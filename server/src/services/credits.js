'use strict';

/**
 * The credit ledger (§4, §37).
 *
 * One rule, enforced here and nowhere else: a balance is never written without
 * an immutable credit_transactions row written in the same transaction. There
 * is no exported function that sets a balance directly.
 */

const { get, all, run, transaction } = require('../db');
const { newId } = require('../lib/crypto');
const { paymentRequired, badRequest } = require('../lib/errors');

function balance(userId) {
  const row = get('SELECT credit_balance FROM users WHERE id = ?', userId);
  return row ? row.credit_balance : 0;
}

/** What an action costs right now. Admin-configurable; never hardcoded client-side. */
function costOf(actionKey) {
  const row = get('SELECT credits FROM credit_costs WHERE action_key = ?', actionKey);
  if (!row) throw badRequest(`Unknown action "${actionKey}".`);
  return row.credits;
}

function listCosts() {
  return all('SELECT * FROM credit_costs ORDER BY action_key');
}

/**
 * Moves the balance and records why.
 *
 * `idempotencyKey` is what makes a redelivered payment webhook safe: the unique
 * index on (user_id, idempotency_key) turns a second identical grant into a
 * no-op that returns the original transaction rather than adding credits twice.
 */
function record({
  userId,
  delta,
  reason,
  kind,
  refType = null,
  refId = null,
  idempotencyKey = null,
  allowNegative = false,
}) {
  return transaction(() => {
    if (idempotencyKey) {
      const existing = get(
        'SELECT * FROM credit_transactions WHERE user_id = ? AND idempotency_key = ?',
        userId,
        idempotencyKey,
      );
      if (existing) return { transaction: existing, duplicate: true };
    }

    const current = get('SELECT credit_balance FROM users WHERE id = ?', userId);
    if (!current) throw badRequest('No such user.');

    const next = current.credit_balance + delta;
    if (next < 0 && !allowNegative) {
      throw paymentRequired('Not enough credits for that action.', {
        required: Math.abs(delta),
        balance: current.credit_balance,
      });
    }

    const id = newId('ctx');
    run(
      `INSERT INTO credit_transactions
         (id, user_id, delta, balance_after, reason, kind, ref_type, ref_id, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      delta,
      next,
      reason,
      kind,
      refType,
      refId,
      idempotencyKey,
    );
    run(
      `UPDATE users SET credit_balance = ?, updated_at = datetime('now') WHERE id = ?`,
      next,
      userId,
    );

    return {
      transaction: get('SELECT * FROM credit_transactions WHERE id = ?', id),
      duplicate: false,
    };
  });
}

const grant = (userId, amount, reason, opts = {}) =>
  record({ userId, delta: Math.abs(amount), reason, kind: opts.kind || 'GRANT', ...opts });

const consume = (userId, amount, reason, opts = {}) =>
  record({ userId, delta: -Math.abs(amount), reason, kind: 'CONSUME', ...opts });

/**
 * Checks affordability without spending. Used to fail an AI request before the
 * provider call rather than after, so a user is never charged for a refusal.
 */
function assertCanAfford(userId, amount) {
  const current = balance(userId);
  if (current < amount) {
    throw paymentRequired('You do not have enough credits for this action.', {
      required: amount,
      balance: current,
      shortfall: amount - current,
    });
  }
  return current;
}

function history(userId, { limit = 50, offset = 0 } = {}) {
  const rows = all(
    `SELECT * FROM credit_transactions WHERE user_id = ?
      ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    userId,
    limit,
    offset,
  );
  const total = get('SELECT COUNT(*) AS n FROM credit_transactions WHERE user_id = ?', userId).n;
  return { rows, total };
}

module.exports = {
  balance,
  costOf,
  listCosts,
  record,
  grant,
  consume,
  assertCanAfford,
  history,
};
