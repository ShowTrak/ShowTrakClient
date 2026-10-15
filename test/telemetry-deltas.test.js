const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// Incremental telemetry on the client side.
//
// The full-list events remain the authority — sent on connect and on a 60s
// resync, and applied by the server as a REPLACE. A delta only describes the
// step between two samples, so the rules that matter are:
//
//   1. deltas are only sent to a server that said it understands them;
//   2. a resync always sends the full list, never a delta;
//   3. an older server keeps getting exactly what it got before.
//
// Rule 3 is the one worth guarding hardest: client and server are versioned and
// updated independently with no minimum-version gate, so a new client talking to
// an old server is a normal deployment, not an edge case. Getting it wrong would
// silently stretch detection latency out to the resync interval.

function waitTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

const UTILS_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'Utils', 'index.js');
const CAPABILITIES_PATH = path.join(
  __dirname,
  '..',
  'dist',
  'Modules',
  'ServerCapabilities',
  'index.js'
);

// --- DiffByKey -------------------------------------------------------------

test('DiffByKey separates additions, removals and changes', () => {
  const { DiffByKey } = require(UTILS_PATH);
  const diff = DiffByKey(
    [
      { id: 'a', v: 1 },
      { id: 'b', v: 1 },
      { id: 'c', v: 1 },
    ],
    [
      { id: 'a', v: 1 },
      { id: 'b', v: 2 },
      { id: 'd', v: 1 },
    ],
    (item) => item.id,
    (item) => String(item.v)
  );
  assert.deepEqual(
    diff.Added.map((i) => i.id),
    ['d']
  );
  assert.deepEqual(diff.Removed, ['c']);
  assert.deepEqual(
    diff.Changed.map((i) => i.id),
    ['b'],
    'an entry present in both is a change only when its signature moved'
  );
});

test('DiffByKey ignores entries with no usable key', () => {
  const { DiffByKey, IsEmptyDiff } = require(UTILS_PATH);
  // Such an entry can be neither tracked across snapshots nor named in a
  // removal list, so reporting it would produce a delta the server cannot apply.
  const diff = DiffByKey([{ id: null }], [{ id: null }], (item) => item.id, String);
  assert.equal(IsEmptyDiff(diff), true);
});

test('DiffByKey treats a duplicate key within one snapshot as a single entry', () => {
  const { DiffByKey } = require(UTILS_PATH);
  const diff = DiffByKey(
    [],
    [
      { id: 'a', v: 1 },
      { id: 'a', v: 2 },
    ],
    (item) => item.id,
    (item) => String(item.v)
  );
  assert.equal(diff.Added.length, 1);
});

// --- ServerCapabilities ----------------------------------------------------

test('deltas stay off until a server actually answers the probe', () => {
  const { Manager } = loadWithMocks(CAPABILITIES_PATH, {
    '../Logger': { CreateLogger: () => createSilentLogger() },
  });
  assert.equal(Manager.SupportsDeltas(), false, 'the safe default is full lists');

  // An older server has no handler for this event, so the acknowledgement is
  // simply never invoked. The absence of a reply IS the answer — which is why
  // there is no timeout that would eventually assume support.
  Manager.Probe({ emit: () => {} });
  assert.equal(Manager.SupportsDeltas(), false);

  Manager.Probe({
    emit: (_event, callback) => callback({ Deltas: true }),
  });
  assert.equal(Manager.SupportsDeltas(), true);

  Manager.Reset();
  assert.equal(Manager.SupportsDeltas(), false, 'a dropped connection resets to the default');
});

test('a server answering without delta support keeps the client on full lists', () => {
  const { Manager } = loadWithMocks(CAPABILITIES_PATH, {
    '../Logger': { CreateLogger: () => createSilentLogger() },
  });
  Manager.Probe({ emit: (_event, callback) => callback({ Deltas: false }) });
  assert.equal(Manager.SupportsDeltas(), false);
});

