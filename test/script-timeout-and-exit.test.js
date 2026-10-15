// How a script run ends: success, failure, timeout, or app quit.
//
// Three properties, each of which used to be wrong:
//
//   1. A NON-ZERO EXIT IS A FAILURE. It was logged and then reported to the
//      Server as success, so a script that failed on every machine showed green.
//   2. THE REAL REASON IS REPORTED. Every failure used to collapse into one
//      generic sentence, so the operator could not tell a missing interpreter
//      from a script that exited 1.
//   3. THE SCRIPT'S TIMEOUT IS ENFORCED, by killing the DIRECT child only. A
//      process tree kill would take down the show application a script launched
//      (QLab etc.), so anything the script started must survive — that is
//      asserted below with a real background process.
//
// The real-process tests run /bin/sh scripts and so are POSIX-only; the
// escalation test drives a fake child and runs everywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const { loadWithMocks, createSilentLogger, withMocks } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'ScriptManager', 'index.js');
const POSIX = process.platform !== 'win32';
const PLATFORM_KEY =
  process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, description, timeoutMs = 5000) {
  const Deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > Deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A fresh ScriptManager with every dependency stubbed. */
function loadModule(scriptsDir = os.tmpdir(), profileDir = os.tmpdir()) {
  return loadWithMocks(MODULE_PATH, {
    '../Logger': { CreateLogger: () => createSilentLogger() },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../AppData': {
      Manager: {
        GetScriptsDirectory: () => scriptsDir,
        GetProfileDirectory: () => profileDir,
      },
    },
    '../Variables': { Manager: { GetEnvironment: () => ({}) } },
    '@showtrak/protocol/runtime': { ChecksumFile: async () => 'sum', ChecksumBuffer: () => 'sum' },
  });
}

/**
 * ScriptManager with one script, `script-1`, whose body is `body` (sh).
 * `extra` is merged into the script definition (e.g. { Timeout: 300 }).
 */
async function setup(body = 'exit 0', extra = {}) {
  const scriptsDir = tempDir('showtrak-scripts-exit-');
  const profileDir = tempDir('showtrak-profile-exit-');
  const scriptFolder = path.join(scriptsDir, 'script-1');
  fs.mkdirSync(scriptFolder, { recursive: true });
  fs.writeFileSync(path.join(scriptFolder, 'run.sh'), `#!/bin/sh\n${body}\n`, 'utf8');

  const mod = loadModule(scriptsDir, profileDir);

  await mod.Manager.SetScripts([
    {
      ID: 'script-1',
      Name: 'Demo',
      Enabled: true,
      Platforms: { [PLATFORM_KEY]: 'run.sh' },
      Files: [{ Path: 'run.sh', Type: 'file', Checksum: 'sum' }],
      ...extra,
    },
  ]);

  return { ...mod, scriptFolder };
}

// --- Exit codes and error reporting -------------------------------------------

test('a zero exit is success', { skip: !POSIX }, async () => {
  const { Manager } = await setup('echo fine; exit 0');
  assert.deepEqual(await Manager.Execute('r', 'script-1'), [null, true]);
});

test('a non-zero exit fails with the tail of stderr', { skip: !POSIX }, async () => {
  const { Manager } = await setup('echo "QLab workspace not found" >&2; exit 3');
  const [Err, Success] = await Manager.Execute('r', 'script-1');
  assert.equal(Success, false);
  assert.equal(Err, 'QLab workspace not found');
});

test('a non-zero exit with no stderr names the exit code', { skip: !POSIX }, async () => {
  const { Manager } = await setup('echo only stdout; exit 4');
  assert.deepEqual(await Manager.Execute('r', 'script-1'), ['Script exited with code 4.', false]);
});

test('a long stderr is trimmed to its tail, which is where the reason is', () => {
  const { _internal } = loadModule();
  const Long = `${'noise '.repeat(200)}the actual reason`;
  const Tail = _internal.TailText(Long);
  assert.ok(Tail.length <= 501, `tail was ${Tail.length} characters`);
  assert.ok(Tail.startsWith('…'));
  assert.ok(Tail.endsWith('the actual reason'));
  assert.equal(_internal.TailText('  short  '), 'short');
  assert.equal(_internal.TailText('   '), '');
});

test('a run that fails without any message still reports something', async () => {
  // The Server reads a falsy error as SUCCESS, so an empty string must never be
  // sent back.
  const { Manager } = await setup();
  const [Err, Success] = await withMocks(
    {
      child_process: {
        spawn: () => ({
          stdout: { on: () => {} },
          stderr: { on: () => {} },
          on: (event, cb) => {
            if (event === 'error') cb(new Error(''));
          },
        }),
      },
    },
    () => Manager.Execute('r', 'script-1')
  );
  assert.equal(Success, false);
  assert.equal(Err, 'Failed to run script.');
});

// --- Timeout --------------------------------------------------------------------

test('the timeout defaults to 15s and honours a positive script Timeout', () => {
  const { _internal } = loadModule();
  assert.equal(_internal.ResolveTimeoutMs({ Timeout: 2500 }), 2500);
  for (const Timeout of [undefined, null, 0, -5, NaN, '3000', Infinity]) {
    assert.equal(_internal.ResolveTimeoutMs({ Timeout }), 15000, `Timeout ${Timeout}`);
  }
  assert.equal(_internal.ResolveTimeoutMs(null), 15000);
  assert.equal(_internal.FormatTimeout(15000), '15s');
  assert.equal(_internal.FormatTimeout(1500), '1.5s');
});

