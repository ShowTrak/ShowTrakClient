const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

// Exercises src/Modules/Bonjour/index.ts — how an unadopted or recovering client
// finds its server.
//
// The file was 76% lines but **19% branches**: the happy path was walked, and
// essentially none of the fallbacks were. That is the wrong way round for this
// module, because every branch in it exists because mDNS failed somewhere real:
//
//   - the per-interface fallback exists because a multi-homed machine (a show PC
//     with a control NIC and a media NIC) often browses on the wrong one;
//   - the `__found` latch exists because the primary browser and a fallback
//     browser can match the same server within milliseconds of each other, and a
//     second callback would drive the whole adoption/recovery state machine a
//     second time;
//   - the cleanup on success exists because every browser left running holds a
//     multicast socket open, which is exactly what throws EADDRNOTAVAIL on the
//     next interface change (see network-errors-and-guards.test.js).
//
// The module is also written defensively — nearly every statement sits in its
// own try/catch — so the property under test throughout is that a failure in one
// step never stops the others. Discovery has to keep working on a machine where
// something about the network stack is already broken.

const BONJOUR_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'Bonjour', 'index.js');

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

/** A discovered ShowTrak server as bonjour hands it over. */
function service(Overrides = {}) {
  return {
    name: 'ShowTrak',
    fqdn: 'ShowTrak._showtrak._tcp.local',
    host: 'server.local',
    port: 3000,
    type: 'showtrak',
    txt: { ServerIdentity: 'token' },
    addresses: ['10.0.0.10'],
    ...Overrides,
  };
}

/**
 * A `bonjour` factory stub. Every instance and browser it produces is recorded,
 * with its stop/destroy counts, so a test can assert that discovery released
 * what it opened.
 */
function makeBonjour(Options = {}) {
  const {
    createThrows = false,
    findOneThrows = false,
    startThrows = false,
    stopThrows = false,
    destroyThrows = false,
  } = Options;

  const factory = (opts) => {
    if (createThrows) throw new Error('EADDRINUSE: mdns socket');

    const Instance = {
      opts,
      destroyed: 0,
      browsers: [],
      findOne(query, cb) {
        if (findOneThrows) throw new Error('cannot browse');
        const Browser = makeBrowser(query, cb);
        Instance.browsers.push(Browser);
        factory.browsers.push(Browser);
        return Browser;
      },
      find(query) {
        const Browser = makeBrowser(query, null);
        factory.diagnosticBrowsers.push(Browser);
        return Browser;
      },
      destroy() {
        if (destroyThrows) throw new Error('already destroyed');
        Instance.destroyed += 1;
      },
    };
    factory.instances.push(Instance);
    return Instance;
  };

  function makeBrowser(query, cb) {
    const Browser = {
      query,
      services: [],
      starts: 0,
      stops: 0,
      updates: 0,
      removedListeners: 0,
      handlers: {},
      /** Hand this browser a matching service, as the real one would. */
      match: (svc) => cb && cb(svc),
      start() {
        if (startThrows) throw new Error('socket not ready');
        Browser.starts += 1;
      },
      stop() {
        if (stopThrows) throw new Error('socket already closed');
        Browser.stops += 1;
      },
      update() {
        Browser.updates += 1;
      },
      on(event, fn) {
        Browser.handlers[event] = fn;
      },
      removeAllListeners() {
        Browser.removedListeners += 1;
      },
    };
    return Browser;
  }

  factory.instances = [];
  factory.browsers = [];
  factory.diagnosticBrowsers = [];
  return factory;
}

const INTERFACES = {
  lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
  en0: [
    { family: 'IPv4', internal: false, address: '10.0.0.50' },
    { family: 'IPv6', internal: false, address: 'fe80::1' },
  ],
  en1: [{ family: 'IPv4', internal: false, address: '192.168.1.50' }],
  awdl0: null, // os really can return an undefined entry
};

function load({ bonjourMock, interfaces = INTERFACES } = {}) {
  const Bonjour = bonjourMock || makeBonjour();
  const Mod = loadWithMocks(BONJOUR_PATH, {
    bonjour: Bonjour,
    os: { networkInterfaces: () => interfaces },
    '../Logger': loggerStub,
  });
  return { Manager: Mod.Manager, Bonjour };
}

