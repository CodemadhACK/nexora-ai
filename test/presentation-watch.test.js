'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createPresentationWatcher, PRESENTING_STATES, pollScript } = require('../presentation-watch');

/** A stand-in for the PowerShell helper, so a test can feed it states. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  child.emitState = (n) => child.stdout.emit('data', `state:${n}\n`);
  return child;
}

function harness({ platform = 'win32', spawnImpl } = {}) {
  const changes = [];
  const logs = [];
  const spawned = [];
  let child = null;

  const watcher = createPresentationWatcher({
    platform,
    spawn: spawnImpl || ((cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      child = fakeChild();
      return child;
    }),
    onChange: (presenting, detail) => changes.push({ presenting, detail }),
    log: (m) => logs.push(m)
  });

  return { watcher, changes, logs, spawned, child: () => child };
}

// ---------------------------------------------------------------------------

test('the presenting states are the four Windows means by "do not interrupt"', () => {
  assert.deepEqual([...PRESENTING_STATES].sort(), [2, 3, 4, 7]);
});

test('it reports entering and leaving a presentation', () => {
  const h = harness();
  h.watcher.start();

  h.child().emitState(5);          // accepting notifications — nothing to report
  assert.deepEqual(h.changes, []);

  h.child().emitState(4);          // presentation mode
  assert.equal(h.changes.length, 1);
  assert.equal(h.changes[0].presenting, true);
  assert.match(h.changes[0].detail, /presentation mode/);
  assert.equal(h.watcher.isPresenting(), true);

  h.child().emitState(5);
  assert.equal(h.changes.length, 2);
  assert.equal(h.changes[1].presenting, false);
  assert.equal(h.watcher.isPresenting(), false);
});

test('every full-screen state counts as presenting', () => {
  for (const state of [2, 3, 4, 7]) {
    const h = harness();
    h.watcher.start();
    h.child().emitState(state);
    assert.equal(h.changes.length, 1, `state ${state} should report`);
    assert.equal(h.changes[0].presenting, true);
  }
});

test('the login screen and quiet time are not presenting', () => {
  const h = harness();
  h.watcher.start();
  h.child().emitState(4);
  h.child().emitState(1);          // not present (login screen)
  assert.equal(h.changes.at(-1).presenting, false);

  h.child().emitState(4);
  h.child().emitState(6);          // quiet time
  assert.equal(h.changes.at(-1).presenting, false);
});

test('an unchanged state is not reported twice', () => {
  const h = harness();
  h.watcher.start();

  h.child().emitState(4);
  h.child().emitState(4);
  h.child().emitState(4);

  assert.equal(h.changes.length, 1, 'the mode should be toggled once, not on every poll');
});

test('output split across chunks is reassembled', () => {
  const h = harness();
  h.watcher.start();

  h.child().stdout.emit('data', 'stat');
  h.child().stdout.emit('data', 'e:4\nstate:');
  assert.equal(h.changes.length, 1);
  assert.equal(h.changes[0].presenting, true);

  h.child().stdout.emit('data', '5\n');
  assert.equal(h.changes.length, 2);
  assert.equal(h.changes[1].presenting, false);
});

test('unparseable output is ignored rather than fatal', () => {
  const h = harness();
  h.watcher.start();

  h.child().stdout.emit('data', 'Add-Type : some warning\nstate:oops\n\n');
  assert.deepEqual(h.changes, []);

  h.child().emitState(4);
  assert.equal(h.changes.length, 1);
});

test('a helper that never emits a newline cannot grow without bound', () => {
  const h = harness();
  h.watcher.start();
  h.child().stdout.emit('data', 'x'.repeat(9000));
  h.child().emitState(4);
  assert.equal(h.changes.length, 1, 'it recovers once a real line arrives');
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test('it spawns one long-lived helper, not one per poll', () => {
  const h = harness();
  h.watcher.start();
  h.watcher.start();
  h.watcher.start();

  assert.equal(h.spawned.length, 1, 'repeated starts must not stack helpers');
  assert.equal(h.watcher.isRunning(), true);
});

test('the helper is launched hidden and without the user profile', () => {
  const h = harness();
  h.watcher.start();

  const { cmd, args, opts } = h.spawned[0];
  assert.equal(cmd, 'powershell.exe');
  assert.ok(args.includes('-NoProfile'), 'a user profile script would slow startup and could fail');
  assert.ok(args.includes('-NonInteractive'));
  assert.equal(opts.windowsHide, true, 'no console window may flash up');
});

test('stopping kills the helper and start can begin again', () => {
  const h = harness();
  h.watcher.start();
  const first = h.child();

  assert.equal(h.watcher.stop(), true);
  assert.equal(first.killed, true);
  assert.equal(h.watcher.isRunning(), false);
  assert.equal(h.watcher.stop(), false, 'stopping twice is harmless');

  h.watcher.start();
  assert.equal(h.spawned.length, 2);
});

test('a helper that dies is noticed rather than left as a phantom', () => {
  const h = harness();
  h.watcher.start();
  h.child().emit('exit', 1);

  assert.equal(h.watcher.isRunning(), false);
  assert.match(h.logs.join('\n'), /exited with code 1/);
});

test('a spawn failure is reported and leaves the watcher stopped', () => {
  const h = harness({ spawnImpl: () => { throw new Error('powershell not found'); } });

  assert.equal(h.watcher.start(), false);
  assert.equal(h.watcher.isRunning(), false);
  assert.match(h.logs.join('\n'), /powershell not found/);
});

test('an exception in the callback cannot kill the watcher', () => {
  const child = fakeChild();
  const logs = [];
  const watcher = createPresentationWatcher({
    platform: 'win32',
    spawn: () => child,
    onChange: () => { throw new Error('handler blew up'); },
    log: (m) => logs.push(m)
  });

  watcher.start();
  assert.doesNotThrow(() => child.emitState(4));
  assert.match(logs.join('\n'), /handler blew up/);
  assert.equal(watcher.isRunning(), true);
});

// ---------------------------------------------------------------------------
// Platform
// ---------------------------------------------------------------------------

test('it does nothing at all off Windows', () => {
  for (const platform of ['darwin', 'linux']) {
    const h = harness({ platform });
    assert.equal(h.watcher.supported, false);
    assert.equal(h.watcher.start(), false);
    assert.equal(h.spawned.length, 0, 'nothing may be spawned on an unsupported platform');
    assert.match(h.logs.join('\n'), /needs Windows/);
  }
});

// ---------------------------------------------------------------------------
// What the helper actually asks
// ---------------------------------------------------------------------------

test('the helper polls the notification-state API and nothing else', () => {
  const script = pollScript(2000);

  assert.match(script, /SHQueryUserNotificationState/);
  assert.match(script, /shell32\.dll/);
  assert.match(script, /Start-Sleep -Milliseconds 2000/);
  // It prints only on change, so the pipe stays quiet between transitions.
  assert.match(script, /if \(\$s -ne \$last\)/);
});

test('the helper touches no capture API and no specific application', () => {
  const script = pollScript(2000).toLowerCase();
  for (const forbidden of ['setwindowdisplayaffinity', 'wda_', 'dwm', 'bitblt', 'printwindow',
                           'teams', 'zoom', 'slack', 'chrome', 'msedge', 'capture']) {
    assert.equal(script.includes(forbidden), false, `the watcher must not reference ${forbidden}`);
  }
});

test('the poll interval has a floor, so a bad setting cannot spin the CPU', () => {
  assert.match(pollScript(0), /Start-Sleep -Milliseconds 500/);
  assert.match(pollScript(-5), /Start-Sleep -Milliseconds 500/);
});
