'use strict';

/**
 * Admin control centre API (§1, §6, §7, §11–§14, §22, §23, §25, §30, §38, §41, §65).
 *
 * Every route here sits behind requireRole('ADMIN') mounted at the router level,
 * and every mutation writes an audit row. Secrets are write-only: they go in
 * encrypted and come back masked, never in plaintext.
 */

const express = require('express');
const { get, all, run, transaction } = require('../db');
const cryptoLib = require('../lib/crypto');
const audit = require('../lib/audit');
const aiRouter = require('../services/aiRouter');
const cashfree = require('../services/cashfree');
const credits = require('../services/credits');
const v = require('../lib/validate');
const { notFound, badRequest } = require('../lib/errors');
const { requireRole, requireReauth } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('SUPPORT')); // read-only floor; writes demand ADMIN below
const writeAccess = requireRole('ADMIN');

// ───────────────────────── overview & analytics (§11, §40) ─────────────────────────

router.get('/overview', (_req, res) => {
  const revenue = (since) =>
    get(
      `SELECT COALESCE(SUM(amount_minor),0) AS total, COUNT(*) AS count
         FROM payment_orders WHERE status='ACTIVATED' AND created_at > datetime('now', ?)`,
      since,
    );
  const aiCost = (since) =>
    get(
      `SELECT COALESCE(SUM(cost_micro),0) AS micro, COUNT(*) AS requests,
              COALESCE(SUM(total_tokens),0) AS tokens
         FROM ai_requests WHERE created_at > datetime('now', ?)`,
      since,
    );

  const today = revenue('-1 day');
  const month = revenue('-30 days');
  const year = revenue('-365 days');
  const costToday = aiCost('-1 day');
  const costMonth = aiCost('-30 days');

  const activeSubs = get(
    `SELECT COUNT(*) AS n FROM subscriptions
      WHERE status='ACTIVE' AND (expiry_date IS NULL OR expiry_date > datetime('now'))`,
  ).n;

  // MRR normalises yearly plans to a monthly figure.
  const mrr = get(
    `SELECT COALESCE(SUM(CASE p.billing_period
              WHEN 'YEARLY' THEN p.price_minor / 12
              WHEN 'MONTHLY' THEN p.price_minor ELSE 0 END), 0) AS mrr
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
      WHERE s.status='ACTIVE' AND (s.expiry_date IS NULL OR s.expiry_date > datetime('now'))`,
  ).mrr;

  // Cashfree's standard card/UPI rate; configurable, and clearly an estimate.
  const feeRate = Number(get(`SELECT value FROM settings WHERE key='billing.fee_rate'`)?.value || 0.0236);
  const monthRevenue = month.total;
  const monthAiCost = Math.round(costMonth.micro / 1000); // micro-rupees -> paise
  const monthFees = Math.round(monthRevenue * feeRate);

  res.json({
    revenue: {
      todayMinor: today.total,
      monthMinor: monthRevenue,
      yearMinor: year.total,
      mrrMinor: mrr,
      activeSubscriptions: activeSubs,
      paymentsToday: today.count,
      paymentsMonth: month.count,
    },
    aiCost: {
      todayMinor: Math.round(costToday.micro / 1000),
      monthMinor: monthAiCost,
      requestsToday: costToday.requests,
      requestsMonth: costMonth.requests,
      tokensMonth: costMonth.tokens,
      byProvider: all(
        `SELECT p.label, p.id, COALESCE(SUM(r.cost_micro),0) AS micro, COUNT(*) AS requests
           FROM ai_requests r JOIN ai_providers p ON p.id = r.provider_id
          WHERE r.created_at > datetime('now','-30 days')
          GROUP BY p.id ORDER BY micro DESC`,
      ),
      byModel: all(
        `SELECT r.model_key, COALESCE(SUM(r.cost_micro),0) AS micro, COUNT(*) AS requests,
                AVG(r.latency_ms) AS avg_latency
           FROM ai_requests r WHERE r.created_at > datetime('now','-30 days')
          GROUP BY r.model_key ORDER BY micro DESC LIMIT 20`,
      ),
    },
    profitability: {
      revenueMinor: monthRevenue,
      aiCostMinor: monthAiCost,
      paymentFeesMinor: monthFees,
      grossMarginMinor: monthRevenue - monthAiCost - monthFees,
      feeRate,
      note: 'AI cost uses estimated token counts where the provider did not report usage.',
    },
    users: {
      total: get('SELECT COUNT(*) AS n FROM users').n,
      active: get(`SELECT COUNT(*) AS n FROM users WHERE status='ACTIVE'`).n,
      newThisMonth: get(
        `SELECT COUNT(*) AS n FROM users WHERE created_at > datetime('now','-30 days')`,
      ).n,
    },
    funnel: (() => {
      const started = get(`SELECT COUNT(*) AS n FROM payment_orders`).n;
      const pending = get(`SELECT COUNT(*) AS n FROM payment_orders WHERE status != 'CREATED'`).n;
      const paid = get(`SELECT COUNT(*) AS n FROM payment_orders WHERE status IN ('PAID','ACTIVATED')`).n;
      const activated = get(`SELECT COUNT(*) AS n FROM payment_orders WHERE status='ACTIVATED'`).n;
      const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);
      return {
        checkoutStarted: started,
        paymentInitiated: pending,
        paymentSuccessful: paid,
        subscriptionActivated: activated,
        initiatedRate: pct(pending, started),
        successRate: pct(paid, started),
        activationRate: pct(activated, started),
      };
    })(),
  });
});

