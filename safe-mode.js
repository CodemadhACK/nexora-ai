/**
 * Screen Share Safe Mode — a local privacy switch for presentations and calls.
 *
 * What it does: hides Nexora's own window and tells its own renderer to cover
 * private conversation content, so nothing of ours is on display while you present.
 * The preference is remembered between launches.
 *
 * What it deliberately does NOT do: it never touches another application — Teams,
 * Zoom, Meet, Slack and browsers are left completely alone — and it never calls
 * into, hooks, or alters any screen-capture API. Safe Mode does not make this
 * window invisible to capture software; it makes sure the window is not on screen
 * to be captured in the first place. Those are different things, and only the
 * second one is honest.
 *
 * There are no Electron imports here on purpose. Every collaborator is injected,
 * which keeps the state machine testable in plain Node and keeps the policy
 * ("what Safe Mode means") separate from the plumbing ("which window to hide").
 */

'use strict';

/** Shown verbatim in the tray menu and the settings sheet, so the two agree. */
const SAFE_MODE_LABEL = 'Screen Share Safe Mode';

/**
 * @param {object}   deps
 * @param {boolean}  deps.initial      State restored from disk at launch.
 * @param {Function} deps.persist      (enabled) => void — write the preference.
 * @param {Function} deps.hideWindow   () => void — hide our own window.
 * @param {Function} deps.notify       (enabled) => void — tell our own renderer.
 * @param {Function} deps.refreshMenu  () => void — redraw the tray status.
 * @param {Function} deps.log          (message) => void — non-fatal problems.
 */
function createSafeMode({
  initial = false,
  persist = () => {},
  hideWindow = () => {},
  notify = () => {},
  refreshMenu = () => {},
  log = () => {}
} = {}) {
  let enabled = Boolean(initial);

  // Every collaborator reaches into Electron, where a window can be destroyed or
  // a disk write can fail between one call and the next. None of that is worth
  // aborting a privacy toggle over: record it and carry on with the rest.
  const guard = (what, fn) => {
    try {
      return fn();
    } catch (err) {
      log(`Safe Mode: could not ${what}: ${(err && err.message) || err}`);
      return undefined;
    }
  };

  // Hiding runs before notifying so the window is off screen at the earliest
  // possible moment; the renderer's cover is the backstop for when it returns.
  function announce() {
    if (enabled) guard('hide the window', hideWindow);
    guard('update the window', () => notify(enabled));
    guard('rebuild the tray menu', refreshMenu);
  }

  function isEnabled() {
    return enabled;
  }

  function set(next) {
    const want = Boolean(next);
    if (want === enabled) return enabled;   // idempotent: no redundant writes or flicker
    enabled = want;
    guard('save your preference', () => persist(enabled));
    announce();
    return enabled;
  }

  function toggle() {
    return set(!enabled);
  }

  /**
   * Whether the window may show itself at startup. Restoring Safe Mode has to
   * beat first paint — a window that appears and *then* hides has already
   * leaked whatever was on it.
   */
  function shouldShowAtLaunch() {
    return !enabled;
  }

  /** Re-assert the current state without persisting (e.g. after a window reload). */
  function sync() {
    announce();
    return enabled;
  }

  return { label: SAFE_MODE_LABEL, isEnabled, set, toggle, shouldShowAtLaunch, sync };
}

module.exports = { createSafeMode, SAFE_MODE_LABEL };