test('a probe against a socket that throws does not take the monitor down', () => {
  const { Manager } = loadWithMocks(CAPABILITIES_PATH, {
    '../Logger': { CreateLogger: () => createSilentLogger() },
  });
  Manager.Probe({
    emit: () => {
      throw new Error('socket closed mid-probe');
    },
  });
  assert.equal(Manager.SupportsDeltas(), false);
});

// --- NetworkMonitor --------------------------------------------------------

function loadNetworkMonitor({ deltas, snapshots }) {
  const emissions = [];
  const socket = { connected: true, emit: (event, payload) => emissions.push([event, payload]) };
  let index = 0;
  let intervalHandle = null;

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalNow = Date.now;
  let now = 9_000_000;
  Date.now = () => now;
  global.setInterval = (callback) => {
    intervalHandle = { callback };
    return intervalHandle;
  };
  global.clearInterval = () => {
    intervalHandle = null;
  };

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'NetworkMonitor', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    // Routes are covered by network-gateways.test.js; never shell out here.
    './gateways': { ReadGateways: async () => [new Error('not read in tests'), null] },
    '../Logger': { CreateLogger: () => createSilentLogger() },
    '../ServerCapabilities': { Manager: { SupportsDeltas: () => deltas } },
    '../OS': {
      Manager: {
        GetNetworkInterfaces: async () => [
          null,
          snapshots[Math.min(index++, snapshots.length - 1)],
        ],
      },
    },
  });

  return {
    Manager,
    socket,
    emissions,
    tick: async () => {
      intervalHandle.callback();
      await waitTick();
    },
    advance: (ms) => {
      now += ms;
    },
    restore: () => {
      Date.now = originalNow;
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    },
  };
}

const WIFI = {
  name: 'en0',
  addresses: [{ family: 'IPv4', address: '10.0.0.5', mac: 'aa:bb', internal: false }],
};
const VPN = {
  name: 'utun0',
  addresses: [{ family: 'IPv4', address: '10.8.0.2', mac: null, internal: false }],
};

