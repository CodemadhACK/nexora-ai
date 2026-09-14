'use strict';

/**
 * The AI router (§5–§10, §20 cost control).
 *
 * This is the only place in the platform that holds a provider API key in
 * memory, and the only place that calls a model vendor. The architecture the
 * spec demands —
 *
 *     user -> frontend -> our backend -> router -> provider -> model
 *
 * — is enforced structurally: the browser has no provider credentials to use
 * even if it wanted to, because they never leave this process.
 *
 * It reuses `providers/` from the Electron app rather than reimplementing three
 * vendor clients. That module already speaks a neutral message shape, handles
 * retries and normalises errors, and it is covered by the repo's test suite.
 */

const path = require('node:path');
const registry = require(path.resolve(__dirname, '../../../providers'));
const { get, all, run } = require('../db');
const { newId, decryptSecret } = require('../lib/crypto');
const { ApiError, badRequest } = require('../lib/errors');
const credits = require('./credits');

// ───────────────────────── complexity classification (§8) ─────────────────────────

const COMPLEX_HINTS = [
  'design', 'architecture', 'scale', 'distributed', 'trade-off', 'tradeoff',
  'optimise', 'optimize', 'complexity', 'concurren', 'consistency', 'throughput',
  'bottleneck', 'sharding', 'why does', 'prove',
];

/**
 * Cheap, deterministic triage so a one-line question does not pay for a
 * reasoning model. Length and keyword hints only — deliberately not an AI call,
 * because classifying with a model would cost more than it saves.
 */
function classify(text = '') {
  const t = String(text).toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  const hits = COMPLEX_HINTS.filter((h) => t.includes(h)).length;
  if (hits >= 2 || words > 120) return 'COMPLEX';
  if (hits >= 1 || words > 35) return 'MEDIUM';
  return 'SIMPLE';
}

// ───────────────────────── routing (§7, §8, §9) ─────────────────────────

/**
 * Resolves an intent to an ordered list of candidate models — the fallback
 * chain. Falls back from the specific rule (intent + complexity) to the
 * catch-all (intent + ANY), then to any enabled model by priority, so a missing
 * rule degrades instead of failing.
 */
function resolveChain(intent, complexity) {
  const rule =
    get(
      `SELECT * FROM ai_routing_rules WHERE intent = ? AND complexity = ? AND enabled = 1`,
      intent,
      complexity,
    ) ||
    get(`SELECT * FROM ai_routing_rules WHERE intent = ? AND complexity = 'ANY' AND enabled = 1`, intent);

  let ids = [];
  if (rule) {
    try {
      ids = JSON.parse(rule.model_chain);
    } catch {
      ids = [];
    }
  }

  const models = [];
  for (const id of ids) {
    const m = get(
      `SELECT m.*, p.provider_key, p.api_key_cipher, p.enabled AS provider_enabled,
              p.priority AS provider_priority, p.id AS provider_row_id, p.label AS provider_label
         FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
        WHERE m.id = ? AND m.enabled = 1 AND p.enabled = 1`,
      id,
    );
    if (m) models.push(m);
  }

  if (models.length === 0) {
    // No usable rule: every enabled model, cheapest and fastest first.
    return all(
      `SELECT m.*, p.provider_key, p.api_key_cipher, p.enabled AS provider_enabled,
              p.priority AS provider_priority, p.id AS provider_row_id, p.label AS provider_label
         FROM ai_models m JOIN ai_providers p ON p.id = m.provider_id
        WHERE m.enabled = 1 AND p.enabled = 1
        ORDER BY p.priority ASC, m.priority ASC`,
    );
  }
  return models;
}

// ───────────────────────── usage accounting (§10) ─────────────────────────

/**
 * Token estimate for providers that do not return usage. ~4 characters per
 * token is the usual English approximation; rows recorded this way are flagged
 * `tokens_estimated = 1` so cost dashboards never present a guess as measured.
 */
const estimateTokens = (text) => Math.max(1, Math.ceil(String(text || '').length / 4));

