'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createSafeMode, SAFE_MODE_LABEL } = require('../safe-mode');

/** A controller with every collaborator recorded, so transitions are observable. */
function harness(initial = false, overrides = {}) {
  const calls = { persisted: [], hidden: 0, notified: [], menus: 0, logs: [] };
  const controller = createSafeMode({
    initial,
    persist: (on) => calls.persisted.push(on),
    hideWindow: () => { calls.hidden++; },
    notify: (on) => calls.notified.push(on),
    refreshMenu: () => { calls.menus++; },
    log: (message) => calls.logs.push(message),
    ...overrides
  });
  return { controller, calls };
}

test('starts off, and off means the window may show at launch', () => {
  const { controller, calls } = harness();
  assert.equal(controller.isEnabled(), false);
  assert.equal(controller.shouldShowAtLaunch(), true);
  assert.deepEqual(calls.persisted, []);   // constructing it writes nothing
  assert.equal(calls.hidden, 0);
});

test('a restored preference keeps the window off screen at launch', () => {
  const { controller } = harness(true);
  assert.equal(controller.isEnabled(), true);
  assert.equal(controller.shouldShowAtLaunch(), false);
});

test('enabling hides the window, saves, tells the window and redraws the tray', () => {
  const { controller, calls } = harness(false);

  assert.equal(controller.set(true), true);

  assert.equal(controller.isEnabled(), true);
  assert.equal(calls.hidden, 1);
  assert.deepEqual(calls.persisted, [true]);
  assert.deepEqual(calls.notified, [true]);
  assert.equal(calls.menus, 1);
});

test('disabling never reveals the window on its own', () => {
  const { controller, calls } = harness(true);

  controller.set(false);

  assert.equal(controller.isEnabled(), false);
  assert.equal(calls.hidden, 0, 'disabling must not touch window visibility');
  assert.deepEqual(calls.persisted, [false]);
  assert.deepEqual(calls.notified, [false]);
  assert.equal(calls.menus, 1);
});

test('setting the value it already has does nothing', () => {
  const { controller, calls } = harness(true);

  assert.equal(controller.set(true), true);

  assert.deepEqual(calls.persisted, [], 'no redundant disk write');
  assert.equal(calls.hidden, 0);
  assert.deepEqual(calls.notified, []);
  assert.equal(calls.menus, 0);
});

test('toggle flips the state and survives being destructured', () => {
  const { controller, calls } = harness(false);
  const { toggle, isEnabled } = controller;   // the tray click handler does exactly this

  assert.equal(toggle(), true);
  assert.equal(isEnabled(), true);
  assert.equal(toggle(), false);
  assert.equal(isEnabled(), false);

  assert.deepEqual(calls.persisted, [true, false]);
  assert.deepEqual(calls.notified, [true, false]);
  assert.equal(calls.hidden, 1, 'only the enabling half hides');
});

test('non-boolean input is coerced, so IPC can never wedge it into a third state', () => {
  const { controller } = harness(false);

  controller.set('yes');
  assert.equal(controller.isEnabled(), true);

  controller.set(0);
  assert.equal(controller.isEnabled(), false);

  controller.set(undefined);
  assert.equal(controller.isEnabled(), false);
});

test('sync re-asserts the current state without saving it again', () => {
  const { controller, calls } = harness(true);

  controller.sync();

  assert.equal(calls.hidden, 1);
  assert.deepEqual(calls.notified, [true]);
  assert.equal(calls.menus, 1);
  assert.deepEqual(calls.persisted, []);
});

// --- failures in the plumbing must not take the privacy switch with them -----

test('a failed save still hides the window and flips the state', () => {
  const { controller, calls } = harness(false, {
    persist: () => { throw new Error('disk full'); }
  });

  controller.set(true);

  assert.equal(controller.isEnabled(), true, 'the switch works even if it cannot be remembered');
  assert.equal(calls.hidden, 1);
  assert.deepEqual(calls.notified, [true]);
  assert.equal(calls.menus, 1);
  assert.match(calls.logs.join('\n'), /disk full/);
});

test('a destroyed window does not stop the tray from being redrawn', () => {
  const { controller, calls } = harness(false, {
    hideWindow: () => { throw new Error('Object has been destroyed'); },
    notify: () => { throw new Error('Object has been destroyed'); }
  });

  controller.set(true);

  assert.equal(controller.isEnabled(), true);
  assert.equal(calls.menus, 1, 'the tray is the only status left, so it must still update');
  assert.equal(calls.logs.length, 2);
});

test('it runs with no collaborators supplied at all', () => {
  const bare = createSafeMode();
  assert.equal(bare.isEnabled(), false);
  assert.doesNotThrow(() => bare.toggle());
  assert.equal(bare.isEnabled(), true);
});

// --- persistence across launches --------------------------------------------

test('the preference survives a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-safe-mode-'));
  const file = path.join(dir, 'settings.json');

  // Mirrors how main.js stores it: one key inside the existing settings file.
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).safeMode === true; }
    catch { return false; }
  };
  const write = (on) => {
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    fs.writeFileSync(file, JSON.stringify({ ...stored, safeMode: on }), 'utf8');
  };

  try {
    fs.writeFileSync(file, JSON.stringify({ model: 'gemini-3.8-flash' }), 'utf8');

    const firstRun = createSafeMode({ initial: read(), persist: write });
    assert.equal(firstRun.isEnabled(), false);
    firstRun.set(true);

    const secondRun = createSafeMode({ initial: read(), persist: write });
    assert.equal(secondRun.isEnabled(), true, 'Safe Mode should still be on after a restart');
    assert.equal(secondRun.shouldShowAtLaunch(), false);

    // Neighbouring settings are left alone.
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model, 'gemini-3.8-flash');

    secondRun.set(false);
    assert.equal(createSafeMode({ initial: read() }).isEnabled(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing or corrupt settings file falls back to off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-safe-mode-'));
  const file = path.join(dir, 'settings.json');
  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).safeMode === true; }
    catch { return false; }
  };

  try {
    assert.equal(createSafeMode({ initial: read() }).isEnabled(), false);
    fs.writeFileSync(file, '{ not json', 'utf8');
    assert.equal(createSafeMode({ initial: read() }).isEnabled(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the label is the one the requirements name', () => {
  assert.equal(SAFE_MODE_LABEL, 'Screen Share Safe Mode');
  assert.equal(createSafeMode().label, SAFE_MODE_LABEL);
});
