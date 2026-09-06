'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function sourceFiles() {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) return [];
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
  return walk(ROOT).filter((f) => /\.(js|html|json|md)$/.test(f));
}

/**
 * Invisible characters in source are a trap: they survive copy-paste, break
 * JSON.parse or a regex depending on where they land, and give no clue in a
 * diff. Anywhere one is genuinely needed it should be written as an explicit
 * escape or String.fromCharCode, both of which a reader can see.
 */
test('no source file contains an invisible control character', () => {
  const offenders = [];

  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const invisible = code < 9 || (code >= 14 && code < 32) || code === 0xfeff;
      if (invisible) {
        offenders.push(`${path.relative(ROOT, file)} @${i} (U+${code.toString(16).padStart(4, '0')})`);
        break;
      }
    }
  }

  assert.deepEqual(offenders, [], `write these as escapes instead: ${offenders.join(', ')}`);
});

test('no settings or profile file is committed alongside the source', () => {
  // These live in the app's user-data folder. A stray copy in the repo would be
  // a real risk, since one of them sits next to an API key.
  for (const leak of ['settings.json', 'profile.json', 'gemini.key', 'openai.key']) {
    assert.equal(fs.existsSync(path.join(ROOT, leak)), false, `${leak} does not belong in the project directory`);
  }
});

/**
 * The rename is only done when the old name is gone from everything the user
 * sees. main.js is exempt: it names the previous data folder on purpose, to
 * carry settings and the API key across the rename.
 */
test('the old product name survives only where migration needs it', () => {
  const userFacing = ['index.html', 'renderer.js', 'preload.js', 'tray-menu.js', 'prompts.js',
                      'agents.js', 'displays.js', 'credentials.js', 'settings-schema.js',
                      'hotkeys.js', 'safe-mode.js', 'presentation-mode.js',
                      'presentation-watch.js', 'providers/index.js'];

  for (const file of userFacing) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(/angel/i.test(text), false, `${file} still mentions the old product name`);
  }
});

test('main.js mentions the old name only as the legacy data folder', () => {
  const text = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const mentions = [...text.matchAll(/.*angel.*/gi)].map((m) => m[0].trim());

  assert.ok(mentions.length > 0, 'the migration constant should still be there');
  for (const line of mentions) {
    assert.match(line, /LEGACY_APP_DIR|previous install|before Nexora/i,
      `unexpected reference to the old name: ${line}`);
  }
});

test('the renderer reaches the main process only through the preload bridge', () => {
  const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');

  assert.equal(/require\s*\(/.test(renderer), false, 'the renderer must not require modules directly');
  assert.equal(/ipcRenderer/.test(renderer), false, 'the renderer must not touch ipcRenderer');
  assert.match(renderer, /window\.nexora/, 'it should use the exposed bridge');
});

test('no network call can originate in the renderer', () => {
  // Every provider call lives in the main process precisely so a key never
  // reaches page context.
  const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
  assert.equal(/\bfetch\s*\(/.test(renderer), false, 'the renderer must not make network calls');
  assert.equal(/XMLHttpRequest|WebSocket/.test(renderer), false);
});

test('the bridge offers no way to read a stored key back', () => {
  // The renderer can save, clear and ask about a key. It can never retrieve
  // one — so a compromised page has nothing to exfiltrate.
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const channels = [...preload.matchAll(/invoke\('(key:[^']+)'/g)].map((m) => m[1]).sort();

  assert.deepEqual(channels, ['key:clear', 'key:set', 'key:status']);
});

test('every channel the preload invokes has a handler in main', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

  const invoked = new Set([...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]));
  const handled = new Set([...main.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]));

  assert.ok(invoked.size > 15, `expected a real surface, found ${invoked.size} channels`);
  const orphans = [...invoked].filter((c) => !handled.has(c));
  assert.deepEqual(orphans, [], `the renderer would hang on these: ${orphans.join(', ')}`);
});

test('every channel main sends to the window is on the inbound allowlist', () => {
  const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

  const allowed = new Set(
    [...(/const INBOUND = new Set\(\[([\s\S]*?)\]\)/.exec(preload)[1]).matchAll(/'([^']+)'/g)].map((m) => m[1])
  );
  const sent = new Set([...main.matchAll(/sendToWindow\('([^']+)'/g)].map((m) => m[1]));

  assert.ok(sent.size > 0);
  const blocked = [...sent].filter((c) => !allowed.has(c));
  assert.deepEqual(blocked, [], `these would be silently dropped by the bridge: ${blocked.join(', ')}`);
});

/**
 * The promise both modes make. Neither may reach for the APIs that hide a window
 * from capture or single out a conferencing app — the whole point is that they
 * simply are not on screen.
 */
test('nothing in the app touches a screen-capture or concealment API', () => {
  const forbidden = [
    'setContentProtection',      // Electron's "exclude me from capture"
    'SetWindowDisplayAffinity',  // the Win32 equivalent
    'WDA_EXCLUDEFROMCAPTURE',
    'WDA_MONITOR'
  ];

  for (const file of sourceFiles()) {
    if (/[\\/]test[\\/]|README\.md$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const api of forbidden) {
      assert.equal(text.includes(api), false, `${path.relative(ROOT, file)} must not use ${api}`);
    }
  }
});

test('no mode is keyed to a particular conferencing application', () => {
  const named = /\b(teams|zoom|webex|slack|google ?meet)\b/i;

  for (const file of ['presentation-mode.js', 'presentation-watch.js', 'safe-mode.js', 'main.js']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // Mentions are fine in a comment saying we do NOT target them; code is not.
    const code = text.split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    assert.equal(named.test(code), false, `${file} names a conferencing app outside a comment`);
  }
});

test('the page keeps a strict content security policy', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const csp = /content="([^"]*default-src[^"]*)"/.exec(html);

  assert.ok(csp, 'index.html should carry a CSP meta tag');
  assert.match(csp[1], /default-src 'none'/);
  assert.match(csp[1], /script-src 'self'/, 'no remote or inline scripts');
  assert.match(csp[1], /img-src 'self' data:/, 'screenshots arrive as data URIs');
});
