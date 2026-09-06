/**
 * The tray menu as data.
 *
 * `buildTrayTemplate` is a pure function: state in, Electron menu template out.
 * That keeps the parts the user actually looks at — the mode statuses, the
 * toggles — testable, and keeps main.js from growing a second copy of the labels.
 */

'use strict';

const { SAFE_MODE_LABEL } = require('./safe-mode');
const { PRESENTATION_LABEL } = require('./presentation-mode');
const { HOTKEYS, describe } = require('./hotkeys');

const APP_NAME = 'Nexora';
const TWO_AGENT_LABEL = 'Two-agent mode';

/**
 * The at-a-glance answer to "which of these is on right now?". A filled dot reads
 * as on and a hollow one as off even before the words register, and both sit at
 * the top of the menu because that is where the eye lands first.
 */
function statusLabel(name, on) {
  return on ? `● ${name}: ON` : `○ ${name}: OFF`;
}

const presentationStatusLabel = (on) => statusLabel(PRESENTATION_LABEL, on);
const safeModeStatusLabel = (on) => statusLabel(SAFE_MODE_LABEL, on);

/** The same answers again, for people who hover the icon rather than open the menu. */
function trayTooltip(safeModeOn, presentationOn) {
  const active = [
    presentationOn ? `${PRESENTATION_LABEL} is ON (window hidden and off the taskbar)` : null,
    safeModeOn ? `${SAFE_MODE_LABEL} is ON (conversation covered)` : null
  ].filter(Boolean);

  return active.length
    ? `${APP_NAME} — ${active.join('; ')}`
    : `${APP_NAME} AI — technical interview assistant`;
}

/**
 * @param {object} state    { presentation, presentationShortcut, safeMode, clickThrough, alwaysOnTop, twoAgents }
 * @param {object} actions  click handlers, all optional
 */
function buildTrayTemplate(state = {}, actions = {}) {
  const noop = () => {};
  const {
    showAssistant = noop,
    togglePresentation = noop,
    toggleSafeMode = noop,
    toggleTwoAgents = noop,
    toggleClickThrough = noop,
    toggleAlwaysOnTop = noop,
    openSettings = noop,
    openDataFolder = noop,
    quit = noop
  } = actions;

  const shortcut = describe(state.presentationShortcut || HOTKEYS.PRESENTATION);

  return [
    // Status first, and deliberately inert — these report, they don't act. The
    // checkboxes below are the controls.
    { label: presentationStatusLabel(!!state.presentation), enabled: false },
    { label: safeModeStatusLabel(!!state.safeMode), enabled: false },
    { type: 'separator' },

    // Always brings the window back, whatever mode is on — the one item that is
    // guaranteed to get you to the assistant.
    { label: 'Show Assistant', click: showAssistant },
    {
      label: `${PRESENTATION_LABEL}  (${shortcut})`,
      type: 'checkbox',
      checked: !!state.presentation,
      click: togglePresentation
    },
    {
      label: SAFE_MODE_LABEL,
      type: 'checkbox',
      checked: !!state.safeMode,
      click: toggleSafeMode
    },
    {
      label: TWO_AGENT_LABEL,
      type: 'checkbox',
      checked: !!state.twoAgents,
      click: toggleTwoAgents
    },
    {
      label: `Click-through mode  (${describe(HOTKEYS.CLICK_THROUGH)})`,
      type: 'checkbox',
      checked: !!state.clickThrough,
      click: toggleClickThrough
    },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: !!state.alwaysOnTop,
      click: toggleAlwaysOnTop
    },

    { type: 'separator' },
    { label: 'Settings…', click: openSettings },
    { label: 'Open data folder', click: openDataFolder },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: quit }
  ];
}

module.exports = {
  buildTrayTemplate, statusLabel, safeModeStatusLabel, presentationStatusLabel,
  trayTooltip, APP_NAME, TWO_AGENT_LABEL
};
