/**
 * End-of-turn detection for hands-free voice input.
 *
 * The microphone already produces a level per captured batch; this decides, from
 * nothing but those levels, when the user has stopped talking. Keeping it here —
 * pure, dependency-free, no timers — means the rule that ends someone's sentence
 * is testable without a microphone, a model or a clock.
 *
 * Time is accumulated from the duration of each batch rather than read from a
 * clock. The audio thread is the authority on how much sound has actually been
 * captured, and the main thread can be throttled or blocked behind a render — a
 * wall clock would cut people off mid-word on a busy machine.
 *
 * Loaded both as a plain script in the renderer (window.NexoraVoice) and with
 * require() in the tests, the same way audio-dsp.js is.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NexoraVoice = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    speechLevel: 0.02,     // RMS above this counts as speech, not room tone
    minSpeechMs: 400,      // shorter than this is a cough or a chair, not a turn
    silenceMs: 1200,       // trailing silence that ends a turn
    leadInMs: 8000,        // nobody started talking at all
    maxTurnMs: 120000      // the hard cap that bounds the buffer
  };

  /**
   * Ranges, not just defaults: these numbers reach the detector from a settings
   * file a user can hand-edit, and a silenceMs of 0 would end every turn on the
   * first batch — an app that cannot be configured into uselessness is worth the
   * few lines.
   */
  const LIMITS = {
    speechLevel: [0.002, 0.4],
    minSpeechMs: [100, 5000],
    silenceMs: [300, 5000],
    leadInMs: [1000, 60000],
    maxTurnMs: [5000, 600000]
  };

  function clamp(value, [lo, hi], fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  function normaliseVoiceOptions(options) {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      out[key] = clamp((options || {})[key], LIMITS[key], DEFAULTS[key]);
    }
    return out;
  }

  /**
   * Feed it `push(level, ms)` per captured batch. It answers with what the turn is
   * doing, and exactly one `end` — after that it reports `ended` until `reset()`,
   * so a caller that pushes one more batch cannot submit the same turn twice.
   *
   * `end` carries a reason because they need different handling: `silence` is a
   * finished question worth transcribing, `no-speech` is an open mic nobody spoke
   * into and must not become an empty request.
   */
  function createTurnDetector(options) {
    const config = normaliseVoiceOptions(options);

    let speechMs = 0;
    let silenceMs = 0;
    let totalMs = 0;
    let heardSpeech = false;
    let ended = null;

    function stats() {
      return { speechMs, silenceMs, totalMs, heardSpeech };
    }

    function finish(reason) {
      ended = { type: 'end', reason, ...stats() };
      return ended;
    }

    function push(level, ms) {
      if (ended) return { type: 'ended', reason: ended.reason, ...stats() };

      const duration = Number.isFinite(Number(ms)) ? Math.max(0, Number(ms)) : 0;
      totalMs += duration;

      if (Number(level) >= config.speechLevel) {
        heardSpeech = true;
        speechMs += duration;
        silenceMs = 0;
      } else if (heardSpeech) {
        silenceMs += duration;
      }

      // The cap comes first: a turn that has run this long ends whatever it is
      // doing, and the buffer behind it is already at its limit.
      if (totalMs >= config.maxTurnMs) {
        return finish(heardSpeech ? 'max-length' : 'no-speech');
      }

      // Silence only ends a turn that had something in it. Below minSpeechMs the
      // silence counter is deliberately left to keep climbing, so a cough followed
      // by quiet resolves as no-speech rather than sitting open until the cap.
      if (heardSpeech && speechMs >= config.minSpeechMs && silenceMs >= config.silenceMs) {
        return finish('silence');
      }

      if (!heardSpeech && totalMs >= config.leadInMs) return finish('no-speech');

      if (heardSpeech && speechMs < config.minSpeechMs && silenceMs >= config.leadInMs) {
        return finish('no-speech');
      }

      if (!heardSpeech) return { type: 'waiting', ...stats() };
      return { type: silenceMs > 0 ? 'pause' : 'speech', ...stats() };
    }

    function reset() {
      speechMs = 0;
      silenceMs = 0;
      totalMs = 0;
      heardSpeech = false;
      ended = null;
    }

    return { push, reset, stats, config };
  }

  /**
   * What the status line says for each phase of a hands-free turn. Kept beside the
   * detector because the two have to agree: a UI claiming "Listening" while the
   * detector has already ended the turn is how people end up talking to nothing.
   */
  const TURN_LABELS = {
    waiting: 'Listening…',
    speech: 'Listening…',
    pause: 'Listening… (pause)',
    silence: 'Got it — transcribing…',
    'max-length': 'That is as much as I can take in one turn — transcribing…',
    'no-speech': 'I did not hear anything.'
  };

  function describeTurn(event) {
    if (!event) return TURN_LABELS.waiting;
    if (event.type === 'end' || event.type === 'ended') {
      return TURN_LABELS[event.reason] || TURN_LABELS.waiting;
    }
    return TURN_LABELS[event.type] || TURN_LABELS.waiting;
  }

  return {
    DEFAULTS, LIMITS,
    createTurnDetector, normaliseVoiceOptions, describeTurn, TURN_LABELS
  };
}));