test('a script that overruns its Timeout is stopped and fails', { skip: !POSIX }, async () => {
  const { Manager, scriptFolder } = await setup('echo $$ > self.pid; exec sleep 30', {
    Timeout: 300,
  });
  const Started = Date.now();
  const [Err, Success] = await Manager.Execute('r', 'script-1');

  assert.equal(Success, false);
  assert.equal(Err, 'Script timed out after 0.3s.');
  assert.ok(Date.now() - Started < 5000, 'the run did not end at its timeout');

  const Pid = Number(fs.readFileSync(path.join(scriptFolder, 'self.pid'), 'utf8'));
  await waitFor(() => !isAlive(Pid), 'the timed-out script process to exit');
});

test(
  'a timeout kills only the direct child, never what the script launched',
  {
    skip: !POSIX,
  },
  async () => {
    // The background `sleep` stands in for QLab: launched by the script, inheriting
    // its stdout, and required to outlive it. It holding the pipe open is also why
    // the run must settle on the timeout rather than wait for 'close'.
    const { Manager, scriptFolder } = await setup(
      'echo $$ > self.pid; sleep 30 & echo $! > show.pid; wait',
      { Timeout: 300 }
    );

    const [Err] = await Manager.Execute('r', 'script-1');
    assert.equal(Err, 'Script timed out after 0.3s.');

    const ScriptPid = Number(fs.readFileSync(path.join(scriptFolder, 'self.pid'), 'utf8'));
    const ShowPid = Number(fs.readFileSync(path.join(scriptFolder, 'show.pid'), 'utf8'));
    try {
      await waitFor(() => !isAlive(ScriptPid), 'the script process itself to exit');
      assert.equal(isAlive(ShowPid), true, 'the process the script launched was killed too');
    } finally {
      try {
        process.kill(ShowPid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
);

test('a child that ignores SIGTERM is SIGKILLed after the grace period', async (t) => {
  // Driven with a fake child so it runs on every platform and needs no real
  // 3s wait. On Windows kill() is already a hard stop, so there is no
  // escalation to observe.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { _internal } = loadModule();

  const Signals = [];
  const Child = new EventEmitter();
  Child.stdout = new EventEmitter();
  Child.stderr = new EventEmitter();
  Child.exitCode = null;
  Child.signalCode = null;
  Child.kill = (Signal) => {
    Signals.push(Signal || 'SIGTERM');
    return true;
  };

  const Run = withMocks({ child_process: { spawn: () => Child } }, () =>
    _internal.RunScriptFile('/tmp/never-run.sh', [], null, null, null, 1000)
  );
  const Outcome = Run.then(
    () => 'resolved',
    (Err) => Err.message
  );

  t.mock.timers.tick(1000);
  assert.equal(await Outcome, 'Script timed out after 1s.');
  assert.deepEqual(Signals, ['SIGTERM'], 'SIGTERM first, so the script can clean up');

  t.mock.timers.tick(3000);
  if (process.platform === 'win32') {
    assert.deepEqual(Signals, ['SIGTERM']);
  } else {
    assert.deepEqual(Signals, ['SIGTERM', 'SIGKILL']);
  }
});

test('a child that exits within the grace period is not SIGKILLed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { _internal } = loadModule();

  const Signals = [];
  const Child = new EventEmitter();
  Child.stdout = new EventEmitter();
  Child.stderr = new EventEmitter();
  Child.exitCode = null;
  Child.signalCode = null;
  Child.kill = (Signal) => {
    Signals.push(Signal || 'SIGTERM');
    Child.signalCode = 'SIGTERM';
    return true;
  };

  const Run = withMocks({ child_process: { spawn: () => Child } }, () =>
    _internal.RunScriptFile('/tmp/never-run.sh', [], null, null, null, 1000)
  );
  t.mock.timers.tick(1000);
  await assert.rejects(Run, /timed out/);
  t.mock.timers.tick(3000);
  assert.deepEqual(Signals, ['SIGTERM']);
});

// --- App quit -------------------------------------------------------------------

test('quitting stops running scripts and fails their runs', { skip: !POSIX }, async () => {
  const { Manager, scriptFolder } = await setup('echo $$ > self.pid; exec sleep 30', {
    Timeout: 60000,
  });

  const Run = Manager.Execute('r', 'script-1');
  const PidFile = path.join(scriptFolder, 'self.pid');
  await waitFor(() => fs.existsSync(PidFile) && fs.readFileSync(PidFile, 'utf8').trim(), 'start');

  assert.equal(Manager.StopRunningScripts(), 1);
  assert.deepEqual(await Run, ['Script was stopped because ShowTrak Client is quitting.', false]);

  const Pid = Number(fs.readFileSync(PidFile, 'utf8'));
  await waitFor(() => !isAlive(Pid), 'the script process to exit on quit');
  assert.equal(Manager.StopRunningScripts(), 0, 'a finished run was still tracked');
});
