/**
 * Presentation Mode — keeps the assistant out of your own presentation workflow.
 *
 * Turning it on hides the window and takes it out of the taskbar and alt-tab, so
 * nothing of ours is in the way while you present. Turning it off puts the window
 * back exactly where it was, at the size it was. The process keeps running the
 * whole time: the conversation, the pending screenshot and every bit of app state
 * are still in memory, and the tray is still there.
 *
 * What it deliberately does NOT do: it never touches another application, and it
 * never calls, hooks or alters any screen-capture API. It does not try to be
 * invisible to Teams, Zoom, Meet or Slack — it simply is not on screen. Those are
 * different claims and only the second one is true here.
 *
 * How it relates to Screen Share Safe Mode: Safe Mode is about content — it covers
 * the conversation even when the window is up. Presentation Mode is about the
 * window — it gets out of the way and comes back where it was. They compose; see
 * safe-mode.js.
 *
 * No Electron imports on purpose. Every collaborator is injected, which keeps the
 * state machine testable in plain Node and keeps the policy ("what the mode
 * means") apart from the plumbing ("which window to hide").
 */

'use strict';

const PRESENTATION_LABEL = 'Presentation Mode';

/** Where the window was before we hid it, and how it was shown. */
function normaliseWindowState(state) {
  if (!state || !state.bounds) return null;
  const { x, y, width, height } = state.bounds;
  if (![x, y, width, height].every((n) => Number.isFinite(n))) return null;
  return {
    bounds: { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) },
    maximized: !!state.maximized
  };
}

/**
 * @param {object}   deps
 * @param {boolean}  deps.initial          restored from disk at launch
 * @param {object}   deps.restore          the window state saved alongside it
 * @param {Function} deps.persist          (enabled, restoreState) => void
 * @param {Function} deps.captureWindow    () => { bounds, maximized } | null
 * @param {Function} deps.hideWindow       () => void — hide and leave the taskbar
 * @param {Function} deps.showWindow       (restoreState) => void — put it back
 * @param {Function} deps.notify           (enabled) => void — tell our own renderer
 * @param {Function} deps.refreshMenu      () => void — redraw the tray
 * @param {Function} deps.log
 */
function createPresentationMode({
  initial = false,
  restore = null,
  persist = () => {},
  captureWindow = () => null,
  hideWindow = () => {},
  showWindow = () => {},
  notify = () => {},
  refreshMenu = () => {},
  log = () => {}
} = {}) {
  let enabled = Boolean(initial);
  let saved = normaliseWindowState(restore);

  // Set when the mode was entered by the fullscreen watcher rather than by the
  // user. Only an automatic entry may be undone automatically — once someone has
  // turned this on deliberately, a detector has no business turning it back off.
  let auto = false;

  // Each collaborator reaches into Electron, where a window can be destroyed
  // between one call and the next and a disk write can fail. None of that is
  // worth aborting a mode toggle over: record it and carry on with the rest.
  const guard = (what, fn) => {
    try {
      return fn();
    } catch (err) {
      log(`${PRESENTATION_LABEL}: could not ${what}: ${(err && err.message) || err}`);
      return undefined;
    }
  };

  const isEnabled = () => enabled;
  const restoreState = () => (saved ? { bounds: { ...saved.bounds }, maximized: saved.maximized } : null);
  const enteredAutomatically = () => auto;

  function enable({ automatic = false } = {}) {
    if (enabled) return false;

    // Remember where the window is BEFORE hiding it — a hidden window still
    // reports bounds, but a later restore would otherwise have nothing to aim at
    // if the app is restarted while the mode is on.
    const captured = normaliseWindowState(guard('read the window position', captureWindow));
    if (captured) saved = captured;

    enabled = true;
    auto = !!automatic;

    guard('save your preference', () => persist(enabled, restoreState()));
    guard('hide the window', hideWindow);
    guard('update the window', () => notify(enabled));
    guard('rebuild the tray menu', refreshMenu);
    return true;
  }

  function disable({ automatic = false } = {}) {
    if (!enabled) return false;
    // A detector may only undo what a detector did.
    if (automatic && !auto) return false;

    enabled = false;
    auto = false;

    guard('save your preference', () => persist(enabled, restoreState()));
    guard('restore the window', () => showWindow(restoreState()));
    guard('update the window', () => notify(enabled));
    guard('rebuild the tray menu', refreshMenu);
    return true;
  }

  /** The single action behind the hotkey and the tray checkbox. */
  function toggle() {
    if (enabled) disable();
    else enable();
    return enabled;
  }

  function set(next, options) {
    return Boolean(next) ? enable(options) : disable(options);
  }

  /**
   * Whether the window may show itself at startup. A session that starts in
   * Presentation Mode should never paint the window at all.
   */
  const shouldShowAtLaunch = () => !enabled;

  /** Re-assert the current state without persisting — e.g. after a window reload. */
  function sync() {
    guard('update the window', () => notify(enabled));
    guard('rebuild the tray menu', refreshMenu);
    return enabled;
  }

  return {
    label: PRESENTATION_LABEL,
    isEnabled, enable, disable, toggle, set,
    restoreState, enteredAutomatically, shouldShowAtLaunch, sync
  };
}

module.exports = { createPresentationMode, normaliseWindowState, PRESENTATION_LABEL };
