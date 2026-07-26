const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { loadWithMocks } = require('./test-helpers');

// Exercises the server-recovery state machine in src/main.ts.
//
// recovery-lifecycle.test.js already covers the happy path (primary fails →
// rediscover → reconnect → persist the new endpoint). This file covers the
// branches that decide what happens when recovery does NOT go cleanly, because
// that is where an unattended agent gets permanently stranded:
//
//   - discovery finds nothing            -> RecoveryFailed, then restart
//   - the discovered server rejects us   -> RecoveryFailed ('rejected')
//   - the connection never stabilises    -> RecoveryFailed ('timeout')
//   - a manually configured endpoint     -> skip mDNS entirely (VLAN case)
//   - IDENTITY MISMATCH                  -> skip that server, never adopt it
//
// The identity check is the one with real blast radius: on a shared LAN with
// more than one ShowTrak Server, adopting to the wrong one silently hands the
// machine to another operator's show.
//
// Everything is observed through the ServerRecoveryStatus payloads pushed to
// the renderer, which is also what the operator actually sees.

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'main.js');

/** The endpoint stored in the profile, i.e. the one that fails first. */
const PRIMARY_IP = '10.0.0.10';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until `predicate` holds, polling rather than sleeping a guessed duration.
 *
 * Recovery is an async chain (discovery -> address resolution -> connect ->
 * validate), so how long it takes is a property of the machine running the test,
 * not of the code. Fixed `await tick(80)` waits passed locally and failed every
 * time on a 2-core CI runner with test files running concurrently. Polling for
 * the condition is both faster in the normal case and immune to load.
 */
async function waitFor(predicate, description, timeoutMs = 5000) {
  const Deadline = Date.now() + timeoutMs;
  for (;;) {
    const Value = predicate();
    if (Value) return Value;
    if (Date.now() > Deadline) {
      const What = typeof description === 'function' ? description() : description;
      throw new Error(`Timed out waiting for ${What}`);
    }
    await tick(2);
  }
}

/**
 * The checkpoint for a test whose assertion is that something did NOT happen.
 *
 * A negative assertion has no event of its own to wait for, so it needs a
 * positive one first. `Discovering` is the right marker: it is pushed after the
 * primary has failed and the browser is live, so by then a candidate record has
 * been offered and "did we wrongly connect to it / persist it" is decidable.
 *
 * Deliberately NOT `ConnectingPrimary` — that is pushed BEFORE the primary is
 * known to have failed, so waiting on it proves nothing about discovery.
 */
function reachedDiscovery(H) {
  return () => H.states().includes('Discovering');
}

/**
 * Load main.js with a controllable environment.
 *
 * @param profile         the stored client profile (may carry ManualServer)
 * @param discover        records handed to the Bonjour OnFind callback
 * @param onCandidate     (broadcast, IP, Port) => void — what happens after
 *                        MainClient.Init for a NON-primary endpoint. Default:
 *                        the endpoint connects successfully.
 * @param primaryFailures how many times the primary refuses to connect before
 *                        it starts succeeding. Keeping this finite is what stops
 *                        RecoveryFailed -> restartService() -> Main() looping
 *                        forever and hanging the test process.
 */
