/**
 * Nexora renderer — UI, screenshot flow, microphone capture, conversation state.
 *
 * No API key ever reaches this file and it knows nothing about any AI vendor.
 * It speaks the app's neutral message format over the narrow bridge in
 * preload.js; the main process decides which provider answers.
 */

'use strict';

const api = window.nexora;
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

const stage        = $('stage');
const input        = $('input');
const statusText   = $('status-text');
const statusBar    = $('status');
const levelBar     = $('level');
const levelFill    = levelBar.firstElementChild;
const levelSysBar  = $('level-sys');
const levelSysFill = levelSysBar.firstElementChild;
const voicebar     = $('voicebar');
const voiceHint    = $('voice-hint');
const btnSend      = $('btn-send');
const btnMic       = $('btn-mic');
const btnShot      = $('btn-shot');
const btnAgents    = $('btn-agents');
const settingsPane = $('settings');
const pickerPane   = $('picker');
const keyBadge     = $('key-badge');
const ctBanner     = $('clickthrough-banner');
const safeScreen   = $('safe-mode-screen');
const safeToggle   = $('set-safe-mode');
const shotbar      = $('shotbar');
const pmChip       = $('btn-presentation');
const fsChip       = $('btn-forcestop');
const pmToggle     = $('set-presentation');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let settings = null;
let profile = null;
let providerList = [];
let history = [];            // { role, parts, text, imageDataUrl }
let pendingShot = null;      // { dataBase64, mimeType, display, dataUrl }

// The last thing heard, so a screenshot taken just afterwards can be tied to it.
let lastTranscript = { text: '', at: 0 };
// Long enough to cover reading a problem off the screen and reaching for the
// capture key; short enough that yesterday's question never gets attached.
const TRANSCRIPT_LINK_MS = 5 * 60 * 1000;
let run = null;              // active run: { requestId, panes: Map, turn }
let presentation = null;     // { enabled, shortcut, shortcutLabel, autoEnter, ... }
let busy = false;
let recording = false;
let recordingShortcut = false;

let micStream = null, audioCtx = null, procNode = null, srcNode = null, sinkNode = null;
let sysStream = null, sysNode = null, sysGain = null, micGain = null, mixNode = null;
let micAnalyser = null, micBuf = null;
let sysAnalyser = null, sysBuf = null;
// Loudest system audio seen during this recording. The turn detector cannot
// see it, so this is what tells us whether anything was said at all.
let sysPeak = 0;
// Above digital silence and the odd interface blip, below any real speech.
const SYSTEM_AUDIO_FLOOR = 0.01;
let pcmChunks = [], pcmLength = 0;

const providerById = (id) => providerList.find((p) => p.id === id) || providerList[0];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function setStatus(text, kind) {
  statusText.textContent = text;
  statusBar.className = kind || '';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function scrollDown(force) {
  const nearBottom = stage.scrollHeight - stage.scrollTop - stage.clientHeight < 160;
  if (force || nearBottom) stage.scrollTop = stage.scrollHeight;
}

const bytes = (n) => (n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/**
 * Minimal, dependency-free markdown → HTML. Model output is escaped before any
 * of it is treated as markup, so a response cannot inject HTML.
 *
 * Fenced blocks are lifted out first and parked behind NUL sentinels — a
 * character that cannot occur in model output — then restored at the end, so
 * the inline rules never run over code.
 */
function renderMarkdown(src) {
  const NUL = String.fromCharCode(0);
  const blocks = [];

  let text = String(src).replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    const i = blocks.length;
    blocks.push(
      `<div class="code-block"><button class="copy" type="button">Copy</button>` +
      `<pre data-lang="${escapeHtml(lang || '')}"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre></div>`
    );
    return `${NUL}BLOCK${i}${NUL}`;
  });

  text = escapeHtml(text);

  text = text.replace(/`([^`\n]+)`/g, (_m, c) => `<code>${c}</code>`);
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" data-external="1">$1</a>');
  text = text.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>')
             .replace(/^##\s+(.+)$/gm, '<h2>$1</h2>')
             .replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');

  const lines = text.split('\n');
  let html = '', list = null, para = [];
  const flushPara = () => { if (para.length) { html += `<p>${para.join('<br>')}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `</${list}>`; list = null; } };

  const blockLine = new RegExp(`^${NUL}BLOCK\\d+${NUL}$`);

  for (const line of lines) {
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { flushList(); html += `<${want}>`; list = want; }
      html += `<li>${(ul || ol)[1]}</li>`;
    } else if (/^<h[123]>/.test(line) || blockLine.test(line)) {
      flushPara(); flushList(); html += line;
    } else if (line.trim() === '') {
      flushPara(); flushList();
    } else {
      para.push(line);
    }
  }
  flushPara(); flushList();

  return html.replace(new RegExp(`${NUL}BLOCK(\\d+)${NUL}`, 'g'), (_m, i) => blocks[Number(i)]);
}

