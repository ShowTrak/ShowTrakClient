const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

// Utils is pure and side-effect free, so the real module is spread in and only
// Wait is overridden (to avoid real delays). Stubbing Utils wholesale meant that
// adding a helper to it — ReadIdentityToken, ErrorMessage — silently handed the
// module under test an `undefined` function.
const REAL_UTILS = require(path.join(__dirname, '..', 'dist', 'Modules', 'Utils', 'index.js'));

// Exercises the server-command handlers in src/Modules/MainClient/index.ts that
// the existing lifecycle and command tests do not reach.
//
// The module was 83% lines but only 55% branches. Everything here is a command
// the SERVER sends to this machine, so each one is remote control of a show PC:
// update yourself, run this script, show an overlay, forget your adoption. The
// branches that were missing are the ones that decide what happens when the
// socket has gone away mid-command, and how a malformed payload is read.
//
// The recurring property: a handler must never write to a disconnected socket
// (a long update finishes long after the connection dropped) and must never
// take a field from the payload on trust.

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'MainClient', 'index.js');

const IP = '10.0.0.10';
const PORT = 3000;

const loggerStub = {
  CreateLogger: () => ({
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    success: () => {},
    database: () => {},
    databaseError: () => {},
  }),
};

/** A fake Socket.IO socket that records emits and replays registered handlers. */
function createSocket() {
  const Handlers = new Map();
  const Emits = [];

  return {
    connected: true,
    volatile: { emit: () => {} },
    on(Event, Callback) {
      Handlers.set(Event, Callback);
    },
    emit(Event, ...Args) {
      Emits.push([Event, ...Args]);
      const Last = Args[Args.length - 1];
      if (Event === 'GetScripts' && typeof Last === 'function') Last([]);
      return true;
    },
    disconnect() {},
    emits: Emits,
    /** Invoke a registered server-command handler. */
    trigger: (Event, ...Args) => {
      const Handler = Handlers.get(Event);
      return Handler ? Handler(...Args) : undefined;
    },
    has: (Event) => Handlers.has(Event),
  };
}

/** Boot MainClient against a socket, capturing broadcast traffic. */
async function boot({ socket = createSocket(), execute } = {}) {
  const Broadcasts = [];
  const OriginalSetInterval = global.setInterval;
  global.setInterval = () => ({});

  let Manager;
  try {
    ({ Manager } = loadWithMocks(MODULE_PATH, {
      '../Logger': loggerStub,
      'socket.io-client': { io: () => socket },
      '../Broadcast': {
        Manager: {
          emit: (Event, ...Args) => Broadcasts.push([Event, ...Args]),
          on: () => {},
        },
      },
      '../OS': {
        Manager: {
          Hostname: 'foh-01',
          OperatingSystem: 'macOS',
          GetVitals: async () => ({}),
          GetMacAddresses: async () => [null, {}],
          GetNetworkInterfaces: async () => [null, []],
          GetLocalIPv4Addresses: () => ['10.0.0.50', '192.168.1.50'],
        },
      },
      '../Config': { Config: { Application: { Version: '3.14.0' } } },
      '../USBMonitor': {
        Manager: {
          GetUSBDevices: async () => [null, []],
          OnUSBConnect: () => {},
          OnUSBDisconnect: () => {},
        },
      },
      '../DisplayMonitor': {
        Manager: { GetDisplays: async () => [null, []], OnDisplayChange: () => {} },
      },
      '../ScriptManager': {
        Manager: {
          SetScripts: async () => {},
          DownloadScripts: async () => {},
          DeleteScripts: async () => {},
          GetLastAppliedDeploymentFingerprint: async () => 'fp',
          Execute: execute || (async () => [null, true]),
        },
      },
      '../ProcessMonitor': { Manager: { Start: async () => {}, Stop: async () => {} } },
      '../NetworkMonitor': { Manager: { Start: async () => {}, Stop: async () => {} } },
      '../Utils': { ...REAL_UTILS, Wait: async () => {} },
      '../ProfileManager': {
        Manager: { GetProfile: async () => ({ Server: { ServerIdentity: 'token' } }) },
      },
    }));

    await Manager.Init('client-uuid', IP, PORT);
  } finally {
    global.setInterval = OriginalSetInterval;
  }

  return { Manager, socket, broadcasts: Broadcasts };
}

const lastBroadcast = (Broadcasts, Event) =>
  [...Broadcasts].reverse().find((B) => B[0] === Event) || null;
const emitsOf = (Socket, Event) => Socket.emits.filter((E) => E[0] === Event);

// --- Identify ---------------------------------------------------------------