function createHarness({ profile, discover = [], onCandidate, primaryFailures = 1 } = {}) {
  const broadcast = new EventEmitter();
  // The module registers a lot of listeners across reloads; the default cap
  // would emit spurious MaxListeners warnings.
  broadcast.setMaxListeners(0);

  const initCalls = [];
  const profileUpdates = [];
  const statuses = [];
  const bonjourStops = [];
  let currentProfile = JSON.parse(JSON.stringify(profile));
  let onFind = null;
  let primaryAttempts = 0;

  const fakeWindow = {
    webContents: {
      send: (channel, payload) => {
        if (channel === 'ServerRecoveryStatus') statuses.push(payload);
      },
      setWindowOpenHandler: () => {},
      on: () => {},
      getURL: () => 'app://index',
    },
    loadFile: () => {},
    isDestroyed: () => false,
    on: () => {},
    once: (_event, cb) => {
      if (typeof cb === 'function') cb();
    },
    isVisible: () => false,
    hide: () => {},
    show: () => {},
    focus: () => {},
    isMinimized: () => false,
    restore: () => {},
    minimize: () => {},
    removeAllListeners: () => {},
  };

  loadWithMocks(MODULE_PATH, {
    electron: {
      app: {
        requestSingleInstanceLock: () => true,
        quit: () => {},
        whenReady: () => Promise.resolve(),
        on: () => {},
        isPackaged: false,
        dock: { hide: () => {}, show: () => {} },
      },
      BrowserWindow: function BrowserWindow() {
        return fakeWindow;
      },
      Menu: { buildFromTemplate: () => ({}) },
      // Deliberately unavailable, on every platform.
      //
      // Recovery status is only pushed to an open window, and main.ts only
      // creates one when it CANNOT put an icon in the tray (with a tray, the
      // window appears when the operator opens it). So a working tray means
      // these statuses are computed and dropped, and there is nothing to
      // observe.
      //
      // This was previously implicit and only worked by accident: the
      // nativeImage stub below returned a resized image with no isEmpty(), so
      // tray creation threw on macOS and took the fallback path — while on
      // Linux the tray succeeded and every test in this file saw nothing at
      // all. Failing it explicitly makes the harness behave the same
      // everywhere.
      Tray: function Tray() {
        throw new Error('no system tray in this environment');
      },
      nativeImage: {
        createFromPath: () => ({
          isEmpty: () => false,
          resize: () => ({ isEmpty: () => false, setTemplateImage: () => {} }),
        }),
        createEmpty: () => ({ isEmpty: () => true }),
      },
      shell: { openExternal: () => {} },
      ipcMain: { handle: () => {} },
      autoUpdater: {
        on: () => {},
        setFeedURL: () => {},
        checkForUpdates: () => {},
        quitAndInstall: () => {},
      },
    },
    'electron-squirrel-startup': false,
    './Modules/Logger': {
      CreateLogger: () => ({
        log: () => {},
        warn: () => {},
        error: () => {},
        success: () => {},
      }),
    },
    './Modules/Startup': { Manager: { EnsureEnabled: async () => {} } },
    './Modules/Broadcast': { Manager: broadcast },
    './Modules/AppData': {
      Manager: {
        Initialize: () => {},
        GetLogsDirectory: () => '/tmp',
        OpenFolder: () => true,
      },
    },
    './Modules/ProfileManager': {
      Manager: {
        GetProfile: async () => currentProfile,
        UpdateServerEndpoint: async (IP, Port) => {
          currentProfile = { ...currentProfile, Server: { ...currentProfile.Server, IP, Port } };
          profileUpdates.push([IP, Port]);
        },
        ResetAdoption: async () => {
          currentProfile = { UUID: currentProfile.UUID, Adopted: false };
        },
      },
    },
    './Modules/Bonjour': {
      Manager: {
        OnFind: (cb) => {
          onFind = cb;
          for (const Record of discover) setTimeout(() => cb(Record), 0);
        },
        Stop: async () => {
          bonjourStops.push(Date.now());
        },
      },
    },
    './Modules/AdoptionClient': {
      Manager: { Init: async () => {}, Terminate: async () => {} },
    },
    './Modules/MainClient': {
      Manager: {
        Init: async (UUID, IP, Port) => {
          initCalls.push([UUID, IP, Port]);
          if (IP === PRIMARY_IP) {
            primaryAttempts += 1;
            // Fail once to trigger recovery, then succeed so restartService()
            // cannot spin forever and leave the test process alive.
            const Event =
              primaryAttempts <= primaryFailures
                ? ['ServerConnectFailed', { IP, Port, Error: 'ECONNREFUSED' }]
                : ['MainClientConnectionStatus', { State: 'connected', IP, Port }];
            setTimeout(() => broadcast.emit(Event[0], Event[1]), 0);
            return;
          }
          if (typeof onCandidate === 'function') {
            onCandidate(broadcast, IP, Port);
            return;
          }
          setTimeout(
            () => broadcast.emit('MainClientConnectionStatus', { State: 'connected', IP, Port }),
            0
          );
        },
        Terminate: async () => {},
      },
    },
    './Modules/ProcessMonitor': { Manager: { GetStatus: () => ({ State: 'ok' }) } },
    './Modules/Config': { Config: { Application: { Version: '1.0.0' } } },
    './Modules/Utils': { Wait: async () => {} },
    'node:dns': { promises: { lookup: async () => ({ address: '10.0.0.99' }) } },
  });

  return {
    broadcast,
    initCalls,
    profileUpdates,
    statuses,
    bonjourStops,
    /** Hand a Bonjour record to the live discovery callback. */
    deliver: (Record) => onFind && onFind(Record),
    /** Every recovery State pushed to the renderer, in order. */
    states: () => statuses.map((S) => S.State),
    /** The last status carrying the given State, if any. */
    lastStatus: (state) => [...statuses].reverse().find((S) => S.State === state) || null,
    /** The first status carrying the given State, if any. */
    firstStatus: (state) => statuses.find((S) => S.State === state) || null,
    /**
     * Resolve once the given State has been pushed at least once.
     *
     * Returns nothing: several states are pushed more than once per recovery, so
     * tests name firstStatus/lastStatus explicitly rather than relying on which
     * one a wait happens to hand back.
     */
    waitForState: async (state, timeoutMs) => {
      await waitFor(
        () => statuses.some((S) => S.State === state),
        () =>
          `recovery state "${state}" (saw: ${statuses.map((S) => S.State).join(' -> ') || 'nothing'})`,
        timeoutMs
      );
    },
  };
}

