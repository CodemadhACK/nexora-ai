/**
 * Anthropic provider — Claude via the official SDK.
 *
 * The other two providers here are hand-rolled fetch clients on the shared SSE
 * plumbing. This one is not, deliberately: Anthropic ships an official SDK, and
 * its streaming event shapes, beta flags and error taxonomy are exactly the
 * sort of thing that is wrong in ways you only discover in production if you
 * write them from memory. The test seam survives anyway — the SDK accepts a
 * `fetch` of our choosing, so `fetchImpl` threads through as it does elsewhere.
 *
 * Three Claude-specific things worth knowing before editing:
 *
 *  - Sampling is gone on the current models. `temperature` returns a 400 on
 *    Opus 5, Sonnet 5 and Fable 5.1; only the older Haiku still accepts one.
 *  - Thinking is deliberately not configured. Omitting it runs adaptive
 *    thinking on Opus 5, Sonnet 5 and Fable 5.1, and no thinking on Haiku —
 *    the right default for each, and it cannot 400.
 *  - A request can come back refused: HTTP 200 with `stop_reason: "refusal"`.
 *    The SDK does not throw for that, so it has to be checked explicitly or it
 *    reaches the user as an empty answer with no explanation.
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { ProviderError, NO_API_KEY } = require('./shared');

const MODELS = [
  { id: 'claude-opus-5',    label: 'Claude Opus 5 · strongest',            vision: true },
  { id: 'claude-sonnet-5',  label: 'Claude Sonnet 5 · balanced',           vision: true },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 · fastest, cheapest', vision: true, fast: true },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 · most capable',      vision: true }
];

// Anthropic has no speech-to-text API. Left empty rather than pointed at
// someone else's: a provider module here answers for its own vendor only.
const TRANSCRIBE_MODELS = [];

// Streaming gets room, because a truncated answer costs a whole retry. The
// non-streaming path stays lower so it cannot outlive the SDK's HTTP timeout.
const MAX_TOKENS_STREAM = 64000;
const MAX_TOKENS_COMPLETE = 16000;

// Models that reject temperature/top_p/top_k outright. The same models are the
// ones that take `effort`, which is not a coincidence: on current Claude models
// effort is the knob temperature used to be. Haiku is the other way round --
// it takes a temperature and errors on effort -- so both lists are needed.
const NO_SAMPLING = new Set(['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5-1']);
const SUPPORTS_EFFORT = NO_SAMPLING;

/**
 * How hard to think, by what the call is for. The solver's answer is the
 * product, so it gets the good setting; the short auxiliary calls get the cheap
 * one, where extra thoroughness buys nothing and the latency is felt. Effort is
 * the single biggest quality-vs-cost lever on these models, and leaving it at
 * the default meant paying solver-grade thinking to write four follow-up chips.
 */
const EFFORT_BY_INTENT = {
  solve: 'high',
  synthesis: 'medium',
  suggestions: 'low'
};

// Server-side fallbacks: on a policy decline the API re-runs the same request
// on another model within the same call instead of handing back nothing.
// 'default' routes by refusal category, so there is no model list to maintain.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

const acceptsTemperature = (model) => !NO_SAMPLING.has(model);
const usesFallbacks = (model) => FALLBACK_MODELS.has(model);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function refusalError(message) {
  const details = message && message.stop_details;
  const category = (details && details.category) || 'policy';
  return new ProviderError(
    `Claude declined to answer this one (${category}). Rephrasing usually helps.`,
    { code: 'REFUSED', status: 200 }
  );
}

/** Maps the SDK's typed errors onto the shape the rest of the app branches on. */
function toProviderError(err, model) {
  if (err instanceof ProviderError) return err;

  if (err instanceof Anthropic.AuthenticationError) {
    return new ProviderError(
      'That Anthropic API key was rejected. Check it in Settings (keys live at console.anthropic.com/settings/keys).',
      { code: 'BAD_KEY', status: 401 }
    );
  }
  if (Anthropic.PermissionDeniedError && err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(`Anthropic denied this request: ${err.message}`, { code: 'FORBIDDEN', status: 403 });
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderError(
      `Your Anthropic account has no access to ${model || 'that model'}. Pick another in Settings.`,
      { code: 'NO_MODEL', status: 404 }
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    const quota = /credit|billing|quota/i.test(err.message || '');
    return new ProviderError(
      quota
        ? `Anthropic says you are out of credit: ${err.message} Top up at console.anthropic.com/settings/billing.`
        : `Rate limited on ${model || 'this model'}. ${err.message}`,
      { code: quota ? 'NO_QUOTA' : 'RATE_LIMIT', status: 429 }
    );
  }
  if (Anthropic.APIConnectionError && err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(`Network error reaching Anthropic: ${err.message}`, { code: 'NETWORK' });
  }
  if (err instanceof Anthropic.APIError) {
    if (err.status >= 500) {
      return new ProviderError(
        `Anthropic is having trouble (${err.status}). Worth retrying in a moment.`,
        { code: 'UPSTREAM', status: err.status }
      );
    }
    return new ProviderError(`Anthropic API error ${err.status}: ${err.message}`, { status: err.status });
  }
  return new ProviderError(`Anthropic request failed: ${err.message}`);
}

function isAbort(err) {
  if (Anthropic.APIUserAbortError && err instanceof Anthropic.APIUserAbortError) return true;
  return !!err && (err.name === 'AbortError' || err.name === 'APIUserAbortError');
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/**
 * The neutral message shape into Claude content blocks. The system prompt is
 * not a message here — it is a top-level parameter — so it never reaches this.
 */
function toMessages(messages) {
  return (messages || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: (m.parts || []).map((p) => (
      p.type === 'text'
        ? { type: 'text', text: p.text || '' }
        : { type: 'image', source: { type: 'base64', media_type: p.mime || 'image/png', data: p.data } }
    ))
  }));
}

