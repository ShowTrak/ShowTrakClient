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
const { Manager: ProcessMonitor } = require('./Modules/ProcessMonitor');
const { Manager: StartupManager } = require('./Modules/Startup');
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

// Resolve the window icon for the current platform. Electron uses .ico on
// Windows and prefers .png elsewhere; the .icns is only used by the packager.
function getWindowIconPath() {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return path.join(__dirname, 'images', iconName);
}

// Resolve the tray image. Validate candidates and return the first usable one
// so we never create an invisible tray item on macOS.
function getTrayImage() {
  const candidates =
    process.platform === 'win32'
      ? [path.join(__dirname, 'images', 'icon.ico')]
      : [
          path.join(__dirname, 'images', 'trayTemplate.png'),
          path.join(__dirname, 'images', 'icon.png'),
        ];

  for (const iconPath of candidates) {
    try {
      const image = nativeImage.createFromPath(iconPath);
      if (!image || image.isEmpty()) continue;

      if (process.platform === 'darwin') {
        const macImage = image.resize({ width: 18, height: 18 });
        // Only mark explicit template assets as template images.
        if (path.basename(iconPath).toLowerCase().includes('template')) {
          macImage.setTemplateImage(true);
        }
        Logger.log('Tray image selected', iconPath);
        return macImage;
      }

      Logger.log('Tray image selected', iconPath);
      return image;
    } catch {}
  }

  Logger.warn('No valid tray image candidates found', candidates.join(', '));
  return nativeImage.createEmpty();
}

let tray;
let mainWindow;
let appQuitRequested = false;

function hasMainWindow() {
  return mainWindow && !mainWindow.isDestroyed();
}

function createMainWindow() {
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
    icon: getWindowIconPath(),
    frame: true,
    titleBarStyle: 'hidden',
  });

  mainWindow.loadFile(path.join(__dirname, 'UI', 'index.html'));
  applyWindowSecurityGuards(mainWindow);

  // Keep the app running in the background when the user clicks the window
  // close button; explicit quit actions still terminate the app.
  mainWindow.on('close', (event) => {
    if (appQuitRequested) return;
    event.preventDefault();
    try {
      mainWindow.hide();
    } catch {}
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

function openConfigureWindow() {
  if (!hasMainWindow()) {
    createMainWindow();
  }
  if (!hasMainWindow()) return;

  try {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
  } catch {}
}

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
  try {
    Logger.log('[Updater] Status event', payload || {});
  } catch {}
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('AppUpdate:Status', payload); } catch {}
  try {
    if (ActiveRemoteUpdateSession && typeof ActiveRemoteUpdateSession.onStatus === 'function') {
      ActiveRemoteUpdateSession.onStatus(payload || {});
    }
  } catch {}
}
let euAutoUpdater = null;
let squirrelUpdaterInitialized = false;
let autoInstallNext = false; // when true, auto-install on update-downloaded
let ActiveRemoteUpdateSession = null;

function prepareForQuitAndInstall(context = 'unknown') {
  const previousQuitRequested = appQuitRequested;
  appQuitRequested = true;
  try {
    if (tray) {
      tray.destroy();
      tray = null;
    }
  } catch (error) {
    Logger.warn('[Updater] Failed to destroy tray before install', {
      context,
      error: String(error),
    });
  }
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.removeAllListeners('close');
    }
  } catch (error) {
    Logger.warn('[Updater] Failed to relax window close guard before install', {
      context,
      error: String(error),
    });
  }

  return () => {
    appQuitRequested = previousQuitRequested;
  };
}

function requestQuitAndInstall(runInstall, context = 'unknown') {
  const restoreQuitState = prepareForQuitAndInstall(context);
  try {
    Logger.log('[Updater] quitAndInstall requested', {
      context,
      hasTray: !!tray,
      hasMainWindow: !!(mainWindow && !mainWindow.isDestroyed()),
    });
    runInstall();
  } catch (error) {
    restoreQuitState();
    throw error;
  }
}

