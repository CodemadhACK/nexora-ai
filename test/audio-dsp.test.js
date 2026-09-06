'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dsp = require('../audio-dsp');

// ---------------------------------------------------------------------------
// Signal generators — enough to stand in for a real microphone
// ---------------------------------------------------------------------------

const RATE = 48000;

function tone(freq, ms, amplitude = 0.5, rate = RATE, phase = 0) {
  const n = Math.round((rate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amplitude * Math.sin(phase + (2 * Math.PI * freq * i) / rate);
  return out;
}

/** Voiced speech is roughly periodic with harmonics — a few summed tones is close enough. */
function speech(ms, amplitude = 0.5, rate = RATE) {
  const n = Math.round((rate * ms) / 1000);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    out[i] = amplitude * (
      0.6 * Math.sin(2 * Math.PI * 140 * t) +
      0.3 * Math.sin(2 * Math.PI * 280 * t) +
      0.1 * Math.sin(2 * Math.PI * 560 * t)
    );
  }
  return out;
}

function noise(ms, amplitude = 0.002, rate = RATE, seed = 1) {
  const n = Math.round((rate * ms) / 1000);
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;      // deterministic, so tests do not flake
    out[i] = ((s / 0x7fffffff) * 2 - 1) * amplitude;
  }
  return out;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function mix(a, b) {
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = (a[i] || 0) + (b[i] || 0);
  return out;
}

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

test('DC offset is removed without touching the waveform', () => {
  const clean = tone(200, 100, 0.4);
  const biased = new Float32Array(clean.length);
  for (let i = 0; i < clean.length; i++) biased[i] = clean[i] + 0.3;

  const fixed = dsp.removeDcOffset(biased);
  let sum = 0;
  for (const v of fixed) sum += v;

  assert.ok(Math.abs(sum / fixed.length) < 1e-4, 'the mean should be back at zero');
  assert.ok(Math.abs(dsp.peakOf(fixed) - dsp.peakOf(clean)) < 0.01, 'and the shape unchanged');
});

test('a quiet clip is brought up to a usable level', () => {
  // 3% of full scale is the common case for a laptop mic, and it quantises to
  // almost nothing in 16-bit PCM.
  const quiet = tone(200, 200, 0.03);
  const loud = dsp.normalise(quiet);

  assert.ok(dsp.peakOf(quiet) < 0.04);
  assert.ok(dsp.peakOf(loud) > 0.85, `expected a normalised peak, got ${dsp.peakOf(loud)}`);
  assert.equal(loud.length, quiet.length);
});

test('normalising never exceeds full scale, and never amplifies silence into hiss', () => {
  assert.ok(dsp.peakOf(dsp.normalise(tone(200, 50, 0.99))) <= 1);

  const silence = noise(200, 0.00001);
  const boosted = dsp.normalise(silence);
  assert.ok(dsp.peakOf(boosted) < 0.01, 'a 20x cap keeps a silent room silent');
});

test('an already-loud clip is left alone', () => {
  const loud = tone(200, 100, 0.92);
  assert.equal(dsp.normalise(loud), loud, 'no copy, no work');
});

// ---------------------------------------------------------------------------
// Filtering and resampling
// ---------------------------------------------------------------------------

test('the low-pass keeps speech frequencies and rejects what is above it', () => {
  const passed = dsp.lowPass(tone(300, 200, 0.5), RATE, 7000);
  const stopped = dsp.lowPass(tone(15000, 200, 0.5), RATE, 7000);

  // Ignore the filter's settling time at the very start.
  const settle = (s) => s.slice(2000);
  assert.ok(dsp.rmsOf(settle(passed)) > 0.3, 'a 300 Hz tone must survive');
  assert.ok(dsp.rmsOf(settle(stopped)) < 0.02, 'a 15 kHz tone must not');
});

test('downsampling to 16 kHz gives the right length and keeps the tone', () => {
  const out = dsp.resample(tone(440, 500, 0.5), RATE, 16000);

  assert.ok(Math.abs(out.length - 8000) <= 2, `expected ~8000 samples, got ${out.length}`);
  assert.ok(dsp.rmsOf(out.slice(1000)) > 0.25, 'the signal should still be there');
});

test('downsampling filters first, so high frequencies cannot alias down', () => {
  // 14 kHz is above the 8 kHz Nyquist of the target rate. Decimating without a
  // filter would fold it down to 2 kHz and the transcriber would hear a tone
  // that was never spoken.
  const aliasing = dsp.resample(tone(14000, 400, 0.6), RATE, 16000);
  assert.ok(dsp.rmsOf(aliasing.slice(500)) < 0.05,
    `expected the 14 kHz tone to be filtered out, got RMS ${dsp.rmsOf(aliasing.slice(500))}`);
});

test('resampling to the same rate is a no-op', () => {
  const input = tone(300, 50);
  assert.equal(dsp.resample(input, RATE, RATE), input);
});

// ---------------------------------------------------------------------------
// Voice activity detection
// ---------------------------------------------------------------------------

test('speech in a quiet room is detected', () => {
  const clip = concat(noise(400), mix(speech(900, 0.4), noise(900)), noise(400));
  const analysis = dsp.analyse(clip, RATE);

  assert.equal(analysis.speech, true);
  assert.equal(analysis.silent, false);
  assert.ok(analysis.longestRunMs > 400, `expected a long voiced run, got ${analysis.longestRunMs}ms`);
  assert.ok(analysis.snrDb > 10, `expected a healthy SNR, got ${analysis.snrDb}`);
});

test('a silent clip is reported as silent, not as speech', () => {
  const analysis = dsp.analyse(noise(2000, 0.0005), RATE);

  assert.equal(analysis.speech, false);
  assert.equal(analysis.silent, true);
  assert.ok(analysis.peak < dsp.SILENT_PEAK);
});

test('room tone alone is not mistaken for speech', () => {
  // Loud enough to fail a naive "is it louder than nothing" check, but with no
  // structure — this is what an open mic in a busy office sounds like.
  const analysis = dsp.analyse(noise(2500, 0.05, RATE, 7), RATE);
  assert.equal(analysis.speech, false, 'broadband hiss must not read as speech');
});

test('a single click is not speech', () => {
  const clip = noise(1500, 0.001);
  for (let i = 20000; i < 20200; i++) clip[i] = 0.9;      // ~4ms transient

  const analysis = dsp.analyse(clip, RATE);
  assert.equal(analysis.speech, false, 'a keystroke is not a word');
  assert.ok(analysis.peak > 0.5, 'even though it is the loudest thing in the clip');
});

test('very quiet speech is still found, and flagged as quiet', () => {
  const clip = concat(noise(200, 0.0002), mix(speech(800, 0.03), noise(800, 0.0002)), noise(200, 0.0002));
  const analysis = dsp.analyse(clip, RATE);

  assert.equal(analysis.speech, true, 'the threshold is relative to the noise floor, not absolute');
  assert.equal(analysis.quiet, true);
  assert.equal(analysis.silent, false);
});

test('clipping is reported', () => {
  const clip = mix(speech(800, 0.6), noise(800));
  for (let i = 0; i < clip.length; i++) clip[i] = Math.max(-1, Math.min(1, clip[i] * 4));

  const analysis = dsp.analyse(clip, RATE);
  assert.equal(analysis.clipping, true);
  assert.ok(analysis.clippedRatio > 0.01);
});

test('silence around the speech is trimmed away', () => {
  const clip = concat(noise(1200), mix(speech(700, 0.4), noise(700)), noise(1200));
  const analysis = dsp.analyse(clip, RATE);
  const trimmed = dsp.trimToSpeech(clip, analysis);

  assert.ok(trimmed.length < clip.length * 0.75, 'most of the silence should be gone');
  assert.ok(trimmed.length > RATE * 0.6, 'but the speech itself must survive, with padding');
});

test('trimming leaves a clip with no speech untouched', () => {
  const clip = noise(800, 0.001);
  const analysis = dsp.analyse(clip, RATE);
  assert.equal(dsp.trimToSpeech(clip, analysis), clip);
});

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

test('the WAV header describes 16-bit mono PCM at the given rate', () => {
  const samples = tone(440, 100, 0.5, 16000);
  const view = new DataView(dsp.encodeWav(samples, 16000));
  const ascii = (off) => String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));

  assert.equal(ascii(0), 'RIFF');
  assert.equal(ascii(8), 'WAVE');
  assert.equal(ascii(12), 'fmt ');
  assert.equal(view.getUint16(20, true), 1, 'PCM');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16, 'bits per sample');
  assert.equal(ascii(36), 'data');
  assert.equal(view.getUint32(40, true), samples.length * 2);
  assert.equal(view.byteLength, 44 + samples.length * 2);
});

