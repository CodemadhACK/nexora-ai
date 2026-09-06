/**
 * Plumbing every AI provider needs: retries, SSE reading, and a common error
 * shape. Nothing provider-specific lives here.
 *
 * `fetchImpl` is threaded through every call rather than reaching for the
 * global. That is the seam the tests use to drive real streaming behaviour
 * without a network.
 */

'use strict';

/** An error the UI can show verbatim. `code` lets callers branch without regex. */
class ProviderError extends Error {
  constructor(message, { code = null, status = null, retryAfter = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

const NO_API_KEY = 'NO_API_KEY';

/**
 * The neutral message shape everything above the providers speaks:
 *   { role: 'user' | 'assistant', parts: [ {type:'text', text} | {type:'image', mime, data} ] }
 */
function textOf(message) {
  return (message.parts || [])
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function hasImage(messages) {
  return messages.some((m) => (m.parts || []).some((p) => p.type === 'image'));
}

/**
 * Drops all but the newest N images. A screenshot is by far the most expensive
 * thing in a conversation, and once it has been described the follow-up turns
 * ride on the answer text instead — so resending every past capture buys
 * nothing but latency and tokens.
 */
function trimImages(messages, keep = 1) {
  let budget = keep;
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const parts = [];
    for (const part of m.parts || []) {
      if (part.type !== 'image') { parts.push(part); continue; }
      if (budget > 0) { parts.push(part); budget--; }
    }
    out.unshift(parts.length ? { ...m, parts } : { ...m, parts: [{ type: 'text', text: textOf(m) || '(image omitted)' }] });
  }
  return out;
}

/**
 * POST with backoff on 429. `retryAfterFrom` lets each provider read whatever
 * it puts in the body or headers. A long suggested wait means a daily quota
 * rather than a burst, so we fail fast instead of sleeping on it.
 */
async function postWithRetry(url, init, {
  fetchImpl,
  notify,
  maxRetries = 2,
  retryAfterFrom = () => null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
} = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, init);
    if (res.status !== 429 || attempt >= maxRetries) return res;

    const bodyText = await res.text();
    const retryAfter = retryAfterFrom(bodyText, res.headers);
    if (retryAfter && retryAfter > 30) {
      return new Response(bodyText, { status: 429 });
    }

    const waitSec = Math.min(30, Math.max(2, retryAfter || (attempt + 1) * 5));
    if (notify) notify(`Rate limited — retrying in ${waitSec}s…`);
    await sleep(waitSec * 1000);
    if (init.signal && init.signal.aborted) return new Response(bodyText, { status: 429 });
  }
}

/**
 * Reads a `text/event-stream` body, handing each parsed `data:` payload to
 * `onEvent`. Malformed frames are skipped rather than thrown: one bad chunk
 * should not lose an answer that is already half rendered.
 */
async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;

      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let parsed;
      try { parsed = JSON.parse(payload); } catch { continue; }
      onEvent(parsed);
    }
  }
}

module.exports = {
  ProviderError, NO_API_KEY,
  textOf, hasImage, trimImages,
  postWithRetry, readSSE
};
