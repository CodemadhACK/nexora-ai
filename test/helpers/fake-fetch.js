'use strict';

/**
 * A stand-in for `fetch` that lets a test drive real streaming behaviour —
 * including the chunk boundaries, which is where SSE parsers actually break.
 */

/** Builds a Response-shaped object whose body yields `chunks` in order. */
function sseResponse(chunks, { status = 200 } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length
          ? { done: false, value: encoder.encode(chunks[i++]) }
          : { done: true, value: undefined })
      })
    },
    text: async () => chunks.join(''),
    json: async () => JSON.parse(chunks.join(''))
  };
}

function jsonResponse(payload, { status = 200, headers = {} } = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => JSON.parse(body)
  };
}

/** Records every call, and replies with whatever the queue hands back. */
function recordingFetch(responses) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: init && init.body ? safeParse(init.body) : null });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (typeof next === 'function') return next(url, init);
    return next;
  };
  impl.calls = calls;
  return impl;
}

function safeParse(body) {
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body); } catch { return body; }
}

module.exports = { sseResponse, jsonResponse, recordingFetch };