/**
 * Advance the fake clock and let the timer's own async work settle.
 *
 * The 10s discovery timeout is an async callback that awaits the diagnostic
 * browse before launching the fallback, so a bare tick() returns before the
 * fallback exists.
 */
async function advance(Ms) {
  mock.timers.tick(Ms);
  await new Promise((R) => setImmediate(R));
}

/** Every test drives the module's real timers, so fake them throughout. */
test.beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
});
test.afterEach(() => {
  mock.timers.reset();
});

// --- Starting a browse ------------------------------------------------------

test('OnFind opens one browser for the showtrak service type', () => {
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});

  assert.equal(Bonjour.instances.length, 1);
  assert.deepEqual(Bonjour.instances[0].opts, { reuseAddr: true, loopback: true });
  assert.equal(Bonjour.browsers.length, 1);
  assert.deepEqual(Bonjour.browsers[0].query, { type: 'showtrak' });
  assert.equal(Bonjour.browsers[0].starts, 1);
});

test('a second OnFind reuses the instance and replaces the browser', () => {
  // A second instance would open a second multicast socket on the same port —
  // and OnFind is called again on every reconnect attempt, so this would leak
  // one per attempt on a machine that cannot reach its server.
  const { Manager, Bonjour } = load();

  Manager.OnFind(() => {});
  const [First] = Bonjour.browsers;
  Manager.OnFind(() => {});

  assert.equal(Bonjour.instances.length, 1, 'a second bonjour instance was created');
  assert.equal(Bonjour.browsers.length, 2);
  assert.equal(First.stops, 1, 'the previous browser was left running');
  assert.equal(First.removedListeners, 1, 'the previous browser kept its listeners');
});

test('an instance that cannot be created leaves discovery inert, not crashed', () => {
  // The client must still boot: an agent that is up but undiscovered can be
  // reached by a manually configured endpoint; one that crashed cannot.
  const { Manager, Bonjour } = load({ bonjourMock: makeBonjour({ createThrows: true }) });

  assert.doesNotThrow(() => Manager.OnFind(() => {}));
  assert.equal(Bonjour.browsers.length, 0);
});

test('a browser that cannot be created leaves discovery inert', () => {
  const { Manager } = load({ bonjourMock: makeBonjour({ findOneThrows: true }) });
  assert.doesNotThrow(() => Manager.OnFind(() => {}));
});

test('a browser that will not start still gets its refresh timers', () => {
  // start() throwing is a transient socket condition; the periodic update is
  // what recovers from it, so it must still be scheduled.
  const { Manager, Bonjour } = load({ bonjourMock: makeBonjour({ startThrows: true }) });
  Manager.OnFind(() => {});

  mock.timers.tick(5000);
  assert.ok(Bonjour.browsers[0].updates > 0, 'no refresh was scheduled after a failed start');
});

test('the browser is nudged immediately and then refreshed periodically', () => {
  // Servers that were already advertising before this client started do not
  // re-announce, so a browse that only waits passively can sit silent forever.
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});
  const [Browser] = Bonjour.browsers;

  mock.timers.tick(100);
  assert.equal(Browser.updates, 1, 'no initial nudge');

  mock.timers.tick(5000);
  mock.timers.tick(5000);
  assert.equal(Browser.updates, 3);
});

// --- Finding a server -------------------------------------------------------

test('a match is handed to the callback', () => {
  const { Manager, Bonjour } = load();
  const Found = [];
  Manager.OnFind((S) => Found.push(S));

  Bonjour.browsers[0].match(service());

  assert.equal(Found.length, 1);
  assert.equal(Found[0].host, 'server.local');
});

