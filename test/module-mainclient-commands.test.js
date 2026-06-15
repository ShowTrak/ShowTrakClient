const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

function createSocket() {
  const handlers = new Map();
  const emits = [];
  const volatileEmits = [];
  const socket = {
    connected: true,
    volatile: {
      emit: (event, payload) => {
        volatileEmits.push([event, payload]);
      },
    },
    on(event, callback) {
      handlers.set(event, callback);
    },
    emit(event, ...args) {
      emits.push([event, ...args]);
      const maybeCallback = args[args.length - 1];
      if (event === 'GetScripts' && typeof maybeCallback === 'function') {
        maybeCallback([{ ID: 'scriptA' }]);
      }
    },
    disconnect() {
      const handler = handlers.get('disconnect');
      if (handler) handler();
    },
    async trigger(event, ...args) {
      const handler = handlers.get(event);
      if (handler) return handler(...args);
      return undefined;
    },
    getHandlers() {
      return handlers;
    },
    getEmits() {
      return emits;
    },
    getVolatileEmits() {
      return volatileEmits;
    },
  };
  return socket;
}

test('MainClient handles command events and reconnect lifecycle branches', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;

  const intervalHandles = [];
  global.setInterval = (callback) => {
    const handle = { callback };
    intervalHandles.push(handle);
    return handle;
  };
  global.clearInterval = () => {};

  let createdSocket = null;
  let processStops = 0;
  let networkStops = 0;
  let setScriptsCalls = 0;
  let deleteScriptsCalls = 0;
  let downloadCalls = 0;
  let executeCalls = 0;
  let executeShouldFail = false;
  const broadcastEvents = [];
  let onUsbConnect = null;
  let onUsbDisconnect = null;

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'MainClient', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {}, success: () => {} }),
    },
    '../Broadcast': {
      Manager: {
        emit: (event, ...args) => {
          broadcastEvents.push([event, ...args]);
          if (event === 'UpdateSoftware') {
            const cb = args[0];
            if (typeof cb === 'function') cb(null);
          }
          if (event === 'UpdateSoftwareFromLAN') {
            const progressCb = args[1];
            const doneCb = args[2];
            if (typeof progressCb === 'function') progressCb(45, 'Downloading');
            if (typeof doneCb === 'function') doneCb(null);
          }
        },
      },
    },
    'socket.io-client': {
      io: () => {
        createdSocket = createSocket();
        return createdSocket;
      },
    },
    '../OS': {
      Manager: {
        Hostname: 'test-host',
        OperatingSystem: 'macOS',
        GetVitals: async () => ({ CPU: { UsagePercentage: 1 } }),
        GetMacAddresses: async () => [null, { en0: 'aa' }],
        GetNetworkInterfaces: async () => [null, [{ name: 'en0', addresses: [] }]],
      },
    },
    '../Config': { Config: { Application: { Version: '9.9.9' } } },
    '../USBMonitor': {
      Manager: {
        GetUSBDevices: async () => [null, [{ ProductID: 2 }]],
        OnUSBConnect: (cb) => {
          onUsbConnect = cb;
        },
        OnUSBDisconnect: (cb) => {
          onUsbDisconnect = cb;
        },
      },
    },
    '../ScriptManager': {
      Manager: {
        SetScripts: async () => {
          setScriptsCalls += 1;
        },
        DownloadScripts: async () => {
          downloadCalls += 1;
        },
        DeleteScripts: async () => {
          deleteScriptsCalls += 1;
        },
        GetLastAppliedDeploymentFingerprint: async () => 'fp-123',
        Execute: async () => {
          executeCalls += 1;
          if (executeShouldFail) return ['failed', false];
          return [null, true];
        },
      },
    },
    '../ProcessMonitor': {
      Manager: {
        Start: async () => {},
        Stop: async () => {
          processStops += 1;
        },
      },
    },
    '../NetworkMonitor': {
      Manager: {
        Start: async () => {},
        Stop: async () => {
          networkStops += 1;
        },
      },
    },
    '../Utils': { Wait: async () => {} },
  });

  try {
    await Manager.Init('uuid-main', '127.0.0.1', 3000);
    await createdSocket.trigger('connect');

    assert.equal(setScriptsCalls, 1);
    assert.equal(createdSocket.getVolatileEmits().some(([event]) => event === 'Heartbeat'), true);
    assert.equal(createdSocket.getEmits().some(([event]) => event === 'SystemInfo'), true);
    assert.equal(createdSocket.getEmits().some(([event]) => event === 'NetworkInterfaces'), true);

    await createdSocket.trigger('UpdateSoftware', 'r-1');
    assert.equal(createdSocket.getEmits().some(([event, requestId]) => event === 'ScriptExecutionResponse' && requestId === 'r-1'), true);

    await createdSocket.trigger('UpdateSoftwareFromLAN', 'r-2', { FeedPath: '/feed', ReleaseVersion: '1.2.3' });
    assert.equal(createdSocket.getEmits().some(([event, requestId]) => event === 'ScriptExecutionProgress' && requestId === 'r-2'), true);

    await createdSocket.trigger('DeleteScripts', 'r-3');
    assert.equal(deleteScriptsCalls, 1);

    await createdSocket.trigger('UpdateScripts', 'r-4');
    assert.equal(downloadCalls, 1);

    await createdSocket.trigger('Unadopt');
    assert.equal(broadcastEvents.some(([event]) => event === 'ServerAdoptionRejected'), true);

    await createdSocket.trigger('connect_error', new Error('ECONNREFUSED'));
    await createdSocket.trigger('connect_error', new Error('ECONNREFUSED'));
    await createdSocket.trigger('connect_error', new Error('ECONNREFUSED'));
    assert.equal(broadcastEvents.some(([event]) => event === 'ServerConnectFailed'), true);

    executeShouldFail = true;
    await createdSocket.trigger('ExecuteScript', 'r-5', 'script-a');
    executeShouldFail = false;
    await createdSocket.trigger('ExecuteScript', 'r-6', 'script-a');
    assert.equal(executeCalls, 2);

    createdSocket.connected = false;
    await onUsbConnect({ ProductID: 9 });
    await onUsbDisconnect({ ProductID: 9 });

    await createdSocket.trigger('disconnect');
    assert.equal(processStops >= 1, true);
    assert.equal(networkStops >= 1, true);

    await Manager.Terminate();
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

test('MainClient reports UpdateScripts download errors and pre-download failures', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.setInterval = () => ({ id: 'i' });
  global.clearInterval = () => {};

  let createdSocket = null;
  let shouldThrowGetScripts = false;
  let shouldFailDownload = false;

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'MainClient', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {}, success: () => {} }),
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    'socket.io-client': {
      io: () => {
        const handlers = new Map();
        const emits = [];
        createdSocket = {
          connected: true,
          volatile: { emit: () => {} },
          on: (event, cb) => handlers.set(event, cb),
          disconnect: () => {
            const handler = handlers.get('disconnect');
            if (handler) handler();
          },
          emit: (event, ...args) => {
            emits.push([event, ...args]);
            if (event === 'GetScripts') {
              if (shouldThrowGetScripts) throw new Error('pre-download');
              const cb = args[args.length - 1];
              if (typeof cb === 'function') cb([{ ID: 'a' }]);
            }
          },
          trigger: async (event, ...args) => handlers.get(event)?.(...args),
          getEmits: () => emits,
        };
        return createdSocket;
      },
    },
    '../OS': {
      Manager: {
        Hostname: 'h',
        OperatingSystem: 'macOS',
        GetVitals: async () => ({}),
        GetMacAddresses: async () => [null, {}],
        GetNetworkInterfaces: async () => [null, []],
      },
    },
    '../Config': { Config: { Application: { Version: 'v' } } },
    '../USBMonitor': { Manager: { GetUSBDevices: async () => [null, []], OnUSBConnect: () => {}, OnUSBDisconnect: () => {} } },
    '../ScriptManager': {
      Manager: {
        SetScripts: async () => {},
        DeleteScripts: async () => {},
        Execute: async () => [null, true],
        GetLastAppliedDeploymentFingerprint: async () => null,
        DownloadScripts: async () => {
          if (shouldFailDownload) throw new Error('download failed');
        },
      },
    },
    '../ProfileManager': { Manager: { ResetAdopption: async () => {} } },
    '../ProcessMonitor': { Manager: { Start: async () => {}, Stop: async () => {} } },
    '../NetworkMonitor': { Manager: { Start: async () => {}, Stop: async () => {} } },
    '../Utils': { Wait: async () => {} },
  });

  try {
    await Manager.Init('uuid', '127.0.0.1', 3000);
    await createdSocket.trigger('connect');

    shouldFailDownload = true;
    await createdSocket.trigger('UpdateScripts', 'req-download-fail');
    assert.equal(
      createdSocket
        .getEmits()
        .some(([event, requestId, message]) => event === 'ScriptExecutionResponse' && requestId === 'req-download-fail' && String(message).includes('download failed')),
      true
    );

    shouldFailDownload = false;
    shouldThrowGetScripts = true;
    await createdSocket.trigger('UpdateScripts', 'req-pre-fail');
    assert.equal(
      createdSocket
        .getEmits()
        .some(([event, requestId, message]) => event === 'ScriptExecutionResponse' && requestId === 'req-pre-fail' && String(message).includes('pre-download')),
      true
    );

    await Manager.Terminate();
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});