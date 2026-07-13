// LaunchCountdownOverlay
// Renders a single, centered, always-on-top countdown window before a
// run-on-launch script executes. The countdown IS the abort window: the script
// only runs once the timer expires, and the operator can cancel it at any point
// (Cancel button, Esc, Shift, or clicking the window). This is the safety net
// against a destructive script (e.g. shutdown) trapping an auto-launching
// machine in a boot loop.
const { CreateLogger } = require('../Logger');
const Logger = CreateLogger('LaunchCountdownOverlay');

const { BrowserWindow, screen } = require('electron');
const path = require('path');

let overlayWindow = null;
let currentResolve = null;
let expiryTimer = null;
let baseWebPreferences = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webSecurity: true,
};

const OVERLAY_HTML = path.join(__dirname, '..', '..', 'UI', 'launch-countdown-overlay.html');
const OVERLAY_PRELOAD = path.join(__dirname, '..', '..', 'launch-countdown-preload.js');

const WINDOW_WIDTH = 560;
const WINDOW_HEIGHT = 320;

const Manager = {};

// Called once from main.js so the overlay uses the same hardened webPreferences.
Manager.Configure = ({ webPreferences } = {}) => {
  if (webPreferences) baseWebPreferences = webPreferences;
};

Manager.IsActive = () => overlayWindow !== null;

// Settle the pending Show() promise exactly once, tearing the window down.
function Settle(Outcome) {
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  const Resolve = currentResolve;
  currentResolve = null;
  Manager.Hide();
  if (typeof Resolve === 'function') {
    try {
      Resolve(Outcome);
    } catch (Err) {
      Logger.warn(`Launch countdown resolve handler failed: ${Err.message}`);
    }
  }
}

// Show the countdown for `Seconds` seconds. Resolves 'expired' when the timer
// completes (caller should run the script) or 'cancelled' when the operator
// aborts. The main process owns the authoritative timer; the renderer only
// displays the ticking number.
Manager.Show = ({ ScriptName, Seconds } = {}) => {
  const SafeSeconds = Math.max(1, Math.floor(Number(Seconds) || 0));
  const Name = ScriptName ? String(ScriptName) : 'startup script';

  // Resolve any prior countdown as cancelled before starting a new one.
  if (currentResolve) Settle('cancelled');

  return new Promise((resolve) => {
    currentResolve = resolve;

    let bounds = { x: 0, y: 0, width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
    try {
      const WorkArea = screen.getPrimaryDisplay().workArea;
      bounds = {
        x: Math.round(WorkArea.x + (WorkArea.width - WINDOW_WIDTH) / 2),
        y: Math.round(WorkArea.y + (WorkArea.height - WINDOW_HEIGHT) / 2),
        width: WINDOW_WIDTH,
        height: WINDOW_HEIGHT,
      };
    } catch (Err) {
      Logger.warn(`Failed to center launch countdown overlay: ${Err.message}`);
    }

    try {
      overlayWindow = new BrowserWindow({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
        frame: false,
        transparent: false,
        backgroundColor: '#05070d',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: true,
        show: false,
        alwaysOnTop: true,
        focusable: true,
        webPreferences: {
          ...baseWebPreferences,
          preload: OVERLAY_PRELOAD,
          devTools: false,
        },
      });
    } catch (Err) {
      Logger.error('Failed to create launch countdown window', Err);
      overlayWindow = null;
      // Without a visible abort window we must not silently run a destructive
      // script, so treat inability to show the overlay as a cancellation.
      currentResolve = null;
      return resolve('cancelled');
    }

    try {
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    } catch (Err) {
      Logger.warn(`setAlwaysOnTop failed: ${Err.message}`);
    }
    try {
      overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch (_err) {
      // Ignore platform-specific failures; the overlay still works.
    }

    const search = `?script=${encodeURIComponent(Name)}&seconds=${encodeURIComponent(
      String(SafeSeconds)
    )}`;
    overlayWindow.loadFile(OVERLAY_HTML, { search });

    overlayWindow.once('ready-to-show', () => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      overlayWindow.show();
      try {
        overlayWindow.focus();
      } catch (_err) {
        // Focus is best-effort; keyboard abort still works via the button.
      }
    });

    // Keyboard fallback: Esc or Shift aborts even if the renderer script fails.
    overlayWindow.webContents.on('before-input-event', (_event, input) => {
      if (!input || input.type !== 'keyDown') return;
      if (input.key === 'Escape' || input.key === 'Shift') {
        Manager.HandleUserCancel();
      }
    });

    Logger.log(`Launch countdown shown for "${Name}" (${SafeSeconds}s)`);
    expiryTimer = setTimeout(() => Settle('expired'), SafeSeconds * 1000);
  });
};

// Operator aborted (Cancel button / Esc / Shift / click). Invoked from the
// IPC handler registered in main.js.
Manager.HandleUserCancel = () => {
  if (!currentResolve) return;
  Logger.log('Launch action cancelled by operator');
  Settle('cancelled');
};

Manager.Hide = () => {
  if (overlayWindow) {
    try {
      if (!overlayWindow.isDestroyed()) overlayWindow.destroy();
    } catch (_err) {
      // Best-effort cleanup only.
    }
    overlayWindow = null;
  }
};

module.exports = {
  Manager,
};
