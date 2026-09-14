'use strict';

/**
 * Session resolution and role gates (§15, §62, §64).
 *
 * The rule this file exists to enforce: authorisation is decided here, on the
 * server, from the session cookie. No request body, header or query parameter
 * can influence who the caller is or what role they hold. Hiding a button in
 * React is presentation; this is the access control.
 */

const authService = require('../services/auth');
const { unauthorized, forbidden } = require('../lib/errors');

const COOKIE_NAME = 'nx_session';

const ROLE_RANK = { USER: 0, SUPPORT: 1, ADMIN: 2, SUPER_ADMIN: 3 };

/** Minimal cookie parsing — avoids a dependency for one header. */
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionCookieOptions() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true, // never readable from JavaScript
    secure: isProd, // HTTPS only in production
    // 'lax' still sends the cookie on the top-level GET that Google redirects
    // back to, which 'strict' would drop — breaking OAuth sign-in.
    sameSite: 'lax',
    path: '/',
    maxAge: authService.SESSION_DAYS * 86400_000,
  };
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, sessionCookieOptions());
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { ...sessionCookieOptions(), maxAge: undefined });
}

/**
 * Attaches req.user / req.session when a valid session cookie is present.
 * Never rejects — routes decide whether anonymous access is acceptable.
 */
function attachUser(req, _res, next) {
  req.cookies = parseCookies(req.headers.cookie || '');
  const token = req.cookies[COOKIE_NAME];
  const resolved = token ? authService.resolveSession(token) : null;
  if (resolved) {
    req.user = resolved.user;
    req.session = resolved.session;
  }
  next();
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (req.user.status !== 'ACTIVE') return next(forbidden('This account is not active.'));
  next();
}

/** §50: unverified email is authenticated but not fully trusted. */
function requireVerifiedEmail(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (!req.user.email_verified) {
    return next(forbidden('Verify your email address to use this feature.'));
  }
  next();
}

/** Role gate by rank, so requireRole('ADMIN') also admits SUPER_ADMIN. */
function requireRole(minimum) {
  const needed = ROLE_RANK[minimum];
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if ((ROLE_RANK[req.user.role] ?? -1) < needed) {
      // Deliberately 404-shaped in message: an unauthorised caller should not
      // learn that an admin surface exists here.
      return next(forbidden('Not found.'));
    }
    next();
  };
}

/**
 * §64: re-authentication for dangerous operations. The caller must resend their
 * password (or be a Google-only account, which is covered by the session being
 * recent). Used for role changes, provider-secret writes and account deletion.
 */
function requireReauth(req, _res, next) {
  const supplied = req.body?.currentPassword;
  const user = req.user;
  if (!user) return next(unauthorized());
  if (!user.password_hash) {
    // Google-only account: fall back to session freshness (15 minutes).
    const age = Date.now() - new Date(`${req.session.created_at}Z`).getTime();
    if (age > 15 * 60_000) {
      return next(forbidden('Please sign in again to make this change.'));
    }
    return next();
  }
  const { verifyPassword } = require('../lib/crypto');
  if (!supplied || !verifyPassword(supplied, user.password_hash)) {
    return next(forbidden('Confirm your password to make this change.'));
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  attachUser,
  requireAuth,
  requireVerifiedEmail,
  requireRole,
  requireReauth,
  setSessionCookie,
  clearSessionCookie,
};
