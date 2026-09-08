'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_SETTINGS, DEFAULT_AGENTS, SETTABLE,
  migrateSettings, normaliseSettings, readSettings
} = require('../settings-schema');
const prompts = require('../prompts');
const voice = require('../voice-turn');

/** Exactly what the previous single-provider build wrote. */
const LEGACY_FILE = {
  model: 'gemini-3.5-flash-lite',
  transcribeModel: 'gemini-3.5-transcribe',
  temperature: 2,
  systemPrompt: 'You are ANGEL, a fast and friendly desktop assistant.',
  opacity: 1,
  alwaysOnTop: true,
  launchHidden: true,
  bounds: { x: 2252, y: -60, width: 760, height: 580 },
  historyLimit: 60,
  safeMode: false
};

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test('an upgraded config keeps the model, temperature and persona the user chose', () => {
  const settings = normaliseSettings(migrateSettings(LEGACY_FILE));

  assert.equal(settings.agents[0].provider, 'gemini');
  assert.equal(settings.agents[0].model, 'gemini-3.5-flash-lite', 'their model choice must survive the rename');
  assert.equal(settings.agents[0].temperature, 2);
  assert.match(settings.persona, /^You are ANGEL/, 'their edited prompt becomes the persona');
});

test('an upgraded config keeps the rest of the window and history preferences', () => {
  const settings = normaliseSettings(migrateSettings(LEGACY_FILE));

  assert.equal(settings.historyLimit, 60);
  assert.equal(settings.launchHidden, true);
  assert.equal(settings.alwaysOnTop, true);
  assert.deepEqual(settings.bounds, LEGACY_FILE.bounds);
  assert.equal(settings.transcribeModel, 'gemini-3.5-transcribe');
});

test('migration gives the new install a sensible second agent', () => {
  const settings = normaliseSettings(migrateSettings(LEGACY_FILE));

  assert.equal(settings.agents.length, 2);
  assert.deepEqual(settings.agents[1], DEFAULT_AGENTS[1]);
  assert.equal(settings.twoAgents, false, 'two-agent mode is opt-in, not sprung on an upgrader');
});

test('the retired keys are dropped rather than left to rot', () => {
  const migrated = migrateSettings(LEGACY_FILE);
  for (const dead of ['model', 'systemPrompt', 'temperature']) {
    assert.equal(dead in migrated, false, `${dead} should not survive migration`);
  }
});

test('migrating an already-current config changes nothing', () => {
  const current = normaliseSettings({});
  assert.deepEqual(normaliseSettings(migrateSettings(current)), current);
});

