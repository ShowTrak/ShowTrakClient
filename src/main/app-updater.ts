// Application self-update.
//
// Two independent update mechanisms live here, and which one runs is decided by
// isSquirrelWindows():
//
//   - Squirrel (Windows, installed builds): Electron's built-in `autoUpdater`,
//     driven by a feed URL.
//   - electron-updater (everything else): lazily required, driven by an
//     app-update.yml that is synthesised into the temp dir when the packaged one
//     is missing or when a LAN feed overrides it.
//
// Three entry points:
//   - performUpdateCheck()  — tray item and IPC 'AppUpdate:Check'
//   - installUpdate()       — IPC 'AppUpdate:Install'
//   - the two Broadcast handlers registered by broadcast-bridge.ts, for
//     server-triggered updates ('UpdateSoftware' and the LAN variant)
//
// The LAN path is the interesting one: the server hands the client a relative
// feed path, MainClient resolves it against the connected server's origin, and
// the resulting session routes updater progress events back over the socket so
// the operator watches a real progress bar in the server's execution panel.
// Exactly one such session runs at a time (ActiveRemoteUpdateSession).
//
// Extracted from main.ts; behaviour unchanged.

import { app, autoUpdater as SquirrelUpdater } from 'electron';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AppUpdateStatus } from '../types/preload';
import { CreateLogger } from '../Modules/Logger';
import { Config } from '../Modules/Config';
import { PushToRenderer } from './renderer-bus';
import { destroyTray, hasTray } from './tray';
import {
  hasMainWindow,
  isAppQuitRequested,
  removeCloseGuard,
  setAppQuitRequested,
} from './app-window';

const Logger = CreateLogger('Updater');

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

let currentAppUpdateStatus: AppUpdateStatus | null = null;
let euAutoUpdater: import('electron-updater').AppUpdater | null = null;
let euAutoUpdaterHandlersBound = false;
let squirrelUpdaterInitialized = false;
let autoInstallNext = false; // when true, auto-install on update-downloaded
let ActiveRemoteUpdateSession: RemoteUpdateSession | null = null;

function getAppUpdateStatus(): AppUpdateStatus | null {
  return currentAppUpdateStatus;
}

function sendAppUpdateStatus(payload: AppUpdateStatus): void {
  currentAppUpdateStatus = payload || null;
  Logger.log('[Updater] Status event', payload || {});
  PushToRenderer('AppUpdate:Status', payload);
  try {
    if (ActiveRemoteUpdateSession && typeof ActiveRemoteUpdateSession.onStatus === 'function') {
      ActiveRemoteUpdateSession.onStatus(payload || {});
    }
  } catch (Err) {
    Logger.debug('Remote update session status relay failed', String(Err));
  }
}

// Lazily resolve the electron-updater instance. Returns a non-null updater so
// callers do not each have to re-prove initialisation; the one-time event
// handler binding is tracked separately by euAutoUpdaterHandlersBound.
//
// Lazy on purpose: electron-updater dereferences `app.getVersion()` at
// construction, so importing it eagerly would make this module unloadable
// outside a running Electron main process (including under `node --test`).
function ensureAutoUpdater(): import('electron-updater').AppUpdater {
  if (!euAutoUpdater) {
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
    euAutoUpdater = autoUpdater;
  }
  return euAutoUpdater;
}

// Get out of our own way before handing control to an installer: drop the tray
// item and relax the hide-to-tray close guard, so neither intercepts the quit.
// Returns a rollback for the case where the install call itself throws.
function prepareForQuitAndInstall(context = 'unknown') {
  const previousQuitRequested = isAppQuitRequested();
  setAppQuitRequested(true);
  try {
    destroyTray();
  } catch (Err) {
    Logger.warn('[Updater] Failed to destroy tray before install', {
      context,
      error: String(Err),
    });
  }
  try {
    removeCloseGuard();
  } catch (Err) {
    Logger.warn('[Updater] Failed to relax window close guard before install', {
      context,
      error: String(Err),
    });
  }

  return () => {
    setAppQuitRequested(previousQuitRequested);
  };
}

function requestQuitAndInstall(runInstall: () => void, context = 'unknown'): void {
  const restoreQuitState = prepareForQuitAndInstall(context);
  try {
    Logger.log('[Updater] quitAndInstall requested', {
      context,
      hasTray: hasTray(),
      hasMainWindow: hasMainWindow(),
    });
    runInstall();
  } catch (Err) {
    restoreQuitState();
    throw Err;
  }
}

// Map an updater state onto (percent, label) for the server's execution panel.
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

// Detect a Squirrel-installed Windows build by looking for the Update.exe that
// Squirrel places one or two levels above the app binary.
function isSquirrelWindows(): boolean {
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

function initSquirrelUpdater(): void {
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
        } catch (Err) {
          sendAppUpdateStatus({ state: 'error', error: String(Err) });
        }
      }
    });
    SquirrelUpdater.on('error', (err) => {
      Logger.error('[Updater][Squirrel] error', err);
      sendAppUpdateStatus({ state: 'error', error: String(err) });
    });
  } catch (Err) {
    Logger.warn('[Updater][Squirrel] Failed to bind updater events', String(Err));
  }
}

