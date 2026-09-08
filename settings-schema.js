/**
 * The settings shape, its defaults, and the migration from older builds.
 *
 * Split out of main.js so it can be tested without Electron — this is the code
 * that decides whether someone's configuration survives an upgrade, which is
 * exactly the code you want covered.
 */

'use strict';

const providers = require('./providers');
const prompts = require('./prompts');
const { HOTKEYS, isValidAccelerator } = require('./hotkeys');
const voice = require('./voice-turn');

const DEFAULT_AGENTS = [
  { provider: 'gemini', model: 'gemini-3.8-flash', temperature: 1.0 },
  { provider: 'openai', model: 'gpt-4.1-mini', temperature: 1.0 }
];

const DEFAULT_SETTINGS = {
  agents: DEFAULT_AGENTS,
  twoAgents: false,
  synthesis: true,
  suggestions: true,

  transcribeProvider: 'gemini',
  transcribeModel: 'gemini-3.5-transcribe',
  micDeviceId: null,          // null means whatever the OS calls the default

  // Hands-free voice. voiceAuto ends a turn on silence so nobody has to reach
  // for Stop mid-thought; the manual button stays regardless, because no
  // detector is right every time. continuousConversation reopens the mic once
  // an answer lands, for a back-and-forth rather than a series of questions.
  voiceAuto: true,
  voiceSilenceMs: voice.DEFAULTS.silenceMs,
  continuousConversation: false,

  persona: prompts.DEFAULT_PERSONA,
  historyLimit: 20,

  opacity: 1.0,
  alwaysOnTop: true,
  launchHidden: false,
  bounds: null,
  safeMode: false,

  // Presentation Mode. `presentationMode` and `presentationBounds` are state
  // rather than preferences — the renderer changes them through their own IPC
  // channel, because entering the mode has side effects a generic settings patch
  // has no business performing.
  presentationMode: false,
  presentationShortcut: HOTKEYS.PRESENTATION,
  presentationAutoEnter: false,
  presentationBounds: null,

  // Applies Windows content protection to Nexora's own window: it stays on your
  // monitor but is left out of screen shares and recordings that use supported
  // capture. State rather than a plain preference -- it has to be applied to a
  // live window -- so it travels on its own IPC channel, not a settings patch.
  hideFromScreenShare: false,

  screenCapturePrivacy: false,

  lastDisplayId: null,
  alwaysAskDisplay: true
};

/** Keys the renderer is allowed to change. Window bounds and safeMode are not among them. */
const SETTABLE = [
  'agents', 'twoAgents', 'synthesis', 'suggestions',
  'transcribeProvider', 'transcribeModel', 'micDeviceId',
  'voiceAuto', 'voiceSilenceMs', 'continuousConversation',
  'persona', 'historyLimit', 'opacity', 'alwaysOnTop', 'launchHidden',
  'presentationShortcut', 'presentationAutoEnter',
  'screenCapturePrivacy',
  'lastDisplayId', 'alwaysAskDisplay'
];

/**
 * Brings a settings file written by an older build up to the current shape.
 * Renaming the app moved its data folder, so the alternative to migrating is
 * silently resetting someone's model choice and persona — not acceptable for a
 * rename they did not ask for.
 */
function migrateSettings(raw) {
  const out = { ...raw };

  // Pre-3.0: a single `model` + `temperature` instead of an agent list.
  if (!Array.isArray(out.agents)) {
    out.agents = [
      {
        ...DEFAULT_AGENTS[0],
        model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_AGENTS[0].model,
        temperature: Number.isFinite(Number(raw.temperature)) ? Number(raw.temperature) : DEFAULT_AGENTS[0].temperature
      },
      { ...DEFAULT_AGENTS[1] }
    ];
  }

  // Pre-3.0: `systemPrompt` was the whole instruction; it is now just the persona.
  if (typeof out.persona !== 'string' && typeof raw.systemPrompt === 'string') {
    out.persona = raw.systemPrompt;
  }

  delete out.model;
  delete out.systemPrompt;
  delete out.temperature;
  return out;
}

