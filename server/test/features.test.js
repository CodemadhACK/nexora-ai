'use strict';

/**
 * Tests for the second wave of features: two-factor authentication (§53),
 * document extraction (§56) and the mail outbox (§67).
 *
 * Kept apart from platform.test.js so each file boots its own database; the two
 * run in separate processes under `node --test`.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { rmSync } = require('node:fs');
const { resolve } = require('node:path');
const nodeCrypto = require('node:crypto');
const { deflateRawSync } = require('node:zlib');

const DB = resolve(__dirname, '../data/test-features.db');
process.env.DATABASE_PATH = DB;
process.env.APP_ENCRYPTION_KEY = 'b'.repeat(64);
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@features.local';
process.env.ADMIN_PASSWORD = 'admin-features-password-1';
process.env.RATE_LIMIT_DISABLED = '1';

for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB}${suffix}`, { force: true });

const { seed } = require('../src/db/seed');
const { buildApp } = require('../src/app');
const db = require('../src/db');
const totp = require('../src/lib/totp');
const documents = require('../src/lib/documents');

let server;
let base;

before(async () => {
  seed();
  server = buildApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${DB}${suffix}`, { force: true });
    } catch {
      /* removed on the next run */
    }
  }
});

function client() {
  let cookie = '';
  return async (path, options = {}) => {
    const res = await fetch(`${base}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: 'manual',
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(';');
      if (pair.startsWith('nx_session=')) cookie = pair;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* empty */
    }
    return { status: res.status, body };
  };
}

const PASSWORD = 'a-strong-password-1';
const unique = () => `f${nodeCrypto.randomBytes(5).toString('hex')}@test.local`;

async function newUser(call) {
  const email = unique();
  const res = await call('/api/auth/signup', {
    method: 'POST',
    body: { email, password: PASSWORD, name: 'Feature User' },
  });
  return { email, res };
}

// ───────────────────────── TOTP primitive ─────────────────────────

describe('TOTP (RFC 6238)', () => {
  test('matches the published SHA-1 test vectors', () => {
    // Appendix B of RFC 6238, truncated from 8 digits to the 6 we issue.
    const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
    const vectors = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ];
    for (const [epoch, expected] of vectors) {
      assert.equal(totp.codeForStep(secret, Math.floor(epoch / 30)), expected, `T=${epoch}`);
    }
  });

  test('accepts one step of clock drift either way, but no more', () => {
    const secret = totp.generateSecret();
    const now = totp.currentStep();
    assert.notEqual(totp.verify(secret, totp.codeForStep(secret, now - 1)), null, 'one step behind');
    assert.notEqual(totp.verify(secret, totp.codeForStep(secret, now + 1)), null, 'one step ahead');
    assert.equal(totp.verify(secret, totp.codeForStep(secret, now - 5)), null, 'five steps is too far');
  });

  test('a code at or below the last used step is refused', () => {
    const secret = totp.generateSecret();
    const now = totp.currentStep();
    const code = totp.codeForStep(secret, now);
    assert.equal(totp.verify(secret, code, { lastStep: 0 }), now);
    assert.equal(totp.verify(secret, code, { lastStep: now }), null, 'replay within the window');
  });
});

// ───────────────────────── 2FA end to end ─────────────────────────

describe('two-factor authentication (§53)', () => {
  async function enrol(call) {
    const { email } = await newUser(call);
    const setup = await call('/api/auth/2fa/setup', {
      method: 'POST',
      body: { currentPassword: PASSWORD },
    });
    assert.equal(setup.status, 200);
    assert.ok(setup.body.secret, 'the secret is returned exactly once');
    assert.match(setup.body.otpauthUrl, /^otpauth:\/\/totp\//);

    const enabled = await call('/api/auth/2fa/enable', {
      method: 'POST',
      body: { code: totp.codeForStep(setup.body.secret, totp.currentStep()) },
    });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.recoveryCodes.length, 10);
    // enable() records the step it consumed, so a code from the *same* window
    // is now spent. Signing in needs the next one.
    return {
      email,
      secret: setup.body.secret,
      recoveryCodes: enabled.body.recoveryCodes,
      nextCode: () => totp.codeForStep(setup.body.secret, totp.currentStep() + 1),
    };
  }

  test('setup requires re-authentication', async () => {
    const call = client();
    await newUser(call);
    const noPassword = await call('/api/auth/2fa/setup', { method: 'POST', body: {} });
    assert.equal(noPassword.status, 403, 'turning on 2FA is a sensitive change');
  });

  test('an unconfirmed secret does not gate login', async () => {
    const call = client();
    const { email } = await newUser(call);
    await call('/api/auth/2fa/setup', { method: 'POST', body: { currentPassword: PASSWORD } });

    // Enrolment started but never confirmed. If this gated login, a mistyped QR
    // scan would lock the user out of their own account permanently.
    const fresh = client();
    const login = await fresh('/api/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });
    assert.equal(login.status, 200);
    assert.notEqual(login.body.requiresTwoFactor, true);
    assert.ok(login.body.user, 'a full session was issued');
  });

  test('enabling 2FA turns login into a two-step exchange', async () => {
    const { email, nextCode } = await enrol(client());

    const fresh = client();
    const login = await fresh('/api/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });
    assert.equal(login.body.requiresTwoFactor, true);
    assert.ok(login.body.challengeToken);
    assert.equal(login.body.user, undefined, 'no user before the second factor');
    assert.equal((await fresh('/api/auth/me')).body.user, null, 'the challenge grants no session');

    const done = await fresh('/api/auth/2fa/challenge', {
      method: 'POST',
      body: {
        challengeToken: login.body.challengeToken,
        code: nextCode(),
      },
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.user.email, email);
    assert.ok((await fresh('/api/auth/me')).body.user, 'now signed in');
  });

  test('a wrong code is refused without spending the challenge', async () => {
    const { email, nextCode } = await enrol(client());
    const fresh = client();
    const login = await fresh('/api/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });

    const wrong = await fresh('/api/auth/2fa/challenge', {
      method: 'POST',
      body: { challengeToken: login.body.challengeToken, code: '000000' },
    });
    assert.equal(wrong.status, 401);

    const right = await fresh('/api/auth/2fa/challenge', {
      method: 'POST',
      body: {
        challengeToken: login.body.challengeToken,
        code: nextCode(),
      },
    });
    assert.equal(right.status, 200, 'the same challenge still works');
  });

  test('a code cannot be replayed inside its own time step', async () => {
    const { email, nextCode } = await enrol(client());
    const code = nextCode();

    const first = client();
    const login1 = await first('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
    assert.equal(
      (await first('/api/auth/2fa/challenge', {
        method: 'POST',
        body: { challengeToken: login1.body.challengeToken, code },
      })).status,
      200,
    );

    const second = client();
    const login2 = await second('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
    const replay = await second('/api/auth/2fa/challenge', {
      method: 'POST',
      body: { challengeToken: login2.body.challengeToken, code },
    });
    assert.equal(replay.status, 401, 'the same code is refused the second time');
  });

  test('the code used to finish enrolment cannot also sign you in', async () => {
    const call = client();
    const { email } = await newUser(call);
    const setup = await call('/api/auth/2fa/setup', {
      method: 'POST',
      body: { currentPassword: PASSWORD },
    });
    const enrolCode = totp.codeForStep(setup.body.secret, totp.currentStep());
    await call('/api/auth/2fa/enable', { method: 'POST', body: { code: enrolCode } });

    const fresh = client();
    const login = await fresh('/api/auth/login', {
      method: 'POST',
      body: { email, password: PASSWORD },
    });
    const reuse = await fresh('/api/auth/2fa/challenge', {
      method: 'POST',
      body: { challengeToken: login.body.challengeToken, code: enrolCode },
    });
    assert.equal(reuse.status, 401, 'the enrolment code is spent');
  });

  test('a recovery code works once and is then spent', async () => {
    const { email, recoveryCodes } = await enrol(client());
    const code = recoveryCodes[0];

    const first = client();
    const login1 = await first('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
    const used = await first('/api/auth/2fa/challenge', {
      method: 'POST',
      body: { challengeToken: login1.body.challengeToken, code, useRecoveryCode: true },
    });
    assert.equal(used.status, 200);
    assert.equal(used.body.usedRecovery, true);

    const second = client();
    const login2 = await second('/api/auth/login', { method: 'POST', body: { email, password: PASSWORD } });
    const reuse = await second('/api/auth/2fa/challenge', {
      method: 'POST',
      body: { challengeToken: login2.body.challengeToken, code, useRecoveryCode: true },
    });
    assert.equal(reuse.status, 401, 'a spent recovery code is refused');
  });

  test('the secret is never readable after setup, and is encrypted at rest', async () => {
    const call = client();
    const { email, secret } = await enrol(call);
    const status = await call('/api/auth/2fa');

    assert.equal(status.body.enabled, true);
    assert.ok(!JSON.stringify(status.body).includes(secret), 'the status payload carries no secret');

    const userId = db.get('SELECT id FROM users WHERE email = ?', email).id;
    const stored = db.get('SELECT secret_cipher FROM totp_secrets WHERE user_id = ?', userId);
    assert.ok(!stored.secret_cipher.includes(secret), 'not stored in the clear');
    assert.equal(
      require('../src/lib/crypto').decryptSecret(stored.secret_cipher),
      secret,
      'but it still decrypts for verification',
    );
  });

  test('recovery codes are stored hashed, never in the clear', async () => {
    const call = client();
    const { email, recoveryCodes } = await enrol(call);
    const userId = db.get('SELECT id FROM users WHERE email = ?', email).id;
    const rows = db.all('SELECT code_hash FROM recovery_codes WHERE user_id = ?', userId);

    assert.equal(rows.length, 10);
    for (const row of rows) {
      assert.ok(
        !recoveryCodes.some((c) => row.code_hash.includes(c)),
        'no plaintext recovery code in the database',
      );
    }
  });
});

// ───────────────────────── document extraction ─────────────────────────

describe('document extraction (§56)', () => {
  /** A minimal but genuine .docx: a ZIP holding word/document.xml. */
  function makeDocx(xml) {
    const name = Buffer.from('word/document.xml');
    const raw = Buffer.from(xml);
    const comp = deflateRawSync(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const localPart = Buffer.concat([local, name, comp]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const centralPart = Buffer.concat([central, name]);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(centralPart.length, 12);
    eocd.writeUInt32LE(localPart.length, 16);
    return Buffer.concat([localPart, centralPart, eocd]);
  }

  test('a .docx is unzipped and reduced to its words', async () => {
    const docx = makeDocx(
      '<w:document><w:body>' +
        '<w:p><w:r><w:t>Priya Sharma</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Backend Engineer</w:t></w:r><w:tab/><w:r><w:t>5 years</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Payments service at Acme &amp; Co handling 40k req/s.</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    );
    const result = await documents.extractText({
      filename: 'cv.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      dataBase64: docx.toString('base64'),
    });

    assert.equal(result.kind, 'docx');
    assert.match(result.text, /Priya Sharma/);
    assert.match(result.text, /Backend Engineer\t5 years/, 'tabs survive');
    assert.match(result.text, /Acme & Co/, 'XML entities are decoded');
    assert.ok(!result.text.includes('<w:'), 'no markup survives');
  });

  test('a PDF text layer is extracted through the repo parser', async () => {
    const objs = [
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>endobj',
    ];
    const stream =
      'BT /F1 12 Tf 72 700 Td (Priya Sharma - Backend Engineer, five years on payment systems.) Tj ET';
    objs.push(`4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj`);
    objs.push('5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj');

    let pdf = '%PDF-1.4\n';
    const offsets = [];
    for (const o of objs) {
      offsets.push(pdf.length);
      pdf += `${o}\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
    pdf += `trailer<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`;

    const result = await documents.extractText({
      filename: 'cv.pdf',
      mimeType: 'application/pdf',
      dataBase64: Buffer.from(pdf, 'latin1').toString('base64'),
    });
    assert.equal(result.kind, 'pdf');
    assert.match(result.text, /Priya Sharma/);
  });

  test('an unsupported file type is refused with a useful message', async () => {
    await assert.rejects(
      documents.extractText({
        filename: 'photo.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('not a document').toString('base64'),
      }),
      /PDF, a Word .docx, or a plain text file/,
    );
  });

  test('an oversized upload is refused before anything is parsed', async () => {
    const huge = Buffer.alloc(documents.MAX_BYTES + 1024, 0x41);
    await assert.rejects(
      documents.extractText({
        filename: 'big.txt',
        mimeType: 'text/plain',
        dataBase64: huge.toString('base64'),
      }),
      /The limit is 8 MB/,
    );
  });

  test('an uploaded file lands in the database with its text', async () => {
    const call = client();
    const { email } = await newUser(call);
    const text = 'Priya Sharma. Backend Engineer with five years of experience on payment systems.';

    const res = await call('/api/account/resume/upload', {
      method: 'POST',
      body: {
        filename: 'cv.txt',
        mimeType: 'text/plain',
        dataBase64: Buffer.from(text).toString('base64'),
      },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.kind, 'text');

    const userId = db.get('SELECT id FROM users WHERE email = ?', email).id;
    const resume = db.get('SELECT * FROM resumes WHERE user_id = ? AND is_active = 1', userId);
    assert.equal(resume.raw_text, text);
    assert.equal(resume.extraction_status, 'PENDING', 'not analysed until asked');
    assert.ok(
      db.get('SELECT id FROM file_blobs WHERE user_id = ?', userId),
      'the original bytes are kept',
    );
  });

  test('a free user cannot run AI resume analysis', async () => {
    const call = client();
    const { email } = await newUser(call);
    await call('/api/account/resume/upload', {
      method: 'POST',
      body: {
        filename: 'cv.txt',
        mimeType: 'text/plain',
        dataBase64: Buffer.from(
          'Priya Sharma. Backend Engineer with five years building payment systems.',
        ).toString('base64'),
      },
    });
    const userId = db.get('SELECT id FROM users WHERE email = ?', email).id;
    const resume = db.get('SELECT id FROM resumes WHERE user_id = ?', userId);

    const res = await call(`/api/account/resume/${resume.id}/analyse`, { method: 'POST' });
    assert.equal(res.status, 403, 'resume analysis is a paid entitlement');
    assert.match(res.body.error.message, /does not include this feature/);
  });
});

