// ScriptManager's record of the last script deployment it applied
// (ScriptDeploymentState.json in the profile directory).
//
// The fingerprint read back from this file goes to the server in every heartbeat
// (ScriptsFingerprint); the server compares it with its own catalog's and
// redeploys when they differ or when the client reports none. So a damaged file
// must read as "nothing applied yet" (null), which costs at most one redundant
// download, and must never throw out of the heartbeat.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'ScriptManager', 'index.js');
const STATE_FILE = 'ScriptDeploymentState.json';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A fresh ScriptManager over its own profile dir, recording what it warns about. */
function loadScriptManager(profileDir) {
  const warnings = [];
  const { Manager } = loadWithMocks(MODULE_PATH, {
    '../Logger': {
      CreateLogger: () => createSilentLogger({ warn: (...args) => warnings.push(args) }),
    },
    '../AppData': {
      Manager: {
        GetScriptsDirectory: () => path.join(profileDir, 'Scripts'),
        GetProfileDirectory: () => profileDir,
      },
    },
  });
  return { Manager, warnings };
}

function withStateFile(Contents) {
  const profileDir = tempDir('showtrak-deploy-state-');
  if (Contents !== undefined) fs.writeFileSync(path.join(profileDir, STATE_FILE), Contents);
  return loadScriptManager(profileDir);
}

test('the applied fingerprint is read back from the state file', async () => {
  const { Manager, warnings } = withStateFile(
    JSON.stringify({ LastAppliedDeploymentFingerprint: 'abc123', UpdatedAt: 1 })
  );
  assert.equal(await Manager.GetLastAppliedDeploymentFingerprint(), 'abc123');
  assert.deepEqual(warnings, []);
});

test('no state file means nothing has been applied yet', async () => {
  const { Manager, warnings } = withStateFile(undefined);
  assert.equal(await Manager.GetLastAppliedDeploymentFingerprint(), null);
  assert.deepEqual(warnings, []);
});

test('an unparseable state file reads as nothing applied, with a warning', async () => {
  const { Manager, warnings } = withStateFile('{"LastAppliedDeploymentFingerprint": "abc');
  assert.equal(await Manager.GetLastAppliedDeploymentFingerprint(), null);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0][0]), /Failed to load script deployment state/);
});

test('an empty state file reads as nothing applied', async () => {
  // `Raw || '{}'`: a zero-byte file (a write cut short) is an empty object, not
  // a parse error.
  const { Manager, warnings } = withStateFile('');
  assert.equal(await Manager.GetLastAppliedDeploymentFingerprint(), null);
  assert.deepEqual(warnings, []);
});

test('JSON of the wrong shape reads as nothing applied, without a warning', async () => {
  // These parse, so they never reach the warning above; each has to fall
  // through to null on its own, as it did before JSON.parse was typed.
  for (const Contents of [
    'null',
    '0',
    '"abc123"',
    'true',
    '[]',
    '["abc123"]',
    '{}',
    '{"LastAppliedDeploymentFingerprint": 123}',
    '{"LastAppliedDeploymentFingerprint": null}',
    '{"LastAppliedDeploymentFingerprint": ["abc123"]}',
    '{"LastAppliedDeploymentFingerprint": {"value": "abc123"}}',
  ]) {
    const { Manager, warnings } = withStateFile(Contents);
    assert.equal(await Manager.GetLastAppliedDeploymentFingerprint(), null, Contents);
    assert.deepEqual(warnings, [], Contents);
  }
});

test('an empty-string fingerprint is kept as written', async () => {
  // Only the type is checked; the value is the server's to judge.
  const { Manager } = withStateFile(JSON.stringify({ LastAppliedDeploymentFingerprint: '' }));
  assert.equal(await Manager.GetLastAppliedDeploymentFingerprint(), '');
});
