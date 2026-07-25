/* eslint-disable no-empty */
import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  shell,
  ipcMain as RPC,
  autoUpdater as SquirrelUpdater,
  type MenuItemConstructorOptions,
} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';

import type {
  MainClientConnectionStatus,
  ServerAdoptionRejectedInfo,
  ServerConnectFailedInfo,
} from './types/client';
import type { AppUpdateStatus, ServerRecoveryStatus } from './types/preload';
import type { LaunchConfigPayload } from '@showtrak/protocol';
import type { DiscoveredService } from './Modules/Bonjour';

import { CreateLogger } from './Modules/Logger';
import { installProcessGuards } from './Modules/ProcessGuards';

if (squirrelStartup) app.quit();

// Installed before anything else can throw: an unattended agent must survive a
// NIC flap or a closed stdout rather than dying somewhere nobody is watching.
installProcessGuards();

const Logger = CreateLogger('Main');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  Logger.error('Another instance of ShowTrak Client is already running. Exiting this instance.');
  app.quit();
  process.exit(0);
} else {
  Logger.log('Single instance lock acquired');

  // When a user launches a second instance, Electron routes it here instead of
  // starting a new process. Surface the existing instance's config GUI so the
  // relaunch reads as "open settings" rather than silently doing nothing.
  app.on('second-instance', () => {
    Logger.log('Second instance launch detected; opening config window on the primary instance');
    try {
      openConfigureWindow();
    } catch (error) {
      Logger.warn('Failed to open config window for second-instance launch', String(error));
    }
  });
}

import { Manager as AdoptionClientManager } from './Modules/AdoptionClient';
import { Manager as MainClientManager } from './Modules/MainClient';
import { Manager as IdentifyOverlay } from './Modules/IdentifyOverlay';
import { Manager as LaunchCountdownOverlay } from './Modules/LaunchCountdownOverlay';
import { Manager as LaunchConfigManager } from './Modules/LaunchConfig';
import { Manager as ProcessMonitor } from './Modules/ProcessMonitor';
import { Manager as StartupManager } from './Modules/Startup';
import path from 'path';
import { Manager as BroadcastManager } from './Modules/Broadcast';
import { Manager as BonjourManager } from './Modules/Bonjour';
import { promises as dns } from 'node:dns';
import { Manager as AppDataManager } from './Modules/AppData';
import { Manager as ProfileManager } from './Modules/ProfileManager';
import { Manager as ScriptManager } from './Modules/ScriptManager';
import { Wait } from './Modules/Utils';
AppDataManager.Initialize();

