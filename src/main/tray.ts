// System tray / menu-bar item.
//
// Owns the Tray instance and its context menu. The tray is the client's ONLY
// affordance on a normal install — the app runs as a background agent with no
// Dock icon and no visible window — so tray creation failing has to degrade to
// something reachable rather than leaving the app running invisibly. main.ts
// still owns that fallback decision (it needs to create a window); this module
// reports whether the tray exists.
//
// `performUpdateCheck` is injected via Configure rather than imported, because
// app-updater.ts also needs the tray (it destroys it before quitAndInstall) and
// importing both ways would be a cycle.

import { Menu, Tray, nativeImage, app, type MenuItemConstructorOptions } from 'electron';
import fs from 'fs';
import path from 'path';

import { CreateLogger } from '../Modules/Logger';
import { Manager as AppDataManager } from '../Modules/AppData';
import { Manager as ScriptManager } from '../Modules/ScriptManager';
import { openConfigureWindow } from './app-window';

const Logger = CreateLogger('Tray');

let tray: Tray | null = null;
let onCheckForUpdates: (() => Promise<void> | void) | null = null;

interface TrayOptions {
  // Invoked by the "Check For Updates" item. Injected to avoid a tray <-> updater
  // import cycle.
  onCheckForUpdates: () => Promise<void> | void;
}

function Configure(options: TrayOptions): void {
  onCheckForUpdates = options.onCheckForUpdates;
}

// Resolve the tray image. Validate candidates and return the first usable one
// so we never create an invisible tray item on macOS.
function getTrayImage() {
  const candidates =
    process.platform === 'win32'
      ? [path.join(__dirname, '..', 'images', 'icon.ico')]
      : [
          path.join(__dirname, '..', 'images', 'trayTemplate.png'),
          path.join(__dirname, '..', 'images', 'icon.png'),
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
    } catch (Err) {
      Logger.debug(`Tray image candidate ${iconPath} failed to load`, String(Err));
    }
  }

  Logger.warn('No valid tray image candidates found', candidates.join(', '));
  return nativeImage.createEmpty();
}

function buildTrayScriptMenuItems(): MenuItemConstructorOptions[] {
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
        if (onCheckForUpdates) await onCheckForUpdates();
      },
    },
  ];
}

// Rebuild the context menu. Called on creation and whenever the script catalog
// changes, so the "Run Script" submenu reflects what is actually deployed.
function refreshTrayContextMenu(): void {
  if (!tray) return;
  try {
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayContextMenuTemplate()));
  } catch (Err) {
    Logger.warn('Failed to refresh tray context menu', String(Err));
  }
}

// Create the tray icon and its menu.
//
// Returns false when no tray could be created — reliable on Windows and macOS,
// but varies across Linux desktops. main.ts uses that to fall back to a
// minimized window so the app stays reachable.
function createTray(): boolean {
  try {
    const trayImage = getTrayImage();
    if (!trayImage || trayImage.isEmpty()) {
      throw new Error('No valid tray image found');
    }
    tray = new Tray(trayImage);
    Logger.log('Tray created successfully');
  } catch (Err) {
    tray = null;
    Logger.warn('System tray unavailable, falling back to minimized window', String(Err));
    return false;
  }

  tray.setToolTip('ShowTrak Client Service');
  if (process.platform === 'darwin') {
    // Keep a visible fallback label in the menu bar in case the icon remains
    // hidden by OS rendering rules.
    tray.setTitle('ShowTrak Client');
  }
  refreshTrayContextMenu();
  tray.setIgnoreDoubleClickEvents(true);
  return true;
}

function hasTray(): boolean {
  return !!tray;
}

// Tear the tray down. Called before quitAndInstall so the installer is not
// racing a live menu-bar item.
function destroyTray(): void {
  if (!tray) return;
  tray.destroy();
  tray = null;
}

export {
  Configure,
  buildTrayContextMenuTemplate,
  buildTrayScriptMenuItems,
  createTray,
  destroyTray,
  getTrayImage,
  hasTray,
  refreshTrayContextMenu,
};
