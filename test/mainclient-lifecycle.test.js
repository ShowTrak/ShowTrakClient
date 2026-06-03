const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

function loadWithMocks(modulePath, mocks) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];

  const originalLoad = Module._load;
  Module._load = function patchedLoader(request, _parent, _isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

test('MainClient reinit clears timers and does not re-register USB listeners', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;

  let intervalId = 0;
  const activeIntervals = new Set();
  let clearIntervalCalls = 0;

  global.setInterval = (callback, _delay) => {
    intervalId += 1;
    const handle = { id: intervalId, callback };
    activeIntervals.add(handle);
    return handle;
  };

  global.clearInterval = (handle) => {
    clearIntervalCalls += 1;
    activeIntervals.delete(handle);
  };

  let onUsbConnectRegistrations = 0;
  let onUsbDisconnectRegistrations = 0;
  let networkStarts = 0;
  let networkStops = 0;

  function createSocket() {
    const handlers = new Map();
    return {
      connected: true,
      volatile: { emit: () => {} },
      on(event, callback) {
        handlers.set(event, callback);
      },
      emit(event, ...args) {
        const maybeCb = args[args.length - 1];
        if (event === 'GetScripts' && typeof maybeCb === 'function') {
          maybeCb([]);
        }
      },
      disconnect() {
        const disconnectHandler = handlers.get('disconnect');
        if (disconnectHandler) disconnectHandler();
      },
      trigger(event, ...args) {
        const handler = handlers.get(event);
        if (handler) return handler(...args);
      },
    };
  }

  const createdSockets = [];

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'MainClient', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {}, success: () => {} }),
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    'socket.io-client': {
      io: () => {
        const socket = createSocket();
        createdSockets.push(socket);
        return socket;
      },
    },
    '../OS': {
      Manager: {
        Hostname: 'test-host',
        GetVitals: async () => ({}),
        GetMacAddresses: async () => [null, {}],
        GetNetworkInterfaces: async () => [null, []],
      },
    },
    '../Config': { Config: { Application: { Version: 'test' } } },
    '../USBMonitor': {
      Manager: {
        GetUSBDevices: async () => [null, []],
        OnUSBConnect: () => {
          onUsbConnectRegistrations += 1;
        },
        OnUSBDisconnect: () => {
          onUsbDisconnectRegistrations += 1;
        },
      },
    },
    '../ScriptManager': { Manager: { SetScripts: async () => {}, DownloadScripts: async () => {}, DeleteScripts: async () => {} } },
    '../ProfileManager': { Manager: { ResetAdopption: async () => {} } },
    '../NetworkMonitor': {
      Manager: {
        Start: async () => {
          networkStarts += 1;
        },
        Stop: async () => {
          networkStops += 1;
        },
      },
    },
    '../Utils': { Wait: async () => {} },
  });

  try {
    await Manager.Init('uuid-1', '127.0.0.1', 3000);
    await createdSockets[0].trigger('connect');
    const clearsAfterFirstConnect = clearIntervalCalls;

    await Manager.Init('uuid-1', '127.0.0.1', 3000);
    await createdSockets[1].trigger('connect');

    assert.equal(onUsbConnectRegistrations, 1);
    assert.equal(onUsbDisconnectRegistrations, 1);
    assert.ok(clearIntervalCalls > clearsAfterFirstConnect);
    assert.ok(networkStarts >= 2);

    await Manager.Terminate();
    assert.ok(networkStops >= 1);
    assert.equal(activeIntervals.size, 0);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});
