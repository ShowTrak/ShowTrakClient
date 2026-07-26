// Migration of macOS client state from ~/Library/Preferences to Application Support.
//
// This is the highest-risk change in the refactor: Profile.json IS the client's
// identity, and losing it means the machine silently unadopts itself and reappears
// on the server as a new pending client mid-show. So the cases that matter are the
// ones where migration goes WRONG — a half-finished earlier attempt, a destination
// that already has data, a cross-volume home directory, an unreadable folder.
//
// Uses a REAL temporary filesystem rather than a mocked fs: the whole point is
// whether files actually arrive, and a stubbed rename would prove nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { withMocks, loadWithMocks } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'AppData', 'index.js');

const LEGACY = ['Library', 'Preferences', 'ShowTrakClient'];
const CURRENT = ['Library', 'Application Support', 'ShowTrakClient'];

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'appdata-mig-'));
}

function writeFile(root, segments, contents) {
  const target = path.join(root, ...segments);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
  return target;
}

/**
 * Load AppData as if on macOS with `homedir` as the user's home.
 *
 * The migration runs at module scope, so simply loading the module performs it.
 * APPDATA is cleared, because an explicitly set APPDATA means state has been
 * redirected and there is no legacy path to reason about.
 */
function loadOnMac(homedir) {
  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  delete process.env.APPDATA;
  try {
    return withMocks({ os: { ...os, homedir: () => homedir } }, () => {
      const mod = loadWithMocks(MODULE_PATH, { os: { ...os, homedir: () => homedir } });
      // The automatic import-time migration is suppressed under `node --test` so a
      // test can never move the developer's real client state, so drive it here.
      mod._internal.migrateLegacyMacAppData();
      return mod;
    });
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  }
}

test('a legacy install has its profile, scripts and logs moved', () => {
  const home = makeHome();
  writeFile(home, [...LEGACY, 'Profile', 'Profile.json'], '{"UUID":"keep-me"}');
  writeFile(home, [...LEGACY, 'Scripts', 'open-show', 'run.sh'], 'echo hi');
  writeFile(home, [...LEGACY, 'Logs', 'ShowTrakClient-2026-07-01.log'], 'old log');

  loadOnMac(home);

  assert.equal(
    fs.readFileSync(path.join(home, ...CURRENT, 'Profile', 'Profile.json'), 'utf8'),
    '{"UUID":"keep-me"}',
    'the identity must survive the move'
  );
  assert.equal(
    fs.readFileSync(path.join(home, ...CURRENT, 'Scripts', 'open-show', 'run.sh'), 'utf8'),
    'echo hi',
    'nested script files must survive'
  );
  assert.ok(fs.existsSync(path.join(home, ...CURRENT, 'Logs')));
});

test('migration is idempotent — a second load changes nothing', () => {
  const home = makeHome();
  writeFile(home, [...LEGACY, 'Profile', 'Profile.json'], '{"UUID":"stable"}');

  loadOnMac(home);
  loadOnMac(home);
  loadOnMac(home);

  assert.equal(
    fs.readFileSync(path.join(home, ...CURRENT, 'Profile', 'Profile.json'), 'utf8'),
    '{"UUID":"stable"}'
  );
});

test('an existing destination folder is never overwritten', () => {
  // If both locations somehow hold a profile, the NEW one is authoritative —
  // clobbering it would revert the client to a stale identity.
  const home = makeHome();
  writeFile(home, [...LEGACY, 'Profile', 'Profile.json'], '{"UUID":"old"}');
  writeFile(home, [...CURRENT, 'Profile', 'Profile.json'], '{"UUID":"new"}');

  loadOnMac(home);

  assert.equal(
    fs.readFileSync(path.join(home, ...CURRENT, 'Profile', 'Profile.json'), 'utf8'),
    '{"UUID":"new"}',
    'the destination profile must win'
  );
});

test('a half-finished earlier attempt still migrates the remaining folders', () => {
  // The case a whole-root "does the destination exist?" check would get wrong, and
  // the reason migration is per-folder: Logger creates the new Logs directory in its
  // own module body, so on a real boot the destination root ALWAYS exists by the time
  // anything else looks at it.
  const home = makeHome();
  writeFile(home, [...LEGACY, 'Profile', 'Profile.json'], '{"UUID":"still-here"}');
  writeFile(home, [...LEGACY, 'Scripts', 'run.sh'], 'echo hi');
  fs.mkdirSync(path.join(home, ...CURRENT, 'Logs'), { recursive: true });

  loadOnMac(home);

  assert.equal(
    fs.readFileSync(path.join(home, ...CURRENT, 'Profile', 'Profile.json'), 'utf8'),
    '{"UUID":"still-here"}',
    'an already-created Logs directory must not block the Profile from moving'
  );
  assert.ok(fs.existsSync(path.join(home, ...CURRENT, 'Scripts', 'run.sh')));
});