test('Identify shows the overlay with this machine’s own details', async () => {
  // The whole point is physically locating this box, so the details must come
  // from the local OS rather than from anything the server sends.
  const { socket, broadcasts } = await boot();

  await socket.trigger('Identify', { Nickname: 'FOH PC' });

  const [, Payload] = lastBroadcast(broadcasts, 'ShowIdentifyOverlay');
  assert.equal(Payload.Hostname, 'foh-01');
  assert.equal(Payload.Nickname, 'FOH PC');
  assert.deepEqual(Payload.IPs, ['10.0.0.50', '192.168.1.50']);
});

test('a blank or missing nickname falls back to null, not an empty overlay', async () => {
  // The overlay renders the hostname as the headline when there is no distinct
  // nickname; an empty string would make it render a blank name instead.
  const { socket, broadcasts } = await boot();

  for (const Payload of [{ Nickname: '   ' }, { Nickname: '' }, { Nickname: 42 }, {}, undefined]) {
    await socket.trigger('Identify', Payload);
    const [, Sent] = lastBroadcast(broadcasts, 'ShowIdentifyOverlay');
    assert.equal(Sent.Nickname, null, `payload ${JSON.stringify(Payload)}`);
    assert.equal(Sent.Hostname, 'foh-01');
  }
});

test('StopIdentify hides the overlay', async () => {
  const { socket, broadcasts } = await boot();
  await socket.trigger('StopIdentify');
  assert.ok(lastBroadcast(broadcasts, 'HideIdentifyOverlay'));
});

// --- Unadopt ----------------------------------------------------------------

test('Unadopt reports the endpoint that rejected us', async () => {
  // The recovery state machine keys off IP and Port to decide whether this
  // rejection concerns the candidate it is currently validating.
  const { socket, broadcasts } = await boot();

  await socket.trigger('Unadopt', { Reason: 'Replaced', ServerIdentity: '  token-2  ' });

  const [, Payload] = lastBroadcast(broadcasts, 'ServerAdoptionRejected');
  assert.equal(Payload.IP, IP);
  assert.equal(Payload.Port, PORT);
  assert.equal(Payload.Reason, 'Replaced');
  assert.equal(Payload.ServerIdentity, 'token-2', 'the identity should be trimmed');
});

test('an Unadopt with no details still rejects cleanly', async () => {
  // A bare unadopt is normal — the operator pressed a button, and there is
  // nothing more to say.
  const { socket, broadcasts } = await boot();

  for (const Info of [undefined, null, {}, { Reason: '' }, { ServerIdentity: 42 }]) {
    await socket.trigger('Unadopt', Info);
    const [, Payload] = lastBroadcast(broadcasts, 'ServerAdoptionRejected');
    assert.equal(Payload.Reason, null, `info ${JSON.stringify(Info)}`);
    assert.equal(Payload.ServerIdentity, null);
  }
});

// --- Software update --------------------------------------------------------

test('UpdateSoftware answers the request it was given', async () => {
  // The server correlates the response by RequestID; answering the wrong one
  // leaves a task pending in the operator's panel forever.
  const { socket, broadcasts } = await boot();

  await socket.trigger('UpdateSoftware', 'req-1');
  const [, Callback] = lastBroadcast(broadcasts, 'UpdateSoftware');
  Callback('update failed');

  assert.deepEqual(emitsOf(socket, 'ScriptExecutionResponse')[0], [
    'ScriptExecutionResponse',
    'req-1',
    'update failed',
  ]);
});

test('a LAN update resolves the feed URL against the server it came from', async () => {
  // The server sends a RELATIVE path; this client turns it into an absolute URL
  // for its own connection. Getting that wrong points the updater at the wrong
  // machine, or at nothing.
  const { socket, broadcasts } = await boot();

  await socket.trigger('UpdateSoftwareFromLAN', 'req-2', {
    FeedPath: '/updates/client/3.14.0/',
    ReleaseVersion: '3.14.0',
  });

  const [, Payload] = lastBroadcast(broadcasts, 'UpdateSoftwareFromLAN');
  assert.equal(Payload.FeedURL, `http://${IP}:${PORT}/updates/client/3.14.0/`);
  assert.equal(Payload.ReleaseVersion, '3.14.0');
});

test('a LAN update with no path falls back to the default feed', async () => {
  const { socket, broadcasts } = await boot();

  for (const Payload of [undefined, {}, { FeedPath: '' }]) {
    await socket.trigger('UpdateSoftwareFromLAN', 'req-3', Payload);
    const [, Sent] = lastBroadcast(broadcasts, 'UpdateSoftwareFromLAN');
    assert.equal(
      Sent.FeedURL,
      `http://${IP}:${PORT}/updates/client/latest/`,
      `payload ${JSON.stringify(Payload)}`
    );
    assert.equal(Sent.ReleaseVersion, null);
  }
});

