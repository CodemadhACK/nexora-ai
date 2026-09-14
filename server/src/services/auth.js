'use strict';

/**
 * Identity: accounts, sessions, verification and reset tokens, Google linking.
 *
 * On "don't roll your own crypto" (§48/§51): the primitives here come from
 * Node's own crypto module — scrypt for passwords, SHA-256 for token storage —
 * and Google ID tokens are verified by `google-auth-library`, Google's official
 * client, rather than by hand-parsing a JWT. Nothing cryptographic is invented.
 */

const { OAuth2Client } = require('google-auth-library');
const { get, all, run, transaction } = require('../db');
const crypto = require('../lib/crypto');
const { badRequest, unauthorized, forbidden, conflict, tooMany } = require('../lib/errors');
const audit = require('../lib/audit');
const notifications = require('./notifications');
const credits = require('./credits');

const SESSION_DAYS = 30;
const VERIFY_TOKEN_HOURS = 24;
const RESET_TOKEN_MINUTES = 30;

// Lockout window. Deliberately counts by email+IP rather than email alone, so
// one attacker cannot lock a victim out of their own account.
const MAX_FAILED = 8;
const LOCKOUT_MINUTES = 15;

const nowIso = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const inFuture = (ms) => new Date(Date.now() + ms).toISOString().replace('T', ' ').slice(0, 19);

// ───────────────────────── accounts ─────────────────────────

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    creditBalance: user.credit_balance,
    emailVerified: !!user.email_verified,
    createdAt: user.created_at,
  };
}

function findByEmail(email) {
  return get('SELECT * FROM users WHERE email = ? COLLATE NOCASE', email);
}

function findById(id) {
  return get('SELECT * FROM users WHERE id = ?', id);
}

/**
 * Creates the account plus the rows every user is expected to have. Done in one
 * transaction so a half-made account (user row, no profile) cannot exist.
 */
