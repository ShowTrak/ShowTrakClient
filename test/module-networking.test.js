const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

function waitTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('OS manager returns vitals, mac addresses, and interfaces', async () => {
  const originalSetInterval = global.setInterval;
  global.setInterval = () => ({ id: 'cpu' });

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'OS', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    os: {
      hostname: () => 'unit-host',
      totalmem: () => 100,
      freemem: () => 30,
      uptime: () => 3661,
      cpus: () => [{ times: { user: 1, nice: 1, sys: 1, idle: 7, irq: 0 } }],
      networkInterfaces: () => ({
        lo0: [
          {
            family: 'IPv4',
            address: '127.0.0.1',
            netmask: '255.0.0.0',
            cidr: '127.0.0.1/8',
            mac: '00',
            internal: true,
          },
        ],
      }),
    },
    macaddress: {
      all: () => Promise.resolve({ en0: 'aa:bb:cc:dd:ee:ff' }),
    },
  });

  try {
    const vitals = await Manager.GetVitals();
    assert.equal(vitals.Ram.Total, 100);
    assert.equal(vitals.Ram.Used, 70);
    assert.equal(vitals.Uptime.Formatted, '01:01:01');

    const [macErr, macs] = await Manager.GetMacAddresses();
    assert.equal(macErr, null);
    assert.equal(macs.en0, 'aa:bb:cc:dd:ee:ff');

    const [ifaceErr, interfaces] = await Manager.GetNetworkInterfaces();
    assert.equal(ifaceErr, null);
    assert.equal(Array.isArray(interfaces), true);
    assert.equal(interfaces[0].name, 'lo0');
  } finally {
    global.setInterval = originalSetInterval;
  }
});

