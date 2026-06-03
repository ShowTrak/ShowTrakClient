const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  ipcMain: RPC,
  autoUpdater: SquirrelUpdater,
} = require('electron');

if (require('electron-squirrel-startup')) app.quit();

const { CreateLogger } = require('./Modules/Logger');
const Logger = CreateLogger('Main');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  Logger.error('Another instance of ShowTrak Client is already running. Exiting this instance.');
  app.quit();
  process.exit(0);
} else {
  Logger.log('Single instance lock acquired');
}

const { Manager: AdoptionClientManager } = require('./Modules/AdoptionClient');
const { Manager: MainClientManager } = require('./Modules/MainClient');
const path = require('path');
const { Manager: BroadcastManager } = require('./Modules/Broadcast');
const { Manager: BonjourManager } = require('./Modules/Bonjour');
const dns = require('node:dns').promises;
const { Manager: AppDataManager } = require('./Modules/AppData');
const { Manager: ProfileManager } = require('./Modules/ProfileManager');
AppDataManager.Initialize();

const { Config } = require('./Modules/Config');
const fs = require('fs');
const os = require('os');

const BASE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
});

let tray;
let mainWindow;

function assertNoArgs(handlerName, args) {
  if (args.length > 0) {
    throw new Error(`${handlerName} does not accept arguments`);
  }
}

function validationErrorPayload(error) {
  const message = error && error.message ? error.message : String(error || 'Invalid request');
  return [message, null];
}

function applyWindowSecurityGuards(windowInstance) {
  if (!windowInstance || windowInstance.isDestroyed()) return;

  windowInstance.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (/^https?:\/\//i.test(url)) {
        shell.openExternal(url);
      }
    } catch (_error) {
      return { action: 'deny' };
    }
    return { action: 'deny' };
  });

  windowInstance.webContents.on('will-navigate', (event, url) => {
    const currentURL = windowInstance.webContents.getURL();
    if (!currentURL || !url) return;
    if (url !== currentURL) {
      event.preventDefault();
    }
  });
}