// Bind electron-updater's event handlers exactly once.
function bindElectronUpdaterHandlers(Updater: import('electron-updater').AppUpdater): void {
  if (euAutoUpdaterHandlersBound) return;
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
      } catch (Err) {
        sendAppUpdateStatus({ state: 'error', error: String(Err) });
      }
    }
  });
}

// Ensure electron-updater has an app-update.yml to read.
//
// A packaged build normally ships one. When it is missing (or when a LAN feed
// must override it) we synthesise one into the temp dir, keyed by pid so
// concurrent runs cannot clobber each other.
function ensureUpdateConfig(
  Updater: import('electron-updater').AppUpdater,
  UseLANFeed: boolean,
  FeedURL: string
): void {
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
}

async function performUpdateCheck(
  options: { Silent?: boolean; FeedURL?: string; TargetVersion?: string | null } = {}
): Promise<void> {
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
    bindElectronUpdaterHandlers(Updater);

    try {
      Updater.allowDowngrade = AllowDowngrade;
      Logger.log('[Updater][ElectronUpdater] allowDowngrade set', {
        value: Updater.allowDowngrade,
      });
    } catch (err) {
      Logger.error('[Updater][ElectronUpdater] failed to set allowDowngrade', err);
    }

    ensureUpdateConfig(Updater, UseLANFeed, FeedURL);

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
  } catch (Err) {
    Logger.error('[Updater] performUpdateCheck failed', Err);
    sendAppUpdateStatus({ state: 'error', error: String(Err) });
  }
}

// IPC 'AppUpdate:Check'. Unpackaged builds get a scripted fake sequence so the
// config window's updater panel can be exercised in development.
async function checkForUpdatesFromRenderer(): Promise<void> {
  if (!app.isPackaged) {
    try {
      autoInstallNext = true;
      sendAppUpdateStatus({ state: 'checking' });
      setTimeout(() => sendAppUpdateStatus({ state: 'available', info: { version: 'TEST' } }), 400);
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
    } catch (Err) {
      sendAppUpdateStatus({ state: 'error', error: String(Err) });
    }
    return;
  }
  autoInstallNext = true;
  await performUpdateCheck();
}

// IPC 'AppUpdate:Install'.
//
// Pushes an 'error' status before rethrowing, so a failed install shows up in the
// config window's updater panel and not only in the caller's error tuple — the
// operator is usually watching that panel, not the return value.
function installUpdate(): void {
  if (!app.isPackaged) {
    sendAppUpdateStatus({ state: 'installing' });
    setTimeout(() => sendAppUpdateStatus({ state: 'installed' }), 400);
    return;
  }
  try {
    if (isSquirrelWindows()) {
      sendAppUpdateStatus({ state: 'installing' });
      requestQuitAndInstall(() => {
        SquirrelUpdater.quitAndInstall(); // auto-restart
      }, 'squirrel-manual');
      return;
    }
    const Updater = ensureAutoUpdater();
    // Force run after install
    sendAppUpdateStatus({ state: 'installing' });
    requestQuitAndInstall(() => {
      Updater.quitAndInstall(false, true);
    }, 'electron-updater-manual');
  } catch (Err) {
    sendAppUpdateStatus({ state: 'error', error: String(Err) });
    throw Err;
  }
}

// Broadcast 'UpdateSoftware': the server asked this client to self-update from
// its normal (GitHub) feed.
async function handleRemoteUpdateRequest(Callback: (err: string | null) => void): Promise<void> {
  Logger.log('[Updater][Remote] UpdateSoftware request received from server');
  if (!app.isPackaged) return Callback('App is not packaged, skipping update check');
  autoInstallNext = true; // remote trigger should auto-install when ready
  Logger.log('[Updater][Remote] autoInstallNext enabled for remote self-update');
  await performUpdateCheck();
  Logger.log('[Updater][Remote] UpdateSoftware request dispatched to updater');
  return Callback(null);
}

// Broadcast 'UpdateSoftwareFromLAN': the server is hosting the release itself.
//
// Installs an ActiveRemoteUpdateSession so updater status events are relayed back
// as socket progress, and resolves once a terminal state is reached. 'none' is
// only an error when a specific version was requested and we are not already on
// it — otherwise it legitimately means "already up to date".
async function handleRemoteLanUpdateRequest(
  Payload: { FeedURL?: string; ReleaseVersion?: string | null } | null | undefined,
  ProgressCallback: ((progress: number, statusText: string) => void | Promise<void>) | undefined,
  Callback: (err: string | null) => void
): Promise<void> {
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
  } catch (Err) {
    Logger.debug('[Updater][RemoteLAN] initial progress callback failed', String(Err));
  }

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
          } catch (Err) {
            Logger.debug('[Updater][RemoteLAN] progress callback failed', String(Err));
          }

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
}

export {
  checkForUpdatesFromRenderer,
  getAppUpdateStatus,
  handleRemoteLanUpdateRequest,
  handleRemoteUpdateRequest,
  installUpdate,
  isSquirrelWindows,
  mapUpdaterStateToProgress,
  normalizeVersionToken,
  performUpdateCheck,
  sendAppUpdateStatus,
};