function normaliseAgent(agent, fallback) {
  const base = { ...fallback, ...(agent || {}) };
  const provider = providers.hasProvider(base.provider) ? base.provider : fallback.provider;
  const temperature = Number(base.temperature);
  return {
    provider,
    // A model the user typed by hand is kept: new model ids ship faster than
    // this catalogue updates, and rejecting them would age badly.
    model: typeof base.model === 'string' && base.model.trim()
      ? base.model.trim()
      : providers.getProvider(provider).defaults.model,
    temperature: Number.isFinite(temperature) ? Math.min(2, Math.max(0, temperature)) : 1.0
  };
}

/** Clamps everything into range so a hand-edited file can't wedge the app. */
function normaliseSettings(input) {
  const merged = { ...DEFAULT_SETTINGS, ...input };
  const agents = Array.isArray(merged.agents) ? merged.agents : [];

  merged.agents = [
    normaliseAgent(agents[0], DEFAULT_AGENTS[0]),
    normaliseAgent(agents[1], DEFAULT_AGENTS[1])
  ];
  merged.historyLimit = Math.min(60, Math.max(2, Number(merged.historyLimit) || 20));
  merged.opacity = Math.min(1, Math.max(0.4, Number(merged.opacity) || 1));

  // Unknown, or known but with no speech-to-text to offer. The second case is
  // reachable by hand-editing the file, and it would otherwise fail at the
  // moment someone speaks rather than at the moment they configure it.
  const stt = providers.getProvider(merged.transcribeProvider);
  if (!providers.hasProvider(merged.transcribeProvider) || !(stt.transcribeModels || []).length) {
    merged.transcribeProvider = DEFAULT_SETTINGS.transcribeProvider;
    merged.transcribeModel = DEFAULT_SETTINGS.transcribeModel;
  }

  // The detector clamps this too, but a settings file is also what the UI reads
  // back, and a slider showing a value the microphone does not actually use is
  // its own kind of bug.
  merged.voiceSilenceMs = voice.normaliseVoiceOptions({ silenceMs: merged.voiceSilenceMs }).silenceMs;
  merged.voiceAuto = !!merged.voiceAuto;
  merged.continuousConversation = !!merged.continuousConversation;
  if (typeof merged.persona !== 'string' || !merged.persona.trim()) {
    merged.persona = DEFAULT_SETTINGS.persona;
  }

  // A shortcut that cannot be registered would leave the mode reachable only
  // from the tray, silently. Fall back rather than ship a dead key.
  if (!isValidAccelerator(merged.presentationShortcut)) {
    merged.presentationShortcut = DEFAULT_SETTINGS.presentationShortcut;
  }
  merged.presentationMode = !!merged.presentationMode;
  merged.presentationAutoEnter = !!merged.presentationAutoEnter;
  merged.presentationBounds = normaliseBounds(merged.presentationBounds);
  merged.hideFromScreenShare = !!merged.hideFromScreenShare;

  return merged;
}

/** Window geometry is only useful if every number is real. */
function normaliseBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const { x, y, width, height } = bounds;
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  if (width <= 0 || height <= 0) return null;
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** Parse → migrate → normalise, in the one order that is correct. */
function readSettings(rawText) {
  // trim() also removes a leading byte-order mark (JS counts U+FEFF as
  // whitespace). Without it, a file any editor saved as UTF-8-with-BOM makes
  // JSON.parse throw and every setting silently resets to its default —
  // including Safe Mode, and a privacy switch must never fail open in silence.
  return normaliseSettings(migrateSettings(JSON.parse(String(rawText).trim())));
}

module.exports = {
  DEFAULT_SETTINGS, DEFAULT_AGENTS, SETTABLE,
  migrateSettings, normaliseSettings, normaliseAgent, normaliseBounds, readSettings
};