stage.addEventListener('click', (e) => {
  const copy = e.target.closest('.copy');
  if (copy) {
    const code = copy.parentElement.querySelector('code');
    navigator.clipboard.writeText(code.textContent).then(() => {
      copy.textContent = 'Copied';
      setTimeout(() => { copy.textContent = 'Copy'; }, 1400);
    });
    return;
  }
  const link = e.target.closest('a[data-external]');
  if (link) { e.preventDefault(); api.openExternal(link.getAttribute('href')); }

  const suggestion = e.target.closest('.suggestion');
  if (suggestion) ask({ text: suggestion.dataset.prompt || suggestion.textContent });
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

const STARTERS = [
  'Explain the difference between a process and a thread',
  'Give me a system design answer for a URL shortener',
  'Ask me a medium-difficulty DSA question',
  'How do I explain a project failure in an interview?'
];

function renderEmptyState() {
  stage.innerHTML = `
    <div class="empty">
      <h2>Capture the problem. Get the whole answer.</h2>
      <div class="lede">
        Screenshot a coding question, an error, a system-design prompt or an interview
        question. Nexora reads it and answers with the reasoning, the code, the complexity
        and how to say it out loud.
      </div>
      <div class="starters">
        ${STARTERS.map((s, i) => `<button class="suggestion" data-i="${i}" type="button">${escapeHtml(s)}</button>`).join('')}
      </div>
      <div class="grid">
        <span>Capture a screenshot</span><kbd>Ctrl+Shift+S</kbd>
        <span>Push to talk</span><kbd>Ctrl+Shift+A</kbd>
        <span>Presentation Mode</span><kbd>${escapeHtml(presentation ? presentation.shortcutLabel : 'Ctrl+Shift+Space')}</kbd>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Turn rendering
// ---------------------------------------------------------------------------

const PILL = {
  working:   'Working…',
  status:    'Waiting…',
  streaming: 'Streaming',
  done:      'Done',
  error:     'Failed'
};

function agentLabel(index) {
  const agent = settings.agents[index];
  const provider = providerById(agent.provider);
  return `${provider ? provider.label : agent.provider} · ${agent.model}`;
}

function makePane({ slot, name, model, extraClass = '' }) {
  const pane = document.createElement('div');
  pane.className = `pane ${extraClass}`.trim();
  pane.dataset.slot = String(slot);

  const head = document.createElement('div');
  head.className = 'pane-head';
  head.innerHTML =
    `<span class="pane-name">${escapeHtml(name)}</span>` +
    `<span class="pane-model">${escapeHtml(model || '')}</span>` +
    `<span class="pill working"><i></i>Working…</span>`;

  const body = document.createElement('div');
  body.className = 'pane-body';
  body.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';

  pane.append(head, body);
  return { pane, body, pill: head.querySelector('.pill') };
}

function setPaneState(entry, state, text) {
  if (!entry) return;
  const known = PILL[state] ? state : 'working';
  entry.pill.className = `pill ${known}`;
  entry.pill.innerHTML = `<i></i>${escapeHtml(text || PILL[known])}`;
  entry.pane.classList.toggle('failed', state === 'error');
}

/** Builds the DOM for one exchange and returns the handles the run writes into. */
function addTurn({ text, imageDataUrl }) {
  const empty = stage.querySelector('.empty');
  if (empty) empty.remove();

  const turn = document.createElement('div');
  turn.className = 'turn';

  const ask = document.createElement('div');
  ask.className = 'ask';
  ask.innerHTML = `<div class="who">You</div>`;
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (imageDataUrl) {
    const img = document.createElement('img');
    img.src = imageDataUrl;
    img.alt = 'Screenshot sent with this message';
    bubble.appendChild(img);
  }
  const said = document.createElement('div');
  said.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
  bubble.appendChild(said);
  ask.appendChild(bubble);

  const panes = document.createElement('div');
  panes.className = `panes${settings.twoAgents ? ' dual' : ''}`;

  const entries = new Map();
  const first = makePane({ slot: 1, name: settings.twoAgents ? 'Agent 1' : 'Nexora', model: agentLabel(0) });
  panes.appendChild(first.pane);
  entries.set('1', first);

  if (settings.twoAgents) {
    const second = makePane({ slot: 2, name: 'Agent 2', model: agentLabel(1) });
    panes.appendChild(second.pane);
    entries.set('2', second);
  }

  const followups = document.createElement('div');
  followups.className = 'followups';

  turn.append(ask, panes, followups);
  stage.appendChild(turn);
  scrollDown(true);

  return { turn, panes, entries, followups, raw: new Map() };
}

function ensureSynthesisPane(view) {
  if (view.entries.has('synthesis')) return view.entries.get('synthesis');
  const entry = makePane({
    slot: 'synthesis', name: 'Combined insight',
    model: 'agreement · differences · what to watch', extraClass: 'full synthesis'
  });
  view.panes.appendChild(entry.pane);
  view.entries.set('synthesis', entry);
  scrollDown();
  return entry;
}

function renderSuggestions(view, items) {
  view.followups.innerHTML = '';
  if (!items || !items.length) return;

  const label = document.createElement('div');
  label.className = 'label';
  label.textContent = 'They may ask next';
  view.followups.appendChild(label);

  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion';
    button.dataset.prompt = item;
    button.textContent = item;
    view.followups.appendChild(button);
  }
  scrollDown();
}

// ---------------------------------------------------------------------------
// Running a turn
// ---------------------------------------------------------------------------

function setBusy(on) {
  busy = on;
  btnSend.classList.toggle('stop', on);
  btnSend.title = on ? 'Stop' : 'Send';
  btnShot.disabled = on;
  btnMic.disabled = on;
}

function buildContext() {
  const limit = Math.max(2, Number(settings.historyLimit) || 20);
  return history.slice(-limit).map(({ role, parts }) => ({ role, parts }));
}

/** Throttled markdown re-render — one paint per frame budget, not per token. */
function scheduleRender(view, slot) {
  const entry = view.entries.get(slot);
  if (!entry || entry.pending) return;
  entry.pending = setTimeout(() => {
    entry.pending = null;
    entry.body.innerHTML = renderMarkdown(view.raw.get(slot) || '');
    scrollDown();
  }, 60);
}

function flushRender(view, slot) {
  const entry = view.entries.get(slot);
  if (!entry) return;
  clearTimeout(entry.pending);
  entry.pending = null;
  const text = view.raw.get(slot) || '';
  if (text) entry.body.innerHTML = renderMarkdown(text);
}

function onRunEvent(payload) {
  if (!run || payload.requestId !== run.requestId) return;
  const view = run.view;

  if (payload.type === 'chunk') {
    const slot = String(payload.slot);
    const entry = view.entries.get(slot);
    if (!entry) return;
    if (!entry.started) { entry.started = true; entry.body.innerHTML = ''; }
    view.raw.set(slot, (view.raw.get(slot) || '') + payload.delta);
    scheduleRender(view, slot);
    return;
  }

  if (payload.type === 'agent') {
    const slot = String(payload.slot);
    const entry = view.entries.get(slot);
    if (!entry) return;                 // a pane for a slot this turn never rendered
    if (payload.state === 'done') {
      flushRender(view, slot);
      const text = view.raw.get(slot) || payload.text || '';
      if (!text) entry.body.textContent = payload.aborted ? '(stopped)' : '(no response)';
      setPaneState(entry, 'done', payload.aborted ? 'Stopped' : 'Done');
    } else if (payload.state === 'error') {
      entry.body.textContent = payload.error;
      setPaneState(entry, 'error');
      if (payload.needsKey) openSettings();
    } else if (payload.state === 'status') {
      setPaneState(entry, 'working', payload.text);
    } else {
      setPaneState(entry, payload.state);
    }
    updateRunStatus();
    return;
  }

  if (payload.type === 'synthesis') {
    const entry = ensureSynthesisPane(view);
    if (payload.state === 'done') {
      flushRender(view, 'synthesis');
      if (!view.raw.get('synthesis')) entry.body.textContent = payload.text || '(no comparison)';
      setPaneState(entry, 'done');
    } else if (payload.state === 'error') {
      entry.body.textContent = payload.error;
      setPaneState(entry, 'error');
    } else {
      setPaneState(entry, payload.state);
    }
    updateRunStatus();
    return;
  }

  if (payload.type === 'suggestions') {
    renderSuggestions(view, payload.items);
  }
}

/** Turns per-pane states into the one line at the bottom of the window. */
function updateRunStatus() {
  if (!run) return;
  const states = [...run.view.entries.entries()]
    .map(([slot, entry]) => [slot, entry.pill.className.replace('pill ', '')]);

  const working = states.filter(([slot, s]) => slot !== 'synthesis' && (s === 'working' || s === 'streaming'));
  const synthesis = states.find(([slot]) => slot === 'synthesis');

  if (synthesis && (synthesis[1] === 'working' || synthesis[1] === 'streaming')) {
    setStatus('Comparing answers…');
  } else if (working.length) {
    setStatus(settings.twoAgents
      ? `${working.map(([slot]) => `Agent ${slot}`).join(' · ')} working…`
      : 'Working…');
  }
}

/** The most recent transcript, if it is recent enough to still be the subject. */
function recentTranscript() {
  if (!lastTranscript.text) return '';
  if (Date.now() - lastTranscript.at > TRANSCRIPT_LINK_MS) return '';
  return lastTranscript.text;
}

/**
 * What to ask when a screenshot is sent with nothing typed.
 *
 * "What is on this screen? Answer it." was actively wrong for the way this app
 * gets used. Someone asks a question out loud, it is transcribed, and then the
 * screen is captured because the problem is sitting on it — at which point
 * describing the screen answers a question nobody asked. When something was
 * heard a moment ago, the screenshot is evidence for that question, so ask that
 * one and point at the screen as where to look.
 */
function screenshotQuestion() {
  const heard = recentTranscript();
  if (!heard) return 'What is on this screen? Answer it.';
  return `The question that was just asked out loud was: "${heard}"\n\n` +
         'Answer that question, using what is on this screen. If the screen shows a ' +
         'different problem from the one asked, say so and answer what is on the screen.';
}

async function ask({ text, shot }) {
  if (busy) return;

  const attached = shot || pendingShot;
  const trimmed = (text || '').trim();
  if (!trimmed && !attached) return;

  const parts = [];
  if (attached) parts.push({ type: 'image', mime: attached.mimeType, data: attached.dataBase64 });
  const question = trimmed || screenshotQuestion();
  parts.push({ type: 'text', text: question });

  history.push({ role: 'user', parts, text: question, imageDataUrl: attached ? attached.dataUrl : null });

  const view = addTurn({ text: question, imageDataUrl: attached ? attached.dataUrl : null });
  clearShot();
  input.value = '';
  autoGrow();

  const requestId = `r${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  run = { requestId, view };
  setBusy(true);
  setStatus(attached ? 'Analyzing screenshot…' : 'Thinking…');

  let result;
  try {
    result = await api.ask.send({
      requestId,
      messages: buildContext(),
      question,
      hasScreenshot: !!attached
    });
  } catch (err) {
    result = { ok: false, error: err.message, answers: {} };
  }

  setBusy(false);
  const finished = run;
  run = null;

  if (!result || (!result.ok && !Object.keys(result.answers || {}).length)) {
    const entry = finished.view.entries.get('1');
    entry.body.textContent = result?.error || 'Something went wrong.';
    setPaneState(entry, 'error');
    setStatus(result?.error || 'Request failed.', 'error');
    history.pop();                      // don't poison the context with a failed turn
    return;
  }

  // Agent 1 carries the conversation; if it failed but agent 2 answered, that
  // answer becomes the thread instead of losing the turn entirely.
  const primary = result.answers?.[1];
  const secondary = result.answers?.[2];
  const answer = (primary && primary.ok && primary.text) || (secondary && secondary.ok && secondary.text) || '';

  if (answer) {
    history.push({ role: 'assistant', parts: [{ type: 'text', text: answer }], text: answer });
  } else {
    history.pop();
  }

  setStatus(result.aborted ? 'Stopped.' : 'Ready.');
  scrollDown();
}

api.on('run:event', onRunEvent);

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

function clearShot() {
  pendingShot = null;
  shotbar.classList.remove('show');
}

function showShot(shot) {
  pendingShot = shot;
  $('shot-thumb').src = shot.dataUrl;
  const display = shot.display;
  $('shot-detail').textContent = [
    display ? `${display.label} · ${display.detail}` : 'Captured',
    bytes(shot.bytes || 0),
    shot.mimeType === 'image/jpeg' ? 'JPEG' : 'PNG'
  ].filter(Boolean).join(' · ');
  shotbar.classList.add('show');

  // While the mic is live this screenshot is not waiting on the composer — it
  // rides along with whatever is being said — so do not ask for an Enter that
  // would cut the recording short, and do not pull focus out from under it.
  if (recording) {
    input.placeholder = 'Still listening… this screenshot goes with what you say.';
  } else {
    input.placeholder = recentTranscript()
      ? 'Enter answers what was just asked, using this screenshot…'
      : 'Ask about this screenshot… (Enter sends it)';
    input.focus();
  }
}

/**
 * A capture never interrupts the microphone. The window steps aside for a moment
 * to stay out of shot, which backgrounds this renderer, but the recording keeps
 * running and only the user ends it — the shot simply waits in the composer and
 * goes up with whatever the recording turns into.
 */
async function captureDisplay(displayId) {
  const listening = recording;
  setStatus(listening ? 'Capturing… still listening.' : 'Capturing…');

  const shot = await api.displays.capture(displayId ?? null);
  if (!shot.ok) {
    setStatus(shot.error, 'error');
    await resumeMic();               // a failed capture must not cost the recording either
    return null;
  }

  shot.dataUrl = `data:${shot.mimeType};base64,${shot.dataBase64}`;
  showShot(shot);

  if (listening) {
    await resumeMic();
    setStatus(listeningStatus(), 'recording');
  } else {
    setStatus('Screenshot ready — ask about it, or press Enter.');
  }
  return shot;
}

/**
 * With two or more displays connected, guessing is wrong about half the time on
 * a normal desk — so we ask, unless the user has told us to stop asking.
 */
async function startCapture() {
  if (busy) return;
  try {
    const { displays, needsPicker } = await api.displays.list();
    if (!displays.length) { setStatus('No displays detected.', 'error'); return; }
    if (displays.length === 1) return captureDisplay(displays[0].id);
    if (!needsPicker) return captureDisplay(settings.lastDisplayId);
    return openPicker(displays);
  } catch (err) {
    setStatus(`Could not read your displays: ${err.message}`, 'error');
  }
}

async function openPicker(displays) {
  const grid = $('display-grid');
  $('picker-remember').checked = settings.alwaysAskDisplay === false;

  const render = (list) => {
    grid.innerHTML = '';
    for (const d of list) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'display-card';
      card.dataset.id = d.id;

      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      if (d.preview) thumb.style.backgroundImage = `url("${d.preview}")`;
      else thumb.textContent = String(d.index);

      const name = document.createElement('b');
      name.textContent = `${d.label}${d.primary ? ' — Primary' : ''}`;
      const detail = document.createElement('span');
      detail.textContent = d.detail;

      card.append(thumb, name, detail);
      if (String(settings.lastDisplayId) === d.id) {
        const last = document.createElement('span');
        last.className = 'last';
        last.textContent = 'Last used';
        card.appendChild(last);
      }
      grid.appendChild(card);
    }
  };

  render(displays);
  pickerPane.classList.add('open');

  // Previews take a beat and need the window out of the way; the picker is
  // already usable from the text descriptions while they load.
  api.displays.previews()
    .then((withPreviews) => { if (pickerPane.classList.contains('open')) render(withPreviews); })
    .catch(() => { /* text-only picker is fine */ });
}

function closePicker() { pickerPane.classList.remove('open'); }

$('display-grid').addEventListener('click', async (e) => {
  const card = e.target.closest('.display-card');
  if (!card) return;
  const remember = $('picker-remember').checked;
  closePicker();
  if (remember && settings.alwaysAskDisplay !== false) await patch({ alwaysAskDisplay: false });
  await captureDisplay(card.dataset.id);
});

$('btn-close-picker').onclick = closePicker;
$('btn-recapture').onclick = () => { clearShot(); startCapture(); };
$('btn-discard-shot').onclick = () => {
  clearShot();
  input.placeholder = 'Ask anything, or capture a screenshot of the problem…';
  setStatus('Screenshot discarded.');
};

// ---------------------------------------------------------------------------
// Microphone
//
// Capture happens on the audio thread through an AudioWorklet, so a busy UI
// cannot punch holes in the recording. The clip is then conditioned by
// audio-dsp.js — trimmed to the speech, downsampled and normalised — and only
// uploaded if there was actually something to hear.
// ---------------------------------------------------------------------------

const dsp = window.NexoraAudio;
const vad = window.NexoraVoice;
const MAX_RECORD_SECONDS = 120;

let captureNode = null;
let usingWorklet = false;

// Automatic turn detection. Null when the user has switched it off, in which
// case the microphone behaves exactly as it always did — a manual toggle.
let turnDetector = null;
let turnPhase = null;

function toBase64(arrayBuffer) {
  const view = new Uint8Array(arrayBuffer);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, view.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** One place every captured batch arrives, whichever node produced it. */
/**
 * RMS of the microphone alone.
 *
 * The recording carries the microphone and the system mix together, but this
 * number must not: it drives the level meter, which answers "is my mic
 * working", and the end-of-turn detector, which answers "have I stopped
 * speaking". Neither question is about the other person. Feed the detector the
 * mix instead and a call with music or a colleague talking never falls silent,
 * so the turn never ends and the recording runs to the hard cap.
 */
function micLevel(chunk) {
  if (micAnalyser && micBuf) {
    micAnalyser.getFloatTimeDomainData(micBuf);
    let sum = 0;
    for (let i = 0; i < micBuf.length; i += 8) sum += micBuf[i] * micBuf[i];
    return Math.sqrt(sum / Math.max(1, micBuf.length / 8));
  }
  let sum = 0;
  for (let i = 0; i < chunk.length; i += 8) sum += chunk[i] * chunk[i];
  return Math.sqrt(sum / Math.max(1, chunk.length / 8));
}

function onSamples(chunk) {
  if (!recording) return;
  pcmChunks.push(chunk);
  pcmLength += chunk.length;

  // The system meter is display only. It must never reach the turn detector:
  // that decides when you have stopped speaking, and the other side of a call
  // does not get a vote.
  if (sysAnalyser && sysBuf) {
    sysAnalyser.getFloatTimeDomainData(sysBuf);
    let sysSum = 0;
    for (let i = 0; i < sysBuf.length; i += 8) sysSum += sysBuf[i] * sysBuf[i];
    const sysRms = Math.sqrt(sysSum / Math.max(1, sysBuf.length / 8));
    if (sysRms > sysPeak) sysPeak = sysRms;
    levelSysFill.style.width = `${Math.min(100, sysRms * 320)}%`;
  }

  const level = micLevel(chunk);
  levelFill.style.width = `${Math.min(100, level * 320)}%`;
  levelFill.style.background = level < 0.01 ? 'var(--bad)' : level > 0.6 ? 'var(--warn)' : 'var(--good)';

  const rate = audioCtx ? audioCtx.sampleRate : dsp.TARGET_RATE;
  if (pcmLength > rate * MAX_RECORD_SECONDS) { stopRecording(); return; }

  // The detector is fed the batch's own duration rather than a clock reading:
  // the audio thread knows how much sound it actually captured, and the main
  // thread may be behind a render.
  if (turnDetector) onTurnEvent(turnDetector.push(level, (chunk.length / rate) * 1000));
}

/**
 * One DOM write per phase change rather than per batch — the phases last whole
 * seconds and the status line rewriting ten times a second reads as flicker.
 */
function onTurnEvent(event) {
  if (event.type === 'ended') return;
  if (event.type === 'end') { turnPhase = null; endTurn(event); return; }
  if (event.type === turnPhase) return;
  turnPhase = event.type;
  setStatus(listeningStatus(event), 'recording');
}

/**
 * A turn the detector closed on its own. Silence means a finished question, so
 * it goes; an open microphone nobody spoke into is thrown away rather than sent
 * as an empty request the user would still be charged for.
 *
 * The exception is the whole point of recording system audio. The detector only
 * ever hears the microphone, so "no speech" means "you did not speak" — not
 * "nothing was said". Sitting quietly while an interviewer asks a question is
 * the normal case, and discarding on mic silence threw away exactly the
 * recording that was wanted. When the system side carried something, it goes to
 * the same analysis as any other clip, which still refuses to pay for an upload
 * of silence.
 */
function endTurn(event) {
  if (event.reason === 'no-speech' && sysPeak < SYSTEM_AUDIO_FLOOR) {
    discardRecording();
    setStatus(vad.describeTurn(event));
    return;
  }
  if (event.reason === 'no-speech') {
    setStatus('You did not speak, but the call did — transcribing that.', 'recording');
    stopRecording();
    return;
  }
  setStatus(vad.describeTurn(event), 'recording');
  stopRecording();
}

/**
 * Prefers the worklet. If it cannot be loaded — an old runtime, a CSP that
 * refuses the module — it falls back to the deprecated ScriptProcessor rather
 * than losing the microphone altogether, and says so in the console.
 */
/**
 * The system output mix, if the platform will give it to us. Main answers the
 * getDisplayMedia request with `audio: 'loopback'`; no video is asked for or
 * returned, so this starts no screen capture.
 */
async function getSystemAudio() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false });
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach((track) => track.stop());
      return null;
    }
    return stream;
  } catch (err) {
    // Never fatal. Half a conversation is worth more than none, so this degrades
    // to a microphone recording and says so rather than refusing to record.
    setStatus(`System audio unavailable — recording the microphone only: ${err.message}`, 'error');
    return null;
  }
}

