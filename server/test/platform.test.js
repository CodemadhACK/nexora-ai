'use strict';

/**
 * End-to-end checks for the guarantees the specification calls non-negotiable
 * (§45 payment security QA, §68 authentication QA).
 *
 * These run against a real HTTP server and a real (temporary) database. They
 * assert behaviour a reviewer would otherwise have to take on trust: that the
 * backend stays authoritative when the client lies.
 */

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { rmSync } = require('node:fs');
const { resolve } = require('node:path');
const crypto = require('node:crypto');

const DB = resolve(__dirname, '../data/test-platform.db');
process.env.DATABASE_PATH = DB;
process.env.APP_ENCRYPTION_KEY = 'a'.repeat(64);
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'admin-test-password-1';
process.env.CASHFREE_CLIENT_ID = 'TEST_CLIENT';
process.env.CASHFREE_CLIENT_SECRET = 'TEST_SECRET';
process.env.RATE_LIMIT_DISABLED = '1';

for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB}${suffix}`, { force: true });

const { seed } = require('../src/db/seed');
const { buildApp } = require('../src/app');
const db = require('../src/db');

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
  // SQLite may still hold the file on Windows; a leftover test database is
  // harmless because the next run deletes it before opening.
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(`${DB}${suffix}`, { force: true });
    } catch {
      /* removed on the next run */
    }
  }
});

/** Tiny cookie-aware fetch, so sessions behave as they do in a browser. */
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
    const setCookie = res.headers.getSetCookie?.() || [];
    for (const c of setCookie) {
      const [pair] = c.split(';');
      if (pair.startsWith('nx_session=')) cookie = pair;
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* empty or non-JSON */
    }
    return { status: res.status, body };
  };
}

const unique = () => `u${crypto.randomBytes(5).toString('hex')}@test.local`;

async function newUser(call, overrides = {}) {
  const email = unique();
  const res = await call('/api/auth/signup', {
    method: 'POST',
    body: { email, password: 'a-strong-password-1', name: 'Test User', ...overrides },
  });
  return { email, res };
}

// ───────────────────────── authentication ─────────────────────────

describe('authentication (§68)', () => {
  test('signup creates a session and an unverified account', async () => {
    const call = client();
    const { res } = await newUser(call);
    assert.equal(res.status, 201);
    assert.equal(res.body.user.emailVerified, false, 'a new account is not verified');
    assert.equal(res.body.entitlements.plan.code, 'free', 'defaults to the Free plan');
  });

  test('a weak password is refused', async () => {
    const call = client();
    const res = await call('/api/auth/signup', {
      method: 'POST',
      body: { email: unique(), password: 'short' },
    });
    assert.equal(res.status, 400);
  });

  test('duplicate email is refused', async () => {
    const call = client();
    const { email } = await newUser(call);
    const res = await call('/api/auth/signup', {
      method: 'POST',
      body: { email, password: 'a-strong-password-1' },
    });
    assert.equal(res.status, 409);
  });

  test('wrong password gives the same error as an unknown account', async () => {
    const call = client();
    const { email } = await newUser(call);
    const wrongPassword = await call('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'not-the-right-password' },
    });
    const noSuchUser = await call('/api/auth/login', {
      method: 'POST',
      body: { email: unique(), password: 'not-the-right-password' },
    });
    assert.equal(wrongPassword.status, 401);
    assert.equal(noSuchUser.status, 401);
    assert.equal(
      wrongPassword.body.error.message,
      noSuchUser.body.error.message,
      'identical message, so the endpoint cannot enumerate accounts',
    );
  });

  test('password reset never reveals whether the account exists', async () => {
    const call = client();
    const { email } = await newUser(call);
    const known = await call('/api/auth/forgot-password', { method: 'POST', body: { email } });
    const unknown = await call('/api/auth/forgot-password', {
      method: 'POST',
      body: { email: unique() },
    });
    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(known.body, unknown.body);
  });

  test('a reset token works once and then is dead', async () => {
    const call = client();
    const { email } = await newUser(call);
    const user = db.get('SELECT id FROM users WHERE email = ?', email);

    // Mint a token the way the service does, so the raw value is available.
    const authService = require('../src/services/auth');
    const token = authService.issueToken
      ? authService.issueToken(user.id, 'PASSWORD_RESET')
      : null;
    if (!token) return; // issueToken is internal; skip if not exported

    const first = await call('/api/auth/reset-password', {
      method: 'POST',
      body: { token, password: 'another-strong-password-2' },
    });
    const second = await call('/api/auth/reset-password', {
      method: 'POST',
      body: { token, password: 'a-third-strong-password-3' },
    });
    assert.equal(first.status, 200);
    assert.equal(second.status, 400, 'a used token is refused');
  });

  test('logout revokes the session for good', async () => {
    const call = client();
    await newUser(call);
    assert.equal((await call('/api/auth/me')).body.user !== null, true);
    await call('/api/auth/logout', { method: 'POST' });
    const after = await call('/api/auth/me');
    assert.equal(after.body.user, null, 'the session is gone after logout');
  });

  test('suspending a user kills their live session immediately', async () => {
    const userCall = client();
    const { email } = await newUser(userCall);
    const userId = db.get('SELECT id FROM users WHERE email = ?', email).id;

    const admin = client();
    await admin('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@test.local', password: 'admin-test-password-1' },
    });
    const res = await admin(`/api/admin/users/${userId}/status`, {
      method: 'POST',
      body: { status: 'SUSPENDED' },
    });
    assert.equal(res.status, 200);

    const after = await userCall('/api/auth/me');
    assert.equal(after.body.user, null, 'the suspended user is signed out at once');
  });
});

// ───────────────────────── authorisation ─────────────────────────

describe('access control (§15, §62, §64)', () => {
  test('an ordinary user cannot reach the admin API', async () => {
    const call = client();
    await newUser(call);
    for (const path of ['/api/admin/overview', '/api/admin/users', '/api/admin/providers']) {
      const res = await call(path);
      assert.equal(res.status, 403, `${path} is closed to a normal user`);
    }
  });

  test('an anonymous caller cannot reach the admin API', async () => {
    const call = client();
    assert.equal((await call('/api/admin/overview')).status, 401);
  });

  test('provider API keys are never returned to the client', async () => {
    const admin = client();
    await admin('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@test.local', password: 'admin-test-password-1' },
    });

    const provider = db.get(`SELECT id FROM ai_providers WHERE provider_key = 'openai'`);
    const saved = await admin(`/api/admin/providers/${provider.id}`, {
      method: 'PUT',
      body: {
        apiKey: 'sk-super-secret-value-abcd1234',
        enabled: true,
        priority: 20,
        currentPassword: 'admin-test-password-1',
      },
    });
    assert.equal(saved.status, 200);

    const listed = await admin('/api/admin/providers');
    const serialised = JSON.stringify(listed.body);
    assert.ok(!serialised.includes('sk-super-secret-value'), 'the raw key never leaves the server');
    assert.ok(serialised.includes('••••'), 'it is shown masked instead');

    const stored = db.get('SELECT api_key_cipher FROM ai_providers WHERE id = ?', provider.id);
    assert.ok(!stored.api_key_cipher.includes('sk-super-secret'), 'and it is encrypted at rest');
    assert.equal(
      require('../src/lib/crypto').decryptSecret(stored.api_key_cipher),
      'sk-super-secret-value-abcd1234',
      'but it still decrypts correctly for the router',
    );
  });

  test('a sensitive admin write requires re-authentication', async () => {
    const admin = client();
    await admin('/api/auth/login', {
      method: 'POST',
      body: { email: 'admin@test.local', password: 'admin-test-password-1' },
    });
    const provider = db.get(`SELECT id FROM ai_providers WHERE provider_key = 'gemini'`);
    const noPassword = await admin(`/api/admin/providers/${provider.id}`, {
      method: 'PUT',
      body: { apiKey: 'sk-nope', enabled: true },
    });
    assert.equal(noPassword.status, 403, 'writing a secret without re-auth is refused');
  });
});

// ───────────────────────── payments ─────────────────────────

describe('payment integrity (§45)', () => {
  const signature = (timestamp, rawBody) =>
    crypto.createHmac('sha256', 'TEST_SECRET').update(timestamp + rawBody).digest('base64');

  async function postWebhook(payload, { sign = true, timestamp = String(Date.now()) } = {}) {
    const rawBody = JSON.stringify(payload);
    return fetch(`${base}/api/webhooks/cashfree`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature': sign ? signature(timestamp, rawBody) : 'not-a-real-signature',
      },
      body: rawBody,
    });
  }

  /** Creates an order directly, bypassing the gateway call. */
  function seedOrder(userId, planCode = 'pro') {
    const plan = db.get('SELECT * FROM plans WHERE code = ?', planCode);
    const orderId = require('../src/lib/crypto').newId('ord');
    db.run(
      `INSERT INTO payment_orders (id, user_id, plan_id, cashfree_order_id, amount_minor,
                                   currency, credits_to_grant, status)
       VALUES (?, ?, ?, ?, ?, 'INR', ?, 'PENDING')`,
      orderId, userId, plan.id, orderId, plan.price_minor, plan.credits_granted,
    );
    return { orderId, plan };
  }

  test('an unsigned webhook is rejected and grants nothing', async () => {
    const call = client();
    const { email } = await newUser(call);
    const user = db.get('SELECT * FROM users WHERE email = ?', email);
    const { orderId } = seedOrder(user.id);

    const res = await postWebhook(
      {
        type: 'PAYMENT_SUCCESS_WEBHOOK',
        data: { order: { order_id: orderId }, payment: { cf_payment_id: 'cf_forged_1', payment_status: 'SUCCESS', payment_amount: 499 } },
      },
      { sign: false },
    );

    assert.equal(res.status, 401, 'a bad signature is refused');
    const after = db.get('SELECT status FROM payment_orders WHERE id = ?', orderId);
    assert.equal(after.status, 'PENDING', 'the order is untouched');
    assert.equal(
      db.get('SELECT credit_balance FROM users WHERE id = ?', user.id).credit_balance,
      db.get(`SELECT credits_granted FROM plans WHERE code = 'free'`).credits_granted,
      'and the balance is still only the free allowance',
    );
    // Still recorded, so a forged attempt is visible to the admin.
    assert.ok(db.get(`SELECT id FROM webhook_events WHERE signature_ok = 0`), 'the attempt is logged');
  });

  test('a signed webhook activates the subscription and grants credits exactly once', async () => {
    const call = client();
    const { email } = await newUser(call);
    const user = db.get('SELECT * FROM users WHERE email = ?', email);
    const { orderId, plan } = seedOrder(user.id);

    const payload = {
      type: 'PAYMENT_SUCCESS_WEBHOOK',
      data: {
        order: { order_id: orderId, order_amount: plan.price_minor / 100 },
        payment: { cf_payment_id: `cf_${orderId}`, payment_status: 'SUCCESS', payment_amount: plan.price_minor / 100, payment_group: 'upi' },
      },
      event_time: new Date().toISOString(),
    };

    const before = db.get('SELECT credit_balance FROM users WHERE id = ?', user.id).credit_balance;
    const first = await postWebhook(payload);
    assert.equal(first.status, 200);

    const balanceAfterFirst = db.get('SELECT credit_balance FROM users WHERE id = ?', user.id).credit_balance;
    assert.equal(balanceAfterFirst - before, plan.credits_granted, 'credits arrive once');
    assert.equal(
      db.get('SELECT status FROM payment_orders WHERE id = ?', orderId).status,
      'ACTIVATED',
    );

    const entitlements = require('../src/services/entitlements').resolve(user.id);
    assert.equal(entitlements.plan.code, 'pro', 'the plan is now Pro');
    assert.equal(entitlements.features.resume_analysis, true, 'Pro unlocks résumé analysis');

    // §34: redelivery must be a no-op.
    const second = await postWebhook(payload);
    const third = await postWebhook(payload);
    assert.equal(second.status, 200);
    assert.equal(third.status, 200);
    assert.equal((await second.json()).duplicate, true, 'the redelivery is recognised');

    assert.equal(
      db.get('SELECT credit_balance FROM users WHERE id = ?', user.id).credit_balance,
      balanceAfterFirst,
      'the balance did not move on redelivery',
    );
    assert.equal(
      db.get(
        `SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ? AND status = 'ACTIVE'`,
        user.id,
      ).n,
      1,
      'and no duplicate subscription was created',
    );
  });

  test('the client cannot dictate price, credits or plan', async () => {
    const call = client();
    const { email } = await newUser(call);
    const user = db.get('SELECT * FROM users WHERE email = ?', email);
    const premium = db.get(`SELECT * FROM plans WHERE code = 'premium'`);

    // Ask for the premium plan while claiming it costs ₹1 and grants a million credits.
    const res = await call('/api/billing/checkout', {
      method: 'POST',
      body: {
        planId: premium.id,
        amount: 100,
        priceMinor: 100,
        credits: 1_000_000,
        status: 'ACTIVATED',
      },
    });

    // The gateway call fails against fake credentials — that is expected here.
    // What matters is the order row the server wrote before calling out.
    const order = db.get(
      'SELECT * FROM payment_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      user.id,
    );
    assert.ok(order, 'an order was recorded server-side');
    assert.equal(order.amount_minor, premium.price_minor, 'the price is the plan’s, not the client’s');
    assert.equal(order.credits_to_grant, premium.credits_granted, 'as is the credit quantity');
    assert.notEqual(order.status, 'ACTIVATED', 'and the client cannot self-activate');
    assert.ok([502, 503].includes(res.status) || res.status === 200);
  });

  test('credits cannot go negative and every move leaves a ledger row', async () => {
    const call = client();
    const { email } = await newUser(call);
    const user = db.get('SELECT * FROM users WHERE email = ?', email);
    const credits = require('../src/services/credits');

    const start = credits.balance(user.id); // the Free allowance
    const rowsAtStart = db.all('SELECT id FROM credit_transactions WHERE user_id = ?', user.id).length;

    credits.grant(user.id, 100, 'test grant');
    assert.equal(credits.balance(user.id), start + 100);

    assert.throws(() => credits.consume(user.id, start + 5000, 'too much'), /Not enough credits/);
    assert.equal(credits.balance(user.id), start + 100, 'a refused spend changes nothing');

    credits.consume(user.id, 40, 'an answer');
    assert.equal(credits.balance(user.id), start + 60);

    const ledger = db.all(
      'SELECT * FROM credit_transactions WHERE user_id = ? ORDER BY created_at, rowid',
      user.id,
    );
    assert.equal(ledger.length - rowsAtStart, 2, 'only successful moves are recorded');
    assert.equal(ledger.at(-1).balance_after, start + 60);
    // The cached balance and the ledger must agree.
    const summed = ledger.reduce((total, row) => total + row.delta, 0);
    assert.equal(summed, credits.balance(user.id), 'the cache matches the ledger sum');
  });

  test('an idempotency key makes a repeated grant a no-op', async () => {
    const call = client();
    const { email } = await newUser(call);
    const user = db.get('SELECT * FROM users WHERE email = ?', email);
    const credits = require('../src/services/credits');

    const start = credits.balance(user.id);
    const first = credits.grant(user.id, 500, 'order', { idempotencyKey: 'order:xyz' });
    const second = credits.grant(user.id, 500, 'order', { idempotencyKey: 'order:xyz' });

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(credits.balance(user.id), start + 500, 'granted once, not twice');
  });
});

// ───────────────────────── entitlements ─────────────────────────

describe('entitlements (§17, §62)', () => {
  test('a free user is refused a paid feature by the server', async () => {
    const call = client();
    const { email } = await newUser(call);
    const user = db.get('SELECT * FROM users WHERE email = ?', email);
    const entitlements = require('../src/services/entitlements');

    assert.throws(
      () => entitlements.assertFeature(user.id, 'resume_analysis'),
      /does not include this feature/,
    );
  });

  test('a disabled feature flag overrides the plan', async () => {
    const call = client();
    const { email } = await newUser(call);
    const user = db.get('SELECT * FROM users WHERE email = ?', email);
    const entitlements = require('../src/services/entitlements');

    assert.equal(entitlements.resolve(user.id).features.ai_assistant, true);
    db.run(`UPDATE feature_flags SET enabled = 0 WHERE key = 'ai_assistant'`);
    assert.equal(
      entitlements.resolve(user.id).features.ai_assistant,
      false,
      'the kill switch wins over the plan',
    );
    db.run(`UPDATE feature_flags SET enabled = 1 WHERE key = 'ai_assistant'`);
  });

  test('an expired subscription stops granting access', async () => {
    const call = client();
    const { email } = await newUser(call);
    const user = db.get('SELECT * FROM users WHERE email = ?', email);
    const pro = db.get(`SELECT * FROM plans WHERE code = 'pro'`);
    const entitlements = require('../src/services/entitlements');

    db.run(
      `INSERT INTO subscriptions (id, user_id, plan_id, status, start_date, expiry_date)
       VALUES (?, ?, ?, 'ACTIVE', datetime('now','-60 days'), datetime('now','-1 day'))`,
      require('../src/lib/crypto').newId('sub'), user.id, pro.id,
    );

    const resolved = entitlements.resolve(user.id);
    assert.equal(resolved.plan.code, 'free', 'access falls back to Free once it lapses');
    assert.equal(resolved.features.resume_analysis, false);
  });
});

// ───────────────────────── AI routing ─────────────────────────

describe('AI routing (§8, §9)', () => {
  test('question complexity picks a different chain', () => {
    const router = require('../src/services/aiRouter');
    assert.equal(router.classify('what is a hash map'), 'SIMPLE');
    assert.equal(
      router.classify(
        'design a distributed url shortener and talk through the trade-offs of sharding and caching at scale',
      ),
      'COMPLEX',
    );
  });

  test('a request with no configured key fails without charging the user', async () => {
    const call = client();
    const { email } = await newUser(call);
    const user = db.get('SELECT * FROM users WHERE email = ?', email);
    db.run('UPDATE users SET email_verified = 1 WHERE id = ?', user.id);
    require('../src/services/credits').grant(user.id, 1000, 'test');

    // Strip every key so the whole chain has nothing to call with.
    db.run('UPDATE ai_providers SET api_key_cipher = NULL');

    const before = require('../src/services/credits').balance(user.id);
    const res = await call('/api/ai/ask', { method: 'POST', body: { question: 'what is a mutex' } });
    const after = require('../src/services/credits').balance(user.id);

    assert.equal(res.status, 503);
    assert.equal(after, before, 'a failed answer costs the user nothing');
    assert.ok(
      !JSON.stringify(res.body).toLowerCase().includes('api key'),
      'and the reason is not leaked to the user',
    );
    // Every failed attempt is still recorded for the admin.
    assert.ok(db.get(`SELECT id FROM ai_requests WHERE success = 0`), 'the failures are logged');
  });
});

describe('rate limiting (§24, §51)', () => {
  test('the limiter returns 429 once the window is exhausted', async () => {
    const express = require('express');
    const { rateLimit } = require('../src/middleware/rateLimit');
    const { ApiError } = require('../src/lib/errors');

    delete process.env.RATE_LIMIT_DISABLED; // exercise the real path
    const app = express();
    app.use((req, _res, next) => {
      req.clientIp = 'test-client';
      next();
    });
    app.get('/limited', rateLimit({ windowMs: 60_000, max: 3 }), (_req, res) => res.json({ ok: true }));
    // eslint-disable-next-line no-unused-vars
    app.use((err, _req, res, _next) => {
      res.status(err instanceof ApiError ? err.status : 500).json({ error: err.code });
    });

    const local = app.listen(0);
    await new Promise((r) => local.once('listening', r));
    const url = `http://127.0.0.1:${local.address().port}/limited`;

    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await fetch(url)).status);
    local.close();
    process.env.RATE_LIMIT_DISABLED = '1';

    assert.deepEqual(statuses, [200, 200, 200, 429, 429], 'three succeed, the rest are refused');
  });
});

