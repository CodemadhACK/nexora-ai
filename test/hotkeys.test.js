'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HOTKEYS, registerHotkeys, createHotkeyManager, describe, isValidAccelerator
} = require('../hotkeys');

/**
 * Stands in for Electron's globalShortcut. `behaviour` maps an accelerator to
 * the failure to simulate: 'taken' (another app owns it — register returns
 * false) or 'throw' (Electron rejects the accelerator outright).
 */
function fakeGlobalShortcut(behaviour = {}) {
  const registered = new Map();
  return {
    registered,
    register(accelerator, callback) {
      if (behaviour[accelerator] === 'throw') throw new Error('Invalid accelerator');
      if (behaviour[accelerator] === 'taken') return false;
      registered.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) { registered.delete(accelerator); },
    press(accelerator) { registered.get(accelerator)(); }
  };
}

/** Debouncing is time-based, so tests drive the clock rather than sleeping. */
function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('Ctrl+Shift+Space is the Presentation Mode accelerator', () => {
  assert.equal(HOTKEYS.PRESENTATION, 'CommandOrControl+Shift+Space');
});

test('the Presentation Mode shortcut is distinct from the screenshot one', () => {
  const all = Object.values(HOTKEYS);
  assert.equal(new Set(all).size, all.length, 'no two actions may share an accelerator');
  assert.notEqual(HOTKEYS.PRESENTATION, HOTKEYS.SCREENSHOT);
});

test('pressing the shortcut toggles Presentation Mode on and off', () => {
  const shortcut = fakeGlobalShortcut();
  const time = clock();
  let enabled = false;

  const results = registerHotkeys(shortcut, {
    [HOTKEYS.PRESENTATION]: () => { enabled = !enabled; }
  }, () => {}, { now: time.now });

  assert.deepEqual(results, [{ accelerator: HOTKEYS.PRESENTATION, ok: true, reason: null }]);

  shortcut.press(HOTKEYS.PRESENTATION);
  assert.equal(enabled, true, 'off → on');

  time.advance(500);
  shortcut.press(HOTKEYS.PRESENTATION);
  assert.equal(enabled, false, 'on → off');
});

test('a held key cannot fire the toggle twice', () => {
  const shortcut = fakeGlobalShortcut();
  const time = clock();
  let fired = 0;

  registerHotkeys(shortcut, { [HOTKEYS.PRESENTATION]: () => { fired++; } }, () => {}, { now: time.now });

  shortcut.press(HOTKEYS.PRESENTATION);
  time.advance(30);
  shortcut.press(HOTKEYS.PRESENTATION);   // auto-repeat while the key is held
  time.advance(30);
  shortcut.press(HOTKEYS.PRESENTATION);

  assert.equal(fired, 1, 'key repeat must not produce three toggles');

  time.advance(400);
  shortcut.press(HOTKEYS.PRESENTATION);
  assert.equal(fired, 2, 'a deliberate second press still works');
});

test('an accelerator another app already owns is reported, not fatal', () => {
  const shortcut = fakeGlobalShortcut({ [HOTKEYS.PRESENTATION]: 'taken' });
  const logs = [];
  let clickThrough = 0;

  const results = registerHotkeys(shortcut, {
    [HOTKEYS.PRESENTATION]: () => {},
    [HOTKEYS.CLICK_THROUGH]: () => { clickThrough++; }
  }, (m) => logs.push(m));

  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /already claimed/);
  assert.equal(results[1].ok, true, 'one bad accelerator must not cost you the rest');
  assert.match(logs.join('\n'), new RegExp(HOTKEYS.PRESENTATION.replace(/\+/g, '\\+')));

  shortcut.press(HOTKEYS.CLICK_THROUGH);
  assert.equal(clickThrough, 1);
});

test('an accelerator Electron rejects is caught', () => {
  // Well-formed enough to get past our own validation, but not a key Electron
  // will accept — so the throw has to be handled rather than escape.
  const shortcut = fakeGlobalShortcut({ 'Ctrl+Shift+F25': 'throw' });
  const logs = [];

  const results = registerHotkeys(shortcut, {
    'Ctrl+Shift+F25': () => {},
    [HOTKEYS.PRESENTATION]: () => {}
  }, (m) => logs.push(m));

  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /Invalid accelerator/);
  assert.equal(results[1].ok, true, 'one bad accelerator must not cost you the rest');
  assert.equal(logs.length, 1);
});

test('a throwing handler is contained inside the shortcut callback', () => {
  const shortcut = fakeGlobalShortcut();
  const logs = [];

  registerHotkeys(shortcut, {
    [HOTKEYS.PRESENTATION]: () => { throw new Error('window gone'); }
  }, (m) => logs.push(m));

  // Electron invokes this callback with no caller to catch anything it throws.
  assert.doesNotThrow(() => shortcut.press(HOTKEYS.PRESENTATION));
  assert.match(logs.join('\n'), /window gone/);
});