test('a legacy file with no model at all still lands on a working default', () => {
  const settings = normaliseSettings(migrateSettings({ opacity: 0.8 }));
  assert.equal(settings.agents[0].model, DEFAULT_AGENTS[0].model);
  assert.equal(settings.agents[0].temperature, 1.0);
  assert.equal(settings.persona, prompts.DEFAULT_PERSONA);
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

test('an unknown provider falls back without losing the rest of the agent', () => {
  const settings = normaliseSettings({ agents: [{ provider: 'anthropi', model: 'x', temperature: 0.5 }] });
  assert.equal(settings.agents[0].provider, 'gemini');
  assert.equal(settings.agents[0].temperature, 0.5);
});

test('a hand-typed model id is kept, because catalogues lag reality', () => {
  const settings = normaliseSettings({ agents: [{ provider: 'openai', model: 'gpt-6-turbo-preview' }] });
  assert.equal(settings.agents[0].model, 'gpt-6-turbo-preview');
});

test('out-of-range numbers are clamped rather than trusted', () => {
  const settings = normaliseSettings({
    agents: [{ provider: 'gemini', temperature: 99 }, { provider: 'openai', temperature: -4 }],
    historyLimit: 5000,
    opacity: 0.01
  });

  assert.equal(settings.agents[0].temperature, 2);
  assert.equal(settings.agents[1].temperature, 0);
  assert.equal(settings.historyLimit, 60);
  assert.equal(settings.opacity, 0.4);
});

test('garbage in the agents field cannot wedge the app', () => {
  for (const agents of [null, 'nope', [], [{}], [null, null], 42]) {
    const settings = normaliseSettings({ agents });
    assert.equal(settings.agents.length, 2);
    assert.ok(settings.agents.every((a) => a.provider && a.model && Number.isFinite(a.temperature)));
  }
});

test('an empty persona falls back to the built-in one', () => {
  assert.equal(normaliseSettings({ persona: '   ' }).persona, prompts.DEFAULT_PERSONA);
  assert.equal(normaliseSettings({ persona: null }).persona, prompts.DEFAULT_PERSONA);
  assert.equal(normaliseSettings({ persona: 'You are Ada.' }).persona, 'You are Ada.');
});

test('an unknown transcription provider falls back', () => {
  assert.equal(normaliseSettings({ transcribeProvider: 'nope' }).transcribeProvider, 'gemini');
  assert.equal(normaliseSettings({ transcribeProvider: 'openai' }).transcribeProvider, 'openai');
});

// ---------------------------------------------------------------------------
// Reading from disk
// ---------------------------------------------------------------------------

test('a UTF-8 BOM does not silently reset every setting', () => {
  const withBom = String.fromCharCode(0xfeff) + JSON.stringify(LEGACY_FILE);
  const settings = readSettings(withBom);
  assert.equal(settings.agents[0].model, 'gemini-3.5-flash-lite');
  assert.equal(settings.historyLimit, 60);
});

test('unparseable JSON throws, so the caller can log it and fall back deliberately', () => {
  assert.throws(() => readSettings('{ not json'));
});

// ---------------------------------------------------------------------------
// The settable allowlist
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Presentation Mode settings
// ---------------------------------------------------------------------------

test('Presentation Mode ships off, on Ctrl+Shift+Space, with auto-entry off', () => {
  const settings = normaliseSettings({});
  assert.equal(settings.presentationMode, false);
  assert.equal(settings.presentationShortcut, 'CommandOrControl+Shift+Space');
  assert.equal(settings.presentationAutoEnter, false, 'automatic entry must be opt-in');
  assert.equal(settings.presentationBounds, null);
});

test('the mode, its shortcut and its geometry all persist', () => {
  const stored = {
    presentationMode: true,
    presentationShortcut: 'CommandOrControl+Alt+P',
    presentationAutoEnter: true,
    presentationBounds: { x: 320, y: 180, width: 900, height: 660 }
  };
  const settings = readSettings(JSON.stringify(stored));

  assert.equal(settings.presentationMode, true);
  assert.equal(settings.presentationShortcut, 'CommandOrControl+Alt+P');
  assert.equal(settings.presentationAutoEnter, true);
  assert.deepEqual(settings.presentationBounds, stored.presentationBounds);
});

test('an unusable shortcut falls back instead of leaving a dead key', () => {
  for (const bad of ['Space', 'Shift', '', null, 42, 'Ctrl+']) {
    assert.equal(normaliseSettings({ presentationShortcut: bad }).presentationShortcut,
      'CommandOrControl+Shift+Space', `${JSON.stringify(bad)} should not survive`);
  }
});

test('nonsense geometry is dropped rather than restored to', () => {
  for (const bad of [{ x: 1, y: 2 }, { x: NaN, y: 0, width: 8, height: 8 },
                     { x: 0, y: 0, width: 0, height: 100 }, 'somewhere', null]) {
    assert.equal(normaliseSettings({ presentationBounds: bad }).presentationBounds, null);
  }
  assert.deepEqual(
    normaliseSettings({ presentationBounds: { x: 1.4, y: 2.6, width: 800.2, height: 600.9 } }).presentationBounds,
    { x: 1, y: 3, width: 800, height: 601 }
  );
});

test('a config from before Presentation Mode existed gains the defaults', () => {
  const settings = normaliseSettings(migrateSettings(LEGACY_FILE));
  assert.equal(settings.presentationMode, false);
  assert.equal(settings.presentationAutoEnter, false);
  assert.equal(settings.presentationShortcut, 'CommandOrControl+Shift+Space');
  assert.equal(settings.historyLimit, 60, 'and keeps everything it already had');
});

test('the renderer can change the shortcut and auto-entry, but not the mode itself', () => {
  // Entering the mode moves and hides a window; that goes through its own
  // channel, not a generic settings patch.
  assert.ok(SETTABLE.includes('presentationShortcut'));
  assert.ok(SETTABLE.includes('presentationAutoEnter'));
  assert.ok(!SETTABLE.includes('presentationMode'));
  assert.ok(!SETTABLE.includes('presentationBounds'));
});

/**
 * Screen Share Privacy is the one feature in Nexora that genuinely hides the app
 * from other people, so the two things worth pinning down are that nobody gets
 * it without asking, and that it cannot be switched on by a generic settings
 * patch -- it has to go through the channel that actually applies it to a live
 * window, where the result is reported back honestly.
 */
test('Screen Share Privacy is off until someone turns it on', () => {
  assert.equal(DEFAULT_SETTINGS.hideFromScreenShare, false);
  assert.equal(normaliseSettings({}).hideFromScreenShare, false);
  assert.equal(normaliseSettings(migrateSettings(LEGACY_FILE)).hideFromScreenShare, false,
    'an upgrade must never switch concealment on for someone');
});

test('force stop is off by default and survives a restart once set', () => {
  // It is persisted deliberately: the user said "until I click it again", and a
  // restart is not a click. A kill switch that forgets itself is worse than none.
  assert.equal(DEFAULT_SETTINGS.forceStop, false);
  assert.ok(SETTABLE.includes('forceStop'));
  assert.equal(normaliseSettings({ forceStop: 'on' }).forceStop, true);
  assert.equal(normaliseSettings({ forceStop: undefined }).forceStop, false);
});

test('hiding the taskbar button is off by default and is an ordinary preference', () => {
  // Unlike the capture switch, this one has no state to reconcile -- it is a
  // window property like always-on-top, so it travels the normal settings path.
  assert.equal(DEFAULT_SETTINGS.hideFromTaskbar, false);
  assert.ok(SETTABLE.includes('hideFromTaskbar'));
  assert.equal(normaliseSettings({ hideFromTaskbar: 'yes' }).hideFromTaskbar, true);
  assert.equal(normaliseSettings({}).hideFromTaskbar, false);
});

test('Screen Share Privacy cannot be flipped through settings:set', () => {
  assert.ok(!SETTABLE.includes('hideFromScreenShare'));
});

test('a hand-edited hideFromScreenShare is coerced to a real boolean', () => {
  assert.equal(normaliseSettings({ hideFromScreenShare: 'yes' }).hideFromScreenShare, true);
  assert.equal(normaliseSettings({ hideFromScreenShare: 0 }).hideFromScreenShare, false);
  assert.equal(normaliseSettings({ hideFromScreenShare: null }).hideFromScreenShare, false);
});

test('system audio is recorded alongside the microphone by default', () => {
  // A mic-only recording captures you and silence where everyone else was,
  // which is the wrong half of a meeting.
  assert.equal(DEFAULT_SETTINGS.captureSystemAudio, true);
  assert.ok(SETTABLE.includes('captureSystemAudio'), 'it is an ordinary preference with no side effects');
  assert.equal(normaliseSettings({ captureSystemAudio: 'no' }).captureSystemAudio, true);
  assert.equal(normaliseSettings({ captureSystemAudio: 0 }).captureSystemAudio, false);
});

test('the renderer cannot reach window bounds or Safe Mode through settings:set', () => {
  // Safe Mode has its own channel because flipping it has side effects; bounds
  // are owned by the window. Neither belongs in a generic settings patch.
  assert.ok(!SETTABLE.includes('safeMode'));
  assert.ok(!SETTABLE.includes('bounds'));
});

test('every settable key is a real setting', () => {
  for (const key of SETTABLE) {
    assert.ok(key in DEFAULT_SETTINGS, `${key} is settable but not a known setting`);
  }
});

// ---------------------------------------------------------------------------
// Hands-free voice
// ---------------------------------------------------------------------------

test('hands-free voice ships on, with the manual controls still present', () => {
  const s = DEFAULT_SETTINGS;
  assert.equal(s.voiceAuto, true, 'the point of the feature is not having to press Stop');
  assert.equal(s.continuousConversation, false, 'a mic that reopens itself is opt-in');
  assert.equal(typeof s.voiceSilenceMs, 'number');
});

test('the renderer may change the voice settings, since they all live in its UI', () => {
  for (const key of ['voiceAuto', 'voiceSilenceMs', 'continuousConversation']) {
    assert.ok(SETTABLE.includes(key), `${key} would be silently ignored`);
  }
});

/**
 * A settings file is hand-editable, and a silence threshold of zero would end
 * every turn on its first batch — an unusable microphone with no error to
 * explain it.
 */
test('a hand-edited silence threshold is clamped to something usable', () => {
  assert.equal(normaliseSettings({ voiceSilenceMs: 0 }).voiceSilenceMs, voice.LIMITS.silenceMs[0]);
  assert.equal(normaliseSettings({ voiceSilenceMs: 1e9 }).voiceSilenceMs, voice.LIMITS.silenceMs[1]);
  assert.equal(normaliseSettings({ voiceSilenceMs: 'soon' }).voiceSilenceMs, voice.DEFAULTS.silenceMs);
  assert.equal(normaliseSettings({}).voiceSilenceMs, voice.DEFAULTS.silenceMs);
});

test('the voice switches survive a file that wrote them as strings', () => {
  const s = normaliseSettings({ voiceAuto: 'yes', continuousConversation: 0 });
  assert.equal(s.voiceAuto, true);
  assert.equal(s.continuousConversation, false);
});

/** An older settings file predates all of this and must still open. */
test('a settings file from before hands-free voice picks up the defaults', () => {
  const old = readSettings(JSON.stringify({ model: 'gemini-2.0-flash', historyLimit: 8 }));
  assert.equal(old.voiceAuto, true);
  assert.equal(old.voiceSilenceMs, voice.DEFAULTS.silenceMs);
  assert.equal(old.continuousConversation, false);
  assert.equal(old.historyLimit, 8, 'and must not lose what it did set');
});
