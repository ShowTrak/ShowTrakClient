const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');
const {
  createFakeChild,
  createFakePowerShell,
  tagged,
  PS_DIR,
} = require('./helpers/fake-powershell');

// The shared PowerShell host (src/Modules/PowerShell). Every Windows sampler
// reads through it, so its framing, queueing and failure handling are pinned
// here against a scripted powershell.exe — the CI runners are not Windows.

const HOST_PATH = path.join(PS_DIR, 'host.js');
const loggerStub = { CreateLogger: () => createSilentLogger() };

const tick = () => new Promise((resolve) => setImmediate(resolve));

function loadHost({ onSpawn, priorities } = {}) {
  const spawned = [];
  const mod = loadWithMocks(HOST_PATH, {
    child_process: {
      spawn: (...args) => {
        const child = createFakeChild();
        child.spawnArgs = args;
        child.pid = 1000 + spawned.length;
        spawned.push(child);
        if (onSpawn) onSpawn(child);
        return child;
      },
    },
    '../Logger': loggerStub,
    '../Utils/process-priority': {
      LowerChildPriority: (child) => priorities && priorities.push(child.pid),
    },
  });
  // No startup allowance by default, so deadlines in these tests are what they say.
  const create = (name = 'Test', options = {}) =>
    mod.CreatePowerShellHost(name, { StartupAllowanceMs: 0, IdleMs: 0, ...options });
  return { ...mod, create, spawned };
}

test('the host reuses one process across requests', async () => {
  const { create, spawned } = loadHost();
  const host = create();

  const first = host.Run('Get-Process', 1000);
  assert.equal(spawned.length, 1, 'the host spawns on first use');
  spawned[0].respond('Safari\nCode\n');
  const [err, out] = await first;
  assert.equal(err, null);
  assert.deepEqual(out.split(/\r?\n/).filter(Boolean), ['Safari', 'Code']);

  // The point of the host: a second request must NOT pay another cold start.
  const second = host.Run('Get-Process', 1000);
  assert.equal(spawned.length, 1);
  spawned[0].respond('Safari\n');
  assert.equal((await second)[1].trim(), 'Safari');

  host.Dispose();
  assert.equal(spawned[0].killed, true);
});

test('the host runs below normal priority, with no window, and initialises UTF-8 first', async () => {
  const priorities = [];
  const { create, spawned } = loadHost({ priorities });
  const host = create();
  const pending = host.Run('Get-Process', 1000);
  assert.deepEqual(priorities, [spawned[0].pid]);
  assert.equal(spawned[0].spawnArgs[0], 'powershell.exe');
  assert.equal(spawned[0].spawnArgs[2].windowsHide, true);
  // Without this the samplers mojibake any name containing non-ASCII characters
  // on a machine that is not already on a UTF-8 codepage.
  assert.match(spawned[0].writes[0], /OutputEncoding/);
  spawned[0].respond('');
  await pending;
  host.Dispose();
});

test('independent hosts never share a process', async () => {
  const { create, spawned } = loadHost();
  const desktop = create('Desktop');
  const wmi = create('WMI');
  const apps = desktop.Run('Get-Process', 1000);
  const disks = wmi.Run('Get-CimInstance Win32_LogicalDisk', 1000);
  assert.equal(spawned.length, 2);
  spawned[1].respond('[]');
  spawned[0].respond('Safari\n');
  assert.deepEqual(await disks, [null, '[]']);
  assert.equal((await apps)[1].trim(), 'Safari');
  wmi.Dispose();
  assert.equal(spawned[1].killed, true);
  assert.equal(spawned[0].killed, false, 'disposing one host leaves the other running');
  desktop.Dispose();
});

test('concurrent requests are queued, not refused, and each gets its own answer', async () => {
  const { create, spawned } = loadHost();
  const host = create();
  const first = host.Run('first', 1000);
  const second = host.Run('second', 1000);
  await tick();
  assert.equal(spawned[0].writes.length, 2, 'init + the first request only: one at a time');
  assert.match(spawned[0].writes[1], /first/);
  spawned[0].respond('one');
  assert.deepEqual(await first, [null, 'one']);
  await tick();
  assert.match(spawned[0].writes[2], /second/);
  spawned[0].respond('two');
  assert.deepEqual(await second, [null, 'two']);
  host.Dispose();
});

