'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createPresentationMode, normaliseWindowState, PRESENTATION_LABEL } = require('../presentation-mode');

const BOUNDS = { x: 320, y: 180, width: 900, height: 660 };

/**
 * A controller wired to a fake window, so every transition is observable and the
 * process-stays-alive claim can be checked rather than assumed.
 */
function harness(overrides = {}) {
  const win = {
    visible: true,
    skipTaskbar: false,
    maximized: false,
    bounds: { ...BOUNDS },
    destroyed: false
  };
  const calls = { persisted: [], hidden: 0, shown: [], notified: [], menus: 0, logs: [] };

  const controller = createPresentationMode({
    persist: (enabled, state) => calls.persisted.push({ enabled, state }),
    captureWindow: () => (win.destroyed ? null : { bounds: { ...win.bounds }, maximized: win.maximized }),
    hideWindow: () => { calls.hidden++; win.visible = false; win.skipTaskbar = true; },
    showWindow: (state) => {
      calls.shown.push(state);
      win.visible = true;
      win.skipTaskbar = false;
      if (state && state.bounds) win.bounds = { ...state.bounds };
      win.maximized = !!(state && state.maximized);
    },
    notify: (on) => calls.notified.push(on),
    refreshMenu: () => { calls.menus++; },
    log: (m) => calls.logs.push(m),
    ...overrides
  });

  return { controller, calls, win };
}

// ---------------------------------------------------------------------------
// Enabling
// ---------------------------------------------------------------------------

test('starts off, and off means the window may show at launch', () => {
  const { controller, calls } = harness();
  assert.equal(controller.isEnabled(), false);
  assert.equal(controller.shouldShowAtLaunch(), true);
  assert.deepEqual(calls.persisted, [], 'constructing it writes nothing');
});

test('enabling hides the window, takes it off the taskbar, saves and reports', () => {
  const { controller, calls, win } = harness();

  assert.equal(controller.enable(), true);

  assert.equal(controller.isEnabled(), true);
  assert.equal(win.visible, false, 'the window must be hidden');
  assert.equal(win.skipTaskbar, true, 'and out of the taskbar and alt-tab');
  assert.equal(calls.hidden, 1);
  assert.deepEqual(calls.notified, [true]);
  assert.equal(calls.menus, 1, 'the tray has to report the new state');
  assert.equal(calls.persisted.length, 1);
  assert.equal(calls.persisted[0].enabled, true);
});

test('enabling remembers exactly where the window was', () => {
  const { controller } = harness();
  controller.enable();
  assert.deepEqual(controller.restoreState(), { bounds: BOUNDS, maximized: false });
});

test('enabling twice is a no-op and cannot overwrite the saved position', () => {
  const { controller, calls, win } = harness();
  controller.enable();

  win.bounds = { x: 0, y: 0, width: 10, height: 10 };   // as if something moved it while hidden
  assert.equal(controller.enable(), false);

  assert.equal(calls.hidden, 1, 'no second hide');
  assert.equal(calls.persisted.length, 1, 'no redundant disk write');
  assert.deepEqual(controller.restoreState().bounds, BOUNDS, 'the original position survives');
});

// ---------------------------------------------------------------------------
// Disabling and restoring
// ---------------------------------------------------------------------------

test('disabling restores the window to its previous position', () => {
  const { controller, win } = harness();
  controller.enable();
  win.bounds = { x: -9999, y: -9999, width: 1, height: 1 };   // whatever it was left at

  assert.equal(controller.disable(), true);

  assert.equal(win.visible, true);
  assert.deepEqual(win.bounds, BOUNDS, 'it must come back exactly where it was');
});

test('disabling restores the window to its previous size', () => {
  const { controller, win } = harness();
  win.bounds = { x: 100, y: 120, width: 1280, height: 800 };

  controller.enable();
  win.bounds = { x: 0, y: 0, width: 400, height: 300 };
  controller.disable();

  assert.equal(win.bounds.width, 1280);
  assert.equal(win.bounds.height, 800);
});

test('disabling puts the window back in the taskbar', () => {
  const { controller, win } = harness();
  controller.enable();
  assert.equal(win.skipTaskbar, true);

  controller.disable();
  assert.equal(win.skipTaskbar, false);
});

