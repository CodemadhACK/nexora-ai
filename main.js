/**
 * Nexora AI — technical interview and problem-solving assistant.
 *
 * Main process: window and tray management, credential storage, display
 * capture, global hotkeys, and the agent runs.
 *
 * Every network call happens here rather than in the renderer, so an API key
 * never reaches page context. The renderer speaks the app's own neutral message
 * format and has no idea which vendor is behind it.
 */

const {
  app, BrowserWindow, globalShortcut, ipcMain, safeStorage,
  desktopCapturer, screen, Tray, Menu, shell, nativeImage, dialog
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const { createSafeMode } = require('./safe-mode');
const { createPresentationMode } = require('./presentation-mode');
const { createPresentationWatcher } = require('./presentation-watch');
const { buildTrayTemplate, trayTooltip } = require('./tray-menu');
const { HOTKEYS, createHotkeyManager, describe: describeHotkey } = require('./hotkeys');
const { TRAY_ICON_B64 } = require('./tray-icon');
const { createCredentials } = require('./credentials');
const { createDisplayCapture, needsPicker, boundsOnAnyDisplay } = require('./displays');
const audio = require('./audio-dsp');
const { createAgentRunner } = require('./agents');
const providers = require('./providers');
const { DEFAULT_SETTINGS, SETTABLE, normaliseSettings, readSettings } = require('./settings-schema');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEGACY_APP_DIR = 'ANGEL';       // the name this app shipped under before Nexora
const LEGACY_KEY_NAME = 'gemini';

const PROFILE_CHAR_LIMIT = 40000;   // ~10k tokens; well inside any model's window
const DEFAULT_PROFILE = { resume: '', projects: '', notes: '', enabled: true };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let tray = null;
let settings = { ...DEFAULT_SETTINGS };
let profile = { ...DEFAULT_PROFILE };
let safeMode = null;
let presentation = null;
let presentationWatcher = null;
let hotkeyManager = null;
let credentials = null;
let capture = null;
let runner = null;
let clickThrough = false;
let quitting = false;
let transcribeFallback = false;   // set once the dedicated STT model refuses us

const userDataDir = () => app.getPath('userData');
const settingsPath = () => path.join(userDataDir(), 'settings.json');
const profilePath = () => path.join(userDataDir(), 'profile.json');
const warn = (message) => console.warn(`[nexora] ${message}`);

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function loadSettings() {
  let raw = null;
  try {
    raw = fs.readFileSync(settingsPath(), 'utf8');
    settings = readSettings(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') warn(`settings.json unreadable (${err.message}) — using defaults.`);
    settings = normaliseSettings({});
  }

  // Write straight back when the file is missing or in an older shape, rather
  // than leaving a migrated config in memory only until the user happens to
  // move the window.
  if (raw === null || raw.trim() !== JSON.stringify(settings, null, 2)) saveSettings();
  return settings;
}

function saveSettings() {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    warn(`could not save settings: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Profile — résumé and project write-ups, injected as reference material
// ---------------------------------------------------------------------------

function loadProfile() {
  try {
    profile = { ...DEFAULT_PROFILE, ...JSON.parse(fs.readFileSync(profilePath(), 'utf8').trim()) };
  } catch {
    profile = { ...DEFAULT_PROFILE };
  }
  return profile;
}

function saveProfile() {
  try {
    fs.mkdirSync(userDataDir(), { recursive: true });
    fs.writeFileSync(profilePath(), JSON.stringify(profile, null, 2), 'utf8');
  } catch (err) {
    warn(`could not save profile: ${err.message}`);
  }
}

const profileSize = () =>
  (profile.resume || '').length + (profile.projects || '').length + (profile.notes || '').length;

/**
 * Files worth carrying over from the folder this app used before the rename.
 *
 * `Local State` is the non-obvious one and it is not optional. Chromium's
 * OSCrypt — which `safeStorage` is built on — keeps its master key inside that
 * file, protected by DPAPI. Copy the encrypted API key without it and the new
 * install generates a fresh master key, leaving the ciphertext permanently
 * unreadable and the user silently logged out of their own provider.
 */
const LEGACY_FILES = [
  'Local State',
  'settings.json',
  'profile.json',
  `${LEGACY_KEY_NAME}.key`,
  `${LEGACY_KEY_NAME}.key.plain`
];

/**
 * One-time carry-over from the pre-rename folder.
 *
 * Must run BEFORE the app is ready: OSCrypt reads `Local State` during startup,
 * so a copy made any later is already too late to matter. Individual files are
 * only ever copied into empty slots, so this can never overwrite live data.
 */
function migrateLegacyUserData() {
  try {
    const target = userDataDir();
    const legacyDir = path.join(path.dirname(target), LEGACY_APP_DIR);
    if (legacyDir === target || !fs.existsSync(legacyDir)) return;
    if (fs.existsSync(path.join(target, 'settings.json'))) return;   // already a real install

    fs.mkdirSync(target, { recursive: true });
    const carried = [];
    for (const name of LEGACY_FILES) {
      const from = path.join(legacyDir, name);
      const to = path.join(target, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) { fs.copyFileSync(from, to); carried.push(name); }
    }
    if (carried.length) console.log(`[nexora] carried over from the previous install: ${carried.join(', ')}`);
  } catch (err) {
    warn(`could not carry over previous settings: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Screen Share Safe Mode
//
// Purely local: it hides our own window and covers our own conversation. It
// touches no other application and no screen-capture API — see safe-mode.js.
// ---------------------------------------------------------------------------

/** Send on a channel only if there is still a live window listening. */
function sendToWindow(channel, payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function buildSafeMode() {
  return createSafeMode({
    initial: settings.safeMode,
    persist: (on) => { settings.safeMode = on; saveSettings(); },
    hideWindow: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide(); },
    notify: (on) => sendToWindow('state:safe-mode', on),
    refreshMenu: () => refreshTray(),
    log: warn
  });
}

// ---------------------------------------------------------------------------
// Presentation Mode
//
// Hides the window and takes it off the taskbar while you present, then puts it
// back exactly where it was. Local only: it touches no other application and no
// screen-capture API — see presentation-mode.js.
// ---------------------------------------------------------------------------

const liveWindow = () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null);

function buildPresentationMode() {
  return createPresentationMode({
    initial: settings.presentationMode,
    restore: settings.presentationBounds ? { bounds: settings.presentationBounds } : null,

    persist: (enabled, state) => {
      settings.presentationMode = enabled;
      if (state && state.bounds) settings.presentationBounds = state.bounds;
      saveSettings();
    },

    captureWindow: () => {
      const win = liveWindow();
      if (!win) return null;
      // Ask for the restored geometry: a maximized window reports the screen, and
      // restoring to that would lose the size the user actually chose.
      return { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    },

    hideWindow: () => {
      const win = liveWindow();
      if (!win) return;
      win.hide();
      win.setSkipTaskbar(true);      // out of the taskbar and alt-tab while presenting
    },

    showWindow: (state) => {
      const win = liveWindow();
      if (!win) return createWindow();

      win.setSkipTaskbar(false);

      // A monitor may have been unplugged while we were hidden; restoring to a
      // rectangle that no longer exists would put the window out of reach.
      const target = state && state.bounds && boundsOnAnyDisplay(state.bounds, screen.getAllDisplays())
        ? state.bounds
        : null;

      // Set before showing so it does not flash at the wrong place, then again
      // after: on a scaled display the first call rounds through physical pixels
      // and can land a pixel out, and "the same size" should mean the same size.
      if (target) win.setBounds(target);
      win.show();
      if (state && state.maximized) win.maximize();
      else if (target) win.setBounds(target);

      win.focus();
      win.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
      win.setOpacity(Number(settings.opacity) || 1);
    },

    notify: (on) => sendToWindow('state:presentation', on),
    refreshMenu: () => refreshTray(),
    log: warn
  });
}

/**
 * Starts or stops the fullscreen watcher to match the setting. It only ever
 * enters the mode on its own, and only undoes an entry it made itself — see
 * presentation-mode.js.
 */
function syncPresentationWatcher() {
  const wanted = !!settings.presentationAutoEnter;

  if (!wanted) {
    if (presentationWatcher) { presentationWatcher.stop(); presentationWatcher = null; }
    return { running: false, supported: process.platform === 'win32' };
  }
  if (presentationWatcher) return { running: presentationWatcher.isRunning(), supported: true };

  presentationWatcher = createPresentationWatcher({
    spawn,
    log: warn,
    onChange: (presenting, detail) => {
      if (presenting) {
        if (presentation.enable({ automatic: true })) {
          console.log(`[nexora] entered Presentation Mode automatically (${detail}).`);
        }
      } else {
        presentation.disable({ automatic: true });
      }
    }
  });

  if (!presentationWatcher.supported) {
    const supported = false;
    presentationWatcher = null;
    return { running: false, supported };
  }

  presentationWatcher.start();
  return { running: presentationWatcher.isRunning(), supported: true };
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function persistBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  settings.bounds = mainWindow.getBounds();
  saveSettings();
}

let boundsTimer = null;
function scheduleBoundsSave() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(persistBounds, 400);
}

function createWindow() {
  const saved = settings.bounds;
  const options = {
    width: saved?.width || 900,
    height: saved?.height || 660,
    minWidth: 520,
    minHeight: 320,
    transparent: true,
    frame: false,
    resizable: true,
    movable: true,
    hasShadow: false,
    alwaysOnTop: settings.alwaysOnTop,
    // Visible in the taskbar and alt-tab by design — Presentation Mode is the
    // one thing that takes it out, and only while it is on.
    skipTaskbar: !!settings.presentationMode,
    backgroundColor: '#00000000',
    show: false,
    title: 'Nexora AI',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
      // The window hides while a screenshot is taken and whenever it goes to the
      // tray, and a throttled renderer drops microphone samples on the floor —
      // the ScriptProcessor fallback runs its callback on the main thread. A
      // recording has to survive the window going away, so do not throttle.
      backgroundThrottling: false
    }
  };
  // Only restore position if it still lands on a connected display.
  if (boundsOnAnyDisplay(saved, screen.getAllDisplays())) {
    options.x = saved.x;
    options.y = saved.y;
  }

  mainWindow = new BrowserWindow(options);
  mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setOpacity(Number(settings.opacity) || 1);
  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    // Both modes have to win here: a window that appears and only then hides has
    // already been seen.
    const mayShow = !settings.launchHidden &&
                    safeMode.shouldShowAtLaunch() &&
                    presentation.shouldShowAtLaunch();
    if (mayShow) mainWindow.show();
  });

  mainWindow.on('resize', scheduleBoundsSave);
  mainWindow.on('move', scheduleBoundsSave);

  mainWindow.on('close', (e) => {
    if (!quitting) { e.preventDefault(); mainWindow.hide(); }  // close = hide to tray
  });

  // Links open in the real browser, never inside the overlay.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/** Plain show/hide, behind the tray icon click. */
function toggleWindow() {
  const win = liveWindow();
  if (!win) return createWindow();
  if (win.isVisible() && win.isFocused()) win.hide();
  else showAssistant();
}

/**
 * The one action guaranteed to get you back to the assistant, whatever mode is
 * on. It does not clear Presentation Mode — summoning the window for a moment
 * is a different intention from ending the presentation, and the header says
 * which mode is still active.
 */
function showAssistant() {
  const win = liveWindow();
  if (!win) return createWindow();
  win.setSkipTaskbar(false);
  win.show();
  win.focus();
}

function setClickThrough(enable) {
  clickThrough = !!enable;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setIgnoreMouseEvents(clickThrough, { forward: true });
    sendToWindow('state:click-through', clickThrough);
  }
  buildTrayMenu();   // the tray still reports state even with no window
}