import { Config } from './Modules/Config';
import fs from 'fs';
import os from 'os';

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
  const loaderOrder = process.platform === 'win32' ? ['path', 'buffer'] : ['buffer', 'path'];

  for (const iconPath of candidates) {
    try {
      if (!fs.existsSync(iconPath)) continue;

      let image = null;
      for (const loader of loaderOrder) {
        try {
          image =
            loader === 'path'
              ? nativeImage.createFromPath(iconPath)
              : nativeImage.createFromBuffer(fs.readFileSync(iconPath));
        } catch {
          image = null;
        }
        if (image && !image.isEmpty()) break;
      }
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

/** A ShowTrak server discovered over Bonjour (or configured manually). */
interface ServerCandidate {
  IP: string;
  Port: number;
  ServerIdentity: string | null;
}

/** Raw status payload emitted by electron-updater, before normalisation. */
interface UpdaterStatusPayload {
  state?: unknown;
  percent?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

/**
 * An in-flight server-triggered LAN update. Only one runs at a time; the
 * handler installs it so updater events can be routed back to the requesting
 * server, and clears it on any terminal state.
 */
interface RemoteUpdateSession {
  onStatus: (payload: AppUpdateStatus) => void | Promise<void>;
}

/** Outcome of waiting for a rediscovered server to accept this client. */
interface RecoveryValidation {
  ok: boolean;
  reason?: 'rejected' | 'timeout';
}

/** Running totals shown in the recovery status panel. */
interface RecoveryMetrics {
  Attempts: number;
  LastAttemptAt: number;
  LastFailureAt: number;
  LastFailureReason: string | null;
  LastRecoveredAt: number;
}

let tray: Tray | null = null;
let mainWindow: BrowserWindow | null = null;
let appQuitRequested = false;
let currentRecoveryStatus: ServerRecoveryStatus = { State: 'idle', Message: '' };
let currentAppUpdateStatus: AppUpdateStatus | null = null;
let isReinitializing = false;
let recoveryInProgress = false;
let pendingRecoveryCandidate: ServerCandidate | null = null;
const RECOVERY_COOLDOWN_MS = 15000;
const RECOVERY_BACKOFF_BASE_MS = 1000;
const RECOVERY_BACKOFF_MAX_MS = 10000;
let recoveryRetryTimer: NodeJS.Timeout | null = null;
let recoveryRetryInfo: ServerConnectFailedInfo | null = null;
const recoveryMetrics: RecoveryMetrics = {
  Attempts: 0,
  LastAttemptAt: 0,
  LastFailureAt: 0,
  LastFailureReason: null,
  LastRecoveredAt: 0,
};

function hasMainWindow() {
  return mainWindow && !mainWindow.isDestroyed();
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#161618',
    width: 800,
    height: 550,
    minWidth: 640,
    minHeight: 380,
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

  const Window = mainWindow;
  Window.loadFile(path.join(__dirname, 'UI', 'index.html'));
  applyWindowSecurityGuards(Window);

  // Keep explicit app shutdown behavior separate from native window close
  // events so external window lifecycle changes do not unexpectedly hide the
  // client window.
  Window.on('close', (event) => {
    if (appQuitRequested) return;
    event.preventDefault();

    const FocusedWindow = BrowserWindow.getFocusedWindow();
    const isUserInitiatedClose =
      FocusedWindow === Window || (typeof Window.isFocused === 'function' && Window.isFocused());

    // Only hide-to-tray when the user closes the active client window.
    // Ignore non-user/native side-effect close events so connection/service
    // transitions cannot collapse the UI unexpectedly.
    if (isUserInitiatedClose) {
      try {
        Window.hide();
      } catch {}
    }
  });

  Window.on('closed', () => {
    mainWindow = null;
  });

  return Window;
}

function openConfigureWindow() {
  if (!hasMainWindow()) {
    createMainWindow();
  }
  const Window = mainWindow;
  if (!Window || Window.isDestroyed()) return;

  try {
    if (Window.isMinimized()) {
      Window.restore();
    }
    Window.show();
    Window.focus();
  } catch {}
}

function buildTrayScriptMenuItems() {
  const ScriptEntries = ScriptManager.GetTrayScriptEntries();
  if (!ScriptEntries.length) {
    return [{ label: 'No scripts available', enabled: false }];
  }

  return ScriptEntries.map(({ Script, Enabled, DisabledReason }) => {
    const ScriptLabel = String(
      (Script && Script.Name) || (Script && Script.ID) || 'Unnamed Script'
    );
    return {
      label: ScriptLabel,
      enabled: Enabled,
      click: async () => {
        if (!Enabled || !Script || !Script.ID) return;
        const [Err, Success] = await ScriptManager.Execute('tray', Script.ID);
        if (Err || !Success) {
          Logger.warn('Tray script execution failed', {
            scriptId: Script.ID,
            scriptName: ScriptLabel,
            reason: Err || DisabledReason || 'unknown_error',
          });
        }
      },
    };
  });
}

function buildTrayContextMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: 'Configure',
      click: async () => {
        openConfigureWindow();
      },
    },
    {
      label: 'Run Script',
      submenu: buildTrayScriptMenuItems(),
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
  ];
}

function refreshTrayContextMenu() {
  if (!tray) return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayContextMenuTemplate()));
  } catch (error) {
    Logger.warn('Failed to refresh tray context menu', String(error));
  }
}

function assertNoArgs(handlerName: string, args: unknown[]) {
  if (args.length > 0) {
    throw new Error(`${handlerName} does not accept arguments`);
  }
}

function validationErrorPayload(error: unknown): [string, null] {
  const asError = error as { message?: unknown } | null | undefined;
  const message =
    asError && asError.message ? String(asError.message) : String(error || 'Invalid request');
  return [message, null];
}

function applyWindowSecurityGuards(windowInstance: BrowserWindow | null) {
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

  windowInstance.webContents.on('will-navigate', (event, url: string) => {
    const currentURL = windowInstance.webContents.getURL();
    if (!currentURL || !url) return;
    if (url !== currentURL) {
      event.preventDefault();
    }
  });
}

function sendRecoveryStatus(payload: ServerRecoveryStatus) {
  const base = payload || { State: 'idle', Message: '' };
  currentRecoveryStatus = {
    ...base,
    Metrics: {
      Attempts: recoveryMetrics.Attempts,
      LastAttemptAt: recoveryMetrics.LastAttemptAt,
      LastFailureAt: recoveryMetrics.LastFailureAt,
      LastFailureReason: recoveryMetrics.LastFailureReason,
      LastRecoveredAt: recoveryMetrics.LastRecoveredAt,
      MaxAttempts: null,
      CooldownMs: RECOVERY_COOLDOWN_MS,
    },
  };
  try {
    Logger.log('[Recovery] Status event', currentRecoveryStatus);
  } catch {}
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ServerRecoveryStatus', currentRecoveryStatus);
    }
  } catch {}
}

function clearRecoveryRetryTimer() {
  if (recoveryRetryTimer) {
    clearTimeout(recoveryRetryTimer);
    recoveryRetryTimer = null;
  }
  recoveryRetryInfo = null;
}