function sendAppUpdateStatus(payload) {
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('AppUpdate:Status', payload); } catch {}
}
let euAutoUpdater = null;
let squirrelUpdaterInitialized = false;
let autoInstallNext = false; // when true, auto-install on update-downloaded
function isSquirrelWindows() {
  try {
    if (process.platform !== 'win32') return false;
    const execDir = path.dirname(process.execPath);
    const updateExe1 = path.resolve(execDir, '..', 'Update.exe');
    const updateExe2 = path.resolve(execDir, '..', '..', 'Update.exe');
    return fs.existsSync(updateExe1) || fs.existsSync(updateExe2);
  } catch { return false; }
}
function initSquirrelUpdater() {
  if (squirrelUpdaterInitialized) return;
  squirrelUpdaterInitialized = true;
  try {
    SquirrelUpdater.on('checking-for-update', () => sendAppUpdateStatus({ state: 'checking' }));
    SquirrelUpdater.on('update-available', () => sendAppUpdateStatus({ state: 'available', info: { tag: 'latest' } }));
    SquirrelUpdater.on('update-not-available', () => sendAppUpdateStatus({ state: 'none' }));
    SquirrelUpdater.on('update-downloaded', (_e, _notes, _name) => {
      sendAppUpdateStatus({ state: 'downloaded', info: { version: _name || 'pending' } });
      if (autoInstallNext) {
        try { sendAppUpdateStatus({ state: 'installing' }); SquirrelUpdater.quitAndInstall(); } catch (e) { sendAppUpdateStatus({ state: 'error', error: String(e) }); }
      }
    });
    SquirrelUpdater.on('error', (err) => sendAppUpdateStatus({ state: 'error', error: String(err) }));
  } catch {}
}
app.whenReady().then(() => {
  mainWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
  width: 600,
  height: 460,
  maxWidth: 600,
  maxHeight: 460,
    resizable: false,
    fullscreenable: false,
    webPreferences: {
      ...BASE_WEB_PREFERENCES,
      preload: path.join(__dirname, 'preload.js'),
      devTools: !app.isPackaged,
    },
    icon: path.join(__dirname, 'Images/icon.ico'),
    frame: true,
    titleBarStyle: 'hidden',
  });

  mainWindow.loadFile(path.join(__dirname, 'UI', 'index.html'));
  applyWindowSecurityGuards(mainWindow);

  let IconPath = path.join(__dirname, 'Images', 'icon.ico');
  const icon = nativeImage.createFromPath(IconPath);
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Stop Service',
      click: async () => {
        app.quit();
      },
    },
    {
      label: 'Check For Updates',
      click: async () => {
  await performUpdateCheck();
      },
    },
  ]);

  tray.setToolTip('ShowTrak Client Service');
  tray.setContextMenu(contextMenu);
  tray.setIgnoreDoubleClickEvents(true);
  tray.on('click', function (_e) {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
    }
  });

  RPC.handle('Loaded', async (_event, ...args) => {
    try {
      assertNoArgs('Loaded', args);
    } catch (error) {
      return validationErrorPayload(error);
    }
    const Profile = await ProfileManager.GetProfile();
    mainWindow.webContents.send('SetProfile', Profile);
    return [null, true];
  });

  RPC.handle('Minimise', async (_event, ...args) => {
    try {
      assertNoArgs('Minimise', args);
    } catch (error) {
      return validationErrorPayload(error);
    }
    if (mainWindow && mainWindow.isVisible()) {
      mainWindow.hide();
    }
    return [null, true];
  });

  RPC.handle('Shutdown', async (_event, ...args) => {
    try {
      assertNoArgs('Shutdown', args);
    } catch (error) {
      return validationErrorPayload(error);
    }
    app.quit();
    return [null, true];
  });

  RPC.handle('GetVersion', async (_event, ...args) => {
    try {
      assertNoArgs('GetVersion', args);
    } catch (error) {
      return validationErrorPayload(error);
    }
    return Config.Application.Version;
  });

  // Updater IPC
  RPC.handle('AppUpdate:Check', async (_event, ...args) => {
    try {
      assertNoArgs('AppUpdate:Check', args);
    } catch (error) {
      return validationErrorPayload(error);
    }
    if (!app.isPackaged) {
      try {
        sendAppUpdateStatus({ state: 'checking' });
        setTimeout(() => sendAppUpdateStatus({ state: 'available', info: { version: 'TEST' } }), 400);
        let pct = 0; const t = setInterval(() => { pct += 20; if (pct >= 100) { clearInterval(t); sendAppUpdateStatus({ state: 'downloaded', info: { version: 'TEST' } }); } else { sendAppUpdateStatus({ state: 'downloading', percent: pct }); } }, 200);
      } catch (e) { sendAppUpdateStatus({ state: 'error', error: String(e) }); }
      return [null, true];
    }
    await performUpdateCheck();
    return [null, true];
  });
  RPC.handle('AppUpdate:Install', async (_event, ...args) => {
    try {
      assertNoArgs('AppUpdate:Install', args);
    } catch (error) {
      return validationErrorPayload(error);
    }
    if (!app.isPackaged) {
      sendAppUpdateStatus({ state: 'installing' });
      setTimeout(() => sendAppUpdateStatus({ state: 'installed' }), 400);
      return [null, true];
    }
    try {
      if (isSquirrelWindows()) {
        sendAppUpdateStatus({ state: 'installing' });
        SquirrelUpdater.quitAndInstall(); // auto-restart
        return [null, true];
      }
      if (!euAutoUpdater) {
        const { autoUpdater } = require('electron-updater');
        euAutoUpdater = autoUpdater;
      }
      // Force run after install
      await euAutoUpdater.quitAndInstall(false, true);
      return [null, true];
    } catch (e) {
      sendAppUpdateStatus({ state: 'error', error: String(e) });
      return validationErrorPayload(e);
    }
  });

  Main();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// ReinitializeService
BroadcastManager.on('ReinitializeService', async () => {
  try { await BonjourManager.Stop(); } catch {}
  await AdoptionClientManager.Terminate();
  await MainClientManager.Terminate();
  await Main();
});

BroadcastManager.on('ProfileUpdated', async (Profile) => {
  if (mainWindow) mainWindow.webContents.send('SetProfile', Profile);
});

