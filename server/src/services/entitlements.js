'use strict';

/**
 * Access resolution (§17, §62).
 *
 *   User -> Subscription -> Plan -> Entitlements -> Feature access
 *
 * Never `isPaid === true`. A caller asks "may this user do X", and the answer is
 * computed from the live subscription, the plan's entitlement rows and any
 * global feature flag. Expiry is evaluated in SQL against the current time, so
 * an expired subscription stops granting access without needing a cron job.
 */

const { get, all } = require('../db');
const { forbidden } = require('../lib/errors');

const FREE_PLAN_CODE = 'free';

/** The plan actually in force: an ACTIVE, unexpired subscription, else Free. */
function activePlan(userId) {
  const sub = get(
    `SELECT p.*, s.id AS subscription_id, s.status AS subscription_status,
            s.expiry_date AS expiry_date, s.next_billing_date AS next_billing_date,
            s.cancel_at_period_end AS cancel_at_period_end
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.user_id = ?
        AND s.status = 'ACTIVE'
        AND (s.expiry_date IS NULL OR s.expiry_date > datetime('now'))
      ORDER BY p.price_minor DESC
      LIMIT 1`,
    userId,
  );
  if (sub) return sub;

  return get(
    `SELECT *, NULL AS subscription_id, NULL AS subscription_status,
            NULL AS expiry_date, NULL AS next_billing_date, 0 AS cancel_at_period_end
       FROM plans WHERE code = ?`,
    FREE_PLAN_CODE,
  );
}

function entitlementMap(planId) {
  const rows = all('SELECT feature_key, value FROM plan_entitlements WHERE plan_id = ?', planId);
  const map = {};
  for (const r of rows) {
    // Values are stored as text; coerce the obvious shapes back.
    if (r.value === 'true' || r.value === 'false') {
      map[r.feature_key] = r.value === 'true';
    } else if (/^-?\d+$/.test(r.value)) {
      map[r.feature_key] = Number(r.value);
    } else if (r.value.startsWith('[')) {
      try {
        map[r.feature_key] = JSON.parse(r.value);
      } catch {
        map[r.feature_key] = r.value;
      }
    } else {
      map[r.feature_key] = r.value;
    }
  }
  return map;
}

/** Global kill switch, independent of plan. A disabled flag beats any plan. */
function flagAllows(featureKey, planCode) {
  const flag = get('SELECT * FROM feature_flags WHERE key = ?', featureKey);
  if (!flag) return true; // unflagged features are governed by the plan alone
  if (!flag.enabled) return false;
  let codes = [];
  try {
    codes = JSON.parse(flag.plan_codes);
  } catch {
    codes = [];
  }
  return codes.length === 0 || codes.includes(planCode);
}

/** Everything the UI needs to render correctly — and the server needs to decide. */
function resolve(userId) {
  const plan = activePlan(userId);
  const features = entitlementMap(plan.id);
  const user = get('SELECT credit_balance, email_verified FROM users WHERE id = ?', userId);

  const allowed = {};
  for (const key of Object.keys(features)) {
    allowed[key] = features[key] === true ? flagAllows(key, plan.code) : features[key];
  }

  return {
    plan: {
      id: plan.id,
      code: plan.code,
      name: plan.name,
      priceMinor: plan.price_minor,
      currency: plan.currency,
      billingPeriod: plan.billing_period,
      subscriptionId: plan.subscription_id,
      subscriptionStatus: plan.subscription_status,
      expiryDate: plan.expiry_date ?? null,
      nextBillingDate: plan.next_billing_date ?? null,
      cancelAtPeriodEnd: !!plan.cancel_at_period_end,
    },
    features: allowed,
    creditBalance: user?.credit_balance ?? 0,
    emailVerified: !!user?.email_verified,
  };
}

/** Throws unless the feature is on for this user's plan. */
function assertFeature(userId, featureKey) {
  const { features, plan } = resolve(userId);
  if (features[featureKey] !== true) {
    throw forbidden(`Your ${plan.name} plan does not include this feature. Upgrade to unlock it.`);
  }
  return true;
}

/** Numeric caps: max_interviews, max_ai_requests. -1 means unlimited. */
function assertWithinLimit(userId, limitKey, currentCount) {
  const plan = activePlan(userId);
  const cap = plan[limitKey];
  if (cap === -1 || cap === null || cap === undefined) return true;
  if (currentCount >= cap) {
    throw forbidden(`You have reached your plan's limit of ${cap}. Upgrade for more.`);
  }
  return true;
}

module.exports = {
  activePlan,
  entitlementMap,
  resolve,
  assertFeature,
  assertWithinLimit,
  flagAllows,
  FREE_PLAN_CODE,
};
