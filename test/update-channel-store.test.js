const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// Exercises src/Modules/UpdateChannel: where this client keeps its update
// channel. Anything unreadable must read as stable, never as beta.

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'UpdateChannel', 'index.js');

function load() {
  const Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-channel-'));
  const { Manager } = loadWithMocks(MODULE_PATH, {
    '../AppData': { Manager: { GetProfileDirectory: () => Dir } },
    '../Logger': { CreateLogger: () => createSilentLogger() },
  });
  return { Manager, File: path.join(Dir, 'UpdateChannel.json'), Dir };
}

test('the channel defaults to stable and persists once set', () => {
  const { Manager, File, Dir } = load();
  try {
    assert.equal(Manager.Get(), 'stable');
    assert.equal(Manager.Set('beta'), 'beta');
    assert.equal(Manager.Get(), 'beta');
    assert.deepEqual(JSON.parse(fs.readFileSync(File, 'utf8')), { Channel: 'beta' });
    Manager.Reset();
    assert.equal(Manager.Get(), 'stable');
    assert.equal(fs.existsSync(File), false);
  } finally {
    fs.rmSync(Dir, { recursive: true, force: true });
  }
});

test('anything unexpected reads as stable', () => {
  const { Manager, File, Dir } = load();
  try {
    assert.equal(Manager.Set('nightly'), 'stable');
    fs.writeFileSync(File, '{ not json');
    assert.equal(Manager.Get(), 'stable');
    fs.writeFileSync(File, JSON.stringify({ Channel: 'BETA ' }));
    assert.equal(Manager.Get(), 'beta');
  } finally {
    fs.rmSync(Dir, { recursive: true, force: true });
  }
});
