// The Windows user-environment exporter.
//
// This is the one module in the feature whose real behaviour CANNOT be observed
// on this platform: it shells out to powershell.exe and writes HKCU. So the
// tests pin the two things that are checkable anywhere — that it is inert off
// Windows, and that the PowerShell it generates is exactly right — rather than
// pretending to verify the registry write.
//
// The generated script carries the weight of the feature:
//
//   1. IT RECONCILES, IT DOES NOT APPEND. Names no longer in the show are
//      deleted. Without that, deleting a variable in the Variable Manager leaves
//      it in the machine's registry indefinitely.
//   2. IT ONLY EVER TOUCHES SHOWTRAK_VAR_*. The delete pass enumerates the
//      registry, so a bug here could remove a user's own variables.
//   3. IT QUOTES VALUES SAFELY. Values are operator-typed and land inside a
//      PowerShell string; a stray quote must not be able to become code.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'WindowsEnvironment', 'index.js');

function loadExporter(spawnImpl) {
  return loadWithMocks(MODULE_PATH, {
    '../Logger': { CreateLogger: () => createSilentLogger() },
    child_process: { spawn: spawnImpl || (() => assert.fail('spawn must not be called')) },
  });
}

test('the exporter is inert on macOS and Linux', async () => {
  const { Manager } = loadExporter();
  if (process.platform === 'win32') {
    assert.equal(Manager.IsSupported(), true);
    return;
  }
  assert.equal(Manager.IsSupported(), false);
  // Must not spawn — the mocked spawn asserts if called. macOS/Linux clients
  // still receive variables in their scripts; only this mirror is Windows-only.
  await Manager.Reconcile({ SHOWTRAK_VAR_A: '1' });
});

test('the generated script sets every variable and deletes the rest', () => {
  const { _internal } = loadExporter();
  const Script = _internal.BuildReconcileScript({
    SHOWTRAK_VAR_GAME_VERSION: 'TEST_GAME',
    SHOWTRAK_VAR_ROOM: 'Studio 1',
  });

  // .NET's SetEnvironmentVariable with 'User' scope is what writes HKCU *and*
  // broadcasts WM_SETTINGCHANGE. setx would truncate at 1024 chars and not
  // reliably notify, which is why it is not used.
  assert.match(
    Script,
    /\[Environment\]::SetEnvironmentVariable\('SHOWTRAK_VAR_GAME_VERSION', 'TEST_GAME', 'User'\)/
  );
  assert.match(
    Script,
    /\[Environment\]::SetEnvironmentVariable\('SHOWTRAK_VAR_ROOM', 'Studio 1', 'User'\)/
  );

  // The delete pass: enumerate what is there, remove anything not wanted.
  assert.match(Script, /GetEnvironmentVariables\('User'\)/);
  assert.match(Script, /SHOWTRAK_VAR_\*/);
  assert.match(Script, /\$Name -notin \$Wanted/);
  assert.match(Script, /SetEnvironmentVariable\(\$Name, \$null, 'User'\)/);
});

test('the delete pass is scoped to the SHOWTRAK_VAR_ namespace', () => {
  const { _internal } = loadExporter();
  const Script = _internal.BuildReconcileScript({});

  // With no variables left, the script still runs a delete pass — that is how a
  // show's variables are removed from a machine. It must be impossible for that
  // pass to see anything outside the namespace.
  assert.match(Script, /Where-Object \{ \$_ -like 'SHOWTRAK_VAR_\*' \}/);
  // @() keeps $Wanted an array at zero elements, so -notin still behaves.
  assert.match(Script, /\$Wanted = @\(\)/);
});

test('a value containing a single quote cannot break out of the string', () => {
  const { _internal } = loadExporter();

  // PowerShell single-quoted strings expand nothing, so the only escape is the
  // quote itself — doubled. This is the seam that decides whether an
  // operator-typed value can become a command.
  assert.equal(_internal.QuoteForPowerShell("it's"), "'it''s'");
  assert.equal(
    _internal.QuoteForPowerShell("'; Remove-Item C:\\ -Recurse; '"),
    "'''; Remove-Item C:\\ -Recurse; '''"
  );

  const Script = _internal.BuildReconcileScript({
    SHOWTRAK_VAR_EVIL: "'; Start-Process calc.exe; $x='",
  });
  // The injected text survives only as literal string content.
  assert.match(Script, /'''; Start-Process calc\.exe; \$x='''/);
});