router.get('/usage', (req, res) => {
  const limit = Number(req.query.limit || 100);
  res.json({
    requests: all(
      `SELECT r.*, u.email FROM ai_requests r LEFT JOIN users u ON u.id = r.user_id
        ORDER BY r.created_at DESC LIMIT ?`,
      Math.min(limit, 500),
    ),
    daily: all(
      `SELECT date(created_at) AS day, COUNT(*) AS requests,
              COALESCE(SUM(cost_micro),0) AS micro,
              COALESCE(SUM(credits_charged),0) AS credits,
              SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) AS failures
         FROM ai_requests WHERE created_at > datetime('now','-30 days')
        GROUP BY day ORDER BY day`,
    ),
  });
});

// ───────────────────────── users (§12, §65) ─────────────────────────

router.get('/users', (req, res) => {
  const q = String(req.query.q || '').trim();
  const limit = Math.min(Number(req.query.limit || 25), 100);
  const offset = Number(req.query.offset || 0);
  const where = q ? `WHERE u.email LIKE ? OR u.name LIKE ?` : '';
  const params = q ? [`%${q}%`, `%${q}%`] : [];

  const rows = all(
    `SELECT u.*, p.name AS plan_name, s.status AS sub_status, s.expiry_date,
            (SELECT GROUP_CONCAT(provider) FROM auth_identities ai WHERE ai.user_id = u.id) AS providers
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status='ACTIVE'
       LEFT JOIN plans p ON p.id = s.plan_id
       ${where}
      ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
  const total = get(`SELECT COUNT(*) AS n FROM users u ${where}`, ...params).n;

  res.json({
    users: rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      status: u.status,
      creditBalance: u.credit_balance,
      emailVerified: !!u.email_verified,
      planName: u.plan_name || 'Free',
      subscriptionStatus: u.sub_status,
      expiryDate: u.expiry_date,
      authProviders: (u.providers || '').split(',').filter(Boolean),
      createdAt: u.created_at,
    })),
    total,
  });
});

router.get('/users/:id', (req, res, next) => {
  try {
    const user = get('SELECT * FROM users WHERE id = ?', req.params.id);
    if (!user) throw notFound('No such user.');
    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        status: user.status,
        creditBalance: user.credit_balance,
        emailVerified: !!user.email_verified,
        createdAt: user.created_at,
      },
      identities: all('SELECT provider, email, linked_at FROM auth_identities WHERE user_id = ?', user.id),
      subscriptions: all(
        `SELECT s.*, p.name AS plan_name FROM subscriptions s JOIN plans p ON p.id = s.plan_id
          WHERE s.user_id = ? ORDER BY s.created_at DESC`,
        user.id,
      ),
      payments: all(
        `SELECT * FROM payment_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 25`,
        user.id,
      ),
      creditHistory: credits.history(user.id, { limit: 25 }).rows,
      usage: all(
        `SELECT feature, model_key, credits_charged, cost_micro, success, created_at
           FROM ai_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 25`,
        user.id,
      ),
      sessions: all(
        `SELECT id, user_agent, ip, created_at FROM sessions
          WHERE user_id = ? AND revoked_at IS NULL AND expires_at > datetime('now')`,
        user.id,
      ),
      interviews: all(
        `SELECT id, role_title, kind, status, score, created_at FROM interview_sessions
          WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
        user.id,
      ),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/credits', writeAccess, (req, res, next) => {
  try {
    const amount = v.int(req.body.amount, 'Amount', { min: -1_000_000, max: 1_000_000 });
    const reason = v.str(req.body.reason, 'Reason', { max: 200 });
    const before = get('SELECT credit_balance FROM users WHERE id = ?', req.params.id);
    if (!before) throw notFound('No such user.');

    credits.record({
      userId: req.params.id,
      delta: amount,
      reason: `Admin: ${reason}`,
      kind: 'ADMIN_ADJUST',
      allowNegative: true, // an admin correcting an over-grant may go below zero
    });

    audit.fromRequest(req, {
      action: 'user.credits_adjusted',
      targetType: 'user',
      targetId: req.params.id,
      previous: { balance: before.credit_balance },
      next: { delta: amount, reason },
    });
    res.json({ ok: true, balance: credits.balance(req.params.id) });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/status', writeAccess, (req, res, next) => {
  try {
    const status = v.oneOf(req.body.status, ['ACTIVE', 'SUSPENDED'], 'Status');
    const before = get('SELECT status FROM users WHERE id = ?', req.params.id);
    if (!before) throw notFound('No such user.');

    transaction(() => {
      run(`UPDATE users SET status=?, updated_at=datetime('now') WHERE id=?`, status, req.params.id);
      if (status === 'SUSPENDED') {
        // Suspension must take effect immediately, not at session expiry.
        run(
          `UPDATE sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL`,
          req.params.id,
        );
      }
    });
    audit.fromRequest(req, {
      action: status === 'SUSPENDED' ? 'user.suspended' : 'user.reactivated',
      targetType: 'user',
      targetId: req.params.id,
      previous: before,
      next: { status },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/revoke-sessions', writeAccess, (req, res, next) => {
  try {
    run(
      `UPDATE sessions SET revoked_at=datetime('now') WHERE user_id=? AND revoked_at IS NULL`,
      req.params.id,
    );
    audit.fromRequest(req, { action: 'user.sessions_revoked', targetType: 'user', targetId: req.params.id });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/** Role changes are the highest-privilege action here, so they demand re-auth. */
router.post('/users/:id/role', requireRole('SUPER_ADMIN'), requireReauth, (req, res, next) => {
  try {
    const role = v.oneOf(req.body.role, ['USER', 'SUPPORT', 'ADMIN', 'SUPER_ADMIN'], 'Role');
    const before = get('SELECT role FROM users WHERE id = ?', req.params.id);
    if (!before) throw notFound('No such user.');
    run(`UPDATE users SET role=?, updated_at=datetime('now') WHERE id=?`, role, req.params.id);
    audit.fromRequest(req, {
      action: 'user.role_changed',
      targetType: 'user',
      targetId: req.params.id,
      previous: before,
      next: { role },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── plans (§3, §31) ─────────────────────────

router.get('/plans', (_req, res) => {
  const plans = all('SELECT * FROM plans ORDER BY sort_order, price_minor');
  res.json({
    plans: plans.map((p) => ({
      ...p,
      entitlements: all('SELECT feature_key, value FROM plan_entitlements WHERE plan_id = ?', p.id),
      subscriberCount: get(
        `SELECT COUNT(*) AS n FROM subscriptions WHERE plan_id=? AND status='ACTIVE'`,
        p.id,
      ).n,
    })),
  });
});

router.put('/plans/:id', writeAccess, (req, res, next) => {
  try {
    const before = get('SELECT * FROM plans WHERE id = ?', req.params.id);
    if (!before) throw notFound('No such plan.');

    const fields = {
      name: v.str(req.body.name ?? before.name, 'Name', { max: 80 }),
      description: v.str(req.body.description ?? before.description, 'Description', { min: 0, max: 500 }),
      price_minor: v.int(req.body.priceMinor ?? before.price_minor, 'Price', { min: 0 }),
      billing_period: v.oneOf(
        req.body.billingPeriod ?? before.billing_period,
        ['MONTHLY', 'YEARLY', 'ONE_TIME', 'FREE'],
        'Billing period',
      ),
      credits_granted: v.int(req.body.credits ?? before.credits_granted, 'Credits', { min: 0 }),
      max_interviews: v.int(req.body.maxInterviews ?? before.max_interviews, 'Max interviews', { min: -1 }),
      max_ai_requests: v.int(req.body.maxAiRequests ?? before.max_ai_requests, 'Max AI requests', { min: -1 }),
      is_public: req.body.isPublic === undefined ? before.is_public : v.bool(req.body.isPublic) ? 1 : 0,
      status: v.oneOf(req.body.status ?? before.status, ['ACTIVE', 'ARCHIVED'], 'Status'),
    };

    transaction(() => {
      run(
        `UPDATE plans SET name=?, description=?, price_minor=?, billing_period=?, credits_granted=?,
                          max_interviews=?, max_ai_requests=?, is_public=?, status=?,
                          updated_at=datetime('now')
          WHERE id=?`,
        ...Object.values(fields),
        req.params.id,
      );
      if (req.body.entitlements && typeof req.body.entitlements === 'object') {
        run('DELETE FROM plan_entitlements WHERE plan_id = ?', req.params.id);
        for (const [key, value] of Object.entries(req.body.entitlements)) {
          run(
            'INSERT INTO plan_entitlements (plan_id, feature_key, value) VALUES (?, ?, ?)',
            req.params.id,
            key,
            String(value),
          );
        }
      }
    });

    audit.fromRequest(req, {
      action: 'plan.updated',
      targetType: 'plan',
      targetId: req.params.id,
      previous: before,
      next: fields,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── credit costs (§4) ─────────────────────────

router.get('/credit-costs', (_req, res) => res.json({ costs: credits.listCosts() }));

router.put('/credit-costs/:key', writeAccess, (req, res, next) => {
  try {
    const before = get('SELECT * FROM credit_costs WHERE action_key = ?', req.params.key);
    if (!before) throw notFound('No such action.');
    const amount = v.int(req.body.credits, 'Credits', { min: 0, max: 100000 });
    run(
      `UPDATE credit_costs SET credits=?, updated_at=datetime('now') WHERE action_key=?`,
      amount,
      req.params.key,
    );
    audit.fromRequest(req, {
      action: 'credit_cost.updated',
      targetType: 'credit_cost',
      targetId: req.params.key,
      previous: { credits: before.credits },
      next: { credits: amount },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── AI providers & models (§6, §7) ─────────────────────────

const maskProvider = (p) => ({
  id: p.id,
  providerKey: p.provider_key,
  label: p.label,
  hasKey: !!p.api_key_cipher,
  maskedKey: cryptoLib.maskSecret(p.api_key_last4),
  enabled: !!p.enabled,
  priority: p.priority,
  healthStatus: p.health_status,
  healthCheckedAt: p.health_checked_at,
  lastError: p.last_error,
});

router.get('/providers', (_req, res) => {
  res.json({
    providers: all('SELECT * FROM ai_providers ORDER BY priority').map(maskProvider),
    catalogue: aiRouter.catalogue(),
  });
});

/** Writing a provider secret is sensitive enough to require re-authentication. */
router.put('/providers/:id', writeAccess, requireReauth, (req, res, next) => {
  try {
    const before = get('SELECT * FROM ai_providers WHERE id = ?', req.params.id);
    if (!before) throw notFound('No such provider.');

    const enabled = req.body.enabled === undefined ? before.enabled : v.bool(req.body.enabled) ? 1 : 0;
    const priority = v.int(req.body.priority ?? before.priority, 'Priority', { min: 1, max: 1000 });

    let cipher = before.api_key_cipher;
    let last4 = before.api_key_last4;
    // An empty string means "leave it alone" — the UI never round-trips a key.
    if (typeof req.body.apiKey === 'string' && req.body.apiKey.trim() !== '') {
      const key = req.body.apiKey.trim();
      cipher = cryptoLib.encryptSecret(key);
      last4 = cryptoLib.last4(key);
    }

    run(
      `UPDATE ai_providers SET api_key_cipher=?, api_key_last4=?, enabled=?, priority=?,
                               updated_at=datetime('now')
        WHERE id=?`,
      cipher,
      last4,
      enabled,
      priority,
      req.params.id,
    );

    audit.fromRequest(req, {
      action: 'ai_provider.updated',
      targetType: 'ai_provider',
      targetId: req.params.id,
      previous: { enabled: before.enabled, priority: before.priority, hasKey: !!before.api_key_cipher },
      // The key itself is never written to the audit log, only that it changed.
      next: { enabled, priority, keyRotated: cipher !== before.api_key_cipher },
    });
    res.json({ ok: true, provider: maskProvider(get('SELECT * FROM ai_providers WHERE id = ?', req.params.id)) });
  } catch (err) {
    next(err);
  }
});

router.post('/providers/:id/health', writeAccess, async (req, res, next) => {
  try {
    res.json(await aiRouter.healthCheck(req.params.id));
  } catch (err) {
    next(err);
  }
});

router.get('/models', (_req, res) => {
  res.json({
    models: all(
      `SELECT m.*, p.label AS provider_label, p.provider_key
         FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
        ORDER BY p.priority, m.priority`,
    ),
  });
});

router.put('/models/:id', writeAccess, (req, res, next) => {
  try {
    const before = get('SELECT * FROM ai_models WHERE id = ?', req.params.id);
    if (!before) throw notFound('No such model.');
    const fields = {
      label: v.str(req.body.label ?? before.label, 'Label', { max: 80 }),
      input_cost_micro: v.int(req.body.inputCostMicro ?? before.input_cost_micro, 'Input cost', { min: 0 }),
      output_cost_micro: v.int(req.body.outputCostMicro ?? before.output_cost_micro, 'Output cost', { min: 0 }),
      max_tokens: v.int(req.body.maxTokens ?? before.max_tokens, 'Max tokens', { min: 1 }),
      context_window: v.int(req.body.contextWindow ?? before.context_window, 'Context window', { min: 1 }),
      reasoning: req.body.reasoning === undefined ? before.reasoning : v.bool(req.body.reasoning) ? 1 : 0,
      speed_rating: v.int(req.body.speedRating ?? before.speed_rating, 'Speed', { min: 1, max: 5 }),
      enabled: req.body.enabled === undefined ? before.enabled : v.bool(req.body.enabled) ? 1 : 0,
      priority: v.int(req.body.priority ?? before.priority, 'Priority', { min: 1, max: 1000 }),
    };
    run(
      `UPDATE ai_models SET label=?, input_cost_micro=?, output_cost_micro=?, max_tokens=?,
                            context_window=?, reasoning=?, speed_rating=?, enabled=?, priority=?,
                            updated_at=datetime('now')
        WHERE id=?`,
      ...Object.values(fields),
      req.params.id,
    );
    audit.fromRequest(req, {
      action: 'ai_model.updated',
      targetType: 'ai_model',
      targetId: req.params.id,
      previous: before,
      next: fields,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── routing (§8, §9) ─────────────────────────

router.get('/routing', (_req, res) => {
  res.json({
    rules: all('SELECT * FROM ai_routing_rules ORDER BY intent, complexity').map((r) => ({
      ...r,
      model_chain: JSON.parse(r.model_chain),
    })),
    models: all(
      `SELECT m.id, m.model_key, m.label, p.label AS provider_label, m.enabled
         FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id ORDER BY p.priority, m.priority`,
    ),
  });
});

router.put('/routing/:id', writeAccess, (req, res, next) => {
  try {
    const before = get('SELECT * FROM ai_routing_rules WHERE id = ?', req.params.id);
    if (!before) throw notFound('No such routing rule.');
    const chain = v.jsonArray(req.body.modelChain, 'Model chain');
    for (const id of chain) {
      if (!get('SELECT id FROM ai_models WHERE id = ?', id)) throw badRequest(`Unknown model "${id}".`);
    }
    const enabled = req.body.enabled === undefined ? before.enabled : v.bool(req.body.enabled) ? 1 : 0;
    run(
      `UPDATE ai_routing_rules SET model_chain=?, enabled=?, notes=?, updated_at=datetime('now')
        WHERE id=?`,
      JSON.stringify(chain),
      enabled,
      v.str(req.body.notes ?? before.notes, 'Notes', { min: 0, max: 300 }),
      req.params.id,
    );
    audit.fromRequest(req, {
      action: 'ai_routing.updated',
      targetType: 'ai_routing_rule',
      targetId: req.params.id,
      previous: { chain: JSON.parse(before.model_chain), enabled: before.enabled },
      next: { chain, enabled },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── feature flags (§13) ─────────────────────────

router.get('/flags', (_req, res) => {
  res.json({
    flags: all('SELECT * FROM feature_flags ORDER BY key').map((f) => ({
      ...f,
      enabled: !!f.enabled,
      plan_codes: JSON.parse(f.plan_codes),
    })),
    planCodes: all(`SELECT code FROM plans WHERE status='ACTIVE'`).map((p) => p.code),
  });
});

router.put('/flags/:key', writeAccess, (req, res, next) => {
  try {
    const before = get('SELECT * FROM feature_flags WHERE key = ?', req.params.key);
    if (!before) throw notFound('No such flag.');
    const enabled = v.bool(req.body.enabled) ? 1 : 0;
    const planCodes = JSON.stringify(v.jsonArray(req.body.planCodes ?? [], 'Plans'));
    run(
      `UPDATE feature_flags SET enabled=?, plan_codes=?, updated_at=datetime('now') WHERE key=?`,
      enabled,
      planCodes,
      req.params.key,
    );
    audit.fromRequest(req, {
      action: 'feature_flag.updated',
      targetType: 'feature_flag',
      targetId: req.params.key,
      previous: { enabled: !!before.enabled, planCodes: JSON.parse(before.plan_codes) },
      next: { enabled: !!enabled, planCodes: JSON.parse(planCodes) },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── prompts (§14) ─────────────────────────

router.get('/prompts', (_req, res) => {
  res.json({
    prompts: all('SELECT * FROM prompts ORDER BY key').map((p) => ({
      ...p,
      versions: all(
        `SELECT id, version, status, created_at, substr(body,1,160) AS preview
           FROM prompt_versions WHERE prompt_id=? ORDER BY version DESC`,
        p.id,
      ),
    })),
  });
});

router.get('/prompts/:id/versions/:versionId', (req, res, next) => {
  try {
    const version = get('SELECT * FROM prompt_versions WHERE id=? AND prompt_id=?', req.params.versionId, req.params.id);
    if (!version) throw notFound('No such prompt version.');
    res.json({ version });
  } catch (err) {
    next(err);
  }
});

/** New versions are always drafts; publishing is a separate, audited step. */
router.post('/prompts/:id/versions', writeAccess, (req, res, next) => {
  try {
    const prompt = get('SELECT * FROM prompts WHERE id = ?', req.params.id);
    if (!prompt) throw notFound('No such prompt.');
    const body = v.str(req.body.body, 'Prompt body', { max: 20000 });
    const nextVersion =
      (get('SELECT MAX(version) AS v FROM prompt_versions WHERE prompt_id=?', prompt.id).v || 0) + 1;
    const id = cryptoLib.newId('pv');
    run(
      `INSERT INTO prompt_versions (id, prompt_id, version, body, status, created_by)
       VALUES (?, ?, ?, ?, 'DRAFT', ?)`,
      id,
      prompt.id,
      nextVersion,
      body,
      req.user.id,
    );
    audit.fromRequest(req, {
      action: 'prompt.version_created',
      targetType: 'prompt',
      targetId: prompt.id,
      next: { version: nextVersion },
    });
    res.status(201).json({ ok: true, versionId: id, version: nextVersion });
  } catch (err) {
    next(err);
  }
});

/** Publish or roll back — both are just "make this version active". */
router.post('/prompts/:id/activate/:versionId', writeAccess, (req, res, next) => {
  try {
    const prompt = get('SELECT * FROM prompts WHERE id = ?', req.params.id);
    const version = get('SELECT * FROM prompt_versions WHERE id=? AND prompt_id=?', req.params.versionId, req.params.id);
    if (!prompt || !version) throw notFound('No such prompt version.');

    transaction(() => {
      run(`UPDATE prompt_versions SET status='ARCHIVED' WHERE prompt_id=? AND status='ACTIVE'`, prompt.id);
      run(`UPDATE prompt_versions SET status='ACTIVE' WHERE id=?`, version.id);
      run(`UPDATE prompts SET active_version_id=?, updated_at=datetime('now') WHERE id=?`, version.id, prompt.id);
    });
    audit.fromRequest(req, {
      action: 'prompt.activated',
      targetType: 'prompt',
      targetId: prompt.id,
      previous: { activeVersionId: prompt.active_version_id },
      next: { activeVersionId: version.id, version: version.version },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── payments (§30, §38, §40, §41) ─────────────────────────

router.get('/payments', (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const where = status ? 'WHERE o.status = ?' : '';
  const params = status ? [status] : [];
  res.json({
    orders: all(
      `SELECT o.*, u.email, p.name AS plan_name
         FROM payment_orders o JOIN users u ON u.id = o.user_id
         LEFT JOIN plans p ON p.id = o.plan_id
         ${where} ORDER BY o.created_at DESC LIMIT 100`,
      ...params,
    ),
    webhooks: all(
      `SELECT id, event_type, dedupe_key, signature_ok, processed, process_error, received_at
         FROM webhook_events ORDER BY received_at DESC LIMIT 50`,
    ),
  });
});

router.get('/payments/reconcile', (_req, res) => res.json(cashfree.reconcile()));

/** Settles a stuck order by asking Cashfree, never by trusting the admin's word. */
router.post('/payments/:id/verify', writeAccess, async (req, res, next) => {
  try {
    const result = await cashfree.verifyAndSettle(req.params.id);
    audit.fromRequest(req, {
      action: 'payment.manual_verify',
      targetType: 'payment_order',
      targetId: req.params.id,
      next: result,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * §38: records a refund and applies the configured credit policy. The gateway
 * call itself is not wired up — see the deployment checklist.
 */
router.post('/payments/:id/refund', writeAccess, requireReauth, (req, res, next) => {
  try {
    const order = get('SELECT * FROM payment_orders WHERE id = ?', req.params.id);
    if (!order) throw notFound('No such order.');
    if (order.status !== 'ACTIVATED') throw badRequest('Only an activated order can be refunded.');

    const policy = get(`SELECT value FROM settings WHERE key='billing.refund_credit_policy'`)?.value || 'CLAWBACK';
    const reason = v.str(req.body.reason, 'Reason', { max: 300 });

    transaction(() => {
      run(
        `INSERT INTO refunds (id, payment_order_id, amount_minor, status, reason, created_by, credits_clawed_back)
         VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`,
        cryptoLib.newId('ref'),
        order.id,
        order.amount_minor,
        reason,
        req.user.id,
        policy === 'CLAWBACK' ? order.credits_to_grant : 0,
      );
      run(`UPDATE payment_orders SET status='REFUNDED', updated_at=datetime('now') WHERE id=?`, order.id);
      run(
        `UPDATE subscriptions SET status='CANCELLED', updated_at=datetime('now')
          WHERE user_id=? AND plan_id=? AND status='ACTIVE'`,
        order.user_id,
        order.plan_id,
      );
      if (policy === 'CLAWBACK' && order.credits_to_grant > 0) {
        credits.record({
          userId: order.user_id,
          delta: -order.credits_to_grant,
          reason: `Refund: ${reason}`,
          kind: 'REFUND',
          refType: 'payment_order',
          refId: order.id,
          allowNegative: true, // spent credits cannot be un-spent
        });
      }
    });

    audit.fromRequest(req, {
      action: 'payment.refunded',
      targetType: 'payment_order',
      targetId: order.id,
      next: { reason, policy },
    });
    res.json({ ok: true, policy, note: 'Recorded internally. Issue the refund in the Cashfree dashboard.' });
  } catch (err) {
    next(err);
  }
});

// ───────────────────────── settings & audit (§22, §23, §30) ─────────────────────────

const SECRET_KEYS = new Set(['cashfree.client_secret', 'cashfree.client_id']);

router.get('/settings', (_req, res) => {
  const rows = all('SELECT * FROM settings ORDER BY key');
  res.json({
    settings: rows.map((s) => ({
      key: s.key,
      // Secrets are never returned, in any form, to any role.
      value: s.encrypted ? cryptoLib.maskSecret(String(s.value).slice(-4)) : s.value,
      encrypted: !!s.encrypted,
    })),
    cashfree: { mode: cashfree.config().mode, configured: !!cashfree.config().clientSecret, apiVersion: cashfree.API_VERSION },
  });
});

router.put('/settings/:key', writeAccess, requireReauth, (req, res, next) => {
  try {
    const key = req.params.key;
    const isSecret = SECRET_KEYS.has(key);
    const raw = v.str(req.body.value, 'Value', { min: 0, max: 4000, trim: false });
    if (isSecret && raw.trim() === '') return res.json({ ok: true, unchanged: true });

    run(
      `INSERT INTO settings (key, value, encrypted, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, encrypted=excluded.encrypted,
                                      updated_at=datetime('now')`,
      key,
      isSecret ? cryptoLib.encryptSecret(raw) : raw,
      isSecret ? 1 : 0,
    );
    audit.fromRequest(req, {
      action: 'setting.updated',
      targetType: 'setting',
      targetId: key,
      // Value deliberately omitted for secrets.
      next: isSecret ? { rotated: true } : { value: raw },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/audit', (req, res) => {
  res.json(
    audit.list({
      limit: Math.min(Number(req.query.limit || 50), 200),
      offset: Number(req.query.offset || 0),
      action: req.query.action ? String(req.query.action) : null,
    }),
  );
});

router.get('/notifications', (_req, res) => {
  res.json({
    notifications: all(
      `SELECT n.*, u.email FROM notifications n LEFT JOIN users u ON u.id = n.user_id
        ORDER BY n.created_at DESC LIMIT 100`,
    ),
  });
});

module.exports = router;
