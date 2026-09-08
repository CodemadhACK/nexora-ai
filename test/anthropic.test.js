'use strict';

/**
 * The Anthropic provider drives the official SDK rather than raw fetch, so the
 * fake here has to be a real `Response` over a real stream — the duck-typed
 * helpers the other provider tests use satisfy hand-rolled code but not an SDK
 * that reads headers and consumes a web stream. Testing through the SDK is the
 * point: it is the layer where the wire format is either right or silently not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const anthropic = require('../providers/anthropic');
const { NO_API_KEY } = require('../providers/shared');

const userText = (text) => [{ role: 'user', parts: [{ type: 'text', text }] }];

/** Anthropic's message-stream event sequence, as SSE. */
function streamBody({ deltas = ['Hello'], stopReason = 'end_turn', model = 'claude-opus-5' } = {}) {
  const frames = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', model,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 }
      }
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }]
  ];

  for (const text of deltas) {
    frames.push(['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }]);
  }

  frames.push(['content_block_stop', { type: 'content_block_stop', index: 0 }]);
  frames.push(['message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 5 },
    ...(stopReason === 'refusal' ? { stop_details: { type: 'refusal', category: 'cyber' } } : {})
  }]);
  frames.push(['message_stop', { type: 'message_stop' }]);

  return frames.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

/** Records requests and answers with real Responses. */
function fakeFetch(makeResponse) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({
      url: String(url),
      headers: init && init.headers,
      body: init && init.body ? JSON.parse(init.body) : null
    });
    return makeResponse(calls.length);
  };
  impl.calls = calls;
  return impl;
}

const sse = (body) => new Response(body, {
  status: 200,
  headers: { 'content-type': 'text/event-stream' }
});

const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers: { 'content-type': 'application/json' }
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

test('streaming yields each delta and returns the assembled answer', async () => {
  const deltas = [];
  const fetchImpl = fakeFetch(() => sse(streamBody({ deltas: ['Hel', 'lo ', 'world'] })));

  const result = await anthropic.stream({
    apiKey: 'sk-ant-test',
    model: 'claude-opus-5',
    messages: userText('hi'),
    onDelta: (d) => deltas.push(d),
    fetchImpl
  });

  assert.equal(result.text, 'Hello world');
  assert.equal(result.aborted, false);
  assert.deepEqual(deltas, ['Hel', 'lo ', 'world']);
});

test('the system prompt travels as a top-level parameter, not as a message', async () => {
  // Claude has no system role in `messages`; sending one there is a 400, and
  // quietly folding it into the first user turn would change the prompt.
  const fetchImpl = fakeFetch(() => sse(streamBody()));

  await anthropic.stream({
    apiKey: 'sk-ant-test',
    model: 'claude-opus-5',
    system: 'You are terse.',
    messages: userText('hi'),
    fetchImpl
  });

  const { body } = fetchImpl.calls[0];
  assert.equal(body.system, 'You are terse.');
  assert.deepEqual(body.messages.map((m) => m.role), ['user']);
});

