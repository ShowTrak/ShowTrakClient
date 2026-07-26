// src/main/window-guards.ts
//
// The per-window navigation policy, applied to every BrowserWindow the client
// opens. Two rules, both fail-closed:
//
//   1. No window is ever opened in-app. http(s) targets are handed to the OS
//      browser; everything else is dropped. A window.open() that got through
//      would be a frame with no preload allowlist and no CSP.
//   2. The window cannot navigate away from the UI it loaded. Without this, a
//      renderer bug (or injected markup) could point the config window at a
//      remote origin while it still holds the contextBridge API.
//
// Security policy that never ran under test until main.ts was decomposed.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'main', 'window-guards.js');

/** A BrowserWindow test double that records what the guards installed. */
function makeWindow({ currentURL = 'file:///app/dist/UI/index.html', destroyed = false } = {}) {
  const listeners = new Map();
  return {
    isDestroyed: () => destroyed,
    webContents: {
      getURL: () => currentURL,
      setWindowOpenHandler(handler) {
        this._openHandler = handler;
      },
      on(event, handler) {
        listeners.set(event, handler);
      },
      _openHandler: null,
      _emit(event, ...args) {
        const handler = listeners.get(event);
        if (!handler) throw new Error(`no listener bound for ${event}`);
        return handler(...args);
      },
      _hasListener(event) {
        return listeners.has(event);
      },
    },
  };
}

function loadGuards({ opened = [], openExternalThrows = false } = {}) {
  return loadWithMocks(MODULE_PATH, {
    electron: {
      shell: {
        openExternal: (url) => {
          if (openExternalThrows) throw new Error('no browser available');
          opened.push(url);
        },
      },
    },
  });
}

test('an http(s) link is handed to the OS browser and still denied in-app', () => {
  const opened = [];
  const { applyWindowSecurityGuards } = loadGuards({ opened });
  const win = makeWindow();
  applyWindowSecurityGuards(win);

  for (const url of [
    'http://example.com/',
    'https://example.com/docs',
    'HTTPS://EXAMPLE.COM/shouty',
  ]) {
    const result = win.webContents._openHandler({ url });
    assert.deepEqual(result, { action: 'deny' }, `${url} must never open an in-app window`);
  }
  assert.deepEqual(opened, [
    'http://example.com/',
    'https://example.com/docs',
    'HTTPS://EXAMPLE.COM/shouty',
  ]);
});

test('a non-http scheme is denied AND not handed to the OS', () => {
  // file:, javascript:, data: and friends must not reach shell.openExternal —
  // that would be handing an arbitrary URI to the OS handler.
  const opened = [];
  const { applyWindowSecurityGuards } = loadGuards({ opened });
  const win = makeWindow();
  applyWindowSecurityGuards(win);

  for (const url of [
    'file:///etc/passwd',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://example.com/',
    'showtrak://do-something',
    '',
  ]) {
    const result = win.webContents._openHandler({ url });
    assert.deepEqual(result, { action: 'deny' }, `${url} must be denied`);
  }
  assert.deepEqual(opened, [], 'no non-http scheme may be passed to the OS');
});

test('a throwing shell.openExternal still denies rather than falling open', () => {
  const { applyWindowSecurityGuards } = loadGuards({ openExternalThrows: true });
  const win = makeWindow();
  applyWindowSecurityGuards(win);

  const result = win.webContents._openHandler({ url: 'https://example.com/' });
  assert.deepEqual(result, { action: 'deny' });
});

test('navigation to a different URL is prevented', () => {
  const { applyWindowSecurityGuards } = loadGuards();
  const win = makeWindow({ currentURL: 'file:///app/dist/UI/index.html' });
  applyWindowSecurityGuards(win);

  let prevented = false;
  const event = {
    preventDefault: () => {
      prevented = true;
    },
  };
  win.webContents._emit('will-navigate', event, 'https://evil.example.com/');
  assert.equal(prevented, true, 'navigating away from the loaded UI must be blocked');
});

test('navigation to the SAME URL is allowed (a reload is not an escape)', () => {
  const { applyWindowSecurityGuards } = loadGuards();
  const current = 'file:///app/dist/UI/index.html';
  const win = makeWindow({ currentURL: current });
  applyWindowSecurityGuards(win);

  let prevented = false;
  win.webContents._emit(
    'will-navigate',
    {
      preventDefault: () => {
        prevented = true;
      },
    },
    current
  );
  assert.equal(prevented, false);
});

test('an empty current or target URL is left alone', () => {
  // Mid-teardown / pre-load states where there is nothing meaningful to compare.
  const { applyWindowSecurityGuards } = loadGuards();

  for (const [currentURL, target] of [
    ['', 'https://example.com/'],
    ['file:///app/dist/UI/index.html', ''],
  ]) {
    const win = makeWindow({ currentURL });
    applyWindowSecurityGuards(win);
    let prevented = false;
    win.webContents._emit(
      'will-navigate',
      {
        preventDefault: () => {
          prevented = true;
        },
      },
      target
    );
    assert.equal(prevented, false);
  }
});

test('a destroyed or missing window installs no guards and does not throw', () => {
  const { applyWindowSecurityGuards } = loadGuards();

  const destroyed = makeWindow({ destroyed: true });
  applyWindowSecurityGuards(destroyed);
  assert.equal(destroyed.webContents._openHandler, null);
  assert.equal(destroyed.webContents._hasListener('will-navigate'), false);

  applyWindowSecurityGuards(null);
  applyWindowSecurityGuards(undefined);
});