const ADOPTED_PROFILE = {
  UUID: 'client-uuid',
  Adopted: true,
  Server: { IP: PRIMARY_IP, Port: 3000, ServerIdentity: 'server-token-1' },
};

const GOOD_IP = '10.0.0.99';

/** A Bonjour record as the browser delivers it. */
function record({ address = GOOD_IP, port = 3000, identity = 'server-token-1', ...rest } = {}) {
  return {
    host: 'showtrak.local',
    port,
    addresses: address === null ? [] : [address],
    txt: identity === null ? {} : { ServerIdentity: identity },
    ...rest,
  };
}

/**
 * Let a stalled discovery finish by handing it a valid record.
 *
 * Discovery's own timeout is 12s. Tests that deliberately give it nothing
 * acceptable would otherwise sit through that timeout on every case, so once the
 * assertion is made we hand it a good record and let recovery complete.
 */
async function settleDiscovery(H) {
  H.deliver(record());
  await H.waitForState('Reconnected');
}

// --- Identity matching ------------------------------------------------------

test('a discovered server with a mismatched identity is skipped, not adopted', async () => {
  // The blast radius: on a LAN with two ShowTrak Servers, adopting to the wrong
  // one silently hands this machine to another operator's show.
  const H = createHarness({
    profile: ADOPTED_PROFILE,
    discover: [record({ address: '10.0.0.50', identity: 'someone-elses-server' })],
  });

  await waitFor(reachedDiscovery(H), 'discovery to start');

  assert.ok(
    !H.initCalls.map((C) => C[1]).includes('10.0.0.50'),
    'connected to a server with the wrong identity'
  );
  assert.deepEqual(H.profileUpdates, [], 'persisted an endpoint for the wrong server');

  await settleDiscovery(H);
});

test('a discovered server with no identity token is skipped when one is expected', async () => {
  const H = createHarness({
    profile: ADOPTED_PROFILE,
    discover: [record({ address: '10.0.0.50', identity: null })],
  });

  await waitFor(reachedDiscovery(H), 'discovery to start');
  assert.ok(!H.initCalls.map((C) => C[1]).includes('10.0.0.50'));
  assert.deepEqual(H.profileUpdates, []);

  await settleDiscovery(H);
});

test('the matching server is taken even when a mismatched one is discovered first', async () => {
  const H = createHarness({
    profile: ADOPTED_PROFILE,
    discover: [
      record({ address: '10.0.0.50', identity: 'someone-elses-server' }),
      record({ address: GOOD_IP, identity: 'server-token-1' }),
    ],
  });

  await H.waitForState('Reconnected');
  assert.deepEqual(H.profileUpdates, [[GOOD_IP, 3000]]);
});

// --- Discovery ---------------------------------------------------------------

test('discovery keeps the operator informed while it searches', async () => {
  const H = createHarness({ profile: ADOPTED_PROFILE, discover: [] });

  await H.waitForState('Discovering');
  const Discovering = H.lastStatus('Discovering');

  assert.ok(H.states().includes('PrimaryFailed'));
  assert.match(Discovering.Message, /Searching for Controlling Server/i);
  assert.deepEqual(H.profileUpdates, [], 'nothing should be persisted while still searching');

  await settleDiscovery(H);
});