test('samples outside full scale are clamped rather than wrapped', () => {
  const view = new DataView(dsp.encodeWav(Float32Array.from([2, -2]), 16000));
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768, 'wrapping would turn a loud peak into a loud click');
});

// ---------------------------------------------------------------------------
// Non-speech transcripts — the bug that put "<noise>" in the conversation
// ---------------------------------------------------------------------------

test('the markers models use for "I heard nothing" are recognised', () => {
  for (const marker of [
    '<noise>', '[noise]', '(noise)', 'noise',
    '[inaudible]', '(inaudible)', '[INAUDIBLE]',
    '[silence]', '(silence)', '[BLANK_AUDIO]', '[no speech]',
    '[music]', '(background)', 'n/a', '...', '…', '   ', '', null, undefined,
    'No speech detected.', '(no intelligible speech)', '**[no audible speech]**',
    'The audio is silent.'
  ]) {
    assert.equal(dsp.isNonSpeech(marker), true, `${JSON.stringify(marker)} should be treated as nothing`);
  }
});

test('real speech is never mistaken for a marker', () => {
  for (const said of [
    'Explain the difference between a process and a thread',
    'What is the time complexity of quicksort?',
    'noise cancellation in audio pipelines',       // contains "noise", but is a question
    'Tell me about silence detection',
    'How do I fix this null pointer exception?',
    'a',
    'Yes.'
  ]) {
    assert.equal(dsp.isNonSpeech(said), false, `${JSON.stringify(said)} is a real transcript`);
  }
});

