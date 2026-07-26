// Electron API smoke probe — run this after every Electron major upgrade.
//
//   npm run probe:electron
//
// Requires a display and a built dist/ (run `npm run build` first). Not part of
// CI: it needs a GUI session, and it is a manual gate rather than a regression
// gate. Exits non-zero if any check fails.
//
// Why this exists: the client sat six Electron majors behind (37 -> 43), and
// none of the surfaces an Electron major actually breaks — tray construction,
// nativeImage template handling, app.dock, sandboxed preloads, contextBridge,
// the two overlay windows, both updater paths — are reachable from `node --test`,
// which runs outside Electron entirely. This closes that gap cheaply.
//
// It deliberately does NOT boot dist/main.js. That would touch the real profile
// in the user's AppData directory, register this machine with whatever ShowTrak
// server is on the LAN, and advertise it for adoption. This checks the API
// surface and the renderer/preload wiring only.
//
// NOTE: if your shell exports ELECTRON_RUN_AS_NODE=1, Electron runs in the plain
// Node context and `app` is undefined. Prefix with `env -u ELECTRON_RUN_AS_NODE`.
const path = require('node:path');
const fs = require('node:fs');

// This file lives in scripts/, so dist/ is one level up.
const PROJECT_ROOT = path.join(__dirname, '..');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  screen,
  ipcMain,
  autoUpdater,
} = require('electron');

const results = [];
const record = (name, fn) => {
  try {
    const detail = fn();
    results.push(['ok', name, detail === undefined ? '' : String(detail)]);
  } catch (e) {
    results.push(['FAIL', name, e && e.message ? e.message : String(e)]);
  }
};

const BASE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
});

