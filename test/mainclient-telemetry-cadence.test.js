const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// How MainClient reports USB and display telemetry.
//
// Both are event-driven at the source — libusb hotplug and Electron's screen
// events — so the server hears about a change the moment it happens. The full
// lists exist only to correct drift (a missed event, a server restart), which is
// why they run on a slow resync rather than being resent alongside every event.
//
// The behaviour these tests pin down is what stops "closer to real time" from
// turning into "much more traffic": one emit per actual change.

const REAL_UTILS = require(path.join(__dirname, '..', 'dist', 'Modules', 'Utils', 'index.js'));
const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'MainClient', 'index.js');

function createHarness({ displays = [], deltas = false } = {}) {
  const emits = [];
  const intervals = [];
  const usb = {};
  let displayChanged = null;
  let currentDisplays = displays;
  const sockets = [];

  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.setInterval = (callback, ms) => {
    const handle = { callback, ms };
    intervals.push(handle);
    return handle;
  };
  global.clearInterval = () => {};

  const socket = {
    connected: true,
    handlers: new Map(),
    volatile: { emit: () => {} },
    emit: (event, ...args) => {
      emits.push([event, args[0]]);
      const last = args[args.length - 1];
      if (typeof last === 'function') last(undefined);
    },
    on: (event, handler) => socket.handlers.set(event, handler),
    disconnect: () => {},
  };
  sockets.push(socket);

  const mod = loadWithMocks(MODULE_PATH, {
    'socket.io-client': { io: () => socket },
    '../Logger': { CreateLogger: () => createSilentLogger() },
    '../Broadcast': { Manager: { emit: () => {}, on: () => {} } },
    '../OS': {
      Manager: {
        Hostname: 'test-host',
        OperatingSystem: 'test-os',
        GetVitals: async () => ({}),
        GetMacAddresses: async () => [null, {}],
        GetNetworkInterfaces: async () => [null, []],
        GetLocalIPv4Addresses: () => [],
      },
    },
    '../Config': { Config: { Application: { Version: 'test' } } },
    '../USBMonitor': {
      Manager: {
        GetUSBDevices: async () => [null, [{ SerialNumber: 'ABC' }]],
        OnUSBConnect: (callback) => {
          usb.connect = callback;
        },
        OnUSBDisconnect: (callback) => {
          usb.disconnect = callback;
        },
      },
    },
    '../DisplayMonitor': {
      Manager: {
        GetDisplays: async () => [null, currentDisplays],
        OnDisplayChange: (callback) => {
          displayChanged = callback;
        },
      },
    },
    '../ScriptManager': {
      Manager: {
        SetScripts: async () => {},
        DownloadScripts: async () => {},
        DeleteScripts: async () => {},
        GetLastAppliedDeploymentFingerprint: async () => null,
      },
    },
    '../ProfileManager': { Manager: { GetProfile: async () => ({ Server: {} }) } },
    '../LaunchConfig': { Manager: { Normalize: () => ({ ScriptID: null }) } },
    '../ServerCapabilities': {
      Manager: { Probe: () => {}, Reset: () => {}, SupportsDeltas: () => deltas },
    },
    '../ProcessMonitor': { Manager: { Start: async () => {}, Stop: async () => {} } },
    '../NetworkMonitor': { Manager: { Start: async () => {}, Stop: async () => {} } },
    '../Utils': { ...REAL_UTILS, Wait: async () => {} },
  });

  return {
    Manager: mod.Manager,
    emits,
    intervals,
    socket,
    usb: () => usb,
    fireDisplayChange: () => displayChanged(),
    setDisplays: (next) => {
      currentDisplays = next;
    },
    eventsNamed: (name) => emits.filter(([event]) => event === name),
    restore: () => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
    },
  };
}

