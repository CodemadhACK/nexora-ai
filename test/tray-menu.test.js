'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTrayTemplate, safeModeStatusLabel, presentationStatusLabel, trayTooltip
} = require('../tray-menu');
const { createSafeMode } = require('../safe-mode');
const { createPresentationMode } = require('../presentation-mode');

const itemsLabelled = (template, label) => template.filter((i) => i.label === label);
const find = (template, label) => template.find((i) => i.label === label);
const startingWith = (template, prefix) => template.find((i) => (i.label || '').startsWith(prefix));

test('the menu carries an item called exactly "Screen Share Safe Mode"', () => {
  const template = buildTrayTemplate({ safeMode: false }, {});
  const matches = itemsLabelled(template, 'Screen Share Safe Mode');

  assert.equal(matches.length, 1);
  assert.equal(matches[0].type, 'checkbox');
});

test('the checkbox mirrors the current state', () => {
  assert.equal(find(buildTrayTemplate({ safeMode: false }), 'Screen Share Safe Mode').checked, false);
  assert.equal(find(buildTrayTemplate({ safeMode: true }), 'Screen Share Safe Mode').checked, true);
});

test('both mode statuses sit at the top of the menu and state ON or OFF', () => {
  const off = buildTrayTemplate({ safeMode: false, presentation: false });
  const on = buildTrayTemplate({ safeMode: true, presentation: true });

  assert.equal(off[0].label, '○ Presentation Mode: OFF');
  assert.equal(off[1].label, '○ Screen Share Safe Mode: OFF');
  assert.equal(on[0].label, '● Presentation Mode: ON');
  assert.equal(on[1].label, '● Screen Share Safe Mode: ON');

  // They report; the checkboxes below them act.
  for (const item of [off[0], off[1]]) {
    assert.equal(item.enabled, false);
    assert.equal(item.click, undefined);
  }
});

// ---------------------------------------------------------------------------
// Presentation Mode
// ---------------------------------------------------------------------------

test('the menu carries an item called exactly "Presentation Mode", with its shortcut', () => {
  const template = buildTrayTemplate({ presentation: false });
  const item = startingWith(template, 'Presentation Mode');

  assert.ok(item);
  assert.equal(item.type, 'checkbox');
  assert.match(item.label, /Ctrl\+Shift\+Space|Cmd\+Shift\+Space/);
});

test('the Presentation Mode label follows a rebound shortcut', () => {
  const template = buildTrayTemplate({ presentationShortcut: 'CommandOrControl+Alt+P' });
  assert.match(startingWith(template, 'Presentation Mode').label, /Ctrl\+Alt\+P|Cmd\+Alt\+P/);
});

test('the Presentation Mode checkbox mirrors the current state', () => {
  assert.equal(startingWith(buildTrayTemplate({ presentation: false }), 'Presentation Mode').checked, false);
  assert.equal(startingWith(buildTrayTemplate({ presentation: true }), 'Presentation Mode').checked, true);
});

test('toggling from the tray flips the mode and the redrawn menu reflects it', () => {
  let state = { presentation: false };
  let template = null;
  const window = { visible: true };

  const controller = createPresentationMode({
    persist: (on) => { state = { ...state, presentation: on }; },
    captureWindow: () => ({ bounds: { x: 1, y: 2, width: 800, height: 600 }, maximized: false }),
    hideWindow: () => { window.visible = false; },
    showWindow: () => { window.visible = true; },
    refreshMenu: () => { template = buildTrayTemplate(state, actions); }
  });
  const actions = { togglePresentation: () => controller.toggle() };

  template = buildTrayTemplate(state, actions);
  startingWith(template, 'Presentation Mode').click();

  assert.equal(controller.isEnabled(), true);
  assert.equal(window.visible, false, 'the tray toggle really hides the window');
  assert.equal(template[0].label, '● Presentation Mode: ON');
  assert.equal(startingWith(template, 'Presentation Mode').checked, true);

  startingWith(template, 'Presentation Mode').click();

  assert.equal(controller.isEnabled(), false);
  assert.equal(window.visible, true, 'and brings it back');
  assert.equal(template[0].label, '○ Presentation Mode: OFF');
});

test('Show Assistant and Quit are plain, always-available actions', () => {
  const seen = [];
  const template = buildTrayTemplate({ presentation: true }, {
    showAssistant: () => seen.push('show'),
    quit: () => seen.push('quit')
  });

  const show = find(template, 'Show Assistant');
  const quit = find(template, 'Quit Nexora');

  assert.ok(show, 'the tray must always offer a way back to the window');
  assert.equal(show.type, undefined, 'it is an action, not a checkbox');
  show.click();
  quit.click();

  assert.deepEqual(seen, ['show', 'quit']);
});