test('a maximized window comes back maximized', () => {
  const { controller, win } = harness();
  win.maximized = true;

  controller.enable();
  win.maximized = false;
  controller.disable();

  assert.equal(win.maximized, true);
});

test('disabling when it is already off does nothing', () => {
  const { controller, calls } = harness();
  assert.equal(controller.disable(), false);
  assert.deepEqual(calls.shown, []);
  assert.deepEqual(calls.persisted, []);
});

// ---------------------------------------------------------------------------
// Toggling — the hotkey and the tray share this one path
// ---------------------------------------------------------------------------

test('toggle flips the mode, and survives being destructured', () => {
  const { controller, calls, win } = harness();
  const { toggle, isEnabled } = controller;   // the tray click handler does exactly this

  assert.equal(toggle(), true);
  assert.equal(isEnabled(), true);
  assert.equal(win.visible, false);

  assert.equal(toggle(), false);
  assert.equal(isEnabled(), false);
  assert.equal(win.visible, true);
  assert.deepEqual(win.bounds, BOUNDS);

  assert.deepEqual(calls.notified, [true, false]);
  assert.equal(calls.hidden, 1);
  assert.equal(calls.shown.length, 1);
});

test('repeated toggles always land back on the same geometry', () => {
  const { controller, win } = harness();
  for (let i = 0; i < 5; i++) { controller.toggle(); controller.toggle(); }
  assert.equal(controller.isEnabled(), false);
  assert.deepEqual(win.bounds, BOUNDS);
});

test('set() coerces, so IPC can never wedge it into a third state', () => {
  const { controller } = harness();
  controller.set('yes');
  assert.equal(controller.isEnabled(), true);
  controller.set(0);
  assert.equal(controller.isEnabled(), false);
  controller.set(undefined);
  assert.equal(controller.isEnabled(), false);
});

// ---------------------------------------------------------------------------
// The app stays alive
// ---------------------------------------------------------------------------

test('nothing in the mode can close or quit the application', () => {
  // The controller is handed no way to quit — it can hide a window and nothing
  // more. This pins that down so a future refactor cannot slip one in.
  const quitters = [];
  const { controller } = harness({
    quit: () => quitters.push('quit'),
    destroyWindow: () => quitters.push('destroy')
  });

  controller.enable();
  controller.disable();
  assert.deepEqual(quitters, [], 'the mode must never terminate anything');
});

test('state survives while the UI is hidden', () => {
  // Whatever the app was holding is still there when the window comes back: the
  // controller only ever touches window visibility and geometry.
  const session = { history: ['a question', 'an answer'], pendingShot: { data: 'png' } };
  const { controller } = harness();

  controller.enable();
  assert.deepEqual(session.history, ['a question', 'an answer']);
  assert.deepEqual(session.pendingShot, { data: 'png' });

  controller.disable();
  assert.deepEqual(session.history, ['a question', 'an answer']);
  assert.deepEqual(session.pendingShot, { data: 'png' });
});

// ---------------------------------------------------------------------------
// Automatic entry
// ---------------------------------------------------------------------------

test('an automatic entry can be undone automatically', () => {
  const { controller, win } = harness();

  assert.equal(controller.enable({ automatic: true }), true);
  assert.equal(controller.enteredAutomatically(), true);

  assert.equal(controller.disable({ automatic: true }), true);
  assert.equal(win.visible, true);
});

test('a manual entry is never undone by the detector', () => {
  const { controller, win } = harness();
  controller.enable();                       // the user turned it on

  assert.equal(controller.disable({ automatic: true }), false);
  assert.equal(controller.isEnabled(), true);
  assert.equal(win.visible, false, 'the detector must not reopen a window the user hid');

  assert.equal(controller.disable(), true, 'but the user still can');
});

test('turning it off by hand clears the automatic flag', () => {
  const { controller } = harness();
  controller.enable({ automatic: true });
  controller.disable();
  controller.enable();
  assert.equal(controller.enteredAutomatically(), false);
});

// ---------------------------------------------------------------------------
// Restoring across a restart
// ---------------------------------------------------------------------------