/**
 * Microphone and system audio summed into one mono signal for the recording.
 *
 * Summing is what Web Audio does when two sources meet at one node, so there is
 * no mixing code here — only the channel settings that make it mono, because
 * the worklet reads input[0][0] and would otherwise transcribe the left half of
 * a stereo system feed and nothing else.
 */
async function buildMixGraph() {
  mixNode = audioCtx.createGain();
  mixNode.channelCount = 1;
  mixNode.channelCountMode = 'explicit';
  mixNode.channelInterpretation = 'speakers';

  micGain = audioCtx.createGain();
  micGain.gain.value = 1;
  srcNode.connect(micGain);
  micGain.connect(mixNode);

  micAnalyser = audioCtx.createAnalyser();
  micAnalyser.fftSize = 2048;
  micBuf = new Float32Array(micAnalyser.fftSize);
  micGain.connect(micAnalyser);

  if (!settings.captureSystemAudio) return;

  sysStream = await getSystemAudio();
  if (!sysStream) return;

  sysNode = audioCtx.createMediaStreamSource(sysStream);
  sysGain = audioCtx.createGain();
  // Under unity on purpose: playback is usually louder than a voice a metre
  // from the microphone, and the two are summed before being written as 16-bit
  // samples, where the sum has nowhere left to go.
  sysGain.gain.value = 0.7;
  sysNode.connect(sysGain);
  sysGain.connect(mixNode);

  sysAnalyser = audioCtx.createAnalyser();
  sysAnalyser.fftSize = 2048;
  sysBuf = new Float32Array(sysAnalyser.fftSize);
  sysGain.connect(sysAnalyser);
}

