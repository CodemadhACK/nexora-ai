'use strict';

/** Authentication surface (§48–§53, §61). */

const express = require('express');
const authService = require('../services/auth');
const entitlements = require('../services/entitlements');
const twoFactor = require('../services/twoFactor');
const { rateLimit } = require('../middleware/rateLimit');
const {
  requireAuth,
  requireReauth,
  setSessionCookie,
  clearSessionCookie,
} = require('../middleware/auth');
const v = require('../lib/validate');
const { badRequest } = require('../lib/errors');
const audit = require('../lib/audit');

const router = express.Router();

// Tight limits on the credential endpoints; lockout in the service layer is the
// second line, this is the first.
const authLimit = rateLimit({ windowMs: 15 * 60_000, max: 20 });
const resetLimit = rateLimit({ windowMs: 60 * 60_000, max: 5 });

const mePayload = (user, session) => ({
  user: authService.publicUser(user),
  entitlements: entitlements.resolve(user.id),
  sessionId: session?.id ?? null,
});

router.post('/signup', authLimit, (req, res, next) => {
  try {
    const email = v.email(req.body.email);
    const password = v.password(req.body.password);
    const name = v.str(req.body.name ?? '', 'Name', { min: 0, max: 120 });
    if (req.body.confirmPassword !== undefined && req.body.confirmPassword !== password) {
      throw badRequest('Those passwords do not match.');
    }

    const user = authService.signUp({
      email,
      password,
      name,
      ip: req.clientIp,
      userAgent: req.get('user-agent'),
    });
    const token = authService.createSession(user.id, {
      ip: req.clientIp,
      userAgent: req.get('user-agent'),
    });
    setSessionCookie(res, token);
    const session = authService.resolveSession(token)?.session;
    res.status(201).json(mePayload(user, session));
  } catch (err) {
    next(err);
  }
});

router.post('/login', authLimit, (req, res, next) => {
  try {
    const email = v.email(req.body.email);
    const password = v.str(req.body.password, 'Password', { trim: false });
    const user = authService.signIn({
      email,
      password,
      ip: req.clientIp,
      userAgent: req.get('user-agent'),
    });

    // §53: a correct password is only the first factor. No session cookie is
    // set here — the challenge token grants nothing on its own.
    if (twoFactor.isEnabled(user.id)) {
      const challengeToken = twoFactor.createChallenge(user.id, {
        ip: req.clientIp,
        userAgent: req.get('user-agent'),
      });
      return res.json({
        requiresTwoFactor: true,
        challengeToken,
        recoveryAvailable: twoFactor.status(user.id).recoveryCodesRemaining > 0,
      });
    }

    const token = authService.createSession(user.id, {
      ip: req.clientIp,
      userAgent: req.get('user-agent'),
    });
    setSessionCookie(res, token);
    const session = authService.resolveSession(token)?.session;
    res.json(mePayload(user, session));
  } catch (err) {
    next(err);
  }
});

