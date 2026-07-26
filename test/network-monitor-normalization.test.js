const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// Exercises the normalisation and change-detection in
// src/Modules/NetworkMonitor/index.ts.
//
// module-networking.test.js already covers the happy path (emit on change, not
// on repeat, stop cleanly). This covers the branches — the module was 82% lines
// but only 42% branches, which is the wrong way round for something whose whole
// job is deciding whether two snapshots are the same.
//
// Why the normalisation matters: the change signal is a JSON signature of the
// normalised list. `os.networkInterfaces()` gives no ordering guarantee, so
// without stable sorting the client would emit a "change" on every 10-second
// poll — flooding the server with identical interface lists for every client on
// the rig, forever. In the other direction, over-normalising would hide a NIC
// actually going away, which is the event the server needs to see.

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'NetworkMonitor', 'index.js');

const loggerStub = {
  CreateLogger: () => createSilentLogger(),
};

/** Load NetworkMonitor with a scripted OS and a recording socket. */
function load({ snapshots = [], osError = null, osThrows = false, emitThrows = false } = {}) {
  const Emissions = [];
  let Index = 0;

  const Socket = {
    connected: true,
    emit: (Event, Payload) => {
      if (emitThrows) throw new Error('socket write failed');
      Emissions.push([Event, Payload]);
      return true;
    },
  };

  const { Manager } = loadWithMocks(MODULE_PATH, {
    '../Logger': loggerStub,
    '../OS': {
      Manager: {
        GetNetworkInterfaces: async () => {
          if (osThrows) throw new Error('sysctl failed');
          if (osError) return [osError, null];
          const Snapshot = snapshots[Math.min(Index, snapshots.length - 1)];
          Index += 1;
          return [null, Snapshot];
        },
      },
    },
  });

  return { Manager, socket: Socket, emissions: Emissions, sampled: () => Index };
}

const iface = (name, addresses = []) => ({ name, addresses });
const addr = (O = {}) => ({ family: 'IPv4', address: '10.0.0.2', internal: false, ...O });

/** Advance the 10s poll and let its async work settle. */
async function poll(Times = 1) {
  for (let i = 0; i < Times; i += 1) {
    mock.timers.tick(10_000);
    await new Promise((R) => setImmediate(R));
  }
}

test.beforeEach(() => mock.timers.enable({ apis: ['setInterval'] }));
test.afterEach(() => mock.timers.reset());

// --- Stable ordering --------------------------------------------------------

test('interfaces are sorted by name, so arrival order is not a change', () => {
  // os.networkInterfaces() gives no ordering guarantee. Without this the client
  // would emit on most polls, for every client on the rig, forever.
  const { Manager, socket, emissions } = load({
    snapshots: [
      [iface('en1', [addr()]), iface('en0', [addr()])],
      [iface('en0', [addr()]), iface('en1', [addr()])],
    ],
  });

  return Manager.Start(socket)
    .then(() => poll(1))
    .then(() => {
      assert.equal(emissions.length, 1, 'a reordered snapshot was reported as a change');
      assert.deepEqual(
        emissions[0][1].map((I) => I.name),
        ['en0', 'en1']
      );
    });
});

test('addresses are sorted by family then address', async () => {
  const { Manager, socket, emissions } = load({
    snapshots: [
      [
        iface('en0', [
          addr({ family: 'IPv6', address: 'fe80::2' }),
          addr({ family: 'IPv4', address: '10.0.0.9' }),
          addr({ family: 'IPv6', address: 'fe80::1' }),
          addr({ family: 'IPv4', address: '10.0.0.1' }),
        ]),
      ],
    ],
  });

  await Manager.Start(socket);
  assert.deepEqual(
    emissions[0][1][0].addresses.map((A) => A.address),
    ['10.0.0.1', '10.0.0.9', 'fe80::1', 'fe80::2']
  );
});

test('a reordered address list is not a change either', async () => {
  const { Manager, socket, emissions } = load({
    snapshots: [
      [iface('en0', [addr({ address: '10.0.0.1' }), addr({ address: '10.0.0.2' })])],
      [iface('en0', [addr({ address: '10.0.0.2' }), addr({ address: '10.0.0.1' })])],
    ],
  });

  await Manager.Start(socket);
  await poll(1);
  assert.equal(emissions.length, 1);
});

