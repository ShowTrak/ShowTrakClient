const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// The platform samplers behind ProcessMonitor.
//
// These are the pieces that replaced a ~1.2-SECOND macOS sample (an osascript
// Apple Events round-trip against System Events, which also needed Automation
// permission) and a per-sample powershell.exe cold start on Windows. Both were
// affordable at the old 20-second poll and are not at the 3-second one, so the
// correctness of the replacements is what makes the faster cadence safe.
//
// Every test drives the samplers through mocked child_process, so the suite
// asserts the same behaviour on every platform — in particular the Windows
// PowerShell host, whose framing cannot otherwise be exercised on CI runners
// that are not Windows.

const SAMPLERS_PATH = path.join(
  __dirname,
  '..',
  'dist',
  'Modules',
  'ProcessMonitor',
  'samplers.js'
);
const HOST_PATH = path.join(
  __dirname,
  '..',
  'dist',
  'Modules',
  'ProcessMonitor',
  'powershell-host.js'
);

const loggerStub = { CreateLogger: () => createSilentLogger() };

/** A stand-in for a spawned powershell.exe that the test drives by hand. */
function createFakeChild() {
  const child = new EventEmitter();
  child.writes = [];
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.resume = () => {};
  child.stdin = {
    write: (chunk) => {
      child.writes.push(String(chunk));
      return true;
    },
  };
  child.kill = () => {
    child.killed = true;
  };
  // Reply to the most recent script the way a real host would: the payload
  // wrapped in whatever sentinels the module wrote around it.
  child.respond = (payload) => {
    const last = child.writes[child.writes.length - 1] || '';
    const tokens = [...last.matchAll(/Write-Output '([^']+)'/g)].map((m) => m[1]);
    const begin = tokens[0];
    const end = tokens[tokens.length - 1];
    child.stdout.emit('data', `${begin}${payload}${end}\n`);
  };
  return child;
}

function loadHost({ onSpawn } = {}) {
  const spawned = [];
  const { Manager } = loadWithMocks(HOST_PATH, {
    child_process: {
      spawn: (...args) => {
        const child = createFakeChild();
        child.spawnArgs = args;
        spawned.push(child);
        if (onSpawn) onSpawn(child);
        return child;
      },
    },
    '../Logger': loggerStub,
  });
  return { Manager, spawned };
}

test('PowerShell host reuses one process across samples', async () => {
  const { Manager, spawned } = loadHost();

  const first = Manager.Run('Get-Process', 1000);
  assert.equal(spawned.length, 1, 'the host spawns on first use');
  spawned[0].respond('Safari\nCode\n');
  const [err, out] = await first;
  assert.equal(err, null);
  assert.deepEqual(
    out.split(/\r?\n/).filter(Boolean),
    ['Safari', 'Code'],
    'the payload is returned without the sentinels'
  );

  // The point of the host: a second sample must NOT pay another cold start.
  const second = Manager.Run('Get-Process', 1000);
  assert.equal(spawned.length, 1, 'a second sample reuses the running host');
  spawned[0].respond('Safari\n');
  const [err2, out2] = await second;
  assert.equal(err2, null);
  assert.equal(out2.trim(), 'Safari');

  Manager.Dispose();
  assert.equal(spawned[0].killed, true);
});

test('PowerShell host initialises UTF-8 output before any script', async () => {
  const { Manager, spawned } = loadHost();
  const pending = Manager.Run('Get-Process', 1000);
  // Without this the sampler mojibakes any process name containing non-ASCII
  // characters on a machine that is not already on a UTF-8 codepage.
  assert.match(spawned[0].writes[0], /OutputEncoding/);
  spawned[0].respond('');
  await pending;
  Manager.Dispose();
});