test('clicking the Safe Mode item toggles it, and the redrawn menu reflects that', () => {
  let state = { safeMode: false, clickThrough: false, alwaysOnTop: true };
  let template = null;

  const controller = createSafeMode({
    initial: false,
    persist: (on) => { state = { ...state, safeMode: on }; },
    refreshMenu: () => { template = buildTrayTemplate(state, actions); }
  });
  const actions = { toggleSafeMode: () => controller.toggle() };

  template = buildTrayTemplate(state, actions);
  find(template, 'Screen Share Safe Mode').click();

  assert.equal(controller.isEnabled(), true);
  assert.equal(template[1].label, '● Screen Share Safe Mode: ON');
  assert.equal(find(template, 'Screen Share Safe Mode').checked, true);

  find(template, 'Screen Share Safe Mode').click();

  assert.equal(controller.isEnabled(), false);
  assert.equal(template[1].label, '○ Screen Share Safe Mode: OFF');
  assert.equal(find(template, 'Screen Share Safe Mode').checked, false);
});

test('the two modes report independently', () => {
  const template = buildTrayTemplate({ presentation: true, safeMode: false });
  assert.equal(template[0].label, '● Presentation Mode: ON');
  assert.equal(template[1].label, '○ Screen Share Safe Mode: OFF');
  assert.equal(startingWith(template, 'Presentation Mode').checked, true);
  assert.equal(find(template, 'Screen Share Safe Mode').checked, false);
});

test('the pre-existing items are still there and still wired', () => {
  const seen = [];
  const template = buildTrayTemplate(
    { clickThrough: true, alwaysOnTop: true },
    {
      toggleClickThrough: () => seen.push('click-through'),
      toggleAlwaysOnTop: () => seen.push('always-on-top'),
      openSettings: () => seen.push('settings'),
      openDataFolder: () => seen.push('data-folder'),
      quit: () => seen.push('quit')
    }
  );

  const clickThrough = template.find((i) => (i.label || '').startsWith('Click-through mode'));
  assert.equal(clickThrough.checked, true);
  clickThrough.click();

  const onTop = find(template, 'Always on top');
  assert.equal(onTop.checked, true);
  onTop.click();

  find(template, 'Settings…').click();
  find(template, 'Open data folder').click();
  find(template, 'Quit Nexora').click();

  assert.deepEqual(seen, ['click-through', 'always-on-top', 'settings', 'data-folder', 'quit']);
});

test('two-agent mode has a checkbox that mirrors and toggles state', () => {
  let toggled = 0;
  const off = find(buildTrayTemplate({ twoAgents: false }), 'Two-agent mode');
  const on = find(buildTrayTemplate({ twoAgents: true }, { toggleTwoAgents: () => { toggled++; } }), 'Two-agent mode');

  assert.equal(off.type, 'checkbox');
  assert.equal(off.checked, false);
  assert.equal(on.checked, true);

  on.click();
  assert.equal(toggled, 1);
});

test('every actionable item has a handler even when none are supplied', () => {
  const template = buildTrayTemplate({});
  for (const item of template) {
    if (item.type === 'separator' || item.enabled === false) continue;
    assert.equal(typeof item.click, 'function', `${item.label} needs a handler`);
    assert.doesNotThrow(() => item.click());
  }
});

test('the tooltip names whichever modes are on, and always the product', () => {
  assert.match(trayTooltip(false, false), /^Nexora/);
  assert.doesNotMatch(trayTooltip(false, false), /ON/);

  assert.match(trayTooltip(true, false), /Safe Mode is ON/);
  assert.match(trayTooltip(false, true), /Presentation Mode is ON/);
  assert.match(trayTooltip(false, true), /off the taskbar/);

  const both = trayTooltip(true, true);
  assert.match(both, /Presentation Mode is ON/);
  assert.match(both, /Safe Mode is ON/);
});

test('the status labels are derived from state, not stored twice', () => {
  assert.equal(presentationStatusLabel(true), '● Presentation Mode: ON');
  assert.equal(presentationStatusLabel(false), '○ Presentation Mode: OFF');
});

test('nothing in the menu still carries the old product name', () => {
  const labels = buildTrayTemplate({ safeMode: true, twoAgents: true }).map((i) => i.label || '').join(' | ');
  assert.doesNotMatch(labels, /angel/i);
});

test('the status label is derived from the state, not stored twice', () => {
  assert.equal(safeModeStatusLabel(true), '● Screen Share Safe Mode: ON');
  assert.equal(safeModeStatusLabel(false), '○ Screen Share Safe Mode: OFF');
});

test('the menu offers nothing that reaches outside Nexora', () => {
  // Safe Mode is local only: no menu affordance should imply otherwise.
  const labels = buildTrayTemplate({ safeMode: true }).map((i) => i.label || '').join(' | ');
  assert.doesNotMatch(labels, /teams|zoom|meet|slack|browser|capture|record/i);
});
