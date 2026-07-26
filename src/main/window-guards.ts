// Per-window security guards. Extracted verbatim from main.ts.
//
// Applied to every BrowserWindow the client creates: external http(s) links open
// in the OS browser (never in-app), and in-app navigation away from the loaded
// UI is blocked. Both guards fail closed (deny) on error.
//
// Mirrors ShowTrakServer's src/main/window-guards.ts so the two apps enforce the
// same policy; keep them in step.
import { shell, type BrowserWindow } from 'electron';

function applyWindowSecurityGuards(windowInstance: BrowserWindow | null): void {
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

export { applyWindowSecurityGuards };