test("a queued request's deadline starts when it is sent, not when it is queued", async () => {
  const { create, spawned } = loadHost();
  const host = create();
  const slow = host.Run('slow', 1000);
  const quick = host.Run('quick', 30);
  // Longer than the queued request's own deadline, spent waiting behind `slow`.
  await new Promise((resolve) => setTimeout(resolve, 60));
  spawned[0].respond('slow done');
  assert.deepEqual(await slow, [null, 'slow done']);
  await tick();
  spawned[0].respond('quick done');
  assert.deepEqual(await quick, [null, 'quick done'], 'not timed out while it waited its turn');
  host.Dispose();
});

test('a full queue answers busy, tagged so callers do not fall back', async () => {
  const { create, _constants, HOST_BUSY, IsWorthFallingBack } = loadHost();
  const host = create();
  const pending = [];
  for (let i = 0; i < _constants.MAX_QUEUED + 1; i += 1) pending.push(host.Run(`r${i}`, 1000));
  const [err] = await host.Run('one too many', 1000);
  assert.equal(err.code, HOST_BUSY);
  assert.equal(IsWorthFallingBack(err), false, 'a one-shot would only add to the load');
  host.Dispose();
  await Promise.all(pending);
});

test('a failing script is reported without costing the host', async () => {
  const { create, spawned, SCRIPT_FAILED } = loadHost();
  const host = create();
  const pending = host.Run('Get-Process', 1000);
  const last = spawned[0].writes[spawned[0].writes.length - 1];
  assert.match(last, /try \{/);
  assert.match(last, /catch \{/);
  const errorToken = /Write-Output \('([^']+)' \+ \$_\.Exception\.Message\)/.exec(last)[1];
  spawned[0].respond(`${errorToken}Access is denied`);
  const [err, out] = await pending;
  assert.equal(out, null);
  assert.match(String(err.message), /Access is denied/);
  assert.equal(err.code, SCRIPT_FAILED);

  const next = host.Run('Get-Process', 1000);
  assert.equal(spawned.length, 1, 'still the same host');
  spawned[0].respond('Safari\n');
  assert.equal((await next)[0], null);
  host.Dispose();
});

test('a timeout tears the host down; what was queued behind it runs in a fresh one', async () => {
  const { create, spawned, SCRIPT_TIMED_OUT, IsScriptFailure } = loadHost();
  const host = create();
  const wedged = host.Run('wedged', 5);
  const queued = host.Run('queued', 1000);
  const [err, out] = await wedged;
  assert.equal(out, null);
  assert.match(String(err.message), /timed out/);
  assert.equal(err.code, SCRIPT_TIMED_OUT);
  assert.equal(IsScriptFailure(err), true);
  assert.equal(spawned[0].killed, true, 'a wedged host is killed rather than left running');
  await tick();
  assert.equal(spawned.length, 2, 'the queued request spawns a fresh host');
  spawned[1].respond('ok');
  assert.deepEqual(await queued, [null, 'ok']);
  host.Dispose();
});

test('a host that exits fails only the request it was running', async () => {
  const { create, spawned } = loadHost();
  const host = create();
  const running = host.Run('running', 1000);
  const queued = host.Run('queued', 1000);
  spawned[0].emit('exit', 1, null);
  const [err] = await running;
  assert.match(String(err.message), /exited/);
  await tick();
  spawned[1].respond('fine');
  assert.deepEqual(await queued, [null, 'fine']);
  host.Dispose();
});

test('a response split across stdout chunks is reassembled; banner noise is discarded', async () => {
  const { create, spawned } = loadHost();
  const host = create();
  const pending = host.Run('Get-Process', 1000);
  spawned[0].stdout.emit('data', 'Windows PowerShell\nCopyright (C) Microsoft\nPS C:\\> ');
  const last = spawned[0].writes[spawned[0].writes.length - 1];
  const tokens = [...last.matchAll(/Write-Output '([^']+)'/g)].map((m) => m[1]);
  const framed = `${tokens[0]}Safari\nCode\n${tokens[tokens.length - 1]}`;
  spawned[0].stdout.emit('data', framed.slice(0, 9));
  spawned[0].stdout.emit('data', framed.slice(9, 30));
  spawned[0].stdout.emit('data', framed.slice(30));
  const [err, out] = await pending;
  assert.equal(err, null);
  assert.deepEqual(out.split(/\r?\n/).filter(Boolean), ['Safari', 'Code']);
  host.Dispose();
});

test('a powershell.exe that cannot be spawned makes the host unavailable, and it stops trying', async () => {
  let attempts = 0;
  const { CreatePowerShellHost } = loadWithMocks(HOST_PATH, {
    child_process: {
      spawn: () => {
        attempts += 1;
        throw new Error('spawn powershell.exe ENOENT');
      },
    },
    '../Logger': loggerStub,
  });
  const host = CreatePowerShellHost('Test', { IdleMs: 0 });
  const [err, out] = await host.Run('Get-Process', 1000);
  assert.equal(out, null);
  assert.match(String(err.message), /unavailable/);
  await host.Run('Get-Process', 1000);
  assert.equal(attempts, 1, 'a failing spawn is not retried on every request');
});

test('a prelude is sent once per powershell.exe, ahead of the first request needing it', async () => {
  const { create, spawned } = loadHost();
  const host = create();
  const prelude = { Key: 'Shim', Script: 'Add-Type -TypeDefinition $src', ExtraTimeoutMs: 15000 };

  const first = host.Run('[Shim]::Query()', { TimeoutMs: 1000, Prelude: prelude });
  assert.match(spawned[0].writes[1], /Add-Type/);
  // Its output is discarded and its errors swallowed: the script checks for it.
  assert.match(spawned[0].writes[1], /try \{ \$null = & \{ Add-Type/);
  assert.ok(
    spawned[0].writes[1].indexOf('Add-Type') < spawned[0].writes[1].indexOf('<<<ShowTrak:BEGIN'),
    'before the response frame, so it cannot pollute the answer'
  );
  spawned[0].respond('one');
  await first;

  const second = host.Run('[Shim]::Query()', { TimeoutMs: 1000, Prelude: prelude });
  assert.doesNotMatch(spawned[0].writes[2], /Add-Type/, 'not resent to the same process');
  spawned[0].respond('two');
  await second;

  // A fresh process has to be set up again.
  spawned[0].emit('exit', 0, null);
  const third = host.Run('[Shim]::Query()', { TimeoutMs: 1000, Prelude: prelude });
  assert.equal(spawned.length, 2);
  assert.match(spawned[1].writes[1], /Add-Type/);
  spawned[1].respond('three');
  assert.deepEqual(await third, [null, 'three']);
  host.Dispose();
});

test('the request carrying a prelude, and the first into a cold host, get longer deadlines', async () => {
  const { CreatePowerShellHost, spawned } = loadHost();
  const host = CreatePowerShellHost('Test', { IdleMs: 0, StartupAllowanceMs: 40 });
  // 5ms alone would time out; the startup allowance carries the cold call.
  const cold = host.Run('cold', 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  spawned[0].respond('warm now');
  assert.deepEqual(await cold, [null, 'warm now']);

  const shim = host.Run('shim', {
    TimeoutMs: 5,
    Prelude: { Key: 'k', Script: 'Add-Type', ExtraTimeoutMs: 40 },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  spawned[0].respond('compiled');
  assert.deepEqual(await shim, [null, 'compiled']);

  const [err] = await host.Run('warm', 5);
  assert.match(String(err.message), /timed out/, 'a warm request gets its own deadline only');
  host.Dispose();
});

test('an idle host stops itself, and the next request starts a fresh one', async () => {
  const { create, spawned } = loadHost();
  const host = create('Test', { IdleMs: 20 });
  const first = host.Run('one', 1000);
  spawned[0].respond('1');
  await first;
  assert.equal(host.IsRunning(), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(spawned[0].killed, true, 'stopped after the idle period');
  assert.equal(host.IsRunning(), false);

  const second = host.Run('two', 1000);
  assert.equal(spawned.length, 2);
  spawned[1].respond('2');
  assert.deepEqual(await second, [null, '2']);
  host.Dispose();
});

test('a request keeps a busy host from going idle', async () => {
  const { create, spawned } = loadHost();
  const host = create('Test', { IdleMs: 20 });
  const pending = host.Run('long', 1000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(spawned[0].killed, false, 'never stopped under a running request');
  spawned[0].respond('done');
  assert.deepEqual(await pending, [null, 'done']);
  host.Dispose();
});

test('Dispose fails whatever was still queued', async () => {
  const { create } = loadHost();
  const host = create();
  const running = host.Run('running', 1000);
  const queued = host.Run('queued', 1000);
  host.Dispose();
  assert.match(String((await running)[0].message), /disposed/);
  assert.match(String((await queued)[0].message), /disposed/);
});

// ---------------------------------------------------------------------------
// The shared fallback policy
// ---------------------------------------------------------------------------

test('RunPowerShell falls back to a one-shot only when the host itself could not run', async () => {
  const unavailable = createFakePowerShell({ host: () => null, oneShot: () => 'from one-shot' });
  const { PowerShell } = unavailable;
  assert.deepEqual(
    await PowerShell.RunPowerShell(PowerShell.Hosts.Wmi, 'Get-Thing', { TimeoutMs: 1000 }),
    [null, 'from one-shot']
  );
  const [shot] = unavailable.oneShots;
  assert.equal(shot.cmd, 'powershell.exe');
  assert.deepEqual(shot.args.slice(0, 4), [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
  ]);
  assert.equal(shot.script, "$ErrorActionPreference = 'Stop'; Get-Thing");
  assert.equal(shot.options.windowsHide, true);

  // A script that raised, ran past its deadline, or met a full queue would only
  // do the same again in a cold powershell.exe.
  for (const error of [
    tagged('Access denied', 'ESCRIPT'),
    tagged('timed out', 'ETIMEDOUT'),
    tagged('busy', 'EBUSY'),
  ]) {
    const fake = createFakePowerShell({ host: () => error, oneShot: () => 'unexpected' });
    const [err, out] = await fake.PowerShell.RunPowerShell(fake.PowerShell.Hosts.Wmi, 'x', {
      TimeoutMs: 1000,
    });
    assert.equal(out, null);
    assert.equal(err, error);
    assert.equal(fake.oneShots.length, 0, `${error.code}: no one-shot`);
  }
});

test('RunPowerShell: the fallback includes the prelude, can be replaced, or disabled', async () => {
  const withPrelude = createFakePowerShell({ host: () => null, oneShot: () => 'ok' });
  await withPrelude.PowerShell.RunPowerShell(withPrelude.PowerShell.Hosts.Desktop, 'Query', {
    TimeoutMs: 1000,
    Prelude: { Key: 'k', Script: 'Add-Type x' },
  });
  assert.equal(
    withPrelude.oneShots[0].script,
    "$ErrorActionPreference = 'Stop'; Add-Type x; Query"
  );
  assert.deepEqual(withPrelude.hostRuns[0].options.Prelude, { Key: 'k', Script: 'Add-Type x' });

  const replaced = createFakePowerShell({ host: () => null, oneShot: () => 'ok' });
  await replaced.PowerShell.RunPowerShell(replaced.PowerShell.Hosts.Wmi, 'Query', {
    TimeoutMs: 1000,
    Fallback: 'Simpler',
  });
  assert.equal(replaced.oneShots[0].script, "$ErrorActionPreference = 'Stop'; Simpler");

  const disabled = createFakePowerShell({ host: () => null, oneShot: () => 'ok' });
  const [err] = await disabled.PowerShell.RunPowerShell(disabled.PowerShell.Hosts.Wmi, 'Query', {
    TimeoutMs: 1000,
    Fallback: false,
  });
  assert.match(String(err.message), /unavailable/);
  assert.equal(disabled.oneShots.length, 0);
});

test('the shared hosts are two: one for desktop calls, one for WMI', () => {
  const { PowerShell } = createFakePowerShell();
  assert.equal(PowerShell.Hosts.Desktop.Name, 'PowerShell:Desktop');
  assert.equal(PowerShell.Hosts.Wmi.Name, 'PowerShell:WMI');
});

test('LastJsonLine and JsonRows read PowerShell JSON around its noise and quirks', () => {
  const { PowerShell } = createFakePowerShell();
  assert.equal(PowerShell.LastJsonLine('WARNING: x\r\n{"a":1}\r\n'), '{"a":1}');
  assert.equal(PowerShell.LastJsonLine('[1]\n{"a":1}', ['[']), '[1]');
  assert.equal(PowerShell.LastJsonLine('Add-Type : Cannot add type.'), null);
  assert.deepEqual(PowerShell.JsonRows([1, 2]), [1, 2]);
  assert.deepEqual(PowerShell.JsonRows({ Name: 'x' }), [{ Name: 'x' }]);
  assert.deepEqual(PowerShell.JsonRows({ value: [1], Count: 1 }), [1]);
  assert.deepEqual(PowerShell.JsonRows(null), []);
});

test('LowerChildPriority lowers a helper process and ignores anything without a pid', () => {
  const calls = [];
  const { LowerChildPriority } = loadWithMocks(
    path.join(__dirname, '..', 'dist', 'Modules', 'Utils', 'process-priority.js'),
    {
      'node:os': {
        setPriority: (...args) => {
          calls.push(args);
          if (args[0] === 13) throw new Error('ESRCH');
        },
        constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } },
      },
    }
  );
  LowerChildPriority({ pid: 42 });
  LowerChildPriority({});
  LowerChildPriority(undefined);
  LowerChildPriority({ pid: 13 }); // already exited: silent
  assert.deepEqual(calls, [
    [42, 10],
    [13, 10],
  ]);
});