function requireKey(apiKey) {
  if (!apiKey) throw new ProviderError('No Anthropic API key set.', { code: NO_API_KEY });
}

function makeClient(apiKey, fetchImpl) {
  const options = { apiKey };
  // Only overridden when a caller supplies one: the tests do, the app does not.
  if (fetchImpl) options.fetch = fetchImpl;
  return new Anthropic(options);
}

function buildParams({ model, system, messages, temperature, maxTokens, intent = 'solve' }) {
  const params = {
    model,
    max_tokens: maxTokens,
    messages: toMessages(messages)
  };
  if (system) {
    // Cached, because it is the stable half of every request. Persona, profile,
    // house style and formatting rules run to hundreds of lines and do not
    // change between turns, while the messages after them grow every turn.
    // Caching reads that prefix back at a fraction of the price and shortens
    // time-to-first-token, which in the middle of an interview is not a cost
    // question but a usability one. Too short a prefix simply will not cache;
    // that is a miss, not an error.
    params.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }
  if (SUPPORTS_EFFORT.has(model)) {
    params.output_config = { effort: EFFORT_BY_INTENT[intent] || EFFORT_BY_INTENT.solve };
  }
  if (Number.isFinite(temperature) && acceptsTemperature(model)) {
    params.temperature = Number(temperature);
  }
  if (usesFallbacks(model)) {
    params.betas = [FALLBACK_BETA];
    params.fallbacks = 'default';
  }
  return params;
}

/** The beta endpoint only where a beta parameter is actually being sent. */
const endpoint = (client, model) => (usesFallbacks(model) ? client.beta.messages : client.messages);

/**
 * The numbers that answer "is the cache actually working". A `cacheRead` that
 * stays at zero across turns of one conversation means something ahead of the
 * breakpoint is changing between requests, which is the usual way caching is
 * switched on and quietly does nothing.
 */
function summariseUsage(usage) {
  return {
    input: usage.input_tokens || 0,
    output: usage.output_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    cacheWrite: usage.cache_creation_input_tokens || 0
  };
}

function textOfMessage(message) {
  return ((message && message.content) || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

async function stream({
  apiKey, model, system, messages, temperature,
  signal, onDelta, onStatus, onUsage, intent, fetchImpl
}) {
  requireKey(apiKey);
  const client = makeClient(apiKey, fetchImpl);
  const params = buildParams({ model, system, messages, temperature, intent, maxTokens: MAX_TOKENS_STREAM });

  let full = '';
  try {
    const running = endpoint(client, model).stream(params, { signal });

    for await (const event of running) {
      if (event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') continue;
      full += event.delta.text;
      if (onDelta) onDelta(event.delta.text);
    }

    // A refusal arrives as a perfectly successful response with nothing useful
    // in it, so this check belongs after the stream drains, not in a catch.
    const final = await running.finalMessage();
    if (final.stop_reason === 'refusal') throw refusalError(final);

    // Worth saying out loud when a fallback answered: the reply came from a
    // different model than the one chosen in Settings.
    if (onStatus && final.model && final.model !== model) {
      onStatus(`${model} declined — answered by ${final.model}.`);
    }

    // Reported rather than assumed. Caching either works or silently does not,
    // and the only way to tell the difference is to look at what came back.
    if (onUsage && final.usage) onUsage(summariseUsage(final.usage));
  } catch (err) {
    if (isAbort(err)) return { text: full, aborted: true };
    throw toProviderError(err, model);
  }

  return { text: full, aborted: false };
}

async function complete({ apiKey, model, system, messages, temperature, signal, onUsage, intent, fetchImpl }) {
  requireKey(apiKey);
  const client = makeClient(apiKey, fetchImpl);
  const params = buildParams({ model, system, messages, temperature, intent, maxTokens: MAX_TOKENS_COMPLETE });

  let message;
  try {
    message = await endpoint(client, model).create(params, { signal });
  } catch (err) {
    throw toProviderError(err, model);
  }

  if (message.stop_reason === 'refusal') throw refusalError(message);
  if (onUsage && message.usage) onUsage(summariseUsage(message.usage));
  return textOfMessage(message).trim();
}

/**
 * Anthropic has no transcription endpoint. This throws rather than returning
 * empty text, because a silent empty transcript reads as "you said nothing"
 * and sends people hunting for a microphone fault that is not there.
 */
async function transcribe() {
  throw new ProviderError(
    'Anthropic does not offer speech-to-text. Choose Gemini or OpenAI for transcription in Settings.',
    { code: 'NO_TRANSCRIPTION' }
  );
}

module.exports = {
  id: 'anthropic',
  label: 'Claude (Anthropic)',
  keyEnv: 'ANTHROPIC_API_KEY',
  keyUrl: 'https://console.anthropic.com/settings/keys',
  keyHint: 'sk-ant-…',
  blurb: 'Pay-as-you-go. Current Claude models ignore temperature, and there is no speech-to-text.',
  models: MODELS,
  transcribeModels: TRANSCRIBE_MODELS,
  defaults: {
    model: 'claude-opus-5',
    transcribeModel: null,
    transcribeFallback: null,
    temperature: 1.0
  },
  supports: { streaming: true, vision: true, transcription: false, temperature: false },
  stream, complete, transcribe,
  // exported for tests
  _internals: { toMessages, buildParams, toProviderError, acceptsTemperature, usesFallbacks, textOfMessage, summariseUsage, EFFORT_BY_INTENT }
};