test('LAN update progress reaches the operator’s panel', async () => {
  const { socket, broadcasts } = await boot();

  await socket.trigger('UpdateSoftwareFromLAN', 'req-4', {});
  const [, , OnProgress, OnDone] = lastBroadcast(broadcasts, 'UpdateSoftwareFromLAN');

  OnProgress(42, 'Downloading');
  assert.deepEqual(emitsOf(socket, 'ScriptExecutionProgress')[0], [
    'ScriptExecutionProgress',
    'req-4',
    42,
    'Downloading',
  ]);

  await OnDone(null);
  assert.deepEqual(emitsOf(socket, 'ScriptExecutionResponse')[0], [
    'ScriptExecutionResponse',
    'req-4',
    null,
  ]);
});

test('a LAN update that finishes after the socket dropped writes nothing', async () => {
  // The realistic case: downloading and installing takes minutes, and the
  // server may well have gone away in between. Emitting on a dead socket is at
  // best noise and at worst an unhandled error inside the updater's callback.
  const { socket, broadcasts } = await boot();

  await socket.trigger('UpdateSoftwareFromLAN', 'req-5', {});
  const [, , OnProgress, OnDone] = lastBroadcast(broadcasts, 'UpdateSoftwareFromLAN');

  socket.connected = false;
  OnProgress(50, 'Installing');
  await OnDone('failed');

  assert.deepEqual(emitsOf(socket, 'ScriptExecutionProgress'), []);
  assert.deepEqual(emitsOf(socket, 'ScriptExecutionResponse'), []);
});

test('an undefined LAN update error is normalised to null', async () => {
  // The server reads a truthy value as failure; undefined would serialise away
  // and could be read as either.
  const { socket, broadcasts } = await boot();

  await socket.trigger('UpdateSoftwareFromLAN', 'req-6', {});
  const [, , , OnDone] = lastBroadcast(broadcasts, 'UpdateSoftwareFromLAN');
  await OnDone(undefined);

  assert.equal(emitsOf(socket, 'ScriptExecutionResponse')[0][2], null);
});

// --- Script execution -------------------------------------------------------

test('a script failure is reported against its request', async () => {
  const { socket } = await boot({ execute: async () => ['permission denied', false] });

  await socket.trigger('ExecuteScript', 'req-7', 'restart-qlab');

  assert.deepEqual(emitsOf(socket, 'ScriptExecutionResponse')[0], [
    'ScriptExecutionResponse',
    'req-7',
    'permission denied',
    null,
  ]);
});

test('a script success carries its result back', async () => {
  const { socket } = await boot({ execute: async () => [null, 'done'] });

  await socket.trigger('ExecuteScript', 'req-8', 'restart-qlab');

  assert.deepEqual(emitsOf(socket, 'ScriptExecutionResponse')[0], [
    'ScriptExecutionResponse',
    'req-8',
    null,
    'done',
  ]);
});

test('script progress is dropped once the socket is gone', async () => {
  // Same guard as the LAN update: a long script outliving its connection must
  // not keep writing.
  let Report;
  const { socket } = await boot({
    execute: async (_RequestID, _ScriptID, OnProgress) => {
      Report = OnProgress;
      return [null, true];
    },
  });

  await socket.trigger('ExecuteScript', 'req-9', 'slow-script');
  socket.connected = false;
  Report(10, 'Still going');

  assert.deepEqual(emitsOf(socket, 'ScriptExecutionProgress'), []);
});

test('script progress reaches the server while connected', async () => {
  let Report;
  const { socket } = await boot({
    execute: async (_RequestID, _ScriptID, OnProgress) => {
      Report = OnProgress;
      OnProgress(25, 'Starting');
      return [null, true];
    },
  });

  await socket.trigger('ExecuteScript', 'req-10', 'slow-script');
  assert.deepEqual(emitsOf(socket, 'ScriptExecutionProgress')[0], [
    'ScriptExecutionProgress',
    'req-10',
    25,
    'Starting',
  ]);
  assert.equal(typeof Report, 'function');
});

// --- Registration -----------------------------------------------------------

test('every server command this client answers is registered', () => {
  // A command the server sends to an unregistered event is silently swallowed
  // by Socket.IO, which surfaces as a task that never completes.
  return boot().then(({ socket }) => {
    for (const Event of [
      'connect',
      'disconnect',
      'connect_error',
      'UpdateSoftware',
      'UpdateSoftwareFromLAN',
      'DeleteScripts',
      'UpdateScripts',
      'Unadopt',
      'ExecuteScript',
      'Identify',
      'StopIdentify',
    ]) {
      assert.ok(socket.has(Event), `${Event} is not handled`);
    }
  });
});
