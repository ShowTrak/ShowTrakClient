// Containment of server-supplied script paths.
//
// `Script.ID` and `ScriptFile.Path` both arrive from the server over the wire and
// are joined onto the scripts directory. A segment containing `..` — or an
// absolute path, which path.resolve lets win outright — would escape the
// sandbox, and DownloadScripts writes, chmod 0755s and ultimately executes
// whatever lands there.
//
// Every case below is spelled so it holds on all three platforms: `..` and
// backslash traversal are rejected textually rather than by asking the local
// path module where they resolve to, so the suite does not pass on POSIX for the
// wrong reason (a POSIX path.resolve treats `..\x` as an ordinary filename).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'ScriptManager', 'index.js');

function loadScriptManager({ scriptsDir, profileDir, checksum = 'different-sum' }) {
  return loadWithMocks(MODULE_PATH, {
    '../Logger': {
      CreateLogger: () => createSilentLogger(),
    },
    '../AppData': {
      Manager: {
        GetScriptsDirectory: () => scriptsDir,
        GetProfileDirectory: () => profileDir,
      },
    },
    '../ChecksumManager': { Manager: { Checksum: async () => checksum } },
    '../Broadcast': { Manager: { emit: () => {}, on: () => {} } },
  });
}

// Spellings that must never be accepted as a relative segment.
const UNSAFE_SEGMENTS = [
  ['parent traversal', '../evil'],
  ['nested traversal', 'bin/../../evil'],
  ['deep traversal', '../../../../tmp/evil.sh'],
  ['bare parent', '..'],
  ['posix absolute', '/tmp/evil.sh'],
  ['unc path', '\\\\attacker\\share\\evil.sh'],
  ['windows drive', 'C:\\Windows\\System32\\evil.exe'],
  ['windows drive lowercase', 'c:/windows/evil.exe'],
  ['backslash traversal', '..\\..\\evil.sh'],
  ['mixed separator traversal', 'bin\\..\\..\\evil.sh'],
  ['nul byte', 'evil\0.sh'],
  ['empty', ''],
  ['whitespace only', '   '],
];

const SAFE_SEGMENTS = [
  ['plain file', 'macos.sh'],
  ['nested file', 'bin/macos.sh'],
  ['deep nested file', 'a/b/c/run.sh'],
  ['dot prefix retained elsewhere', 'bin/.keep'],
  ['name containing dots', 'release..candidate.sh'],
  ['double-dot substring', '..hidden.sh'],
];

test('IsSafeRelativeSegment rejects every traversal spelling', () => {
  const { _internal } = loadScriptManager({
    scriptsDir: tempDir('stc-seg-s-'),
    profileDir: tempDir('stc-seg-p-'),
  });

  for (const [label, segment] of UNSAFE_SEGMENTS) {
    assert.equal(
      _internal.IsSafeRelativeSegment(segment),
      false,
      `expected ${label} (${JSON.stringify(segment)}) to be rejected`
    );
  }

  for (const nonString of [null, undefined, 42, {}, [], true]) {
    assert.equal(_internal.IsSafeRelativeSegment(nonString), false);
  }
});

test('IsSafeRelativeSegment accepts ordinary relative paths', () => {
  const { _internal } = loadScriptManager({
    scriptsDir: tempDir('stc-seg2-s-'),
    profileDir: tempDir('stc-seg2-p-'),
  });

  for (const [label, segment] of SAFE_SEGMENTS) {
    assert.equal(
      _internal.IsSafeRelativeSegment(segment),
      true,
      `expected ${label} (${JSON.stringify(segment)}) to be accepted`
    );
  }
});

test('ResolveContained returns null for anything escaping the base', () => {
  const base = tempDir('stc-res-');
  const { _internal } = loadScriptManager({
    scriptsDir: base,
    profileDir: tempDir('stc-res-p-'),
  });

  for (const [label, segment] of UNSAFE_SEGMENTS) {
    assert.equal(
      _internal.ResolveContained(base, segment),
      null,
      `expected ${label} (${JSON.stringify(segment)}) to resolve to null`
    );
  }

  // A missing or empty base is not a usable sandbox root.
  assert.equal(_internal.ResolveContained('', 'macos.sh'), null);
  assert.equal(_internal.ResolveContained(null, 'macos.sh'), null);

  // The base itself is a rejection: a target must be strictly inside it.
  assert.equal(_internal.ResolveContained(base, '.'), null);
});

test('ResolveContained resolves safe segments to an absolute path inside the base', () => {
  const base = tempDir('stc-ok-');
  const { _internal } = loadScriptManager({
    scriptsDir: base,
    profileDir: tempDir('stc-ok-p-'),
  });

  const resolved = _internal.ResolveContained(base, 'bin/macos.sh');
  assert.equal(resolved, path.join(base, 'bin', 'macos.sh'));
  assert.equal(path.isAbsolute(resolved), true);

  // Multi-segment form, as used for scriptsDir -> ID -> relative file.
  const twoStep = _internal.ResolveContained(base, 'script-1', 'run.sh');
  assert.equal(twoStep, path.join(base, 'script-1', 'run.sh'));
});

