'use strict';

/**
 * Cashfree Payment Gateway (§29–§47).
 *
 * Endpoints, headers and the webhook signature scheme below were taken from the
 * current Cashfree documentation, not from memory:
 *   Create order : POST {base}/pg/orders
 *   Fetch order  : GET  {base}/pg/orders/{order_id}
 *   Payments     : GET  {base}/pg/orders/{order_id}/payments
 *   Webhook      : base64( HMAC-SHA256( timestamp + rawBody, secretKey ) )
 *                  carried in x-webhook-signature / x-webhook-timestamp
 *   https://www.cashfree.com/docs/api-reference/payments/latest/orders/create
 *   https://www.cashfree.com/docs/payments/online/webhooks/overview
 *
 * The security rule that shapes this whole file: a frontend redirect is never
 * proof of payment. Nothing is activated until either a signature-verified
 * webhook or a server-to-server order fetch says the order is PAID.
 */

const { get, run, transaction, all } = require('../db');
const crypto = require('../lib/crypto');
const { ApiError, badRequest, notFound } = require('../lib/errors');
const credits = require('./credits');
const notifications = require('./notifications');
const audit = require('../lib/audit');

const API_VERSION = '2026-01-01';
const SANDBOX_BASE = 'https://sandbox.cashfree.com';
const PRODUCTION_BASE = 'https://api.cashfree.com';

// ───────────────────────── configuration ─────────────────────────

/**
 * Credentials live in the settings table, encrypted, and are editable from the
 * admin console (§30). Environment variables win when present, so a deployment
 * can keep secrets entirely out of the database if it prefers.
 */
function config() {
  const setting = (key) => {
    const row = get('SELECT value, encrypted FROM settings WHERE key = ?', key);
    if (!row || !row.value) return null;
    return row.encrypted ? crypto.decryptSecret(row.value) : row.value;
  };

  const mode = process.env.CASHFREE_MODE || setting('cashfree.mode') || 'sandbox';
  return {
    enabled: (setting('cashfree.enabled') ?? 'false') === 'true' || !!process.env.CASHFREE_CLIENT_ID,
    mode,
    base: mode === 'production' ? PRODUCTION_BASE : SANDBOX_BASE,
    clientId: process.env.CASHFREE_CLIENT_ID || setting('cashfree.client_id'),
    clientSecret: process.env.CASHFREE_CLIENT_SECRET || setting('cashfree.client_secret'),
  };
}

function assertConfigured() {
  const cfg = config();
  if (!cfg.clientId || !cfg.clientSecret) {
    throw new ApiError(503, 'GATEWAY_UNCONFIGURED', 'Payments are not available right now.');
  }
  return cfg;
}

function headers(cfg, idempotencyKey) {
  const h = {
    'Content-Type': 'application/json',
    'x-api-version': API_VERSION,
    'x-client-id': cfg.clientId,
    'x-client-secret': cfg.clientSecret,
  };
  if (idempotencyKey) h['x-idempotency-key'] = idempotencyKey;
  return h;
}