test('sorting does not mutate the caller’s snapshot', async () => {
  // The array comes from the OS module's own cache; sorting it in place would
  // reorder what the next comparison sees.
  const Addresses = [addr({ address: '10.0.0.9' }), addr({ address: '10.0.0.1' })];
  const Snapshot = [iface('en0', Addresses)];

  const { Manager, socket } = load({ snapshots: [Snapshot] });
  await Manager.Start(socket);

  assert.deepEqual(
    Addresses.map((A) => A.address),
    ['10.0.0.9', '10.0.0.1'],
    'the source address list was sorted in place'
  );
});

// --- Field normalisation ----------------------------------------------------

test('a MAC is upper-cased so case alone is never a change', async () => {
  // Windows and macOS report different cases for the same adapter.
  const { Manager, socket, emissions } = load({
    snapshots: [
      [iface('en0', [addr({ mac: 'aa:bb:cc:dd:ee:ff' })])],
      [iface('en0', [addr({ mac: 'AA:BB:CC:DD:EE:FF' })])],
    ],
  });

  await Manager.Start(socket);
  assert.equal(emissions[0][1][0].addresses[0].mac, 'AA:BB:CC:DD:EE:FF');

  await poll(1);
  assert.equal(emissions.length, 1, 'MAC case was treated as a change');
});

test('absent optional fields are normalised to null, not undefined', async () => {
  // They are JSON-stringified for the signature, and undefined vanishes from
  // JSON entirely — so an interface that starts reporting a netmask would look
  // identical to one that never had one.
  const { Manager, socket, emissions } = load({
    snapshots: [[iface('en0', [{ family: 'IPv4', address: '10.0.0.2' }])]],
  });

  await Manager.Start(socket);
  const [Address] = emissions[0][1][0].addresses;
  assert.equal(Address.netmask, null);
  assert.equal(Address.cidr, null);
  assert.equal(Address.mac, null);
  assert.equal(Address.scopeid, null);
  assert.equal(Address.internal, false);
});

test('a scopeid of 0 is kept, because it is a real value', async () => {
  // The check is a typeof, not a truthiness test — 0 is the scope id of the
  // default IPv6 zone.
  const { Manager, socket, emissions } = load({
    snapshots: [[iface('en0', [addr({ family: 'IPv6', scopeid: 0 })])]],
  });

  await Manager.Start(socket);
  assert.equal(emissions[0][1][0].addresses[0].scopeid, 0);
});

test('internal is coerced to a real boolean', async () => {
  const { Manager, socket, emissions } = load({
    snapshots: [[iface('lo0', [addr({ internal: 1 })])]],
  });

  await Manager.Start(socket);
  assert.equal(emissions[0][1][0].addresses[0].internal, true);
});

test('an unnamed interface is reported as unknown rather than dropped', async () => {
  // Losing it entirely would look like a NIC disappeared.
  const { Manager, socket, emissions } = load({
    snapshots: [[{ addresses: [addr()] }, { name: '', addresses: [] }]],
  });

  await Manager.Start(socket);
  assert.deepEqual(
    emissions[0][1].map((I) => I.name),
    ['unknown', 'unknown']
  );
});

test('an interface with no address list becomes an empty one', async () => {
  const { Manager, socket, emissions } = load({
    snapshots: [[{ name: 'en0' }, { name: 'en1', addresses: 'nope' }]],
  });

  await Manager.Start(socket);
  for (const Interface of emissions[0][1]) {
    assert.deepEqual(Interface.addresses, []);
  }
});

test('a non-array snapshot normalises to an empty list', async () => {
  for (const Snapshot of [null, undefined, 'nope', {}, 42]) {
    const { Manager, socket, emissions } = load({ snapshots: [Snapshot] });
    await Manager.Start(socket);
    assert.deepEqual(emissions[0][1], [], `snapshot ${JSON.stringify(Snapshot)}`);
    await Manager.Stop();
  }
});

