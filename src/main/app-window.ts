// Config-window ownership for the Electron main process.
//
// main.ts used to hold `mainWindow` and `appQuitRequested` as module-local `let`s,
// which meant every IPC handler, broadcast subscriber and updater step that
// needed to guard against window teardown had to live inside the same
// 1,600-line closure. Putting the window behind get/set/has accessors lets the
// decomposed modules share it without threading a `deps` object through
// everything.
//
// Mirrors ShowTrakServer's src/main/app-window.ts.

import { app, BrowserWindow } from 'electron';
import path from 'path';

import { CreateLogger } from '../Modules/Logger';
import { applyWindowSecurityGuards } from './window-guards';

const Logger = CreateLogger('AppWindow');

// Shared by the config window AND both overlay windows (IdentifyOverlay,
// LaunchCountdownOverlay are Configure()d with it), so it lives here rather than
// in main.ts — every window this app opens must be sandboxed and
// context-isolated, and that should be stated in one place.
const BASE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
});

// The live config window, or null before creation / after teardown.
let mainWindow: BrowserWindow | null = null;

// Distinguishes "the app is really shutting down" from "the user closed the
// window", which hides to tray instead. Written by the before-quit handler and
// by the updater immediately before quitAndInstall; read by the close handler.
let appQuitRequested = false;

function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

// True when a usable (non-destroyed) window exists. The canonical guard before
// any webContents access.
function hasMainWindow(): boolean {
  return !!mainWindow && !mainWindow.isDestroyed();
}

function isAppQuitRequested(): boolean {
  return appQuitRequested;
}

function setAppQuitRequested(value: boolean): void {
  appQuitRequested = value;
}

// Resolve the window icon for the current platform. Electron uses .ico on
// Windows and prefers .png elsewhere; the .icns is only used by the packager.
function getWindowIconPath(): string {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return path.join(__dirname, '..', 'images', iconName);
}

function createMainWindow(): BrowserWindow {
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
      preload: path.join(__dirname, '..', 'preload.js'),
      devTools: !app.isPackaged,
    },
    icon: getWindowIconPath(),
    frame: true,
    titleBarStyle: 'hidden',
  });

  const Window = mainWindow;
  Window.loadFile(path.join(__dirname, '..', 'UI', 'index.html'));
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
      } catch {
        Logger.debug('Window hide failed during close; window is already gone');
      }
    }
  });

  Window.on('closed', () => {
    mainWindow = null;
  });

  return Window;
}

// Surface the config GUI, creating the window if it does not exist yet.
function openConfigureWindow(): void {
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
  } catch (Err) {
    Logger.warn('Failed to surface the config window', String(Err));
  }
}

// macOS Dock-icon click / no-tray fallback: restore and focus an existing
// window. A no-op when no window exists, which is the normal tray-mode state.
function restoreExistingWindow(): void {
  const Window = mainWindow;
  if (!Window || Window.isDestroyed()) return;
  try {
    if (Window.isMinimized()) Window.restore();
    Window.show();
    Window.focus();
  } catch (Err) {
    Logger.warn('Failed to restore the config window', String(Err));
  }
}

// Relax the close guard so quitAndInstall is not intercepted by hide-to-tray.
function removeCloseGuard(): void {
  if (hasMainWindow()) {
    mainWindow?.removeAllListeners('close');
  }
}

export {
  BASE_WEB_PREFERENCES,
  createMainWindow,
  getMainWindow,
  getWindowIconPath,
  hasMainWindow,
  isAppQuitRequested,
  openConfigureWindow,
  removeCloseGuard,
  restoreExistingWindow,
  setAppQuitRequested,
};