async function attachCapture() {
  try {
    await audioCtx.audioWorklet.addModule('audio-worklet.js');
    captureNode = new AudioWorkletNode(audioCtx, 'nexora-capture', {
      numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { batchSize: 2048 }
    });
    captureNode.port.onmessage = (event) => onSamples(event.data);
    mixNode.connect(captureNode);
    usingWorklet = true;
    return;
  } catch (err) {
    console.warn('[nexora] AudioWorklet unavailable, falling back to ScriptProcessor:', err.message);
  }

  usingWorklet = false;
  procNode = audioCtx.createScriptProcessor(4096, 1, 1);
  sinkNode = audioCtx.createGain();
  sinkNode.gain.value = 0;                  // keep the graph alive without playback
  procNode.onaudioprocess = (e) => onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
  mixNode.connect(procNode);
  procNode.connect(sinkNode);
  sinkNode.connect(audioCtx.destination);
}

/** What the status bar says while the mic is live, given the turn's phase and any shot waiting. */
function listeningStatus(event) {
  let base;
  if (event && event.type === 'pause') base = 'Listening… (pause)';
  else if (turnDetector) base = 'Listening… I will send when you stop talking.';
  else base = 'Listening… click the mic or press Ctrl+Shift+A to stop.';

  return pendingShot ? `${base} The screenshot goes with what you say.` : base;
}

/**
 * Hiding the window for a capture backgrounds the renderer, and a backgrounded
 * renderer is allowed to suspend its AudioContext. Nothing else in the app
 * interrupts a recording, so this is the one place that has to put it back —
 * silently when it worked, loudly when it did not, because a mic that has
 * quietly stopped listening is the worst version of this bug.
 */
async function resumeMic() {
  if (!recording || !audioCtx) return;
  try {
    if (audioCtx.state === 'suspended') await audioCtx.resume();
  } catch (err) {
    setStatus(`The microphone stopped during the capture: ${err.message}`, 'error');
  }
}

async function startRecording() {
  if (recording || busy) return;
  if (settings.forceStop) {
    setStatus('Force stop is on — click it in the header to start listening again.');
    return;
  }
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(settings.micDeviceId ? { deviceId: { exact: settings.micDeviceId } } : {})
      }
    });
  } catch (err) {
    setStatus(`Microphone unavailable: ${err.message}`, 'error');
    return;
  }

  // The context runs at whatever rate the device actually gives us. Forcing
  // 16 kHz here makes the driver resample, which is a known source of glitching
  // on Windows — audio-dsp.js downsamples afterwards, with a proper filter.
  audioCtx = new AudioContext();
  if (audioCtx.state === 'suspended') await audioCtx.resume();

  srcNode = audioCtx.createMediaStreamSource(micStream);
  await buildMixGraph();
  pcmChunks = []; pcmLength = 0;
  sysPeak = 0;
  await attachCapture();

  recording = true;
  turnPhase = null;
  turnDetector = settings.voiceAuto
    ? vad.createTurnDetector({ silenceMs: settings.voiceSilenceMs })
    : null;

  btnMic.classList.add('rec');
  levelBar.style.display = 'block';
  levelSysBar.style.display = sysStream ? 'block' : 'none';
  voicebar.classList.add('show');
  voiceHint.textContent = turnDetector ? 'or just stop talking' : '';
  setStatus(listeningStatus(), 'recording');
}

/** Tears the audio graph down and returns everything captured, at the device rate. */
function teardownAudio() {
  recording = false;
  turnDetector = null;
  turnPhase = null;
  btnMic.classList.remove('rec');
  levelBar.style.display = 'none';
  levelSysBar.style.display = 'none';
  levelSysFill.style.width = '0%';
  levelFill.style.width = '0%';
  voicebar.classList.remove('show');

  // Ask the worklet for the last partial batch before pulling the graph apart,
  // so the final fraction of a second is not lost.
  try { if (usingWorklet && captureNode) captureNode.port.postMessage('flush'); } catch { /* going away anyway */ }

  for (const node of [captureNode, procNode, srcNode, sinkNode, micGain, micAnalyser, sysNode, sysGain, sysAnalyser, mixNode]) {
    try { if (node) node.disconnect(); } catch { /* already torn down */ }
  }
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  // A live loopback track holds a system audio capture open. Leaving it running
  // after the recording ends is a recording nobody asked for.
  if (sysStream) sysStream.getTracks().forEach((t) => t.stop());

  const rate = audioCtx ? audioCtx.sampleRate : dsp.TARGET_RATE;
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  micStream = null; captureNode = null; procNode = null; srcNode = null; sinkNode = null;
  sysStream = null; sysNode = null; sysGain = null; micGain = null; mixNode = null;
  micAnalyser = null; micBuf = null; sysAnalyser = null; sysBuf = null;

  let merged = null;
  if (pcmLength) {
    merged = new Float32Array(pcmLength);
    let off = 0;
    for (const c of pcmChunks) { merged.set(c, off); off += c.length; }
  }
  pcmChunks = []; pcmLength = 0;
  return { samples: merged, rate };
}