function mapUpdaterStateToProgress(payload = {}) {
  const state = String(payload.state || '').toLowerCase();
  if (state === 'checking') return [5, 'Checking for updates'];
  if (state === 'available') return [15, 'Update available'];
  if (state === 'downloading') {
    const percent = payload && payload.percent ? Number(payload.percent) : 0;
    const safe = Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0;
    return [safe, `Downloading ${safe}%`];
  }
  if (state === 'downloaded') return [100, 'Downloaded'];
  if (state === 'installing') return [100, 'Installing update'];
  if (state === 'none') return [100, 'Already up to date'];
  if (state === 'error') return [0, payload && payload.error ? String(payload.error) : 'Update error'];
  return [0, 'Waiting'];
}

function normalizeVersionToken(value) {
  return String(value || '')
    .trim()
    .replace(/^v/i, '')
    .toLowerCase();
}

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
  Logger.log('[Updater][Squirrel] Initializing Squirrel updater event bindings');
  try {
    SquirrelUpdater.on('checking-for-update', () => {
      Logger.log('[Updater][Squirrel] checking-for-update');
      sendAppUpdateStatus({ state: 'checking' });
    });
    SquirrelUpdater.on('update-available', () => {
      Logger.log('[Updater][Squirrel] update-available');
      sendAppUpdateStatus({ state: 'available', info: { tag: 'latest' } });
    });
    SquirrelUpdater.on('update-not-available', () => {
      Logger.log('[Updater][Squirrel] update-not-available');
      sendAppUpdateStatus({ state: 'none' });
    });
    SquirrelUpdater.on('update-downloaded', (_e, _notes, _name) => {
      Logger.log('[Updater][Squirrel] update-downloaded', {
        name: _name || null,
        autoInstallNext,
      });
      sendAppUpdateStatus({ state: 'downloaded', info: { version: _name || 'pending' } });
      if (autoInstallNext) {
        try {
          sendAppUpdateStatus({ state: 'installing' });
          requestQuitAndInstall(() => {
            SquirrelUpdater.quitAndInstall();
          }, 'squirrel-auto');
        } catch (e) {
          sendAppUpdateStatus({ state: 'error', error: String(e) });
        }
      }
    });
    SquirrelUpdater.on('error', (err) => {
      Logger.error('[Updater][Squirrel] error', err);
      sendAppUpdateStatus({ state: 'error', error: String(err) });
    });
  } catch {}
}
app.whenReady().then(async () => {
  await StartupManager.EnsureEnabled();
  createMainWindow();

  // Create the tray icon. Tray support is reliable on Windows and macOS, but
  // varies across Linux desktops; if it fails there we fall back to showing the
  // window minimized so the app remains reachable.
  try {
    const trayImage = getTrayImage();
    if (!trayImage || trayImage.isEmpty()) {
      throw new Error('No valid tray image found');
    }
    tray = new Tray(trayImage);
    Logger.log('Tray created successfully');
  } catch (error) {
    tray = null;
    Logger.warn('System tray unavailable, falling back to minimized window', String(error));
  }

  if (tray) {
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Configure',
        click: async () => {
          openConfigureWindow();
        },
      },
      {
        label: 'Open Logs Folder',
        click: async () => {
          const Opened = AppDataManager.OpenFolder(AppDataManager.GetLogsDirectory());
          if (!Opened) {
            Logger.warn('Failed to open logs folder from tray menu');
          }
        },
      },
      {
        type: 'separator',
      },
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
    if (process.platform === 'darwin') {
      // Keep a visible fallback label in the menu bar in case the icon remains
      // hidden by OS rendering rules.
      tray.setTitle('ShowTrak Client');
      // Hide Dock only after tray is confirmed available.
      if (app.dock) {
        try {
          app.dock.hide();
        } catch {}
      }
    }
    tray.setContextMenu(contextMenu);
    tray.setIgnoreDoubleClickEvents(true);
  } else {
    // No tray: keep the app accessible by making the window visible.
    mainWindow.once('ready-to-show', () => {
      try {
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show();
          mainWindow.show();
          mainWindow.focus();
          return;
        }
        mainWindow.minimize();
        mainWindow.show();
      } catch {}
    });
  }

  RPC.handle('Loaded', async (_event, ...args) => {
    try {
      assertNoArgs('Loaded', args);
    } catch (error) {
      return validationErrorPayload(error);
    }
    const Profile = await ProfileManager.GetProfile();
    mainWindow.webContents.send('SetProfile', Profile);
    mainWindow.webContents.send('ProcessMonitorStatus', ProcessMonitor.GetStatus());
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
        requestQuitAndInstall(() => {
          SquirrelUpdater.quitAndInstall(); // auto-restart
        }, 'squirrel-manual');
        return [null, true];
      }
      if (!euAutoUpdater) {
        const { autoUpdater } = require('electron-updater');
        euAutoUpdater = autoUpdater;
      }
      // Force run after install
      sendAppUpdateStatus({ state: 'installing' });
      requestQuitAndInstall(() => {
        euAutoUpdater.quitAndInstall(false, true);
      }, 'electron-updater-manual');
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

app.on('before-quit', () => {
  appQuitRequested = true;
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

BroadcastManager.on('ProcessMonitorStatus', async (Status) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ProcessMonitorStatus', Status || { State: 'unknown' });
  }
});

async function performUpdateCheck(options = {}) {
  try {
    const FeedURL = options && options.FeedURL ? String(options.FeedURL).trim() : '';
    const UseLANFeed = !!FeedURL;
    const TargetVersion = options && options.TargetVersion ? String(options.TargetVersion).trim() : '';
    const AllowDowngrade = !!(UseLANFeed && TargetVersion);
    Logger.log('[Updater] performUpdateCheck begin', {
      mode: UseLANFeed ? 'remote-lan' : 'self-default',
      feedUrl: FeedURL || null,
      targetVersion: TargetVersion || null,
      allowDowngrade: AllowDowngrade,
      platform: process.platform,
      packaged: app.isPackaged,
      isSquirrelWindows: isSquirrelWindows(),
      autoInstallNext,
    });

    if (isSquirrelWindows()) {
      initSquirrelUpdater();
      const feed = UseLANFeed
        ? FeedURL
        : 'https://github.com/ShowTrak/ShowTrakClient/releases/latest/download/';
      Logger.log('[Updater][Squirrel] setting feed URL', { feed });
      try { SquirrelUpdater.setFeedURL({ url: feed }); } catch { SquirrelUpdater.setFeedURL(feed); }
      Logger.log('[Updater][Squirrel] checkForUpdates invoked');
      SquirrelUpdater.checkForUpdates();
      return;
    }
    if (!euAutoUpdater) {
      const { autoUpdater } = require('electron-updater');
      euAutoUpdater = autoUpdater;
      euAutoUpdater.autoDownload = true;
      euAutoUpdater.autoInstallOnAppQuit = false;
      Logger.log('[Updater][ElectronUpdater] initialized autoUpdater instance');
      euAutoUpdater.on('checking-for-update', () => {
        Logger.log('[Updater][ElectronUpdater] checking-for-update');
        sendAppUpdateStatus({ state: 'checking' });
      });
      euAutoUpdater.on('update-available', (info) => {
        Logger.log('[Updater][ElectronUpdater] update-available', info || {});
        sendAppUpdateStatus({ state: 'available', info });
      });
      euAutoUpdater.on('update-not-available', (info) => {
        Logger.log('[Updater][ElectronUpdater] update-not-available', info || {});
        sendAppUpdateStatus({ state: 'none', info });
      });
      euAutoUpdater.on('error', (err) => {
        Logger.error('[Updater][ElectronUpdater] error', err);
        sendAppUpdateStatus({ state: 'error', error: String(err) });
      });
      euAutoUpdater.on('download-progress', (p) => {
        Logger.log('[Updater][ElectronUpdater] download-progress', {
          percent: p && p.percent ? p.percent : 0,
          bytesPerSecond: p && p.bytesPerSecond ? p.bytesPerSecond : null,
          transferred: p && p.transferred ? p.transferred : null,
          total: p && p.total ? p.total : null,
        });
        sendAppUpdateStatus({ state: 'downloading', percent: p && p.percent ? p.percent : 0 });
      });
      euAutoUpdater.on('update-downloaded', async (info) => {
        Logger.log('[Updater][ElectronUpdater] update-downloaded', {
          info: info || {},
          autoInstallNext,
        });
        sendAppUpdateStatus({ state: 'downloaded', info });
        if (autoInstallNext) {
          try {
            sendAppUpdateStatus({ state: 'installing' });
            requestQuitAndInstall(() => {
              euAutoUpdater.quitAndInstall(false, true);
            }, 'electron-updater-auto');
          } catch (e) {
            sendAppUpdateStatus({ state: 'error', error: String(e) });
          }
        }
      });
    }
    try {
      euAutoUpdater.allowDowngrade = AllowDowngrade;
      Logger.log('[Updater][ElectronUpdater] allowDowngrade set', {
        value: euAutoUpdater.allowDowngrade,
      });
    } catch (err) {
      Logger.error('[Updater][ElectronUpdater] failed to set allowDowngrade', err);
    }
    // Provide update config dynamically if missing.
    const resourcesPath = typeof process !== 'undefined' ? process.resourcesPath : '';
    const execDir = typeof process !== 'undefined' && process.execPath ? path.dirname(process.execPath) : '';
    const ymlPaths = [resourcesPath ? path.join(resourcesPath, 'app-update.yml') : '', execDir ? path.join(execDir, 'app-update.yml') : ''].filter(Boolean);
    const hasYml = ymlPaths.some((p) => { try { return fs.existsSync(p); } catch { return false; } });
    Logger.log('[Updater][ElectronUpdater] update config inspection', {
      hasYml,
      ymlPaths,
      useLanFeed: UseLANFeed,
    });
    if (!hasYml || UseLANFeed) {
      const tmpYml = path.join(os.tmpdir(), `showtrak-client-app-update-${process.pid}.yml`);
      const yml = UseLANFeed
        ? ['provider: generic', `url: ${FeedURL}`].join('\n')
        : ['provider: github', 'owner: ShowTrak', 'repo: ShowTrakClient'].join('\n');
      try {
        fs.writeFileSync(tmpYml, yml, 'utf8');
        euAutoUpdater.updateConfigPath = tmpYml;
        Logger.log('[Updater][ElectronUpdater] using temporary update config', {
          path: tmpYml,
          content: yml,
        });
      } catch (err) {
        Logger.error('[Updater][ElectronUpdater] failed to write temporary update config', err);
      }
    }

    if (UseLANFeed && typeof euAutoUpdater.setFeedURL === 'function') {
      try {
        euAutoUpdater.setFeedURL({ provider: 'generic', url: FeedURL });
        Logger.log('[Updater][ElectronUpdater] setFeedURL applied for LAN feed', { feedUrl: FeedURL });
      } catch (err) {
        Logger.error('[Updater][ElectronUpdater] setFeedURL failed for LAN feed', err);
      }
    }

    Logger.log('[Updater][ElectronUpdater] invoking checkForUpdates');
    await euAutoUpdater.checkForUpdates();
    Logger.log('[Updater][ElectronUpdater] checkForUpdates call resolved');
  } catch (e) {
    Logger.error('[Updater] performUpdateCheck failed', e);
    sendAppUpdateStatus({ state: 'error', error: String(e) });
  }
}

BroadcastManager.on('UpdateSoftware', async (Callback) => {
  Logger.log('[Updater][Remote] UpdateSoftware request received from server');
  if (!app.isPackaged) return Callback('App is not packaged, skipping update check');
  autoInstallNext = true; // remote trigger should auto-install when ready
  Logger.log('[Updater][Remote] autoInstallNext enabled for remote self-update');
  await performUpdateCheck();
  Logger.log('[Updater][Remote] UpdateSoftware request dispatched to updater');
  return Callback(null);
});

BroadcastManager.on('UpdateSoftwareFromLAN', async (Payload, ProgressCallback, Callback) => {
  Logger.log('[Updater][RemoteLAN] UpdateSoftwareFromLAN request received', {
    payload: Payload || {},
  });
  if (!app.isPackaged) return Callback('App is not packaged, skipping update check');

  const FeedURL = Payload && Payload.FeedURL ? String(Payload.FeedURL).trim() : '';
  const TargetVersion = Payload && Payload.ReleaseVersion ? String(Payload.ReleaseVersion).trim() : '';
  if (!FeedURL) return Callback('Missing LAN update feed URL');

  autoInstallNext = true;
  Logger.log('[Updater][RemoteLAN] autoInstallNext enabled with LAN feed', {
    feedUrl: FeedURL,
    targetVersion: TargetVersion || null,
    currentVersion: Config.Application.Version,
  });

  const [InitialPercent, InitialText] = mapUpdaterStateToProgress({ state: 'checking' });
  try {
    if (typeof ProgressCallback === 'function') {
      await ProgressCallback(InitialPercent, InitialText);
    }
  } catch {}

  try {
    const terminalState = await new Promise((resolve, reject) => {
      ActiveRemoteUpdateSession = {
        onStatus: async (statusPayload) => {
          Logger.log('[Updater][RemoteLAN] status payload', statusPayload || {});
          const [percent, statusText] = mapUpdaterStateToProgress(statusPayload);
          try {
            if (typeof ProgressCallback === 'function') {
              await ProgressCallback(percent, statusText);
              Logger.log('[Updater][RemoteLAN] progress callback sent', {
                percent,
                statusText,
              });
            }
          } catch {}

          const state = String((statusPayload && statusPayload.state) || '').toLowerCase();
          if (state === 'downloaded' || state === 'none') {
            Logger.log('[Updater][RemoteLAN] terminal state reached', { state });
            resolve(state);
            ActiveRemoteUpdateSession = null;
          } else if (state === 'error') {
            const msg = statusPayload && statusPayload.error
              ? String(statusPayload.error)
              : 'Update failed';
            Logger.error('[Updater][RemoteLAN] terminal error state', { message: msg });
            reject(new Error(msg));
            ActiveRemoteUpdateSession = null;
          }
        },
      };
    
      performUpdateCheck({ FeedURL, TargetVersion }).catch((Err) => {
        Logger.error('[Updater][RemoteLAN] performUpdateCheck rejected', Err);
        reject(Err);
        ActiveRemoteUpdateSession = null;
      });
    });

    if (terminalState === 'none') {
      const requestedVersion = normalizeVersionToken(TargetVersion);
      const currentVersion = normalizeVersionToken(Config.Application.Version);
      if (requestedVersion && requestedVersion !== currentVersion) {
        Logger.error('[Updater][RemoteLAN] requested version was not offered by updater', {
          requestedVersion,
          currentVersion,
        });
        return Callback(`Requested version ${TargetVersion} was reported as unavailable by the updater`);
      }
      Logger.log('[Updater][RemoteLAN] no update available because client is already on requested version');
      return Callback(null);
    }
    Logger.log('[Updater][RemoteLAN] remote LAN update download completed');
    return Callback(null);
  } catch (Err) {
    Logger.error('[Updater][RemoteLAN] remote LAN update failed', Err);
    return Callback(Err && Err.message ? Err.message : String(Err));
  } finally {
    Logger.log('[Updater][RemoteLAN] session cleanup');
    ActiveRemoteUpdateSession = null;
  }
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