function scheduleRecoveryRetry(waitMs: number, Info: ServerConnectFailedInfo) {
  if (recoveryInProgress || isReinitializing) return;
  if (recoveryRetryTimer) return;
  const Delay = Math.max(0, Number(waitMs) || 0);
  recoveryRetryInfo = Info ?? null;
  recoveryRetryTimer = setTimeout(async () => {
    const pendingInfo = recoveryRetryInfo;
    clearRecoveryRetryTimer();
    if (recoveryInProgress || isReinitializing) return;
    // Unreachable in practice: clearRecoveryRetryTimer() nulls recoveryRetryInfo
    // and cancels this timer in the same call, so a fired callback always has
    // the info it was scheduled with. Kept to satisfy the compiler without
    // asserting non-null.
    if (!pendingInfo) return;
    try {
      await recoverFromPrimaryFailure(pendingInfo);
    } catch (Error) {
      recoveryMetrics.LastFailureAt = Date.now();
      recoveryMetrics.LastFailureReason = (Error as { message?: unknown })?.message
        ? String((Error as { message?: unknown }).message)
        : 'unknown_error';
      Logger.error('Scheduled recovery flow failed', Error);
      sendRecoveryStatus({
        State: 'RecoveryFailed',
        Message: 'Unable to recover server connection automatically.',
      });
    }
  }, Delay);
}

function sendAppUpdateStatus(payload: AppUpdateStatus) {
  currentAppUpdateStatus = payload || null;
  try {
    Logger.log('[Updater] Status event', payload || {});
  } catch {}
  try {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('AppUpdate:Status', payload);
  } catch {}
  try {
    if (ActiveRemoteUpdateSession && typeof ActiveRemoteUpdateSession.onStatus === 'function') {
      ActiveRemoteUpdateSession.onStatus(payload || {});
    }
  } catch {}
}
let euAutoUpdater: import('electron-updater').AppUpdater | null = null;
let euAutoUpdaterHandlersBound = false;

// Lazily resolve the electron-updater instance. Returns a non-null updater so
// callers do not each have to re-prove initialisation; the one-time event
// handler binding is tracked separately by euAutoUpdaterHandlersBound.
function ensureAutoUpdater(): import('electron-updater').AppUpdater {
  if (!euAutoUpdater) {
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    euAutoUpdater = autoUpdater;
  }
  return euAutoUpdater;
}
let squirrelUpdaterInitialized = false;
let autoInstallNext = false; // when true, auto-install on update-downloaded
let ActiveRemoteUpdateSession: RemoteUpdateSession | null = null;

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