/** Steps the window out of shot for a capture, and returns how to put it back. */
async function stepAside() {
  const wasVisible = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  if (!wasVisible) return async () => {};

  mainWindow.hide();
  await new Promise((r) => setTimeout(r, 220));
  return async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (safeMode.isEnabled()) return;      // Safe Mode outranks "put it back"
    mainWindow.showInactive();
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
  };
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

/** Redraws the menu and the tooltip together — they report the same thing. */
function refreshTray() {
  buildTrayMenu();
  if (tray && !tray.isDestroyed()) {
    tray.setToolTip(trayTooltip(
      safeMode ? safeMode.isEnabled() : false,
      presentation ? presentation.isEnabled() : false
    ));
  }
}

function buildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  const template = buildTrayTemplate(
    {
      presentation: presentation ? presentation.isEnabled() : false,
      presentationShortcut: settings.presentationShortcut,
      safeMode: safeMode ? safeMode.isEnabled() : false,
      clickThrough,
      alwaysOnTop: settings.alwaysOnTop,
      twoAgents: settings.twoAgents
    },
    {
      showAssistant,
      togglePresentation: () => presentation.toggle(),
      toggleSafeMode: () => safeMode.toggle(),
      toggleTwoAgents: () => {
        settings.twoAgents = !settings.twoAgents;
        saveSettings();
        sendToWindow('state:settings', settings);
        buildTrayMenu();
      },
      toggleClickThrough: () => setClickThrough(!clickThrough),
      toggleAlwaysOnTop: () => {
        settings.alwaysOnTop = !settings.alwaysOnTop;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
        }
        saveSettings();
        buildTrayMenu();
      },
      openSettings: () => {
        showAssistant();
        sendToWindow('ui:open-settings', true);
      },
      openDataFolder: () => shell.openPath(userDataDir()),
      quit: () => { quitting = true; app.quit(); }
    }
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_B64, 'base64'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.on('click', toggleWindow);
  refreshTray();
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

