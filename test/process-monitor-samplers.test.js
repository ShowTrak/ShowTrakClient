const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');
const { createFakeChild } = require('./helpers/fake-powershell');

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
const loggerStub = { CreateLogger: () => createSilentLogger() };

/** Set (or, with undefined, delete) environment variables; returns the undo. */
function withEnv(values) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) {
    saved[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

// The shared PowerShell host itself is covered by powershell-host.test.js.

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

  const [err, sample] = await collectMacApplications();
  assert.equal(err, null);
  // lsappinfo's listing renders spaces as underscores, so taking the embedded
  // name verbatim would report "GitHub_Desktop" and stop matching a critical
  // application rule named "GitHub Desktop".
  assert.deepEqual(
    sample.Processes.map((p) => p.Name),
    ['Code', 'GitHub Desktop', 'Finder']
  );
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
  assert.equal(
    afterFirst,
    5,
    'one listing, one frontmost-application query, plus one lookup per application'
  );

  await collectMacApplications();
  // This is what keeps the 3-second poll cheap: the steady-state cost of a
  // sample is the listing and the frontmost query, not a lookup per running
  // application.
  assert.equal(
    calls.length - afterFirst,
    2,
    'a repeat sample only lists and asks what is in front'
  );
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
    const [err, sample] = await collectMacApplications();
    assert.equal(err, null, `fallback should succeed when lsappinfo ${label}`);
    assert.deepEqual(
      sample.Processes.map((p) => p.Name),
      ['Safari', 'Finder']
    );
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

  const [err, sample] = await collectWindowsApplications();
  assert.equal(err, null);
  assert.deepEqual(sample.Processes, [{ Name: 'Safari' }, { Name: 'Code' }]);
  // The fallback does not compile the window shim into a cold PowerShell every
  // three seconds, so it reports both as unavailable rather than guessing.
  assert.deepEqual(sample.Capabilities, { Responding: false, Foreground: false });
  assert.equal('Foreground' in sample, false);
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
  const restoreEnv = withEnv({ DISPLAY: undefined, WAYLAND_DISPLAY: undefined });
  try {
    const [err, sample] = await collectLinuxApplications();
    assert.equal(err, null);
    assert.deepEqual(
      sample.Processes.map((p) => p.Name),
      ['gnome-shell', 'firefox']
    );
    assert.deepEqual(calls[0], ['ps', ['-u', 'tester', '-o', 'comm=']]);
  } finally {
    restoreEnv();
  }
});

// ---------------------------------------------------------------------------
// Hung applications and the focused application
// ---------------------------------------------------------------------------

test('Windows host sample: hung verdicts and the focused application are read from the JSON', () => {
  const { ParseWindowsApplications } = loadSamplers();
  const sample = ParseWindowsApplications(
    JSON.stringify({
      Processes: [
        { Name: 'QLab', Responding: true },
        { Name: 'chrome', Responding: false },
        { Name: 'chrome', Responding: true },
        { Name: 'Resolume', Responding: null },
      ],
      Foreground: 'QLab',
      Shim: true,
    })
  );
  assert.deepEqual(sample.Capabilities, { Responding: true, Foreground: true });
  assert.equal(sample.Foreground, 'QLab');
  assert.deepEqual(sample.Processes, [
    { Name: 'QLab', Responding: true },
    { Name: 'chrome', Responding: false },
    { Name: 'chrome', Responding: true },
    // Readable platform, unreadable window: null, never a guess.
    { Name: 'Resolume', Responding: null },
  ]);
});

test('Windows host sample: one process serialised as a bare object is still a list', () => {
  const { ParseWindowsApplications } = loadSamplers();
  const sample = ParseWindowsApplications(
    `WARNING: noise\r\n${JSON.stringify({
      Processes: { Name: 'QLab', Responding: true },
      Foreground: null,
      Shim: true,
    })}\r\n`
  );
  assert.deepEqual(sample.Processes, [{ Name: 'QLab', Responding: true }]);
  // Supported, but nothing focused (the lock screen, a UAC prompt).
  assert.equal(sample.Foreground, null);
});

