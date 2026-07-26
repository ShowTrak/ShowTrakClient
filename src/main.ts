// ShowTrak Client — Electron main process entry point.
//
// This file is deliberately thin. It owns only process-level concerns: the
// Squirrel install hand-off, process guards, the single-instance lock, the
// app-lifecycle event handlers, and the whenReady boot order. Everything else
// lives in src/main/*, mirroring ShowTrakServer's layout:
//
//   app-window.ts        the config window + BASE_WEB_PREFERENCES
//   window-guards.ts     per-window navigation/link security
//   renderer-bus.ts      the one guarded path for main -> renderer pushes
//   rpc.ts               IPC handler plumbing
//   ipc-handlers.ts      the channels the config window can invoke
//   tray.ts              tray item and context menu
//   discovery.ts         mDNS discovery of a server
//   service-lifecycle.ts Main() / restartService()
//   recovery-status.ts   last recovery status + metrics
//   recovery.ts          the server-recovery state machine
//   app-updater.ts       Squirrel + electron-updater, incl. LAN updates
//   launch-actions.ts    run-on-launch countdown + execution
//   broadcast-bridge.ts  BroadcastManager -> main-process actions
//
// The import order below matters and is not alphabetised: the Squirrel check and
// installProcessGuards() must run before anything that could throw or spawn.

import { app } from 'electron';
import squirrelStartup from 'electron-squirrel-startup';

import { CreateLogger } from './Modules/Logger';
import { installProcessGuards } from './Modules/ProcessGuards';

if (squirrelStartup) app.quit();

// Installed before anything else can throw: an unattended agent must survive a
// NIC flap or a closed stdout rather than dying somewhere nobody is watching.
installProcessGuards();

const Logger = CreateLogger('Main');

import { openConfigureWindow, restoreExistingWindow } from './main/app-window';

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
    } catch (Err) {
      Logger.warn('Failed to open config window for second-instance launch', String(Err));
    }
  });
}

import { Manager as IdentifyOverlay } from './Modules/IdentifyOverlay';
import { Manager as LaunchCountdownOverlay } from './Modules/LaunchCountdownOverlay';
import { Manager as StartupManager } from './Modules/Startup';
import { Manager as BroadcastManager } from './Modules/Broadcast';
import { Manager as AppDataManager } from './Modules/AppData';
AppDataManager.Initialize();

import {
  BASE_WEB_PREFERENCES,
  createMainWindow,
  getMainWindow,
  hasMainWindow,
  setAppQuitRequested,
} from './main/app-window';
import { performUpdateCheck } from './main/app-updater';
import { registerBroadcastBridge } from './main/broadcast-bridge';
import { registerIpcHandlers } from './main/ipc-handlers';
import { Main } from './main/service-lifecycle';
import { Configure as ConfigureTray, createTray } from './main/tray';

// Wired up front, before whenReady: the socket layer can emit a
// ServerConnectFailed while the app is still starting, and dropping it would
// leave the client with no recovery attempt at all.
registerBroadcastBridge();

app.whenReady().then(async () => {
  await StartupManager.EnsureEnabled();

  IdentifyOverlay.Configure({
    webPreferences: BASE_WEB_PREFERENCES,
    onClose: () => {
      BroadcastManager.emit('IdentifyStoppedByUser');
    },
  });

  LaunchCountdownOverlay.Configure({ webPreferences: BASE_WEB_PREFERENCES });

  ConfigureTray({ onCheckForUpdates: () => performUpdateCheck() });

  // Tray support is reliable on Windows and macOS but varies across Linux
  // desktops. If it fails, fall back to a minimized window so the app stays
  // reachable rather than running invisibly with no way to configure it.
  if (createTray()) {
    if (process.platform === 'darwin' && app.dock) {
      // Hide the Dock icon only once the tray is confirmed available, so we never
      // end up with neither.
      try {
        app.dock.hide();
      } catch (Err) {
        Logger.debug('Dock hide failed', String(Err));
      }
    }
  } else {
    if (!hasMainWindow()) {
      createMainWindow();
    }
    const StartupWindow = getMainWindow();
    StartupWindow?.once('ready-to-show', () => {
      try {
        // Show the Dock icon on macOS so the minimized window stays reachable
        // (clicking the Dock icon triggers the 'activate' handler below).
        if (process.platform === 'darwin' && app.dock) {
          app.dock.show();
        }
        // Start minimized and never focused — reachable (taskbar/Dock) but not
        // visible on boot.
        StartupWindow?.minimize();
      } catch (Err) {
        Logger.debug('Startup window minimize failed', String(Err));
      }
    });
  }

  registerIpcHandlers();

  Main();
});

app.on('window-all-closed', () => {
  // Keep the client alive in the background so identify dismissal does not
  // terminate the process when the last overlay window closes.
});

app.on('before-quit', () => {
  setAppQuitRequested(true);
  try {
    IdentifyOverlay.Hide();
  } catch (Err) {
    Logger.debug('Identify overlay hide failed during quit', String(Err));
  }
});

// macOS Dock-icon click. Only relevant to the no-tray fallback, which created a
// minimized window: restore and focus it. In normal tray mode no window exists
// (and the Dock is hidden), so this is a no-op and the app stays a pure
// menu-bar agent.
app.on('activate', () => {
  restoreExistingWindow();
});
