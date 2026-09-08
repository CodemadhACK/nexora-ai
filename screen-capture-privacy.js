'use strict';

/**
 * Screen Capture Privacy, for the labelled test window only.
 *
 * This asks Electron to set content protection on one window, which on Windows
 * 10 2004 and later is SetWindowDisplayAffinity with WDA_EXCLUDEFROMCAPTURE.
 *
 * It used to shell out to a small native helper that called that API itself.
 * That could never have worked: Windows only lets a process set display
 * affinity on its own windows, so the helper — a separate process by
 * definition — got ERROR_ACCESS_DENIED every time, on any window Nexora owned.
 * The call has to come from inside this process, which is what Electron's own
 * method does. The mechanism is deliberately confined to this module: nothing
 * in Nexora may hide the main window from capture, and source-hygiene.test.js
 * enforces that by forbidding these API names everywhere else.
 */

const WDA_NONE = 0;
const WDA_EXCLUDEFROMCAPTURE = 0x11;

function nativeHandleToString(handle) {
  if (Buffer.isBuffer(handle)) {
    // Electron hands the HWND over as a little-endian pointer — 8 bytes on x64,
    // 4 on x86 — so read it in one call instead of walking the bytes. The loop
    // stays for the odd length neither reader accepts.
    if (handle.length >= 8) return handle.readBigUInt64LE(0).toString();
    if (handle.length === 4) return String(handle.readUInt32LE(0));
    let value = 0n;
    for (let i = handle.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(handle[i]);
    return value.toString();
  }
  return handle == null ? null : String(handle);
}

function createScreenCapturePrivacy({
  platform = process.platform,
  // Injected so the whole service is testable without Electron, and so a test
  // can make the call fail without needing a real window to fail on.
  setProtection = (win, enabled) => win.setContentProtection(enabled),
  windowsVersion = typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : null,
  log = () => {}
} = {}) {
  let last = {
    supported: platform === 'win32',
    hwnd: null,
    excluded: false,
    succeeded: false,
    error: platform === 'win32' ? null : 'Screen Capture Privacy is only available on Windows.',
    windowsVersion: platform === 'win32' ? windowsVersion : null
  };

  // Which windows this process actually protected. A WeakSet because the value
  // is a BrowserWindow: holding it strongly would keep a closed window alive.
  const excludedWindows = new WeakSet();

  function usable(win) {
    return !!win
      && typeof win.setContentProtection === 'function'
      && !(typeof win.isDestroyed === 'function' && win.isDestroyed());
  }

  // Purely diagnostic — the test window displays it so a reader can confirm
  // which window was acted on. Nothing depends on it any more.
  function handleText(win) {
    try {
      if (!win || typeof win.getNativeWindowHandle !== 'function') return null;
      return nativeHandleToString(win.getNativeWindowHandle());
    } catch {
      return null;
    }
  }

  function unavailable(win, error) {
    // excluded is forced to false rather than carried over from the last
    // success. A failed call leaves the true state unknown, and the honest
    // default for a privacy switch is "assume you are visible" — a stale ON is
    // exactly how someone ends up trusting a window that is being captured.
    last = { ...last, hwnd: handleText(win), excluded: false, succeeded: false, error };
    log(`[nexora] screen capture privacy unavailable: ${error}`);
    return { ...last };
  }

  function apply(win, excluded) {
    if (platform !== 'win32') return unavailable(win, 'Screen Capture Privacy is only available on Windows.');
    if (!usable(win)) return unavailable(win, 'The privacy test window is not available.');

    try {
      setProtection(win, excluded);
      last = {
        supported: true,
        hwnd: handleText(win),
        excluded,
        succeeded: true,
        error: null,
        windowsVersion
      };
      if (excluded) excludedWindows.add(win);
      else excludedWindows.delete(win);
      return { ...last };
    } catch (err) {
      return unavailable(win, `Content protection could not be applied: ${err.message}`);
    }
  }

  /**
   * The shutdown path, and the reason it is not just an alias for disable():
   * disable() is the user asking, which always reaches the API because their
   * switch has to be authoritative. cleanup() is the app tidying up after
   * itself, where a window it never protected needs nothing done to it — and
   * skipping is safe in the only direction that matters, since it can leave a
   * window hidden but can never expose one.
   */
  function cleanup(win) {
    if (!win || !excludedWindows.has(win)) {
      last = { ...last, hwnd: handleText(win), excluded: false, succeeded: true, error: null };
      return { ...last };
    }
    return apply(win, false);
  }

  return {
    supported: platform === 'win32',
    hwnd: nativeHandleToString,
    enable: (win) => apply(win, true),
    disable: (win) => apply(win, false),
    cleanup,
    status: () => ({ ...last }),
    constants: { WDA_NONE, WDA_EXCLUDEFROMCAPTURE }
  };
}

module.exports = { createScreenCapturePrivacy, nativeHandleToString, WDA_NONE, WDA_EXCLUDEFROMCAPTURE };