test('a match releases every socket and timer discovery opened', () => {
  // Each surviving browser holds a multicast socket. Leaving them open is what
  // turns the next NIC change into an EADDRNOTAVAIL storm.
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});
  const [Browser] = Bonjour.browsers;

  Browser.match(service());

  assert.equal(Browser.stops, 1);
  assert.equal(Browser.removedListeners, 1);

  // No timer may still be armed: an update tick against a stopped browser, or a
  // fallback launched after the server was already found, is pure waste.
  Browser.updates = 0;
  mock.timers.tick(60_000);
  assert.equal(Browser.updates, 0, 'the refresh interval outlived discovery');
  assert.equal(Bonjour.instances.length, 1, 'the fallback launched after a successful find');
});

test('the callback fires exactly once even when several browsers match', async () => {
  // The real race: the primary browser and a per-interface fallback browser both
  // see the same announcement. A second callback would re-enter adoption or
  // recovery with a stale candidate.
  const { Manager, Bonjour } = load();
  const Found = [];
  Manager.OnFind((S) => Found.push(S));

  await advance(10_000); // arm the fallback so there are extra browsers
  assert.ok(Bonjour.browsers.length > 1);

  for (const Browser of Bonjour.browsers) Browser.match(service());

  assert.equal(Found.length, 1, `callback fired ${Found.length} times`);
});

test('a throwing callback does not escape discovery', () => {
  // finalizeFound has already torn down its browsers by the time the callback
  // runs; letting the throw out would abandon the rest of the cleanup and, in
  // the main process, hit the uncaught-exception guard.
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {
    throw new Error('handler blew up');
  });

  assert.doesNotThrow(() => Bonjour.browsers[0].match(service()));
});

test('a browser that will not stop does not block the rest of the cleanup', () => {
  const { Manager, Bonjour } = load({ bonjourMock: makeBonjour({ stopThrows: true }) });
  const Found = [];
  Manager.OnFind((S) => Found.push(S));

  Bonjour.browsers[0].match(service());
  assert.equal(Found.length, 1, 'the callback was skipped because teardown threw');
});

// --- The per-interface fallback --------------------------------------------

test('nothing found within 10s launches a browse bound to each external IPv4 NIC', async () => {
  // The case this exists for: a show PC with a control NIC and a media NIC,
  // where the default multicast route goes out the wrong one.
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});

  await advance(10_000);

  const Bound = Bonjour.instances.slice(1).map((I) => I.opts.interface);
  // Two service-type spellings are tried per interface.
  assert.deepEqual(Bound, ['10.0.0.50', '10.0.0.50', '192.168.1.50', '192.168.1.50']);
  assert.ok(!Bound.includes('127.0.0.1'), 'bound to the loopback interface');
  assert.ok(!Bound.includes('fe80::1'), 'bound to an IPv6 address');
});

test('the fallback tries the legacy capitalised service type too', async () => {
  // Older servers advertised "ShowTrak"; mDNS type matching is case-sensitive in
  // some stacks, so a mixed-version rig needs both.
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});
  await advance(10_000);

  const Types = Bonjour.browsers.slice(1).map((B) => B.query.type);
  assert.deepEqual(new Set(Types), new Set(['showtrak', 'ShowTrak']));
  for (const Browser of Bonjour.browsers.slice(1)) {
    assert.equal(Browser.query.protocol, 'tcp');
  }
});

test('a fallback browser can be the one that finds the server', async () => {
  const { Manager, Bonjour } = load();
  const Found = [];
  Manager.OnFind((S) => Found.push(S));

  await advance(10_000);
  const Fallback = Bonjour.browsers[Bonjour.browsers.length - 1];
  Fallback.match(service({ host: 'media-net.local' }));

  assert.equal(Found.length, 1);
  assert.equal(Found[0].host, 'media-net.local');
});

test('a successful fallback destroys every per-interface instance it opened', async () => {
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});
  await advance(10_000);

  Bonjour.browsers[1].match(service());

  for (const Instance of Bonjour.instances.slice(1)) {
    assert.equal(Instance.destroyed, 1, 'a per-interface instance was left holding its socket');
  }
  assert.equal(Bonjour.instances[0].destroyed, 0, 'the shared instance must survive a find');
});

test('the fallback is launched at most once', async () => {
  // The 10s timer is cleared when it fires, but the latch is the real guard —
  // without it a long outage would stack a browse per interface per attempt.
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});

  await advance(10_000);
  const After = Bonjour.instances.length;
  await advance(60_000);

  assert.equal(Bonjour.instances.length, After);
});