test('an image becomes a base64 image block', async () => {
  const fetchImpl = fakeFetch(() => sse(streamBody()));

  await anthropic.stream({
    apiKey: 'sk-ant-test',
    model: 'claude-opus-5',
    messages: [{
      role: 'user',
      parts: [{ type: 'image', mime: 'image/png', data: 'AAAA' }, { type: 'text', text: 'what is this?' }]
    }],
    fetchImpl
  });

  const [image, text] = fetchImpl.calls[0].body.messages[0].content;
  assert.deepEqual(image, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
  assert.equal(text.text, 'what is this?');
});

// ---------------------------------------------------------------------------
// Model-specific request shape
// ---------------------------------------------------------------------------

test('temperature is withheld from models that reject it', async () => {
  // Opus 5, Sonnet 5 and Fable 5.1 return a 400 for any sampling parameter.
  // Sending one because the settings slider has a value would break every
  // request on the default model.
  const fetchImpl = fakeFetch(() => sse(streamBody()));

  await anthropic.stream({ apiKey: 'k', model: 'claude-opus-5', messages: userText('hi'), temperature: 0.7, fetchImpl });
  assert.equal('temperature' in fetchImpl.calls[0].body, false);

  await anthropic.stream({ apiKey: 'k', model: 'claude-haiku-4-5', messages: userText('hi'), temperature: 0.7, fetchImpl });
  assert.equal(fetchImpl.calls[1].body.temperature, 0.7, 'Haiku still accepts one');
});

test('server-side fallbacks ride along only where they are supported', async () => {
  const fetchImpl = fakeFetch(() => sse(streamBody()));

  await anthropic.stream({ apiKey: 'k', model: 'claude-opus-5', messages: userText('hi'), fetchImpl });
  assert.equal(fetchImpl.calls[0].body.fallbacks, 'default');
  assert.match(fetchImpl.calls[0].url, /\/v1\/messages/);

  await anthropic.stream({ apiKey: 'k', model: 'claude-haiku-4-5', messages: userText('hi'), fetchImpl });
  assert.equal('fallbacks' in fetchImpl.calls[1].body, false);
});

test('max_tokens is generous when streaming and bounded when not', async () => {
  const fetchImpl = fakeFetch((n) => (n === 1
    ? sse(streamBody())
    : json({
        id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-opus-5',
        content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      })));

  await anthropic.stream({ apiKey: 'k', model: 'claude-opus-5', messages: userText('hi'), fetchImpl });
  await anthropic.complete({ apiKey: 'k', model: 'claude-opus-5', messages: userText('hi'), fetchImpl });

  assert.equal(fetchImpl.calls[0].body.max_tokens, 64000);
  assert.equal(fetchImpl.calls[1].body.max_tokens, 16000);
});

// ---------------------------------------------------------------------------
// Refusals and errors
// ---------------------------------------------------------------------------

test('a refusal surfaces as a diagnostic rather than an empty answer', async () => {
  // HTTP 200 with stop_reason "refusal". The SDK does not throw for this, so
  // without the explicit check the user just watches nothing appear.
  const fetchImpl = fakeFetch(() => sse(streamBody({ deltas: [], stopReason: 'refusal' })));

  await assert.rejects(
    anthropic.stream({ apiKey: 'k', model: 'claude-opus-5', messages: userText('hi'), fetchImpl }),
    (err) => {
      assert.equal(err.code, 'REFUSED');
      assert.match(err.message, /declined/);
      return true;
    }
  );
});

test('a rejected key is named as such', async () => {
  const fetchImpl = fakeFetch(() => json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401));

  await assert.rejects(
    anthropic.stream({ apiKey: 'bad', model: 'claude-opus-5', messages: userText('hi'), fetchImpl }),
    (err) => {
      assert.equal(err.code, 'BAD_KEY');
      assert.match(err.message, /Anthropic API key was rejected/);
      return true;
    }
  );
});

test('a missing key fails before any request is made', async () => {
  const fetchImpl = fakeFetch(() => sse(streamBody()));

  await assert.rejects(
    anthropic.stream({ apiKey: '', model: 'claude-opus-5', messages: userText('hi'), fetchImpl }),
    (err) => {
      assert.equal(err.code, NO_API_KEY);
      return true;
    }
  );
  assert.deepEqual(fetchImpl.calls, [], 'nothing should have been sent');
});

test('transcription says plainly that Anthropic does not do it', async () => {
  await assert.rejects(
    anthropic.transcribe({ apiKey: 'k', model: 'whatever', wavBase64: '' }),
    (err) => {
      assert.equal(err.code, 'NO_TRANSCRIPTION');
      assert.match(err.message, /Gemini or OpenAI/);
      return true;
    }
  );
});

test('it offers no transcription models, so nothing can select it for voice', () => {
  assert.deepEqual(anthropic.transcribeModels, []);
  assert.equal(anthropic.supports.transcription, false);
});

test('the default model is one it actually lists', () => {
  assert.ok(anthropic.models.some((m) => m.id === anthropic.defaults.model));
  assert.equal(anthropic.defaults.model, 'claude-opus-5');
  assert.ok(anthropic.models.some((m) => m.fast), 'suggestions and synthesis need a fast model');
});
