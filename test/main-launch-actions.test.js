// src/main/launch-actions.ts
//
// Run-on-launch fires a script automatically on an unattended machine, so every
// gate that can STOP it matters more than the happy path: the safe-mode escape
// hatch, the operator's abort window, and refusing to run a script that is
// missing or not runnable on this OS. A regression here means a venue PC runs
// something nobody asked it to, on boot, with no one watching.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { loadWithMocks } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'main', 'launch-actions.js');
const REAL_LAUNCH_CONFIG = path.join(
  __dirname,
  '..',
  'dist',
  'Modules',
  'LaunchConfig',
  'index.js'
);

const silentLogger = {
  log: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  success: () => {},
  silent: () => {},
};

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Load launch-actions with a controllable environment.
 *
 * The REAL LaunchConfig module is used rather than a stub: its Normalize() is
 * what clamps the delay to the 10s minimum, and stubbing it would let a test
 * pass while the abort window silently collapsed to zero.
 */
function loadLaunchActions({
  profileDir,
  launchState,
  showOutcome = 'elapsed',
  executed = [],
  shown = [],
  waits = [],
} = {}) {
  return loadWithMocks(MODULE_PATH, {
    '../Modules/Logger': { CreateLogger: () => silentLogger },
    '../Modules/AppData': { Manager: { GetProfileDirectory: () => profileDir } },
    '../Modules/LaunchConfig': require(REAL_LAUNCH_CONFIG),
    '../Modules/LaunchCountdownOverlay': {
      Manager: {
        Show: async (opts) => {
          shown.push(opts);
          return showOutcome;
        },
      },
    },
    '../Modules/ScriptManager': {
      Manager: {
        GetLaunchState: () => launchState,
        Execute: async (source, scriptId) => {
          executed.push([source, scriptId]);
          return [null, true];
        },
      },
    },
    '../Modules/Utils': {
      Wait: async (ms) => {
        waits.push(ms);
      },
    },
  });
}

const RUNNABLE = { Found: true, Enabled: true, DisabledReason: '', Name: 'Open Show' };

test('IsSafeModeEnabled tracks the PRESENCE of the sentinel file', () => {
  const profileDir = tempDir('la-safe-');
  const { IsSafeModeEnabled } = loadLaunchActions({ profileDir, launchState: RUNNABLE });

  assert.equal(IsSafeModeEnabled(), false, 'no sentinel -> safe mode off');

  fs.writeFileSync(path.join(profileDir, 'SafeMode'), '');
  assert.equal(IsSafeModeEnabled(), true, 'sentinel present -> safe mode on');

  fs.rmSync(path.join(profileDir, 'SafeMode'));
  assert.equal(IsSafeModeEnabled(), false);
});

test('IsSafeModeEnabled returns false rather than throwing on an unreadable profile dir', () => {
  const { IsSafeModeEnabled } = loadLaunchActions({
    profileDir: null, // makes path.join throw inside the guard
    launchState: RUNNABLE,
  });
  assert.equal(IsSafeModeEnabled(), false);
});

test('safe mode blocks the launch script entirely', async () => {
  const profileDir = tempDir('la-blocked-');
  fs.writeFileSync(path.join(profileDir, 'SafeMode'), '');
  const executed = [];
  const shown = [];
  const { RunLaunchActions } = loadLaunchActions({
    profileDir,
    launchState: RUNNABLE,
    executed,
    shown,
  });

  await RunLaunchActions({ ScriptID: 'open-show', DelaySeconds: 10, ShowCountdown: true });

  assert.deepEqual(executed, [], 'safe mode must not execute anything');
  assert.deepEqual(shown, [], 'and must not even show the countdown');
});

test('no configured script is a no-op', async () => {
  const profileDir = tempDir('la-noscript-');
  const executed = [];
  const { RunLaunchActions } = loadLaunchActions({ profileDir, launchState: RUNNABLE, executed });

  await RunLaunchActions({ ScriptID: null, DelaySeconds: null, ShowCountdown: true });
  assert.deepEqual(executed, []);
});

test('a script missing from the catalog is skipped, not guessed at', async () => {
  const profileDir = tempDir('la-missing-');
  const executed = [];
  const { RunLaunchActions } = loadLaunchActions({
    profileDir,
    launchState: { Found: false, Enabled: false, DisabledReason: 'Script not found', Name: null },
    executed,
  });

  await RunLaunchActions({ ScriptID: 'ghost', DelaySeconds: 10, ShowCountdown: true });
  assert.deepEqual(executed, []);
});