test('a machine with no usable interfaces still ends the fallback cleanly', async () => {
  const { Manager, Bonjour } = load({
    interfaces: { lo0: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }] },
  });
  Manager.OnFind(() => {});

  await assert.doesNotReject(() => advance(10_000));
  assert.equal(Bonjour.instances.length, 1);
  await assert.doesNotReject(() => advance(10_000));
});

test('an interface that cannot be bound does not stop the others being tried', async () => {
  // Binding to a specific address fails on interfaces that came up without one,
  // or that disappear between enumeration and bind.
  const Bonjour = makeBonjour();
  const Real = Bonjour;
  let Calls = 0;
  const Flaky = (opts) => {
    Calls += 1;
    if (Calls === 2) throw new Error('EADDRNOTAVAIL');
    return Real(opts);
  };
  Flaky.instances = Real.instances;
  Flaky.browsers = Real.browsers;
  Flaky.diagnosticBrowsers = Real.diagnosticBrowsers;

  const Mod = loadWithMocks(BONJOUR_PATH, {
    bonjour: Flaky,
    os: { networkInterfaces: () => INTERFACES },
    '../Logger': loggerStub,
  });

  Mod.Manager.OnFind(() => {});
  await assert.doesNotReject(() => advance(10_000));
  assert.equal(Real.instances.length, 4, 'the remaining interfaces were abandoned');
});

test('an unreadable interface list does not throw out of the timer', async () => {
  const Mod = loadWithMocks(BONJOUR_PATH, {
    bonjour: makeBonjour(),
    os: {
      networkInterfaces: () => {
        throw new Error('sysctl failed');
      },
    },
    '../Logger': loggerStub,
  });

  Mod.Manager.OnFind(() => {});
  await assert.doesNotReject(() => advance(10_000));
});

test('the timeout also runs a service-type diagnostic browse', async () => {
  // Its only job is to put the advertised types in the log; it must clean itself
  // up rather than leaving another socket open.
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});
  await advance(10_000);

  const [Diag] = Bonjour.diagnosticBrowsers;
  assert.deepEqual(Diag.query, { type: '_services._dns-sd._udp', protocol: 'udp' });
  assert.equal(Diag.starts, 1);

  mock.timers.tick(3000);
  assert.equal(Diag.stops, 1, 'the diagnostic browse was left running');
});

// --- The log-only listeners -------------------------------------------------

test('the socket listeners tolerate whatever the library hands them', async () => {
  // These four handlers only write to the log, but they are attached to the
  // multicast socket's own event paths — the ones that fire when the network is
  // already misbehaving. A throw from any of them lands in the main process's
  // uncaughtException guard rather than anywhere it can be handled, so the
  // property worth pinning is simply that they never throw, on any shape.
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});

  const Down = Bonjour.browsers[0].handlers.down;
  for (const Svc of [service(), { host: 'a.local' }, {}, null, undefined]) {
    assert.doesNotThrow(() => Down(Svc), `down handler threw on ${JSON.stringify(Svc)}`);
  }

  await advance(10_000);

  const [Diag] = Bonjour.diagnosticBrowsers;
  for (const Svc of [{ name: 'AirPlay' }, {}, null]) {
    assert.doesNotThrow(() => Diag.handlers.up(Svc));
  }
  assert.doesNotThrow(() => Diag.handlers.error(new Error('mdns socket closed')));

  const Fallback = Bonjour.browsers[Bonjour.browsers.length - 1];
  assert.doesNotThrow(() => Fallback.handlers.error(new Error('EADDRNOTAVAIL')));
});