test('Windows host sample: a failed shim compile reports both capabilities unavailable', () => {
  const { ParseWindowsApplications } = loadSamplers();
  const sample = ParseWindowsApplications(
    JSON.stringify({
      Processes: [{ Name: 'QLab', Responding: null }],
      Foreground: null,
      Shim: false,
    })
  );
  // The application list survives; the fields are absent rather than null, which
  // is how the server knows to say "not available" rather than "unknown".
  assert.deepEqual(sample.Processes, [{ Name: 'QLab' }]);
  assert.deepEqual(sample.Capabilities, { Responding: false, Foreground: false });
  assert.equal('Foreground' in sample, false);
});

test('Windows host sample: anything but the expected object is an error, not an empty list', () => {
  const { ParseWindowsApplications } = loadSamplers();
  assert.throws(() => ParseWindowsApplications(''), /no process list/);
  assert.throws(() => ParseWindowsApplications('Add-Type : Cannot add type.'), /no process list/);
});

test('Windows sampler reads hung and focus state through the persistent host in one round trip', async () => {
  const spawned = [];
  const execCalls = [];
  const { collectWindowsApplications, WINDOWS_HOST_QUERY, WINDOWS_WINDOW_PRELUDE } = loadWithMocks(
    SAMPLERS_PATH,
    {
      child_process: {
        spawn: () => {
          const child = createFakeChild();
          spawned.push(child);
          return child;
        },
        execFile: (command, args, _opts, callback) => {
          execCalls.push([command, args]);
          setImmediate(() => callback(null, ''));
        },
      },
      os: { userInfo: () => ({ username: 'tester' }) },
      '../Logger': loggerStub,
    }
  );

  // The shim is compiled at most once per host (it is the request's prelude,
  // which the host sends once per powershell.exe), and hung detection uses the
  // window manager's verdict rather than .Responding's 5-second probe.
  assert.match(WINDOWS_WINDOW_PRELUDE.Script, /Add-Type/);
  assert.doesNotMatch(WINDOWS_HOST_QUERY, /Add-Type/);
  assert.match(WINDOWS_HOST_QUERY, /\[ShowTrak\.ApplicationWindows\]::Query\(\)/);
  assert.doesNotMatch(WINDOWS_HOST_QUERY, /\.Responding\b/);
  assert.doesNotMatch(WINDOWS_HOST_QUERY, /\n/, 'the host evaluates one line per request');
  assert.doesNotMatch(WINDOWS_WINDOW_PRELUDE.Script, /\n/);

  const pending = collectWindowsApplications();
  assert.equal(spawned.length, 1);
  spawned[0].respond(
    JSON.stringify({
      Processes: [{ Name: 'QLab', Responding: false }],
      Foreground: 'explorer',
      Shim: true,
    })
  );
  const [err, sample] = await pending;
  assert.equal(err, null);
  assert.equal(sample.Foreground, 'explorer');
  assert.deepEqual(sample.Processes, [{ Name: 'QLab', Responding: false }]);
  assert.equal(execCalls.length, 0, 'no process is spawned per sample');
  assert.match(spawned[0].writes[1], /Add-Type/, 'the first request carries the shim compile');

  // The second sample is the method call alone: the shim is not sent again.
  const second = collectWindowsApplications();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned.length, 1, 'the same host answers');
  assert.doesNotMatch(spawned[0].writes[2], /Add-Type/);
  spawned[0].respond(JSON.stringify({ Processes: [], Foreground: null, Shim: true }));
  assert.equal((await second)[0], null);
});

