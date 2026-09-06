/**
 * Speech conditioning for the microphone path.
 *
 * Raw microphone float is a poor thing to hand a transcription model: it carries
 * a DC offset, it is usually far too quiet, most of the clip is silence around
 * the words, and nothing has checked whether anybody actually spoke. Every one
 * of those makes a model more likely to give up and answer "<noise>".
 *
 * So before a clip is uploaded it goes through: DC removal → voice activity
 * detection → trim to the speech → anti-aliased downsample to 16 kHz →
 * normalise. The detector's verdict is kept, so the app can say "I did not hear
 * anything" instead of paying for a round trip to be told the same thing.
 *
 * Deliberately no dependency and no WASM. A model-based VAD (Silero and friends)
 * would need `wasm-unsafe-eval` in the page's CSP, and the page is locked down to
 * `script-src 'self'` on purpose. Energy-plus-zero-crossing detection is well
 * understood, costs microseconds, and can be tested exactly.
 *
 * Loaded both as a plain script in the renderer (window.NexoraAudio) and with
 * require() in the main process and the tests.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NexoraAudio = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TARGET_RATE = 16000;      // what every speech model wants
  const FRAME_MS = 20;
  const HOP_MS = 10;

  // Below this peak, a clip is silence as far as any model is concerned.
  const SILENT_PEAK = 0.008;
  // Below this, there is a signal but it is very quiet and worth warning about.
  const QUIET_PEAK = 0.05;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // -------------------------------------------------------------------------
  // Basics
  // -------------------------------------------------------------------------

  /**
   * Removes the constant offset some capture chains add. It costs no quality and
   * it stops a biased signal from eating headroom when we normalise.
   */
  function removeDcOffset(samples) {
    if (!samples.length) return samples;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i];
    const mean = sum / samples.length;
    if (Math.abs(mean) < 1e-6) return samples;

    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = samples[i] - mean;
    return out;
  }

  function peakOf(samples) {
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    return peak;
  }

  function rmsOf(samples) {
    if (!samples.length) return 0;
    let sum = 0;
    for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Brings the loudest part up to `target`. Speech recorded at 3% of full scale
   * quantises to almost nothing in 16-bit PCM, which is a large part of why a
   * quiet microphone transcribes badly.
   */
  function normalise(samples, target = 0.92) {
    const peak = peakOf(samples);

    // Below the silence threshold there is nothing to bring up, and amplifying
    // would only raise the hiss. Above it, allow a large gain: speech at 3% of
    // full scale is ordinary for a laptop microphone and needs roughly 30x.
    if (peak <= SILENT_PEAK) return samples;

    const gain = Math.min(target / peak, 40);
    if (Math.abs(gain - 1) < 0.01) return samples;

    const out = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) out[i] = clamp(samples[i] * gain, -1, 1);
    return out;
  }

  // -------------------------------------------------------------------------
  // Anti-aliased resampling
  // -------------------------------------------------------------------------

  /**
   * One biquad low-pass, Direct Form I, run twice for a 4th-order roll-off.
   * Cheap enough to be free on a speech clip and steep enough to keep everything
   * above the new Nyquist out of the downsampled signal — decimating without it
   * folds high frequencies back down as aliasing, which is exactly the kind of
   * artefact that makes a transcriber hallucinate.
   */
  function lowPass(samples, sampleRate, cutoffHz, passes = 2) {
    if (cutoffHz >= sampleRate / 2) return samples;

    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cosW = Math.cos(w0);
    const alpha = Math.sin(w0) / Math.SQRT2;          // Q = 1/sqrt(2), Butterworth

    const a0 = 1 + alpha;
    const b0 = ((1 - cosW) / 2) / a0;
    const b1 = (1 - cosW) / a0;
    const b2 = b0;
    const a1 = (-2 * cosW) / a0;
    const a2 = (1 - alpha) / a0;

    let out = samples;
    for (let p = 0; p < passes; p++) {
      const next = new Float32Array(out.length);
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < out.length; i++) {
        const x0 = out[i];
        const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        next[i] = y0;
        x2 = x1; x1 = x0;
        y2 = y1; y1 = y0;
      }
      out = next;
    }
    return out;
  }

  /** Low-pass, then linear interpolation onto the new grid. */
  function resample(samples, fromRate, toRate) {
    if (fromRate === toRate || !samples.length) return samples;

    const filtered = toRate < fromRate
      ? lowPass(samples, fromRate, toRate * 0.45)
      : samples;

    const ratio = fromRate / toRate;
    const length = Math.max(1, Math.floor(samples.length / ratio));
    const out = new Float32Array(length);

    for (let i = 0; i < length; i++) {
      const at = i * ratio;
      const j = Math.floor(at);
      const frac = at - j;
      const a = filtered[j] || 0;
      const b = j + 1 < filtered.length ? filtered[j + 1] : a;
      out[i] = a + (b - a) * frac;
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Voice activity detection
  // -------------------------------------------------------------------------

  /**
   * Per-frame energy and zero-crossing rate. Energy alone calls a door slam
   * speech; the zero-crossing rate separates voiced speech (low) from hiss and
   * clicks (high), and the two together are a good deal more reliable than
   * either.
   */
  function frames(samples, sampleRate, frameMs = FRAME_MS, hopMs = HOP_MS) {
    const size = Math.max(1, Math.round((sampleRate * frameMs) / 1000));
    const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
    const count = samples.length < size ? 0 : Math.floor((samples.length - size) / hop) + 1;

    const rms = new Float32Array(count);
    const zcr = new Float32Array(count);

    for (let f = 0; f < count; f++) {
      const start = f * hop;
      let sum = 0;
      let crossings = 0;
      for (let i = 0; i < size; i++) {
        const v = samples[start + i];
        sum += v * v;
        if (i > 0 && ((v >= 0) !== (samples[start + i - 1] >= 0))) crossings++;
      }
      rms[f] = Math.sqrt(sum / size);
      zcr[f] = crossings / size;
    }
    return { rms, zcr, size, hop, count };
  }

  /** The quiet end of the frame energies — what the room sounds like. */
  function noiseFloorOf(rms) {
    if (!rms.length) return 0;
    const sorted = Float32Array.from(rms).sort();
    return sorted[Math.floor(sorted.length * 0.2)];
  }

  /**
   * Decides whether anybody spoke, and where.
   *
   * The threshold is relative to the measured noise floor rather than absolute,
   * so it adapts to a quiet room and to a noisy one instead of needing the user
   * to tune anything.
   */
  function analyse(samples, sampleRate, {
    minSpeechMs = 180,
    snrFactor = 2.6,
    maxZcr = 0.34
  } = {}) {
    const peak = peakOf(samples);
    const rms = rmsOf(samples);
    const durationMs = (samples.length / sampleRate) * 1000;

    let clipped = 0;
    for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i]) > 0.99) clipped++;
    const clippedRatio = samples.length ? clipped / samples.length : 0;

    const f = frames(samples, sampleRate);
    const noiseFloor = noiseFloorOf(f.rms);
    const threshold = Math.max(noiseFloor * snrFactor, SILENT_PEAK * 0.5);

    const voiced = new Uint8Array(f.count);
    let voicedFrames = 0;
    for (let i = 0; i < f.count; i++) {
      const isVoiced = f.rms[i] > threshold && f.zcr[i] < maxZcr;
      voiced[i] = isVoiced ? 1 : 0;
      if (isVoiced) voicedFrames++;
    }

    // A run long enough to be a word, not a cough or a keystroke.
    const minRun = Math.max(1, Math.round(minSpeechMs / HOP_MS));
    let bestRun = 0, run = 0, firstVoiced = -1, lastVoiced = -1;
    for (let i = 0; i < f.count; i++) {
      if (voiced[i]) {
        run++;
        if (run >= minRun) {
          if (firstVoiced < 0) firstVoiced = i - run + 1;
          lastVoiced = i;
        }
        if (run > bestRun) bestRun = run;
      } else {
        run = 0;
      }
    }

    const speech = bestRun >= minRun;
    const snrDb = noiseFloor > 1e-7 && rms > 1e-7 ? 20 * Math.log10(rms / noiseFloor) : 0;

    return {
      speech,
      durationMs,
      peak,
      rms,
      noiseFloor,
      snrDb,
      clippedRatio,
      voicedRatio: f.count ? voicedFrames / f.count : 0,
      longestRunMs: bestRun * HOP_MS,
      silent: peak < SILENT_PEAK,
      quiet: peak < QUIET_PEAK,
      clipping: clippedRatio > 0.01,
      // Sample offsets of the speech, with a little padding so words are not
      // clipped at the edges.
      startSample: firstVoiced < 0 ? 0 : Math.max(0, (firstVoiced * f.hop) - f.size * 5),
      endSample: lastVoiced < 0 ? samples.length
        : Math.min(samples.length, (lastVoiced * f.hop) + f.size * 6)
    };
  }

  /** Cuts the clip down to the speech, keeping the padding `analyse` worked out. */
  function trimToSpeech(samples, analysis) {
    if (!analysis.speech) return samples;
    const start = clamp(analysis.startSample, 0, samples.length);
    const end = clamp(analysis.endSample, start, samples.length);
    return end - start < 16 ? samples : samples.slice(start, end);
  }

  // -------------------------------------------------------------------------
  // WAV
  // -------------------------------------------------------------------------

  function encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

    str(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);              // PCM
    view.setUint16(22, 1, true);              // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    str(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let off = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = clamp(samples[i], -1, 1);
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
    return buffer;
  }

  // -------------------------------------------------------------------------
  // Non-speech transcripts
  // -------------------------------------------------------------------------

  /**
   * Every speech model has its own way of saying "there was nothing here", and
   * they are not empty strings — so without this check the marker is sent on as
   * the user's question, which is how you end up asking an assistant "<noise>".
   */
  const NON_SPEECH = [
    /^[\s.,!?-]*$/,
    /^[\[(<{]?\s*(noise|silence|inaudible|unintelligible|blank[_ ]?audio|no[_ ]speech|music|background|sound|null|empty|n\/a)\s*[\])>}]?[.\s]*$/i,
    /^\**\s*\(?no (intelligible )?speech( detected| present)?\)?\s*\**[.\s]*$/i,
    /^\**\s*\(?(there is )?(no|nothing) (audible|discernible)[^.]*\)?\s*\**[.\s]*$/i,
    /^\**\s*(the )?audio (is|contains|appears)[^.]*(silent|empty|no speech|inaudible)[^.]*\.?\s*\**$/i,
    /^\.{2,}$/,
    /^[…\s]+$/
  ];

  function isNonSpeech(text) {
    const trimmed = String(text == null ? '' : text).trim();
    if (!trimmed) return true;
    if (trimmed.length > 120) return false;      // a real sentence, whatever it says

    // Models wrap these markers in markdown and brackets in every combination,
    // so strip the decoration once rather than growing a regex for each variant.
    const bare = trimmed
      .replace(/^[\s*_`~]+|[\s*_`~]+$/g, '')
      .replace(/^[[({<]+|[\])}>]+$/g, '')
      .trim();

    return NON_SPEECH.some((re) => re.test(trimmed) || re.test(bare));
  }

  // -------------------------------------------------------------------------
  // The whole pipeline
  // -------------------------------------------------------------------------

  /**
   * Raw capture in, upload-ready 16 kHz WAV out, with the detector's verdict so
   * the caller can decide whether uploading is worth it at all.
   */
  function prepareForTranscription(samples, sampleRate, { targetRate = TARGET_RATE } = {}) {
    const centred = removeDcOffset(samples);
    const analysis = analyse(centred, sampleRate);

    const trimmed = trimToSpeech(centred, analysis);
    const downsampled = resample(trimmed, sampleRate, targetRate);
    const levelled = normalise(downsampled);

    return {
      samples: levelled,
      sampleRate: targetRate,
      wav: encodeWav(levelled, targetRate),
      analysis,
      durationMs: (levelled.length / targetRate) * 1000,
      trimmedMs: ((centred.length - trimmed.length) / sampleRate) * 1000
    };
  }

  /** One line for the status bar when a clip is not worth sending. */
  function describeProblem(analysis) {
    if (analysis.silent) {
      return 'I heard nothing at all — check that the right microphone is selected and unmuted.';
    }
    if (!analysis.speech) {
      return analysis.quiet
        ? 'That was too quiet to make out — move closer to the microphone, or turn its input level up.'
        : 'I could not find any speech in that — try again, a little closer to the microphone.';
    }
    return null;
  }

  return {
    TARGET_RATE, SILENT_PEAK, QUIET_PEAK, FRAME_MS, HOP_MS,
    removeDcOffset, normalise, peakOf, rmsOf,
    lowPass, resample,
    frames, noiseFloorOf, analyse, trimToSpeech,
    encodeWav, isNonSpeech, prepareForTranscription, describeProblem
  };
}));