test('a fresh install with no legacy directory is untouched', () => {
  const home = makeHome();
  const { Manager } = loadOnMac(home);
  assert.equal(fs.existsSync(path.join(home, ...LEGACY)), false);
  Manager.Initialize();
  assert.ok(fs.existsSync(path.join(home, ...CURRENT, 'Profile')));
});

test('migration does not run on Linux or Windows', () => {
  for (const platform of ['linux', 'win32']) {
    const home = makeHome();
    writeFile(home, [...LEGACY, 'Profile', 'Profile.json'], '{"UUID":"mac-only"}');

    const originalPlatform = process.platform;
    const originalAppData = process.env.APPDATA;
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    delete process.env.APPDATA;
    try {
      withMocks({ os: { ...os, homedir: () => home } }, () => {
        const mod = loadWithMocks(MODULE_PATH, { os: { ...os, homedir: () => home } });
        mod._internal.migrateLegacyMacAppData();
      });
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      if (originalAppData === undefined) delete process.env.APPDATA;
      else process.env.APPDATA = originalAppData;
    }

    assert.ok(
      fs.existsSync(path.join(home, ...LEGACY, 'Profile', 'Profile.json')),
      `${platform}: the macOS legacy path must be left alone`
    );
  }
});

test('an explicitly redirected APPDATA disables the migration', () => {
  // APPDATA set means an operator (or the test suite) has pointed state elsewhere,
  // so there is no ~/Library/Preferences install to reason about.
  const home = makeHome();
  const redirected = makeHome();
  writeFile(home, [...LEGACY, 'Profile', 'Profile.json'], '{"UUID":"untouched"}');

  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  process.env.APPDATA = redirected;
  try {
    withMocks({ os: { ...os, homedir: () => home } }, () => {
      const mod = loadWithMocks(MODULE_PATH, { os: { ...os, homedir: () => home } });
      mod._internal.migrateLegacyMacAppData();
    });
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  }

  assert.ok(fs.existsSync(path.join(home, ...LEGACY, 'Profile', 'Profile.json')));
});

test('a cross-volume home directory falls back to copy, and only then removes', () => {
  // Simulates EXDEV, which is what a redirected or network home directory produces.
  // The source must not be removed until the copy is verified present.
  const home = makeHome();
  writeFile(home, [...LEGACY, 'Profile', 'Profile.json'], '{"UUID":"cross-volume"}');

  const realFs = require('node:fs');
  let renameAttempts = 0;
  const fsMock = {
    ...realFs,
    renameSync: () => {
      renameAttempts += 1;
      const err = new Error('cross-device link not permitted');
      err.code = 'EXDEV';
      throw err;
    },
  };

  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  delete process.env.APPDATA;
  try {
    const mocks = { os: { ...os, homedir: () => home }, fs: fsMock };
    withMocks(mocks, () => loadWithMocks(MODULE_PATH, mocks)._internal.migrateLegacyMacAppData());
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  }

  assert.ok(renameAttempts > 0, 'rename should be tried first');
  assert.equal(
    fs.readFileSync(path.join(home, ...CURRENT, 'Profile', 'Profile.json'), 'utf8'),
    '{"UUID":"cross-volume"}',
    'the copy fallback must land the file'
  );
  assert.equal(
    fs.existsSync(path.join(home, ...LEGACY, 'Profile')),
    false,
    'the source is removed only after the copy is verified'
  );
});

test('a migration failure never throws out of module load', () => {
  // A client that cannot migrate must still start — throwing here would take down
  // every module that imports Logger, which is all of them.
  const home = makeHome();
  writeFile(home, [...LEGACY, 'Profile', 'Profile.json'], '{"UUID":"x"}');

  const realFs = require('node:fs');
  const fsMock = {
    ...realFs,
    renameSync: () => {
      throw new Error('permission denied');
    },
    cpSync: () => {
      throw new Error('permission denied');
    },
  };

  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  delete process.env.APPDATA;
  try {
    const mocks = { os: { ...os, homedir: () => home }, fs: fsMock };
    assert.doesNotThrow(() =>
      withMocks(mocks, () => loadWithMocks(MODULE_PATH, mocks)._internal.migrateLegacyMacAppData())
    );
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    if (originalAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = originalAppData;
  }

  // And the source is left intact, so the profile is recoverable by hand.
  assert.ok(fs.existsSync(path.join(home, ...LEGACY, 'Profile', 'Profile.json')));
});

test('the legacy directory is left in place after a successful migration', () => {
  // Deliberate: the old tree is a free rollback if the new location turns out to be
  // wrong, and deleting a user's data is not something a migration should do silently.
  const home = makeHome();
  writeFile(home, [...LEGACY, 'Profile', 'Profile.json'], '{"UUID":"rollback"}');

  loadOnMac(home);

  assert.ok(
    fs.existsSync(path.join(home, ...LEGACY)),
    'the legacy root should remain as a rollback path'
  );
});