async function stopRecording() {
  if (!recording) return;
  const { samples, rate } = teardownAudio();

  if (!samples || samples.length < rate * 0.2) {
    setStatus('That was too short to hear — hold the mic a little longer.');
    return;
  }

  const clip = dsp.prepareForTranscription(samples, rate);
  const { analysis } = clip;

  // "It is not listening" is nearly always answerable from these numbers, so
  // leave them where anyone debugging it will look.
  // One flat line, because Electron's console bridge renders an object as
  // "[object Object]" and a diagnostic nobody can read is not a diagnostic.
  console.info(
    `[nexora] mic capture=${usingWorklet ? 'audioWorklet' : 'scriptProcessor'} ` +
    `rate=${rate} raw=${Math.round((samples.length / rate) * 1000)}ms ` +
    `sent=${Math.round(clip.durationMs)}ms trimmed=${Math.round(clip.trimmedMs)}ms ` +
    `peak=${analysis.peak.toFixed(3)} floor=${analysis.noiseFloor.toFixed(4)} ` +
    `snr=${analysis.snrDb.toFixed(1)}dB speech=${analysis.speech}`
  );

  // Deciding here saves a round trip: there is no point paying for an upload to
  // be told "<noise>" when the detector already knows nobody spoke.
  const problem = dsp.describeProblem(analysis);
  if (problem) {
    setStatus(problem, 'error');
    return;
  }
  if (analysis.clipping) {
    setStatus('That was distorting — turn the microphone input level down a little. Transcribing anyway…');
  } else if (analysis.quiet) {
    setStatus('Quiet, but I can work with it. Transcribing…');
  } else {
    setStatus('Transcribing…');
  }

  // Last gate before the upload. Force stop can land while a clip is being
  // prepared, and "stop transcribing" has to mean this one too.
  if (settings.forceStop) {
    setStatus('Force stop is on — that recording was discarded, not transcribed.');
    return;
  }

  const res = await api.transcribe(toBase64(clip.wav), {
    hasSpeech: analysis.speech,
    durationMs: Math.round(clip.durationMs),
    snrDb: Math.round(analysis.snrDb)
  });

  if (!res.ok) {
    setStatus(res.error, 'error');
    if (res.needsKey) openSettings();
    return;
  }

  const text = (res.text || '').trim();
  if (dsp.isNonSpeech(text)) {
    // The audio had speech in it and the model still came back with nothing, so
    // the problem is the model or the recording quality, not the user.
    setStatus(
      `I could not make that out${res.model ? ` (${res.model})` : ''} — try again, ` +
      'or pick a stronger transcription model in Settings.', 'error');
    return;
  }

  // Remembered before the turn runs, so a screenshot taken straight afterwards
  // can be answered against this question rather than described on its own.
  lastTranscript = { text, at: Date.now() };

  // ask() attaches whatever is sitting in the composer, so a screenshot taken
  // while the mic was live goes up with this text — the point of allowing a
  // capture mid-recording in the first place.
  await ask({ text });

  // Continuous conversation reopens the microphone once the answer has landed,
  // so a follow-up is just more speech. Safe Mode outranks it: a privacy cover
  // that leaves the microphone running is not a privacy cover.
  if (settings.continuousConversation && !settings.forceStop && !document.body.classList.contains('safe-mode')) {
    await startRecording();
  }
}

/**
 * Lists the input devices. Labels only exist once microphone permission has been
 * granted, so before the first recording this shows generic names — which is
 * still enough to pick a different one.
 */
async function refreshMicDevices() {
  const select = $('set-mic-device');
  if (!select) return;
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput');

    select.innerHTML = '';
    const add = (value, label) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    };

    add('', 'System default');
    devices.forEach((d, i) => add(d.deviceId, d.label || `Microphone ${i + 1}`));
    select.value = settings.micDeviceId || '';
    if (select.value !== (settings.micDeviceId || '')) select.value = '';   // device unplugged
  } catch (err) {
    setStatus(`Could not list microphones: ${err.message}`, 'error');
  }
}

/**
 * Records a couple of seconds and reports what the conditioning pipeline makes
 * of it. Far more useful than a bare level meter: it answers "will this actually
 * transcribe?" using the same code the real path uses.
 */
async function testMicrophone() {
  const button = $('btn-mic-test');
  const result = $('mic-test-result');
  const meter = $('mic-test-meter').firstElementChild;
  if (recording || busy) { setStatus('Finish the current recording first.'); return; }

  button.disabled = true;
  result.className = 'badge';
  result.textContent = 'listening…';

  const restore = () => { button.disabled = false; meter.style.width = '0%'; };

  try {
    await startRecording();
    if (!recording) { restore(); result.textContent = 'no microphone'; result.className = 'badge no'; return; }

    setStatus('Testing the microphone — say something…', 'recording');
    const started = Date.now();
    await new Promise((resolve) => {
      const tick = setInterval(() => {
        meter.style.width = levelFill.style.width;
        if (Date.now() - started > 2600) { clearInterval(tick); resolve(); }
      }, 60);
    });

    const { samples, rate } = teardownAudio();
    restore();

    if (!samples || !samples.length) {
      result.className = 'badge no';
      result.textContent = 'nothing captured';
      setStatus('The microphone produced no audio at all.', 'error');
      return;
    }

    const { analysis } = dsp.prepareForTranscription(samples, rate);
    const peakPct = Math.round(analysis.peak * 100);

    if (analysis.speech && !analysis.quiet) {
      result.className = 'badge ok';
      result.textContent = `good · peak ${peakPct}% · ${Math.round(analysis.snrDb)} dB SNR`;
      setStatus('Microphone sounds good.');
    } else {
      result.className = 'badge no';
      result.textContent = analysis.silent ? `silent · peak ${peakPct}%` : `weak · peak ${peakPct}%`;
      setStatus(dsp.describeProblem(analysis) || 'That was very quiet.', 'error');
    }

    // Labels become available once permission has been granted.
    await refreshMicDevices();
  } catch (err) {
    restore();
    result.className = 'badge no';
    result.textContent = 'failed';
    setStatus(`Microphone test failed: ${err.message}`, 'error');
  }
}

/** Throws the recording away without transcribing it — used when Safe Mode comes on. */
function discardRecording() {
  if (!recording) return false;
  teardownAudio();
  return true;
}

const toggleRecording = () => (recording ? stopRecording() : startRecording());

// ---------------------------------------------------------------------------
// Presentation Mode
// ---------------------------------------------------------------------------

/**
 * The in-window status indicator, wherever the change came from — the hotkey,
 * the tray, the header chip or the settings switch. Deliberately a small chip in
 * our own header: nothing here is ever drawn over another application.
 */
function applyPresentation(state) {
  presentation = state || presentation;
  if (!presentation) return;

  const on = !!presentation.enabled;
  pmChip.classList.toggle('active', on);
  pmChip.querySelector('span').textContent = on ? 'Presentation: on' : 'Presentation: off';
  pmChip.title = on
    ? `Presentation Mode is on — the window is hidden and off the taskbar. ${presentation.shortcutLabel} turns it off.`
    : `Presentation Mode is off. ${presentation.shortcutLabel} turns it on.`;

  if (pmToggle) pmToggle.checked = on;
  const badge = $('pm-state');
  if (badge) { badge.textContent = on ? 'on' : 'off'; badge.className = `badge ${on ? 'ok' : ''}`.trim(); }

  const field = $('pm-shortcut');
  if (field && !recordingShortcut) field.value = presentation.shortcutLabel;
  const hk = $('hk-presentation');
  if (hk) hk.textContent = presentation.shortcutLabel;

  const auto = $('set-presentation-auto');
  if (auto) { auto.checked = !!presentation.autoEnter; auto.disabled = !presentation.autoSupported; }
  const note = $('pm-auto-note');
  if (note) {
    note.textContent = !presentation.autoSupported
      ? 'Only available on Windows — Nexora has no reliable way to detect this elsewhere without shipping a native module.'
      : 'Asks Windows whether a full-screen app or presentation is running, using the same signal it uses to decide whether a notification would interrupt you. It reads that flag and nothing else — it cannot tell which application you are in, and it conceals nothing from anyone. Nexora only turns the mode back off again if it was the one that turned it on.';
  }
}

async function setPresentation(enabled) {
  try {
    applyPresentation(await api.presentation.set(enabled));
  } catch (err) {
    setStatus(`Could not change Presentation Mode: ${err.message}`, 'error');
  }
}

