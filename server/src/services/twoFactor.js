'use strict';

/**
 * Two-factor authentication (§53).
 *
 * Enrolment is deliberately two-step: `begin()` stores an *unconfirmed* secret,
 * and only `enable()` — which requires a working code — turns it on. A secret
 * that gated login before being proven would lock a user out of their own
 * account the moment they mistyped the QR scan.
 */

const { get, all, run, transaction } = require('../db');
const crypto = require('../lib/crypto');
const totp = require('../lib/totp');
const audit = require('../lib/audit');
const notifications = require('./notifications');
const { badRequest, unauthorized, tooMany } = require('../lib/errors');

const CHALLENGE_MINUTES = 10;
const MAX_CHALLENGE_ATTEMPTS = 6;

const inFuture = (ms) => new Date(Date.now() + ms).toISOString().replace('T', ' ').slice(0, 19);

/** Is a *confirmed* second factor in force for this account? */
function isEnabled(userId) {
  const row = get('SELECT confirmed FROM totp_secrets WHERE user_id = ?', userId);
  return !!row?.confirmed;
}

function status(userId) {
  const row = get('SELECT confirmed, confirmed_at FROM totp_secrets WHERE user_id = ?', userId);
  const remaining = get(
    'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL',
    userId,
  ).n;
  return {
    enabled: !!row?.confirmed,
    pending: !!row && !row.confirmed,
    confirmedAt: row?.confirmed_at ?? null,
    recoveryCodesRemaining: remaining,
  };
}

/**
 * Starts enrolment. Returns the secret once, in the only response that will
 * ever contain it — after this it exists only as ciphertext.
 */
function begin(user) {
  if (isEnabled(user.id)) throw badRequest('Two-factor authentication is already on.');

  const secret = totp.generateSecret();
  run(
    `INSERT INTO totp_secrets (user_id, secret_cipher, confirmed, last_step)
     VALUES (?, ?, 0, 0)
     ON CONFLICT(user_id) DO UPDATE SET secret_cipher = excluded.secret_cipher,
                                        confirmed = 0, confirmed_at = NULL, last_step = 0`,
    user.id,
    crypto.encryptSecret(secret),
  );

  return {
    secret,
    otpauthUrl: totp.otpauthUrl({ secret, account: user.email }),
    digits: totp.DIGITS,
    period: totp.STEP_SECONDS,
  };
}

/**
 * Confirms enrolment with a working code, and mints recovery codes.
 *
 * The plaintext recovery codes are returned exactly once. Only their hashes are
 * kept, so a database leak does not yield usable fallbacks.
 */
function enable(user, token) {
  const row = get('SELECT * FROM totp_secrets WHERE user_id = ?', user.id);
  if (!row) throw badRequest('Start setting up two-factor authentication first.');
  if (row.confirmed) throw badRequest('Two-factor authentication is already on.');

  const secret = crypto.decryptSecret(row.secret_cipher);
  const step = totp.verify(secret, token, { lastStep: row.last_step });
  if (step === null) throw badRequest('That code is not right. Check your authenticator and try again.');

  const codes = totp.generateRecoveryCodes();
  transaction(() => {
    run(
      `UPDATE totp_secrets SET confirmed = 1, confirmed_at = datetime('now'), last_step = ?
        WHERE user_id = ?`,
      step,
      user.id,
    );
    run('DELETE FROM recovery_codes WHERE user_id = ?', user.id);
    for (const code of codes) {
      run(
        'INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)',
        crypto.newId('rec'),
        user.id,
        crypto.sha256(totp.normaliseRecoveryCode(code)),
      );
    }
  });

  notifications.queue(user.id, 'SECURITY_ALERT', { event: 'two_factor_enabled' });
  audit.log({ actorId: user.id, action: 'auth.2fa_enabled', targetType: 'user', targetId: user.id });
  return { recoveryCodes: codes };
}

/** Turning 2FA off is a security downgrade, so it demands a live code. */
function disable(user, token) {
  const row = get('SELECT * FROM totp_secrets WHERE user_id = ?', user.id);
  if (!row?.confirmed) throw badRequest('Two-factor authentication is not on.');

  const secret = crypto.decryptSecret(row.secret_cipher);
  const step = totp.verify(secret, token, { lastStep: row.last_step });
  const byRecovery = step === null ? consumeRecoveryCode(user.id, token) : false;
  if (step === null && !byRecovery) throw badRequest('That code is not right.');

  transaction(() => {
    run('DELETE FROM totp_secrets WHERE user_id = ?', user.id);
    run('DELETE FROM recovery_codes WHERE user_id = ?', user.id);
  });

  notifications.queue(user.id, 'SECURITY_ALERT', { event: 'two_factor_disabled' });
  audit.log({ actorId: user.id, action: 'auth.2fa_disabled', targetType: 'user', targetId: user.id });
  return { ok: true };
}