test('NetworkMonitor emits only on interface changes and stops cleanly', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;

  let intervalHandle = null;
  global.setInterval = (callback) => {
    intervalHandle = { callback };
    return intervalHandle;
  };
  global.clearInterval = (handle) => {
    if (handle === intervalHandle) intervalHandle = null;
  };

  const emissions = [];
  const socket = {
    connected: true,
    emit: (event, payload) => emissions.push([event, payload]),
  };

  const interfaceSnapshots = [
    [
      {
        name: 'en0',
        addresses: [{ family: 'IPv4', address: '10.0.0.2', mac: 'aa:bb', internal: false }],
      },
    ],
    [
      {
        name: 'en0',
        addresses: [{ family: 'IPv4', address: '10.0.0.2', mac: 'aa:bb', internal: false }],
      },
    ],
    [
      {
        name: 'en0',
        addresses: [{ family: 'IPv4', address: '10.0.0.3', mac: 'aa:bb', internal: false }],
      },
    ],
  ];

  let idx = 0;
  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'NetworkMonitor', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => createSilentLogger(),
    },
    '../OS': {
      Manager: {
        GetNetworkInterfaces: async () => [
          null,
          interfaceSnapshots[Math.min(idx++, interfaceSnapshots.length - 1)],
        ],
      },
    },
  });

  try {
    await Manager.Start(socket);
    assert.equal(emissions.length, 1);

    intervalHandle.callback();
    await waitTick();
    assert.equal(emissions.length, 1);

    intervalHandle.callback();
    await waitTick();
    assert.equal(emissions.length, 2);

    await Manager.Stop();
    assert.equal(intervalHandle, null);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

test('NetworkMonitor resends the full list periodically even when nothing changed', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalNow = Date.now;

  let intervalHandle = null;
  global.setInterval = (callback, ms) => {
    intervalHandle = { callback, ms };
    return intervalHandle;
  };
  global.clearInterval = () => {
    intervalHandle = null;
  };
  let now = 5_000_000;
  Date.now = () => now;

  const emissions = [];
  const socket = { connected: true, emit: (event, payload) => emissions.push([event, payload]) };
  const iface = [{ name: 'en0', addresses: [] }];

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'NetworkMonitor', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': { CreateLogger: () => createSilentLogger() },
    '../OS': { Manager: { GetNetworkInterfaces: async () => [null, iface] } },
  });

  try {
    await Manager.Start(socket);
    assert.equal(emissions.length, 1);
    // os.networkInterfaces() measures at 0.03ms, which is what makes a
    // one-second poll the cheapest real-time signal the client has.
    assert.equal(intervalHandle.ms, 1000);

    now += 30_000;
    intervalHandle.callback();
    await waitTick();
    assert.equal(emissions.length, 1, 'an unchanged list is not resent early');

    // A rig whose NICs never change would otherwise never speak again, leaving a
    // restarted server with nothing.
    now += 31_000;
    intervalHandle.callback();
    await waitTick();
    assert.equal(emissions.length, 2, 'the full list is resent once the resync is due');
    assert.equal(emissions[1][0], 'NetworkInterfaces');
    assert.equal(emissions[1][1][0].name, 'en0');

    await Manager.Stop();
  } finally {
    Date.now = originalNow;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

// ProcessMonitor's cadence rules, exercised through a stubbed sampler.
//
// The platform samplers live in ./samplers.js and are stubbed here on purpose:
// what this test is about is WHEN the monitor emits, and that must not depend on
// which OS the suite happens to run on. Driving it through the real samplers
// would make the assertions mean something different on each CI platform — the
// macOS path shells out to lsappinfo, Windows to a PowerShell host, Linux to ps.
// Sampler behaviour is covered separately in process-monitor-samplers.test.js.
test('ProcessMonitor emits on change, stays quiet otherwise, and reports errors', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const originalNow = Date.now;

  let intervalHandle = null;
  global.setInterval = (callback) => {
    intervalHandle = { callback };
    return intervalHandle;
  };
  global.clearInterval = (handle) => {
    if (handle === intervalHandle) intervalHandle = null;
  };

  // Simulated clock, so the keepalive and resync deadlines can be crossed
  // deliberately rather than by making the test wait a real minute.
  let now = 1_000_000;
  Date.now = () => now;

  const statusEvents = [];
  const socketEmits = [];
  const socket = {
    connected: true,
    emit: (event, payload) => socketEmits.push([event, payload]),
  };

  // What the stubbed sampler returns next. Reassigned by the test to simulate an
  // application starting, or the collection failing outright.
  let sample = [null, ['Safari', 'Code']];

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'ProcessMonitor', 'index.js');
  const { Manager, _constants } = loadWithMocks(modulePath, {
    './samplers': {
      collectRunningApplications: async () => sample,
      disposeSamplers: () => {},
    },
    '../Logger': {
      CreateLogger: () => createSilentLogger(),
    },
    '../Broadcast': {
      Manager: {
        emit: (event, payload) => {
          statusEvents.push([event, payload]);
        },
      },
    },
  });

  // Deadlines are read from the module so this test cannot drift out of step
  // with the cadence it is asserting.
  const KEEPALIVE_MS = _constants.KEEPALIVE_INTERVAL_MS;
  const FULL_RESYNC_MS = _constants.FULL_RESYNC_INTERVAL_MS;

  const tick = async () => {
    intervalHandle.callback();
    await waitTick();
  };

  try {
    await Manager.Start(socket);
    assert.equal(socketEmits[0][0], 'RunningApplications');
    assert.equal(socketEmits[0][1].Items.length > 0, true);

    // Unchanged, and no deadline due: the monitor says nothing. This is the
    // whole point of sampling every 3 seconds instead of every 20 — the sample
    // is cheap, but the traffic would not be.
    now += 3000;
    await tick();
    assert.equal(socketEmits.length, 1, 'an unchanged sample must not emit');

    // Past the keepalive deadline: report in without item payload, so the
    // server keeps appending monitoring-history points.
    now += KEEPALIVE_MS;
    await tick();
    assert.equal(socketEmits.length, 2);
    assert.equal(socketEmits[1][1].NoChanges, true);
    assert.deepEqual(socketEmits[1][1].Items, []);

    // A change is reported immediately, with the full list.
    sample = [null, ['Safari', 'Code', 'Notion']];
    now += 3000;
    await tick();
    assert.equal(socketEmits.length, 3);
    assert.equal(socketEmits[2][1].NoChanges, undefined);
    assert.equal(socketEmits[2][1].Items.length, 3);

    // Nothing changes for a full minute: the resync sends the whole list again
    // so a server that missed an emit converges.
    now += FULL_RESYNC_MS;
    await tick();
    assert.equal(socketEmits.length, 4);
    assert.equal(socketEmits[3][1].NoChanges, undefined);
    assert.equal(socketEmits[3][1].Items.length, 3, 'a resync carries the full list');

    // A collection failure is always reported, and classified.
    sample = [new Error('Not authorized -1743'), null];
    now += 3000;
    await tick();
    const status = Manager.GetStatus();
    assert.equal(status.State, 'permission_denied');
    assert.equal(
      statusEvents.some(([event]) => event === 'ProcessMonitorStatus'),
      true
    );

    await Manager.Stop();
    assert.equal(intervalHandle, null);
    assert.equal(Manager.GetStatus().State, 'unknown');
  } finally {
    Date.now = originalNow;
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

test('Bonjour manager discovers service and can stop/terminate', async () => {
  const originalSetInterval = global.setInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearInterval = global.clearInterval;
  const originalClearTimeout = global.clearTimeout;

  global.setInterval = (_cb) => ({ id: 'interval' });
  global.setTimeout = (_cb) => ({ id: 'timeout' });
  global.clearInterval = () => {};
  global.clearTimeout = () => {};

  let findOneCallback = null;
  let destroyed = 0;

  function createBrowser() {
    const listeners = new Map();
    return {
      services: [],
      on: (event, handler) => listeners.set(event, handler),
      start: () => {},
      update: () => {},
      stop: () => {},
      removeAllListeners: () => listeners.clear(),
    };
  }

  const bonjourFactory = () => ({
    find: () => createBrowser(),
    findOne: (_opts, callback) => {
      findOneCallback = callback;
      return createBrowser();
    },
    destroy: () => {
      destroyed += 1;
    },
  });

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'Bonjour', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => createSilentLogger(),
    },
    bonjour: bonjourFactory,
    os: {
      networkInterfaces: () => ({
        en0: [{ family: 'IPv4', address: '10.0.0.2', internal: false }],
      }),
    },
  });

  let discovered = null;
  try {
    Manager.OnFind((service) => {
      discovered = service;
    });

    const service = { host: 'server.local', port: 3000 };
    findOneCallback(service);
    assert.deepEqual(discovered, service);

    await Manager.Stop();
    await Manager.Terminate();
    assert.equal(destroyed >= 1, true);
  } finally {
    global.setInterval = originalSetInterval;
    global.setTimeout = originalSetTimeout;
    global.clearInterval = originalClearInterval;
    global.clearTimeout = originalClearTimeout;
  }
});