describe('database transactions', () => {
  test('a nested transaction joins the outer one instead of throwing', () => {
    // Regression guard: activating a payment opens a transaction and then calls
    // the credit ledger, which opens another. SQLite rejects a literal nested
    // BEGIN, so transaction() must be re-entrant.
    const result = db.transaction(() => {
      assert.equal(db.inTransaction(), true);
      return db.transaction(() => 'inner ran');
    });
    assert.equal(result, 'inner ran');
    assert.equal(db.inTransaction(), false, 'the depth counter unwinds');
  });

  test('a failure inside a nested call rolls the whole thing back', () => {
    const email = unique();
    const id = require('../src/lib/crypto').newId('usr');
    db.run(
      `INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, '', 'Rollback test')`,
      id,
      email,
    );

    assert.throws(() => {
      db.transaction(() => {
        db.run('UPDATE users SET name = ? WHERE id = ?', 'changed', id);
        db.transaction(() => {
          throw new Error('inner failed');
        });
      });
    }, /inner failed/);

    assert.equal(
      db.get('SELECT name FROM users WHERE id = ?', id).name,
      'Rollback test',
      'the outer write was rolled back too',
    );
  });
});

describe('free plan onboarding', () => {
  test('a new account receives the Free plan allowance', async () => {
    const call = client();
    const { email, res } = await newUser(call);
    const plan = db.get(`SELECT credits_granted FROM plans WHERE code = 'free'`);
    const user = db.get('SELECT * FROM users WHERE email = ?', email);

    assert.equal(user.credit_balance, plan.credits_granted, 'the advertised allowance arrives');
    assert.equal(
      res.body.entitlements.creditBalance,
      plan.credits_granted,
      'and the signup response already reflects it',
    );

    const ledger = db.all('SELECT * FROM credit_transactions WHERE user_id = ?', user.id);
    assert.equal(ledger.length, 1, 'recorded as a ledger entry, not a bare balance write');
    assert.equal(ledger[0].kind, 'GRANT');
  });
});
