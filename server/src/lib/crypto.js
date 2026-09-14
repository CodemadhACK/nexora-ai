'use strict';

/**
 * Every secret-handling primitive the platform uses. Nothing here depends on a
 * third-party package: Node's crypto module covers all of it.
 *
 * Three distinct jobs, deliberately kept apart:
 *   - passwords        -> scrypt, slow and salted, verified in constant time
 *   - provider secrets -> AES-256-GCM, reversible because we must send the key
 *                         to the provider
 *   - session tokens   -> SHA-256 one-way, because we never need the original
 */

const crypto = require('node:crypto');

// ───────────────────────── master key ─────────────────────────

let cachedKey = null;

/**
 * The AES key for provider secrets. Must be 32 bytes, supplied as 64 hex
 * characters in APP_ENCRYPTION_KEY.
 *
 * Refusing to boot without it is deliberate. A generated-on-the-fly key would
 * silently make every stored provider key undecryptable on the next restart,
 * and the failure would surface hours later as "the AI stopped working".
 */
function masterKey() {
  if (cachedKey) return cachedKey;
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(
      'APP_ENCRYPTION_KEY must be 64 hex characters (32 bytes). ' +
        'Generate one with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  cachedKey = Buffer.from(raw, 'hex');
  return cachedKey;
}

// ───────────────────────── reversible secrets ─────────────────────────

/**
 * AES-256-GCM. Output is `v1.<iv>.<authTag>.<ciphertext>`, all base64url.
 * GCM rather than CBC so tampering is detected on decrypt rather than
 * producing plausible garbage.
 */
function encryptSecret(plaintext) {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = crypto.randomBytes(12); // 96-bit nonce, the GCM standard
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64url'), tag.toString('base64url'), enc.toString('base64url')].join(
    '.',
  );
}

function decryptSecret(payload) {
  if (!payload) return null;
  const [version, ivB64, tagB64, dataB64] = String(payload).split('.');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted value');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    masterKey(),
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/** `sk-proj-abc…wxyz` -> `wxyz`, the only part of a key the admin UI ever sees. */
function last4(secret) {
  const s = String(secret || '');
  return s.length <= 4 ? s : s.slice(-4);
}

/** What the admin UI renders in place of a stored secret. */
function maskSecret(last4Value) {
  return last4Value ? `••••••••••••${last4Value}` : '';
}

// ───────────────────────── passwords ─────────────────────────

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS);
  return `scrypt$${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString(
    'base64url',
  )}$${hash.toString('base64url')}`;
}

/**
 * Always does the full scrypt work, even for a malformed stored hash, so the
 * response time cannot be used to tell a missing account from a wrong password.
 */
function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64url');
    const expected = Buffer.from(hashB64, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ───────────────────────── tokens & signatures ─────────────────────────

/** 256 bits of entropy, URL-safe. Used for session tokens. */
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Collision-resistant, sortable-ish id. Prefix makes logs readable. */
function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/**
 * Cashfree webhook signature: base64( HMAC-SHA256( timestamp + rawBody, secret ) ).
 * The raw body matters — re-serialising parsed JSON changes the bytes and the
 * signature will never match.
 * https://www.cashfree.com/docs/payments/online/webhooks/overview
 */
function cashfreeWebhookSignature(timestamp, rawBody, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(String(timestamp) + String(rawBody))
    .digest('base64');
}

/** Length-safe constant-time compare for signatures of unequal length. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  encryptSecret,
  decryptSecret,
  last4,
  maskSecret,
  hashPassword,
  verifyPassword,
  randomToken,
  sha256,
  newId,
  cashfreeWebhookSignature,
  safeEqual,
};
