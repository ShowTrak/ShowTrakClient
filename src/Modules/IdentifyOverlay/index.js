// IdentifyOverlay
// Renders a full-screen, always-on-top "identify" overlay on every connected
// display so an operator can physically locate this machine. The overlay is a
// borderless BrowserWindow per display (not true fullscreen/kiosk) so it never
// forces a Space switch or crashes other full-screen apps. Esc or a click
// dismisses it.
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('IdentifyOverlay');

const { BrowserWindow, screen } = require('electron');
const path = require('path');
const os = require('os');

let overlayWindows = [];
let baseWebPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
};
let onUserClose = null;

const OVERLAY_HTML = path.join(__dirname, '..', '..', 'UI', 'identify-overlay.html');
const OVERLAY_PRELOAD = path.join(__dirname, '..', '..', 'identify-preload.js');
const USE_WORK_AREA_BOUNDS = os.platform() === 'darwin';

const Manager = {};

function normalizeBounds(candidate, fallback) {
  if (!candidate) return fallback;
  const width = Number(candidate.width);
  const height = Number(candidate.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return fallback;
  }

  return {
    x: Math.floor(Number(candidate.x) || 0),
    y: Math.floor(Number(candidate.y) || 0),
    width: Math.ceil(width),
    height: Math.ceil(height),
  };
}

// Called once from main.js so the overlay uses the same hardened webPreferences
// and can notify the socket layer when the user dismisses it.
Manager.Configure = ({ webPreferences, onClose } = {}) => {
  if (webPreferences) baseWebPreferences = webPreferences;
  if (typeof onClose === 'function') onUserClose = onClose;
};

Manager.IsActive = () => overlayWindows.length > 0;

// Show the overlay across all displays with the supplied machine details.
Manager.Show = (Payload = {}) => {
  // Always start from a clean slate so display/topology changes are respected.
  Manager.Hide();

  const Data = {
    Hostname: Payload && Payload.Hostname ? String(Payload.Hostname) : '',
    Nickname: Payload && Payload.Nickname ? String(Payload.Nickname) : '',
    IPs: Array.isArray(Payload && Payload.IPs) ? Payload.IPs.map(String) : [],
  };
  const search = encodeURIComponent(JSON.stringify(Data));

  let displays = [];
  try {
    displays = screen.getAllDisplays();
  } catch (e) {
    Logger.error('Failed to enumerate displays', e);
  }
  if (!displays || !displays.length) {
    try {
      displays = [screen.getPrimaryDisplay()];
    } catch {
      displays = [];
    }
  }

  for (const [displayIndex, display] of displays.entries()) {
    try {
      const Bounds = display.bounds || { x: 0, y: 0, width: 800, height: 600 };
      const FallbackBounds = normalizeBounds(Bounds, { x: 0, y: 0, width: 800, height: 600 });
      const WorkAreaBounds = USE_WORK_AREA_BOUNDS
        ? normalizeBounds(display.workArea, FallbackBounds)
        : FallbackBounds;
      const ScaleFactor = Number(display.scaleFactor) || 1;
      const NativeWidth = Math.max(1, Math.round(Number(Bounds.width) * ScaleFactor) || 800);
      const NativeHeight = Math.max(1, Math.round(Number(Bounds.height) * ScaleFactor) || 600);
      const WindowBounds = WorkAreaBounds;
      const ScreenIndex = displayIndex + 1;
      const ResolutionLabel = `Screen ${ScreenIndex} (${NativeWidth}x${NativeHeight})`;
      const win = new BrowserWindow({
        x: WindowBounds.x,
        y: WindowBounds.y,
        width: WindowBounds.width,
        height: WindowBounds.height,
        frame: false,
        transparent: false,
        backgroundColor: '#05070d',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        alwaysOnTop: true,
        focusable: true,
        webPreferences: {
          ...baseWebPreferences,
          preload: OVERLAY_PRELOAD,
          devTools: false,
        },
      });

      // Float above everything, including other apps' full-screen windows,
      // without stealing the current Space.
      try {
        win.setAlwaysOnTop(true, 'screen-saver');
      } catch (e) {
        Logger.warn('setAlwaysOnTop failed', e);
      }
      try {
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      } catch (_err) {
        // Ignore platform-specific failures here; the overlay still works.
      }

      win.loadFile(OVERLAY_HTML, {
        search: `?data=${search}&resolutionLabel=${encodeURIComponent(ResolutionLabel)}`,
      });
      win.once('ready-to-show', () => {
        if (win.isDestroyed()) return;
        try {
          win.setBounds(WindowBounds, false);
        } catch (_err) {
          // Ignore sizing failures and continue showing the overlay.
        }
        win.show();
      });

      // Keyboard fallback in case the renderer script fails to load.
      win.webContents.on('before-input-event', (_event, input) => {
        if (input && input.type === 'keyDown' && input.key === 'Escape') {
          Manager.HandleUserClose();
        }
      });

      overlayWindows.push(win);
    } catch (e) {
      Logger.error('Failed to create identify overlay window', e);
    }
  }

  if (overlayWindows.length) {
    Logger.log(`Identify overlay shown on ${overlayWindows.length} display(s)`);
  }
};

// User dismissed the overlay (esc / click). Hide it and notify the socket layer
// once so the server can clear identify state.
Manager.HandleUserClose = () => {
  const WasActive = overlayWindows.length > 0;
  Manager.Hide();
  if (WasActive && typeof onUserClose === 'function') {
    try {
      onUserClose();
    } catch (e) {
      Logger.warn('onUserClose handler failed', e);
    }
  }
};

// Tear down all overlay windows (server-initiated stop, or before re-showing).
Manager.Hide = () => {
  for (const win of overlayWindows) {
    try {
      if (win && !win.isDestroyed()) win.destroy();
    } catch (_err) {
      // Best-effort cleanup only.
    }
  }
  overlayWindows = [];
};

module.exports = {
  Manager,
};
