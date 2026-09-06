/**
 * Google Gemini provider.
 *
 * The request/response handling, quota parsing and error wording are carried
 * over from the original single-provider implementation — they were correct and
 * hard-won. What changed is the shape of the input: this module now translates
 * the app's neutral message format into Gemini's `contents` rather than having
 * the renderer build Gemini payloads directly.
 */

'use strict';

const { ProviderError, NO_API_KEY, postWithRetry, readSSE } = require('./shared');

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const MODELS = [
  { id: 'gemini-3.5-flash-lite',   label: 'Gemini 3.5 Flash Lite · highest free limits', vision: true, fast: true },
  { id: 'gemini-3.8-flash',        label: 'Gemini 3.8 Flash · best all-round',           vision: true },
  { id: 'gemini-3.7-flash',        label: 'Gemini 3.7 Flash',                            vision: true },
  { id: 'gemini-3.1-flash-lite',   label: 'Gemini 3.1 Flash Lite',                       vision: true, fast: true },
  { id: 'gemini-3.1-pro-preview',  label: 'Gemini 3.1 Pro · deepest reasoning (preview)', vision: true },
  { id: 'gemini-2.5-flash',        label: 'Gemini 2.5 Flash · legacy',                   vision: true },
  { id: 'gemini-2.5-pro',          label: 'Gemini 2.5 Pro · legacy',                     vision: true }
];

const TRANSCRIBE_MODELS = [
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite · highest free limits' },
  { id: 'gemini-3.5-transcribe', label: 'Gemini 3.5 Transcribe · best accuracy' },
  { id: 'gemini-3.8-flash',      label: 'Gemini 3.8 Flash' },
  { id: 'gemini-2.5-flash',      label: 'Gemini 2.5 Flash' }
];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Pulls the structured bits Google puts in `error.details` for a 429. */
function parseQuotaInfo(bodyText) {
  const info = { retryAfter: null, metric: null, limit: null, message: null };
  try {
    const parsed = JSON.parse(bodyText);
    info.message = parsed?.error?.message || null;
    for (const d of parsed?.error?.details || []) {
      const type = d['@type'] || '';
      if (type.includes('RetryInfo') && typeof d.retryDelay === 'string') {
        const m = /^([\d.]+)s$/.exec(d.retryDelay);
        if (m) info.retryAfter = Math.ceil(parseFloat(m[1]));
      }
      if (type.includes('QuotaFailure')) {
        const v = (d.violations || [])[0];
        if (v) {
          info.metric = v.quotaMetric || v.quotaId || null;
          info.limit = v.quotaValue || null;
        }
      }
    }
  } catch { /* non-JSON body */ }
  return info;
}

/** Turns a quota metric id into something a human can act on. */
function describeQuota(metric) {
  if (!metric) return '';
  if (/per_day|PerDay/i.test(metric)) return 'daily request quota';
  if (/per_minute|PerMinute/i.test(metric)) return 'per-minute request quota';
  if (/input_token|InputToken/i.test(metric)) return 'token-per-minute quota';
  return metric;
}

function apiError(status, bodyText, model) {
  let detail = bodyText;
  try {
    detail = JSON.parse(bodyText)?.error?.message || bodyText;
  } catch { /* leave raw */ }

  if (status === 400 && /API key not valid/i.test(detail)) {
    return new ProviderError(
      'That Gemini API key was rejected by Google. Check it in Settings (get one at aistudio.google.com/apikey).',
      { code: 'BAD_KEY', status }
    );
  }
  if (status === 429) {
    const q = parseQuotaInfo(bodyText);
    const parts = [`Rate limited on ${model || 'this model'}.`];
    const named = describeQuota(q.metric);
    if (named) parts.push(`You've hit your ${named}${q.limit ? ` (limit ${q.limit})` : ''}.`);
    if (q.retryAfter) parts.push(`Google says retry in ${q.retryAfter}s.`);
    parts.push(
      'Free-tier quotas are counted per model, so switching the model in Settings ' +
      '(gemini-3.5-flash-lite has the most generous free limits) usually clears this immediately. ' +
      'Your live quotas are at aistudio.google.com/rate-limit.'
    );
    if (!named && q.message) parts.push(`Google said: ${q.message}`);
    return new ProviderError(parts.join(' '), { code: 'RATE_LIMIT', status, retryAfter: q.retryAfter });
  }
  if (status === 403) {
    return new ProviderError('Access denied. The key may not have the Generative Language API enabled.', { code: 'FORBIDDEN', status });
  }
  if (status === 404) {
    return new ProviderError(`Model not available on your key: ${model || ''}. ${detail} — pick another in Settings.`, { code: 'NO_MODEL', status });
  }
  return new ProviderError(`Gemini API error ${status}: ${detail}`, { status });
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/** Any part carrying `data` is inline media — image or audio, same envelope. */
function toContents(messages) {
  return messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: (m.parts || []).map((p) => (
      p.type === 'text'
        ? { text: p.text || '' }
        : { inline_data: { mime_type: p.mime || 'image/png', data: p.data } }
    ))
  }));
}

