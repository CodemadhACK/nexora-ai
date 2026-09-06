/**
 * Runs a turn across one or two agents and, when there are two, compares them.
 *
 * Everything that can overlap does. Both agents start in the same tick rather
 * than one after the other; follow-up suggestions start the moment agent 1
 * finishes, without waiting for agent 2; and the comparison starts as soon as
 * both answers are in — while suggestions may still be in flight. The user sees
 * the first token of agent 1 at exactly the same moment they would if agent 2
 * did not exist.
 *
 * Progress is pushed out through `onEvent` as it happens, so the window never
 * has to sit on a spinner waiting for a whole response.
 */

'use strict';

const { getProvider, fastModel, trimImages, NO_API_KEY } = require('./providers');
const prompts = require('./prompts');

const SOLVER = 1;
const REVIEWER = 2;

/** How many past screenshots to keep in context. See providers/shared.js. */
const IMAGE_BUDGET = 1;

function createAgentRunner({ readKey, log = () => {} } = {}) {
  const running = new Map();   // requestId -> AbortController

  function stop(requestId) {
    const controller = running.get(requestId);
    if (!controller) return false;
    controller.abort();
    running.delete(requestId);
    return true;
  }

  function stopAll() {
    for (const controller of running.values()) {
      try { controller.abort(); } catch { /* already gone */ }
    }
    running.clear();
  }

  /** One agent's stream, reported as it goes. Never throws — it resolves to an outcome. */
  async function runOne({ slot, agent, system, messages, signal, onEvent }) {
    const provider = getProvider(agent.providerId);
    const emit = (patch) => onEvent({ type: 'agent', slot, ...patch });

    emit({ state: 'working', provider: provider.id, model: agent.model });

    let started = false;
    try {
      const key = readKey(provider.id);
      const { text, aborted } = await provider.stream({
        apiKey: key,
        model: agent.model,
        system,
        messages,
        temperature: agent.temperature,
        signal,
        onStatus: (statusText) => emit({ state: 'status', text: statusText }),
        onDelta: (delta) => {
          if (!started) { started = true; emit({ state: 'streaming' }); }
          onEvent({ type: 'chunk', slot, delta });
        }
      });

      emit({ state: 'done', text, aborted });
      return { ok: true, text, aborted };
    } catch (err) {
      const needsKey = err.code === NO_API_KEY;
      const message = needsKey
        ? `No ${provider.label} API key set. Add one in Settings.`
        : err.message || String(err);
      log(`agent ${slot} (${provider.id}) failed: ${message}`);
      emit({ state: 'error', error: message, needsKey });
      return { ok: false, error: message, needsKey };
    }
  }

  /** The comparison pane. Best-effort: a failure here must not spoil the answers. */
  async function runSynthesis({ agent, question, first, second, signal, onEvent }) {
    const provider = getProvider(agent.providerId);
    const emit = (patch) => onEvent({ type: 'synthesis', ...patch });

    emit({ state: 'working' });
    let started = false;
    try {
      const { text } = await provider.stream({
        apiKey: readKey(provider.id),
        model: agent.model,
        system: prompts.SYNTHESIS_SYSTEM,
        messages: prompts.buildSynthesisMessages({ question, first, second }),
        temperature: agent.temperature,
        signal,
        onDelta: (delta) => {
          if (!started) { started = true; emit({ state: 'streaming' }); }
          onEvent({ type: 'chunk', slot: 'synthesis', delta });
        }
      });
      emit({ state: 'done', text });
      return text;
    } catch (err) {
      log(`synthesis failed: ${err.message}`);
      emit({ state: 'error', error: err.message });
      return '';
    }
  }

  /**
   * Follow-ups run on the provider's cheapest model: they are four short
   * strings, and spending the good model's latency on them would delay nothing
   * the user is reading.
   */
  async function runSuggestions({ agent, question, answer, signal, onEvent }) {
    if (!answer || !answer.trim()) return [];
    const provider = getProvider(agent.providerId);

    try {
      const raw = await provider.complete({
        apiKey: readKey(provider.id),
        model: fastModel(provider.id),
        system: prompts.SUGGESTIONS_SYSTEM,
        messages: prompts.buildSuggestionMessages({ question, answer }),
        temperature: 0.6,
        signal
      });
      const items = prompts.parseSuggestions(raw);
      onEvent({ type: 'suggestions', items });
      return items;
    } catch (err) {
      log(`suggestions failed: ${err.message}`);
      onEvent({ type: 'suggestions', items: [] });
      return [];
    }
  }

  /**
   * @param {object} turn
   * @param {string} turn.requestId
   * @param {Array}  turn.messages       neutral history, current turn last
   * @param {string} turn.question       plain text of the current turn
   * @param {Array}  turn.agents         [{ providerId, model, temperature }]
   * @param {Function} turn.onEvent
   */
  async function run({
    requestId,
    messages,
    question = '',
    agents,
    persona,
    profile,
    hasScreenshot = false,
    wantSynthesis = true,
    wantSuggestions = true,
    onEvent = () => {}
  }) {
    const controller = new AbortController();
    running.set(requestId, controller);
    const { signal } = controller;

    const context = trimImages(messages, IMAGE_BUDGET);
    const [primary, secondary] = agents;
    const twoAgents = agents.length > 1;

    const systemFor = (role) => prompts.buildSystemInstruction({
      persona, profile, role, hasScreenshot
    });

    try {
      // Both agents leave the gate together — this is the whole point of the mode.
      const first = runOne({
        slot: SOLVER, agent: primary, system: systemFor('solver'),
        messages: context, signal, onEvent
      });

      const second = twoAgents
        ? runOne({
            slot: REVIEWER, agent: secondary, system: systemFor('reviewer'),
            messages: context, signal, onEvent
          })
        : Promise.resolve(null);

      // Suggestions depend only on agent 1, so they start without waiting for agent 2.
      const suggestionsPromise = first.then((result) => (
        wantSuggestions && result.ok && !result.aborted
          ? runSuggestions({ agent: primary, question, answer: result.text, signal, onEvent })
          : []
      ));

      const [firstResult, secondResult] = await Promise.all([first, second]);

      let synthesis = '';
      if (twoAgents && wantSynthesis &&
          firstResult.ok && secondResult && secondResult.ok &&
          !firstResult.aborted && !secondResult.aborted) {
        synthesis = await runSynthesis({
          agent: primary, question,
          first: firstResult.text, second: secondResult.text,
          signal, onEvent
        });
      }

      const suggestions = await suggestionsPromise;

      return {
        ok: firstResult.ok || !!(secondResult && secondResult.ok),
        aborted: !!firstResult.aborted,
        answers: { 1: firstResult, 2: secondResult },
        synthesis,
        suggestions
      };
    } finally {
      running.delete(requestId);
    }
  }

  return { run, stop, stopAll, isRunning: (id) => running.has(id) };
}

module.exports = { createAgentRunner, SOLVER, REVIEWER, IMAGE_BUDGET };