/**
 * Transcribes, and escalates rather than giving up.
 *
 * The models to try, in order: the one configured, then the provider's declared
 * transcription fallback. That fallback is deliberately a strong multimodal
 * model rather than the cheapest chat model — this used to reuse whatever agent 1
 * was set to, which on a budget configuration meant asking a flash-lite model to
 * do speech recognition, and it answered "<noise>" about as often as not.
 *
 * If the caller's voice detector heard speech but a model returns a non-speech
 * marker, that is a failure of the model rather than of the microphone, so it is
 * worth one attempt at the stronger one.
 */
async function transcribe(wavBase64, { hasSpeech = true } = {}) {
  const provider = providers.getProvider(settings.transcribeProvider);
  const apiKey = credentials.read(provider.id, provider);
  const fallbackModel = provider.defaults.transcribeFallback || provider.defaults.model;

  const chain = [];
  if (!transcribeFallback) chain.push(settings.transcribeModel);
  if (fallbackModel !== settings.transcribeModel || transcribeFallback) chain.push(fallbackModel);

  let lastError = null;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const text = await provider.transcribe({ apiKey, model, wavBase64 });
      const usable = text && !audio.isNonSpeech(text);

      if (usable) return { text, model };

      // Nothing usable. Only worth another model if we know there was speech.
      if (!hasSpeech || i === chain.length - 1) return { text: text || '', model };
      warn(`${model} heard nothing in a clip that contained speech — retrying with ${chain[i + 1]}.`);
    } catch (err) {
      if (err.code === providers.NO_API_KEY) throw err;
      lastError = err;
      // A model that is not on this key's tier will fail every time; stop
      // reaching for it rather than paying the latency on every recording.
      if (model === settings.transcribeModel) transcribeFallback = true;
      warn(`transcription with ${model} failed: ${err.message}`);
    }
  }

  if (lastError) throw lastError;
  return { text: '', model: chain[chain.length - 1] };
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('settings:get', () => settings);

  ipcMain.handle('settings:set', (_e, patch) => {
    for (const key of SETTABLE) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, key)) settings[key] = patch[key];
    }
    settings = normaliseSettings(settings);
    // Picking a different transcription model deserves a fresh try.
    if (patch && 'transcribeModel' in patch) transcribeFallback = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setOpacity(Number(settings.opacity) || 1);
      mainWindow.setAlwaysOnTop(settings.alwaysOnTop, 'screen-saver');
    }
    saveSettings();
    buildTrayMenu();
    return settings;
  });

  ipcMain.handle('providers:list', () => providers.listProviders());

  ipcMain.handle('profile:get', () => ({ ...profile, size: profileSize(), limit: PROFILE_CHAR_LIMIT }));

  ipcMain.handle('profile:set', (_e, patch) => {
    for (const k of ['resume', 'projects', 'notes', 'enabled']) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, k)) {
        profile[k] = k === 'enabled' ? !!patch[k] : String(patch[k] ?? '').slice(0, PROFILE_CHAR_LIMIT);
      }
    }
    saveProfile();
    return { ...profile, size: profileSize(), limit: PROFILE_CHAR_LIMIT };
  });

  ipcMain.handle('profile:import', async (_e, field) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import text',
      properties: ['openFile'],
      filters: [
        { name: 'Text', extensions: ['txt', 'md', 'markdown', 'json', 'csv'] },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (canceled || !filePaths?.length) return { ok: false, canceled: true };

    try {
      if (fs.statSync(filePaths[0]).size > 2 * 1024 * 1024) {
        return { ok: false, error: 'That file is over 2 MB — paste the relevant part instead.' };
      }
      let text = fs.readFileSync(filePaths[0], 'utf8');
      // Reject binary-looking input (a .docx or .pdf renamed, say).
      if (/[\u0000-\u0008\u000E-\u001F]/.test(text.slice(0, 4000))) {
        return {
          ok: false,
          error: 'That looks like a binary file. Open the PDF or Word document, select all, and paste the text in directly.'
        };
      }
      text = text.replace(/\r\n/g, '\n').trim().slice(0, PROFILE_CHAR_LIMIT);
      return { ok: true, field, text, name: path.basename(filePaths[0]) };
    } catch (err) {
      return { ok: false, error: `Could not read that file: ${err.message}` };
    }
  });

  // --- credentials --------------------------------------------------------

  ipcMain.handle('key:status', (_e, providerId) => {
    if (providerId) return credentials.status(providerId, providers.getProvider(providerId));
    return providers.PROVIDERS.map((p) => credentials.status(p.id, p));
  });

  ipcMain.handle('key:set', (_e, { provider: providerId, key }) => {
    const provider = providers.getProvider(providerId);
    credentials.store(provider.id, typeof key === 'string' ? key.trim() : '');
    return credentials.status(provider.id, provider);
  });

  ipcMain.handle('key:clear', (_e, providerId) => {
    const provider = providers.getProvider(providerId);
    credentials.store(provider.id, '');
    return credentials.status(provider.id, provider);
  });

  // --- the agent run ------------------------------------------------------

  ipcMain.handle('ask:send', async (event, { requestId, messages, question, hasScreenshot }) => {
    const sender = event.sender;
    const agents = settings.twoAgents
      ? [toAgentConfig(settings.agents[0]), toAgentConfig(settings.agents[1])]
      : [toAgentConfig(settings.agents[0])];

    try {
      return await runner.run({
        requestId,
        messages,
        question,
        agents,
        persona: settings.persona,
        profile,
        hasScreenshot: !!hasScreenshot,
        wantSynthesis: settings.twoAgents && settings.synthesis !== false,
        wantSuggestions: settings.suggestions !== false,
        onEvent: (payload) => {
          if (!sender.isDestroyed()) sender.send('run:event', { requestId, ...payload });
        }
      });
    } catch (err) {
      warn(`run failed: ${err.message}`);
      return { ok: false, error: err.message, answers: {}, suggestions: [] };
    }
  });

  ipcMain.handle('ask:stop', (_e, requestId) => runner.stop(requestId));

  ipcMain.handle('transcribe', async (_e, wavBase64, meta = {}) => {
    try {
      const { text, model } = await transcribe(wavBase64, meta);
      return { ok: true, text, model };
    } catch (err) {
      return { ok: false, error: err.message, needsKey: err.code === providers.NO_API_KEY };
    }
  });

  // --- displays -----------------------------------------------------------

  ipcMain.handle('displays:list', () => {
    const list = capture.list();
    return {
      displays: list,
      needsPicker: needsPicker(list, {
        remembered: settings.lastDisplayId,
        alwaysAsk: settings.alwaysAskDisplay !== false
      })
    };
  });

  // Deliberately does NOT hide the window first, unlike a real capture: the
  // picker is on screen while these load, and hiding to build a thumbnail would
  // make the window the user is looking at flicker. Seeing Nexora in one
  // thumbnail is a hint about which monitor it is on, not a defect.
  ipcMain.handle('displays:previews', () => capture.previews({ width: 260 }));

  ipcMain.handle('capture:display', async (_e, displayId) => {
    try {
      const shot = await capture.capture(displayId ?? settings.lastDisplayId);
      if (shot.display) {
        settings.lastDisplayId = shot.display.id;
        saveSettings();
      }
      return { ok: true, ...shot };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // --- window / shell -----------------------------------------------------

  ipcMain.handle('safe-mode:get', () => safeMode.isEnabled());
  ipcMain.handle('safe-mode:set', (_e, enabled) => safeMode.set(enabled));
  ipcMain.handle('safe-mode:toggle', () => safeMode.toggle());

  // --- Presentation Mode --------------------------------------------------
  // Its own channels rather than settings:set, because entering the mode moves
  // and hides a window — side effects a generic settings patch has no business
  // performing.

  const presentationState = () => ({
    enabled: presentation.isEnabled(),
    shortcut: settings.presentationShortcut,
    shortcutLabel: describeHotkey(settings.presentationShortcut),
    autoEnter: !!settings.presentationAutoEnter,
    autoSupported: process.platform === 'win32',
    autoRunning: !!(presentationWatcher && presentationWatcher.isRunning()),
    restore: presentation.restoreState()
  });

  ipcMain.handle('presentation:get', () => presentationState());
  ipcMain.handle('presentation:set', (_e, enabled) => { presentation.set(enabled); return presentationState(); });
  ipcMain.handle('presentation:toggle', () => { presentation.toggle(); return presentationState(); });

  ipcMain.handle('presentation:shortcut', (_e, accelerator) => {
    const probe = hotkeyManager.probe(accelerator);
    if (!probe.ok) return { ok: false, error: probe.reason, ...presentationState() };

    settings.presentationShortcut = accelerator;
    settings = normaliseSettings(settings);
    saveSettings();
    registerShortcuts();     // releases the old accelerator before taking the new one
    refreshTray();
    return { ok: true, ...presentationState() };
  });

  ipcMain.handle('presentation:auto', (_e, enabled) => {
    settings.presentationAutoEnter = !!enabled;
    saveSettings();
    const watcher = syncPresentationWatcher();
    return {
      ok: watcher.supported || !settings.presentationAutoEnter,
      error: watcher.supported ? null : 'Automatic Presentation Mode needs Windows.',
      ...presentationState()
    };
  });

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:hide', () => mainWindow?.hide());
  ipcMain.handle('window:quit', () => { quitting = true; app.quit(); });
  ipcMain.handle('window:click-through', (_e, enable) => { setClickThrough(enable); return clickThrough; });

  ipcMain.handle('shell:open', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('export:markdown', async (_e, markdown) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export conversation',
      defaultPath: path.join(app.getPath('documents'), `nexora-${Date.now()}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(filePath, markdown, 'utf8');
      return { ok: true, filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

const toAgentConfig = (agent) => ({
  providerId: agent.provider,
  model: agent.model,
  temperature: agent.temperature
});

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

/**
 * Push-to-talk and screenshot normally bring the window forward so you can see
 * what happened. Under Presentation Mode they must not: popping the assistant up
 * mid-presentation is the exact thing the mode exists to prevent. The renderer is
 * alive either way, so the recording still happens and the capture still lands in
 * the composer — it is simply waiting for you when you come back.
 */
function summon(channel) {
  return () => {
    const win = liveWindow();
    if (!win) return;
    if (!presentation.isEnabled()) {
      if (!win.isVisible()) win.show();
      win.focus();
    }
    sendToWindow(channel, true);
  };
}

function currentBindings() {
  return {
    [settings.presentationShortcut]: () => presentation.toggle(),
    [HOTKEYS.TALK]:          summon('hotkey:talk'),
    [HOTKEYS.SCREENSHOT]:    summon('hotkey:screenshot'),
    [HOTKEYS.CLICK_THROUGH]: () => setClickThrough(!clickThrough)
  };
}

function registerShortcuts() {
  const results = hotkeyManager.apply(currentBindings());
  const failed = results.filter((r) => !r.ok);
  if (failed.length) sendToWindow('state:hotkeys', failed);
  return results;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Before ready, deliberately — see migrateLegacyUserData.
  migrateLegacyUserData();

  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  });

  app.whenReady().then(() => {
    loadSettings();
    loadProfile();

    credentials = createCredentials({ fs, safeStorage, dir: userDataDir, log: warn });
    credentials.adoptLegacyKey(LEGACY_KEY_NAME, 'gemini');

    capture = createDisplayCapture({ screen, desktopCapturer, hideWindow: stepAside, log: warn });
    runner = createAgentRunner({
      readKey: (providerId) => credentials.read(providerId, providers.getProvider(providerId)),
      log: warn
    });

    // Both modes are built before any window exists, so launch respects them.
    safeMode = buildSafeMode();
    presentation = buildPresentationMode();
    hotkeyManager = createHotkeyManager(globalShortcut, warn);

    registerIpc();
    createWindow();
    createTray();
    registerShortcuts();
    syncPresentationWatcher();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else mainWindow?.show();
    });
  });
}

app.on('before-quit', () => {
  quitting = true;
  runner?.stopAll();
  presentationWatcher?.stop();
  persistBounds();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* stays alive in the tray */ });