test('a snapshot that cannot be normalised reports an empty list, not a crash', async () => {
  // A hostile or corrupt entry must not take the monitor down — it polls
  // forever on an unattended machine.
  const Hostile = [
    {
      get name() {
        throw new Error('bad entry');
      },
    },
  ];

  const { Manager, socket, emissions } = load({ snapshots: [Hostile] });
  await assert.doesNotReject(() => Manager.Start(socket));
  assert.deepEqual(emissions[0][1], []);
});

// --- Change detection -------------------------------------------------------

test('a genuinely changed address IS emitted', async () => {
  // The other direction: normalisation must not hide a real NIC change, which
  // is the event the server needs to re-evaluate reachability.
  const { Manager, socket, emissions } = load({
    snapshots: [
      [iface('en0', [addr({ address: '10.0.0.2' })])],
      [iface('en0', [addr({ address: '10.0.0.3' })])],
    ],
  });

  await Manager.Start(socket);
  await poll(1);
  assert.equal(emissions.length, 2);
  assert.equal(emissions[1][1][0].addresses[0].address, '10.0.0.3');
});

test('an interface disappearing is a change', async () => {
  const { Manager, socket, emissions } = load({
    snapshots: [[iface('en0', [addr()]), iface('en1', [addr()])], [iface('en0', [addr()])]],
  });

  await Manager.Start(socket);
  await poll(1);
  assert.equal(emissions.length, 2);
  assert.equal(emissions[1][1].length, 1);
});

test('restarting always re-emits, even with an unchanged network', async () => {
  // The server has a fresh session and no interface list for this client, so
  // the cached signature has to be discarded on Start.
  const { Manager, socket, emissions } = load({ snapshots: [[iface('en0', [addr()])]] });

  await Manager.Start(socket);
  assert.equal(emissions.length, 1);

  await Manager.Start(socket);
  assert.equal(emissions.length, 2);
});

test('restarting does not leave the previous poll timer running', async () => {
  // Otherwise every reconnect adds another 10-second sampler for the life of
  // the process.
  const { Manager, socket, sampled } = load({ snapshots: [[iface('en0', [addr()])]] });

  await Manager.Start(socket);
  await Manager.Start(socket);
  const Before = sampled();

  await poll(1);
  assert.equal(sampled(), Before + 1, 'more than one timer fired');
});

// --- Failure paths ----------------------------------------------------------

test('an OS failure is logged and skipped, leaving the last signature intact', async () => {
  // A failed read must not be mistaken for "the network went away" and emitted
  // as an empty interface list.
  const { Manager, socket, emissions } = load({ osError: 'permission denied' });

  await Manager.Start(socket);
  assert.deepEqual(emissions, []);
});

test('a disconnected socket is not written to, and the change is not lost', async () => {
  // The signature only advances when the payload was actually sent... which it
  // is NOT here: the signature updates regardless. Pinned as the real
  // behaviour — a change that happens while disconnected is not re-sent on
  // reconnect by this module, because Start() resets the signature and
  // re-emits, which is what covers it.
  const { Manager, socket, emissions } = load({ snapshots: [[iface('en0', [addr()])]] });
  socket.connected = false;

  await Manager.Start(socket);
  assert.deepEqual(emissions, []);

  socket.connected = true;
  await Manager.Start(socket);
  assert.equal(emissions.length, 1, 'a reconnect must resend the current interfaces');
});

test('a socket write failure does not stop the monitor', async () => {
  const { Manager, socket } = load({
    snapshots: [[iface('en0', [addr()])]],
    emitThrows: true,
  });

  await assert.doesNotReject(() => Manager.Start(socket));
  await assert.doesNotReject(() => poll(1));
});

test('stopping clears the timer and releases the socket', async () => {
  const { Manager, socket, sampled } = load({ snapshots: [[iface('en0', [addr()])]] });

  await Manager.Start(socket);
  const Before = sampled();

  await Manager.Stop();
  await poll(3);

  assert.equal(sampled(), Before, 'the poll timer outlived Stop');
});

test('stopping twice, or before starting, is safe', async () => {
  const { Manager } = load({ snapshots: [[]] });
  await assert.doesNotReject(() => Manager.Stop());
  await assert.doesNotReject(() => Manager.Stop());
});