app.whenReady().then(async () => {
  record('electron version', () => process.versions.electron);
  record('bundled node', () => process.versions.node);
  record('bundled chromium', () => process.versions.chrome);

  // --- tray image resolution, mirroring getTrayImage() -----------------------
  const distImages = path.join(PROJECT_ROOT, 'dist', 'images');
  record('dist/images present', () => fs.readdirSync(distImages).join(','));

  let trayImage = null;
  record('nativeImage.createFromPath(trayTemplate.png)', () => {
    const img = nativeImage.createFromPath(path.join(distImages, 'trayTemplate.png'));
    if (img.isEmpty()) throw new Error('image is empty');
    trayImage = img;
    return `${img.getSize().width}x${img.getSize().height}`;
  });
  record('nativeImage.createFromBuffer(icon.png)', () => {
    const img = nativeImage.createFromBuffer(fs.readFileSync(path.join(distImages, 'icon.png')));
    if (img.isEmpty()) throw new Error('image is empty');
    return `${img.getSize().width}x${img.getSize().height}`;
  });
  record('nativeImage.resize + setTemplateImage', () => {
    const resized = trayImage.resize({ width: 18, height: 18 });
    resized.setTemplateImage(true);
    return `template=${resized.isTemplateImage()}`;
  });
  record('nativeImage.createEmpty().isEmpty()', () => nativeImage.createEmpty().isEmpty());

  // --- tray ------------------------------------------------------------------
  let tray = null;
  record('new Tray(image)', () => {
    tray = new Tray(trayImage.resize({ width: 18, height: 18 }));
    return 'constructed';
  });
  record('tray.setToolTip', () => {
    tray.setToolTip('ShowTrak Client Service');
    return 'set';
  });
  record('tray.setTitle', () => {
    if (process.platform !== 'darwin') return 'skipped (non-darwin)';
    tray.setTitle('ShowTrak Client');
    return 'set';
  });
  record('tray.setIgnoreDoubleClickEvents', () => {
    tray.setIgnoreDoubleClickEvents(true);
    return 'set';
  });
  record('Menu.buildFromTemplate with submenu + separator', () => {
    const menu = Menu.buildFromTemplate([
      { label: 'Configure', click: () => {} },
      { label: 'Run Script', submenu: [{ label: 'No scripts available', enabled: false }] },
      { type: 'separator' },
      { label: 'Stop Service', click: () => {} },
    ]);
    tray.setContextMenu(menu);
    return `${menu.items.length} items`;
  });

  // --- app.dock (macOS menu-bar agent behaviour) -----------------------------
  record('app.dock present', () => (app.dock ? 'yes' : 'no (non-darwin)'));
  record('app.dock.hide/show callable', () => {
    if (!app.dock) return 'skipped (non-darwin)';
    app.dock.hide();
    app.dock.show();
    app.dock.hide();
    return 'called';
  });

  // --- window with the app's exact webPreferences ----------------------------
  let win = null;
  record('BrowserWindow with sandbox+contextIsolation+preload', () => {
    win = new BrowserWindow({
      show: false,
      backgroundColor: '#161618',
      width: 800,
      height: 550,
      resizable: false,
      fullscreenable: false,
      webPreferences: {
        ...BASE_WEB_PREFERENCES,
        preload: path.join(PROJECT_ROOT, 'dist', 'preload.js'),
        devTools: !app.isPackaged,
      },
      frame: true,
      titleBarStyle: 'hidden',
    });
    return 'constructed';
  });
  record('webContents.setWindowOpenHandler', () => {
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    return 'installed';
  });
  record("webContents.on('will-navigate')", () => {
    win.webContents.on('will-navigate', () => {});
    return 'bound';
  });

  // Actually load the real renderer through the real preload: this is the check
  // that catches a preload/contextBridge or CSP regression.
  const loaded = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('TIMEOUT after 15s'), 15000);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve('did-finish-load');
    });
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      clearTimeout(timer);
      resolve(`did-fail-load ${code} ${desc}`);
    });
    win.loadFile(path.join(PROJECT_ROOT, 'dist', 'UI', 'index.html')).catch((e) => {
      clearTimeout(timer);
      resolve('loadFile threw: ' + e.message);
    });
  });
  results.push([loaded === 'did-finish-load' ? 'ok' : 'FAIL', 'renderer loadFile', loaded]);

  // Does window.API actually exist in the renderer, with every method the UI calls?
  const bridge = await win.webContents
    .executeJavaScript(
      `(() => {
         if (!window.API) return 'window.API MISSING';
         const need = ['Loaded','GetVersion','Shutdown','Minimise','ResetClientFactoryDefaults',
                       'SetManualServer','ClearManualServer','CheckForAppUpdates','InstallAppUpdate',
                       'OnAppUpdateStatus','OnProcessMonitorStatus','OnServerRecoveryStatus','SetProfile'];
         const missing = need.filter((k) => typeof window.API[k] !== 'function');
         return missing.length ? 'MISSING: ' + missing.join(',') : 'all ' + need.length + ' methods present';
       })()`
    )
    .catch((e) => 'executeJavaScript threw: ' + e.message);
  results.push([
    String(bridge).startsWith('all ') ? 'ok' : 'FAIL',
    'contextBridge window.API',
    bridge,
  ]);

  // jQuery + Bootstrap are loaded as plain <script> globals by index.html.
  const vendors = await win.webContents
    .executeJavaScript(
      `(() => {
         const out = [];
         out.push('jQuery=' + (typeof window.jQuery === 'function' ? window.jQuery.fn.jquery : 'MISSING'));
         out.push('bootstrap=' + (window.bootstrap ? 'present' : 'MISSING'));
         return out.join(' ');
       })()`
    )
    .catch((e) => 'executeJavaScript threw: ' + e.message);
  results.push([vendors.includes('MISSING') ? 'FAIL' : 'ok', 'renderer vendor globals', vendors]);

  // Any renderer-side console errors during that load?
  record('screen.getAllDisplays', () => `${screen.getAllDisplays().length} display(s)`);
  record('screen display event binding', () => {
    const noop = () => {};
    screen.on('display-added', noop);
    screen.on('display-removed', noop);
    screen.on('display-metrics-changed', noop);
    return 'bound';
  });

  // --- misc APIs main.ts touches --------------------------------------------
  record('shell.openExternal/openPath exist', () =>
    [typeof shell.openExternal, typeof shell.openPath].join(',')
  );
  record('ipcMain.handle', () => {
    ipcMain.handle('__probe', async () => [null, true]);
    ipcMain.removeHandler('__probe');
    return 'handle+removeHandler';
  });
  record('Squirrel autoUpdater surface', () =>
    ['setFeedURL', 'checkForUpdates', 'quitAndInstall', 'on']
      .map((m) => `${m}=${typeof autoUpdater[m]}`)
      .join(' ')
  );
  record('app.requestSingleInstanceLock', () => typeof app.requestSingleInstanceLock);
  record('app.getPath(userData)', () => app.getPath('userData'));
  record('app.isPackaged', () => app.isPackaged);

  // --- lazy electron-updater (the real self-update path) --------------------
  record('electron-updater lazy require', () => {
    const { autoUpdater: eu } = require('electron-updater');
    const methods = ['checkForUpdates', 'quitAndInstall', 'setFeedURL', 'on']
      .map((m) => `${m}=${typeof eu[m]}`)
      .join(' ');
    eu.autoDownload = true;
    eu.autoInstallOnAppQuit = false;
    eu.allowDowngrade = false;
    return methods + ' props=settable';
  });

  // --- overlay windows ------------------------------------------------------
  for (const [name, file, preload] of [
    ['identify overlay', 'identify-overlay.html', 'identify-preload.js'],
    ['launch countdown overlay', 'launch-countdown-overlay.html', 'launch-countdown-preload.js'],
  ]) {
    const ok = await new Promise((resolve) => {
      let w;
      try {
        w = new BrowserWindow({
          show: false,
          frame: false,
          fullscreen: false,
          webPreferences: {
            ...BASE_WEB_PREFERENCES,
            preload: path.join(PROJECT_ROOT, 'dist', preload),
          },
        });
      } catch (e) {
        return resolve('construct threw: ' + e.message);
      }
      const timer = setTimeout(() => resolve('TIMEOUT'), 10000);
      w.webContents.once('did-finish-load', () => {
        clearTimeout(timer);
        w.destroy();
        resolve('did-finish-load');
      });
      w.webContents.once('did-fail-load', (_e, code, desc) => {
        clearTimeout(timer);
        w.destroy();
        resolve(`did-fail-load ${code} ${desc}`);
      });
      w.loadFile(path.join(PROJECT_ROOT, 'dist', 'UI', file)).catch((e) => {
        clearTimeout(timer);
        resolve('loadFile threw: ' + e.message);
      });
    });
    results.push([ok === 'did-finish-load' ? 'ok' : 'FAIL', name, ok]);
  }

  const failures = results.filter((r) => r[0] === 'FAIL');
  console.log('\n===PROBE RESULTS===');
  for (const [status, name, detail] of results) {
    console.log(`${status.padEnd(4)} | ${name}${detail ? ' | ' + detail : ''}`);
  }
  console.log(
    `===SUMMARY=== ${results.length - failures.length}/${results.length} ok, ${failures.length} FAILED`
  );
  app.exit(failures.length ? 1 : 0);
});
