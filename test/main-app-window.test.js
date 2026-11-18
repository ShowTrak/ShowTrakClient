const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// The config window's lifecycle (src/main/app-window.ts): what every window is
// created with, and what closing it does.

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'main', 'app-window.js');

function load() {
  const windows = [];
  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      windows.push(this);
    }
    static getFocusedWindow() {
      return windows.find((w) => w.focused) || null;
    }
    loadFile() {}
    isDestroyed() {
      return this.destroyed;
    }
    isFocused() {
      return !!this.focused;
    }
    isMinimized() {
      return false;
    }
    isVisible() {
      return this.visible;
    }
    show() {
      this.visible = true;
    }
    focus() {
      this.focused = true;
    }
    hide() {
      this.visible = false;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const mod = loadWithMocks(MODULE_PATH, {
    electron: { app: { isPackaged: true }, BrowserWindow: FakeBrowserWindow },
    '../Modules/Logger': { CreateLogger: () => createSilentLogger() },
    './window-guards': { applyWindowSecurityGuards() {} },
  });
  return { ...mod, windows };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function userClose(window) {
  const event = {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
  window.emit('close', event);
  return event;
}

test('every window is sandboxed, isolated and has no spellchecker', () => {
  const { BASE_WEB_PREFERENCES } = load();
  assert.equal(BASE_WEB_PREFERENCES.sandbox, true);
  assert.equal(BASE_WEB_PREFERENCES.contextIsolation, true);
  assert.equal(BASE_WEB_PREFERENCES.nodeIntegration, false);
  // Hunspell downloads can only fail, slowly, on an air-gapped show network.
  assert.equal(BASE_WEB_PREFERENCES.spellcheck, false);
});

test('in tray mode a closed config window is destroyed, and reopening makes a fresh one', async () => {
  const H = load();
  H.setDestroyOnDismiss(true);
  H.openConfigureWindow();
  const [first] = H.windows;
  assert.equal(first.visible, true);
  const event = userClose(first);
  assert.equal(event.defaultPrevented, true, 'the close is still ours to handle');
  assert.equal(first.visible, false);
  await tick();
  assert.equal(first.destroyed, true, 'its renderer is freed');
  assert.equal(H.hasMainWindow(), false);

  H.openConfigureWindow();
  assert.equal(H.windows.length, 2);
  assert.equal(H.windows[1].visible, true);
});

test('without a tray the window is only hidden, since nothing could reopen it', async () => {
  const H = load();
  H.setDestroyOnDismiss(false);
  H.openConfigureWindow();
  const [win] = H.windows;
  userClose(win);
  await tick();
  assert.equal(win.visible, false);
  assert.equal(win.destroyed, false);
  assert.equal(H.hasMainWindow(), true);
});

test('a close the user did not make (window not focused) leaves the window alone', async () => {
  const H = load();
  H.setDestroyOnDismiss(true);
  H.openConfigureWindow();
  const [win] = H.windows;
  win.focused = false;
  userClose(win);
  await tick();
  assert.equal(win.visible, true);
  assert.equal(win.destroyed, false);
});

test('a quitting app closes the window normally', () => {
  const H = load();
  H.setDestroyOnDismiss(true);
  H.openConfigureWindow();
  H.setAppQuitRequested(true);
  const event = userClose(H.windows[0]);
  assert.equal(event.defaultPrevented, false);
});