/**
 * Builds an Electron accelerator from a keydown, or null while the user is still
 * only holding modifiers. `e.code` is used rather than `e.key` so the result does
 * not depend on the keyboard layout or on which modifiers are down.
 */
function acceleratorFrom(e) {
  const modifiers = [];
  if (e.ctrlKey || e.metaKey) modifiers.push('CommandOrControl');
  if (e.altKey) modifiers.push('Alt');
  if (e.shiftKey) modifiers.push('Shift');
  if (!modifiers.length) return null;

  const code = e.code || '';
  let key = null;

  if (/^Key([A-Z])$/.test(code)) key = code.slice(3);
  else if (/^Digit(\d)$/.test(code)) key = code.slice(5);
  else if (/^F\d{1,2}$/.test(code)) key = code;
  else if (code === 'Space') key = 'Space';
  else if (code === 'Backquote') key = '`';
  else if (['Comma', 'Period', 'Slash', 'Backslash', 'Minus', 'Equal'].includes(code)) {
    key = { Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Minus: '-', Equal: '=' }[code];
  } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
    key = code.replace('Arrow', '');
  } else if (['Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete', 'Tab', 'Enter'].includes(code)) {
    key = code === 'Enter' ? 'Return' : code;
  }

  return key ? [...modifiers, key].join('+') : null;
}

function stopRecordingShortcut() {
  recordingShortcut = false;
  $('pm-record').textContent = 'Change';
  $('pm-shortcut').classList.remove('recording');
  if (presentation) $('pm-shortcut').value = presentation.shortcutLabel;
}

// ---------------------------------------------------------------------------
// Screen Share Safe Mode
// ---------------------------------------------------------------------------

/**
 * Single place the window reacts to Safe Mode, whichever side flipped it — the
 * tray, the settings switch, or the button on the cover itself. The cover is
 * CSS-only and sits above the settings sheet, so history stays intact in memory
 * and comes straight back when Safe Mode goes off.
 */
function applySafeMode(on) {
  const enabled = !!on;
  document.body.classList.toggle('safe-mode', enabled);
  safeScreen.setAttribute('aria-hidden', enabled ? 'false' : 'true');
  if (safeToggle) safeToggle.checked = enabled;
  if (enabled) {
    // A live microphone is not something to leave running behind a privacy cover.
    const wasRecording = discardRecording();
    setStatus(wasRecording
      ? 'Safe Mode on — conversation hidden, recording discarded.'
      : 'Safe Mode on — conversation hidden.');
  }
}

