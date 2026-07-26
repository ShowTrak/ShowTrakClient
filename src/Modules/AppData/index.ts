import path from 'path';
import fs from 'fs';
import os from 'os';

// Where the client keeps its profile, logs and deployed scripts.
//
// Resolved WITHOUT importing electron, deliberately. Logger imports this module,
// and everything imports Logger — giving this an `electron` dependency would mean
// Logger could no longer be loaded outside an Electron main process, which is the
// same constraint documented in Modules/Logger. That also rules out
// `app.getPath('userData')`, which additionally resolves to `.../Electron` in an
// unpackaged run and so would put dev and shipped builds in different places.
//
// The macOS location is `~/Library/Preferences`, which is not where Apple would
// put this (Application Support is the conventional home for app data; the Server
// uses it). Moving it is a deliberate NON-goal here: every macOS client already in
// the field has its Profile.json there, and relocating without a migration makes
// the client forget its identity and re-adopt. That is a release-level decision,
// not a cleanup — see REFACTOR_PLAN.md.
//
// `os.homedir()` rather than `process.env.HOME`: the env var is unset under some
// service accounts and bare systemd units, and string-concatenating it produced
// the literal path "undefined/.local/share". os.homedir() falls back to the OS
// user database.
function resolveBasePath(): string {
  if (process.platform === 'win32') {
    // APPDATA is the correct root on Windows; fall back to its conventional
    // location when the variable is missing (some service contexts).
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  }
  // Honour APPDATA if something has explicitly set it (used by tests and by
  // operators redirecting client state to another volume).
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Preferences');
  }
  return path.join(os.homedir(), '.local', 'share');
}

const BasePath = resolveBasePath();
const appDataPath = path.join(BasePath, 'ShowTrakClient');

export const Manager = {
  Initialized: false,

  Initialize(): void {
    if (Manager.Initialized) return;
    if (!fs.existsSync(appDataPath)) {
      fs.mkdirSync(appDataPath, { recursive: true });
    }

    const AppDataFolders = ['Logs', 'Scripts', 'Profile'];
    AppDataFolders.forEach((folder) => {
      const folderPath = path.join(appDataPath, folder);
      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }
    });
    Manager.Initialized = true;
  },

  GetProfileDirectory(): string {
    return path.join(appDataPath, 'Profile');
  },

  GetLogsDirectory(): string {
    return path.join(appDataPath, 'Logs');
  },

  GetScriptsDirectory(): string {
    return path.join(appDataPath, 'Scripts');
  },

  OpenFolder(FolderPath: string): boolean {
    if (fs.existsSync(FolderPath)) {
      const { shell } = require('electron') as typeof import('electron');
      shell.openPath(FolderPath);
      return true;
    } else {
      return false;
    }
  },
};
