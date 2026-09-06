/**
 * Optional: notices when you have entered a presentation or a full-screen app,
 * so Presentation Mode can turn itself on.
 *
 * This asks Windows the one question it already answers for everybody:
 * `SHQueryUserNotificationState`, the API that decides whether it is polite to
 * pop a toast right now. It reports states like "a full-screen application is
 * running" and "presentation settings are applied".
 *
 * Two things it is not, deliberately:
 *  - It is not a screen-capture API. It reads a notification-politeness flag and
 *    conceals nothing from anyone.
 *  - It does not look at which application is running. It cannot tell PowerPoint
 *    from a game, and nothing here is keyed to Teams, Zoom, Meet or Slack.
 *
 * There is no native module here, and no dependency. The query is polled from a
 * single long-lived PowerShell helper that only prints when the state changes —
 * and the helper is only ever started when the user has opted in, so the default
 * configuration pays nothing for this.
 */

'use strict';

/**
 * QUERY_USER_NOTIFICATION_STATE. The four that mean "do not interrupt":
 *   2 QUNS_BUSY                    full-screen app running, or presentation settings on
 *   3 QUNS_RUNNING_D3D_FULL_SCREEN a full-screen D3D app
 *   4 QUNS_PRESENTATION_MODE       presentation mode
 *   7 QUNS_APP                     a full-screen app has focus (Windows 8+)
 * The rest — login screen, quiet time, accepting notifications — are not presenting.
 */
const PRESENTING_STATES = new Set([2, 3, 4, 7]);

const STATE_NAMES = {
  1: 'not present', 2: 'busy / full screen', 3: 'full-screen D3D',
  4: 'presentation mode', 5: 'accepting notifications', 6: 'quiet time', 7: 'full-screen app'
};

/**
 * Prints `state:<n>` once, then again only when it changes. Keeping the loop
 * inside one process is the whole point: re-spawning a shell every few seconds
 * to ask a one-word question would cost far more than the answer is worth.
 */
function pollScript(intervalMs) {
  return [
    '$ErrorActionPreference = "Stop"',
    'Add-Type -Namespace NexoraPresentation -Name Shell -MemberDefinition \'[System.Runtime.InteropServices.DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);\'',
    '$last = -1',
    'while ($true) {',
    '  $s = 0',
    '  [void][NexoraPresentation.Shell]::SHQueryUserNotificationState([ref]$s)',
    '  if ($s -ne $last) { $last = $s; [Console]::Out.WriteLine("state:$s"); [Console]::Out.Flush() }',
    `  Start-Sleep -Milliseconds ${Math.max(500, Math.round(intervalMs))}`,
    '}'
  ].join('\n');
}

/**
 * @param {object}   deps
 * @param {Function} deps.spawn      child_process.spawn, or a stand-in
 * @param {Function} deps.onChange   (presenting: boolean, detail: string) => void
 * @param {string}   [deps.platform] defaults to the host platform
 */
function createPresentationWatcher({
  spawn,
  onChange = () => {},
  platform = process.platform,
  intervalMs = 2000,
  log = () => {}
} = {}) {
  const supported = platform === 'win32';
  let child = null;
  let buffer = '';
  let presenting = false;

  function handleLine(line) {
    const match = /^state:(\d+)$/.exec(line.trim());
    if (!match) return;

    const state = Number(match[1]);
    const next = PRESENTING_STATES.has(state);
    if (next === presenting) return;

    presenting = next;
    try {
      onChange(presenting, STATE_NAMES[state] || `state ${state}`);
    } catch (err) {
      log(`presentation watcher callback failed: ${(err && err.message) || err}`);
    }
  }

  function consume(chunk) {
    buffer += String(chunk);
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      handleLine(line);
    }
    // A helper that somehow never emits a newline must not grow forever.
    if (buffer.length > 4096) buffer = '';
  }

  function start() {
    if (!supported) {
      log('automatic Presentation Mode needs Windows — leaving it off.');
      return false;
    }
    if (child) return true;

    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-Command', pollScript(intervalMs)
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      log(`could not start the presentation watcher: ${(err && err.message) || err}`);
      child = null;
      return false;
    }

    buffer = '';
    presenting = false;

    child.stdout.on('data', consume);
    child.stderr.on('data', (d) => log(`presentation watcher: ${String(d).trim()}`));
    child.on('error', (err) => {
      log(`presentation watcher failed: ${(err && err.message) || err}`);
      child = null;
    });
    child.on('exit', (code) => {
      if (code) log(`presentation watcher exited with code ${code}`);
      child = null;
    });

    return true;
  }

  function stop() {
    if (!child) return false;
    const dying = child;
    child = null;
    // If the mode was on because of the watcher, the caller decides what to do
    // about that; stopping the watcher only stops the watching.
    presenting = false;
    try { dying.kill(); } catch (err) { log(`could not stop the presentation watcher: ${err.message}`); }
    return true;
  }

  return {
    supported,
    start, stop,
    isRunning: () => !!child,
    isPresenting: () => presenting
  };
}

module.exports = { createPresentationWatcher, PRESENTING_STATES, STATE_NAMES, pollScript };
