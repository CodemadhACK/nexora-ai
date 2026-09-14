'use strict';

/** Plans, checkout, billing history (§21, §32, §39, §42, §43). */

const express = require('express');
const { get, all } = require('../db');
const cashfree = require('../services/cashfree');
const credits = require('../services/credits');
const entitlements = require('../services/entitlements');
const { requireAuth } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const v = require('../lib/validate');
const { notFound } = require('../lib/errors');

const router = express.Router();

const publicPlan = (p) => ({
  id: p.id,
  code: p.code,
  name: p.name,
  description: p.description,
  priceMinor: p.price_minor,
  currency: p.currency,
  billingPeriod: p.billing_period,
  credits: p.credits_granted,
  maxInterviews: p.max_interviews,
  maxAiRequests: p.max_ai_requests,
  features: entitlements.entitlementMap(p.id),
});

/** Public: the pricing page reads this. Prices come from the database only. */
router.get('/plans', (_req, res) => {
  const plans = all(
    `SELECT * FROM plans WHERE status='ACTIVE' AND is_public=1 ORDER BY sort_order, price_minor`,
  );
  res.json({ plans: plans.map(publicPlan) });
});

router.get('/me', requireAuth, (req, res) => {
  const resolved = entitlements.resolve(req.user.id);
  const orders = all(
    `SELECT o.*, p.name AS plan_name, i.number AS invoice_number
       FROM payment_orders o
       LEFT JOIN plans p ON p.id = o.plan_id
       LEFT JOIN invoices i ON i.payment_order_id = o.id
      WHERE o.user_id = ? ORDER BY o.created_at DESC LIMIT 50`,
    req.user.id,
  );
  const ledger = credits.history(req.user.id, { limit: 25 });

  res.json({
    plan: resolved.plan,
    features: resolved.features,
    creditBalance: resolved.creditBalance,
    payments: orders.map((o) => ({
      id: o.id,
      planName: o.plan_name,
      amountMinor: o.amount_minor,
      currency: o.currency,
      status: o.status,
      invoiceNumber: o.invoice_number,
      createdAt: o.created_at,
    })),
    creditHistory: ledger.rows.map((t) => ({
      id: t.id,
      delta: t.delta,
      balanceAfter: t.balance_after,
      reason: t.reason,
      kind: t.kind,
      createdAt: t.created_at,
    })),
  });
});

/**
 * Starts checkout. The body carries a plan id and nothing else — price and
 * credit quantity are decided server-side (§32).
 */
router.post(
  '/checkout',
  requireAuth,
  rateLimit({ windowMs: 60_000, max: 10 }),
  async (req, res, next) => {
    try {
      const planId = v.str(req.body.planId, 'Plan');
      const returnUrl = `${process.env.PUBLIC_APP_URL || 'http://localhost:5173'}/billing/return`;
      const result = await cashfree.createOrder({ user: req.user, planId, returnUrl });
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Called when the browser comes back from checkout, and safe to poll. The
 * redirect itself proves nothing — this asks Cashfree directly (§32, §43).
 */
router.get('/orders/:id/status', requireAuth, async (req, res, next) => {
  try {
    const order = get(
      'SELECT * FROM payment_orders WHERE id = ? AND user_id = ?',
      req.params.id,
      req.user.id,
    );
    if (!order) throw notFound('No such order.');

    const result = await cashfree.verifyAndSettle(order.id);
    const fresh = get('SELECT * FROM payment_orders WHERE id = ?', order.id);
    const plan = get('SELECT name FROM plans WHERE id = ?', fresh.plan_id);

    res.json({
      orderId: fresh.id,
      status: fresh.status,
      settled: result.settled,
      planName: plan?.name ?? '',
      creditsGranted: fresh.status === 'ACTIVATED' ? fresh.credits_to_grant : 0,
      amountMinor: fresh.amount_minor,
      currency: fresh.currency,
      failureReason: fresh.failure_reason,
      entitlements: entitlements.resolve(req.user.id),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * §42: retrying must not spawn duplicate orders. An existing unpaid order for
 * the same plan is handed back instead of a new one being created.
 */
router.get('/orders/pending', requireAuth, (req, res) => {
  const order = get(
    `SELECT * FROM payment_orders
      WHERE user_id = ? AND status IN ('CREATED','PENDING')
      ORDER BY created_at DESC LIMIT 1`,
    req.user.id,
  );
  res.json({ order: order ? { id: order.id, planId: order.plan_id, status: order.status } : null });
});

router.post('/cancel', requireAuth, (req, res, next) => {
  try {
    const { run } = require('../db');
    const active = get(
      `SELECT * FROM subscriptions WHERE user_id = ? AND status='ACTIVE' LIMIT 1`,
      req.user.id,
    );
    if (!active) throw notFound('You do not have an active subscription.');
    // Access continues to the end of the paid period — cancelling is not a refund.
    run(
      `UPDATE subscriptions SET cancel_at_period_end=1, updated_at=datetime('now') WHERE id=?`,
      active.id,
    );
    require('../lib/audit').fromRequest(req, {
      action: 'subscription.cancel_requested',
      targetType: 'subscription',
      targetId: active.id,
    });
    res.json({ ok: true, accessUntil: active.expiry_date });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
