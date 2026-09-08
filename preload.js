/**
 * Preload — the only bridge between the renderer and the main process.
 *
 * The renderer never sees an API key and cannot make arbitrary IPC calls;
 * everything it is allowed to do is enumerated here.
 */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const INBOUND = new Set([
  'run:event',
  'hotkey:talk',
  'hotkey:screenshot',
  'state:click-through',
  'state:safe-mode',
  'state:presentation',
  'state:privacy',
  'state:app-privacy',
  'state:hotkeys',
  'state:settings',
  'ui:open-settings'
]);

contextBridge.exposeInMainWorld('nexora', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch)
  },

  providers: {
    list: () => ipcRenderer.invoke('providers:list')
  },

  profile: {
    get: () => ipcRenderer.invoke('profile:get'),
    set: (patch) => ipcRenderer.invoke('profile:set', patch),
    import: (field) => ipcRenderer.invoke('profile:import', field)
  },

  key: {
    status: (provider) => ipcRenderer.invoke('key:status', provider),
    set: (provider, value) => ipcRenderer.invoke('key:set', { provider, key: value }),
    clear: (provider) => ipcRenderer.invoke('key:clear', provider)
  },

  ask: {
    send: (payload) => ipcRenderer.invoke('ask:send', payload),
    stop: (requestId) => ipcRenderer.invoke('ask:stop', requestId)
  },

  displays: {
    list: () => ipcRenderer.invoke('displays:list'),
    previews: () => ipcRenderer.invoke('displays:previews'),
    capture: (displayId) => ipcRenderer.invoke('capture:display', displayId)
  },

  safeMode: {
    get: () => ipcRenderer.invoke('safe-mode:get'),
    set: (enabled) => ipcRenderer.invoke('safe-mode:set', enabled),
    toggle: () => ipcRenderer.invoke('safe-mode:toggle')
  },

  presentation: {
    get: () => ipcRenderer.invoke('presentation:get'),
    set: (enabled) => ipcRenderer.invoke('presentation:set', enabled),
    toggle: () => ipcRenderer.invoke('presentation:toggle'),
    setShortcut: (accelerator) => ipcRenderer.invoke('presentation:shortcut', accelerator),
    setAutoEnter: (enabled) => ipcRenderer.invoke('presentation:auto', enabled)
  },

  privacy: {
    get: () => ipcRenderer.invoke('privacy:get'),
    set: (enabled) => ipcRenderer.invoke('privacy:set', enabled),
    open: () => ipcRenderer.invoke('privacy:open'),

    // Nexora's own window, as opposed to the labelled demo window above.
    app: {
      get: () => ipcRenderer.invoke('privacy:app-get'),
      set: (enabled) => ipcRenderer.invoke('privacy:app-set', enabled)
    }
  },

  transcribe: (wavBase64, meta) => ipcRenderer.invoke('transcribe', wavBase64, meta),
  exportMarkdown: (markdown) => ipcRenderer.invoke('export:markdown', markdown),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),

  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    hide: () => ipcRenderer.invoke('window:hide'),
    quit: () => ipcRenderer.invoke('window:quit'),
    setClickThrough: (enable) => ipcRenderer.invoke('window:click-through', enable)
  },

  on: (channel, handler) => {
    if (!INBOUND.has(channel)) return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
