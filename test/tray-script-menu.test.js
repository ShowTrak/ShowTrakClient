const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { loadWithMocks } = require('./test-helpers');

function waitForTick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('tray menu exposes run script submenu and refreshes on ScriptsUpdated', async () => {
  const broadcast = new EventEmitter();
  const trayMenus = [];
  const scriptEntries = [
    {
      Script: { ID: 'script-ready', Name: 'Ready Script' },
      Enabled: true,
      DisabledReason: '',
    },
    {
      Script: { ID: 'script-blocked', Name: 'Blocked Script' },
      Enabled: false,
      DisabledReason: 'No script is configured for this operating system',
    },
  ];

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

  loadWithMocks(path.join(__dirname, '..', 'src', 'main.js'), {
    electron: {
      app: {
        requestSingleInstanceLock: () => true,
        quit: () => {},
        whenReady: () => ({
          then: (callback) => {
            const result = typeof callback === 'function' ? callback() : undefined;
            return Promise.resolve(result);
          },
        }),
        on: () => {},
        isPackaged: false,
        dock: { hide: () => {}, show: () => {} },
      },
      BrowserWindow: function BrowserWindow() {
        return fakeWindow;
      },
      Menu: {
        buildFromTemplate: (template) => template,
      },
      Tray: function Tray() {
        return {
          destroy: () => {},
          setToolTip: () => {},
          setTitle: () => {},
          setContextMenu: (menu) => {
            trayMenus.push(menu);
          },
          setIgnoreDoubleClickEvents: () => {},
        };
      },
      nativeImage: {
        createFromPath: () => ({
          isEmpty: () => false,
          resize: () => ({
            isEmpty: () => false,
            setTemplateImage: () => {},
          }),
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
        GetProfile: async () => ({
          Adopted: true,
          UUID: 'client-uuid',
          Server: { IP: '10.0.0.10', Port: 3000 },
        }),
      },
    },
    './Modules/Bonjour': {
      Manager: {
        Stop: async () => {},
        OnFind: () => {},
      },
    },
    './Modules/AdoptionClient': { Manager: { Init: async () => {}, Terminate: async () => {} } },
    './Modules/MainClient': { Manager: { Init: async () => {}, Terminate: async () => {} } },
    './Modules/ProcessMonitor': { Manager: { GetStatus: () => ({ State: 'ok' }) } },
    './Modules/ScriptManager': {
      Manager: {
        GetTrayScriptEntries: () => scriptEntries,
        Execute: async () => [null, true],
        DeleteScripts: async () => {},
      },
    },
    './Modules/Config': { Config: { Application: { Version: '1.0.0' } } },
    './Modules/Utils': { Wait: async () => {} },
  });

  await waitForTick(50);

  assert.equal(trayMenus.length >= 1, true);
  const firstMenu = trayMenus[0];
  const runScriptItem = firstMenu.find((item) => item.label === 'Run Script');
  assert.ok(runScriptItem, 'Run Script submenu should exist');
  assert.equal(Array.isArray(runScriptItem.submenu), true);
  assert.equal(runScriptItem.submenu.length, 2);
  assert.equal(runScriptItem.submenu[0].label, 'Ready Script');
  assert.equal(runScriptItem.submenu[0].enabled, true);
  assert.equal(runScriptItem.submenu[1].label, 'Blocked Script');
  assert.equal(runScriptItem.submenu[1].enabled, false);

  scriptEntries[0] = {
    Script: { ID: 'script-later', Name: 'Later Script' },
    Enabled: true,
    DisabledReason: '',
  };
  scriptEntries.length = 1;
  broadcast.emit('ScriptsUpdated', scriptEntries);
  await waitForTick(10);

  assert.equal(trayMenus.length >= 2, true);
  const refreshedMenu = trayMenus[trayMenus.length - 1];
  const refreshedRunScriptItem = refreshedMenu.find((item) => item.label === 'Run Script');
  assert.equal(refreshedRunScriptItem.submenu.length, 1);
  assert.equal(refreshedRunScriptItem.submenu[0].label, 'Later Script');
  assert.equal(refreshedRunScriptItem.submenu[0].enabled, true);
});