test('a script that is not runnable on this OS is skipped', async () => {
  const profileDir = tempDir('la-disabled-');
  const executed = [];
  const { RunLaunchActions } = loadLaunchActions({
    profileDir,
    launchState: {
      Found: true,
      Enabled: false,
      DisabledReason: 'No script is configured for this operating system',
      Name: 'Windows Only',
    },
    executed,
  });

  await RunLaunchActions({ ScriptID: 'win-only', DelaySeconds: 10, ShowCountdown: true });
  assert.deepEqual(executed, []);
});

test('the countdown runs and the script executes when it elapses', async () => {
  const profileDir = tempDir('la-run-');
  const executed = [];
  const shown = [];
  const { RunLaunchActions } = loadLaunchActions({
    profileDir,
    launchState: RUNNABLE,
    showOutcome: 'elapsed',
    executed,
    shown,
  });

  await RunLaunchActions({ ScriptID: 'open-show', DelaySeconds: 30, ShowCountdown: true });

  assert.deepEqual(shown, [{ ScriptName: 'Open Show', Seconds: 30 }]);
  assert.deepEqual(executed, [['launch', 'open-show']]);
});

test('an operator cancelling the countdown stops the script', async () => {
  const profileDir = tempDir('la-cancel-');
  const executed = [];
  const { RunLaunchActions } = loadLaunchActions({
    profileDir,
    launchState: RUNNABLE,
    showOutcome: 'cancelled',
    executed,
  });

  await RunLaunchActions({ ScriptID: 'open-show', DelaySeconds: 15, ShowCountdown: true });

  assert.deepEqual(executed, [], 'cancel must actually abort execution');
});

test('the delay is clamped to the 10s minimum abort window', async () => {
  // The delay doubles as the operator's cancel window. A server sending 0 (or a
  // stale/garbage value) must not collapse it to no window at all.
  const profileDir = tempDir('la-clamp-');
  const shown = [];
  const { RunLaunchActions } = loadLaunchActions({
    profileDir,
    launchState: RUNNABLE,
    shown,
  });

  await RunLaunchActions({ ScriptID: 'open-show', DelaySeconds: 0, ShowCountdown: true });
  assert.equal(shown[0].Seconds, 10, '0s must clamp up to the 10s minimum');
});

test('with the countdown disabled the delay is still honoured, silently', async () => {
  const profileDir = tempDir('la-silent-');
  const executed = [];
  const shown = [];
  const waits = [];
  const { RunLaunchActions } = loadLaunchActions({
    profileDir,
    launchState: RUNNABLE,
    executed,
    shown,
    waits,
  });

  await RunLaunchActions({ ScriptID: 'open-show', DelaySeconds: 20, ShowCountdown: false });

  assert.deepEqual(shown, [], 'no overlay when the server disabled the countdown');
  assert.deepEqual(waits, [20000], 'but the delay is still waited out, in ms');
  assert.deepEqual(executed, [['launch', 'open-show']]);
});

test('RunLaunchActions runs at most once per process', async () => {
  const profileDir = tempDir('la-once-');
  const executed = [];
  const { RunLaunchActions } = loadLaunchActions({
    profileDir,
    launchState: RUNNABLE,
    executed,
  });

  const config = { ScriptID: 'open-show', DelaySeconds: 10, ShowCountdown: false };
  await RunLaunchActions(config);
  await RunLaunchActions(config);
  await RunLaunchActions(config);

  assert.deepEqual(executed, [['launch', 'open-show']], 'reconnects must not re-run the script');
});

test('a throwing overlay does not escape RunLaunchActions', async () => {
  // A failure here must not take down the main process on an unattended machine.
  const profileDir = tempDir('la-throw-');
  const { RunLaunchActions } = loadWithMocks(MODULE_PATH, {
    '../Modules/Logger': { CreateLogger: () => silentLogger },
    '../Modules/AppData': { Manager: { GetProfileDirectory: () => profileDir } },
    '../Modules/LaunchConfig': require(REAL_LAUNCH_CONFIG),
    '../Modules/LaunchCountdownOverlay': {
      Manager: {
        Show: async () => {
          throw new Error('overlay window failed to open');
        },
      },
    },
    '../Modules/ScriptManager': {
      Manager: { GetLaunchState: () => RUNNABLE, Execute: async () => [null, true] },
    },
    '../Modules/Utils': { Wait: async () => {} },
  });

  await RunLaunchActions({ ScriptID: 'open-show', DelaySeconds: 10, ShowCountdown: true });
  // Reaching here without throwing is the assertion.
  assert.ok(true);
});