// ---------------------------------------------------------------------------
// The pipeline end to end
// ---------------------------------------------------------------------------

test('a realistic recording comes out trimmed, downsampled, normalised and marked as speech', () => {
  const raw = concat(noise(900, 0.002), mix(speech(1100, 0.05), noise(1100, 0.002)), noise(900, 0.002));
  const biased = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) biased[i] = raw[i] + 0.08;    // a DC offset, as some devices add

  const result = dsp.prepareForTranscription(biased, RATE);

  assert.equal(result.sampleRate, 16000);
  assert.equal(result.analysis.speech, true);
  assert.ok(result.trimmedMs > 800, `expected the silence to be cut, trimmed ${result.trimmedMs}ms`);
  assert.ok(result.durationMs > 900 && result.durationMs < 2400, `unexpected duration ${result.durationMs}ms`);
  assert.ok(dsp.peakOf(result.samples) > 0.8, 'the quiet speech should have been brought up');
  assert.equal(result.wav.byteLength, 44 + result.samples.length * 2);
});

test('the pipeline reports a silent recording rather than producing something to upload', () => {
  const result = dsp.prepareForTranscription(noise(2000, 0.0004), RATE);

  assert.equal(result.analysis.speech, false);
  assert.equal(result.analysis.silent, true);
  assert.match(dsp.describeProblem(result.analysis), /heard nothing/);
});

test('each unusable clip gets advice a person can act on', () => {
  const silent = dsp.analyse(noise(1200, 0.0003), RATE);
  assert.match(dsp.describeProblem(silent), /microphone is selected and unmuted/);

  const hiss = dsp.analyse(noise(2000, 0.05, RATE, 11), RATE);
  assert.ok(dsp.describeProblem(hiss), 'noise without speech should be reported too');

  const good = dsp.analyse(concat(noise(300), mix(speech(900, 0.4), noise(900)), noise(300)), RATE);
  assert.equal(dsp.describeProblem(good), null, 'a usable clip has nothing to complain about');
});

test('the pipeline copes with an empty or tiny clip without throwing', () => {
  for (const input of [new Float32Array(0), new Float32Array(8)]) {
    assert.doesNotThrow(() => dsp.prepareForTranscription(input, RATE));
  }
});

test('16 kHz input is not resampled but is still conditioned', () => {
  const clip = mix(speech(900, 0.04, 16000), noise(900, 0.001, 16000));
  const result = dsp.prepareForTranscription(clip, 16000);

  assert.equal(result.sampleRate, 16000);
  assert.ok(dsp.peakOf(result.samples) > 0.8, 'still normalised');
});
