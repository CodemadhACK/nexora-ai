'use strict';

/**
 * RFC 6238 TOTP, implemented on node:crypto's HMAC.
 *
 * This is not inventing cryptography: TOTP is HMAC-SHA1 over a counter, fully
 * specified, and the primitive doing the work is the platform's. SHA-1 here is
 * the algorithm the RFC mandates and every authenticator app implements — it is
 * a MAC over a 8-byte counter, not a collision-sensitive use.
 *
 * https://datatracker.ietf.org/doc/html/rfc6238
 */

const crypto = require('node:crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
// One step either side. Covers clock drift between the phone and the server
// without widening the window enough to matter for brute force.
const DRIFT_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, no padding — the format authenticator apps expect. */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input) {
  const clean = String(input).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160 bits, the RFC's recommended secret length for SHA-1. */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

const currentStep = (at = Date.now()) => Math.floor(at / 1000 / STEP_SECONDS);

/** The 6-digit code for one time step. */
function codeForStep(secretBase32, step) {
  const counter = Buffer.alloc(8);
  // 64-bit big-endian counter. writeUInt32BE twice avoids BigInt for a value
  // that will not exceed 2^32 steps for another ~4000 years.
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);

  const hmac = crypto.createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.3.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * Verifies a code and returns the step it matched, or null.
 *
 * The caller must persist the returned step and refuse anything at or below it
 * — without that, a code shoulder-surfed inside its 30-second window can be
 * replayed. Comparison is constant-time so a near-miss leaks nothing.
 */
function verify(secretBase32, token, { lastStep = 0, at = Date.now() } = {}) {
  const candidate = String(token || '').replace(/\D/g, '');
  if (candidate.length !== DIGITS) return null;

  const now = currentStep(at);
  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift += 1) {
    const step = now + drift;
    if (step <= lastStep) continue; // already used
    const expected = codeForStep(secretBase32, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))) return step;
  }
  return null;
}

/**
 * The otpauth:// URI an authenticator app scans. The issuer appears both as a
 * label prefix and a parameter, which is what Google Authenticator expects.
 */
function otpauthUrl({ secret, account, issuer = 'Nexora AI' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Human-typeable recovery codes: 10 groups of `xxxx-xxxx`. */
function generateRecoveryCodes(count = 10) {
  // Excludes look-alike characters, because these get read off a screen.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () => alphabet[crypto.randomInt(alphabet.length)];
  const group = () => Array.from({ length: 4 }, pick).join('');
  return Array.from({ length: count }, () => `${group()}-${group()}`);
}

/** Normalises what a user typed before hashing or comparing. */
const normaliseRecoveryCode = (code) =>
  String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

module.exports = {
  generateSecret,
  verify,
  codeForStep,
  currentStep,
  otpauthUrl,
  generateRecoveryCodes,
  normaliseRecoveryCode,
  base32Encode,
  base32Decode,
  STEP_SECONDS,
  DIGITS,
};