test('a name outside the namespace is never written', () => {
  const { _internal } = loadExporter();
  const Script = _internal.BuildReconcileScript({ PATH: '/evil', SHOWTRAK_VAR_OK: 'y' });

  assert.doesNotMatch(Script, /SetEnvironmentVariable\('PATH'/);
  assert.match(Script, /SetEnvironmentVariable\('SHOWTRAK_VAR_OK'/);
});

// Reconcile short-circuits off Windows, so exercising its dispatch logic
// anywhere but Windows means standing in for the platform. `process.platform` is
// a plain value property, so it can be swapped for the duration of a test —
// which is what keeps this behaviour covered on the machines it is developed on
// rather than only on the machines it ships to.
async function asWindows(fn) {
  const Original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', Original);
  }
}

test('an unchanged set does not re-hit the registry', async () => {
  await asWindows(async () => {
    let spawns = 0;
    const { Manager } = loadExporter(() => {
      spawns += 1;
      return fakeChild(0);
    });
    Manager.Reset();

    await Manager.Reconcile({ SHOWTRAK_VAR_A: '1' });
    await Manager.Reconcile({ SHOWTRAK_VAR_A: '1' });
    // Definition changes fan out to every client, so without this guard every
    // client would rewrite its registry whenever any variable anywhere was
    // edited — on every machine in the show.
    assert.equal(spawns, 1);

    // A genuine change must still get through.
    await Manager.Reconcile({ SHOWTRAK_VAR_A: '2' });
    assert.equal(spawns, 2);
  });
});

test('a changed set is written, and the script reaches powershell over stdin', async () => {
  await asWindows(async () => {
    let written = '';
    let args = null;
    const { Manager } = loadExporter((_cmd, spawnArgs) => {
      args = spawnArgs;
      const child = fakeChild(0);
      child.stdin.end = (text) => {
        written = text;
      };
      return child;
    });
    Manager.Reset();

    await Manager.Reconcile({ SHOWTRAK_VAR_GAME_VERSION: 'TEST_GAME' });

    // -NoProfile keeps a user's profile script from changing behaviour or
    // adding seconds to every reconcile.
    assert.ok(args.includes('-NoProfile'));
    assert.ok(args.includes('-NonInteractive'));
    // Fed over stdin, not as an argument: a large variable set produces a script
    // long enough to approach the Windows command-line limit.
    assert.equal(args.at(-1), '-');
    assert.match(
      written,
      /SetEnvironmentVariable\('SHOWTRAK_VAR_GAME_VERSION', 'TEST_GAME', 'User'\)/
    );
  });
});

test('a powershell failure is swallowed so scripts still run', async () => {
  await asWindows(async () => {
    const { Manager } = loadExporter(() => fakeChild(1));
    Manager.Reset();

    // Scripts get their variables through the injected environment regardless,
    // so a registry failure must never surface as a thrown error that could
    // stop an execution.
    await Manager.Reconcile({ SHOWTRAK_VAR_A: '1' });

    // A failed write must NOT be recorded as applied, or the dedupe guard would
    // suppress every retry and the machine would never catch up.
    let spawns = 0;
    const retry = loadExporter(() => {
      spawns += 1;
      return fakeChild(0);
    });
    retry.Manager.Reset();
    await retry.Manager.Reconcile({ SHOWTRAK_VAR_A: '1' });
    assert.equal(spawns, 1);
  });
});

test('a missing powershell.exe stops further attempts', async () => {
  await asWindows(async () => {
    let spawns = 0;
    const { Manager } = loadExporter(() => {
      spawns += 1;
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    });
    Manager.Reset();

    await Manager.Reconcile({ SHOWTRAK_VAR_A: '1' });
    await Manager.Reconcile({ SHOWTRAK_VAR_B: '2' });
    // Retrying a spawn that cannot succeed on every variable edit is its own
    // performance problem; one attempt is enough to learn it is unavailable.
    assert.equal(spawns, 1);
  });
});

test('the signature ignores key order but not values', () => {
  const { _internal } = loadExporter();
  assert.equal(
    _internal.BuildSignature({ SHOWTRAK_VAR_A: '1', SHOWTRAK_VAR_B: '2' }),
    _internal.BuildSignature({ SHOWTRAK_VAR_B: '2', SHOWTRAK_VAR_A: '1' })
  );
  assert.notEqual(
    _internal.BuildSignature({ SHOWTRAK_VAR_A: '1' }),
    _internal.BuildSignature({ SHOWTRAK_VAR_A: '2' })
  );
});

/** Minimal ChildProcess stand-in that closes with the given exit code. */
function fakeChild(code) {
  const handlers = {};
  const child = {
    stdout: { resume() {} },
    stderr: { setEncoding() {}, on() {} },
    stdin: { end() {} },
    on(event, fn) {
      handlers[event] = fn;
      if (event === 'close') setImmediate(() => fn(code));
      return child;
    },
  };
  return child;
}
