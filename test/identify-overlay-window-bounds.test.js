const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

function createOverlayHarness({ displays, platform = 'darwin' }) {
  const createdWindows = [];

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.showCount = 0;
      this.boundsHistory = [];
      this.webContents = {
        on: () => {},
      };
      createdWindows.push(this);
    }

    setAlwaysOnTop() {}

    setVisibleOnAllWorkspaces() {}

    loadFile() {}

    once(event, cb) {
      if (event === 'ready-to-show') cb();
    }

    isDestroyed() {
      return this.destroyed;
    }

    setBounds(bounds) {
      this.boundsHistory.push(bounds);
    }

    show() {
      this.showCount += 1;
    }

    destroy() {
      this.destroyed = true;
    }
  }

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'IdentifyOverlay', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    os: {
      platform: () => platform,
    },
    electron: {
      BrowserWindow: FakeBrowserWindow,
      screen: {
        getAllDisplays: () => displays,
        getPrimaryDisplay: () => displays[0],
      },
    },
    '../Logger': {
      CreateLogger: () => ({
        log: () => {},
        warn: () => {},
        error: () => {},
      }),
    },
  });

  return { Manager, createdWindows };
}

test('IdentifyOverlay uses display work area bounds when available', () => {
  const { Manager, createdWindows } = createOverlayHarness({
    displays: [
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 25, width: 1920, height: 1055 },
        scaleFactor: 2,
      },
    ],
  });

  Manager.Show({ Hostname: 'Host', Nickname: 'Nick', IPs: ['10.0.0.10'] });

  assert.equal(createdWindows.length, 1);
  assert.equal(createdWindows[0].options.x, 0);
  assert.equal(createdWindows[0].options.y, 25);
  assert.equal(createdWindows[0].options.width, 1920);
  assert.equal(createdWindows[0].options.height, 1055);
  assert.equal(createdWindows[0].showCount, 1);
  assert.deepEqual(createdWindows[0].boundsHistory[0], {
    x: 0,
    y: 25,
    width: 1920,
    height: 1055,
  });

  Manager.Hide();
  assert.equal(createdWindows[0].destroyed, true);
});

test('IdentifyOverlay falls back to full display bounds when work area is invalid', () => {
  const { Manager, createdWindows } = createOverlayHarness({
    displays: [
      {
        bounds: { x: 100, y: 50, width: 1600, height: 900 },
        workArea: { x: 100, y: 80, width: 0, height: -1 },
        scaleFactor: 1,
      },
    ],
  });

  Manager.Show({ Hostname: 'Host' });

  assert.equal(createdWindows.length, 1);
  assert.equal(createdWindows[0].options.x, 100);
  assert.equal(createdWindows[0].options.y, 50);
  assert.equal(createdWindows[0].options.width, 1600);
  assert.equal(createdWindows[0].options.height, 900);

  Manager.Hide();
});

test('IdentifyOverlay uses full display bounds on non-macOS platforms', () => {
  const { Manager, createdWindows } = createOverlayHarness({
    platform: 'win32',
    displays: [
      {
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 40, width: 1920, height: 1040 },
        scaleFactor: 1,
      },
    ],
  });

  Manager.Show({ Hostname: 'Host' });

  assert.equal(createdWindows.length, 1);
  assert.equal(createdWindows[0].options.x, 0);
  assert.equal(createdWindows[0].options.y, 0);
  assert.equal(createdWindows[0].options.width, 1920);
  assert.equal(createdWindows[0].options.height, 1080);
  assert.deepEqual(createdWindows[0].boundsHistory[0], {
    x: 0,
    y: 0,
    width: 1920,
    height: 1080,
  });

  Manager.Hide();
});
