'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const providers = require('../providers');
const gemini = require('../providers/gemini');
const openai = require('../providers/openai');
const { trimImages, ProviderError, NO_API_KEY } = require('../providers/shared');
const { sseResponse, jsonResponse, recordingFetch } = require('./helpers/fake-fetch');

const userText = (text) => [{ role: 'user', parts: [{ type: 'text', text }] }];
const withImage = (text) => [{
  role: 'user',
  parts: [{ type: 'image', mime: 'image/png', data: 'AAAA' }, { type: 'text', text }]
}];

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

test('every provider is registered and exposes the same interface', () => {
  const ids = providers.PROVIDERS.map((p) => p.id);
  assert.deepEqual(ids.sort(), ['anthropic', 'gemini', 'openai']);

  for (const provider of providers.PROVIDERS) {
    for (const key of ['id', 'label', 'keyEnv', 'keyUrl', 'models', 'transcribeModels', 'defaults', 'supports']) {
      assert.ok(provider[key], `${provider.id} is missing ${key}`);
    }
    for (const fn of ['stream', 'complete', 'transcribe']) {
      assert.equal(typeof provider[fn], 'function', `${provider.id}.${fn} should be a function`);
    }
    assert.ok(provider.models.length, `${provider.id} should list models`);
    assert.ok(provider.models.some((m) => m.id === provider.defaults.model), `${provider.id} default model should be in its catalogue`);
  }
});

test('an unknown provider id falls back instead of throwing', () => {
  assert.equal(providers.getProvider('does-not-exist').id, providers.DEFAULT_PROVIDER);
  assert.equal(providers.getProvider(undefined).id, providers.DEFAULT_PROVIDER);
  assert.equal(providers.hasProvider('does-not-exist'), false);
  assert.equal(providers.hasProvider('openai'), true);
});

test('every provider offers a fast model for suggestions', () => {
  for (const provider of providers.PROVIDERS) {
    const id = providers.fastModel(provider.id);
    assert.ok(provider.models.some((m) => m.id === id));
  }
});

test('listProviders does not leak the call functions to the renderer', () => {
  for (const entry of providers.listProviders()) {
    assert.equal(entry.stream, undefined);
    assert.equal(entry.complete, undefined);
  }
});

// ---------------------------------------------------------------------------
// Context trimming
// ---------------------------------------------------------------------------

test('only the newest screenshot survives into the next request', () => {
  const history = [
    { role: 'user', parts: [{ type: 'image', mime: 'image/png', data: 'OLD' }, { type: 'text', text: 'first' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'answered' }] },
    { role: 'user', parts: [{ type: 'image', mime: 'image/png', data: 'NEW' }, { type: 'text', text: 'second' }] }
  ];

  const trimmed = trimImages(history, 1);
  const images = trimmed.flatMap((m) => m.parts.filter((p) => p.type === 'image'));

  assert.equal(images.length, 1);
  assert.equal(images[0].data, 'NEW', 'the most recent capture is the one worth resending');
  assert.equal(trimmed[0].parts.some((p) => p.type === 'text' && p.text === 'first'), true,
    'the text of the older turn must survive even though its image did not');
  assert.equal(trimmed.length, 3);
});

test('trimming leaves an image-free conversation untouched', () => {
  const history = userText('hello');
  assert.deepEqual(trimImages(history, 1), history);
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

test('gemini translates the neutral format into contents', () => {
  const contents = gemini._internals.toContents([
    { role: 'user', parts: [{ type: 'image', mime: 'image/jpeg', data: 'XYZ' }, { type: 'text', text: 'what is this' }] },
    { role: 'assistant', parts: [{ type: 'text', text: 'a bug' }] }
  ]);

  assert.deepEqual(contents, [
    { role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data: 'XYZ' } }, { text: 'what is this' }] },
    { role: 'model', parts: [{ text: 'a bug' }] }
  ]);
});

test('gemini streams deltas and skips its own thinking parts', async () => {
  const frame = (parts) => `data: ${JSON.stringify({ candidates: [{ content: { parts } }] })}\n`;
  const fetchImpl = recordingFetch(sseResponse([
    frame([{ text: 'Hel' }]),
    frame([{ text: 'lo', thought: false }, { text: ' there', thought: true }]),
    'data: [DONE]\n'
  ]));

  const deltas = [];
  const { text, aborted } = await gemini.stream({
    apiKey: 'k', model: 'gemini-3.8-flash', system: 'sys',
    messages: userText('hi'), temperature: 0.7,
    onDelta: (d) => deltas.push(d), fetchImpl
  });

  assert.equal(text, 'Hello');
  assert.equal(aborted, false);
  assert.deepEqual(deltas, ['Hel', 'lo']);

  const sent = fetchImpl.calls[0];
  assert.match(sent.url, /streamGenerateContent\?alt=sse/);
  assert.equal(sent.body.systemInstruction.parts[0].text, 'sys');
  assert.equal(sent.body.generationConfig.temperature, 0.7);
});

test('gemini reassembles an SSE frame split across chunk boundaries', async () => {
  const payload = JSON.stringify({ candidates: [{ content: { parts: [{ text: 'split' }] } }] });
  const fetchImpl = recordingFetch(sseResponse([`data: ${payload.slice(0, 12)}`, `${payload.slice(12)}\n`]));

  const { text } = await gemini.stream({ apiKey: 'k', model: 'm', messages: userText('hi'), fetchImpl });
  assert.equal(text, 'split');
});