test('the mode and the saved geometry survive a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexora-presentation-'));
  const file = path.join(dir, 'settings.json');

  const read = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  };
  const write = (enabled, state) => {
    const stored = read();
    fs.writeFileSync(file, JSON.stringify({
      ...stored,
      presentationMode: enabled,
      presentationBounds: state ? state.bounds : stored.presentationBounds
    }), 'utf8');
  };

  try {
    fs.writeFileSync(file, JSON.stringify({ opacity: 1 }), 'utf8');

    const first = createPresentationMode({
      persist: write,
      captureWindow: () => ({ bounds: BOUNDS, maximized: false })
    });
    first.enable();

    const stored = read();
    assert.equal(stored.presentationMode, true);
    assert.deepEqual(stored.presentationBounds, BOUNDS);
    assert.equal(stored.opacity, 1, 'neighbouring settings are left alone');

    // A fresh launch reads that back.
    let restoredTo = null;
    const second = createPresentationMode({
      initial: stored.presentationMode,
      restore: { bounds: stored.presentationBounds },
      persist: write,
      showWindow: (state) => { restoredTo = state; }
    });

    assert.equal(second.isEnabled(), true);
    assert.equal(second.shouldShowAtLaunch(), false, 'it must not paint the window at startup');

    second.disable();
    assert.deepEqual(restoredTo.bounds, BOUNDS, 'the position survived the restart');
    assert.equal(read().presentationMode, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Failures in the plumbing
// ---------------------------------------------------------------------------

test('a failed save still hides the window and flips the state', () => {
  const { controller, calls, win } = harness({ persist: () => { throw new Error('disk full'); } });

  controller.enable();

  assert.equal(controller.isEnabled(), true, 'the mode works even if it cannot be remembered');
  assert.equal(win.visible, false);
  assert.equal(calls.menus, 1);
  assert.match(calls.logs.join('\n'), /disk full/);
});

test('a destroyed window does not stop the tray from being redrawn', () => {
  const { controller, calls } = harness({
    captureWindow: () => { throw new Error('Object has been destroyed'); },
    hideWindow: () => { throw new Error('Object has been destroyed'); },
    notify: () => { throw new Error('Object has been destroyed'); }
  });

  controller.enable();

  assert.equal(controller.isEnabled(), true);
  assert.equal(calls.menus, 1, 'the tray is the only status left, so it must still update');
  assert.equal(calls.logs.length, 3);
});

test('it runs with no collaborators supplied at all', () => {
  const bare = createPresentationMode();
  assert.equal(bare.isEnabled(), false);
  assert.doesNotThrow(() => bare.toggle());
  assert.equal(bare.isEnabled(), true);
});

test('sync re-asserts the state without saving or moving anything', () => {
  const { controller, calls, win } = harness({ initial: true });

  controller.sync();

  assert.deepEqual(calls.notified, [true], 'the window is told what the state is');
  assert.equal(calls.menus, 1, 'and so is the tray');
  assert.deepEqual(calls.persisted, [], 'but nothing is written');
  assert.equal(calls.hidden, 0, 'and the window is not touched');
  assert.deepEqual(calls.shown, []);
  assert.equal(win.visible, true);
});

// ---------------------------------------------------------------------------
// Geometry validation
// ---------------------------------------------------------------------------

test('nonsense geometry is rejected rather than stored', () => {
  assert.equal(normaliseWindowState(null), null);
  assert.equal(normaliseWindowState({}), null);
  assert.equal(normaliseWindowState({ bounds: { x: 1, y: 2 } }), null);
  assert.equal(normaliseWindowState({ bounds: { x: NaN, y: 0, width: 10, height: 10 } }), null);

  assert.deepEqual(
    normaliseWindowState({ bounds: { x: 1.6, y: 2.4, width: 800.5, height: 600.2 }, maximized: 1 }),
    { bounds: { x: 2, y: 2, width: 801, height: 600 }, maximized: true }
  );
});

test('a window that cannot report its position leaves the last known one intact', () => {
  const { controller } = harness();
  controller.enable();
  controller.disable();

  const stale = controller.restoreState();
  const blind = createPresentationMode({ restore: stale, captureWindow: () => null });
  blind.enable();

  assert.deepEqual(blind.restoreState(), stale);
});

test('the label is the one the tray and settings both show', () => {
  assert.equal(PRESENTATION_LABEL, 'Presentation Mode');
  assert.equal(createPresentationMode().label, PRESENTATION_LABEL);
});