async function callCashfree(path, { method = 'GET', body, cfg, idempotencyKey } = {}) {
  const settings = cfg || assertConfigured();
  const res = await fetch(`${settings.base}${path}`, {
    method,
    headers: headers(settings, idempotencyKey),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    // Cashfree's own message is logged but never forwarded verbatim: it can
    // carry account and configuration detail a customer should not see.
    console.error('[cashfree] request failed', { path, status: res.status, data });
    throw new ApiError(502, 'GATEWAY_ERROR', 'We could not reach the payment gateway. Please try again.');
  }
  return data;
}

// ───────────────────────── checkout (§32) ─────────────────────────

/**
 * Creates a payment order.
 *
 * Every figure is read from the database here. The client sends a plan id and
 * nothing else — price, currency and credit quantity are the server's decision,
 * snapshotted onto the order row so a later price change cannot alter what this
 * customer agreed to pay.
 */
async function createOrder({ user, planId, returnUrl }) {
  const cfg = assertConfigured();

  const plan = get(`SELECT * FROM plans WHERE id = ? AND status = 'ACTIVE'`, planId);
  if (!plan) throw notFound('That plan is not available.');
  if (plan.price_minor <= 0) throw badRequest('That plan does not require payment.');

  const orderId = crypto.newId('ord');
  // Cashfree requires a customer phone; a synthetic placeholder keeps checkout
  // working for accounts that have not supplied one.
  const phone = (user.phone || '').replace(/\D/g, '') || '9999999999';

  transaction(() => {
    run(
      `INSERT INTO payment_orders
         (id, user_id, plan_id, kind, cashfree_order_id, amount_minor, currency,
          credits_to_grant, status)
       VALUES (?, ?, ?, 'SUBSCRIPTION', ?, ?, ?, ?, 'CREATED')`,
      orderId,
      user.id,
      plan.id,
      orderId,
      plan.price_minor,
      plan.currency,
      plan.credits_granted,
    );
  });

  const payload = {
    order_id: orderId,
    // Cashfree takes major units (rupees); we store paise.
    order_amount: Number((plan.price_minor / 100).toFixed(2)),
    order_currency: plan.currency,
    customer_details: {
      customer_id: user.id,
      customer_phone: phone,
      customer_email: user.email,
      customer_name: user.name || undefined,
    },
    order_meta: {
      return_url: `${returnUrl}?order_id=${orderId}`,
    },
    order_note: `${plan.name} — ${plan.billing_period.toLowerCase()}`,
  };

  let response;
  try {
    response = await callCashfree('/pg/orders', {
      method: 'POST',
      body: payload,
      cfg,
      idempotencyKey: orderId,
    });
  } catch (err) {
    run(
      `UPDATE payment_orders SET status='FAILED', failure_reason=?, updated_at=datetime('now') WHERE id=?`,
      'gateway_create_failed',
      orderId,
    );
    throw err;
  }

  run(
    `UPDATE payment_orders SET cf_order_id = ?, status = 'PENDING', updated_at = datetime('now')
      WHERE id = ?`,
    response.cf_order_id || null,
    orderId,
  );

  // Only what the checkout SDK needs. No secrets, no internal configuration.
  return {
    orderId,
    paymentSessionId: response.payment_session_id,
    mode: cfg.mode,
    amountMinor: plan.price_minor,
    currency: plan.currency,
    planName: plan.name,
  };
}

// ───────────────────────── verification (§32, §35) ─────────────────────────

const TERMINAL = new Set(['ACTIVATED', 'REFUNDED']);

/**
 * Activates an order exactly once.
 *
 * Idempotency has two layers: the order's own status guard, and the credit
 * ledger's (user, idempotency_key) unique index. Either alone would be enough
 * for the common case; both together mean a webhook redelivered concurrently
 * with a return-url poll cannot double-grant.
 */
function activateOrder(orderId, { source }) {
  return transaction(() => {
    const order = get('SELECT * FROM payment_orders WHERE id = ?', orderId);
    if (!order) throw notFound('No such order.');
    if (TERMINAL.has(order.status)) return { order, alreadyActive: true };

    const plan = get('SELECT * FROM plans WHERE id = ?', order.plan_id);
    const now = new Date();
    const expiry = new Date(now);
    if (plan.billing_period === 'YEARLY') expiry.setFullYear(expiry.getFullYear() + 1);
    else if (plan.billing_period === 'MONTHLY') expiry.setMonth(expiry.getMonth() + 1);
    else expiry.setFullYear(expiry.getFullYear() + 100); // one-time purchases do not lapse

    const iso = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

    // Supersede any running subscription, then start the new one.
    run(
      `UPDATE subscriptions SET status='CANCELLED', updated_at=datetime('now')
        WHERE user_id = ? AND status = 'ACTIVE'`,
      order.user_id,
    );
    const subscriptionId = crypto.newId('sub');
    run(
      `INSERT INTO subscriptions
         (id, user_id, plan_id, status, start_date, next_billing_date, expiry_date)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)`,
      subscriptionId,
      order.user_id,
      order.plan_id,
      iso(now),
      iso(expiry),
      iso(expiry),
    );

    if (order.credits_to_grant > 0) {
      credits.grant(order.user_id, order.credits_to_grant, `${plan.name} subscription`, {
        refType: 'payment_order',
        refId: order.id,
        // The guard that makes a repeated webhook harmless.
        idempotencyKey: `order:${order.id}`,
      });
    }

    const invoiceNumber = `INV-${new Date().getFullYear()}-${order.id.slice(-8).toUpperCase()}`;
    run(
      `INSERT OR IGNORE INTO invoices
         (id, user_id, payment_order_id, number, amount_minor, currency, description)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.newId('inv'),
      order.user_id,
      order.id,
      invoiceNumber,
      order.amount_minor,
      order.currency,
      `${plan.name} — ${plan.billing_period.toLowerCase()}`,
    );

    run(
      `UPDATE payment_orders
          SET status='ACTIVATED', activated_at=datetime('now'), updated_at=datetime('now')
        WHERE id = ?`,
      order.id,
    );

    notifications.queue(order.user_id, 'PAYMENT_SUCCESS', {
      planName: plan.name,
      credits: order.credits_to_grant,
      amountMinor: order.amount_minor,
    });
    audit.log({
      actorId: order.user_id,
      action: 'payment.activated',
      targetType: 'payment_order',
      targetId: order.id,
      next: { source, subscriptionId, credits: order.credits_to_grant },
    });

    return { order: get('SELECT * FROM payment_orders WHERE id = ?', order.id), alreadyActive: false };
  });
}

/**
 * Server-to-server truth check. Used by the return-url poll and by admin
 * reconciliation — never trusts anything the browser reported.
 */
async function verifyAndSettle(orderId) {
  const order = get('SELECT * FROM payment_orders WHERE id = ?', orderId);
  if (!order) throw notFound('No such order.');
  if (TERMINAL.has(order.status)) return { status: order.status, settled: true };

  const remote = await callCashfree(`/pg/orders/${encodeURIComponent(orderId)}`);
  const status = remote.order_status;

  if (status === 'PAID') {
    try {
      const payments = await callCashfree(`/pg/orders/${encodeURIComponent(orderId)}/payments`);
      const paid = Array.isArray(payments) ? payments.find((p) => p.payment_status === 'SUCCESS') : null;
      if (paid) recordTransaction(order.id, paid);
    } catch {
      // The order is PAID; failing to list individual payments must not block
      // activation. Reconciliation will fill the transaction row in later.
    }
    run(`UPDATE payment_orders SET status='PAID', updated_at=datetime('now') WHERE id=? AND status NOT IN ('ACTIVATED','REFUNDED')`, order.id);
    const result = activateOrder(order.id, { source: 'verify' });
    return { status: 'ACTIVATED', settled: true, alreadyActive: result.alreadyActive };
  }

  if (status === 'EXPIRED' || status === 'TERMINATED') {
    run(
      `UPDATE payment_orders SET status='FAILED', failure_reason=?, updated_at=datetime('now')
        WHERE id=? AND status NOT IN ('ACTIVATED','REFUNDED')`,
      status.toLowerCase(),
      order.id,
    );
    return { status: 'FAILED', settled: true };
  }

  return { status: 'PENDING', settled: false };
}

function recordTransaction(orderId, payment) {
  run(
    `INSERT OR IGNORE INTO payment_transactions
       (id, payment_order_id, cf_payment_id, status, amount_minor, payment_method, payment_group, gateway_response)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    crypto.newId('ptx'),
    orderId,
    String(payment.cf_payment_id ?? ''),
    payment.payment_status || 'UNKNOWN',
    Math.round(Number(payment.payment_amount || 0) * 100),
    typeof payment.payment_method === 'string'
      ? payment.payment_method
      : Object.keys(payment.payment_method || {})[0] || '',
    payment.payment_group || '',
    JSON.stringify(payment).slice(0, 8000),
  );
}

// ───────────────────────── webhooks (§34) ─────────────────────────

/** base64(HMAC-SHA256(timestamp + rawBody, secret)), compared in constant time. */
function verifySignature({ signature, timestamp, rawBody }) {
  const cfg = config();
  if (!cfg.clientSecret) return false;
  const expected = crypto.cashfreeWebhookSignature(timestamp, rawBody, cfg.clientSecret);
  return crypto.safeEqual(expected, signature || '');
}

/**
 * Persists the event first, acts second.
 *
 * The UNIQUE (provider, dedupe_key) constraint is the idempotency guarantee: a
 * redelivered webhook fails the insert and returns `duplicate`, so nothing
 * downstream runs twice. Storing before acting also means a crash mid-handler
 * leaves a replayable record rather than a silently lost payment.
 */
async function handleWebhook({ rawBody, signature, timestamp }) {
  const signatureOk = verifySignature({ signature, timestamp, rawBody });

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw badRequest('Malformed webhook payload.');
  }

  const type = event.type || 'UNKNOWN';
  const data = event.data || {};
  const dedupeKey =
    String(data.payment?.cf_payment_id || '') ||
    (data.refund?.cf_refund_id
      ? `refund:${data.refund.cf_refund_id}:${data.refund.refund_status ?? ''}`
      : '') ||
    `${type}:${data.order?.order_id || ''}:${event.event_time || ''}`;

  let stored;
  try {
    const id = crypto.newId('whk');
    run(
      `INSERT INTO webhook_events (id, provider, event_type, dedupe_key, raw_body, signature_ok)
       VALUES (?, 'cashfree', ?, ?, ?, ?)`,
      id,
      type,
      dedupeKey,
      String(rawBody).slice(0, 20000),
      signatureOk ? 1 : 0,
    );
    stored = id;
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return { duplicate: true, signatureOk, type };
    }
    throw err;
  }

  // Recorded above for forensics, then refused. An unsigned event is either a
  // misconfiguration or an attack; neither should move money.
  if (!signatureOk) {
    run(`UPDATE webhook_events SET process_error='bad_signature' WHERE id = ?`, stored);
    throw new ApiError(401, 'BAD_SIGNATURE', 'Invalid webhook signature.');
  }

  const orderId = data.order?.order_id;
  try {
    if (type === 'PAYMENT_SUCCESS_WEBHOOK' && orderId) {
      if (data.payment) recordTransaction(orderId, data.payment);
      run(
        `UPDATE payment_orders SET status='PAID', updated_at=datetime('now')
          WHERE id=? AND status NOT IN ('ACTIVATED','REFUNDED')`,
        orderId,
      );
      activateOrder(orderId, { source: 'webhook' });
    } else if (type === 'REFUND_STATUS_WEBHOOK' && data.refund) {
      // Cashfree reports the terminal state of a refund asynchronously; our row
      // is created as PENDING when the admin issues it.
      run(
        `UPDATE refunds SET status = ?, cf_refund_id = ?, updated_at = datetime('now')
          WHERE id = ? OR cf_refund_id = ?`,
        data.refund.refund_status || 'PENDING',
        String(data.refund.cf_refund_id ?? ''),
        String(data.refund.refund_id ?? ''),
        String(data.refund.cf_refund_id ?? ''),
      );
    } else if ((type === 'PAYMENT_FAILED_WEBHOOK' || type === 'PAYMENT_USER_DROPPED_WEBHOOK') && orderId) {
      if (data.payment) recordTransaction(orderId, data.payment);
      const reason = type === 'PAYMENT_USER_DROPPED_WEBHOOK' ? 'user_dropped' : 'payment_failed';
      run(
        `UPDATE payment_orders SET status=?, failure_reason=?, updated_at=datetime('now')
          WHERE id=? AND status NOT IN ('ACTIVATED','REFUNDED','PAID')`,
        type === 'PAYMENT_USER_DROPPED_WEBHOOK' ? 'CANCELLED' : 'FAILED',
        reason,
        orderId,
      );
      const order = get('SELECT user_id FROM payment_orders WHERE id = ?', orderId);
      if (order) notifications.queue(order.user_id, 'PAYMENT_FAILED', { orderId, reason });
    }

    run(`UPDATE webhook_events SET processed=1, processed_at=datetime('now') WHERE id = ?`, stored);
    return { duplicate: false, signatureOk: true, type, handled: true };
  } catch (err) {
    run(`UPDATE webhook_events SET process_error=? WHERE id = ?`, String(err.message).slice(0, 500), stored);
    throw err;
  }
}

// ───────────────────────── refunds (§38) ─────────────────────────

/**
 * Issues a refund through the gateway.
 *
 *   POST {base}/pg/orders/{order_id}/refunds
 *   body: { refund_amount, refund_id, refund_note, refund_speed }
 *   https://www.cashfree.com/docs/api-reference/payments/latest/refunds/create
 *
 * `refund_id` is our own id, so a retry of the same refund is recognised by
 * Cashfree rather than issuing a second one. Cashfree only accepts refunds
 * within six months of the original payment; that error is surfaced as-is
 * because it is the one case where the admin can do nothing but say no.
 */
async function createRefund({ orderId, amountMinor, note, refundId }) {
  const cfg = assertConfigured();
  const order = get('SELECT * FROM payment_orders WHERE id = ?', orderId);
  if (!order) throw notFound('No such order.');
  if (amountMinor > order.amount_minor) {
    throw badRequest('A refund cannot exceed the amount paid.');
  }

  const response = await callCashfree(`/pg/orders/${encodeURIComponent(orderId)}/refunds`, {
    method: 'POST',
    cfg,
    idempotencyKey: refundId,
    body: {
      refund_amount: Number((amountMinor / 100).toFixed(2)),
      refund_id: refundId,
      // Cashfree caps the note at 100 characters.
      refund_note: String(note || 'Refund').slice(0, 100),
      refund_speed: 'STANDARD',
    },
  });

  return {
    cfRefundId: response.cf_refund_id ?? null,
    // SUCCESS | PENDING | PENDING_APPROVAL | CANCELLED | ONHOLD | REJECTED
    status: response.refund_status ?? 'PENDING',
    processedAt: response.processed_at ?? null,
  };
}

// ───────────────────────── reconciliation (§41) ─────────────────────────

/** Surfaces states that should be impossible, for the admin to investigate. */
function reconcile() {
  const paidNotActivated = all(
    `SELECT o.*, u.email FROM payment_orders o JOIN users u ON u.id = o.user_id
      WHERE o.status = 'PAID' ORDER BY o.created_at DESC LIMIT 100`,
  );
  const activatedWithoutCredit = all(
    `SELECT o.*, u.email FROM payment_orders o JOIN users u ON u.id = o.user_id
      WHERE o.status = 'ACTIVATED' AND o.credits_to_grant > 0
        AND NOT EXISTS (
          SELECT 1 FROM credit_transactions c
           WHERE c.idempotency_key = 'order:' || o.id
        ) LIMIT 100`,
  );
  const activeSubNoPayment = all(
    `SELECT s.*, u.email, p.name AS plan_name
       FROM subscriptions s JOIN users u ON u.id = s.user_id JOIN plans p ON p.id = s.plan_id
      WHERE s.status='ACTIVE' AND p.price_minor > 0
        AND NOT EXISTS (
          SELECT 1 FROM payment_orders o
           WHERE o.user_id = s.user_id AND o.status='ACTIVATED' AND o.plan_id = s.plan_id
        ) LIMIT 100`,
  );
  const unsigned = all(
    `SELECT * FROM webhook_events WHERE signature_ok = 0 ORDER BY received_at DESC LIMIT 50`,
  );
  const unprocessed = all(
    `SELECT * FROM webhook_events WHERE processed = 0 AND signature_ok = 1
      ORDER BY received_at DESC LIMIT 50`,
  );

  return {
    paidNotActivated,
    activatedWithoutCredit,
    activeSubNoPayment,
    unsignedWebhooks: unsigned,
    unprocessedWebhooks: unprocessed,
    healthy:
      paidNotActivated.length === 0 &&
      activatedWithoutCredit.length === 0 &&
      activeSubNoPayment.length === 0 &&
      unsigned.length === 0,
  };
}

module.exports = {
  config,
  createOrder,
  createRefund,
  verifyAndSettle,
  activateOrder,
  handleWebhook,
  verifySignature,
  reconcile,
  API_VERSION,
};