test('Windows sampler falls back to one-shot names when the host answers with garbage', async () => {
  const spawned = [];
  const execCalls = [];
  const { collectWindowsApplications } = loadWithMocks(SAMPLERS_PATH, {
    child_process: {
      spawn: () => {
        const child = createFakeChild();
        spawned.push(child);
        return child;
      },
      execFile: (command, args, _opts, callback) => {
        execCalls.push([command, args]);
        setImmediate(() => callback(null, 'QLab\r\n'));
      },
    },
    os: { userInfo: () => ({ username: 'tester' }) },
    '../Logger': loggerStub,
  });
  const pending = collectWindowsApplications();
  spawned[0].respond('this is not json');
  const [err, sample] = await pending;
  assert.equal(err, null);
  assert.deepEqual(sample.Processes, [{ Name: 'QLab' }]);
  assert.deepEqual(sample.Capabilities, { Responding: false, Foreground: false });
  assert.equal(execCalls.length, 1);
});

test('macOS sampler names the frontmost application through the same name cache', async () => {
  const { collectMacApplications, calls } = loadSamplers({
    execFile: (command, args) => {
      if (args[0] === 'visibleProcessList') return [null, VISIBLE_LIST];
      if (args[0] === 'front') return [null, 'ASN:0x0-0x654b545:\n'];
      const asn = args[args.length - 1];
      if (asn.endsWith('654b545')) return [null, '"LSDisplayName"="GitHub Desktop"'];
      return [null, '"LSDisplayName"="Other"'];
    },
  });
  const [err, sample] = await collectMacApplications();
  assert.equal(err, null);
  // The display name, not the underscored listing name, so it matches its entry.
  assert.equal(sample.Foreground, 'GitHub Desktop');
  assert.deepEqual(sample.Capabilities, { Responding: false, Foreground: true });
  assert.equal(
    sample.Processes.some((p) => 'Responding' in p),
    false,
    'macOS has no public hung-application API, so Responding is never sent'
  );
  const lookups = calls.filter(
    ([, args]) => args[0] === 'info' && args.includes('ASN:0x0-0x654b545')
  );
  assert.equal(lookups.length, 1, 'the frontmost application is not looked up twice');
});

test('macOS sampler: nothing in front is null; a failing front query is "cannot tell"', async () => {
  const nothing = loadSamplers({
    execFile: (command, args) =>
      args[0] === 'visibleProcessList'
        ? [null, VISIBLE_LIST]
        : args[0] === 'front'
          ? [null, '[ NULL ]\n']
          : [null, '"LSDisplayName"="Resolved"'],
  });
  const [, front] = await nothing.collectMacApplications();
  assert.equal(front.Foreground, null);
  assert.equal(front.Capabilities.Foreground, true);

  const failing = loadSamplers({
    execFile: (command, args) =>
      args[0] === 'visibleProcessList'
        ? [null, VISIBLE_LIST]
        : args[0] === 'front'
          ? [new Error('lsappinfo front failed'), '']
          : [null, '"LSDisplayName"="Resolved"'],
  });
  const [err, sample] = await failing.collectMacApplications();
  assert.equal(err, null, 'the application list does not depend on the focus query');
  assert.equal(sample.Processes.length, 3);
  assert.equal(sample.Capabilities.Foreground, false);
  assert.equal('Foreground' in sample, false);
});

