'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createScreenCapturePrivacy, nativeHandleToString, WDA_EXCLUDEFROMCAPTURE, WDA_NONE } = require('../screen-capture-privacy');

/** Stands in for the BrowserWindow of the labelled test window. */
function fakeWindow(handle = Buffer.from([0x78, 0x56, 0x34, 0x12])) {
  return {
    destroyed: false,
    protection: null,
    setContentProtection(enabled) { this.protection = enabled; },
    isDestroyed() { return this.destroyed; },
    getNativeWindowHandle() { return handle; }
  };
}

function harness(overrides = {}) {
  const calls = [];
  const privacy = createScreenCapturePrivacy({
    platform: 'win32',
    setProtection: (_win, enabled) => { calls.push(enabled); },
    windowsVersion: '10.0.26100',
    ...overrides
  });
  return { privacy, calls, win: fakeWindow() };
}

test('converts Electron HWND buffers to the native decimal handle', () => {
  assert.equal(nativeHandleToString(Buffer.from([0x78, 0x56, 0x34, 0x12])), '305419896');
});

test('enabling privacy asks for content protection on that window', () => {
  const { privacy, calls, win } = harness();
  const result = privacy.enable(win);
  assert.deepEqual(calls, [true]);
  assert.equal(result.excluded, true);
  assert.equal(result.succeeded, true);
  assert.equal(WDA_EXCLUDEFROMCAPTURE, 0x11);
});

test('disabling privacy restores normal capture', () => {
  const { privacy, calls, win } = harness();
  const result = privacy.disable(win);
  assert.deepEqual(calls, [false]);
  assert.equal(result.excluded, false);
  assert.equal(result.succeeded, true);
  assert.equal(WDA_NONE, 0);
});

/**
 * The call has to happen in this process. Windows refuses SetWindowDisplayAffinity
 * on a window the caller does not own, which is why the previous out-of-process
 * helper returned ERROR_ACCESS_DENIED for every window Nexora had. This asserts
 * the real default reaches Electron's own method rather than anything spawned.
 */
test('by default it calls setContentProtection on the window itself', () => {
  const privacy = createScreenCapturePrivacy({ platform: 'win32', windowsVersion: '10.0.26100' });
  const win = fakeWindow();

  assert.equal(privacy.enable(win).succeeded, true);
  assert.equal(win.protection, true);
  privacy.disable(win);
  assert.equal(win.protection, false);
});

test('a missing or destroyed window fails gracefully without touching the API', () => {
  const { privacy, calls, win } = harness();
  win.destroyed = true;

  for (const target of [null, undefined, {}, win]) {
    const result = privacy.enable(target);
    assert.equal(result.succeeded, false);
    assert.match(result.error, /not available/);
  }
  assert.deepEqual(calls, []);
});

test('unsupported platforms report a diagnostic instead of throwing', () => {
  const { privacy, win } = harness({ platform: 'linux' });
  const result = privacy.enable(win);
  assert.equal(result.supported, false);
  assert.equal(result.succeeded, false);
  assert.match(result.error, /only available on Windows/);
});

test('repeated enable and disable calls remain deterministic', () => {
  const { privacy, calls, win } = harness();
  assert.equal(privacy.enable(win).excluded, true);
  assert.equal(privacy.enable(win).excluded, true);
  assert.equal(privacy.disable(win).excluded, false);
  assert.equal(privacy.disable(win).excluded, false);
  assert.deepEqual(calls, [true, true, false, false]);
});

test('cleanup restores normal capture behavior during application shutdown', () => {
  const { privacy, calls, win } = harness();
  privacy.enable(win);
  const result = privacy.cleanup(win);
  assert.equal(result.excluded, false);
  assert.deepEqual(calls, [true, false]);
});

/**
 * cleanup runs on window close and on quit. It can skip the call safely because
 * it only ever skips restoring a window that was never protected.
 */
test('cleanup does nothing for a window that was never protected', () => {
  const { privacy, calls, win } = harness();
  const result = privacy.cleanup(win);
  assert.deepEqual(calls, []);
  assert.equal(result.excluded, false);
  assert.equal(result.succeeded, true);
});

test('an explicit disable always reaches the API, even with nothing recorded', () => {
  // The user's switch stays authoritative: unlike cleanup, it never assumes the
  // window is already in the state we believe it to be.
  const { privacy, calls, win } = harness();
  privacy.disable(win);
  assert.deepEqual(calls, [false]);
});

/**
 * The direction a privacy switch is allowed to be wrong in. A call that failed
 * leaves the true state unknown, and this status object is what the badge in
 * Settings renders, so carrying a previous success forward would put an ON
 * label over a window that may well be on someone's screen share.
 */
test('a failed call never reports a stale ON from an earlier success', () => {
  let broken = false;
  const { privacy, win } = harness({
    setProtection: () => { if (broken) throw new Error('protection refused'); }
  });

  assert.equal(privacy.enable(win).excluded, true);
  broken = true;
  const failed = privacy.enable(win);
  assert.equal(failed.succeeded, false);
  assert.equal(failed.excluded, false, 'a failure must read as "you are visible"');
  assert.match(failed.error, /protection refused/);
  assert.equal(privacy.status().excluded, false);
});

test('the diagnostic status carries the window handle and Windows version', () => {
  const { privacy, win } = harness();
  const result = privacy.enable(win);
  assert.equal(result.hwnd, '305419896');
  assert.equal(result.windowsVersion, '10.0.26100');
  assert.equal(result.supported, true);
});
