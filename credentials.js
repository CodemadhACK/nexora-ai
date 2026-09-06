/**
 * Per-provider API key storage.
 *
 * Keys are encrypted at rest with the OS keystore through Electron's
 * `safeStorage` — Windows DPAPI, macOS Keychain, libsecret on Linux — and live
 * in the app's user-data folder, never in the project directory. When the OS
 * offers no encryption (rare, and usually a headless Linux box) we fall back to
 * a 0600 plaintext file and say so plainly, so the choice is the user's.
 *
 * `safeStorage` and `fs` are injected, which keeps the whole policy testable
 * without Electron and without touching a real keychain.
 */

'use strict';

const nodePath = require('node:path');

/** Environment variables win — handy for development and CI. */
function envKey(env, provider) {
  const raw = provider && provider.keyEnv ? env[provider.keyEnv] : null;
  return raw ? String(raw).trim() : '';
}

function createCredentials({ fs, safeStorage, dir, env = process.env, log = () => {} }) {
  const encPath = (id) => nodePath.join(dir(), `${id}.key`);
  const plainPath = (id) => nodePath.join(dir(), `${id}.key.plain`);

  const canEncrypt = () => {
    try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
  };

  function forget(id) {
    for (const p of [encPath(id), plainPath(id)]) {
      try { fs.unlinkSync(p); } catch { /* not present */ }
    }
  }

  function store(id, key) {
    fs.mkdirSync(dir(), { recursive: true });
    forget(id);
    if (!key) return { ok: true, present: false, encrypted: false };

    if (canEncrypt()) {
      fs.writeFileSync(encPath(id), safeStorage.encryptString(key));
      return { ok: true, present: true, encrypted: true };
    }
    fs.writeFileSync(plainPath(id), key, { encoding: 'utf8', mode: 0o600 });
    return { ok: true, present: true, encrypted: false };
  }

  function read(id, provider) {
    const fromEnv = envKey(env, provider);
    if (fromEnv) return fromEnv;

    try {
      if (fs.existsSync(encPath(id)) && canEncrypt()) {
        return safeStorage.decryptString(fs.readFileSync(encPath(id))).trim();
      }
    } catch (err) {
      log(`could not decrypt the ${id} key: ${err.message}`);
    }
    try {
      if (fs.existsSync(plainPath(id))) return fs.readFileSync(plainPath(id), 'utf8').trim();
    } catch { /* ignore */ }
    return '';
  }

  /** What the settings pane shows. Never returns the key itself. */
  function status(id, provider) {
    const key = read(id, provider);
    let encrypted = false;
    try { encrypted = fs.existsSync(encPath(id)) && canEncrypt(); } catch { /* ignore */ }
    return {
      provider: id,
      present: !!key,
      encrypted,
      fromEnv: !!envKey(env, provider),
      hint: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '',
      encryptionAvailable: canEncrypt()
    };
  }

  /**
   * One-time move of the single-provider key this app stored before it grew a
   * provider abstraction. The ciphertext is DPAPI/Keychain-bound to the user
   * rather than to the filename, so a straight copy still decrypts.
   */
  function adoptLegacyKey(legacyBaseName, id) {
    if (legacyBaseName === id) return false;
    let moved = false;
    for (const [from, to] of [
      [nodePath.join(dir(), `${legacyBaseName}.key`), encPath(id)],
      [nodePath.join(dir(), `${legacyBaseName}.key.plain`), plainPath(id)]
    ]) {
      try {
        if (fs.existsSync(from) && !fs.existsSync(to)) {
          fs.copyFileSync(from, to);
          moved = true;
        }
      } catch (err) {
        log(`could not carry over the legacy ${legacyBaseName} key: ${err.message}`);
      }
    }
    return moved;
  }

  return { store, read, status, forget, adoptLegacyKey };
}

module.exports = { createCredentials, envKey };