test('Bonjour manager launches per-interface fallback after timeout', async () => {
  const originalSetInterval = global.setInterval;
  const originalSetTimeout = global.setTimeout;
  const originalClearInterval = global.clearInterval;
  const originalClearTimeout = global.clearTimeout;

  let timeoutId = 0;
  const scheduledTimeouts = new Map();
  global.setInterval = () => ({ id: 'interval' });
  global.setTimeout = (callback, delay) => {
    timeoutId += 1;
    scheduledTimeouts.set(timeoutId, { callback, delay });
    return timeoutId;
  };
  global.clearInterval = () => {};
  global.clearTimeout = (id) => {
    scheduledTimeouts.delete(id);
  };

  const fallbackFinds = [];
  const fallbackCallbacks = [];

  function createBrowser() {
    const listeners = new Map();
    return {
      services: [{ name: 'other' }],
      on: (event, handler) => listeners.set(event, handler),
      start: () => {},
      update: () => {},
      stop: () => {},
      removeAllListeners: () => listeners.clear(),
    };
  }

  const bonjourFactory = (opts = {}) => {
    const isFallback = Boolean(opts.interface);
    return {
      find: () => createBrowser(),
      findOne: (findOpts, callback) => {
        if (isFallback) {
          fallbackFinds.push({
            interface: opts.interface,
            type: findOpts.type,
            protocol: findOpts.protocol,
          });
          fallbackCallbacks.push(callback);
        }
        return createBrowser();
      },
      destroy: () => {},
    };
  };

  const modulePath = path.join(__dirname, '..', 'dist', 'Modules', 'Bonjour', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => createSilentLogger(),
    },
    bonjour: bonjourFactory,
    os: {
      networkInterfaces: () => ({
        lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
        en0: [{ family: 'IPv4', address: '10.1.1.5', internal: false }],
      }),
    },
  });

  let discovered = null;
  try {
    Manager.OnFind((service) => {
      discovered = service;
    });

    for (const entry of scheduledTimeouts.values()) {
      if (entry.delay === 10000) {
        await entry.callback();
      }
    }

    // One external IPv4 interface (lo0 is internal and skipped) x one service type.
    // This was 2 until support for servers at or below 3.1.5 — which advertised a
    // capitalised service type — was dropped.
    assert.equal(fallbackFinds.length, 1);
    assert.equal(
      fallbackFinds.every((entry) => entry.type === 'showtrak'),
      true
    );

    fallbackCallbacks[0]({ host: 'fallback.local', port: 4040 });
    assert.deepEqual(discovered, { host: 'fallback.local', port: 4040 });

    await Manager.Terminate();
  } finally {
    global.setInterval = originalSetInterval;
    global.setTimeout = originalSetTimeout;
    global.clearInterval = originalClearInterval;
    global.clearTimeout = originalClearTimeout;
  }
});