/** Gemini marks internal reasoning parts with `thought`; those are not the answer. */
function textFromParts(parts) {
  return (parts || [])
    .filter((p) => !p.thought && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');
}

function requireKey(apiKey) {
  if (!apiKey) throw new ProviderError('No Gemini API key set.', { code: NO_API_KEY });
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

async function stream({
  apiKey, model, system, messages, temperature,
  signal, onDelta, onStatus, fetchImpl = fetch
}) {
  requireKey(apiKey);

  const url = `${API_BASE}/${encodeURIComponent(model)}:streamGenerateContent` +
              `?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const body = { contents: toContents(messages) };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (Number.isFinite(temperature)) body.generationConfig = { temperature: Number(temperature) };

  let res;
  try {
    res = await postWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal
    }, {
      fetchImpl,
      notify: onStatus,
      retryAfterFrom: (text) => parseQuotaInfo(text).retryAfter
    });
  } catch (err) {
    if (err.name === 'AbortError') return { text: '', aborted: true };
    throw new ProviderError(`Network error reaching Gemini: ${err.message}`, { code: 'NETWORK' });
  }

  if (!res.ok) throw apiError(res.status, await res.text(), model);

  let full = '';
  try {
    await readSSE(res, (chunk) => {
      const delta = textFromParts(chunk?.candidates?.[0]?.content?.parts);
      if (!delta) return;
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

  const url = `${API_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = { contents: toContents(messages) };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (Number.isFinite(temperature)) body.generationConfig = { temperature: Number(temperature) };

  const res = await postWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  }, { fetchImpl, maxRetries: 1, retryAfterFrom: (text) => parseQuotaInfo(text).retryAfter });

  if (!res.ok) throw apiError(res.status, await res.text(), model);

  const data = await res.json();
  return textFromParts(data?.candidates?.[0]?.content?.parts).trim();
}

/**
 * The "return nothing" clause is spelled out because models reach for a marker
 * — "<noise>", "[inaudible]" — when they are unsure, and a marker sent on as the
 * user's question is worse than silence. The clip is already trimmed and
 * normalised before it gets here, so a genuine attempt is expected.
 */
const TRANSCRIBE_INSTRUCTION =
  'Transcribe this audio verbatim. Return ONLY the words spoken — no commentary, ' +
  'no labels, no speaker names, no quotation marks, no timestamps, and no ' +
  'description of the audio. The recording may be quiet or brief; transcribe it ' +
  'anyway and do your best with unclear words. It is technical speech, so expect ' +
  'programming and software engineering terms. If and only if there is genuinely ' +
  'no speech at all, return an empty response — never a placeholder such as ' +
  '"<noise>", "[inaudible]" or "(silence)".';

async function transcribe({ apiKey, model, wavBase64, fetchImpl = fetch }) {
  return complete({
    apiKey,
    model,
    messages: [{
      role: 'user',
      parts: [
        { type: 'audio', mime: 'audio/wav', data: wavBase64 },
        { type: 'text', text: TRANSCRIBE_INSTRUCTION }
      ]
    }],
    fetchImpl
  });
}

module.exports = {
  id: 'gemini',
  label: 'Google Gemini',
  keyEnv: 'GEMINI_API_KEY',
  keyUrl: 'https://aistudio.google.com/apikey',
  keyHint: 'AIza…',
  blurb: 'Free tier is generous and needs only a Google account.',
  models: MODELS,
  transcribeModels: TRANSCRIBE_MODELS,
  defaults: {
    model: 'gemini-3.8-flash',
    transcribeModel: 'gemini-3.5-transcribe',
    // Where transcription goes when the dedicated model is unavailable or comes
    // back empty. A capable multimodal model, deliberately — not the cheapest
    // one, which is bad at speech and was the previous fallback.
    transcribeFallback: 'gemini-3.8-flash',
    temperature: 1.0
  },
  supports: { streaming: true, vision: true, transcription: true, temperature: true },
  stream, complete, transcribe,
  // exported for tests
  _internals: { toContents, textFromParts, apiError, parseQuotaInfo, describeQuota }
};
