/**
 * OpenAI provider — Chat Completions for text and vision, Audio Transcriptions
 * for speech.
 *
 * Two details that bite if you skip them: the reasoning models reject a
 * `temperature` other than the default, and images travel as `image_url` parts
 * holding a data URI rather than as a separate media field.
 */

'use strict';

const { ProviderError, NO_API_KEY, postWithRetry, readSSE } = require('./shared');

const API_BASE = 'https://api.openai.com/v1';

const MODELS = [
  { id: 'gpt-5',        label: 'GPT-5 · strongest reasoning',        vision: true, reasoning: true },
  { id: 'gpt-5-mini',   label: 'GPT-5 mini · fast and cheap',        vision: true, reasoning: true, fast: true },
  { id: 'gpt-4.1',      label: 'GPT-4.1 · strong all-round',         vision: true },
  { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini · fast',                vision: true, fast: true },
  { id: 'gpt-4o',       label: 'GPT-4o · multimodal',                vision: true },
  { id: 'gpt-4o-mini',  label: 'GPT-4o mini · cheapest vision',      vision: true, fast: true },
  { id: 'o4-mini',      label: 'o4-mini · reasoning, low cost',      vision: true, reasoning: true }
];

const TRANSCRIBE_MODELS = [
  { id: 'gpt-4o-mini-transcribe', label: 'GPT-4o mini Transcribe · fast' },
  { id: 'gpt-4o-transcribe',      label: 'GPT-4o Transcribe · most accurate' },
  { id: 'whisper-1',              label: 'Whisper v1 · legacy' }
];

const REASONING = new Set(MODELS.filter((m) => m.reasoning).map((m) => m.id));

/** Reasoning models run at a fixed temperature and 400 if you send one. */
function acceptsTemperature(model) {
  return !REASONING.has(model) && !/^(o\d|gpt-5)/.test(model || '');
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function apiError(status, bodyText, model) {
  let detail = bodyText;
  let type = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || bodyText;
    type = parsed?.error?.code || parsed?.error?.type || '';
  } catch { /* leave raw */ }

  if (status === 401) {
    return new ProviderError(
      'That OpenAI API key was rejected. Check it in Settings (keys live at platform.openai.com/api-keys).',
      { code: 'BAD_KEY', status }
    );
  }
  if (status === 403) {
    return new ProviderError(`OpenAI denied this request: ${detail}`, { code: 'FORBIDDEN', status });
  }
  if (status === 404 || /model_not_found/.test(type)) {
    return new ProviderError(
      `Your OpenAI account has no access to ${model || 'that model'}. Pick another in Settings.`,
      { code: 'NO_MODEL', status }
    );
  }
  if (status === 429) {
    const quota = /quota|billing/i.test(detail);
    return new ProviderError(
      quota
        ? `OpenAI says you are out of quota: ${detail} Add credit at platform.openai.com/settings/organization/billing.`
        : `Rate limited on ${model || 'this model'}. ${detail}`,
      { code: quota ? 'NO_QUOTA' : 'RATE_LIMIT', status }
    );
  }
  if (status >= 500) {
    return new ProviderError(`OpenAI is having trouble (${status}). Worth retrying in a moment.`, { code: 'UPSTREAM', status });
  }
  return new ProviderError(`OpenAI API error ${status}: ${detail}`, { status });
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

function toMessages(system, messages) {
  const out = system ? [{ role: 'system', content: system }] : [];

  for (const m of messages) {
    const content = (m.parts || []).map((p) => (
      p.type === 'text'
        ? { type: 'text', text: p.text || '' }
        : { type: 'image_url', image_url: { url: `data:${p.mime || 'image/png'};base64,${p.data}` } }
    ));
    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content });
  }
  return out;
}

function requireKey(apiKey) {
  if (!apiKey) throw new ProviderError('No OpenAI API key set.', { code: NO_API_KEY });
}

function buildBody({ model, system, messages, temperature, stream }) {
  const body = { model, messages: toMessages(system, messages) };
  if (stream) body.stream = true;
  if (Number.isFinite(temperature) && acceptsTemperature(model)) {
    body.temperature = Number(temperature);
  }
  return body;
}

const authHeaders = (apiKey) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${apiKey}`
});

/** OpenAI puts the wait in a header rather than the body. */
function retryAfterFrom(_bodyText, headers) {
  const raw = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

async function stream({
  apiKey, model, system, messages, temperature,
  signal, onDelta, onStatus, fetchImpl = fetch
}) {
  requireKey(apiKey);

  let res;
  try {
    res = await postWithRetry(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify(buildBody({ model, system, messages, temperature, stream: true })),
      signal
    }, { fetchImpl, notify: onStatus, retryAfterFrom });
  } catch (err) {
    if (err.name === 'AbortError') return { text: '', aborted: true };
    throw new ProviderError(`Network error reaching OpenAI: ${err.message}`, { code: 'NETWORK' });
  }

  if (!res.ok) throw apiError(res.status, await res.text(), model);

  let full = '';
  try {
    await readSSE(res, (chunk) => {
      const delta = chunk?.choices?.[0]?.delta?.content;
      if (typeof delta !== 'string' || !delta) return;
      full += delta;
      if (onDelta) onDelta(delta);
    });
  } catch (err) {
    if (err.name === 'AbortError') return { text: full, aborted: true };
    throw err;
  }

  return { text: full, aborted: false };
}

async function complete({ apiKey, model, system, messages, temperature, signal, fetchImpl = fetch }) {
  requireKey(apiKey);

  const res = await postWithRetry(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: JSON.stringify(buildBody({ model, system, messages, temperature, stream: false })),
    signal
  }, { fetchImpl, maxRetries: 1, retryAfterFrom });

  if (!res.ok) throw apiError(res.status, await res.text(), model);

  const data = await res.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}

async function transcribe({ apiKey, model, wavBase64, fetchImpl = fetch }) {
  requireKey(apiKey);

  const form = new FormData();
  form.append('model', model);
  form.append('response_format', 'text');
  form.append('file', new Blob([Buffer.from(wavBase64, 'base64')], { type: 'audio/wav' }), 'speech.wav');

  const res = await fetchImpl(`${API_BASE}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },   // no Content-Type: FormData sets the boundary
    body: form
  });

  if (!res.ok) throw apiError(res.status, await res.text(), model);
  return (await res.text()).trim();
}

module.exports = {
  id: 'openai',
  label: 'OpenAI',
  keyEnv: 'OPENAI_API_KEY',
  keyUrl: 'https://platform.openai.com/api-keys',
  keyHint: 'sk-…',
  blurb: 'Pay-as-you-go. Reasoning models run at a fixed temperature.',
  models: MODELS,
  transcribeModels: TRANSCRIBE_MODELS,
  defaults: {
    model: 'gpt-4.1-mini',
    transcribeModel: 'gpt-4o-mini-transcribe',
    transcribeFallback: 'gpt-4o-transcribe',
    temperature: 1.0
  },
  supports: { streaming: true, vision: true, transcription: true, temperature: true },
  stream, complete, transcribe,
  // exported for tests
  _internals: { toMessages, buildBody, apiError, acceptsTemperature, retryAfterFrom }
};
