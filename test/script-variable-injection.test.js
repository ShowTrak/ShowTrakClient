// Show variables reaching a spawned script.
//
// This is the seam the whole feature rests on: ScriptManager.Execute is the one
// place every execution path converges — server dispatch, the tray menu and the
// run-on-launch action — so whatever this hands to spawn() is what a batch file
// reads as %SHOWTRAK_VAR_…%.
//
// Two properties matter most, and both fail in ways that look like something
// else:
//
//   1. process.env MUST BE SPREAD IN. Passing `env` at all means owning the
//      whole block. A script that silently lost PATH would fail with an error
//      about a missing command, not about variables.
//   2. THE DISPATCH SET WINS OVER THE CACHE. The server resolves variables when
//      a script actually starts, so a script that waited its turn in the queue
//      must not run with the values from when it was queued.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { loadWithMocks, createSilentLogger, withMocks } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'ScriptManager', 'index.js');

const PLATFORM =
  process.platform === 'win32'
    ? { key: 'Windows', fileName: 'run.bat', contents: '@echo off\r\n' }
    : process.platform === 'darwin'
      ? { key: 'macOS', fileName: 'run.sh', contents: '#!/bin/sh\nexit 0\n' }
      : { key: 'Linux', fileName: 'run.sh', contents: '#!/bin/sh\nexit 0\n' };

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** ScriptManager with one runnable script and a stubbed variable cache. */
async function setup(cachedEnvironment) {
  const scriptsDir = tempDir('showtrak-scripts-');
  const profileDir = tempDir('showtrak-profile-');
  const scriptFolder = path.join(scriptsDir, 'script-1');
  fs.mkdirSync(scriptFolder, { recursive: true });
  fs.writeFileSync(path.join(scriptFolder, PLATFORM.fileName), PLATFORM.contents, 'utf8');

  const { Manager } = loadWithMocks(MODULE_PATH, {
    '../Logger': { CreateLogger: () => createSilentLogger() },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../AppData': {
      Manager: {
        GetScriptsDirectory: () => scriptsDir,
        GetProfileDirectory: () => profileDir,
      },
    },
    '../Variables': {
      Manager: { GetEnvironment: () => ({ ...cachedEnvironment }) },
    },
    '@showtrak/protocol/runtime': { ChecksumFile: async () => 'sum', ChecksumBuffer: () => 'sum' },
  });

  await Manager.SetScripts([
    {
      ID: 'script-1',
      Name: 'Demo',
      Enabled: true,
      Platforms: { [PLATFORM.key]: PLATFORM.fileName },
      Files: [{ Path: PLATFORM.fileName, Type: 'file', Checksum: 'sum' }],
    },
  ]);

  return Manager;
}

/** Run a script and return the options object spawn() was given. */
async function spawnOptionsFor(Manager, dispatchVariables) {
  let options = null;
  const childProcessMock = {
    spawn: (_command, _args, opts) => {
      options = opts;
      return {
        stdout: { on: (event, cb) => event === 'data' && cb(Buffer.from('ok')) },
        stderr: { on: () => {} },
        on: (event, cb) => {
          if (event === 'close') cb(0);
        },
      };
    },
  };
  const [err, ok] = await withMocks({ child_process: childProcessMock }, () =>
    Manager.Execute('req-1', 'script-1', undefined, dispatchVariables)
  );
  assert.equal(err, null);
  assert.equal(ok, true);
  assert.ok(options, 'spawn was never called');
  return options;
}

test('the cached environment is injected when no dispatch set is supplied', async () => {
  const Manager = await setup({ SHOWTRAK_VAR_GAME_VERSION: 'TEST_GAME' });
  // No fourth argument: this is the tray and run-on-launch path.
  const options = await spawnOptionsFor(Manager, null);
  assert.equal(options.env.SHOWTRAK_VAR_GAME_VERSION, 'TEST_GAME');
});

test('the dispatch set wins over the cache', async () => {
  const Manager = await setup({ SHOWTRAK_VAR_GAME_VERSION: 'STALE' });
  // The server resolves at dispatch, so a queued script picks up the value
  // current when it started rather than when it was queued.
  const options = await spawnOptionsFor(Manager, { SHOWTRAK_VAR_GAME_VERSION: 'FRESH' });
  assert.equal(options.env.SHOWTRAK_VAR_GAME_VERSION, 'FRESH');
});

test('the inherited environment survives injection', async () => {
  const Manager = await setup({ SHOWTRAK_VAR_A: '1' });
  const options = await spawnOptionsFor(Manager, null);

  // Passing `env` means owning the whole block; dropping process.env would
  // strip PATH and every script would fail for reasons that look unrelated.
  assert.equal(options.env.PATH, process.env.PATH);
  assert.equal(options.env.SHOWTRAK_VAR_A, '1');
});

test('an empty value is still present in the spawned environment', async () => {
  const Manager = await setup({ SHOWTRAK_VAR_EMPTY: '' });
  const options = await spawnOptionsFor(Manager, null);

  // On POSIX this is what makes `if [ -z "$SHOWTRAK_VAR_EMPTY" ]` work rather
  // than the name expanding to nothing at all. (Windows may still drop a
  // defined-but-empty variable at CreateProcess — which is exactly why the
  // Variable Manager recommends setting a default.)
  assert.equal(Object.hasOwn(options.env, 'SHOWTRAK_VAR_EMPTY'), true);
  assert.equal(options.env.SHOWTRAK_VAR_EMPTY, '');
});

test('a script runs normally when no variables are defined at all', async () => {
  const Manager = await setup({});
  const options = await spawnOptionsFor(Manager, null);
  // A show with no variables must behave exactly as it did before the feature.
  assert.equal(options.env.PATH, process.env.PATH);
});