function loadLinuxSamplers({ execFile, comm = {}, xdotool = '/usr/bin/xdotool' } = {}) {
  const calls = [];
  const lookups = [];
  const module = loadWithMocks(SAMPLERS_PATH, {
    child_process: {
      execFile: (command, args, _opts, callback) => {
        calls.push([command, args]);
        const result = execFile(command, args);
        setImmediate(() => callback(result[0], result[1]));
      },
    },
    'fs/promises': {
      readFile: async (file) => {
        if (file in comm) return comm[file];
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
    },
    os: { userInfo: () => ({ username: 'tester' }) },
    '../Utils': {
      FindOnPath: (command) => {
        lookups.push(command);
        return command === 'xdotool' ? xdotool : null;
      },
    },
    '../Logger': loggerStub,
  });
  return { ...module, calls, lookups };
}

test('Linux sampler reads the focused window through xdotool and /proc/<pid>/comm', async () => {
  const restoreEnv = withEnv({
    DISPLAY: ':0',
    WAYLAND_DISPLAY: undefined,
    XDG_SESSION_TYPE: 'x11',
  });
  try {
    const H = loadLinuxSamplers({
      execFile: (command) => (command === 'ps' ? [null, 'firefox\nmpv\n'] : [null, '4242\n']),
      comm: { '/proc/4242/comm': 'mpv\n' },
    });
    const [err, sample] = await H.collectLinuxApplications();
    assert.equal(err, null);
    // comm is exactly what `ps -o comm=` lists, so it matches the entry.
    assert.equal(sample.Foreground, 'mpv');
    assert.deepEqual(sample.Capabilities, { Responding: false, Foreground: true });
    assert.deepEqual(
      H.calls.find(([command]) => command === '/usr/bin/xdotool'),
      ['/usr/bin/xdotool', ['getactivewindow', 'getwindowpid']]
    );

    await H.collectLinuxApplications();
    assert.deepEqual(H.lookups, ['xdotool'], 'PATH is searched once, not per sample');
  } finally {
    restoreEnv();
  }
});

test('Linux sampler reports focus as unavailable without xdotool, on Wayland, or with no display', async () => {
  const cases = [
    ['no xdotool', { DISPLAY: ':0', WAYLAND_DISPLAY: undefined, XDG_SESSION_TYPE: 'x11' }, null],
    [
      'Wayland',
      { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' },
      '/usr/bin/xdotool',
    ],
    [
      'no display',
      { DISPLAY: undefined, WAYLAND_DISPLAY: undefined, XDG_SESSION_TYPE: undefined },
      '/usr/bin/xdotool',
    ],
  ];
  for (const [label, env, xdotool] of cases) {
    const restoreEnv = withEnv(env);
    try {
      const H = loadLinuxSamplers({ execFile: () => [null, 'firefox\n'], xdotool });
      const [err, sample] = await H.collectLinuxApplications();
      assert.equal(err, null, label);
      assert.equal(sample.Capabilities.Foreground, false, label);
      assert.equal('Foreground' in sample, false, label);
      assert.equal(
        H.calls.some(([command]) => command.includes('xdotool')),
        false,
        `${label}: xdotool is never run`
      );
    } finally {
      restoreEnv();
    }
  }
});

test('Linux sampler: an unreachable X server stops focus queries; a window with no pid is null', async () => {
  const restoreEnv = withEnv({
    DISPLAY: ':0',
    WAYLAND_DISPLAY: undefined,
    XDG_SESSION_TYPE: 'x11',
  });
  try {
    const noPid = loadLinuxSamplers({
      execFile: (command) =>
        command === 'ps' ? [null, 'firefox\n'] : [new Error('Command failed: xdotool\n'), ''],
    });
    const [, sample] = await noPid.collectLinuxApplications();
    assert.equal(sample.Foreground, null);
    assert.equal(sample.Capabilities.Foreground, true);

    const noDisplay = loadLinuxSamplers({
      execFile: (command) =>
        command === 'ps'
          ? [null, 'firefox\n']
          : [new Error("Command failed: xdotool\nCan't open display: (null)"), ''],
    });
    const [, first] = await noDisplay.collectLinuxApplications();
    assert.equal(first.Capabilities.Foreground, false);
    await noDisplay.collectLinuxApplications();
    assert.equal(
      noDisplay.calls.filter(([command]) => command.includes('xdotool')).length,
      1,
      'a session that cannot reach X is not asked again every three seconds'
    );
  } finally {
    restoreEnv();
  }
});

test('Windows host sample: PowerShell 5.1 wrapped-array JSON is still a list', () => {
  const { ParseWindowsApplications } = loadSamplers();
  const sample = ParseWindowsApplications(
    JSON.stringify({
      Processes: {
        value: [
          { Name: 'QLab', Responding: true },
          { Name: 'mpv', Responding: false },
        ],
        Count: 2,
      },
      Foreground: 'mpv',
      Shim: true,
    })
  );
  assert.deepEqual(
    sample.Processes.map((p) => p.Name),
    ['QLab', 'mpv']
  );
});