test('gemini turns a rejected key into advice, not a status code', async () => {
  const fetchImpl = recordingFetch(jsonResponse({ error: { message: 'API key not valid. Please pass a valid API key.' } }, { status: 400 }));

  await assert.rejects(
    () => gemini.stream({ apiKey: 'bad', model: 'm', messages: userText('hi'), fetchImpl }),
    (err) => {
      assert.equal(err.code, 'BAD_KEY');
      assert.match(err.message, /aistudio\.google\.com\/apikey/);
      return true;
    }
  );
});

test('gemini names the quota it hit on a 429', async () => {
  const body = {
    error: {
      message: 'Quota exceeded',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generate_requests_per_day', quotaValue: '50' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '45s' }
      ]
    }
  };
  // A 45s retry hint means a daily quota, so it should fail fast rather than sleep.
  const fetchImpl = recordingFetch(jsonResponse(body, { status: 429 }));

  await assert.rejects(
    () => gemini.stream({ apiKey: 'k', model: 'gemini-3.8-flash', messages: userText('hi'), fetchImpl }),
    (err) => {
      assert.equal(err.code, 'RATE_LIMIT');
      assert.match(err.message, /daily request quota/);
      assert.match(err.message, /limit 50/);
      return true;
    }
  );
  assert.equal(fetchImpl.calls.length, 1, 'a long retry window should not be waited out');
});

test('gemini refuses to call out without a key', async () => {
  const fetchImpl = recordingFetch(jsonResponse({}, { status: 200 }));
  await assert.rejects(
    () => gemini.stream({ apiKey: '', model: 'm', messages: userText('hi'), fetchImpl }),
    (err) => err.code === NO_API_KEY
  );
  assert.equal(fetchImpl.calls.length, 0, 'no request should leave the machine');
});

// ---------------------------------------------------------------------------
// OpenAI
// ---------------------------------------------------------------------------

test('openai sends images as data-URI image_url parts', () => {
  const messages = openai._internals.toMessages('be brief', withImage('what is this'));

  assert.deepEqual(messages[0], { role: 'system', content: 'be brief' });
  assert.deepEqual(messages[1].content[0], { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
  assert.deepEqual(messages[1].content[1], { type: 'text', text: 'what is this' });
});

test('openai omits temperature for reasoning models and sends it otherwise', () => {
  const { buildBody } = openai._internals;
  const args = { system: '', messages: userText('hi'), temperature: 0.3 };

  assert.equal(buildBody({ ...args, model: 'gpt-4.1-mini' }).temperature, 0.3);
  assert.equal('temperature' in buildBody({ ...args, model: 'gpt-5' }), false);
  assert.equal('temperature' in buildBody({ ...args, model: 'o4-mini' }), false);
  // Model ids ship faster than this catalogue, so the rule is pattern-based too.
  assert.equal('temperature' in buildBody({ ...args, model: 'o9-future' }), false);
});

test('openai streams choice deltas', async () => {
  const frame = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n`;
  const fetchImpl = recordingFetch(sseResponse([
    frame('Ans'), frame('wer'),
    'data: {"choices":[{"delta":{}}]}\n',       // a role-only frame carries no text
    'data: [DONE]\n'
  ]));

  const deltas = [];
  const { text } = await openai.stream({
    apiKey: 'sk-x', model: 'gpt-4.1-mini', system: 's',
    messages: userText('hi'), onDelta: (d) => deltas.push(d), fetchImpl
  });

  assert.equal(text, 'Answer');
  assert.deepEqual(deltas, ['Ans', 'wer']);
  assert.equal(fetchImpl.calls[0].body.stream, true);
  assert.equal(fetchImpl.calls[0].init.headers.Authorization, 'Bearer sk-x');
});

test('openai maps a 401 to key advice and a quota 429 to billing advice', async () => {
  const unauthorised = recordingFetch(jsonResponse({ error: { message: 'Incorrect API key' } }, { status: 401 }));
  await assert.rejects(
    () => openai.stream({ apiKey: 'sk-bad', model: 'gpt-4.1-mini', messages: userText('hi'), fetchImpl: unauthorised }),
    (err) => err.code === 'BAD_KEY' && /platform\.openai\.com/.test(err.message)
  );

  const noQuota = recordingFetch(jsonResponse(
    { error: { message: 'You exceeded your current quota, please check your plan and billing details.' } },
    { status: 429, headers: { 'retry-after': '120' } }
  ));
  await assert.rejects(
    () => openai.stream({ apiKey: 'sk-x', model: 'gpt-4.1-mini', messages: userText('hi'), fetchImpl: noQuota }),
    (err) => err.code === 'NO_QUOTA'
  );
});

test('openai reads its retry hint from the header', () => {
  const { retryAfterFrom } = openai._internals;
  assert.equal(retryAfterFrom('', { get: () => '12' }), 12);
  assert.equal(retryAfterFrom('', { get: () => null }), null);
  assert.equal(retryAfterFrom('', undefined), null);
});

test('a ProviderError carries a code the UI can branch on', () => {
  const err = new ProviderError('nope', { code: 'BAD_KEY', status: 401 });
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'BAD_KEY');
  assert.equal(err.status, 401);
});
