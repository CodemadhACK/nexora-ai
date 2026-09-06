'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createCredentials } = require('../credentials');

const GEMINI = { id: 'gemini', keyEnv: 'GEMINI_API_KEY' };
const OPENAI = { id: 'openai', keyEnv: 'OPENAI_API_KEY' };

/**
 * Stands in for the OS keystore. Reversible, but the ciphertext must not
 * contain the plaintext — otherwise the "nothing readable on disk" assertion
 * below would pass for the wrong reason.
 */
function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (s) => Buffer.from(`enc:${Buffer.from(s, 'utf8').toString('base64')}`, 'utf8'),
    decryptString: (buf) =>
      Buffer.from(buf.toString('utf8').replace(/^enc:/, ''), 'base64').toString('utf8')
  };
}

function harness(t, { available = true, env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    credentials: createCredentials({ fs, safeStorage: fakeSafeStorage(available), dir: () => dir, env })
  };
}

// ---------------------------------------------------------------------------

test('keys are stored per provider and do not collide', (t) => {
  const { credentials } = harness(t);

  credentials.store('gemini', 'AIzaGEMINI');
  credentials.store('openai', 'sk-OPENAI');

  assert.equal(credentials.read('gemini', GEMINI), 'AIzaGEMINI');
  assert.equal(credentials.read('openai', OPENAI), 'sk-OPENAI');
});

test('a stored key is encrypted at rest, never written as plaintext', (t) => {
  const { credentials, dir } = harness(t);
  credentials.store('gemini', 'AIzaSECRET');

  const onDisk = fs.readFileSync(path.join(dir, 'gemini.key'), 'utf8');
  assert.ok(!onDisk.includes('AIzaSECRET'), 'the raw key must not be readable on disk');
  assert.ok(onDisk.startsWith('enc:'));
  assert.equal(fs.existsSync(path.join(dir, 'gemini.key.plain')), false);
});

test('without OS encryption it falls back to a restricted file and says so', (t) => {
  const { credentials, dir } = harness(t, { available: false });

  const result = credentials.store('gemini', 'AIzaSECRET');
  assert.equal(result.encrypted, false);
  assert.equal(result.present, true);

  assert.equal(fs.readFileSync(path.join(dir, 'gemini.key.plain'), 'utf8'), 'AIzaSECRET');
  assert.equal(credentials.read('gemini', GEMINI), 'AIzaSECRET');
  assert.equal(credentials.status('gemini', GEMINI).encrypted, false);

  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, 'gemini.key.plain')).mode & 0o777, 0o600);
  }
});

test('the status the UI shows never contains the whole key', (t) => {
  const { credentials } = harness(t);
  credentials.store('gemini', 'AIzaSyABCDEFGHIJKLMNOP');

  const status = credentials.status('gemini', GEMINI);
  assert.equal(status.present, true);
  assert.equal(status.encrypted, true);
  assert.equal(status.fromEnv, false);
  assert.equal(status.hint, 'AIzaSy…MNOP');
  assert.ok(!Object.values(status).includes('AIzaSyABCDEFGHIJKLMNOP'));
});

test('an environment variable overrides the stored key', (t) => {
  const { credentials } = harness(t, { env: { OPENAI_API_KEY: '  sk-from-env  ' } });
  credentials.store('openai', 'sk-stored');

  assert.equal(credentials.read('openai', OPENAI), 'sk-from-env', 'trimmed and preferred');
  assert.equal(credentials.status('openai', OPENAI).fromEnv, true);
  // A different provider is unaffected by that variable.
  assert.equal(credentials.status('gemini', GEMINI).fromEnv, false);
});

test('storing an empty key removes both representations', (t) => {
  const { credentials, dir } = harness(t);
  credentials.store('gemini', 'AIzaSECRET');

  const result = credentials.store('gemini', '');
  assert.equal(result.present, false);
  assert.equal(credentials.read('gemini', GEMINI), '');
  assert.equal(fs.existsSync(path.join(dir, 'gemini.key')), false);
  assert.equal(fs.existsSync(path.join(dir, 'gemini.key.plain')), false);
});

test('an unset key reads as empty rather than throwing', (t) => {
  const { credentials } = harness(t);
  assert.equal(credentials.read('openai', OPENAI), '');
  assert.deepEqual(credentials.status('openai', OPENAI), {
    provider: 'openai', present: false, encrypted: false, fromEnv: false, hint: '', encryptionAvailable: true
  });
});

test('a corrupt key file is reported and treated as absent, not fatal', (t) => {
  const logs = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-keys-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const credentials = createCredentials({
    fs,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from(s),
      decryptString: () => { throw new Error('DPAPI could not decrypt'); }
    },
    dir: () => dir,
    env: {},
    log: (m) => logs.push(m)
  });

  credentials.store('gemini', 'AIzaSECRET');
  assert.equal(credentials.read('gemini', GEMINI), '');
  assert.match(logs.join('\n'), /DPAPI could not decrypt/);
});

/** Writes a blob the fake keystore can decrypt — stands in for an older install's file. */
const writeLegacyKey = (dir, base, key) =>
  fs.writeFileSync(path.join(dir, `${base}.key`), fakeSafeStorage().encryptString(key));

test('the key from the pre-rename install is adopted once', (t) => {
  const { credentials, dir } = harness(t);

  // What the single-provider build left behind, encrypted to this user.
  writeLegacyKey(dir, 'gemini', 'AIzaOLD');
  assert.equal(credentials.adoptLegacyKey('gemini', 'gemini'), false, 'same name is a no-op');
  fs.rmSync(path.join(dir, 'gemini.key'));

  writeLegacyKey(dir, 'legacy', 'AIzaLEGACY');
  assert.equal(credentials.adoptLegacyKey('legacy', 'gemini'), true);
  assert.equal(credentials.read('gemini', GEMINI), 'AIzaLEGACY');
});

test('adoption never overwrites a key the user has already set', (t) => {
  const { credentials, dir } = harness(t);
  credentials.store('gemini', 'AIzaCURRENT');
  writeLegacyKey(dir, 'legacy', 'AIzaOLD');

  assert.equal(credentials.adoptLegacyKey('legacy', 'gemini'), false);
  assert.equal(credentials.read('gemini', GEMINI), 'AIzaCURRENT');
});
