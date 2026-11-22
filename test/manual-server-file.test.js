// ManualServer.json: the operator-configured server endpoint, read back by
// ProfileManager.GetManualServer() and attached to every profile it returns.
//
// A client with a manual endpoint connects to it instead of discovering a
// server over Bonjour, so a damaged file must read as "no manual endpoint"
// (null), which falls back to discovery, rather than as an endpoint that was
// never configured or as an exception out of GetProfile().

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'ProfileManager', 'index.js');

/** A fresh ProfileManager over a profile dir holding `Contents` as ManualServer.json. */
function withManualServerFile(Contents) {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-manual-server-'));
  if (Contents !== undefined) {
    fs.writeFileSync(path.join(profileRoot, 'ManualServer.json'), Contents);
  }
  const errors = [];
  const { Manager } = loadWithMocks(MODULE_PATH, {
    '../Logger': {
      CreateLogger: () => createSilentLogger({ error: (...args) => errors.push(args) }),
    },
    '../AppData': {
      Manager: { Initialize: () => {}, GetProfileDirectory: () => profileRoot },
    },
    '../Broadcast': { Manager: { emit: () => {} } },
    '../HardwareIdentity': {
      Manager: {
        Resolve: async () => ({ UUID: 'uuid-machine', Source: 'firmware', Witness: 'fw' }),
      },
    },
  });
  return { Manager, errors };
}

test('a stored endpoint is read back, normalized', async () => {
  const { Manager, errors } = withManualServerFile(
    JSON.stringify({ Host: ' 10.20.30.40 ', Port: '3000' })
  );
  assert.deepEqual(await Manager.GetManualServer(), { Host: '10.20.30.40', Port: 3000 });
  assert.deepEqual((await Manager.GetProfile()).ManualServer, {
    Host: '10.20.30.40',
    Port: 3000,
  });
  assert.deepEqual(errors, []);
});

test('no file means no manual endpoint', async () => {
  const { Manager } = withManualServerFile(undefined);
  assert.equal(await Manager.GetManualServer(), null);
  assert.equal((await Manager.GetProfile()).ManualServer, undefined);
});

test('an unparseable file means no manual endpoint, and is logged', async () => {
  const { Manager, errors } = withManualServerFile('{"Host": "10.20.30.40", "Po');
  assert.equal(await Manager.GetManualServer(), null);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /Failed to read ManualServer\.json/);
});

test('JSON of the wrong shape means no manual endpoint, without an error', async () => {
  // These parse, so none of them reach the error above; each has to come out
  // as null on its own, as it did before JSON.parse was typed.
  for (const Contents of [
    'null',
    '0',
    '"10.20.30.40:3000"',
    'true',
    '[]',
    '[{"Host": "10.20.30.40", "Port": 3000}]',
    '{}',
    '{"Host": 10, "Port": 3000}',
    '{"Host": "   ", "Port": 3000}',
    '{"Host": "10.20.30.40"}',
    '{"Host": "10.20.30.40", "Port": "three thousand"}',
    '{"Host": "10.20.30.40", "Port": 0}',
    '{"Host": "10.20.30.40", "Port": 65536}',
    '{"Host": "10.20.30.40", "Port": 3000.5}',
  ]) {
    const { Manager, errors } = withManualServerFile(Contents);
    assert.equal(await Manager.GetManualServer(), null, Contents);
    assert.equal((await Manager.GetProfile()).ManualServer, undefined, Contents);
    assert.deepEqual(errors, [], Contents);
  }
});