test('a diagnostic browse that cannot start does not stop the fallback launching', async () => {
  const Bonjour = makeBonjour();
  const Instances = Bonjour.instances;
  const Wrapped = (opts) => {
    const Instance = Bonjour(opts);
    if (Instances.length === 1) {
      Instance.find = () => {
        throw new Error('cannot browse service types');
      };
    }
    return Instance;
  };
  Wrapped.instances = Bonjour.instances;
  Wrapped.browsers = Bonjour.browsers;
  Wrapped.diagnosticBrowsers = Bonjour.diagnosticBrowsers;

  const Mod = loadWithMocks(BONJOUR_PATH, {
    bonjour: Wrapped,
    os: { networkInterfaces: () => INTERFACES },
    '../Logger': loggerStub,
  });

  Mod.Manager.OnFind(() => {});
  await advance(10_000);

  assert.equal(Bonjour.instances.length, 5, 'the fallback was abandoned when diagnostics threw');
});

// --- Stop and Terminate -----------------------------------------------------

test('Stop releases the browser and every timer', async () => {
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});
  const [Browser] = Bonjour.browsers;

  await Manager.Stop();

  assert.equal(Browser.stops, 1);
  assert.equal(Browser.removedListeners, 1);

  Browser.updates = 0;
  mock.timers.tick(60_000);
  assert.equal(Browser.updates, 0, 'the refresh interval survived Stop');
  assert.equal(Bonjour.instances.length, 1, 'the fallback fired after Stop');
});

test('Stop keeps the shared instance so the next browse can reuse it', async () => {
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});
  await Manager.Stop();
  Manager.OnFind(() => {});

  assert.equal(Bonjour.instances.length, 1);
  assert.equal(Bonjour.instances[0].destroyed, 0);
});

test('Stop clears the found latch so a later browse can still fire', async () => {
  // Recovery calls Stop between attempts. A latch that stayed set would make
  // every subsequent discovery silently drop its result.
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});
  Bonjour.browsers[0].match(service());

  await Manager.Stop();

  const Found = [];
  Manager.OnFind((S) => Found.push(S));
  Bonjour.browsers[Bonjour.browsers.length - 1].match(service());

  assert.equal(Found.length, 1, 'discovery stayed latched after Stop');
});

test('Stop tears down the per-interface fallback as well', async () => {
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});
  await advance(10_000);

  await Manager.Stop();

  for (const Instance of Bonjour.instances.slice(1)) {
    assert.equal(Instance.destroyed, 1);
  }
  for (const Browser of Bonjour.browsers.slice(1)) {
    assert.equal(Browser.stops, 1);
  }
});

test('Stop after a fallback lets a later browse relaunch it', async () => {
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});
  await advance(10_000);
  await Manager.Stop();

  const Before = Bonjour.instances.length;
  Manager.OnFind(() => {});
  await advance(10_000);

  assert.ok(Bonjour.instances.length > Before, 'the fallback latch was never cleared');
});

test('Terminate destroys the shared instance too', async () => {
  const { Manager, Bonjour } = load();
  Manager.OnFind(() => {});

  await Manager.Terminate();

  assert.equal(Bonjour.instances[0].destroyed, 1);
});

test('Terminate on a client that never browsed is a no-op', async () => {
  // Shutdown runs it unconditionally, including on a client whose network came
  // up too late for discovery to have started.
  const { Manager, Bonjour } = load();
  await assert.doesNotReject(() => Manager.Terminate());
  assert.equal(Bonjour.instances.length, 0);
});

test('Stop and Terminate are safe to call repeatedly', async () => {
  const { Manager } = load();
  Manager.OnFind(() => {});

  await Manager.Stop();
  await Manager.Stop();
  await Manager.Terminate();
  await assert.doesNotReject(() => Manager.Terminate());
});

test('teardown completes even when every release step throws', async () => {
  // Quit must not be able to wedge on a broken socket.
  const { Manager, Bonjour } = load({
    bonjourMock: makeBonjour({ stopThrows: true, destroyThrows: true }),
  });
  Manager.OnFind(() => {});
  await advance(10_000);

  await assert.doesNotReject(() => Manager.Terminate());

  // A later browse must still work, which proves the module state was reset
  // rather than left half torn down.
  Manager.OnFind(() => {});
  const Found = [];
  Manager.OnFind((S) => Found.push(S));
  Bonjour.browsers[Bonjour.browsers.length - 1].match(service());
  assert.equal(Found.length, 1);
});