test('discovery stops the Bonjour browser once a candidate is accepted', async () => {
  // Leaving the mDNS browser running holds a multicast socket open, which is
  // exactly what throws EADDRNOTAVAIL on the next interface change.
  const H = createHarness({ profile: ADOPTED_PROFILE, discover: [record()] });

  await H.waitForState('Reconnected');
  assert.ok(H.bonjourStops.length > 0, 'the Bonjour browser was left running');
});

// --- Validation failure -----------------------------------------------------

test('a server that rejects our adoption identity fails recovery explicitly', async () => {
  const H = createHarness({
    profile: ADOPTED_PROFILE,
    discover: [record()],
    onCandidate: (broadcast, IP, Port) => {
      setTimeout(() => broadcast.emit('ServerAdoptionRejected', { IP, Port }), 0);
    },
  });

  await H.waitForState('RecoveryFailed');
  const Failed = H.lastStatus('RecoveryFailed');
  assert.match(Failed.Message, /rejected adoption identity/i);
  assert.deepEqual(H.profileUpdates, [], 'a rejecting server must not be persisted');
});

test('a rejection for a different endpoint does not settle the validation', async () => {
  // Two servers can reject concurrently; only the candidate under validation
  // counts, or an unrelated rejection would abort a healthy recovery.
  const H = createHarness({
    profile: ADOPTED_PROFILE,
    discover: [record()],
    onCandidate: (broadcast, IP, Port) => {
      setTimeout(() => {
        broadcast.emit('ServerAdoptionRejected', { IP: '10.0.0.77', Port: 3000 });
        broadcast.emit('MainClientConnectionStatus', { State: 'connected', IP, Port });
      }, 0);
    },
  });

  await H.waitForState('Reconnected');
  assert.deepEqual(H.profileUpdates, [[GOOD_IP, 3000]]);
});

test('a stale connected status for the OLD primary does not validate the candidate', async () => {
  const H = createHarness({
    profile: ADOPTED_PROFILE,
    discover: [record()],
    primaryFailures: 1,
    onCandidate: (broadcast) => {
      setTimeout(
        () =>
          broadcast.emit('MainClientConnectionStatus', {
            State: 'connected',
            IP: PRIMARY_IP,
            Port: 3000,
          }),
        0
      );
    },
  });

  await H.waitForState('ValidatingIdentity');
  await tick(50); // give a wrong-endpoint validation the chance to land

  assert.ok(!H.states().includes('Reconnected'), 'validated against the wrong endpoint');
  assert.deepEqual(H.profileUpdates, []);
});

test('a non-connected status for the right endpoint does not validate either', async () => {
  const H = createHarness({
    profile: ADOPTED_PROFILE,
    discover: [record()],
    onCandidate: (broadcast, IP, Port) => {
      setTimeout(
        () => broadcast.emit('MainClientConnectionStatus', { State: 'connecting', IP, Port }),
        0
      );
    },
  });

  await H.waitForState('ValidatingIdentity');
  await tick(50); // give a premature validation the chance to land
  assert.ok(!H.states().includes('Reconnected'));
  assert.deepEqual(H.profileUpdates, []);
});

// --- Manually configured endpoint ------------------------------------------

test('a manually configured server is used directly, bypassing mDNS', async () => {
  // mDNS cannot cross VLANs, so an operator-set endpoint has to win over
  // discovery — otherwise a routed deployment can never self-recover.
  const H = createHarness({
    profile: { ...ADOPTED_PROFILE, ManualServer: { Host: '192.168.9.5', Port: 4000 } },
    discover: [record()],
  });

  await H.waitForState('Reconnected');

  // The configured endpoint is consulted during RECOVERY, not at boot — the
  // first ConnectingPrimary is still the saved server, which has to fail before
  // the manual endpoint is reached. So the property is that some attempt named
  // it, not which position that attempt was in.
  const Attempts = H.statuses.filter((S) => S.State === 'ConnectingPrimary');
  assert.ok(
    Attempts.some((S) => /192\.168\.9\.5:4000/.test(S.Message)),
    `the configured endpoint was never tried (saw: ${Attempts.map((S) => S.Message).join(' | ')})`
  );
  assert.deepEqual(H.profileUpdates, [['192.168.9.5', 4000]]);
  assert.ok(!H.initCalls.map((C) => C[1]).includes(GOOD_IP), 'discovery was consulted anyway');
});