function requestQuitAndInstall(runInstall: () => void, context = 'unknown') {
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

function mapUpdaterStateToProgress(
  payload: UpdaterStatusPayload | AppUpdateStatus = {} as UpdaterStatusPayload
): [number, string] {
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
  if (state === 'error')
    return [0, payload && payload.error ? String(payload.error) : 'Update error'];
  return [0, 'Waiting'];
}

function normalizeVersionToken(value: unknown): string {
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
  } catch {
    return false;
  }
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

// Guards against re-running the launch action within a single process (whenReady
// only fires once, but the flag makes the intent explicit and future-proof).
let LaunchActionsHandled = false;

// Absence-of-file sentinel to disable ALL launch actions — the boot-loop escape
// hatch for the headless case where the countdown overlay isn't reliably seen.
function IsSafeModeEnabled() {
  try {
    return fs.existsSync(path.join(AppDataManager.GetProfileDirectory(), 'SafeMode'));
  } catch {
    return false;
  }
}

// Run the configured run-on-launch script, gated behind a cancellable countdown.
// Triggered once per client launch by MainClient after the FIRST successful
// server connection — MainClient first ensures scripts and the auto-start config
// are freshly synced, then emits 'RunLaunchAction'. The LaunchActionsHandled
// guard makes reconnects no-ops, so the script runs at most once per launch.
async function RunLaunchActions(Config: LaunchConfigPayload) {
  if (LaunchActionsHandled) return;
  LaunchActionsHandled = true;

  try {
    if (IsSafeModeEnabled()) {
      Logger.warn('Safe mode enabled (SafeMode sentinel present) — skipping launch actions');
      return;
    }

    const { ScriptID, DelaySeconds, ShowCountdown } = LaunchConfigManager.Normalize(Config);
    if (!ScriptID) return;

    const LaunchState = ScriptManager.GetLaunchState(ScriptID);
    if (!LaunchState.Found) {
      Logger.warn(`Run-on-launch script ${ScriptID} not found in catalog — skipping`);
      return;
    }
    if (!LaunchState.Enabled) {
      Logger.warn(
        `Run-on-launch script ${ScriptID} is not runnable: ${LaunchState.DisabledReason} — skipping`
      );
      return;
    }

    const Delay = Math.max(
      LaunchConfigManager.MIN_LAUNCH_DELAY_SECONDS,
      Number(DelaySeconds) || LaunchConfigManager.MIN_LAUNCH_DELAY_SECONDS
    );

    Logger.log(`Run-on-launch: "${LaunchState.Name}" scheduled in ${Delay}s`);

    if (ShowCountdown) {
      const Outcome = await LaunchCountdownOverlay.Show({
        ScriptName: LaunchState.Name,
        Seconds: Delay,
      });

      if (Outcome === 'cancelled') {
        Logger.warn(`Run-on-launch action "${LaunchState.Name}" cancelled by operator`);
        return;
      }
    } else {
      // Server disabled the visible countdown: honor the delay silently so the
      // script still fires on schedule, but with no overlay and no abort window.
      Logger.log('Run-on-launch: countdown overlay disabled by server — waiting silently');
      await Wait(Delay * 1000);
    }

    Logger.log(`Run-on-launch: executing "${LaunchState.Name}"`);
    const [Err] = await ScriptManager.Execute('launch', ScriptID);
    if (Err) Logger.error(`Run-on-launch execution failed: ${Err}`);
  } catch (Err) {
    Logger.error('RunLaunchActions failed', Err);
  }
}

app.whenReady().then(async () => {
  await StartupManager.EnsureEnabled();

  IdentifyOverlay.Configure({
    webPreferences: BASE_WEB_PREFERENCES,
    onClose: () => {
      BroadcastManager.emit('IdentifyStoppedByUser');
    },
  });

  LaunchCountdownOverlay.Configure({ webPreferences: BASE_WEB_PREFERENCES });

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
    refreshTrayContextMenu();
    tray.setIgnoreDoubleClickEvents(true);
  } else {
    // No tray/menu-bar item could be created: keep the app reachable but out of
    // the way by starting the window MINIMIZED and never visible on boot. On
    // macOS we show the Dock icon so the minimized window can be restored from
    // there (see the 'activate' handler below).
    if (!hasMainWindow()) {
      createMainWindow();
    }
    const StartupWindow = mainWindow;
    StartupWindow?.once('ready-to-show', () => {
      try {
        // Show the Dock icon on macOS so the minimized window stays reachable
        // (clicking the Dock icon triggers the 'activate' handler above).
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show();
        }
        // Start minimized and never focused — reachable (taskbar/Dock) but not
        // visible on boot.
        StartupWindow?.minimize();
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
    return [
      null,
      {
        Profile,
        ProcessMonitorStatus: ProcessMonitor.GetStatus(),
        ServerRecoveryStatus: currentRecoveryStatus,
        AppUpdateStatus: currentAppUpdateStatus,
      },
    ];
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

  // Called by the identify overlay renderer when the user presses Escape or
  // clicks anywhere. We close all overlay windows and notify the socket layer.
  RPC.handle('Identify:Close', async (_event, ...args) => {
    try {
      assertNoArgs('Identify:Close', args);
    } catch (error) {
      return validationErrorPayload(error);
    }
    IdentifyOverlay.HandleUserClose();
    return [null, true];
  });

  // Called by the launch countdown overlay renderer when the operator aborts the
  // pending run-on-launch script (Cancel button, Esc, or Shift).
  RPC.handle('LaunchCountdown:Cancel', async (_event, ...args) => {
    try {
      assertNoArgs('LaunchCountdown:Cancel', args);
    } catch (error) {
      return validationErrorPayload(error);
    }
    LaunchCountdownOverlay.HandleUserCancel();
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

  RPC.handle('Profile:FactoryReset', async (_event, ...args) => {
    try {
      assertNoArgs('Profile:FactoryReset', args);
      await ProfileManager.ResetProfileToFactoryDefaults();
      await ScriptManager.DeleteScripts();
      await restartService('factory-reset');
      return [null, true];
    } catch (error) {
      Logger.error('Factory reset failed', error);
      return validationErrorPayload(error);
    }
  });

  RPC.handle('Profile:SetManualServer', async (_event, ...args) => {
    try {
      const [Host, Port] = args;
      const NormalizedHost = typeof Host === 'string' ? Host.trim() : '';
      if (!NormalizedHost) {
        throw new Error('A server host or IP address is required.');
      }
      const NormalizedPort = Number(Port);
      if (!Number.isInteger(NormalizedPort) || NormalizedPort < 1 || NormalizedPort > 65535) {
        throw new Error('A valid server port between 1 and 65535 is required.');
      }
      await ProfileManager.SetManualServer(NormalizedHost, NormalizedPort);
      await restartService('manual-server-set');
      return [null, true];
    } catch (error) {
      Logger.error('Failed to set manual server endpoint', error);
      return validationErrorPayload(error);
    }
  });

  RPC.handle('Profile:ClearManualServer', async (_event, ...args) => {
    try {
      assertNoArgs('Profile:ClearManualServer', args);
      await ProfileManager.ClearManualServer();
      await restartService('manual-server-clear');
      return [null, true];
    } catch (error) {
      Logger.error('Failed to clear manual server endpoint', error);
      return validationErrorPayload(error);
    }
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
        autoInstallNext = true;
        sendAppUpdateStatus({ state: 'checking' });
        setTimeout(
          () => sendAppUpdateStatus({ state: 'available', info: { version: 'TEST' } }),
          400
        );
        let pct = 0;
        const t = setInterval(() => {
          pct += 20;
          if (pct >= 100) {
            clearInterval(t);
            sendAppUpdateStatus({ state: 'downloaded', info: { version: 'TEST' } });
            sendAppUpdateStatus({ state: 'installing' });
            setTimeout(() => sendAppUpdateStatus({ state: 'installed' }), 400);
          } else {
            sendAppUpdateStatus({ state: 'downloading', percent: pct });
          }
        }, 200);
      } catch (e) {
        sendAppUpdateStatus({ state: 'error', error: String(e) });
      }
      return [null, true];
    }
    autoInstallNext = true;
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
      const Updater = ensureAutoUpdater();
      // Force run after install
      sendAppUpdateStatus({ state: 'installing' });
      requestQuitAndInstall(() => {
        Updater.quitAndInstall(false, true);
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
  // Keep the client alive in the background so identify dismissal does not
  // terminate the process when the last overlay window closes.
});

app.on('before-quit', () => {
  appQuitRequested = true;
  try {
    IdentifyOverlay.Hide();
  } catch {}
});

// macOS Dock-icon click. Only relevant to the no-tray fallback, which created a
// minimized window: restore and focus it. In normal tray mode no window exists
// (and the Dock is hidden), so this is a no-op and the app stays a pure
// menu-bar agent.
app.on('activate', () => {
  const Window = mainWindow;
  if (!Window || Window.isDestroyed()) return;
  try {
    if (Window.isMinimized()) Window.restore();
    Window.show();
    Window.focus();
  } catch {}
});

// ReinitializeService
BroadcastManager.on('ReinitializeService', async () => {
  await restartService('external-reinitialize');
});

// MainClient fires this once per launch after the first successful connection
// (with scripts + auto-start settings already refreshed). RunLaunchActions is
// self-guarded, so any accidental repeat is a no-op.
BroadcastManager.on('RunLaunchAction', (Config) => {
  RunLaunchActions(Config);
});

BroadcastManager.on('ShowIdentifyOverlay', (Payload) => {
  try {
    IdentifyOverlay.Show(Payload);
  } catch (e) {
    Logger.error('Failed to show identify overlay', e);
  }
});

BroadcastManager.on('HideIdentifyOverlay', () => {
  try {
    IdentifyOverlay.Hide();
  } catch (e) {
    Logger.error('Failed to hide identify overlay', e);
  }
});

BroadcastManager.on('ServerConnectFailed', async (Info) => {
  if (recoveryInProgress) return;

  clearRecoveryRetryTimer();

  const now = Date.now();
  const sinceLastAttempt = recoveryMetrics.LastAttemptAt
    ? now - recoveryMetrics.LastAttemptAt
    : Infinity;
  if (sinceLastAttempt < RECOVERY_COOLDOWN_MS) {
    const waitMs = RECOVERY_COOLDOWN_MS - sinceLastAttempt;
    sendRecoveryStatus({
      State: 'PrimaryFailed',
      Message: `Primary failed. Cooling down for ${Math.ceil(waitMs / 1000)}s before retry.`,
    });
    scheduleRecoveryRetry(waitMs, Info);
    return;
  }

  try {
    await recoverFromPrimaryFailure(Info);
  } catch (Error) {
    recoveryMetrics.LastFailureAt = Date.now();
    recoveryMetrics.LastFailureReason = (Error as { message?: unknown })?.message
      ? String((Error as { message?: unknown }).message)
      : 'unknown_error';
    Logger.error('Recovery flow failed', Error);
    sendRecoveryStatus({
      State: 'RecoveryFailed',
      Message: 'Unable to recover server connection automatically.',
    });
  }
});

BroadcastManager.on('ServerAdoptionRejected', async (Info) => {
  const Profile = await ProfileManager.GetProfile();
  const ExpectedServerIdentity =
    Profile && Profile.Server && typeof Profile.Server.ServerIdentity === 'string'
      ? Profile.Server.ServerIdentity.trim()
      : '';
  const RejectedByIdentity =
    Info && typeof Info.ServerIdentity === 'string' ? Info.ServerIdentity.trim() : '';

  if (
    ExpectedServerIdentity &&
    RejectedByIdentity &&
    ExpectedServerIdentity !== RejectedByIdentity
  ) {
    sendRecoveryStatus({
      State: 'RecoveryFailed',
      Message: 'Ignoring adoption rejection from a different server identity.',
    });
    await restartService('server-identity-mismatch');
    return;
  }

  if (recoveryInProgress && pendingRecoveryCandidate) {
    if (
      pendingRecoveryCandidate.IP === Info.IP &&
      Number(pendingRecoveryCandidate.Port) === Number(Info.Port)
    ) {
      sendRecoveryStatus({
        State: 'RecoveryFailed',
        Message: 'Discovered server rejected adoption identity.',
      });
      return;
    }
  }

  Logger.warn('Server rejected client adoption; resetting profile to pending adoption state.');
  await ProfileManager.ResetAdopption();
  await restartService('server-unadopt');
});

BroadcastManager.on('MainClientConnectionStatus', (Info) => {
  if (!Info || Info.State !== 'connected') return;
  if (!recoveryInProgress || !pendingRecoveryCandidate) {
    sendRecoveryStatus({ State: 'idle', Message: '' });
    return;
  }

  if (
    pendingRecoveryCandidate.IP === Info.IP &&
    Number(pendingRecoveryCandidate.Port) === Number(Info.Port)
  ) {
    // Keep explicit state during candidate validation window.
    sendRecoveryStatus({
      State: 'ValidatingIdentity',
      Message: `Validating discovered server at ${Info.IP}:${Info.Port}`,
    });
  }
});

async function restartService(reason: string) {
  if (isReinitializing) {
    Logger.warn(`restartService ignored while already running (${reason})`);
    return;
  }
  isReinitializing = true;
  try {
    try {
      await BonjourManager.Stop();
    } catch {}
    await AdoptionClientManager.Terminate();
    await MainClientManager.Terminate();
    await Main();
  } finally {
    isReinitializing = false;
  }
}

async function recoverFromPrimaryFailure(Info: ServerConnectFailedInfo) {
  clearRecoveryRetryTimer();
  recoveryMetrics.Attempts += 1;
  recoveryMetrics.LastAttemptAt = Date.now();
  recoveryInProgress = true;
  pendingRecoveryCandidate = null;

  const backoffDelay = Math.min(
    RECOVERY_BACKOFF_MAX_MS,
    RECOVERY_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, recoveryMetrics.Attempts - 1))
  );

  sendRecoveryStatus({
    State: 'PrimaryFailed',
    Message: `Primary server ${Info.IP || 'Unknown'}:${Info.Port || 'Unknown'} is unreachable. Retry attempt ${recoveryMetrics.Attempts}.`,
  });

  try {
    await MainClientManager.Terminate();
    if (backoffDelay > 0) {
      sendRecoveryStatus({
        State: 'PrimaryFailed',
        Message: `Waiting ${Math.ceil(backoffDelay / 1000)}s before discovery retry`,
      });
      await Wait(backoffDelay);
    }

    sendRecoveryStatus({
      State: 'Discovering',
      Message: 'Searching for Controlling Server on Local Network',
    });

    const Profile = await ProfileManager.GetProfile();
    const ExpectedServerIdentity =
      Profile && Profile.Server && typeof Profile.Server.ServerIdentity === 'string'
        ? Profile.Server.ServerIdentity.trim()
        : '';

    // When an operator-defined endpoint is configured, recover against it
    // directly instead of relying on mDNS discovery (which cannot cross VLANs).
    const ManualServer = Profile && Profile.ManualServer ? Profile.ManualServer : null;
    let Candidate;
    if (ManualServer && ManualServer.Host && ManualServer.Port) {
      sendRecoveryStatus({
        State: 'ConnectingPrimary',
        Message: `Reconnecting to configured server ${ManualServer.Host}:${ManualServer.Port}`,
      });
      Candidate = {
        IP: ManualServer.Host,
        Port: ManualServer.Port,
        ServerIdentity: null,
      };
    } else {
      Candidate = await discoverSingleServer(12000, {
        ExpectedServerIdentity,
      });
    }
    if (!Candidate || !Candidate.IP || !Candidate.Port) {
      recoveryMetrics.LastFailureAt = Date.now();
      recoveryMetrics.LastFailureReason = 'discovery_no_candidate';
      sendRecoveryStatus({
        State: 'RecoveryFailed',
        Message: 'No server discovered for automatic recovery.',
      });
      await restartService('recovery-no-candidate');
      return;
    }

    pendingRecoveryCandidate = Candidate;
    sendRecoveryStatus({
      State: 'ValidatingIdentity',
      Message: `Validating discovered server at ${Candidate.IP}:${Candidate.Port}`,
    });

    await MainClientManager.Init(Profile.UUID, Candidate.IP, Candidate.Port);

    const Validation = await waitForRecoveryValidation(Candidate, 6000);
    if (!Validation.ok) {
      recoveryMetrics.LastFailureAt = Date.now();
      recoveryMetrics.LastFailureReason = Validation.reason || 'validation_failed';
      sendRecoveryStatus({
        State: 'RecoveryFailed',
        Message:
          Validation.reason === 'rejected'
            ? 'Discovered server rejected adoption identity.'
            : 'Discovered server did not establish a stable connection.',
      });
      await restartService('recovery-validation-failed');
      return;
    }

    await ProfileManager.UpdateServerEndpoint(Candidate.IP, Candidate.Port);
    recoveryMetrics.Attempts = 0;
    recoveryMetrics.LastFailureAt = 0;
    recoveryMetrics.LastFailureReason = null;
    recoveryMetrics.LastRecoveredAt = Date.now();
    sendRecoveryStatus({
      State: 'Reconnected',
      Message: `Recovered connection to ${Candidate.IP}:${Candidate.Port}`,
    });
  } finally {
    recoveryInProgress = false;
    pendingRecoveryCandidate = null;
  }
}

BroadcastManager.on('ProfileUpdated', async (Profile) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('SetProfile', Profile);
});

BroadcastManager.on('ProcessMonitorStatus', async (Status) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ProcessMonitorStatus', Status || { State: 'unknown' });
  }
});

BroadcastManager.on('ScriptsUpdated', () => {
  refreshTrayContextMenu();
});

async function performUpdateCheck(
  options: { Silent?: boolean; FeedURL?: string; TargetVersion?: string | null } = {}
) {
  try {
    const FeedURL = options && options.FeedURL ? String(options.FeedURL).trim() : '';
    const UseLANFeed = !!FeedURL;
    const TargetVersion =
      options && options.TargetVersion ? String(options.TargetVersion).trim() : '';
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
      try {
        SquirrelUpdater.setFeedURL({ url: feed });
      } catch {
        // Legacy Electron accepted a bare string here; current typings only
        // allow FeedURLOptions, so the fallback is asserted explicitly.
        (SquirrelUpdater.setFeedURL as unknown as (url: string) => void)(feed);
      }
      Logger.log('[Updater][Squirrel] checkForUpdates invoked');
      SquirrelUpdater.checkForUpdates();
      return;
    }
    const Updater = ensureAutoUpdater();
    if (!euAutoUpdaterHandlersBound) {
      euAutoUpdaterHandlersBound = true;
      Updater.autoDownload = true;
      Updater.autoInstallOnAppQuit = false;
      Logger.log('[Updater][ElectronUpdater] initialized autoUpdater instance');
      Updater.on('checking-for-update', () => {
        Logger.log('[Updater][ElectronUpdater] checking-for-update');
        sendAppUpdateStatus({ state: 'checking' });
      });
      Updater.on('update-available', (info) => {
        Logger.log('[Updater][ElectronUpdater] update-available', info || {});
        sendAppUpdateStatus({ state: 'available', info });
      });
      Updater.on('update-not-available', (info) => {
        Logger.log('[Updater][ElectronUpdater] update-not-available', info || {});
        sendAppUpdateStatus({ state: 'none', info });
      });
      Updater.on('error', (err) => {
        Logger.error('[Updater][ElectronUpdater] error', err);
        sendAppUpdateStatus({ state: 'error', error: String(err) });
      });
      Updater.on('download-progress', (p) => {
        Logger.log('[Updater][ElectronUpdater] download-progress', {
          percent: p && p.percent ? p.percent : 0,
          bytesPerSecond: p && p.bytesPerSecond ? p.bytesPerSecond : null,
          transferred: p && p.transferred ? p.transferred : null,
          total: p && p.total ? p.total : null,
        });
        sendAppUpdateStatus({ state: 'downloading', percent: p && p.percent ? p.percent : 0 });
      });
      Updater.on('update-downloaded', async (info) => {
        Logger.log('[Updater][ElectronUpdater] update-downloaded', {
          info: info || {},
          autoInstallNext,
        });
        sendAppUpdateStatus({ state: 'downloaded', info });
        if (autoInstallNext) {
          try {
            sendAppUpdateStatus({ state: 'installing' });
            requestQuitAndInstall(() => {
              Updater.quitAndInstall(false, true);
            }, 'electron-updater-auto');
          } catch (e) {
            sendAppUpdateStatus({ state: 'error', error: String(e) });
          }
        }
      });
    }
    try {
      Updater.allowDowngrade = AllowDowngrade;
      Logger.log('[Updater][ElectronUpdater] allowDowngrade set', {
        value: Updater.allowDowngrade,
      });
    } catch (err) {
      Logger.error('[Updater][ElectronUpdater] failed to set allowDowngrade', err);
    }
    // Provide update config dynamically if missing.
    const resourcesPath = typeof process !== 'undefined' ? process.resourcesPath : '';
    const execDir =
      typeof process !== 'undefined' && process.execPath ? path.dirname(process.execPath) : '';
    const ymlPaths = [
      resourcesPath ? path.join(resourcesPath, 'app-update.yml') : '',
      execDir ? path.join(execDir, 'app-update.yml') : '',
    ].filter(Boolean);
    const hasYml = ymlPaths.some((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });
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
        Updater.updateConfigPath = tmpYml;
        Logger.log('[Updater][ElectronUpdater] using temporary update config', {
          path: tmpYml,
          content: yml,
        });
      } catch (err) {
        Logger.error('[Updater][ElectronUpdater] failed to write temporary update config', err);
      }
    }

    if (UseLANFeed && typeof Updater.setFeedURL === 'function') {
      try {
        Updater.setFeedURL({ provider: 'generic', url: FeedURL });
        Logger.log('[Updater][ElectronUpdater] setFeedURL applied for LAN feed', {
          feedUrl: FeedURL,
        });
      } catch (err) {
        Logger.error('[Updater][ElectronUpdater] setFeedURL failed for LAN feed', err);
      }
    }

    Logger.log('[Updater][ElectronUpdater] invoking checkForUpdates');
    await Updater.checkForUpdates();
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
  const TargetVersion =
    Payload && Payload.ReleaseVersion ? String(Payload.ReleaseVersion).trim() : '';
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
            const msg =
              statusPayload && statusPayload.error ? String(statusPayload.error) : 'Update failed';
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
        return Callback(
          `Requested version ${TargetVersion} was reported as unavailable by the updater`
        );
      }
      Logger.log(
        '[Updater][RemoteLAN] no update available because client is already on requested version'
      );
      return Callback(null);
    }
    Logger.log('[Updater][RemoteLAN] remote LAN update download completed');
    return Callback(null);
  } catch (Err) {
    Logger.error('[Updater][RemoteLAN] remote LAN update failed', Err);
    const AsError = Err as { message?: unknown } | null | undefined;
    return Callback(AsError && AsError.message ? String(AsError.message) : String(Err));
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

    // Prefer an operator-defined endpoint so adoption works across VLANs where
    // mDNS/Bonjour multicast cannot reach the server.
    const ManualServer = Profile.ManualServer || null;
    if (ManualServer && ManualServer.Host && ManualServer.Port) {
      sendRecoveryStatus({
        State: 'ConnectingPrimary',
        Message: `Connecting to configured server ${ManualServer.Host}:${ManualServer.Port} for adoption...`,
      });
      await AdoptionClientManager.Init(Profile.UUID, ManualServer.Host, ManualServer.Port, {
        ServerIdentity: null,
      });
      return;
    }

    sendRecoveryStatus({
      State: 'Discovering',
      Message: 'Searching for ShowTrak Server for adoption...',
    });

    const Candidate = await discoverSingleServer(12000);
    if (!Candidate || !Candidate.IP || !Candidate.Port) {
      sendRecoveryStatus({
        State: 'RecoveryFailed',
        Message: 'No ShowTrak Server discovered for adoption.',
      });
      return;
    }

    await AdoptionClientManager.Init(Profile.UUID, Candidate.IP, Candidate.Port, {
      ServerIdentity: Candidate.ServerIdentity || null,
    });
  }
}

