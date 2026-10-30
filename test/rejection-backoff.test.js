const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// An adopted client whose saved address answers as a DIFFERENT ShowTrak Server
// used to restart straight back into the same rejection, ~80 times a second.

const { RejectionBackoff, RESET_MS } = require(
  path.join(__dirname, '..', 'dist', 'main', 'rejection-backoff.js')
);

test('restart waits grow from 2 s to a 30 s cap', () => {
  const B = new RejectionBackoff();
  const Delays = [];
  for (let I = 0; I < 7; I++) Delays.push(B.NextDelayMs(1000 + I));
  assert.deepEqual(Delays, [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('a quiet spell starts the waits again from the shortest', () => {
  const B = new RejectionBackoff();
  B.NextDelayMs(0);
  B.NextDelayMs(1);
  assert.equal(B.NextDelayMs(1 + RESET_MS + 1), 2000);
});

// --- restartServiceAfter -----------------------------------------------------

function loadLifecycle(calls) {
  return loadWithMocks(path.join(__dirname, '..', 'dist', 'main', 'service-lifecycle.js'), {
    '../Modules/Logger': { CreateLogger: () => createSilentLogger() },
    '../Modules/AdoptionClient': {
      Manager: { Terminate: async () => calls.push('adoption-stop') },
    },
    '../Modules/Bonjour': { Manager: { Stop: async () => {} } },
    '../Modules/MainClient': {
      Manager: { Terminate: async () => calls.push('main-stop'), Init: async () => {} },
    },
    '../Modules/ProfileManager': {
      Manager: { GetProfile: async () => (calls.push('boot'), { UUID: 'u', Adopted: false }) },
    },
    './discovery': { discoverSingleServer: async () => null },
    './recovery-status': { sendRecoveryStatus: () => {} },
  });
}

test('a delayed restart runs once, however many times it is asked for meanwhile', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const L = loadLifecycle(calls);
  L.restartServiceAfter('x', 2000);
  L.restartServiceAfter('x', 2000);
  L.restartServiceAfter('x', 500);
  t.mock.timers.tick(1999);
  assert.deepEqual(calls, []);
  t.mock.timers.tick(1);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((C) => C === 'main-stop').length, 1);
  L.stopService();
});

test('another restart, or stopping, cancels a pending delayed restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const L = loadLifecycle(calls);
  L.restartServiceAfter('x', 2000);
  await L.restartService('profile-changed');
  const AfterDirect = calls.filter((C) => C === 'main-stop').length;
  t.mock.timers.tick(5000);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((C) => C === 'main-stop').length, AfterDirect, 'superseded');

  L.restartServiceAfter('x', 2000);
  L.stopService();
  t.mock.timers.tick(5000);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.filter((C) => C === 'main-stop').length, AfterDirect, 'stopped');
});
