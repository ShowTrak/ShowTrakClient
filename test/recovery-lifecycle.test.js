const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { loadWithMocks } = require('./test-helpers');

function waitForTick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('main process recovery re-discovers server and updates saved endpoint', async () => {
  const broadcast = new EventEmitter();
  const initCalls = [];
  const profileReads = [];
  const profileUpdates = [];

  const baseProfile = {
    UUID: 'client-uuid',
    Adopted: true,
    Server: {
      IP: '10.0.0.10',
      Port: 3000,
      ServerIdentity: 'server-token-1',
    },
  };

  let currentProfile = JSON.parse(JSON.stringify(baseProfile));

  const fakeWindow = {
    destroyed: false,
    visible: false,
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
    show: () => {
      fakeWindow.visible = true;
    },
    focus: () => {},
    isMinimized: () => false,
    restore: () => {},
    minimize: () => {},
    removeAllListeners: () => {},
  };

  const modulePath = path.join(__dirname, '..', 'src', 'main.js');

  loadWithMocks(modulePath, {
    electron: {
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
      Menu: {
        buildFromTemplate: () => ({}),
      },
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
    },
    'electron-squirrel-startup': false,
    './Modules/Logger': {
      CreateLogger: () => ({
        log: () => {},
        warn: () => {},
        error: () => {},
        success: () => {},
      }),
    },
    './Modules/Startup': {
      Manager: { EnsureEnabled: async () => {} },
    },
    './Modules/Broadcast': {
      Manager: broadcast,
    },
    './Modules/AppData': {
      Manager: {
        Initialize: () => {},
        GetLogsDirectory: () => '/tmp',
        OpenFolder: () => true,
      },
    },
    './Modules/ProfileManager': {
      Manager: {
        GetProfile: async () => {
          profileReads.push({ ...currentProfile });
          return currentProfile;
        },
        UpdateServerEndpoint: async (IP, Port) => {
          currentProfile = {
            ...currentProfile,
            Server: {
              ...currentProfile.Server,
              IP,
              Port,
            },
          };
          profileUpdates.push([IP, Port]);
        },
        ResetAdopption: async () => {
          currentProfile = { UUID: currentProfile.UUID, Adopted: false };
        },
      },
    },
    './Modules/Bonjour': {
      Manager: {
        OnFind: (cb) => {
          setTimeout(() => {
            cb({
              host: 'showtrak.local',
              port: 3000,
              addresses: ['10.0.0.99'],
              txt: { ServerIdentity: 'server-token-1' },
            });
          }, 0);
        },
        Stop: async () => {},
      },
    },
    './Modules/AdoptionClient': {
      Manager: {
        Init: async () => {},
        Terminate: async () => {},
      },
    },
    './Modules/MainClient': {
      Manager: {
        Init: async (UUID, IP, Port) => {
          initCalls.push([UUID, IP, Port]);
          if (IP === '10.0.0.10') {
            setTimeout(() => {
              broadcast.emit('ServerConnectFailed', {
                IP,
                Port,
                Error: 'ECONNREFUSED',
              });
            }, 0);
            return;
          }

          setTimeout(() => {
            broadcast.emit('MainClientConnectionStatus', {
              State: 'connected',
              IP,
              Port,
            });
          }, 0);
        },
        Terminate: async () => {},
      },
    },
    './Modules/ProcessMonitor': {
      Manager: {
        GetStatus: () => ({ State: 'ok' }),
      },
    },
    './Modules/Config': {
      Config: {
        Application: {
          Version: '1.0.0',
        },
      },
    },
    './Modules/Utils': {
      Wait: async () => {},
    },
    'node:dns': {
      promises: {
        lookup: async () => ({ address: '10.0.0.99' }),
      },
    },
  });

  await waitForTick(50);

  assert.equal(initCalls.length >= 2, true);
  assert.deepEqual(initCalls[0], ['client-uuid', '10.0.0.10', 3000]);
  assert.deepEqual(initCalls[1], ['client-uuid', '10.0.0.99', 3000]);
  assert.deepEqual(profileUpdates, [['10.0.0.99', 3000]]);
  assert.equal(profileReads.length >= 2, true);
});