test('DownloadScripts refuses a traversing file path and writes nothing outside', async () => {
  const sandbox = tempDir('stc-e2e-');
  const scriptsDir = path.join(sandbox, 'Scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const outsideMarker = path.join(sandbox, 'pwned.sh');
  // NOTE the depth: the file path is joined onto <scriptsDir>/<ID>/, so a single
  // `../` only reaches <scriptsDir> and would still be "inside". Two levels are
  // required for this assertion to actually witness an escape — verified against
  // the pre-fix code, which wrote an executable payload to exactly this path.

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => Buffer.from('#!/bin/sh\necho pwned').buffer,
  });

  try {
    const { Manager } = loadScriptManager({
      scriptsDir,
      profileDir: tempDir('stc-e2e-p-'),
    });

    await assert.rejects(
      () =>
        Manager.DownloadScripts('127.0.0.1', 8080, [
          {
            ID: 'evil-script',
            Name: 'Evil',
            Files: [{ Path: '../../pwned.sh', Type: 'file', Checksum: 'x' }],
          },
        ]),
      /escapes the script directory/
    );

    assert.equal(
      fs.existsSync(outsideMarker),
      false,
      'a traversing Path must not be written outside the scripts directory'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('DownloadScripts refuses a traversing script ID and writes nothing outside', async () => {
  const sandbox = tempDir('stc-e2e-id-');
  const scriptsDir = path.join(sandbox, 'Scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  const outsideDir = path.join(sandbox, 'escaped');

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => Buffer.from('echo pwned').buffer,
  });

  try {
    const { Manager } = loadScriptManager({
      scriptsDir,
      profileDir: tempDir('stc-e2e-id-p-'),
    });

    await assert.rejects(
      () =>
        Manager.DownloadScripts('127.0.0.1', 8080, [
          {
            ID: '../escaped',
            Name: 'Evil ID',
            Files: [{ Path: 'run.sh', Type: 'file', Checksum: 'x' }],
          },
        ]),
      /script ID escapes the scripts directory/
    );

    assert.equal(
      fs.existsSync(outsideDir),
      false,
      'a traversing Script.ID must not create a directory outside the scripts directory'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('DownloadScripts still deploys a well-formed script alongside a rejected one', async () => {
  const scriptsDir = tempDir('stc-mixed-s-');
  const profileDir = tempDir('stc-mixed-p-');

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => Buffer.from('echo ok').buffer,
  });

  try {
    const { Manager } = loadScriptManager({ scriptsDir, profileDir });

    // The good script is listed second so this also proves the rejection uses
    // `continue` rather than aborting the whole deployment.
    await assert.rejects(
      () =>
        Manager.DownloadScripts('127.0.0.1', 8080, [
          { ID: 'evil', Files: [{ Path: '../../pwned.sh', Type: 'file', Checksum: 'x' }] },
          { ID: 'good', Files: [{ Path: 'run.sh', Type: 'file', Checksum: 'x' }] },
        ]),
      /escapes the script directory/
    );

    assert.equal(fs.existsSync(path.join(scriptsDir, 'good', 'run.sh')), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('GetLaunchState reports a traversing platform path as not runnable', async () => {
  const scriptsDir = tempDir('stc-launch-s-');
  const profileDir = tempDir('stc-launch-p-');
  const { Manager } = loadScriptManager({ scriptsDir, profileDir });

  const platformKey =
    process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';

  // The script directory must exist so the failure is attributable to the
  // relative path rather than to a missing script directory.
  fs.mkdirSync(path.join(scriptsDir, 'traverser'), { recursive: true });

  await Manager.SetScripts([
    {
      ID: 'traverser',
      Name: 'Traverser',
      Enabled: true,
      Platforms: { [platformKey]: '../../../../tmp/evil.sh' },
    },
  ]);

  const state = Manager.GetLaunchState('traverser');
  assert.equal(state.Found, true);
  assert.equal(state.Enabled, false);
  assert.match(state.DisabledReason, /escapes the scripts directory/);

  const [err, ok] = await Manager.Execute('req-traverse', 'traverser');
  assert.match(String(err), /escapes the scripts directory/);
  assert.equal(ok, false);
});

test('GetLaunchState reports a traversing script ID as not runnable', async () => {
  const scriptsDir = tempDir('stc-launch-id-s-');
  const profileDir = tempDir('stc-launch-id-p-');
  const { Manager } = loadScriptManager({ scriptsDir, profileDir });

  const platformKey =
    process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';

  await Manager.SetScripts([
    { ID: '../escaped', Name: 'Evil ID', Enabled: true, Platforms: { [platformKey]: 'run.sh' } },
  ]);

  const state = Manager.GetLaunchState('../escaped');
  assert.equal(state.Found, true);
  assert.equal(state.Enabled, false);
  assert.match(state.DisabledReason, /Script ID is not a valid directory name/);
});