test('an incomplete manual server falls back to discovery', async () => {
  for (const ManualServer of [{ Host: '192.168.9.5' }, { Port: 4000 }, {}]) {
    const H = createHarness({
      profile: { ...ADOPTED_PROFILE, ManualServer },
      discover: [record()],
    });

    await H.waitForState('Reconnected');
    assert.deepEqual(
      H.profileUpdates,
      [[GOOD_IP, 3000]],
      `ManualServer ${JSON.stringify(ManualServer)} did not fall back to discovery`
    );
  }
});

// --- Status reporting and metrics ------------------------------------------

test('recovery walks the operator through each state in order', async () => {
  const H = createHarness({ profile: ADOPTED_PROFILE, discover: [record()] });

  await H.waitForState('Reconnected');

  const States = H.states();
  let Cursor = -1;
  for (const Expected of ['PrimaryFailed', 'Discovering', 'ValidatingIdentity', 'Reconnected']) {
    const At = States.indexOf(Expected, Cursor + 1);
    assert.ok(At > Cursor, `${Expected} missing or out of order in ${States.join(' -> ')}`);
    Cursor = At;
  }
});

test('every status carries the metrics block the renderer renders', async () => {
  const H = createHarness({ profile: ADOPTED_PROFILE, discover: [record()] });

  await H.waitForState('Reconnected');

  assert.ok(H.statuses.length > 0);
  for (const Status of H.statuses) {
    assert.ok(Status.Metrics, 'a status was pushed without metrics');
    assert.equal(typeof Status.Metrics.Attempts, 'number');
    assert.equal(Status.Metrics.CooldownMs, 15000);
    assert.equal(Status.Metrics.MaxAttempts, null, 'recovery is deliberately unbounded');
  }
});

test('a successful recovery resets the failure metrics', async () => {
  // Attempts must go back to zero, or the exponential backoff would keep growing
  // across unrelated future outages.
  const H = createHarness({ profile: ADOPTED_PROFILE, discover: [record()] });

  await H.waitForState('Reconnected');
  const Reconnected = H.lastStatus('Reconnected');
  assert.equal(Reconnected.Metrics.Attempts, 0);
  assert.equal(Reconnected.Metrics.LastFailureAt, 0);
  assert.equal(Reconnected.Metrics.LastFailureReason, null);
  assert.ok(Reconnected.Metrics.LastRecoveredAt > 0);
  assert.match(Reconnected.Message, /Recovered connection to 10\.0\.0\.99:3000/);
});

test('the first failure reports attempt 1 and names the unreachable primary', async () => {
  const H = createHarness({ profile: ADOPTED_PROFILE, discover: [record()] });

  await waitFor(reachedDiscovery(H), 'the primary to fail and discovery to start');

  const First = H.firstStatus('PrimaryFailed');
  assert.match(First.Message, /10\.0\.0\.10:3000 is unreachable/);
  assert.match(First.Message, /Retry attempt 1/);
  assert.equal(First.Metrics.Attempts, 1);
});

// --- Address resolution -----------------------------------------------------

test('a record with no IPv4 address falls back to the referer address', async () => {
  const H = createHarness({
    profile: ADOPTED_PROFILE,
    discover: [record({ address: null, referer: { address: GOOD_IP } })],
  });

  await H.waitForState('Reconnected');
  assert.deepEqual(H.profileUpdates, [[GOOD_IP, 3000]]);
});

test('an IPv6-only record falls back to a DNS lookup of the host', async () => {
  // The mock resolver answers 10.0.0.99 for any host.
  const H = createHarness({
    profile: ADOPTED_PROFILE,
    discover: [record({ address: 'fe80::1' })],
  });

  await H.waitForState('Reconnected');
  assert.deepEqual(H.profileUpdates, [[GOOD_IP, 3000]]);
});

test('a record with no resolvable address at all is skipped', async () => {
  const H = createHarness({
    profile: ADOPTED_PROFILE,
    discover: [record({ address: null, host: '' })],
  });

  await waitFor(reachedDiscovery(H), 'discovery to start');
  assert.deepEqual(H.profileUpdates, []);

  await settleDiscovery(H);
});
