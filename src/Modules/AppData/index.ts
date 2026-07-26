import path from 'path';
import fs from 'fs';
import os from 'os';

// Where the client keeps its profile, logs and deployed scripts.
//
// Resolved WITHOUT importing electron, deliberately. Logger imports this module,
// and everything imports Logger — giving this an `electron` dependency would mean
// Logger could no longer be loaded outside an Electron main process, which is the
// constraint documented in Modules/Logger and which the whole test suite relies on.
//
// That also means NOT using `app.getPath('userData')`, even though it would give
// the right macOS directory. Two reasons beyond the import constraint: it resolves
// to `.../Electron` in an unpackaged run, so dev and shipped builds would disagree,
// and it derives the folder name from the app name, so renaming the product would
// silently strand every client's profile. Computing the platform path here keeps the
// folder name pinned to `ShowTrakClient` on every platform and in every build mode.
//
// `os.homedir()` rather than `process.env.HOME`: the env var is unset under some
// service accounts and bare systemd units, and string-concatenating it produced the
// literal path "undefined/.local/share". os.homedir() falls back to the OS user
// database.
const APP_FOLDER_NAME = 'ShowTrakClient';
const APP_DATA_SUBFOLDERS = ['Logs', 'Scripts', 'Profile'] as const;

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
    return path.join(os.homedir(), 'Library', 'Application Support');
  }
  return path.join(os.homedir(), '.local', 'share');
}

/**
 * The pre-3.15 macOS location, or null on any other platform.
 *
 * `~/Library/Preferences` is reserved by Apple for `defaults`/plist storage; app
 * data belongs in Application Support, which is where the Server has always put
 * its own. Existing macOS clients have their Profile.json — and therefore their
 * identity — under the old path, so it has to be moved rather than abandoned.
 */
function resolveLegacyMacBasePath(): string | null {
  if (process.platform !== 'darwin') return null;
  // An explicitly set APPDATA means the caller has redirected state somewhere of
  // its own choosing; there is no legacy path to reason about.
  if (process.env.APPDATA) return null;
  return path.join(os.homedir(), 'Library', 'Preferences');
}

const BasePath = resolveBasePath();
const appDataPath = path.join(BasePath, APP_FOLDER_NAME);

/**
 * Move macOS client state from ~/Library/Preferences to Application Support.
 *
 * Runs at MODULE SCOPE, not from Initialize(), and that ordering is load-bearing:
 * Logger reads GetLogsDirectory() and creates it in its own module body, and
 * Logger imports this module. Deferring the migration to Initialize() would let
 * Logger create an empty Logs directory at the new path first, which — under a
 * whole-root "does the destination exist" check — would look like an already
 * migrated install and strand the profile at the old location forever.
 *
 * Migrated per subfolder rather than as one root move, so a half-finished earlier
 * attempt (or a new-install Logs directory) cannot block the Profile from moving.
 * Each folder moves only when the destination does not exist, which makes the whole
 * thing idempotent.
 *
 * Never throws. A client that cannot migrate must still start: it will come up with
 * a fresh profile and re-adopt, which is recoverable, whereas throwing here would
 * take down every module that imports Logger.
 */
function migrateLegacyMacAppData(): void {
  const legacyBase = resolveLegacyMacBasePath();
  if (!legacyBase) return;
  const legacyRoot = path.join(legacyBase, APP_FOLDER_NAME);
  if (legacyRoot === appDataPath) return;

  try {
    if (!fs.existsSync(legacyRoot)) return;

    let moved = 0;
    for (const folder of APP_DATA_SUBFOLDERS) {
      const from = path.join(legacyRoot, folder);
      const to = path.join(appDataPath, folder);
      try {
        if (!fs.existsSync(from) || fs.existsSync(to)) continue;
        fs.mkdirSync(appDataPath, { recursive: true });
        try {
          fs.renameSync(from, to);
        } catch (renameError) {
          // EXDEV: the two paths are on different volumes (a redirected or
          // network home directory), where rename cannot work. Copy, verify, then
          // remove the source — never remove first.
          if ((renameError as NodeJS.ErrnoException)?.code !== 'EXDEV') throw renameError;
          fs.cpSync(from, to, { recursive: true });
          if (!fs.existsSync(to)) throw renameError;
          fs.rmSync(from, { recursive: true, force: true });
        }
        moved += 1;
      } catch (folderError) {
        // Leave this folder where it is and keep going: moving two of three is
        // strictly better than moving none, and the profile is the one that matters.
        console.warn(
          `[AppData] Could not migrate ${folder} from ${legacyRoot}: ${String(folderError)}`
        );
      }
    }

    if (moved > 0) {
      console.log(
        `[AppData] Migrated ${moved} folder(s) from ${legacyRoot} to ${appDataPath}. ` +
          'The old directory is left in place; it can be deleted once the client is confirmed healthy.'
      );
    }
  } catch (Err) {
    // Logging is not available here — Logger imports this module — so this is one
    // of the few places a bare console call is correct.
    console.warn(`[AppData] Legacy macOS migration skipped: ${String(Err)}`);
  }
}

// Never migrate automatically under `node --test`.
//
// The call above runs at IMPORT, and this module is pulled in by Logger, which every
// module imports — so any test touching almost anything would move the developer's
// own live client state out from under them. That is not hypothetical: it happened
// once during this refactor, via a Logger test that set no APPDATA override.
//
// Node sets NODE_TEST_CONTEXT in `node --test` child processes, so the guard needs no
// wiring in the test suite and cannot be forgotten by a future test author. Tests that
// need to exercise the migration call `_internal.migrateLegacyMacAppData()` directly.
if (!process.env.NODE_TEST_CONTEXT) {
  migrateLegacyMacAppData();
}

export const Manager = {
  Initialized: false,

  Initialize(): void {
    if (Manager.Initialized) return;
    if (!fs.existsSync(appDataPath)) {
      fs.mkdirSync(appDataPath, { recursive: true });
    }

    APP_DATA_SUBFOLDERS.forEach((folder) => {
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

// Exposed so the migration can be exercised under `node --test`, where the automatic
// call above is deliberately suppressed.
export const _internal = { migrateLegacyMacAppData, resolveBasePath, resolveLegacyMacBasePath };