function regenerateRecoveryCodes(user) {
  if (!isEnabled(user.id)) throw badRequest('Two-factor authentication is not on.');
  const codes = totp.generateRecoveryCodes();
  transaction(() => {
    run('DELETE FROM recovery_codes WHERE user_id = ?', user.id);
    for (const code of codes) {
      run(
        'INSERT INTO recovery_codes (id, user_id, code_hash) VALUES (?, ?, ?)',
        crypto.newId('rec'),
        user.id,
        crypto.sha256(totp.normaliseRecoveryCode(code)),
      );
    }
  });
  audit.log({ actorId: user.id, action: 'auth.2fa_codes_regenerated', targetType: 'user', targetId: user.id });
  return { recoveryCodes: codes };
}

/** Marks a recovery code used. Single-use, enforced inside the transaction. */
function consumeRecoveryCode(userId, supplied) {
  const hash = crypto.sha256(totp.normaliseRecoveryCode(supplied));
  return transaction(() => {
    const row = get(
      'SELECT * FROM recovery_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL',
      userId,
      hash,
    );
    if (!row) return false;
    run(`UPDATE recovery_codes SET used_at = datetime('now') WHERE id = ?`, row.id);
    return true;
  });
}

// ───────────────────────── login challenge ─────────────────────────

/**
 * Issued when a password is correct but a second factor is owed. Holding one
 * grants nothing — it is not a session, and it cannot be exchanged for one
 * without a valid code.
 */
function createChallenge(userId, { ip, userAgent }) {
  const token = crypto.randomToken(32);
  run(
    `INSERT INTO login_challenges (id, user_id, token_hash, ip, user_agent, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    crypto.newId('chl'),
    userId,
    crypto.sha256(token),
    ip || '',
    userAgent || '',
    inFuture(CHALLENGE_MINUTES * 60_000),
  );
  return token;
}

/**
 * Exchanges a challenge plus a code for the authenticated user.
 *
 * Attempts are counted on the challenge itself, so a limited number of guesses
 * applies to this sign-in rather than to the account — an attacker cannot lock
 * the real user out by burning the counter.
 */
function verifyChallenge({ challengeToken, code, useRecoveryCode = false }) {
  const challenge = get(
    `SELECT * FROM login_challenges
      WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > datetime('now')`,
    crypto.sha256(challengeToken),
  );
  if (!challenge) throw unauthorized('That sign-in attempt expired. Please sign in again.');

  if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) {
    run(`UPDATE login_challenges SET consumed_at = datetime('now') WHERE id = ?`, challenge.id);
    throw tooMany('Too many incorrect codes. Please sign in again.');
  }
  run('UPDATE login_challenges SET attempts = attempts + 1 WHERE id = ?', challenge.id);

  const secretRow = get('SELECT * FROM totp_secrets WHERE user_id = ?', challenge.user_id);
  let accepted = false;
  let usedRecovery = false;

  if (useRecoveryCode) {
    accepted = consumeRecoveryCode(challenge.user_id, code);
    usedRecovery = accepted;
  } else if (secretRow?.confirmed) {
    const secret = crypto.decryptSecret(secretRow.secret_cipher);
    const step = totp.verify(secret, code, { lastStep: secretRow.last_step });
    if (step !== null) {
      // Persisting the step is what stops the same code being replayed inside
      // its own 30-second window.
      run('UPDATE totp_secrets SET last_step = ? WHERE user_id = ?', step, challenge.user_id);
      accepted = true;
    }
  }

  if (!accepted) {
    throw unauthorized(
      useRecoveryCode ? 'That recovery code is not valid or has been used.' : 'That code is not right.',
    );
  }

  run(`UPDATE login_challenges SET consumed_at = datetime('now') WHERE id = ?`, challenge.id);

  if (usedRecovery) {
    const left = get(
      'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL',
      challenge.user_id,
    ).n;
    notifications.queue(challenge.user_id, 'SECURITY_ALERT', {
      event: 'recovery_code_used',
      remaining: left,
    });
  }

  return { userId: challenge.user_id, usedRecovery };
}

module.exports = {
  isEnabled,
  status,
  begin,
  enable,
  disable,
  regenerateRecoveryCodes,
  consumeRecoveryCode,
  createChallenge,
  verifyChallenge,
};