test('a USB hotplug reports the device without resending the whole list', async () => {
  const H = createHarness();
  try {
    await H.Manager.Init('uuid-1', '127.0.0.1', 3000);
    await H.socket.handlers.get('connect')();
    const listsAfterConnect = H.eventsNamed('USBDeviceList').length;

    H.usb().connect({ SerialNumber: 'NEW', ProductName: 'Label Printer' });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(H.eventsNamed('USBDeviceConnected').length, 1);
    // The server applies the event to its connected list incrementally. Sending
    // the full list as well meant plugging in a hub emitted one complete device
    // list per port on it.
    assert.equal(
      H.eventsNamed('USBDeviceList').length,
      listsAfterConnect,
      'a hotplug must not trigger a full list'
    );

    H.usb().disconnect({ SerialNumber: 'NEW' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(H.eventsNamed('USBDeviceDisconnected').length, 1);
    assert.equal(H.eventsNamed('USBDeviceList').length, listsAfterConnect);
  } finally {
    H.restore();
  }
});

test('the display list is only sent when the reported payload actually changed', async () => {
  const H = createHarness({ displays: [{ DisplayID: 'edid:A', Width: 1920 }] });
  try {
    await H.Manager.Init('uuid-1', '127.0.0.1', 3000);
    await H.socket.handlers.get('connect')();
    const afterConnect = H.eventsNamed('DisplayList').length;
    assert.equal(afterConnect, 1, 'the list is sent once on connect');

    // display-metrics-changed fires for things that do not affect this payload —
    // the dock auto-hiding moves every display's workArea, for one.
    H.fireDisplayChange();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(H.eventsNamed('DisplayList').length, afterConnect, 'no change, no emit');

    H.setDisplays([
      { DisplayID: 'edid:A', Width: 1920 },
      { DisplayID: 'edid:B', Width: 2560 },
    ]);
    H.fireDisplayChange();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      H.eventsNamed('DisplayList').length,
      afterConnect + 1,
      'a real topology change is reported'
    );
    assert.equal(H.eventsNamed('DisplayList').at(-1)[1].length, 2);
  } finally {
    H.restore();
  }
});

test('the periodic resync resends both lists even when nothing changed', async () => {
  const H = createHarness({ displays: [{ DisplayID: 'edid:A' }] });
  try {
    await H.Manager.Init('uuid-1', '127.0.0.1', 3000);
    await H.socket.handlers.get('connect')();
    const before = {
      usb: H.eventsNamed('USBDeviceList').length,
      display: H.eventsNamed('DisplayList').length,
    };

    // Both lists are a reconciliation channel, not the primary signal, so a
    // minute is frequent enough — but they must still fire unconditionally, or a
    // server that missed an event would never converge.
    const resyncs = H.intervals.filter((entry) => entry.ms === 60000);
    assert.equal(resyncs.length, 2, 'USB and display resyncs both run at 60s');

    for (const entry of resyncs) entry.callback();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(H.eventsNamed('USBDeviceList').length, before.usb + 1);
    assert.equal(
      H.eventsNamed('DisplayList').length,
      before.display + 1,
      'the display resync is forced past the change check'
    );
  } finally {
    H.restore();
  }
});

test('a reconnecting client resends its display list to the new server', async () => {
  const H = createHarness({ displays: [{ DisplayID: 'edid:A' }] });
  try {
    await H.Manager.Init('uuid-1', '127.0.0.1', 3000);
    await H.socket.handlers.get('connect')();
    const afterFirst = H.eventsNamed('DisplayList').length;

    H.socket.handlers.get('disconnect')();
    await H.socket.handlers.get('connect')();

    // The hardware has not changed, but this server may never have seen it, so
    // the change check must not suppress the reconnect emit.
    assert.equal(H.eventsNamed('DisplayList').length, afterFirst + 1);
  } finally {
    H.restore();
  }
});

test('a display change is reported as a delta when the server supports it', async () => {
  const H = createHarness({ displays: [{ DisplayID: 'edid:A', Width: 1920 }], deltas: true });
  try {
    await H.Manager.Init('uuid-1', '127.0.0.1', 3000);
    await H.socket.handlers.get('connect')();
    // The on-connect report is a full list: it is the baseline the server
    // replaces its state from, and this server may never have seen this client.
    assert.equal(H.eventsNamed('DisplayList').length, 1);

    H.setDisplays([
      { DisplayID: 'edid:A', Width: 1920 },
      { DisplayID: 'edid:B', Width: 2560 },
    ]);
    H.fireDisplayChange();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(H.eventsNamed('DisplayList').length, 1, 'the change goes out as a delta');
    const deltas = H.eventsNamed('DisplayDelta');
    assert.equal(deltas.length, 1);
    assert.equal(deltas[0][1].Added.length, 1);
    assert.equal(deltas[0][1].Added[0].DisplayID, 'edid:B');
    assert.deepEqual(deltas[0][1].Removed, []);
  } finally {
    H.restore();
  }
});

test('a display being unplugged is reported by DisplayID', async () => {
  const H = createHarness({
    displays: [{ DisplayID: 'edid:A' }, { DisplayID: 'edid:B' }],
    deltas: true,
  });
  try {
    await H.Manager.Init('uuid-1', '127.0.0.1', 3000);
    await H.socket.handlers.get('connect')();

    H.setDisplays([{ DisplayID: 'edid:A' }]);
    H.fireDisplayChange();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(H.eventsNamed('DisplayDelta')[0][1].Removed, ['edid:B']);
  } finally {
    H.restore();
  }
});

test('the display resync sends the full list even with deltas enabled', async () => {
  const H = createHarness({ displays: [{ DisplayID: 'edid:A' }], deltas: true });
  try {
    await H.Manager.Init('uuid-1', '127.0.0.1', 3000);
    await H.socket.handlers.get('connect')();
    const before = H.eventsNamed('DisplayList').length;

    for (const entry of H.intervals.filter((i) => i.ms === 60000)) entry.callback();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(H.eventsNamed('DisplayList').length, before + 1);
    assert.equal(H.eventsNamed('DisplayDelta').length, 0);
  } finally {
    H.restore();
  }
});

test('displays with no usable id fall back to a full list rather than reporting nothing', async () => {
  const H = createHarness({ displays: [{ DisplayID: null, Width: 1920 }], deltas: true });
  try {
    await H.Manager.Init('uuid-1', '127.0.0.1', 3000);
    await H.socket.handlers.get('connect')();
    const before = H.eventsNamed('DisplayList').length;

    // A delta keyed on DisplayID cannot describe these, and silently dropping
    // the change would leave the server permanently stale.
    H.setDisplays([{ DisplayID: null, Width: 3840 }]);
    H.fireDisplayChange();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(H.eventsNamed('DisplayDelta').length, 0);
    assert.equal(H.eventsNamed('DisplayList').length, before + 1);
  } finally {
    H.restore();
  }
});