async function setSafeMode(enabled) {
  try {
    applySafeMode(await api.safeMode.set(enabled));   // trust what main confirms
  } catch (err) {
    // The switch failed, so leave the cover exactly as it is rather than
    // guessing — showing the conversation on a failed call is the one outcome
    // worth avoiding here.
    setStatus(`Could not change Safe Mode: ${err.message}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The kill switch, and the reason it shouts about itself. While it is on the
 * app records nothing and transcribes nothing, which looks exactly like a
 * feature that has broken — so the chip changes colour and wording rather than
 * sitting there quietly doing nothing.
 */
function renderForceStop() {
  const on = !!settings.forceStop;
  fsChip.classList.toggle('stopped', on);
  fsChip.querySelector('span').textContent = on ? 'Force stopped' : 'Listening';
  fsChip.title = on
    ? 'Force stop is ON — nothing is recorded or transcribed. Click to start listening again.'
    : 'Force stop — pause all recording and transcription until you click again';
}

async function setForceStop(on) {
  // Anything already in flight goes, and goes without being sent: turning this
  // on is a request to stop now, not after the current clip has been uploaded.
  if (on && recording) discardRecording();
  await patch({ forceStop: on });
  setStatus(on
    ? 'Force stopped. Nothing is recorded or transcribed until you click it again.'
    : 'Listening again.');
}

async function patch(p) {
  settings = await api.settings.set(p);
  syncHeader();
  return settings;
}

function syncHeader() {
  renderForceStop();
  btnAgents.textContent = settings.twoAgents ? '2 agents' : '1 agent';
  btnAgents.classList.toggle('on', !!settings.twoAgents);
  $('agent2-card').style.display = settings.twoAgents ? '' : 'none';
}

function fillSelect(el, items, value) {
  el.innerHTML = '';
  const known = items.some((m) => m.id === value);
  const list = known || !value ? items : [{ id: value, label: `${value} (custom)` }, ...items];
  for (const item of list) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.label;
    el.appendChild(opt);
  }
  el.value = value || (list[0] && list[0].id) || '';
}

/** Reasoning models reject a custom temperature, so the slider is disabled for them. */
function applyTemperatureAvailability(index) {
  const agent = settings.agents[index];
  const provider = providerById(agent.provider);
  const entry = provider && provider.models.find((m) => m.id === agent.model);
  const fixed = !!(entry && entry.reasoning);
  const slider = $(`a${index + 1}-temp`);
  slider.disabled = fixed;
  slider.style.opacity = fixed ? 0.4 : 1;
  const note = $(`a${index + 1}-temp-note`);
  if (note) note.textContent = fixed ? 'This model runs at a fixed temperature — the slider is ignored.' : '';
}

function fillAgentForm(index) {
  const agent = settings.agents[index];
  const provider = providerById(agent.provider);
  const n = index + 1;

  fillSelect($(`a${n}-provider`), providerList.map((p) => ({ id: p.id, label: p.label })), agent.provider);
  fillSelect($(`a${n}-model`), provider.models, agent.model);
  $(`a${n}-temp`).value = agent.temperature;
  $(`a${n}-temp-val`).textContent = Number(agent.temperature).toFixed(1);
  applyTemperatureAvailability(index);
}

async function patchAgent(index, changes) {
  const agents = settings.agents.map((a) => ({ ...a }));
  agents[index] = { ...agents[index], ...changes };
  await patch({ agents });
  fillAgentForm(index);
  await refreshKeyBadge();
}

function wireAgentForm(index) {
  const n = index + 1;

  $(`a${n}-provider`).onchange = async (e) => {
    const provider = providerById(e.target.value);
    // Switching provider must also switch the model — a Gemini id means nothing
    // to OpenAI, and leaving it would produce a 404 on the next question.
    await patchAgent(index, { provider: provider.id, model: provider.defaults.model });
  };

  $(`a${n}-model`).onchange = (e) => patchAgent(index, { model: e.target.value });

  $(`a${n}-temp`).oninput = (e) => { $(`a${n}-temp-val`).textContent = Number(e.target.value).toFixed(1); };
  $(`a${n}-temp`).onchange = (e) => patchAgent(index, { temperature: Number(e.target.value) });
}

function fillTranscribeForm() {
  const provider = providerById(settings.transcribeProvider);
  // Only providers that actually do speech-to-text. Anthropic has no such
  // endpoint, and offering it here would be a dropdown entry whose only
  // outcome is an error the first time someone holds the talk key.
  const sttProviders = providerList.filter((p) => (p.transcribeModels || []).length);
  fillSelect($('set-transcribe-provider'), sttProviders.map((p) => ({ id: p.id, label: p.label })), provider.id);
  fillSelect($('set-transcribe'), provider.transcribeModels, settings.transcribeModel);
}

function applySettingsToForm() {
  fillAgentForm(0);
  fillAgentForm(1);
  fillTranscribeForm();

  $('set-two-agents').checked = !!settings.twoAgents;
  $('set-synthesis').checked = settings.synthesis !== false;
  $('set-voice-auto').checked = settings.voiceAuto !== false;
  $('set-system-audio').checked = settings.captureSystemAudio !== false;
  $('set-continuous').checked = !!settings.continuousConversation;
  $('set-voice-silence').value = settings.voiceSilenceMs;
  showSilence(settings.voiceSilenceMs);
  $('set-suggestions').checked = settings.suggestions !== false;
  $('set-ask-display').checked = settings.alwaysAskDisplay !== false;
  $('set-persona').value = settings.persona || '';
  $('set-history').value = settings.historyLimit;
  $('hist-val').textContent = settings.historyLimit;
  $('set-opacity').value = settings.opacity;
  $('op-val').textContent = `${Math.round(settings.opacity * 100)}%`;
  $('set-ontop').checked = !!settings.alwaysOnTop;
  $('set-hidden').checked = !!settings.launchHidden;
  refreshCapturePrivacy();
  refreshAppPrivacy();
  $('set-hide-taskbar').checked = !!settings.hideFromTaskbar;
  syncHeader();
  refreshDisplayNote();
}

/**
 * Screen Share Privacy for Nexora's own window. The badge and the switch both
 * render `excluded` -- what is actually true right now -- rather than the saved
 * preference, so a call that failed shows as off instead of quietly claiming a
 * protection the window does not have.
 */
function applyAppPrivacy(status) {
  const on = !!(status && status.excluded);
  const toggle = $('set-hide-app');
  const badge = $('hide-app-state');
  if (toggle) toggle.checked = on;
  if (badge) { badge.textContent = on ? 'ON' : 'OFF'; badge.className = `badge ${on ? 'ok' : ''}`.trim(); }
}

async function refreshAppPrivacy() {
  try {
    applyAppPrivacy(await api.privacy.app.get());
  } catch {
    applyAppPrivacy(null);
  }
}

async function setAppPrivacy(enabled) {
  try {
    const status = await api.privacy.app.set(enabled);
    applyAppPrivacy(status);
    if (enabled && !status.succeeded) {
      setStatus(`Could not hide Nexora from screen sharing: ${status.error || 'unsupported on this system'}`, 'error');
    }
  } catch (err) {
    applyAppPrivacy(null);
    setStatus(`Could not change Screen Share Privacy: ${err.message}`, 'error');
  }
}

/**
 * Asks the main process what is actually true instead of trusting the stored
 * preference. The preference records what was switched on last session; it is
 * not evidence that this session's test window is excluded — the window may not
 * even be open. Rendering ON from it put an ON badge over an unprotected
 * window, which is the single failure this feature cannot afford.
 */
async function refreshCapturePrivacy() {
  try {
    applyCapturePrivacy(await api.privacy.get());
  } catch {
    applyCapturePrivacy(null);
  }
}

function applyCapturePrivacy(status) {
  const on = !!(status && status.excluded);
  const toggle = $('set-capture-privacy');
  const badge = $('capture-privacy-state');
  if (toggle) toggle.checked = on;
  if (badge) { badge.textContent = on ? 'ON' : 'OFF'; badge.className = `badge ${on ? 'ok' : ''}`.trim(); }
  const result = $('capture-privacy-result');
  if (result && status) {
    // Three states, not two. A call that has not happened yet is neither a pass
    // nor a failure, and labelling an untried API 'API failed' sends people
    // hunting for a broken build that is fine.
    const failure = status.succeeded ? null : (status.error == null ? null : String(status.error));
    result.textContent = status.succeeded ? 'API succeeded' : (failure || 'not tested');
    result.className = `badge ${status.succeeded ? 'ok' : (failure ? 'no' : '')}`.trim();
  }
}

async function setCapturePrivacy(enabled) {
  try {
    const status = await api.privacy.set(enabled);
    applyCapturePrivacy(status);
    if (!status.succeeded) setStatus(`Screen Capture Privacy failed: ${status.error || 'unsupported Windows API'}`, 'error');
  } catch (err) {
    applyCapturePrivacy({ excluded: false, succeeded: false, error: err.message });
    setStatus(`Could not change Screen Capture Privacy: ${err.message}`, 'error');
  }
}

async function refreshDisplayNote() {
  try {
    const { displays } = await api.displays.list();
    $('display-note').textContent = displays.length > 1
      ? `${displays.length} displays detected: ${displays.map((d) => `${d.label} (${d.detail})`).join(', ')}.`
      : 'One display detected — Nexora captures it directly without asking.';
  } catch {
    $('display-note').textContent = '';
  }
}

// --- API keys ---------------------------------------------------------------

function renderKeyCards(statuses) {
  const host = $('key-cards');
  host.innerHTML = '';

  for (const provider of providerList) {
    const state = statuses.find((s) => s.provider === provider.id) || { present: false };

    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <h4>${escapeHtml(provider.label)} <span class="badge" data-role="state">checking…</span></h4>
      <div class="inline">
        <input type="password" data-role="input" placeholder="${escapeHtml(provider.keyHint)}" autocomplete="off" spellcheck="false" style="flex:1;min-width:150px">
        <button class="btn tiny" data-role="reveal" type="button">Show</button>
      </div>
      <div class="inline">
        <button class="btn tiny primary" data-role="save">Save</button>
        <button class="btn tiny ghost" data-role="clear">Remove</button>
        <span class="link" data-role="get">Get a key</span>
      </div>
      <div class="help">${escapeHtml(provider.blurb || '')} Overridden by <code>${escapeHtml(provider.keyEnv)}</code>.</div>`;

    const badge = card.querySelector('[data-role=state]');
    const field = card.querySelector('[data-role=input]');

    const paint = (s) => {
      badge.className = `badge ${s.present ? 'ok' : 'no'}`;
      badge.textContent = !s.present ? 'no key'
        : s.fromEnv ? `from ${provider.keyEnv} (${s.hint})`
        : s.encrypted ? `saved & encrypted (${s.hint})`
        : `saved, unencrypted (${s.hint})`;
    };
    paint(state);

    card.querySelector('[data-role=reveal]').onclick = (e) => {
      field.type = field.type === 'password' ? 'text' : 'password';
      e.target.textContent = field.type === 'password' ? 'Show' : 'Hide';
    };
    card.querySelector('[data-role=save]').onclick = async () => {
      const value = field.value.trim();
      if (!value) { setStatus('Paste a key first.', 'error'); return; }
      paint(await api.key.set(provider.id, value));
      field.value = '';
      await refreshKeyBadge();
      setStatus(`${provider.label} key saved.`);
    };
    card.querySelector('[data-role=clear]').onclick = async () => {
      paint(await api.key.clear(provider.id));
      await refreshKeyBadge();
      setStatus(`${provider.label} key removed.`);
    };
    card.querySelector('[data-role=get]').onclick = () => api.openExternal(provider.keyUrl);

    host.appendChild(card);
  }
}

/**
 * The header badge nags only about providers actually in use — an unconfigured
 * OpenAI key is not a problem if both agents run on Gemini.
 */
async function refreshKeyBadge() {
  const statuses = await api.key.status();
  const inUse = new Set([settings.agents[0].provider]);
  if (settings.twoAgents) inUse.add(settings.agents[1].provider);

  const missing = statuses.filter((s) => inUse.has(s.provider) && !s.present);
  keyBadge.textContent = missing.length
    ? `· add a ${missing.map((m) => providerById(m.provider).label).join(' / ')} key in settings`
    : '';
  return { statuses, missing };
}

function openSettings() {
  settingsPane.classList.add('open');
  api.key.status().then(renderKeyCards);
  refreshMicDevices();
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const PROFILE_FIELDS = ['resume', 'projects', 'notes'];

function renderProfileMeta() {
  for (const f of PROFILE_FIELDS) {
    const el = $(`prof-${f}-count`);
    if (!el) continue;
    const n = (profile[f] || '').length;
    el.textContent = n ? `${n.toLocaleString()} characters` : 'empty';
    el.className = n ? 'badge ok' : 'badge';
  }
  const size = $('prof-size');
  if (size) {
    size.textContent = profile.size
      ? ` Currently ${profile.size.toLocaleString()} of ${profile.limit.toLocaleString()} characters (${Math.round((profile.size / profile.limit) * 100)}%).`
      : '';
  }
}

let profileTimer = null;
function saveProfileSoon(field, value) {
  profile[field] = value;
  clearTimeout(profileTimer);
  profileTimer = setTimeout(async () => {
    profile = await api.profile.set({ [field]: value });
    renderProfileMeta();
    setStatus('Profile saved.');
  }, 500);
}

function wireProfile() {
  for (const f of PROFILE_FIELDS) {
    const box = $(`prof-${f}`);
    box.value = profile[f] || '';
    box.addEventListener('input', () => saveProfileSoon(f, box.value));
  }

  $('prof-enabled').checked = !!profile.enabled;
  $('prof-enabled').onchange = async (e) => {
    profile = await api.profile.set({ enabled: e.target.checked });
    renderProfileMeta();
    setStatus(profile.enabled ? 'Profile will be sent with each message.' : 'Profile disabled.');
  };

  for (const f of ['resume', 'projects']) {
    const btn = $(`prof-import-${f}`);
    if (!btn) continue;
    btn.onclick = async () => {
      const res = await api.profile.import(f);
      if (res.canceled) return;
      if (!res.ok) { setStatus(res.error, 'error'); return; }
      $(`prof-${f}`).value = res.text;
      profile = await api.profile.set({ [f]: res.text });
      renderProfileMeta();
      setStatus(`Imported ${res.name}.`);
    };
  }

  renderProfileMeta();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(150, input.scrollHeight)}px`;
}

input.addEventListener('input', autoGrow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); }
});

function onSend() {
  if (busy && run) return api.ask.stop(run.requestId);
  return ask({ text: input.value });
}

btnSend.onclick = onSend;
btnMic.onclick = toggleRecording;
fsChip.onclick = () => setForceStop(!settings.forceStop);

// The manual pair stays available whether or not the detector is on: no turn
// detector is right every time, and being unable to say "I am done" is worse
// than an occasional early send.
$('btn-voice-done').onclick = () => { if (recording) stopRecording(); };
$('btn-voice-cancel').onclick = () => {
  if (!discardRecording()) return;
  setStatus('Voice input discarded.');
};
btnShot.onclick = startCapture;

btnAgents.onclick = async () => {
  await patch({ twoAgents: !settings.twoAgents });
  $('set-two-agents').checked = !!settings.twoAgents;
  await refreshKeyBadge();
  setStatus(settings.twoAgents
    ? `Two-agent mode on — ${agentLabel(0)} and ${agentLabel(1)}.`
    : 'Single-agent mode.');
};

$('btn-clear').onclick = () => {
  if (busy && run) api.ask.stop(run.requestId);
  history = [];
  clearShot();
  renderEmptyState();
  setStatus('New conversation.');
};

$('btn-export').onclick = async () => {
  if (!history.length) { setStatus('Nothing to export yet.'); return; }
  const md = ['# Nexora conversation', '', `_${new Date().toLocaleString()}_`, '']
    .concat(history.map((m) =>
      `## ${m.role === 'user' ? 'You' : 'Nexora'}\n\n${m.imageDataUrl ? '_(screenshot attached)_\n\n' : ''}${m.text}\n`))
    .join('\n');
  const res = await api.exportMarkdown(md);
  setStatus(res.ok ? `Saved to ${res.filePath}` : res.canceled ? 'Export canceled.' : `Export failed: ${res.error || ''}`);
};

$('btn-settings').onclick = openSettings;
$('btn-close-settings').onclick = () => settingsPane.classList.remove('open');
$('btn-minimize').onclick = () => api.window.minimize();
$('btn-hide').onclick = () => api.window.hide();

$('set-two-agents').onchange = async (e) => {
  await patch({ twoAgents: e.target.checked });
  await refreshKeyBadge();
};
$('set-synthesis').onchange = (e) => patch({ synthesis: e.target.checked });

const showSilence = (ms) => { $('voice-silence-val').textContent = `${(Number(ms) / 1000).toFixed(1)}s`; };

$('set-voice-auto').onchange = (e) => patch({ voiceAuto: e.target.checked });
$('set-system-audio').onchange = (e) => patch({ captureSystemAudio: e.target.checked });
$('set-continuous').onchange = (e) => patch({ continuousConversation: e.target.checked });
$('set-voice-silence').oninput = (e) => showSilence(e.target.value);
$('set-voice-silence').onchange = (e) => patch({ voiceSilenceMs: Number(e.target.value) });
$('set-suggestions').onchange = (e) => patch({ suggestions: e.target.checked });
$('set-ask-display').onchange = (e) => patch({ alwaysAskDisplay: e.target.checked });

$('set-transcribe-provider').onchange = async (e) => {
  const provider = providerById(e.target.value);
  await patch({ transcribeProvider: provider.id, transcribeModel: provider.defaults.transcribeModel });
  fillTranscribeForm();
};
$('set-transcribe').onchange = (e) => patch({ transcribeModel: e.target.value });
$('set-mic-device').onchange = (e) => patch({ micDeviceId: e.target.value || null });
$('btn-mic-test').onclick = testMicrophone;

$('set-persona').onchange = (e) => patch({ persona: e.target.value });

$('set-history').oninput = (e) => { $('hist-val').textContent = e.target.value; };
$('set-history').onchange = (e) => patch({ historyLimit: Number(e.target.value) });

$('set-opacity').oninput = (e) => { $('op-val').textContent = `${Math.round(e.target.value * 100)}%`; };
$('set-opacity').onchange = (e) => patch({ opacity: Number(e.target.value) });

$('set-ontop').onchange = (e) => patch({ alwaysOnTop: e.target.checked });
$('set-hidden').onchange = (e) => patch({ launchHidden: e.target.checked });
$('set-hide-app').onchange = (e) => setAppPrivacy(e.target.checked);
$('set-hide-taskbar').onchange = (e) => patch({ hideFromTaskbar: e.target.checked });
$('set-capture-privacy').onchange = (e) => setCapturePrivacy(e.target.checked);
$('btn-open-capture-test').onclick = async () => {
  const status = await api.privacy.open();
  applyCapturePrivacy(status);
};

safeToggle.onchange = (e) => setSafeMode(e.target.checked);
$('btn-safe-off').onclick = () => setSafeMode(false);

pmChip.onclick = () => setPresentation(!(presentation && presentation.enabled));
pmToggle.onchange = (e) => setPresentation(e.target.checked);

$('pm-record').onclick = () => {
  if (recordingShortcut) return stopRecordingShortcut();
  recordingShortcut = true;
  $('pm-record').textContent = 'Cancel';
  $('pm-shortcut').value = 'Press a shortcut…';
  $('pm-shortcut').classList.add('recording');
  $('pm-shortcut').focus();
};

$('pm-shortcut').addEventListener('keydown', async (e) => {
  if (!recordingShortcut) return;
  e.preventDefault();
  if (e.key === 'Escape') return stopRecordingShortcut();

  const accelerator = acceleratorFrom(e);
  if (!accelerator) return;      // still only modifiers down

  const result = await api.presentation.setShortcut(accelerator);
  recordingShortcut = false;
  $('pm-record').textContent = 'Change';
  $('pm-shortcut').classList.remove('recording');
  applyPresentation(result);

  // A shortcut another app already owns has to be rejected loudly, or the mode
  // would quietly become tray-only.
  setStatus(result.ok ? `Presentation Mode shortcut is now ${result.shortcutLabel}.` : result.error,
            result.ok ? undefined : 'error');
});

$('pm-reset').onclick = async () => {
  applyPresentation(await api.presentation.setShortcut('CommandOrControl+Shift+Space'));
  setStatus('Presentation Mode shortcut reset.');
};

$('set-presentation-auto').onchange = async (e) => {
  const result = await api.presentation.setAutoEnter(e.target.checked);
  applyPresentation(result);
  if (!result.ok && result.error) setStatus(result.error, 'error');
};

settingsPane.addEventListener('click', (e) => {
  const link = e.target.closest('.link[data-url]');
  if (link) api.openExternal(link.dataset.url);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (pickerPane.classList.contains('open')) closePicker();
  else if (settingsPane.classList.contains('open')) settingsPane.classList.remove('open');
});

api.on('hotkey:talk', toggleRecording);
api.on('hotkey:screenshot', startCapture);
api.on('ui:open-settings', openSettings);
api.on('state:click-through', (on) => ctBanner.classList.toggle('show', !!on));
api.on('state:safe-mode', applySafeMode);
api.on('state:presentation', (on) => applyPresentation({ ...presentation, enabled: !!on }));
api.on('state:hotkeys', (failed) => {
  if (!failed || !failed.length) return;
  setStatus(`Another app already owns ${failed.map((f) => f.accelerator).join(', ')}.`, 'error');
});
api.on('state:settings', (next) => { settings = next; applySettingsToForm(); });
api.on('state:privacy', applyCapturePrivacy);
api.on('state:app-privacy', applyAppPrivacy);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

(async function boot() {
  settings = await api.settings.get();
  applySafeMode(settings.safeMode);   // first, before any conversation UI exists

  applyPresentation(await api.presentation.get());

  providerList = await api.providers.list();
  profile = await api.profile.get();

  applySettingsToForm();
  wireAgentForm(0);
  wireAgentForm(1);
  wireProfile();
  renderEmptyState();

  const { missing } = await refreshKeyBadge();
  if (missing.length) {
    setStatus(`Add your ${providerById(missing[0].provider).label} API key to get started.`, 'error');
    openSettings();
  } else if (!settings.safeMode) {
    setStatus('Ready.');
  }
  input.focus();
})();
