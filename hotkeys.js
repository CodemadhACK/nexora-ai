/**
 * Global accelerators.
 *
 * Kept out of main.js so the accelerator strings are a single source of truth
 * (the tray menu and the settings sheet quote them) and so the registration
 * behaviour can be tested without Electron.
 */

'use strict';

const HOTKEYS = {
  PRESENTATION:  'CommandOrControl+Shift+Space',
  TALK:          'CommandOrControl+Shift+A',
  SCREENSHOT:    'CommandOrControl+Shift+S',
  CLICK_THROUGH: 'CommandOrControl+Shift+X'
};

/** Held keys repeat. Two toggles 30ms apart are never what anyone meant. */
const DEFAULT_DEBOUNCE_MS = 250;

const MODIFIERS = new Set([
  'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl',
  'alt', 'option', 'altgr', 'shift', 'super', 'meta'
]);

/** Human-readable form for the UI — the platform prefix is what users actually press. */
function describe(accelerator, platform = process.platform) {
  const prefix = platform === 'darwin' ? 'Cmd' : 'Ctrl';
  return String(accelerator || '').replace(/^CommandOrControl/, prefix).replace(/^CmdOrCtrl/, prefix);
}

/**
 * Catches the shapes Electron rejects, before we hand it something that throws
 * and tears down a working binding on the way. Electron is still the authority;
 * this just means a typo in the settings field fails politely.
 */
function isValidAccelerator(accelerator) {
  if (typeof accelerator !== 'string') return false;
  const parts = accelerator.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length !== accelerator.split('+').length || parts.length < 2) return false;

  const key = parts[parts.length - 1];
  const modifiers = parts.slice(0, -1);
  if (!modifiers.length) return false;
  if (!modifiers.every((m) => MODIFIERS.has(m.toLowerCase()))) return false;
  // A bare modifier as the key, or a repeated one, is not a shortcut.
  if (MODIFIERS.has(key.toLowerCase())) return false;
  return new Set(modifiers.map((m) => m.toLowerCase())).size === modifiers.length;
}

/**
 * Wraps a handler so a held key cannot fire it twice, and so an exception inside
 * it cannot escape — a global-shortcut callback has no caller to catch anything
 * it throws, and it would surface as an unhandled crash.
 */
function protect(accelerator, handler, { debounceMs, now, log }) {
  let last = 0;
  return () => {
    const at = now();
    if (debounceMs > 0 && at - last < debounceMs) return;
    last = at;
    try {
      handler();
    } catch (err) {
      log(`hotkey ${accelerator} failed: ${(err && err.message) || err}`);
    }
  };
}

/**
 * Registers each accelerator, absorbing the two ways this fails in practice:
 * `register` returns false when another application already owns the
 * combination, and throws outright on one Electron can't parse. Neither is a
 * reason to bring down startup — a missing hotkey should cost you that hotkey
 * and nothing else.
 *
 * @returns {Array<{accelerator: string, ok: boolean, reason: string|null}>}
 */
function registerHotkeys(globalShortcut, bindings, log = () => {}, {
  debounceMs = DEFAULT_DEBOUNCE_MS,
  now = () => Date.now()
} = {}) {
  const results = [];

  for (const [accelerator, handler] of Object.entries(bindings || {})) {
    if (typeof handler !== 'function') continue;

    let ok = false;
    let reason = null;

    if (!isValidAccelerator(accelerator)) {
      reason = 'not a usable shortcut — it needs at least one modifier and a key';
    } else {
      try {
        const registered = globalShortcut.register(
          accelerator,
          protect(accelerator, handler, { debounceMs, now, log })
        );
        ok = registered !== false;
        if (!ok) reason = 'already claimed by another application';
      } catch (err) {
        reason = (err && err.message) || String(err);
      }
    }

    if (!ok) log(`could not register ${accelerator}: ${reason}`);
    results.push({ accelerator, ok, reason });
  }

  return results;
}

/**
 * Owns the currently registered set so accelerators can be changed at runtime.
 *
 * `apply` is all-or-nothing per accelerator, and it unregisters the previous set
 * first: rebinding Presentation Mode from Ctrl+Shift+Space to something else must
 * not leave the old combination live, or one keypress would fire two toggles.
 */
function createHotkeyManager(globalShortcut, log = () => {}, options = {}) {
  let active = [];

  function releaseAll() {
    for (const accelerator of active) {
      try { globalShortcut.unregister(accelerator); } catch (err) { log(`could not release ${accelerator}: ${err.message}`); }
    }
    active = [];
  }

  function apply(bindings) {
    releaseAll();
    const results = registerHotkeys(globalShortcut, bindings, log, options);
    active = results.filter((r) => r.ok).map((r) => r.accelerator);
    return results;
  }

  /**
   * Tries a single accelerator without disturbing anything: registers it, notes
   * the outcome, and releases it again. Lets the settings pane say "that one is
   * taken" before committing to it.
   */
  function probe(accelerator) {
    if (!isValidAccelerator(accelerator)) {
      return { ok: false, reason: 'That needs at least one modifier and a key — for example Ctrl+Shift+Space.' };
    }
    if (active.includes(accelerator)) return { ok: true, reason: null };

    try {
      if (!globalShortcut.register(accelerator, () => {})) {
        return { ok: false, reason: 'Another application already uses that shortcut.' };
      }
      globalShortcut.unregister(accelerator);
      return { ok: true, reason: null };
    } catch (err) {
      return { ok: false, reason: (err && err.message) || String(err) };
    }
  }

  return { apply, probe, releaseAll, registered: () => [...active] };
}

module.exports = {
  HOTKEYS, DEFAULT_DEBOUNCE_MS,
  registerHotkeys, createHotkeyManager, describe, isValidAccelerator
};
