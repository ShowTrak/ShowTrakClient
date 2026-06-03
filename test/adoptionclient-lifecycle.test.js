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

test('AdoptionClient reinit/terminate clears adoption heartbeat intervals', async () => {
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

  function createSocket() {
    const handlers = new Map();
    return {
      connected: true,
      on(event, callback) {
        handlers.set(event, callback);
      },
      emit: () => {},
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

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'AdoptionClient', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
    },
    'socket.io-client': {
      io: () => {
        const socket = createSocket();
        createdSockets.push(socket);
        return socket;
      },
    },
    '../Config': { Config: { Application: { Version: 'test' } } },
    '../OS': { Manager: { Hostname: 'test-host' } },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../ProfileManager': { Manager: { Adopt: async () => {} } },
  });

  try {
    await Manager.Init('uuid-1', '127.0.0.1', 3000);
    await createdSockets[0].trigger('connect');
    const clearsAfterFirstConnect = clearIntervalCalls;

    await Manager.Init('uuid-1', '127.0.0.1', 3000);
    await createdSockets[1].trigger('connect');
    assert.ok(clearIntervalCalls > clearsAfterFirstConnect);

    await Manager.Terminate();
    assert.equal(activeIntervals.size, 0);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});
