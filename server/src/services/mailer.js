'use strict';

/**
 * Email delivery (§67).
 *
 * Two transports, selected by configuration:
 *   SMTP_HOST set -> nodemailer
 *   otherwise     -> a log transport that prints the message
 *
 * The log transport is not a stub to be replaced later; it is how development
 * works, and it means a missing SMTP configuration degrades to "the link is in
 * the server log" rather than to a silent failure in the signup flow.
 */

const notifications = require('./notifications');

const FROM = process.env.MAIL_FROM || 'Nexora AI <no-reply@nexora.ai>';
const APP_URL = () => process.env.PUBLIC_APP_URL || 'http://localhost:5173';

let cachedTransport = null;

function transport() {
  if (cachedTransport) return cachedTransport;

  if (process.env.SMTP_HOST) {
    // Required lazily so a deployment without SMTP never loads it.
    const nodemailer = require('nodemailer');
    cachedTransport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
    return cachedTransport;
  }

  cachedTransport = {
    name: 'log',
    async sendMail({ to, subject, text }) {
      console.log(`\n──── email (no SMTP configured) ────\nTo: ${to}\nSubject: ${subject}\n\n${text}\n────────────────────────────────────\n`);
      return { messageId: `log-${Date.now()}` };
    },
  };
  return cachedTransport;
}

// ───────────────────────── templates ─────────────────────────

/**
 * Plain text only, deliberately. An HTML mail pipeline is a project of its own,
 * and for transactional mail of this kind plain text is more reliable, renders
 * everywhere, and cannot leak a tracking pixel.
 */
const TEMPLATES = {
  WELCOME: ({ name }) => ({
    subject: 'Welcome to Nexora AI',
    text: `Hi${name ? ` ${name}` : ''},

Your Nexora account is ready. You have credits waiting on the Free plan — enough
to try the assistant properly before deciding about anything paid.

Open your dashboard: ${APP_URL()}/app

— Nexora AI`,
  }),

  EMAIL_VERIFY: ({ name, token }) => ({
    subject: 'Verify your email address',
    text: `Hi${name ? ` ${name}` : ''},

Confirm your email address to unlock the assistant:

${APP_URL()}/verify-email?token=${token}

The link is good for 24 hours. If you did not create a Nexora account, you can
ignore this message.

— Nexora AI`,
  }),

  PASSWORD_RESET: ({ name, token }) => ({
    subject: 'Reset your Nexora password',
    text: `Hi${name ? ` ${name}` : ''},

Use this link to choose a new password:

${APP_URL()}/reset-password?token=${token}

It expires in 30 minutes and can only be used once. If you did not ask for a
reset, nothing has changed and you can ignore this.

— Nexora AI`,
  }),

  PASSWORD_CHANGED: () => ({
    subject: 'Your Nexora password was changed',
    text: `Your password was just changed, and every other signed-in device has been
signed out.

If this was not you, reset your password immediately:
${APP_URL()}/forgot-password

— Nexora AI`,
  }),

  PAYMENT_SUCCESS: ({ planName, credits, amountMinor }) => ({
    subject: `Payment received — welcome to ${planName}`,
    text: `Your payment of ₹${((amountMinor || 0) / 100).toFixed(2)} has been confirmed.

Plan:    ${planName}
Credits: ${credits} added to your account

Your invoice is on the billing page: ${APP_URL()}/app/billing

— Nexora AI`,
  }),

  PAYMENT_FAILED: ({ reason }) => ({
    subject: 'Your payment did not go through',
    text: `We could not complete your payment${reason === 'user_dropped' ? ' — it looks like checkout was closed before finishing' : ''}.

Nothing has been charged. You can try again here:
${APP_URL()}/app/billing

— Nexora AI`,
  }),

  SUBSCRIPTION_EXPIRING: ({ planName, expiresOn }) => ({
    subject: `Your ${planName} plan renews soon`,
    text: `Your ${planName} plan is due to renew on ${expiresOn}.

Manage or cancel it any time: ${APP_URL()}/app/billing

— Nexora AI`,
  }),

  LOW_CREDITS: ({ balance }) => ({
    subject: 'You are running low on credits',
    text: `You have ${balance} credits left — enough for only a few more answers.

Top up or upgrade: ${APP_URL()}/app/billing

— Nexora AI`,
  }),

  SECURITY_ALERT: ({ event, remaining }) => {
    const messages = {
      two_factor_enabled: 'Two-factor authentication was turned on for your account.',
      two_factor_disabled: 'Two-factor authentication was turned OFF for your account.',
      recovery_code_used: `A recovery code was used to sign in. You have ${remaining} left.`,
    };
    return {
      subject: 'Security update on your Nexora account',
      text: `${messages[event] || 'A security setting on your account changed.'}

If this was not you, change your password now:
${APP_URL()}/forgot-password

— Nexora AI`,
    };
  },

  PRODUCT_UPDATE: ({ body }) => ({
    subject: 'What is new in Nexora',
    text: body || 'We shipped some improvements. Take a look: ' + APP_URL(),
  }),

  INTERVIEW_REMINDER: ({ role }) => ({
    subject: 'Ready for another practice round?',
    text: `You have not practised in a while. A short session keeps the answers sharp${
      role ? ` for your ${role} interviews` : ''
    }.

Start one: ${APP_URL()}/app/interviews

— Nexora AI`,
  }),
};

// ───────────────────────── the worker ─────────────────────────

/**
 * Drains the outbox. Called on an interval by the server and, in tests, by hand.
 * A template that no longer exists is marked failed rather than retried for
 * ever — a permanent error should not look like a transient one.
 */
async function flush({ limit = 25 } = {}) {
  const { get } = require('../db');
  const queued = notifications.pending(limit);
  let sent = 0;
  let failed = 0;

  for (const row of queued) {
    const build = TEMPLATES[row.template];
    if (!build) {
      notifications.markFailed(row.id, `No template named ${row.template}`);
      failed += 1;
      continue;
    }

    const user = row.user_id ? get('SELECT email, name FROM users WHERE id = ?', row.user_id) : null;
    if (!user?.email) {
      notifications.markFailed(row.id, 'No recipient address');
      failed += 1;
      continue;
    }

    let payload = {};
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = {};
    }

    try {
      const { subject, text } = build({ ...payload, name: payload.name ?? user.name });
      await transport().sendMail({ from: FROM, to: user.email, subject, text });
      notifications.markSent(row.id);
      sent += 1;
    } catch (err) {
      // Left QUEUED would retry for ever; FAILED is visible in the admin console.
      notifications.markFailed(row.id, err.message);
      failed += 1;
    }
  }

  return { sent, failed, considered: queued.length };
}

/** Background drain. Unref'd so it never holds the process open. */
function startWorker({ intervalMs = 15_000 } = {}) {
  const timer = setInterval(() => {
    flush().catch((err) => console.error('[mail] flush failed', err.message));
  }, intervalMs);
  timer.unref();
  return timer;
}

const configured = () => !!process.env.SMTP_HOST;

module.exports = { flush, startWorker, configured, TEMPLATES };
