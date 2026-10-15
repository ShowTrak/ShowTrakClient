// Unadopted discovery retry (src/main/service-lifecycle.ts).
//
// An unadopted client searches mDNS for 12s. It used to search exactly once and
// then report failure forever, so a client powered on before its server — the
// normal order on a show rig — never appeared for adoption until somebody
// restarted it by hand. It now searches again on a backoff.
//
// The retry has to stop cleanly too, or it becomes the bug: a restart (adoption,
// a manual endpoint, a factory reset) must cancel it and reset the backoff, and
// quitting must stop it for good. A discovery still in flight from an older boot
// must not act on its result either.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'main', 'service-lifecycle.js');

/** Let pending promise chains run (setImmediate is not mocked). */
async function flush(times = 5) {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Load service-lifecycle with a scripted discovery.
 *
 * `results` is consumed one entry per search: null for "nothing found", a
 * candidate object, or a function returning a promise (for a search the test
 * controls). Once exhausted every search finds nothing.
 */
function createHarness({ profile = { UUID: 'client-uuid', Adopted: false }, results = [] } = {}) {
  const statuses = [];
  const searches = [];
  const adoptionInits = [];
  const mainInits = [];
  const queue = results.slice();
  let currentProfile = profile;

  const mod = loadWithMocks(MODULE_PATH, {
    '../Modules/Logger': { CreateLogger: () => createSilentLogger() },
    '../Modules/AdoptionClient': {
      Manager: {
        Init: async (...args) => {
          adoptionInits.push(args);
        },
        Terminate: async () => {},
      },
    },
    '../Modules/Bonjour': { Manager: { Stop: async () => {} } },
    '../Modules/MainClient': {
      Manager: {
        Init: async (...args) => {
          mainInits.push(args);
        },
        Terminate: async () => {},
      },
    },
    '../Modules/ProfileManager': { Manager: { GetProfile: async () => currentProfile } },
    './discovery': {
      discoverSingleServer: async (timeoutMs) => {
        searches.push(timeoutMs);
        const Next = queue.length ? queue.shift() : null;
        return typeof Next === 'function' ? Next() : Next;
      },
    },
    './recovery-status': {
      sendRecoveryStatus: (payload) => statuses.push(payload),
    },
  });

  return {
    ...mod,
    statuses,
    searches,
    adoptionInits,
    mainInits,
    setProfile: (next) => {
      currentProfile = next;
    },
    messages: () => statuses.map((S) => S.Message),
    lastMessage: () => (statuses.length ? statuses[statuses.length - 1].Message : null),
  };
}

const CANDIDATE = { IP: '10.0.0.99', Port: 3000, ServerIdentity: 'server-token-1' };

test('finding nothing schedules another search instead of giving up', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const H = createHarness({ results: [null, null, CANDIDATE] });

  await H.Main();
  await flush();
  assert.equal(H.searches.length, 1);
  assert.equal(H.lastMessage(), 'No ShowTrak Server found. Retrying in 5s…');
  assert.equal(H.statuses.at(-1).State, 'Discovering', 'a pending retry is not a failure');
  assert.ok(!H.statuses.some((S) => S.State === 'RecoveryFailed'));

  t.mock.timers.tick(4999);
  await flush();
  assert.equal(H.searches.length, 1, 'searched again before the backoff elapsed');

  t.mock.timers.tick(1);
  await flush();
  assert.equal(H.searches.length, 2);
  // Each retry announces the search it is running, then backs off further.
  assert.ok(H.messages().includes('Searching for ShowTrak Server for adoption…'));
  assert.equal(H.lastMessage(), 'No ShowTrak Server found. Retrying in 10s…');

  t.mock.timers.tick(10000);
  await flush();
  assert.equal(H.searches.length, 3);
  assert.deepEqual(H.adoptionInits, [
    ['client-uuid', '10.0.0.99', 3000, { ServerIdentity: 'server-token-1' }],
  ]);

  // Found: nothing further is scheduled.
  t.mock.timers.tick(120000);
  await flush();
  assert.equal(H.searches.length, 3);
});

test('the backoff doubles up to a 30s ceiling', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const H = createHarness();

  await H.Main();
  await flush();
  const Delays = [];
  for (let i = 0; i < 6; i += 1) {
    const Match = /Retrying in (\d+)s…/.exec(H.lastMessage());
    Delays.push(Number(Match[1]));
    t.mock.timers.tick(Number(Match[1]) * 1000);
    await flush();
  }
  assert.deepEqual(Delays, [5, 10, 20, 30, 30, 30]);
  assert.equal(H.DISCOVERY_RETRY_MAX_MS, 30000);
});

test('stopping the service cancels a pending retry for good', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const H = createHarness();

  await H.Main();
  await flush();
  assert.equal(H.searches.length, 1);

  H.stopService();
  t.mock.timers.tick(120000);
  await flush();
  assert.equal(H.searches.length, 1, 'searched again after the app began quitting');

  // Nothing can boot again after a stop, restart included.
  await H.restartService('after-quit');
  await H.Main();
  await flush();
  assert.equal(H.searches.length, 1);
});

test('a restart cancels the pending retry and resets the backoff', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const H = createHarness();

  await H.Main();
  await flush();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(H.lastMessage(), 'No ShowTrak Server found. Retrying in 10s…');
  assert.equal(H.searches.length, 2);

  await H.restartService('manual-server-clear');
  await flush();
  assert.equal(H.searches.length, 3, 'the restart searches straight away');
  assert.equal(H.lastMessage(), 'No ShowTrak Server found. Retrying in 5s…');

  // Only the restart's own retry is pending; the old 10s one was cancelled.
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(H.searches.length, 4);
});

test('adoption while a retry is pending stops the searching', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const H = createHarness();

  await H.Main();
  await flush();

  // The adoption flow ends in ReinitializeService -> restartService with an
  // adopted profile.
  H.setProfile({
    UUID: 'client-uuid',
    Adopted: true,
    Server: { IP: '10.0.0.99', Port: 3000 },
  });
  await H.restartService('external-reinitialize');
  await flush();
  assert.deepEqual(H.mainInits, [['client-uuid', '10.0.0.99', 3000]]);

  t.mock.timers.tick(120000);
  await flush();
  assert.equal(H.searches.length, 1, 'kept searching after adoption');
});

test('a search still in flight from an older boot is ignored when it returns', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const H = createHarness({
    results: [() => new Promise((resolve) => (release = resolve))],
  });

  const FirstBoot = H.Main();
  await flush();
  assert.equal(H.searches.length, 1);

  // Quit while the search is still running, then let it find a server.
  H.stopService();
  release(CANDIDATE);
  await FirstBoot;
  await flush();

  assert.deepEqual(H.adoptionInits, [], 'adopted on behalf of a stopped service');
  assert.ok(!H.messages().some((M) => /Retrying/.test(M)), 'scheduled a retry after stop');
});

test('a manually configured endpoint is used without any discovery', async () => {
  const H = createHarness({
    profile: {
      UUID: 'client-uuid',
      Adopted: false,
      ManualServer: { Host: '10.1.1.1', Port: 4000 },
    },
  });

  await H.Main();
  assert.equal(H.searches.length, 0);
  assert.deepEqual(H.adoptionInits, [['client-uuid', '10.1.1.1', 4000, { ServerIdentity: null }]]);
  assert.equal(H.lastMessage(), 'Connecting to configured server 10.1.1.1:4000 for adoption…');
});