function recordRequest(entry) {
  const id = entry.id || newId('air');
  run(
    `INSERT INTO ai_requests
       (id, user_id, feature, intent, complexity, provider_id, model_id, provider_key, model_key,
        input_tokens, output_tokens, total_tokens, tokens_estimated, credits_charged, cost_micro,
        latency_ms, success, error_code, error_message, attempt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    entry.userId ?? null,
    entry.feature,
    entry.intent ?? '',
    entry.complexity ?? '',
    entry.providerId ?? null,
    entry.modelId ?? null,
    entry.providerKey ?? '',
    entry.modelKey ?? '',
    entry.inputTokens ?? 0,
    entry.outputTokens ?? 0,
    (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0),
    entry.tokensEstimated ? 1 : 0,
    entry.creditsCharged ?? 0,
    entry.costMicro ?? 0,
    entry.latencyMs ?? 0,
    entry.success ? 1 : 0,
    entry.errorCode ?? null,
    entry.errorMessage ? String(entry.errorMessage).slice(0, 500) : null,
    entry.attempt ?? 1,
  );
  return id;
}

/** Cost in micro-rupees. Rates are per 1M tokens, so divide once at the end. */
function costMicro(model, inputTokens, outputTokens) {
  return Math.round(
    (inputTokens * model.input_cost_micro + outputTokens * model.output_cost_micro) / 1_000_000,
  );
}

function markProviderHealth(providerId, healthy, errorMessage) {
  run(
    `UPDATE ai_providers
        SET health_status = ?, health_checked_at = datetime('now'), last_error = ?
      WHERE id = ?`,
    healthy ? 'HEALTHY' : 'DOWN',
    healthy ? null : String(errorMessage || '').slice(0, 500),
    providerId,
  );
}

// ───────────────────────── the call (§5, §9) ─────────────────────────

/**
 * Runs one AI request end to end:
 *
 *   1. price the action and confirm the user can afford it (before any spend)
 *   2. classify and resolve the fallback chain
 *   3. try each candidate in order, recording every attempt, success or not
 *   4. charge credits once, only on success
 *
 * Provider failures are logged in full and reported to the caller as a single
 * neutral message: which vendor was down is operational detail, not something a
 * user needs (§9).
 */
async function complete({ userId, feature, intent, system, messages, actionKey, maxTokens, signal }) {
  const price = credits.costOf(actionKey);
  if (userId) credits.assertCanAfford(userId, price);

  const probe = messages?.map((m) => (m.parts || []).map((p) => p.text || '').join(' ')).join(' ') || '';
  const complexity = classify(probe);
  const chain = resolveChain(intent, complexity);

  if (chain.length === 0) {
    throw new ApiError(503, 'NO_MODEL', 'The assistant is unavailable right now. Please try again shortly.');
  }

  const failures = [];

  for (let i = 0; i < chain.length; i += 1) {
    const model = chain[i];
    const apiKey = model.api_key_cipher ? decryptSecret(model.api_key_cipher) : null;

    if (!apiKey) {
      failures.push({ model: model.model_key, reason: 'no_api_key' });
      recordRequest({
        userId, feature, intent, complexity,
        providerId: model.provider_row_id, modelId: model.id,
        providerKey: model.provider_key, modelKey: model.model_key,
        success: false, errorCode: 'NO_API_KEY',
        errorMessage: 'Provider has no API key configured', attempt: i + 1,
      });
      continue;
    }

    const provider = registry.getProvider(model.provider_key);
    const startedAt = Date.now();

    try {
      const text = await provider.complete({
        apiKey,
        model: model.model_key,
        system,
        messages,
        temperature: provider.supports?.temperature ? 0.7 : undefined,
        maxTokens: maxTokens || model.max_tokens,
        signal,
      });

      const latencyMs = Date.now() - startedAt;
      // The shared `complete()` returns text only, so usage is estimated and
      // flagged as such rather than reported as measured.
      const inputTokens = estimateTokens(`${system || ''} ${probe}`);
      const outputTokens = estimateTokens(text);

      const requestId = recordRequest({
        userId, feature, intent, complexity,
        providerId: model.provider_row_id, modelId: model.id,
        providerKey: model.provider_key, modelKey: model.model_key,
        inputTokens, outputTokens, tokensEstimated: true,
        creditsCharged: price,
        costMicro: costMicro(model, inputTokens, outputTokens),
        latencyMs, success: true, attempt: i + 1,
      });

      markProviderHealth(model.provider_row_id, true);

      if (userId) {
        credits.consume(userId, price, `${feature} (${model.model_key})`, {
          refType: 'ai_request',
          refId: requestId,
        });
      }

      return {
        text,
        requestId,
        model: model.model_key,
        provider: model.provider_key,
        complexity,
        creditsCharged: price,
        attempts: i + 1,
      };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      failures.push({ model: model.model_key, reason: err.code || err.message });
      recordRequest({
        userId, feature, intent, complexity,
        providerId: model.provider_row_id, modelId: model.id,
        providerKey: model.provider_key, modelKey: model.model_key,
        latencyMs, success: false,
        errorCode: err.code || 'PROVIDER_ERROR',
        errorMessage: err.message, attempt: i + 1,
      });
      markProviderHealth(model.provider_row_id, false, err.message);
      // Fall through to the next candidate in the chain.
    }
  }

  console.error('[ai] every provider in the chain failed', { intent, complexity, failures });
  throw new ApiError(
    503,
    'AI_UNAVAILABLE',
    'The assistant could not answer just now. Your credits were not charged — please try again.',
  );
}

// ───────────────────────── streaming (§19) ─────────────────────────

/**
 * The same routing, fallback, accounting and billing as `complete()`, but the
 * answer is pushed out token by token through `onDelta`.
 *
 * Two things make this more than a loop over `complete()`:
 *
 *   - Fallback only applies *before the first token*. Once bytes have reached
 *     the client, silently restarting on another model would splice two
 *     different answers together, so a mid-stream failure is reported as a
 *     failure rather than retried.
 *   - Credits are charged on completion, never on start, so an answer that dies
 *     halfway is free.
 */
async function completeStream({
  userId, feature, intent, system, messages, actionKey, maxTokens, signal, onDelta, onStatus,
}) {
  const price = credits.costOf(actionKey);
  if (userId) credits.assertCanAfford(userId, price);

  const probe = messages?.map((m) => (m.parts || []).map((p) => p.text || '').join(' ')).join(' ') || '';
  const complexity = classify(probe);
  const chain = resolveChain(intent, complexity);

  if (chain.length === 0) {
    throw new ApiError(503, 'NO_MODEL', 'The assistant is unavailable right now. Please try again shortly.');
  }

  for (let i = 0; i < chain.length; i += 1) {
    const model = chain[i];
    const apiKey = model.api_key_cipher ? decryptSecret(model.api_key_cipher) : null;

    if (!apiKey) {
      recordRequest({
        userId, feature, intent, complexity,
        providerId: model.provider_row_id, modelId: model.id,
        providerKey: model.provider_key, modelKey: model.model_key,
        success: false, errorCode: 'NO_API_KEY',
        errorMessage: 'Provider has no API key configured', attempt: i + 1,
      });
      continue;
    }

    const provider = registry.getProvider(model.provider_key);
    const startedAt = Date.now();
    let emitted = 0;

    try {
      const { text, aborted } = await provider.stream({
        apiKey,
        model: model.model_key,
        system,
        messages,
        temperature: provider.supports?.temperature ? 0.7 : undefined,
        maxTokens: maxTokens || model.max_tokens,
        signal,
        onStatus,
        onDelta: (delta) => {
          emitted += delta.length;
          onDelta(delta);
        },
      });

      const latencyMs = Date.now() - startedAt;
      const inputTokens = estimateTokens(`${system || ''} ${probe}`);
      const outputTokens = estimateTokens(text);

      // An aborted stream is the user's own doing (they navigated away). It is
      // recorded, but they are not billed for a partial answer.
      const requestId = recordRequest({
        userId, feature, intent, complexity,
        providerId: model.provider_row_id, modelId: model.id,
        providerKey: model.provider_key, modelKey: model.model_key,
        inputTokens, outputTokens, tokensEstimated: true,
        creditsCharged: aborted ? 0 : price,
        costMicro: costMicro(model, inputTokens, outputTokens),
        latencyMs, success: !aborted, attempt: i + 1,
        errorCode: aborted ? 'ABORTED' : null,
      });

      markProviderHealth(model.provider_row_id, true);

      if (userId && !aborted) {
        credits.consume(userId, price, `${feature} (${model.model_key})`, {
          refType: 'ai_request',
          refId: requestId,
        });
      }

      return {
        text, requestId, aborted,
        model: model.model_key, provider: model.provider_key,
        complexity, creditsCharged: aborted ? 0 : price, attempts: i + 1,
      };
    } catch (err) {
      recordRequest({
        userId, feature, intent, complexity,
        providerId: model.provider_row_id, modelId: model.id,
        providerKey: model.provider_key, modelKey: model.model_key,
        latencyMs: Date.now() - startedAt, success: false,
        errorCode: err.code || 'PROVIDER_ERROR', errorMessage: err.message, attempt: i + 1,
      });
      markProviderHealth(model.provider_row_id, false, err.message);

      // Past the point of no return: the client already has part of an answer.
      if (emitted > 0) {
        throw new ApiError(
          502,
          'STREAM_INTERRUPTED',
          'The answer was cut off. Your credits were not charged — please ask again.',
        );
      }
      // Nothing sent yet, so the next model in the chain can still take over.
    }
  }

  throw new ApiError(
    503,
    'AI_UNAVAILABLE',
    'The assistant could not answer just now. Your credits were not charged — please try again.',
  );
}

// ───────────────────────── admin helpers ─────────────────────────

/** Catalogue from the bundled registry, for the admin "add model" picker. */
function catalogue() {
  return registry.listProviders().map((p) => ({
    providerKey: p.id,
    label: p.label,
    models: p.models.map((m) => ({ id: m.id, label: m.label || m.id, fast: !!m.fast })),
    supports: p.supports,
  }));
}

/** Verifies a stored key by making the smallest real call the provider allows. */
async function healthCheck(providerRowId) {
  const row = get('SELECT * FROM ai_providers WHERE id = ?', providerRowId);
  if (!row) throw badRequest('No such provider.');
  const apiKey = row.api_key_cipher ? decryptSecret(row.api_key_cipher) : null;
  if (!apiKey) {
    markProviderHealth(providerRowId, false, 'No API key configured');
    return { healthy: false, error: 'No API key configured' };
  }
  const provider = registry.getProvider(row.provider_key);
  try {
    await provider.complete({
      apiKey,
      model: registry.fastModel(row.provider_key),
      system: 'Reply with the single word: ok',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'ok' }] }],
    });
    markProviderHealth(providerRowId, true);
    return { healthy: true };
  } catch (err) {
    markProviderHealth(providerRowId, false, err.message);
    return { healthy: false, error: err.message };
  }
}

module.exports = {
  complete,
  completeStream,
  classify,
  resolveChain,
  catalogue,
  healthCheck,
  recordRequest,
  estimateTokens,
};