test('a network change is reported as a delta when the server supports it', async () => {
  const H = loadNetworkMonitor({ deltas: true, snapshots: [[WIFI], [WIFI, VPN]] });
  try {
    await H.Manager.Start(H.socket);
    // The first report is always the full list: it establishes the baseline the
    // server replaces its state from.
    assert.equal(H.emissions[0][0], 'NetworkInterfaces');

    H.advance(1000);
    await H.tick();
    assert.equal(H.emissions.length, 2);
    const [event, delta] = H.emissions[1];
    assert.equal(event, 'NetworkInterfaceDelta');
    assert.equal(delta.Added.length, 1);
    assert.equal(delta.Added[0].name, 'utun0');
    assert.deepEqual(delta.Removed, []);
    assert.deepEqual(delta.Changed, []);

    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('an interface disappearing is reported by name', async () => {
  const H = loadNetworkMonitor({ deltas: true, snapshots: [[WIFI, VPN], [WIFI]] });
  try {
    await H.Manager.Start(H.socket);
    H.advance(1000);
    await H.tick();
    const [, delta] = H.emissions[1];
    assert.deepEqual(delta.Removed, ['utun0']);
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('an address change on a surviving interface is a change, not add plus remove', async () => {
  const moved = {
    name: 'en0',
    addresses: [{ family: 'IPv4', address: '10.0.0.99', mac: 'aa:bb', internal: false }],
  };
  const H = loadNetworkMonitor({ deltas: true, snapshots: [[WIFI], [moved]] });
  try {
    await H.Manager.Start(H.socket);
    H.advance(1000);
    await H.tick();
    const [, delta] = H.emissions[1];
    assert.deepEqual(delta.Added, []);
    assert.deepEqual(delta.Removed, []);
    assert.equal(delta.Changed.length, 1);
    assert.equal(delta.Changed[0].addresses[0].address, '10.0.0.99');
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('an older server still receives a full list on every change', async () => {
  const H = loadNetworkMonitor({ deltas: false, snapshots: [[WIFI], [WIFI, VPN]] });
  try {
    await H.Manager.Start(H.socket);
    H.advance(1000);
    await H.tick();
    // Exactly the behaviour that shipped before deltas existed.
    assert.deepEqual(
      H.emissions.map(([event]) => event),
      ['NetworkInterfaces', 'NetworkInterfaces']
    );
    assert.equal(H.emissions[1][1].length, 2);
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('the periodic resync sends the full list even with deltas enabled', async () => {
  const H = loadNetworkMonitor({ deltas: true, snapshots: [[WIFI]] });
  try {
    await H.Manager.Start(H.socket);
    H.advance(61_000);
    await H.tick();
    // A delta cannot correct a server whose state has drifted, because it only
    // describes a step. The resync is the only thing that can, so it must never
    // be downgraded to one.
    assert.equal(H.emissions.length, 2);
    assert.equal(H.emissions[1][0], 'NetworkInterfaces');
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

// --- ProcessMonitor --------------------------------------------------------

function loadProcessMonitor({ deltas }) {
  const emissions = [];
  const socket = { connected: true, emit: (event, payload) => emissions.push([event, payload]) };
  const names = (list) => ({
    Processes: list.map((Name) => ({ Name })),
    Capabilities: { Responding: false, Foreground: false },
  });
  let sample = [null, names(['Safari', 'Code'])];
  let intervalHandle = null;

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalNow = Date.now;
  let now = 4_000_000;
  Date.now = () => now;
  global.setInterval = (callback) => {
    intervalHandle = { callback };
    return intervalHandle;
  };
  global.clearInterval = () => {
    intervalHandle = null;
  };

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'ProcessMonitor', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    './samplers': {
      collectRunningApplications: async () => sample,
      disposeSamplers: () => {},
    },
    '../Logger': { CreateLogger: () => createSilentLogger() },
    '../ServerCapabilities': { Manager: { SupportsDeltas: () => deltas } },
    '../Broadcast': { Manager: { emit: () => {} } },
  });

  return {
    Manager,
    socket,
    emissions,
    setSample: (next) => {
      sample = [null, names(next)];
    },
    // A full sample: processes with their Responding verdicts, the focus, and
    // what the platform says it can report.
    setRichSample: (next) => {
      sample = [null, next];
    },
    setError: (error) => {
      sample = [error, null];
    },
    tick: async () => {
      intervalHandle.callback();
      await waitTick();
    },
    advance: (ms) => {
      now += ms;
    },
    restore: () => {
      Date.now = originalNow;
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    },
  };
}

test('an application starting is reported as a delta', async () => {
  const H = loadProcessMonitor({ deltas: true });
  try {
    await H.Manager.Start(H.socket);
    assert.equal(H.emissions[0][0], 'RunningApplications');

    H.setSample(['Safari', 'Code', 'QLab']);
    H.advance(3000);
    await H.tick();

    const [event, delta] = H.emissions[1];
    assert.equal(event, 'ApplicationDelta');
    assert.deepEqual(
      delta.Started.map((i) => i.Name),
      ['QLab']
    );
    assert.deepEqual(delta.Stopped, []);
    // The counters travel with the delta: the server reports them directly and
    // cannot recompute them from a partial list.
    assert.equal(delta.TotalCount, 3);
    assert.equal(delta.Truncated, false);
    assert.equal(delta.Status.State, 'ok');

    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('an application quitting is reported by name', async () => {
  const H = loadProcessMonitor({ deltas: true });
  try {
    await H.Manager.Start(H.socket);
    H.setSample(['Safari']);
    H.advance(3000);
    await H.tick();
    const [, delta] = H.emissions[1];
    // Matched case-insensitively against the server's stored key.
    assert.deepEqual(delta.Stopped, ['code']);
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('a second instance of a running application is a count change', async () => {
  const H = loadProcessMonitor({ deltas: true });
  try {
    await H.Manager.Start(H.socket);
    H.setSample(['Safari', 'Safari', 'Code']);
    H.advance(3000);
    await H.tick();
    const [, delta] = H.emissions[1];
    assert.deepEqual(delta.Started, []);
    assert.deepEqual(delta.Stopped, []);
    assert.deepEqual(
      delta.Changed.map((i) => [i.Name, i.Count]),
      [['Safari', 2]]
    );
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('an older server still receives full application snapshots', async () => {
  const H = loadProcessMonitor({ deltas: false });
  try {
    await H.Manager.Start(H.socket);
    H.setSample(['Safari', 'Code', 'QLab']);
    H.advance(3000);
    await H.tick();
    assert.deepEqual(
      H.emissions.map(([event]) => event),
      ['RunningApplications', 'RunningApplications']
    );
    assert.equal(H.emissions[1][1].Items.length, 3);
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('the application resync sends a full snapshot, not a delta', async () => {
  const H = loadProcessMonitor({ deltas: true });
  try {
    await H.Manager.Start(H.socket);
    H.advance(61_000);
    await H.tick();
    assert.equal(H.emissions[H.emissions.length - 1][0], 'RunningApplications');
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('a collection failure is always reported in full, never as a delta', async () => {
  const H = loadProcessMonitor({ deltas: true });
  try {
    await H.Manager.Start(H.socket);
    H.setError(new Error('Not authorized -1743'));
    H.advance(3000);
    await H.tick();

    const [event, payload] = H.emissions[H.emissions.length - 1];
    // A delta describing "everything stopped" would be indistinguishable from a
    // machine where everything really did stop. The failure has to arrive as a
    // snapshot carrying the status that explains it.
    assert.equal(event, 'RunningApplications');
    assert.deepEqual(payload.Items, []);
    assert.equal(payload.Status.State, 'permission_denied');
    assert.equal(H.Manager.GetStatus().State, 'permission_denied');

    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

// --- Hung applications and the focused application -------------------------

const FULL_CAPABILITIES = { Responding: true, Foreground: true };

function richSample(processes, foreground, capabilities = FULL_CAPABILITIES) {
  return {
    Processes: processes,
    ...(capabilities.Foreground ? { Foreground: foreground } : {}),
    Capabilities: capabilities,
  };
}

test('an application going unresponsive is a Changed entry in a delta', async () => {
  const H = loadProcessMonitor({ deltas: true });
  try {
    H.setRichSample(
      richSample(
        [
          { Name: 'QLab', Responding: true },
          { Name: 'Code', Responding: true },
        ],
        'QLab'
      )
    );
    await H.Manager.Start(H.socket);
    const [, first] = H.emissions[0];
    assert.deepEqual(first.Capabilities, FULL_CAPABILITIES);
    assert.equal(first.Foreground, 'QLab');
    assert.equal(first.Items.find((i) => i.Name === 'QLab').Responding, true);

    H.setRichSample(
      richSample(
        [
          { Name: 'QLab', Responding: false },
          { Name: 'Code', Responding: true },
        ],
        'QLab'
      )
    );
    H.advance(3000);
    await H.tick();
    const [event, delta] = H.emissions[1];
    assert.equal(event, 'ApplicationDelta');
    assert.deepEqual(delta.Changed, [{ Name: 'QLab', Count: 1, Responding: false }]);
    assert.deepEqual(delta.Started, []);
    assert.equal(delta.Foreground, 'QLab');
    assert.deepEqual(delta.Capabilities, FULL_CAPABILITIES);
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('one hung instance marks the whole application as not responding', async () => {
  const H = loadProcessMonitor({ deltas: true });
  try {
    H.setRichSample(
      richSample(
        [
          { Name: 'chrome', Responding: true },
          { Name: 'chrome', Responding: false },
          { Name: 'chrome', Responding: null },
          { Name: 'mpv', Responding: true },
          { Name: 'mpv', Responding: null },
        ],
        null
      )
    );
    await H.Manager.Start(H.socket);
    const items = H.emissions[0][1].Items;
    assert.deepEqual(
      items.find((i) => i.Name === 'chrome'),
      {
        Name: 'chrome',
        Count: 3,
        Responding: false,
      }
    );
    // None hung, one unreadable: unknown, not "fine".
    assert.equal(items.find((i) => i.Name === 'mpv').Responding, null);
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('a focus change alone is reported at once, as an empty delta carrying the new Foreground', async () => {
  const H = loadProcessMonitor({ deltas: true });
  try {
    const processes = [
      { Name: 'QLab', Responding: true },
      { Name: 'Code', Responding: true },
    ];
    H.setRichSample(richSample(processes, 'QLab'));
    await H.Manager.Start(H.socket);

    H.setRichSample(richSample(processes, 'code'));
    H.advance(3000);
    await H.tick();
    assert.equal(H.emissions.length, 2, 'not held back until the keepalive');
    const [event, delta] = H.emissions[1];
    assert.equal(event, 'ApplicationDelta');
    assert.deepEqual([delta.Started, delta.Stopped, delta.Changed], [[], [], []]);
    // Spelled as its Items entry, so the server can match the two directly.
    assert.equal(delta.Foreground, 'Code');

    // And nothing more while nothing changes.
    H.advance(3000);
    await H.tick();
    assert.equal(H.emissions.length, 2);
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('a focus change reaches an older server as a full snapshot', async () => {
  const H = loadProcessMonitor({ deltas: false });
  try {
    const processes = [{ Name: 'QLab', Responding: true }];
    H.setRichSample(richSample(processes, 'QLab'));
    await H.Manager.Start(H.socket);
    H.setRichSample(richSample(processes, null));
    H.advance(3000);
    await H.tick();
    const [event, snapshot] = H.emissions[1];
    assert.equal(event, 'RunningApplications');
    assert.equal(snapshot.Foreground, null);
    assert.equal(snapshot.Items.length, 1);
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('a filtered application in front is still named; the keepalive carries focus too', async () => {
  const H = loadProcessMonitor({ deltas: true });
  try {
    H.setRichSample(
      richSample(
        [
          { Name: 'QLab', Responding: true },
          { Name: 'explorer', Responding: true },
        ],
        'explorer'
      )
    );
    await H.Manager.Start(H.socket);
    const [, first] = H.emissions[0];
    assert.deepEqual(
      first.Items.map((i) => i.Name),
      ['QLab'],
      'explorer stays out of the application list'
    );
    // ...but it really does hold the focus, which is what an operator asking
    // "is the show app in front?" needs to hear.
    assert.equal(first.Foreground, 'explorer');

    H.advance(20_000);
    await H.tick();
    const [, keepalive] = H.emissions[1];
    assert.equal(keepalive.NoChanges, true);
    assert.equal(keepalive.Foreground, 'explorer');
    assert.deepEqual(keepalive.Capabilities, FULL_CAPABILITIES);
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('a platform without hung or focus detection sends neither field, and says so', async () => {
  const H = loadProcessMonitor({ deltas: true });
  try {
    await H.Manager.Start(H.socket);
    const [, snapshot] = H.emissions[0];
    assert.deepEqual(snapshot.Capabilities, { Responding: false, Foreground: false });
    assert.equal('Foreground' in snapshot, false);
    assert.equal(
      snapshot.Items.some((i) => 'Responding' in i),
      false
    );
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});

test('losing focus detection mid-session is reported as a capability change', async () => {
  const H = loadProcessMonitor({ deltas: true });
  try {
    const processes = [{ Name: 'QLab', Responding: true }];
    H.setRichSample(richSample(processes, 'QLab'));
    await H.Manager.Start(H.socket);
    H.setRichSample(
      richSample([{ Name: 'QLab' }], undefined, { Responding: false, Foreground: false })
    );
    H.advance(3000);
    await H.tick();
    const [event, payload] = H.emissions[1];
    assert.equal(event, 'ApplicationDelta');
    assert.deepEqual(payload.Capabilities, { Responding: false, Foreground: false });
    assert.equal('Foreground' in payload, false);
    // The item lost its Responding field, which is itself a change.
    assert.deepEqual(payload.Changed, [{ Name: 'QLab', Count: 1 }]);
    await H.Manager.Stop();
  } finally {
    H.restore();
  }
});
