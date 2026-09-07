'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const voice = require('../voice-turn');

const BATCH = 100;   // ms per captured batch, roughly what the worklet produces

/**
 * Feeds `ms` worth of audio at one level and returns the event it settled on.
 * Stops at an `end`, because that is what the caller does — the recording is
 * torn down there, so no further batch is ever pushed.
 */
function feed(detector, level, ms) {
  let last = null;
  for (let sent = 0; sent < ms; sent += BATCH) {
    last = detector.push(level, BATCH);
    if (last.type === 'end') break;   // the caller tears the recording down here
  }
  return last;
}

const LOUD = 0.2;      // comfortably above the default speech floor
const QUIET = 0.001;   // room tone

// ---------------------------------------------------------------------------
// Ending a turn
// ---------------------------------------------------------------------------

test('a sentence followed by enough silence ends the turn', () => {
  const d = voice.createTurnDetector({});

  assert.equal(feed(d, LOUD, 1000).type, 'speech');
  assert.equal(feed(d, QUIET, 1000).type, 'pause', 'a second of silence is a pause, not an ending');

  const end = feed(d, QUIET, 300);
  assert.equal(end.type, 'end');
  assert.equal(end.reason, 'silence');
  assert.ok(end.speechMs >= 1000, 'the whole utterance should be accounted for');
});

/**
 * The pause in the middle of a sentence is the thing that makes naive silence
 * detection unusable: people stop to think, and being cut off mid-question is
 * worse than waiting a moment longer.
 */
test('speech resets the silence counter, so thinking mid-sentence does not submit', () => {
  const d = voice.createTurnDetector({});

  feed(d, LOUD, 600);
  feed(d, QUIET, 1000);                        // a beat, just under the threshold
  const resumed = feed(d, LOUD, 400);          // ...and they carry on

  assert.equal(resumed.type, 'speech');
  assert.equal(resumed.silenceMs, 0, 'the pause should be forgotten once they speak again');

  assert.equal(feed(d, QUIET, 1000).type, 'pause', 'the countdown starts again from zero');
  assert.equal(feed(d, QUIET, 300).type, 'end');
});

test('an open microphone nobody spoke into ends as no-speech, not as a turn', () => {
  const d = voice.createTurnDetector({});
  const end = feed(d, QUIET, 8000);

  assert.equal(end.type, 'end');
  assert.equal(end.reason, 'no-speech', 'an empty turn must not become an empty request');
  assert.equal(end.heardSpeech, false);
});

test('a cough is not a turn', () => {
  const d = voice.createTurnDetector({});

  feed(d, LOUD, 200);                          // shorter than minSpeechMs
  const end = feed(d, QUIET, 8000);

  assert.equal(end.type, 'end');
  assert.equal(end.reason, 'no-speech', 'too little speech to be worth transcribing');
});

test('a turn that runs past the cap ends itself', () => {
  const d = voice.createTurnDetector({ maxTurnMs: 5000 });
  const end = feed(d, LOUD, 5000);

  assert.equal(end.type, 'end');
  assert.equal(end.reason, 'max-length');
});

// ---------------------------------------------------------------------------
// Firing exactly once
// ---------------------------------------------------------------------------

test('the end fires exactly once, however many batches arrive after it', () => {
  const d = voice.createTurnDetector({});
  feed(d, LOUD, 1000);

  const ends = [];
  for (let i = 0; i < 40; i++) {
    const event = d.push(QUIET, BATCH);
    if (event.type === 'end') ends.push(event);
  }

  assert.equal(ends.length, 1, 'a second end would submit the same turn twice');
  assert.equal(d.push(LOUD, BATCH).type, 'ended', 'later speech does not reopen a closed turn');
});

test('reset makes the detector usable for the next turn', () => {
  const d = voice.createTurnDetector({});
  feed(d, LOUD, 1000);
  feed(d, QUIET, 1300);
  assert.equal(d.push(QUIET, BATCH).type, 'ended');

  d.reset();
  assert.deepEqual(d.stats(), { speechMs: 0, silenceMs: 0, totalMs: 0, heardSpeech: false });
  assert.equal(feed(d, LOUD, 500).type, 'speech', 'the next turn starts clean');
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

test('the silence threshold is what actually decides when a turn ends', () => {
  const impatient = voice.createTurnDetector({ silenceMs: 400 });
  feed(impatient, LOUD, 600);
  assert.equal(feed(impatient, QUIET, 400).type, 'end', 'a short threshold ends sooner');

  const patient = voice.createTurnDetector({ silenceMs: 3000 });
  feed(patient, LOUD, 600);
  assert.equal(feed(patient, QUIET, 2000).type, 'pause', 'a long threshold waits');
  assert.equal(feed(patient, QUIET, 1000).type, 'end');
});

/**
 * These arrive from a settings file a user can hand-edit. A silenceMs of zero
 * would end every turn on the first batch and make the microphone useless.
 */
test('hand-edited options are clamped into a range that still works', () => {
  assert.equal(voice.normaliseVoiceOptions({ silenceMs: 0 }).silenceMs, voice.LIMITS.silenceMs[0]);
  assert.equal(voice.normaliseVoiceOptions({ silenceMs: 999999 }).silenceMs, voice.LIMITS.silenceMs[1]);
  assert.equal(voice.normaliseVoiceOptions({ speechLevel: -5 }).speechLevel, voice.LIMITS.speechLevel[0]);

  for (const junk of [undefined, null, {}, { silenceMs: 'soon' }, { silenceMs: NaN }]) {
    assert.deepEqual(voice.normaliseVoiceOptions(junk), voice.DEFAULTS, `${JSON.stringify(junk)} should fall back`);
  }
});

test('a batch with no duration cannot stall or advance a turn', () => {
  const d = voice.createTurnDetector({});
  const event = d.push(QUIET, 'not a number');
  assert.equal(event.totalMs, 0);
  assert.equal(event.type, 'waiting');
});

// ---------------------------------------------------------------------------
// What the user is told
// ---------------------------------------------------------------------------

test('every phase of a turn has something honest to show the user', () => {
  assert.match(voice.describeTurn({ type: 'waiting' }), /Listening/);
  assert.match(voice.describeTurn({ type: 'speech' }), /Listening/);
  assert.match(voice.describeTurn({ type: 'pause' }), /pause/i);
  assert.match(voice.describeTurn({ type: 'end', reason: 'silence' }), /transcribing/i);
  assert.match(voice.describeTurn({ type: 'end', reason: 'no-speech' }), /did not hear/i);
  assert.match(voice.describeTurn({ type: 'ended', reason: 'max-length' }), /transcribing/i);

  assert.equal(voice.describeTurn(null), voice.TURN_LABELS.waiting, 'never render undefined at the user');
  assert.equal(voice.describeTurn({ type: 'nonsense' }), voice.TURN_LABELS.waiting);
});
