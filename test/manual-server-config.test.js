const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { loadWithMocks } = require('./test-helpers');

function waitForTick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFakeWindow() {
  const fakeWindow = {
    webContents: {
      send: () => {},
      setWindowOpenHandler: () => {},
      on: () => {},
      getURL: () => 'app://index',
    },
    loadFile: () => {},
    isDestroyed: () => false,
    on: () => {},
    once: (_event, cb) => {
      if (typeof cb === 'function') cb();
    },
    isVisible: () => false,
    hide: () => {},
    show: () => {},
    focus: () => {},
    isMinimized: () => false,
    restore: () => {},
    minimize: () => {},
    removeAllListeners: () => {},
  };
  return fakeWindow;
}

function baseElectronMocks(fakeWindow) {
  return {
    app: {
      requestSingleInstanceLock: () => true,
      quit: () => {},
      whenReady: () => Promise.resolve(),
      on: () => {},
      isPackaged: false,
      dock: { hide: () => {}, show: () => {} },
    },
    BrowserWindow: function BrowserWindow() {
      return fakeWindow;
    },
    Menu: { buildFromTemplate: () => ({}) },
    Tray: function Tray() {
      return {
        destroy: () => {},
        setToolTip: () => {},
        setTitle: () => {},
        setContextMenu: () => {},
        setIgnoreDoubleClickEvents: () => {},
      };
    },
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => false,
        resize: () => ({ setTemplateImage: () => {} }),
      }),
      createEmpty: () => ({ isEmpty: () => true }),
    },
    shell: { openExternal: () => {} },
    ipcMain: { handle: () => {} },
    autoUpdater: {
      on: () => {},
      setFeedURL: () => {},
      checkForUpdates: () => {},
      quitAndInstall: () => {},
    },
  };
}

test('manual server bypasses Bonjour for adoption across VLANs', async () => {
  const broadcast = new EventEmitter();
  const adoptionInitCalls = [];
  let bonjourFindCalls = 0;

  const currentProfile = {
    UUID: 'client-uuid',
    Adopted: false,
    ManualServer: { Host: '10.50.0.5', Port: 3000 },
  };

  const fakeWindow = buildFakeWindow();
  const modulePath = path.join(__dirname, '..', 'src', 'main.js');

  loadWithMocks(modulePath, {
    electron: baseElectronMocks(fakeWindow),
    'electron-squirrel-startup': false,
    './Modules/Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {}, success: () => {} }),
    },
    './Modules/Startup': { Manager: { EnsureEnabled: async () => {} } },
    './Modules/Broadcast': { Manager: broadcast },
    './Modules/AppData': {
      Manager: {
        Initialize: () => {},
        GetLogsDirectory: () => '/tmp',
        OpenFolder: () => true,
      },
    },
    './Modules/ProfileManager': {
      Manager: {
        GetProfile: async () => currentProfile,
        UpdateServerEndpoint: async () => {},
        ResetAdopption: async () => {},
      },
    },
    './Modules/Bonjour': {
      Manager: {
        OnFind: () => {
          bonjourFindCalls += 1;
        },
        Stop: async () => {},
      },
    },
    './Modules/AdoptionClient': {
      Manager: {
        Init: async (UUID, IP, Port) => {
          adoptionInitCalls.push([UUID, IP, Port]);
        },
        Terminate: async () => {},
      },
    },
    './Modules/MainClient': {
      Manager: { Init: async () => {}, Terminate: async () => {} },
    },
    './Modules/ProcessMonitor': { Manager: { GetStatus: () => ({ State: 'ok' }) } },
    './Modules/ScriptManager': { Manager: { DeleteScripts: async () => {} } },
    './Modules/Config': { Config: { Application: { Version: '1.0.0' } } },
    './Modules/Utils': { Wait: async () => {} },
    'node:dns': { promises: { lookup: async () => ({ address: '10.50.0.5' }) } },
  });

  await waitForTick(50);

  assert.equal(
    bonjourFindCalls,
    0,
    'Bonjour discovery must not run when a manual server is configured'
  );
  assert.equal(adoptionInitCalls.length, 1);
  assert.deepEqual(adoptionInitCalls[0], ['client-uuid', '10.50.0.5', 3000]);
});

test('manual server recovery reconnects to the configured endpoint without Bonjour', async () => {
  const broadcast = new EventEmitter();
  const mainInitCalls = [];
  let bonjourFindCalls = 0;
  const endpointUpdates = [];

  const currentProfile = {
    UUID: 'client-uuid',
    Adopted: true,
    ManualServer: { Host: '10.50.0.5', Port: 3000 },
    Server: { IP: '10.50.0.5', Port: 3000 },
  };

  const fakeWindow = buildFakeWindow();
  const modulePath = path.join(__dirname, '..', 'src', 'main.js');

  loadWithMocks(modulePath, {
    electron: baseElectronMocks(fakeWindow),
    'electron-squirrel-startup': false,
    './Modules/Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {}, success: () => {} }),
    },
    './Modules/Startup': { Manager: { EnsureEnabled: async () => {} } },
    './Modules/Broadcast': { Manager: broadcast },
    './Modules/AppData': {
      Manager: {
        Initialize: () => {},
        GetLogsDirectory: () => '/tmp',
        OpenFolder: () => true,
      },
    },
    './Modules/ProfileManager': {
      Manager: {
        GetProfile: async () => currentProfile,
        UpdateServerEndpoint: async (IP, Port) => {
          endpointUpdates.push([IP, Port]);
        },
        ResetAdopption: async () => {},
      },
    },
    './Modules/Bonjour': {
      Manager: {
        OnFind: () => {
          bonjourFindCalls += 1;
        },
        Stop: async () => {},
      },
    },
    './Modules/AdoptionClient': {
      Manager: { Init: async () => {}, Terminate: async () => {} },
    },
    './Modules/MainClient': {
      Manager: {
        Init: async (UUID, IP, Port) => {
          mainInitCalls.push([UUID, IP, Port]);
          if (mainInitCalls.length === 1) {
            setTimeout(() => {
              broadcast.emit('ServerConnectFailed', { IP, Port, Error: 'ECONNREFUSED' });
            }, 0);
            return;
          }
          setTimeout(() => {
            broadcast.emit('MainClientConnectionStatus', { State: 'connected', IP, Port });
          }, 0);
        },
        Terminate: async () => {},
      },
    },
    './Modules/ProcessMonitor': { Manager: { GetStatus: () => ({ State: 'ok' }) } },
    './Modules/ScriptManager': { Manager: { DeleteScripts: async () => {} } },
    './Modules/Config': { Config: { Application: { Version: '1.0.0' } } },
    './Modules/Utils': { Wait: async () => {} },
    'node:dns': { promises: { lookup: async () => ({ address: '10.50.0.5' }) } },
  });

  await waitForTick(80);

  assert.equal(bonjourFindCalls, 0, 'recovery must reuse the manual endpoint, not Bonjour');
  assert.equal(mainInitCalls.length >= 2, true);
  assert.deepEqual(mainInitCalls[0], ['client-uuid', '10.50.0.5', 3000]);
  assert.deepEqual(mainInitCalls[1], ['client-uuid', '10.50.0.5', 3000]);
  assert.deepEqual(endpointUpdates, [['10.50.0.5', 3000]]);
});
