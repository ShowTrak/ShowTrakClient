const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

function waitTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('OS manager returns vitals, mac addresses, and interfaces', async () => {
  const originalSetInterval = global.setInterval;
  global.setInterval = () => ({ id: 'cpu' });

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'OS', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    os: {
      hostname: () => 'unit-host',
      totalmem: () => 100,
      freemem: () => 30,
      uptime: () => 3661,
      cpus: () => [{ times: { user: 1, nice: 1, sys: 1, idle: 7, irq: 0 } }],
      networkInterfaces: () => ({
        lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', cidr: '127.0.0.1/8', mac: '00', internal: true }],
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
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'NetworkMonitor', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, error: () => {}, debug: () => {} }),
    },
    '../OS': {
      Manager: {
        GetNetworkInterfaces: async () => [null, interfaceSnapshots[Math.min(idx++, interfaceSnapshots.length - 1)]],
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

test('ProcessMonitor emits snapshots, no-change markers, and permission status errors', async () => {
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

  const statusEvents = [];
  const socketEmits = [];
  const socket = {
    connected: true,
    emit: (event, payload) => socketEmits.push([event, payload]),
  };

  const responses = [
    [null, 'Safari\nCode\n'],
    [null, 'Safari\nCode\n'],
    [new Error('Not authorized -1743'), ''],
  ];

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'ProcessMonitor', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    child_process: {
      execFile: (_command, _args, _opts, callback) => {
        const next = responses.shift() || [null, ''];
        callback(next[0], next[1]);
      },
    },
    os: {
      userInfo: () => ({ username: 'tester' }),
    },
    '../Logger': {
      CreateLogger: () => ({ warn: () => {}, error: () => {} }),
    },
    '../Broadcast': {
      Manager: {
        emit: (event, payload) => {
          statusEvents.push([event, payload]);
        },
      },
    },
  });

  try {
    await Manager.Start(socket);
    assert.equal(socketEmits[0][0], 'RunningApplications');
    assert.equal(socketEmits[0][1].Items.length > 0, true);

    intervalHandle.callback();
    await waitTick();
    const noChangesEmit = socketEmits.find((entry) => entry[1] && entry[1].NoChanges === true);
    assert.equal(Boolean(noChangesEmit), true);

    intervalHandle.callback();
    await waitTick();
    const status = Manager.GetStatus();
    assert.equal(status.State, 'permission_denied');
    assert.equal(statusEvents.some(([event]) => event === 'ProcessMonitorStatus'), true);

    await Manager.Stop();
    assert.equal(intervalHandle, null);
    assert.equal(Manager.GetStatus().State, 'unknown');
  } finally {
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

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'Bonjour', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
    },
    bonjour: bonjourFactory,
    os: {
      networkInterfaces: () => ({ en0: [{ family: 'IPv4', address: '10.0.0.2', internal: false }] }),
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
          fallbackFinds.push({ interface: opts.interface, type: findOpts.type, protocol: findOpts.protocol });
          fallbackCallbacks.push(callback);
        }
        return createBrowser();
      },
      destroy: () => {},
    };
  };

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'Bonjour', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
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

    assert.equal(fallbackFinds.length, 2);
    assert.equal(fallbackFinds.some((entry) => entry.type === 'showtrak'), true);
    assert.equal(fallbackFinds.some((entry) => entry.type === 'ShowTrak'), true);

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