test('non-function bindings are skipped rather than registered', () => {
  const shortcut = fakeGlobalShortcut();
  const results = registerHotkeys(shortcut, { [HOTKEYS.TALK]: null, [HOTKEYS.SCREENSHOT]: undefined });
  assert.deepEqual(results, []);
  assert.equal(shortcut.registered.size, 0);
});

test('empty and missing binding sets are harmless', () => {
  const shortcut = fakeGlobalShortcut();
  assert.deepEqual(registerHotkeys(shortcut, {}), []);
  assert.deepEqual(registerHotkeys(shortcut), []);
});

test('describe renders the accelerator the way the platform reads it', () => {
  assert.equal(describe(HOTKEYS.PRESENTATION, 'win32'), 'Ctrl+Shift+Space');
  assert.equal(describe(HOTKEYS.PRESENTATION, 'darwin'), 'Cmd+Shift+Space');
  assert.equal(describe('CmdOrCtrl+Shift+P', 'darwin'), 'Cmd+Shift+P');
  assert.equal(describe(undefined, 'win32'), '');
});

// ---------------------------------------------------------------------------
// Accelerator validation — the settings field feeds this directly
// ---------------------------------------------------------------------------

test('a usable shortcut needs a modifier and a key', () => {
  for (const good of ['CommandOrControl+Shift+Space', 'Alt+F4', 'Ctrl+Shift+P', 'Super+Alt+K']) {
    assert.equal(isValidAccelerator(good), true, `${good} should be accepted`);
  }
  for (const bad of ['Space', 'Shift', 'Ctrl+', '+Space', 'Ctrl++A', '', null, 42,
                     'Ctrl+Shift', 'Ctrl+Ctrl+A']) {
    assert.equal(isValidAccelerator(bad), false, `${JSON.stringify(bad)} should be rejected`);
  }
});

test('an unusable shortcut is rejected before Electron ever sees it', () => {
  const shortcut = fakeGlobalShortcut();
  const results = registerHotkeys(shortcut, { 'Shift': () => {} });

  assert.equal(results[0].ok, false);
  assert.match(results[0].reason, /needs at least one modifier/);
  assert.equal(shortcut.registered.size, 0, 'nothing should have been attempted');
});

// ---------------------------------------------------------------------------
// Rebinding
// ---------------------------------------------------------------------------

test('rebinding releases the old accelerator before taking the new one', () => {
  const shortcut = fakeGlobalShortcut();
  const manager = createHotkeyManager(shortcut);
  let fired = 0;
  const handler = () => { fired++; };

  manager.apply({ [HOTKEYS.PRESENTATION]: handler });
  assert.deepEqual(manager.registered(), [HOTKEYS.PRESENTATION]);

  manager.apply({ 'CommandOrControl+Alt+P': handler });

  assert.equal(shortcut.registered.has(HOTKEYS.PRESENTATION), false,
    'the old combination must not stay live, or one press would fire two toggles');
  assert.equal(shortcut.registered.has('CommandOrControl+Alt+P'), true);
  assert.deepEqual(manager.registered(), ['CommandOrControl+Alt+P']);

  shortcut.press('CommandOrControl+Alt+P');
  assert.equal(fired, 1);
});

test('probe reports a shortcut another app owns without disturbing the live set', () => {
  const shortcut = fakeGlobalShortcut({ 'CommandOrControl+Alt+T': 'taken' });
  const manager = createHotkeyManager(shortcut);
  manager.apply({ [HOTKEYS.PRESENTATION]: () => {} });

  const taken = manager.probe('CommandOrControl+Alt+T');
  assert.equal(taken.ok, false);
  assert.match(taken.reason, /Another application/);

  const free = manager.probe('CommandOrControl+Alt+J');
  assert.equal(free.ok, true);
  assert.equal(shortcut.registered.has('CommandOrControl+Alt+J'), false, 'probing must not leave it bound');

  assert.deepEqual(manager.registered(), [HOTKEYS.PRESENTATION], 'the live binding is untouched');
});

test('probe rejects nonsense with something a user can act on', () => {
  const manager = createHotkeyManager(fakeGlobalShortcut());
  const result = manager.probe('Space');
  assert.equal(result.ok, false);
  assert.match(result.reason, /modifier/);
});

test('probing the shortcut that is already bound succeeds', () => {
  const shortcut = fakeGlobalShortcut();
  const manager = createHotkeyManager(shortcut);
  manager.apply({ [HOTKEYS.PRESENTATION]: () => {} });

  assert.deepEqual(manager.probe(HOTKEYS.PRESENTATION), { ok: true, reason: null });
});

test('releaseAll leaves nothing registered', () => {
  const shortcut = fakeGlobalShortcut();
  const manager = createHotkeyManager(shortcut);
  manager.apply({ [HOTKEYS.PRESENTATION]: () => {}, [HOTKEYS.SCREENSHOT]: () => {} });

  manager.releaseAll();
  assert.equal(shortcut.registered.size, 0);
  assert.deepEqual(manager.registered(), []);
});
