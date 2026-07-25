import path from 'path';
import fs from 'fs';

const BasePath =
  process.env.APPDATA ||
  (process.platform == 'darwin'
    ? process.env.HOME + '/Library/Preferences'
    : process.env.HOME + '/.local/share');
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
