// src/Modules/AppData — where client state lives.
//
// This resolves the root for Profile.json, the log files and deployed scripts. If
// it resolves somewhere unexpected the client silently forgets its identity and
// re-adopts, so the path is worth pinning per platform.
//
// The bug that motivated these: the base path was built by string-concatenating
// `process.env.HOME`, which is unset under some service accounts and bare systemd
// units — producing the literal directory "undefined/.local/share".

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const { withMocks, loadWithMocks } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'AppData', 'index.js');

/**
 * Load AppData with a synthesised platform and environment.
 *
 * `process.platform` is read at module scope, so it is redefined for the duration
 * of the load and restored afterwards.
 */
function loadAppData({ platform, appData, homedir = '/home/tester', unsetHome = false }) {
  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;
  const originalHome = process.env.HOME;

  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  if (appData === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = appData;
  // Unsetting HOME is what makes the regression test load-bearing: the old
  // implementation concatenated process.env.HOME directly, so with HOME present it
  // produced a perfectly normal path and the assertion proved nothing.
  if (unsetHome) delete process.env.HOME;

  try {
    // fs is stubbed so loading never touches the real filesystem; os is stubbed so
    // homedir() is deterministic.
    return withMocks(
      {
        os: { ...os, homedir: () => homedir },
        fs: { existsSync: () => true, mkdirSync: () => {} },
      },
      () =>
        loadWithMocks(MODULE_PATH, {
          os: { ...os, homedir: () => homedir },
          fs: { existsSync: () => true, mkdirSync: () => {} },
        })
    );
  } finally {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      configurable: true,
    });
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
}

test('macOS resolves under the home directory, not a concatenated env var', () => {
  const { Manager } = loadAppData({
    platform: 'darwin',
    appData: undefined,
    homedir: '/Users/tester',
  });
  assert.equal(
    Manager.GetProfileDirectory(),
    path.join('/Users/tester', 'Library', 'Preferences', 'ShowTrakClient', 'Profile')
  );
});

test('Linux resolves under the home directory', () => {
  const { Manager } = loadAppData({
    platform: 'linux',
    appData: undefined,
    homedir: '/home/tester',
  });
  assert.equal(
    Manager.GetLogsDirectory(),
    path.join('/home/tester', '.local', 'share', 'ShowTrakClient', 'Logs')
  );
});

test('a missing HOME does not produce an "undefined" path segment', () => {
  // The regression: `process.env.HOME + '/.local/share'` yielded the literal
  // string "undefined/.local/share" whenever HOME was unset. os.homedir() falls
  // back to the OS user database instead.
  for (const platform of ['darwin', 'linux']) {
    const { Manager } = loadAppData({
      platform,
      appData: undefined,
      homedir: '/var/lib/showtrak',
      unsetHome: true,
    });
    for (const dir of [
      Manager.GetProfileDirectory(),
      Manager.GetLogsDirectory(),
      Manager.GetScriptsDirectory(),
    ]) {
      assert.equal(dir.includes('undefined'), false, `${platform}: ${dir}`);
      assert.equal(path.isAbsolute(dir), true, `${platform}: ${dir} must be absolute`);
    }
  }
});

test('Windows uses APPDATA when it is set', () => {
  const { Manager } = loadAppData({
    platform: 'win32',
    appData: 'C:\\Users\\tester\\AppData\\Roaming',
  });
  assert.equal(
    Manager.GetScriptsDirectory(),
    path.join('C:\\Users\\tester\\AppData\\Roaming', 'ShowTrakClient', 'Scripts')
  );
});

test('Windows falls back to a conventional AppData path when APPDATA is unset', () => {
  // Some Windows service contexts do not set APPDATA. Concatenating undefined
  // there would have put client state in a directory literally named "undefined".
  const { Manager } = loadAppData({
    platform: 'win32',
    appData: undefined,
    homedir: 'C:\\Users\\tester',
    unsetHome: true,
  });
  const dir = Manager.GetProfileDirectory();
  assert.equal(dir.includes('undefined'), false);
  assert.equal(
    dir,
    path.join('C:\\Users\\tester', 'AppData', 'Roaming', 'ShowTrakClient', 'Profile')
  );
});

test('an explicitly set APPDATA is honoured on every platform', () => {
  // Operators redirect client state to another volume this way, and the test
  // suite relies on it too.
  for (const platform of ['darwin', 'linux', 'win32']) {
    const { Manager } = loadAppData({ platform, appData: '/mnt/state' });
    assert.equal(
      Manager.GetProfileDirectory(),
      path.join('/mnt/state', 'ShowTrakClient', 'Profile'),
      platform
    );
  }
});

test('the three directories are siblings under one root', () => {
  const { Manager } = loadAppData({ platform: 'linux', appData: '/mnt/state' });
  const root = path.join('/mnt/state', 'ShowTrakClient');
  assert.equal(path.dirname(Manager.GetProfileDirectory()), root);
  assert.equal(path.dirname(Manager.GetLogsDirectory()), root);
  assert.equal(path.dirname(Manager.GetScriptsDirectory()), root);
});

test('AppData loads without electron, so Logger stays usable outside Electron', () => {
  // Logger imports AppData and everything imports Logger. If AppData ever
  // acquires a top-level `electron` dependency, Logger can no longer be loaded in
  // a plain Node process — which would break this entire test suite. Asserting it
  // here makes that a caught regression rather than a cascade of confusing
  // failures.
  let requestedElectron = false;
  withMocks(
    {
      electron: new Proxy(
        {},
        {
          get() {
            requestedElectron = true;
            return undefined;
          },
        }
      ),
    },
    () => loadWithMocks(MODULE_PATH, {})
  );
  assert.equal(requestedElectron, false, 'AppData must not touch electron at import time');
});