test('PowerShell host surfaces a failing script without dying', async () => {
  const { Manager, spawned } = loadHost();

  const pending = Manager.Run('Get-Process', 1000);
  const last = spawned[0].writes[spawned[0].writes.length - 1];
  // The wrapper must catch, so one bad script does not cost us the host.
  assert.match(last, /try \{/);
  assert.match(last, /catch \{/);
  const errorToken = /Write-Output \('([^']+)' \+ \$_\.Exception\.Message\)/.exec(last)[1];
  spawned[0].respond(`${errorToken}Access is denied`);

  const [err, out] = await pending;
  assert.equal(out, null);
  assert.match(String(err.message), /Access is denied/);

  // Still the same host: a script-level failure is not a host-level one.
  const next = Manager.Run('Get-Process', 1000);
  assert.equal(spawned.length, 1);
  spawned[0].respond('Safari\n');
  assert.equal((await next)[0], null);
  Manager.Dispose();
});

test('PowerShell host tears down and respawns after a timeout', async () => {
  const { Manager, spawned } = loadHost();

  // Never responds, so the deadline is what resolves this.
  const pending = Manager.Run('Get-Process', 5);
  const [err, out] = await pending;
  assert.equal(out, null);
  assert.match(String(err.message), /timed out/);
  assert.equal(spawned[0].killed, true, 'a wedged host is killed rather than left running');

  // A wedged host must not poison every later sample.
  const next = Manager.Run('Get-Process', 1000);
  assert.equal(spawned.length, 2, 'the next sample spawns a fresh host');
  spawned[1].respond('Safari\n');
  assert.equal((await next)[0], null);
  Manager.Dispose();
});

test('PowerShell host fails the in-flight sample when the process exits', async () => {
  const { Manager, spawned } = loadHost();
  const pending = Manager.Run('Get-Process', 1000);
  spawned[0].emit('exit', 1, null);
  const [err, out] = await pending;
  assert.equal(out, null);
  assert.match(String(err.message), /exited/);
  Manager.Dispose();
});

test('PowerShell host reassembles a response split across stdout chunks', async () => {
  const { Manager, spawned } = loadHost();
  const pending = Manager.Run('Get-Process', 1000);

  const last = spawned[0].writes[spawned[0].writes.length - 1];
  const tokens = [...last.matchAll(/Write-Output '([^']+)'/g)].map((m) => m[1]);
  const [begin, , end] = [tokens[0], tokens[1], tokens[tokens.length - 1]];
  // A pipe hands over whatever it has; a sentinel can land across a boundary.
  const framed = `${begin}Safari\nCode\n${end}`;
  spawned[0].stdout.emit('data', framed.slice(0, 9));
  spawned[0].stdout.emit('data', framed.slice(9, 30));
  spawned[0].stdout.emit('data', framed.slice(30));

  const [err, out] = await pending;
  assert.equal(err, null);
  assert.deepEqual(out.split(/\r?\n/).filter(Boolean), ['Safari', 'Code']);
  Manager.Dispose();
});

test('PowerShell host discards banner noise written before a response', async () => {
  const { Manager, spawned } = loadHost();
  const pending = Manager.Run('Get-Process', 1000);
  spawned[0].stdout.emit('data', 'Windows PowerShell\nCopyright (C) Microsoft\nPS C:\\> ');
  spawned[0].respond('Safari\n');
  const [err, out] = await pending;
  assert.equal(err, null);
  assert.equal(out.trim(), 'Safari');
  Manager.Dispose();
});

test('PowerShell host refuses to interleave two samples', async () => {
  const { Manager, spawned } = loadHost();
  const first = Manager.Run('Get-Process', 1000);
  const [busyErr] = await Manager.Run('Get-Process', 1000);
  assert.match(String(busyErr.message), /busy/);
  spawned[0].respond('Safari\n');
  await first;
  Manager.Dispose();
});

test('PowerShell host reports unavailable when powershell.exe cannot be spawned', async () => {
  const { Manager } = loadWithMocks(HOST_PATH, {
    child_process: {
      spawn: () => {
        throw new Error('spawn powershell.exe ENOENT');
      },
    },
    '../Logger': loggerStub,
  });
  const [err, out] = await Manager.Run('Get-Process', 1000);
  assert.equal(out, null);
  assert.match(String(err.message), /unavailable/);
});

// ---------------------------------------------------------------------------

function loadSamplers({ execFile } = {}) {
  const calls = [];
  const module = loadWithMocks(SAMPLERS_PATH, {
    child_process: {
      execFile: (command, args, _opts, callback) => {
        calls.push([command, args]);
        const result = execFile ? execFile(command, args) : [null, ''];
        // Real execFile is asynchronous; keeping that here means the samplers
        // are exercised with the interleaving they actually see.
        setImmediate(() => callback(result[0], result[1]));
      },
    },
    os: { userInfo: () => ({ username: 'tester' }) },
    '../Logger': loggerStub,
  });
  return { ...module, calls };
}

const VISIBLE_LIST =
  'ASN:0x0-0x64d04ca-"Code": ASN:0x0-0x654b545-"GitHub_Desktop": ASN:0x0-0x27027-"Finder":';

test('macOS sampler resolves real display names, not the underscored listing', async () => {
  const { collectMacApplications } = loadSamplers({
    execFile: (command, args) => {
      if (args[0] === 'visibleProcessList') return [null, VISIBLE_LIST];
      const asn = args[args.length - 1];
      if (asn.endsWith('654b545')) return [null, '"LSDisplayName"="GitHub Desktop"'];
      if (asn.endsWith('64d04ca')) return [null, '"LSDisplayName"="Code"'];
      return [null, '"LSDisplayName"="Finder"'];
    },
  });

  const [err, names] = await collectMacApplications();
  assert.equal(err, null);
  // lsappinfo's listing renders spaces as underscores, so taking the embedded
  // name verbatim would report "GitHub_Desktop" and stop matching a critical
  // application rule named "GitHub Desktop".
  assert.deepEqual(names, ['Code', 'GitHub Desktop', 'Finder']);
});

test('macOS sampler resolves each name once, not once per sample', async () => {
  const { collectMacApplications, calls } = loadSamplers({
    execFile: (command, args) =>
      args[0] === 'visibleProcessList'
        ? [null, VISIBLE_LIST]
        : [null, '"LSDisplayName"="Resolved"'],
  });

  await collectMacApplications();
  const afterFirst = calls.length;
  assert.equal(afterFirst, 4, 'one listing plus one lookup per application');

  await collectMacApplications();
  // This is what keeps the 3-second poll cheap: the steady-state cost of a
  // sample is the single listing call, not a lookup per running application.
  assert.equal(calls.length - afterFirst, 1, 'a repeat sample only lists');
});

test('macOS sampler forgets applications that have quit', async () => {
  let listing = VISIBLE_LIST;
  const { collectMacApplications, _internal } = loadSamplers({
    execFile: (command, args) =>
      args[0] === 'visibleProcessList' ? [null, listing] : [null, '"LSDisplayName"="Resolved"'],
  });

  await collectMacApplications();
  assert.equal(_internal.displayNameCache.size, 3);

  listing = 'ASN:0x0-0x27027-"Finder":';
  await collectMacApplications();
  // An ASN is unique to one launch, so a cache that never evicted would grow
  // for the life of the process.
  assert.equal(_internal.displayNameCache.size, 1);
});

test('macOS sampler falls back to System Events when lsappinfo is unusable', async () => {
  for (const [label, lsappinfoResult] of [
    ['fails', [new Error('lsappinfo missing'), '']],
    ['returns nothing', [null, '']],
  ]) {
    const { collectMacApplications, calls } = loadSamplers({
      execFile: (command) =>
        command === 'lsappinfo' ? lsappinfoResult : [null, 'Safari\nFinder\n'],
    });
    const [err, names] = await collectMacApplications();
    assert.equal(err, null, `fallback should succeed when lsappinfo ${label}`);
    assert.deepEqual(names, ['Safari', 'Finder']);
    assert.equal(
      calls.some(([command]) => command === 'osascript'),
      true,
      `System Events should be consulted when lsappinfo ${label}`
    );
  }
});

test('macOS sampler propagates a System Events permission error when both paths fail', async () => {
  const { collectMacApplications } = loadSamplers({
    execFile: (command) =>
      command === 'lsappinfo'
        ? [new Error('no lsappinfo'), '']
        : [new Error('Not authorized to send Apple events (-1743)'), ''],
  });
  const [err, names] = await collectMacApplications();
  assert.equal(names, null);
  // ProcessMonitor classifies this into the permission_denied state the UI
  // shows, so the error has to survive the fallback rather than be swallowed.
  assert.match(String(err.message), /-1743/);
});

test('Windows sampler falls back to a one-shot spawn when the host is unavailable', async () => {
  const calls = [];
  const { collectWindowsApplications } = loadWithMocks(SAMPLERS_PATH, {
    child_process: {
      spawn: () => {
        throw new Error('spawn powershell.exe ENOENT');
      },
      execFile: (command, args, _opts, callback) => {
        calls.push([command, args]);
        setImmediate(() => callback(null, 'Safari\r\nCode\r\n'));
      },
    },
    os: { userInfo: () => ({ username: 'tester' }) },
    '../Logger': loggerStub,
  });

  const [err, names] = await collectWindowsApplications();
  assert.equal(err, null);
  assert.deepEqual(names, ['Safari', 'Code']);
  assert.equal(calls[0][0], 'powershell.exe');
  // A host that cannot start must cost latency, not the signal itself.
  assert.equal(
    calls[0][1].some((arg) => arg.includes('MainWindowHandle')),
    true,
    'the fallback keeps the same windowed-process filter'
  );
});

test('Linux sampler scopes the listing to the current user', async () => {
  const { collectLinuxApplications, calls } = loadSamplers({
    execFile: () => [null, 'gnome-shell\nfirefox\n'],
  });
  const [err, names] = await collectLinuxApplications();
  assert.equal(err, null);
  assert.deepEqual(names, ['gnome-shell', 'firefox']);
  assert.deepEqual(calls[0], ['ps', ['-u', 'tester', '-o', 'comm=']]);
});
