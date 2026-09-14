'use strict';

/**
 * Notification outbox (§67).
 *
 * Queuing rather than sending inline keeps request latency off the mail path
 * and makes delivery retryable and auditable. No SMTP transport is wired up
 * yet: `deliver()` is the single seam where one goes. Until then queued mail is
 * visible in the admin console and, in development, printed to the log so the
 * verification and reset links are usable end to end.
 */

const { run, all, get } = require('../db');
const { newId } = require('../lib/crypto');

// Mail a user may not opt out of: anything about money, access or security.
const TRANSACTIONAL = new Set([
  'EMAIL_VERIFY', 'PASSWORD_RESET', 'PASSWORD_CHANGED',
  'PAYMENT_SUCCESS', 'PAYMENT_FAILED', 'SUBSCRIPTION_EXPIRING', 'SECURITY_ALERT',
]);

const PREF_COLUMN = {
  PRODUCT_UPDATE: 'product_updates',
  INTERVIEW_REMINDER: 'interview_reminders',
};

function queue(userId, template, payload = {}) {
  // Honour the user's preferences for anything non-essential.
  const prefColumn = PREF_COLUMN[template];
  if (prefColumn && userId) {
    const prefs = get(`SELECT ${prefColumn} AS allowed FROM notification_preferences WHERE user_id = ?`, userId);
    if (prefs && !prefs.allowed) {
      run(
        `INSERT INTO notifications (id, user_id, template, payload, status) VALUES (?, ?, ?, ?, 'SKIPPED')`,
        newId('ntf'), userId, template, JSON.stringify(payload),
      );
      return { skipped: true };
    }
  }

  const id = newId('ntf');
  run(
    `INSERT INTO notifications (id, user_id, template, payload) VALUES (?, ?, ?, ?)`,
    id, userId || null, template, JSON.stringify(payload),
  );

  if (process.env.NODE_ENV !== 'production' && TRANSACTIONAL.has(template)) {
    const base = process.env.PUBLIC_APP_URL || 'http://localhost:5173';
    const link =
      template === 'EMAIL_VERIFY' ? `${base}/verify-email?token=${payload.token}`
      : template === 'PASSWORD_RESET' ? `${base}/reset-password?token=${payload.token}`
      : null;
    console.log(`[mail:${template}] user=${userId}${link ? ` link=${link}` : ''}`);
  }
  return { id };
}

function pending(limit = 50) {
  return all(`SELECT * FROM notifications WHERE status = 'QUEUED' ORDER BY created_at LIMIT ?`, limit);
}

function markSent(id) {
  run(`UPDATE notifications SET status = 'SENT', sent_at = datetime('now') WHERE id = ?`, id);
}

function markFailed(id, error) {
  run(`UPDATE notifications SET status = 'FAILED', error = ? WHERE id = ?`, String(error).slice(0, 500), id);
}

module.exports = { queue, pending, markSent, markFailed };
