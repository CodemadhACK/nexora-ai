'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAgentRunner, SOLVER, REVIEWER } = require('../agents');
const providersModule = require('../providers');

/**
 * Swaps both providers for stubs the test controls, so orchestration can be
 * checked — ordering, concurrency, partial failure — without a network.
 */
function stubProviders(t, behaviour) {
  const original = new Map();
  for (const provider of providersModule.PROVIDERS) {
    original.set(provider.id, { stream: provider.stream, complete: provider.complete });
    const impl = behaviour[provider.id] || {};
    provider.stream = impl.stream || (async () => ({ text: `${provider.id} answer`, aborted: false }));
    provider.complete = impl.complete || (async () => '["one","two"]');
  }
  t.after(() => {
    for (const provider of providersModule.PROVIDERS) {
      Object.assign(provider, original.get(provider.id));
    }
  });
}

const AGENT_1 = { providerId: 'gemini', model: 'gemini-3.8-flash', temperature: 1 };
const AGENT_2 = { providerId: 'openai', model: 'gpt-4.1-mini', temperature: 1 };
const MESSAGES = [{ role: 'user', parts: [{ type: 'text', text: 'Reverse a linked list' }] }];

const runner = (readKey = () => 'key') => createAgentRunner({ readKey });

function collect() {
  const events = [];
  return { events, onEvent: (e) => events.push(e) };
}

const delay = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));

// ---------------------------------------------------------------------------

test('a single agent answers, and no second pane or comparison is produced', async (t) => {
  stubProviders(t, {
    gemini: { stream: async ({ onDelta }) => { onDelta('Use '); onDelta('three pointers.'); return { text: 'Use three pointers.', aborted: false }; } }
  });

  const { events, onEvent } = collect();
  const result = await runner().run({
    requestId: 'r1', messages: MESSAGES, question: 'Reverse a linked list',
    agents: [AGENT_1], onEvent
  });

  assert.equal(result.ok, true);
  assert.equal(result.answers[1].text, 'Use three pointers.');
  assert.equal(result.answers[2], null);
  assert.equal(result.synthesis, '');

  assert.deepEqual(events.filter((e) => e.type === 'chunk').map((e) => e.delta), ['Use ', 'three pointers.']);
  assert.ok(!events.some((e) => e.slot === REVIEWER));
  assert.ok(!events.some((e) => e.type === 'synthesis'));
});

test('two agents run concurrently, not one after the other', async (t) => {
  const started = [];
  const startOne = (id) => async () => {
    started.push({ id, at: Date.now() });
    await delay(60);
    return { text: `${id} answer`, aborted: false };
  };

  stubProviders(t, {
    gemini: { stream: startOne('gemini') },
    openai: { stream: startOne('openai') }
  });

  const began = Date.now();
  const result = await runner().run({
    requestId: 'r2', messages: MESSAGES, agents: [AGENT_1, AGENT_2],
    wantSynthesis: false, wantSuggestions: false, onEvent: () => {}
  });
  const elapsed = Date.now() - began;

  assert.equal(started.length, 2);
  assert.ok(Math.abs(started[0].at - started[1].at) < 25, 'both agents should start in the same tick');
  assert.ok(elapsed < 110, `two 60ms agents run in parallel should finish well under 120ms, took ${elapsed}ms`);
  assert.equal(result.answers[1].text, 'gemini answer');
  assert.equal(result.answers[2].text, 'openai answer');
});