function createUser({ email, password, name, role = 'USER', emailVerified = false }) {
  const existing = findByEmail(email);
  if (existing) throw conflict('An account with that email already exists.');

  const id = crypto.newId('usr');
  return transaction(() => {
    run(
      `INSERT INTO users (id, email, password_hash, name, role, email_verified)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      email,
      password ? crypto.hashPassword(password) : '',
      name || '',
      role,
      emailVerified ? 1 : 0,
    );
    run('INSERT INTO user_profiles (user_id) VALUES (?)', id);
    run('INSERT INTO notification_preferences (user_id) VALUES (?)', id);

    // The Free plan advertises a starting allowance, and nothing else grants it:
    // free users never pass through payment activation. Without this a new
    // account lands on a dashboard showing 0 credits and cannot ask anything.
    // The idempotency key makes a re-run harmless.
    const freePlan = get(
      `SELECT credits_granted FROM plans WHERE code = 'free' AND status = 'ACTIVE'`,
    );
    if (freePlan && freePlan.credits_granted > 0) {
      credits.grant(id, freePlan.credits_granted, 'Free plan welcome credits', {
        refType: 'plan',
        refId: 'free',
        idempotencyKey: `signup:${id}`,
      });
    }
    if (password) {
      run(
        `INSERT INTO auth_identities (id, user_id, provider, email) VALUES (?, ?, 'password', ?)`,
        crypto.newId('idn'),
        id,
        email,
      );
    }
    return findById(id);
  });
}

// ───────────────────────── lockout ─────────────────────────

function recordAttempt({ email, userId, success, method, reason, ip, userAgent }) {
  run(
    `INSERT INTO login_attempts (id, email, user_id, success, method, reason, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.newId('att'),
    email || '',
    userId || null,
    success ? 1 : 0,
    method,
    reason || '',
    ip || '',
    userAgent || '',
  );
}

function assertNotLockedOut(email, ip) {
  const row = get(
    `SELECT COUNT(*) AS failures FROM login_attempts
      WHERE email = ? AND ip = ? AND success = 0
        AND created_at > datetime('now', ?)`,
    email,
    ip || '',
    `-${LOCKOUT_MINUTES} minutes`,
  );
  if (row && row.failures >= MAX_FAILED) {
    throw tooMany(
      `Too many failed sign-in attempts. Try again in ${LOCKOUT_MINUTES} minutes, or reset your password.`,
    );
  }
}

// ───────────────────────── sessions ─────────────────────────

/** Returns the raw token exactly once; only its hash is persisted. */
function createSession(userId, { ip, userAgent }) {
  const token = crypto.randomToken(32);
  run(
    `INSERT INTO sessions (id, user_id, token_hash, user_agent, ip, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    crypto.newId('ses'),
    userId,
    crypto.sha256(token),
    userAgent || '',
    ip || '',
    inFuture(SESSION_DAYS * 86400_000),
  );
  return token;
}

function resolveSession(token) {
  if (!token) return null;
  const row = get(
    `SELECT s.*, u.id AS uid FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
        AND s.revoked_at IS NULL
        AND s.expires_at > datetime('now')`,
    crypto.sha256(token),
  );
  if (!row) return null;
  const user = findById(row.user_id);
  if (!user || user.status !== 'ACTIVE') return null;
  return { session: row, user };
}

function revokeSession(sessionId, userId) {
  run(
    `UPDATE sessions SET revoked_at = datetime('now')
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    sessionId,
    userId,
  );
}

function revokeAllSessions(userId, exceptSessionId = null) {
  run(
    `UPDATE sessions SET revoked_at = datetime('now')
      WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?`,
    userId,
    exceptSessionId,
  );
}

function listSessions(userId, currentSessionId) {
  return all(
    `SELECT id, user_agent, ip, created_at, expires_at FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')
      ORDER BY created_at DESC`,
    userId,
  ).map((s) => ({
    id: s.id,
    device: describeAgent(s.user_agent),
    // Only the /24 is shown. A full address is more than the user needs to
    // recognise a session and more than we should render back.
    approxIp: (s.ip || '').split('.').slice(0, 3).concat('x').join('.'),
    createdAt: s.created_at,
    expiresAt: s.expires_at,
    current: s.id === currentSessionId,
  }));
}

/** Turns a user-agent string into something a person can recognise. */
function describeAgent(ua = '') {
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  const os =
    /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux'
    : 'Unknown OS';
  return `${browser} on ${os}`;
}

// ───────────────────────── single-use tokens ─────────────────────────

function issueToken(userId, purpose) {
  const token = crypto.randomToken(32);
  const ttl = purpose === 'EMAIL_VERIFY' ? VERIFY_TOKEN_HOURS * 3600_000 : RESET_TOKEN_MINUTES * 60_000;
  run(
    `INSERT INTO auth_tokens (id, user_id, purpose, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    crypto.newId('tok'),
    userId,
    purpose,
    crypto.sha256(token),
    inFuture(ttl),
  );
  return token;
}

/**
 * Consumes a token. Marking it used inside the same transaction as the lookup
 * is what makes it genuinely single-use — two concurrent resets cannot both win.
 */
function consumeToken(token, purpose) {
  return transaction(() => {
    const row = get(
      `SELECT * FROM auth_tokens
        WHERE token_hash = ? AND purpose = ? AND used_at IS NULL
          AND expires_at > datetime('now')`,
      crypto.sha256(token),
      purpose,
    );
    if (!row) return null;
    run(`UPDATE auth_tokens SET used_at = datetime('now') WHERE id = ?`, row.id);
    return row;
  });
}

// ───────────────────────── password flows ─────────────────────────

function signUp({ email, password, name, ip, userAgent }) {
  const user = createUser({ email, password, name });
  const token = issueToken(user.id, 'EMAIL_VERIFY');
  notifications.queue(user.id, 'EMAIL_VERIFY', { name: user.name, token });
  notifications.queue(user.id, 'WELCOME', { name: user.name });
  recordAttempt({ email, userId: user.id, success: true, method: 'signup', ip, userAgent });
  return user;
}

function signIn({ email, password, ip, userAgent }) {
  assertNotLockedOut(email, ip);
  const user = findByEmail(email);

  // Same failure for "no such account" and "wrong password": revealing which
  // is an account-enumeration oracle.
  const fail = (reason) => {
    recordAttempt({ email, userId: user?.id, success: false, method: 'password', reason, ip, userAgent });
    throw unauthorized('That email or password is not right.');
  };

  if (!user) {
    // Still spend the time a real verification would, so timing says nothing.
    crypto.verifyPassword(password, 'scrypt$16384$8$1$AAAA$AAAA');
    return fail('no_such_user');
  }
  if (!user.password_hash) {
    recordAttempt({ email, userId: user.id, success: false, method: 'password', reason: 'oauth_only', ip, userAgent });
    throw badRequest('This account signs in with Google. Use “Continue with Google”.');
  }
  if (!crypto.verifyPassword(password, user.password_hash)) return fail('bad_password');
  if (user.status === 'SUSPENDED') {
    recordAttempt({ email, userId: user.id, success: false, method: 'password', reason: 'suspended', ip, userAgent });
    throw forbidden('This account has been suspended. Contact support.');
  }

  recordAttempt({ email, userId: user.id, success: true, method: 'password', ip, userAgent });
  return user;
}

/**
 * Always reports the same thing, whether or not the email exists (§51).
 * The caller must not branch on the return value.
 */
function requestPasswordReset(email) {
  const user = findByEmail(email);
  if (user && user.password_hash) {
    const token = issueToken(user.id, 'PASSWORD_RESET');
    notifications.queue(user.id, 'PASSWORD_RESET', { name: user.name, token });
  }
  return { ok: true };
}

function resetPassword({ token, password }) {
  const row = consumeToken(token, 'PASSWORD_RESET');
  if (!row) throw badRequest('That reset link has expired or already been used. Request a new one.');

  transaction(() => {
    run(
      `UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`,
      crypto.hashPassword(password),
      row.user_id,
    );
    // A password reset is a security event: every existing session dies.
    run(
      `UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`,
      row.user_id,
    );
  });
  notifications.queue(row.user_id, 'PASSWORD_CHANGED', {});
  audit.log({ actorId: row.user_id, action: 'auth.password_reset', targetType: 'user', targetId: row.user_id });
  return findById(row.user_id);
}

function verifyEmail(token) {
  const row = consumeToken(token, 'EMAIL_VERIFY');
  if (!row) throw badRequest('That verification link has expired or already been used.');
  run(`UPDATE users SET email_verified = 1, updated_at = datetime('now') WHERE id = ?`, row.user_id);
  return findById(row.user_id);
}

function resendVerification(userId) {
  const user = findById(userId);
  if (!user || user.email_verified) return { ok: true };
  const token = issueToken(user.id, 'EMAIL_VERIFY');
  notifications.queue(user.id, 'EMAIL_VERIFY', { name: user.name, token });
  return { ok: true };
}

function changePassword({ userId, currentPassword, newPassword, keepSessionId }) {
  const user = findById(userId);
  if (!user) throw unauthorized();
  if (user.password_hash && !crypto.verifyPassword(currentPassword, user.password_hash)) {
    throw badRequest('Your current password is not right.');
  }
  transaction(() => {
    run(
      `UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?`,
      crypto.hashPassword(newPassword),
      userId,
    );
    run(
      `UPDATE sessions SET revoked_at = datetime('now')
        WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?`,
      userId,
      keepSessionId || null,
    );
    run(
      `INSERT OR IGNORE INTO auth_identities (id, user_id, provider, email)
       VALUES (?, ?, 'password', ?)`,
      crypto.newId('idn'),
      userId,
      user.email,
    );
  });
  notifications.queue(userId, 'PASSWORD_CHANGED', {});
  audit.log({ actorId: userId, action: 'auth.password_changed', targetType: 'user', targetId: userId });
  return { ok: true };
}

// ───────────────────────── Google (§49) ─────────────────────────

function googleClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return new OAuth2Client({ clientId, clientSecret, redirectUri });
}

const googleConfigured = () => googleClient() !== null;

/**
 * Builds the consent URL and stores the CSRF `state` and replay-guard `nonce`
 * server-side. Both are checked on the callback.
 */
function googleAuthUrl(redirectTo = '/app') {
  const client = googleClient();
  if (!client) throw badRequest('Google sign-in is not configured on this server.');

  const state = crypto.randomToken(24);
  const nonce = crypto.randomToken(24);
  run(
    `INSERT INTO oauth_states (state, nonce, redirect_to, expires_at) VALUES (?, ?, ?, ?)`,
    state,
    nonce,
    redirectTo,
    inFuture(10 * 60_000),
  );

  return client.generateAuthUrl({
    access_type: 'online',
    scope: ['openid', 'email', 'profile'],
    state,
    nonce,
    prompt: 'select_account',
  });
}

/**
 * Exchanges the authorization code and verifies the returned ID token against
 * Google's signing keys. Account resolution is the delicate part:
 *
 *   known google sub            -> that account
 *   unknown sub, known email    -> link google to the existing account, but
 *                                  only if that email is already verified
 *   unknown sub, unknown email  -> new account, pre-verified by Google
 *
 * The middle case is where account takeover would live: linking to an
 * unverified email would let someone who registered `victim@x.com` without
 * confirming it be displaced by whoever actually controls that inbox — or the
 * reverse. Requiring a verified email makes the link safe in both directions.
 */
async function googleCallback({ code, state, ip, userAgent }) {
  const client = googleClient();
  if (!client) throw badRequest('Google sign-in is not configured on this server.');

  const stateRow = get(
    `SELECT * FROM oauth_states WHERE state = ? AND expires_at > datetime('now')`,
    state,
  );
  // Single-use whatever happens next.
  run('DELETE FROM oauth_states WHERE state = ?', state);
  if (!stateRow) throw badRequest('That sign-in link has expired. Please try again.');

  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw badRequest('Google did not return an identity token.');

  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub) throw badRequest('Google identity could not be verified.');
  if (payload.nonce && payload.nonce !== stateRow.nonce) {
    throw badRequest('Google identity could not be verified.');
  }
  if (!payload.email || !payload.email_verified) {
    throw badRequest('Your Google account does not have a verified email address.');
  }

  const email = String(payload.email).toLowerCase();
  const existingIdentity = get(
    `SELECT * FROM auth_identities WHERE provider = 'google' AND provider_uid = ?`,
    payload.sub,
  );

  let user;
  if (existingIdentity) {
    user = findById(existingIdentity.user_id);
  } else {
    const byEmail = findByEmail(email);
    if (byEmail) {
      if (!byEmail.email_verified) {
        throw conflict(
          'An account with this email already exists but has not been verified. ' +
            'Verify it from your email first, then link Google from Settings → Security.',
        );
      }
      user = byEmail;
      run(
        `INSERT OR IGNORE INTO auth_identities (id, user_id, provider, provider_uid, email)
         VALUES (?, ?, 'google', ?, ?)`,
        crypto.newId('idn'),
        user.id,
        payload.sub,
        email,
      );
      audit.log({ actorId: user.id, action: 'auth.google_linked', targetType: 'user', targetId: user.id });
    } else {
      user = createUser({ email, password: null, name: payload.name || '', emailVerified: true });
      run(
        `INSERT INTO auth_identities (id, user_id, provider, provider_uid, email)
         VALUES (?, ?, 'google', ?, ?)`,
        crypto.newId('idn'),
        user.id,
        payload.sub,
        email,
      );
      notifications.queue(user.id, 'WELCOME', { name: user.name });
    }
  }

  if (!user) throw badRequest('Could not resolve that Google account.');
  if (user.status === 'SUSPENDED') throw forbidden('This account has been suspended.');

  recordAttempt({ email, userId: user.id, success: true, method: 'google', ip, userAgent });
  return { user, redirectTo: stateRow.redirect_to };
}

function listIdentities(userId) {
  return all(
    `SELECT provider, email, linked_at FROM auth_identities WHERE user_id = ?`,
    userId,
  );
}

function loginHistory(userId, limit = 20) {
  return all(
    `SELECT success, method, reason, ip, user_agent, created_at
       FROM login_attempts WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    userId,
    limit,
  ).map((r) => ({
    success: !!r.success,
    method: r.method,
    device: describeAgent(r.user_agent),
    at: r.created_at,
  }));
}

module.exports = {
  publicUser,
  findById,
  findByEmail,
  createUser,
  signUp,
  signIn,
  createSession,
  resolveSession,
  revokeSession,
  revokeAllSessions,
  listSessions,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
  resendVerification,
  changePassword,
  googleConfigured,
  googleAuthUrl,
  googleCallback,
  listIdentities,
  loginHistory,
  SESSION_DAYS,
};