async function performUpdateCheck() {
  try {
    if (isSquirrelWindows()) {
      initSquirrelUpdater();
      const feed = 'https://github.com/ShowTrak/ShowTrakClient/releases/latest/download/';
      try { SquirrelUpdater.setFeedURL({ url: feed }); } catch { SquirrelUpdater.setFeedURL(feed); }
      SquirrelUpdater.checkForUpdates();
      return;
    }
    if (!euAutoUpdater) {
      const { autoUpdater } = require('electron-updater');
      euAutoUpdater = autoUpdater;
      euAutoUpdater.autoDownload = true;
      euAutoUpdater.autoInstallOnAppQuit = false;
      euAutoUpdater.on('checking-for-update', () => sendAppUpdateStatus({ state: 'checking' }));
      euAutoUpdater.on('update-available', (info) => sendAppUpdateStatus({ state: 'available', info }));
      euAutoUpdater.on('update-not-available', (info) => sendAppUpdateStatus({ state: 'none', info }));
      euAutoUpdater.on('error', (err) => sendAppUpdateStatus({ state: 'error', error: String(err) }));
      euAutoUpdater.on('download-progress', (p) => sendAppUpdateStatus({ state: 'downloading', percent: p && p.percent ? p.percent : 0 }));
      euAutoUpdater.on('update-downloaded', async (info) => {
        sendAppUpdateStatus({ state: 'downloaded', info });
        if (autoInstallNext) {
          try { sendAppUpdateStatus({ state: 'installing' }); await euAutoUpdater.quitAndInstall(false, true); } catch (e) { sendAppUpdateStatus({ state: 'error', error: String(e) }); }
        }
      });
    }
    // Provide GitHub config dynamically if missing
    const resourcesPath = typeof process !== 'undefined' ? process.resourcesPath : '';
    const execDir = typeof process !== 'undefined' && process.execPath ? path.dirname(process.execPath) : '';
    const ymlPaths = [resourcesPath ? path.join(resourcesPath, 'app-update.yml') : '', execDir ? path.join(execDir, 'app-update.yml') : ''].filter(Boolean);
    const hasYml = ymlPaths.some((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (!hasYml) {
      const tmpYml = path.join(os.tmpdir(), `showtrak-client-app-update-${process.pid}.yml`);
      const yml = ['provider: github', 'owner: ShowTrak', 'repo: ShowTrakClient'].join('\n');
      try { fs.writeFileSync(tmpYml, yml, 'utf8'); euAutoUpdater.updateConfigPath = tmpYml; } catch {}
    }
    await euAutoUpdater.checkForUpdates();
  } catch (e) {
    sendAppUpdateStatus({ state: 'error', error: String(e) });
  }
}

BroadcastManager.on('UpdateSoftware', async (Callback) => {
  if (!app.isPackaged) return Callback('App is not packaged, skipping update check');
  autoInstallNext = true; // remote trigger should auto-install when ready
  await performUpdateCheck();
  return Callback(null);
});

async function Main() {
  const Profile = await ProfileManager.GetProfile();
  if (Profile.Adopted && Profile.Server && Profile.Server.IP && Profile.Server.Port) {
    Logger.log('Profile loaded [Adopted]');
    await BootWithStoredSettings();
  } else {
    Logger.log('Profile loaded [Unadopted]');
    BonjourManager.OnFind(async (Server) => {
      Logger.log('Bonjour service found:', Server);
      try {
        const addrs = Array.isArray(Server.addresses) ? Server.addresses : [];
        // Prefer IPv4 from addresses
        let targetIP = addrs.find((a) => typeof a === 'string' && a.includes('.')) || null;
        if (!targetIP && Server.referer && typeof Server.referer.address === 'string' && Server.referer.address.includes('.')) {
          targetIP = Server.referer.address; // fallback to referer IPv4
        }
        if (!targetIP && typeof Server.host === 'string' && Server.host.length) {
          try {
            const looked = await dns.lookup(Server.host, { family: 4 });
            if (looked && looked.address) targetIP = looked.address;
          } catch {}
        }
        if (!targetIP) {
          Logger.warn('Bonjour service discovered but no IPv4 address resolved; skipping this record.');
          return;
        }
        Logger.log(`Discovered ShowTrak Server at ${targetIP}:${Server.port}`);
        // Stop further browsing to avoid duplicate attempts
        try { await BonjourManager.Stop(); } catch {}
        await AdoptionClientManager.Init(Profile.UUID, targetIP, Server.port);
      } catch (e) {
        Logger.error('Failed to initialize adoption from Bonjour discovery:', e);
      }
    });
  }
}

async function BootWithStoredSettings() {
  const Profile = await ProfileManager.GetProfile();
  Logger.log(`Attempting connection to ${Profile.Server.IP}:${Profile.Server.Port}`);
  await MainClientManager.Init(Profile.UUID, Profile.Server.IP, Profile.Server.Port);
}
