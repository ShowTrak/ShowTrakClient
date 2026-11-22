// The window both overlays (IdentifyOverlay, LaunchCountdownOverlay) are drawn
// in: borderless, fixed in place, above everything, and hardened. Borderless
// rather than true fullscreen or kiosk, so showing one never forces a Space
// switch or upsets another app's full-screen window.
import { BrowserWindow, type Rectangle, type WebPreferences } from 'electron';

import type { Logger } from '../Logger';

/** What an overlay uses until main.ts Configure()s it with the app's shared set. */
export const DEFAULT_OVERLAY_WEB_PREFERENCES: WebPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
};

export interface OverlayWindowOptions {
  Bounds: Rectangle;
  HasShadow: boolean;
  WebPreferences: WebPreferences;
  /** The page's preload: always set, whatever WebPreferences says. */
  Preload: string;
  /** Where a failure to raise the window above full-screen apps is reported. */
  Logger: Pick<Logger, 'warn'>;
}

/**
 * Create an overlay window, hidden until the caller shows it. It floats above
 * everything, including other apps' full-screen windows, on every workspace,
 * without stealing the current Space. Throws when the window cannot be created.
 */
export function CreateOverlayWindow(Options: OverlayWindowOptions): BrowserWindow {
  const { Bounds } = Options;
  const Window = new BrowserWindow({
    x: Bounds.x,
    y: Bounds.y,
    width: Bounds.width,
    height: Bounds.height,
    frame: false,
    transparent: false,
    backgroundColor: '#05070d',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: Options.HasShadow,
    show: false,
    alwaysOnTop: true,
    focusable: true,
    webPreferences: {
      ...Options.WebPreferences,
      preload: Options.Preload,
      devTools: false,
    },
  });
  try {
    Window.setAlwaysOnTop(true, 'screen-saver');
  } catch (error) {
    Options.Logger.warn('setAlwaysOnTop failed', error);
  }
  try {
    Window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } catch (_error) {
    // Platform-specific; the overlay still works without it.
  }
  return Window;
}