async function BootWithStoredSettings() {
  const Profile = await ProfileManager.GetProfile();
  // Main() only reaches here once it has verified Adopted + Server.IP + Port,
  // so this is a restatement of that precondition rather than a new code path.
  const Server = Profile.Server;
  if (!Server || !Server.IP || !Server.Port) {
    Logger.error('BootWithStoredSettings called without a stored server endpoint; ignoring.');
    return;
  }
  sendRecoveryStatus({
    State: 'ConnectingPrimary',
    Message: `Connecting to saved server ${Server.IP}:${Server.Port}`,
  });
  Logger.log(`Attempting connection to ${Server.IP}:${Server.Port}`);
  await MainClientManager.Init(Profile.UUID, Server.IP, Server.Port);
}

function extractServerIdentityToken(Service: DiscoveredService | null | undefined): string {
  const txt = Service && Service.txt ? Service.txt : null;
  if (!txt || typeof txt !== 'object') return '';
  if (typeof txt.ServerIdentity === 'string' && txt.ServerIdentity.trim()) {
    return txt.ServerIdentity.trim();
  }
  return '';
}

async function discoverSingleServer(
  timeoutMs = 12000,
  Options: { ExpectedServerIdentity?: string } = {}
): Promise<ServerCandidate | null> {
  return new Promise((resolve) => {
    let settled = false;
    const ExpectedServerIdentity =
      Options && typeof Options.ExpectedServerIdentity === 'string'
        ? Options.ExpectedServerIdentity.trim()
        : '';

    const finish = async (Result: ServerCandidate | null) => {
      if (settled) return;
      settled = true;
      try {
        await BonjourManager.Stop();
      } catch {}
      resolve(Result || null);
    };

    const timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);

    BonjourManager.OnFind(async (Server) => {
      Logger.log('Bonjour service found:', Server);
      try {
        const ServerIdentity = extractServerIdentityToken(Server);
        if (ExpectedServerIdentity && ServerIdentity !== ExpectedServerIdentity) {
          Logger.warn(
            `Skipping discovered server due to identity mismatch (${ServerIdentity || 'missing'} != ${ExpectedServerIdentity})`
          );
          return;
        }

        const addrs = Array.isArray(Server.addresses) ? Server.addresses : [];
        let targetIP = addrs.find((a) => typeof a === 'string' && a.includes('.')) || null;
        if (
          !targetIP &&
          Server.referer &&
          typeof Server.referer.address === 'string' &&
          Server.referer.address.includes('.')
        ) {
          targetIP = Server.referer.address;
        }
        if (!targetIP && typeof Server.host === 'string' && Server.host.length) {
          try {
            const looked = await dns.lookup(Server.host, { family: 4 });
            if (looked && looked.address) targetIP = looked.address;
          } catch {}
        }
        if (!targetIP) {
          Logger.warn(
            'Bonjour service discovered but no IPv4 address resolved; skipping this record.'
          );
          return;
        }

        clearTimeout(timer);
        Logger.log(`Discovered ShowTrak Server at ${targetIP}:${Server.port}`);
        await finish({
          IP: targetIP,
          Port: Server.port,
          ServerIdentity: ServerIdentity || null,
        });
      } catch (Error) {
        clearTimeout(timer);
        Logger.error('Failed to process Bonjour discovery record', Error);
        await finish(null);
      }
    });
  });
}

async function waitForRecoveryValidation(
  Candidate: ServerCandidate,
  timeoutMs = 6000
): Promise<RecoveryValidation> {
  return new Promise((resolve) => {
    let settled = false;

    const finish = (Result: RecoveryValidation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      BroadcastManager.removeListener('ServerAdoptionRejected', onRejected);
      BroadcastManager.removeListener('MainClientConnectionStatus', onConnectionStatus);
      resolve(Result);
    };

    const onRejected = (Info: ServerAdoptionRejectedInfo) => {
      if (Info.IP === Candidate.IP && Number(Info.Port) === Number(Candidate.Port)) {
        finish({ ok: false, reason: 'rejected' });
      }
    };

    const onConnectionStatus = (Info: MainClientConnectionStatus) => {
      if (Info.IP !== Candidate.IP || Number(Info.Port) !== Number(Candidate.Port)) {
        return;
      }
      if (Info.State === 'connected') {
        finish({ ok: true });
      }
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    BroadcastManager.on('ServerAdoptionRejected', onRejected);
    BroadcastManager.on('MainClientConnectionStatus', onConnectionStatus);
  });
}
