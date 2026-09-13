'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * A module missing from `build.files` is invisible until someone installs the
 * packaged app, where it crashes on the first require — the tests all pass and
 * `npm start` works fine, because both read from the source tree. So the check
 * has to happen here.
 */

/** Follows local requires from an entry point and returns every file reached. */
function requireGraph(entries) {
  const seen = new Set();
  const queue = entries.map((e) => path.resolve(ROOT, e));

  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);

    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const resolved = resolveLocal(path.dirname(file), match[1]);
      if (resolved) queue.push(resolved);
    }
  }
  return [...seen];
}

function resolveLocal(from, spec) {
  const base = path.resolve(from, spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Handles the two glob shapes this manifest uses: exact paths and `dir/**\/*`. */
function coveredBy(patterns, relative) {
  const posix = relative.split(path.sep).join('/');
  return patterns.some((pattern) => {
    if (pattern === posix) return true;
    const prefix = pattern.match(/^(.+?)\/\*\*\/\*$/);
    return !!prefix && posix.startsWith(`${prefix[1]}/`);
  });
}

test('every module the app requires at runtime is in build.files', () => {
  const reached = requireGraph([pkg.main, 'preload.js']);
  const missing = reached
    .map((file) => path.relative(ROOT, file))
    .filter((rel) => !coveredBy(pkg.build.files, rel));

  assert.deepEqual(missing, [], `these would be absent from the packaged app: ${missing.join(', ')}`);
});

test('the require graph actually reached the modules it should have', () => {
  // Guards the test above: if the walker silently found nothing, it would pass
  // while checking precisely zero files.
  const reached = requireGraph([pkg.main, 'preload.js']).map((f) => path.relative(ROOT, f).split(path.sep).join('/'));

  for (const expected of [
    'main.js', 'safe-mode.js', 'tray-menu.js', 'hotkeys.js', 'tray-icon.js',
    'credentials.js', 'displays.js', 'agents.js', 'prompts.js', 'settings-schema.js',
    'providers/index.js', 'providers/gemini.js', 'providers/openai.js', 'providers/shared.js'
  ]) {
    assert.ok(reached.includes(expected), `the walker should have reached ${expected}`);
  }
});

test('the files the renderer loads are packaged too', () => {
  // index.html is loaded by BrowserWindow and pulls renderer.js via a script tag,
  // so neither shows up in the require graph.
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);

  assert.deepEqual(scripts, ['audio-dsp.js', 'voice-turn.js', 'markdown.js', 'highlight.min.js', 'renderer.js']);
  for (const asset of ['index.html', ...scripts, 'capture-privacy-test.html', 'capture-privacy-demo.js']) {
    assert.ok(coveredBy(pkg.build.files, asset), `${asset} must be packaged`);
  }
});

test('the audio worklet is packaged, though nothing requires or imports it', () => {
  // It is fetched at runtime by audioWorklet.addModule, so neither the require
  // graph nor the script tags in index.html would ever mention it.
  const renderer = fs.readFileSync(path.join(ROOT, 'renderer.js'), 'utf8');
  assert.match(renderer, /addModule\('audio-worklet\.js'\)/);
  assert.ok(coveredBy(pkg.build.files, 'audio-worklet.js'),
    'without this the microphone silently drops to the fallback path in a packaged build');
});

test('build.files lists nothing that no longer exists', () => {
  for (const pattern of pkg.build.files) {
    const target = pattern.replace(/\/\*\*\/\*$/, '');
    assert.ok(fs.existsSync(path.join(ROOT, target)), `build.files points at a missing path: ${pattern}`);
  }
});

test('the icons the manifest references are present and non-trivial', () => {
  for (const icon of ['icon.png', 'icon.ico', 'icon.icns']) {
    const file = path.join(ROOT, icon);
    assert.ok(fs.existsSync(file), `${icon} is referenced by the build config`);
    assert.ok(fs.statSync(file).size > 1024, `${icon} looks empty`);
  }
});

test('the app is branded consistently in the manifest', () => {
  assert.equal(pkg.name, 'nexora-ai');
  assert.equal(pkg.productName, 'Nexora AI');
  assert.equal(pkg.build.productName, 'Nexora AI');
  assert.match(pkg.build.appId, /nexora/);

  const stale = JSON.stringify(pkg).match(/angel/i);
  assert.equal(stale, null, 'package.json still mentions the old product name');
});