// ───────────────────────── mail outbox ─────────────────────────

describe('notifications (§67)', () => {
  const mailer = require('../src/services/mailer');

  test('signup queues a verification email and the worker renders it', async () => {
    const call = client();
    const { email } = await newUser(call);
    const userId = db.get('SELECT id FROM users WHERE email = ?', email).id;

    const queued = db.all(
      `SELECT * FROM notifications WHERE user_id = ? AND template = 'EMAIL_VERIFY'`,
      userId,
    );
    assert.equal(queued.length, 1, 'queued once');
    assert.equal(queued[0].status, 'QUEUED');

    // Earlier tests leave mail in the outbox and flush() takes the oldest batch,
    // so drain it rather than assuming one pass reaches this row.
    let delivered = 0;
    for (let pass = 0; pass < 20; pass += 1) {
      const result = await mailer.flush({ limit: 100 });
      delivered += result.sent;
      if (result.considered === 0) break;
    }
    assert.ok(delivered > 0, 'the worker delivered something');
    assert.equal(
      db.get('SELECT status FROM notifications WHERE id = ?', queued[0].id).status,
      'SENT',
    );
  });

  test('a template that does not exist fails loudly instead of retrying for ever', async () => {
    const call = client();
    const { email } = await newUser(call);
    const userId = db.get('SELECT id FROM users WHERE email = ?', email).id;

    db.run(
      `INSERT INTO notifications (id, user_id, template, payload) VALUES (?, ?, 'NO_SUCH_TEMPLATE', '{}')`,
      require('../src/lib/crypto').newId('ntf'),
      userId,
    );
    for (let pass = 0; pass < 20; pass += 1) {
      if ((await mailer.flush({ limit: 100 })).considered === 0) break;
    }

    const row = db.get(
      `SELECT * FROM notifications WHERE user_id = ? AND template = 'NO_SUCH_TEMPLATE'`,
      userId,
    );
    assert.equal(row.status, 'FAILED');
    assert.match(row.error, /No template named/);
  });

  test('opting out suppresses a marketing email but not a security one', async () => {
    const call = client();
    const { email } = await newUser(call);
    const userId = db.get('SELECT id FROM users WHERE email = ?', email).id;
    const notifications = require('../src/services/notifications');

    db.run('UPDATE notification_preferences SET product_updates = 0 WHERE user_id = ?', userId);

    notifications.queue(userId, 'PRODUCT_UPDATE', { body: 'news' });
    notifications.queue(userId, 'SECURITY_ALERT', { event: 'two_factor_enabled' });

    const marketing = db.get(
      `SELECT status FROM notifications WHERE user_id = ? AND template = 'PRODUCT_UPDATE'`,
      userId,
    );
    const security = db.get(
      `SELECT status FROM notifications WHERE user_id = ? AND template = 'SECURITY_ALERT'`,
      userId,
    );
    assert.equal(marketing.status, 'SKIPPED', 'honours the preference');
    assert.equal(security.status, 'QUEUED', 'transactional mail is not opt-out');
  });
});