test('agent 2 gets the reviewer instruction and agent 1 does not', async (t) => {
  const systems = {};
  stubProviders(t, {
    gemini: { stream: async ({ system }) => { systems.one = system; return { text: 'a', aborted: false }; } },
    openai: { stream: async ({ system }) => { systems.two = system; return { text: 'b', aborted: false }; } }
  });

  await runner().run({
    requestId: 'r3', messages: MESSAGES, agents: [AGENT_1, AGENT_2],
    wantSynthesis: false, wantSuggestions: false, onEvent: () => {}
  });

  assert.ok(!systems.one.includes('SECOND agent'));
  assert.match(systems.two, /SECOND agent/);
  assert.match(systems.two, /### Review/);
});

test('the comparison runs once both answers are in, and reports as it streams', async (t) => {
  let call = 0;
  stubProviders(t, {
    gemini: {
      stream: async ({ onDelta }) => {
        call++;
        if (call === 1) return { text: 'iterative', aborted: false };
        if (onDelta) onDelta('Agent 1 is right.');       // this call is the synthesis
        return { text: 'Agent 1 is right.', aborted: false };
      }
    },
    openai: { stream: async () => ({ text: 'recursive', aborted: false }) }
  });

  const { events, onEvent } = collect();
  const result = await runner().run({
    requestId: 'r4', messages: MESSAGES, question: 'Reverse a linked list',
    agents: [AGENT_1, AGENT_2], wantSuggestions: false, onEvent
  });

  assert.equal(result.synthesis, 'Agent 1 is right.');
  const states = events.filter((e) => e.type === 'synthesis').map((e) => e.state);
  assert.deepEqual(states, ['working', 'streaming', 'done']);
  assert.ok(events.some((e) => e.type === 'chunk' && e.slot === 'synthesis'));
});

test('no comparison when either agent failed — there is nothing honest to compare', async (t) => {
  stubProviders(t, {
    gemini: { stream: async () => ({ text: 'fine', aborted: false }) },
    openai: { stream: async () => { throw new Error('upstream exploded'); } }
  });

  const { events, onEvent } = collect();
  const result = await runner().run({
    requestId: 'r5', messages: MESSAGES, agents: [AGENT_1, AGENT_2],
    wantSuggestions: false, onEvent
  });

  assert.equal(result.ok, true, 'one good answer is still a usable turn');
  assert.equal(result.answers[1].ok, true);
  assert.equal(result.answers[2].ok, false);
  assert.equal(result.synthesis, '');
  assert.ok(!events.some((e) => e.type === 'synthesis'));

  const failure = events.find((e) => e.type === 'agent' && e.state === 'error');
  assert.equal(failure.slot, REVIEWER);
  assert.match(failure.error, /upstream exploded/);
});

test('a missing key is reported as an instruction, and flagged for the UI', async (t) => {
  stubProviders(t, {
    gemini: {
      stream: async () => {
        const err = new Error('No Gemini API key set.');
        err.code = providersModule.NO_API_KEY;
        throw err;
      }
    }
  });

  const { events, onEvent } = collect();
  const result = await runner(() => '').run({
    requestId: 'r6', messages: MESSAGES, agents: [AGENT_1], onEvent
  });

  assert.equal(result.ok, false);
  const failure = events.find((e) => e.state === 'error');
  assert.equal(failure.needsKey, true);
  assert.match(failure.error, /Add one in Settings/);
});

test('suggestions do not wait for agent 2', async (t) => {
  const timeline = [];
  stubProviders(t, {
    gemini: {
      stream: async () => { timeline.push('agent1-done'); return { text: 'quick', aborted: false }; },
      complete: async () => { timeline.push('suggestions-start'); return '["Explain the invariant"]'; }
    },
    openai: { stream: async () => { await delay(80); timeline.push('agent2-done'); return { text: 'slow', aborted: false }; } }
  });

  const { events, onEvent } = collect();
  const result = await runner().run({
    requestId: 'r7', messages: MESSAGES, agents: [AGENT_1, AGENT_2],
    wantSynthesis: false, onEvent
  });

  assert.deepEqual(result.suggestions, ['Explain the invariant']);
  assert.ok(
    timeline.indexOf('suggestions-start') < timeline.indexOf('agent2-done'),
    `suggestions should start before the slower agent finishes: ${timeline.join(' → ')}`
  );
  assert.deepEqual(events.find((e) => e.type === 'suggestions').items, ['Explain the invariant']);
});

test('suggestions use the provider its cheapest model, not the answering model', async (t) => {
  let usedModel = null;
  stubProviders(t, {
    gemini: {
      stream: async () => ({ text: 'answer', aborted: false }),
      complete: async ({ model }) => { usedModel = model; return '["a"]'; }
    }
  });

  await runner().run({ requestId: 'r8', messages: MESSAGES, agents: [AGENT_1], onEvent: () => {} });

  assert.equal(usedModel, providersModule.fastModel('gemini'));
  assert.notEqual(usedModel, AGENT_1.model);
});

test('a suggestions failure never damages the answer', async (t) => {
  stubProviders(t, {
    gemini: {
      stream: async () => ({ text: 'the answer', aborted: false }),
      complete: async () => { throw new Error('suggestion model is down'); }
    }
  });

  const { events, onEvent } = collect();
  const result = await runner().run({ requestId: 'r9', messages: MESSAGES, agents: [AGENT_1], onEvent });

  assert.equal(result.answers[1].text, 'the answer');
  assert.deepEqual(result.suggestions, []);
  assert.deepEqual(events.find((e) => e.type === 'suggestions').items, []);
});

test('suggestions are skipped for an aborted or empty answer', async (t) => {
  let asked = 0;
  stubProviders(t, {
    gemini: {
      stream: async () => ({ text: '', aborted: true }),
      complete: async () => { asked++; return '["nope"]'; }
    }
  });

  const result = await runner().run({ requestId: 'r10', messages: MESSAGES, agents: [AGENT_1], onEvent: () => {} });
  assert.equal(result.aborted, true);
  assert.equal(asked, 0);
});

test('stop aborts the run and the signal reaches the provider', async (t) => {
  let sawAbort = false;
  stubProviders(t, {
    gemini: {
      stream: async ({ signal }) => {
        await new Promise((resolve) => {
          signal.addEventListener('abort', () => { sawAbort = true; resolve(); }, { once: true });
        });
        return { text: '', aborted: true };
      }
    }
  });

  const agentRunner = runner();
  const pending = agentRunner.run({ requestId: 'r11', messages: MESSAGES, agents: [AGENT_1], onEvent: () => {} });

  await delay(10);
  assert.equal(agentRunner.isRunning('r11'), true);
  assert.equal(agentRunner.stop('r11'), true);

  const result = await pending;
  assert.equal(sawAbort, true);
  assert.equal(result.aborted, true);
  assert.equal(agentRunner.isRunning('r11'), false);
});

test('stopping an unknown request is harmless', () => {
  assert.equal(runner().stop('never-existed'), false);
});

test('only the newest screenshot is forwarded to the agents', async (t) => {
  let received = null;
  stubProviders(t, {
    gemini: { stream: async ({ messages }) => { received = messages; return { text: 'ok', aborted: false }; } }
  });

  await runner().run({
    requestId: 'r12',
    messages: [
      { role: 'user', parts: [{ type: 'image', mime: 'image/png', data: 'OLD' }, { type: 'text', text: 'first' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'answered' }] },
      { role: 'user', parts: [{ type: 'image', mime: 'image/png', data: 'NEW' }, { type: 'text', text: 'second' }] }
    ],
    agents: [AGENT_1], wantSuggestions: false, onEvent: () => {}
  });

  const images = received.flatMap((m) => m.parts.filter((p) => p.type === 'image'));
  assert.equal(images.length, 1);
  assert.equal(images[0].data, 'NEW');
});

test('slot numbers are stable, because the UI panes are keyed on them', () => {
  assert.equal(SOLVER, 1);
  assert.equal(REVIEWER, 2);
});