/** Exchanges a challenge plus a second factor for a real session. */
router.post('/2fa/challenge', authLimit, (req, res, next) => {
  try {
    const challengeToken = v.str(req.body.challengeToken, 'Challenge');
    const code = v.str(req.body.code, 'Code', { max: 40 });
    const useRecoveryCode = v.bool(req.body.useRecoveryCode);

    const { userId, usedRecovery } = twoFactor.verifyChallenge({
      challengeToken,
      code,
      useRecoveryCode,
    });
    const user = authService.findById(userId);

    const token = authService.createSession(user.id, {
      ip: req.clientIp,
      userAgent: req.get('user-agent'),
    });
    setSessionCookie(res, token);
    const session = authService.resolveSession(token)?.session;
    res.json({ ...mePayload(user, session), usedRecovery });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── two-factor management (§53) ─────────────────────────

router.get('/2fa', requireAuth, (req, res) => {
  res.json(twoFactor.status(req.user.id));
});

/** Returns the secret once. Nothing is enforced until /2fa/enable succeeds. */
router.post('/2fa/setup', requireAuth, requireReauth, (req, res, next) => {
  try {
    res.json(twoFactor.begin(req.user));
  } catch (err) {
    next(err);
  }
});

router.post('/2fa/enable', requireAuth, (req, res, next) => {
  try {
    const code = v.str(req.body.code, 'Code', { max: 10 });
    res.json(twoFactor.enable(req.user, code));
  } catch (err) {
    next(err);
  }
});

router.post('/2fa/disable', requireAuth, requireReauth, (req, res, next) => {
  try {
    const code = v.str(req.body.code, 'Code', { max: 40 });
    res.json(twoFactor.disable(req.user, code));
  } catch (err) {
    next(err);
  }
});

router.post('/2fa/recovery-codes', requireAuth, requireReauth, (req, res, next) => {
  try {
    res.json(twoFactor.regenerateRecoveryCodes(req.user));
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, (req, res, next) => {
  try {
    authService.revokeSession(req.session.id, req.user.id);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** §52: sign out everywhere. Keeps the current session so the user stays put. */
router.post('/logout-all', requireAuth, (req, res, next) => {
  try {
    authService.revokeAllSessions(req.user.id, req.session.id);
    audit.fromRequest(req, { action: 'auth.logout_all', targetType: 'user', targetId: req.user.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', (req, res) => {
  if (!req.user) return res.json({ user: null, entitlements: null });
  res.json(mePayload(req.user, req.session));
});

router.get('/sessions', requireAuth, (req, res) => {
  res.json({ sessions: authService.listSessions(req.user.id, req.session.id) });
});

router.delete('/sessions/:id', requireAuth, (req, res, next) => {
  try {
    authService.revokeSession(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/login-history', requireAuth, (req, res) => {
  res.json({ history: authService.loginHistory(req.user.id) });
});

router.get('/identities', requireAuth, (req, res) => {
  res.json({ identities: authService.listIdentities(req.user.id) });
});

// ───────────────────────── email verification ─────────────────────────

router.post('/verify-email', (req, res, next) => {
  try {
    const token = v.str(req.body.token, 'Token');
    const user = authService.verifyEmail(token);
    res.json({ ok: true, user: authService.publicUser(user) });
  } catch (err) {
    next(err);
  }
});

router.post('/resend-verification', requireAuth, resetLimit, (req, res, next) => {
  try {
    res.json(authService.resendVerification(req.user.id));
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── password reset ─────────────────────────

/**
 * §51: the response is identical whether or not the account exists, so this
 * endpoint cannot be used to discover who has registered.
 */
router.post('/forgot-password', resetLimit, (req, res, next) => {
  try {
    authService.requestPasswordReset(v.email(req.body.email));
  } catch (err) {
    if (err.status !== 400) return next(err);
  }
  res.json({
    ok: true,
    message: "If an account exists for this email, you'll receive a reset link.",
  });
});

router.post('/reset-password', resetLimit, (req, res, next) => {
  try {
    const token = v.str(req.body.token, 'Token');
    const password = v.password(req.body.password);
    authService.resetPassword({ token, password });
    res.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
  } catch (err) {
    next(err);
  }
});

router.post('/change-password', requireAuth, requireReauth, (req, res, next) => {
  try {
    const newPassword = v.password(req.body.newPassword);
    authService.changePassword({
      userId: req.user.id,
      currentPassword: req.body.currentPassword,
      newPassword,
      keepSessionId: req.session.id,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── Google (§49) ─────────────────────────

router.get('/google', authLimit, (req, res, next) => {
  try {
    const redirectTo = typeof req.query.redirect === 'string' ? req.query.redirect : '/app';
    // Only same-site paths, so the parameter cannot be used as an open redirect.
    const safe = redirectTo.startsWith('/') && !redirectTo.startsWith('//') ? redirectTo : '/app';
    res.redirect(authService.googleAuthUrl(safe));
  } catch (err) {
    next(err);
  }
});

/**
 * Google redirects the browser here. Errors end up on the sign-in page with a
 * short reason rather than as raw JSON the user cannot act on (§61).
 */
router.get('/google/callback', async (req, res) => {
  const appUrl = process.env.PUBLIC_APP_URL || 'http://localhost:5173';
  const fail = (reason) => res.redirect(`${appUrl}/login?error=${encodeURIComponent(reason)}`);

  if (req.query.error) return fail(req.query.error === 'access_denied' ? 'cancelled' : 'oauth_failed');
  if (!req.query.code || !req.query.state) return fail('oauth_failed');

  try {
    const { user, redirectTo } = await authService.googleCallback({
      code: String(req.query.code),
      state: String(req.query.state),
      ip: req.clientIp,
      userAgent: req.get('user-agent'),
    });

    // A verified Google identity is still only one factor. Hand the browser a
    // challenge instead of a session and let the app collect the code.
    if (twoFactor.isEnabled(user.id)) {
      const challengeToken = twoFactor.createChallenge(user.id, {
        ip: req.clientIp,
        userAgent: req.get('user-agent'),
      });
      return res.redirect(
        `${appUrl}/login?challenge=${encodeURIComponent(challengeToken)}&next=${encodeURIComponent(redirectTo)}`,
      );
    }

    const token = authService.createSession(user.id, {
      ip: req.clientIp,
      userAgent: req.get('user-agent'),
    });
    setSessionCookie(res, token);
    res.redirect(`${appUrl}${redirectTo}`);
  } catch (err) {
    console.error('[auth] google callback failed', err.message);
    return fail(err.expose ? err.message : 'oauth_failed');
  }
});

router.get('/providers', (_req, res) => {
  res.json({ google: authService.googleConfigured(), password: true });
});

module.exports = router;
