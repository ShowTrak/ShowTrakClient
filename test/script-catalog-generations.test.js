// The script catalog as every supported server sends it (ScriptCatalogWireEntry
// in @showtrak/protocol).
//
// A client is still adopted by servers older than itself, so ScriptManager has
// to read three generations of entry: 3.0.0 - 3.2.x (one launch `Path`, no
// `Platforms`), 3.3.0 on (per-platform `Platforms`, fields added release by
// release), and a 3.3.0+ entry whose Script.json failed to parse.
//
// The deployment fingerprint built from the catalog goes to the server in every
// heartbeat (ScriptsFingerprint) and is compared with the server's own, so what
// it hashes is pinned here: a change to it must be deliberate, and matched on
// the server.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'ScriptManager', 'index.js');

const PLATFORM_KEY =
  process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function loadScriptManager() {
  const scriptsDir = tempDir('stc-gen-s-');
  const profileDir = tempDir('stc-gen-p-');
  const { Manager } = loadWithMocks(MODULE_PATH, {
    '../Logger': { CreateLogger: () => createSilentLogger() },
    '../AppData': {
      Manager: {
        GetScriptsDirectory: () => scriptsDir,
        GetProfileDirectory: () => profileDir,
      },
    },
    '../Broadcast': { Manager: { emit: () => {}, on: () => {} } },
  });
  return { Manager, scriptsDir };
}

/** Put a script's launch file where GetLaunchState looks for it. */
function placeScriptFile(scriptsDir, ScriptID, RelativePath) {
  const File = path.join(scriptsDir, ScriptID, RelativePath);
  fs.mkdirSync(path.dirname(File), { recursive: true });
  fs.writeFileSync(File, 'echo ok\n');
}

// One entry of every generation, as each server release sends it.
const CATALOG = [
  // Server 3.3.0+: every field the current server sends.
  {
    ID: 'open-show',
    Name: 'Open Show',
    Description: 'Opens the show file in QLab',
    Colour: 3,
    Icon: 'play-circle',
    Weight: 1,
    Confirmation: true,
    ConfirmationLevel: 'Critical',
    Timeout: 30000,
    Platforms: { Windows: 'open.bat', macOS: 'open.sh', Linux: '' },
    Arguments: { Windows: '', macOS: '--fast "Main Show"', Linux: '' },
    ConsoleFilter: { Mode: 'startsWith', Pattern: 'STATUS:', Strip: true },
    CompatiblePlatforms: ['Windows', 'macOS'],
    Files: [
      { Path: 'open.sh', Type: 'file', Checksum: 'b'.repeat(40) },
      { Path: 'assets', Type: 'directory' },
      { Path: 'open.bat', Type: 'file', Checksum: 'a'.repeat(40) },
      { Path: 'assets/show.qlab5', Type: 'file', Checksum: null },
    ],
    isEnabled: true,
    isValid: true,
    ValidationErrors: [],
    Config: { Name: 'Open Show', Enabled: true },
  },
  // Server 3.3.0 - 3.4.0: no Timeout, ConsoleFilter, Icon or ConfirmationLevel yet.
  {
    ID: 'reboot',
    Name: 'Reboot',
    Description: '',
    Colour: 6,
    Weight: 5,
    Confirmation: false,
    Platforms: { Windows: 'reboot.ps1', macOS: '', Linux: 'reboot.sh' },
    Arguments: { Windows: '-Force', macOS: '', Linux: '' },
    CompatiblePlatforms: ['Windows', 'Linux'],
    Files: [
      { Path: 'reboot.sh', Type: 'file', Checksum: 'c'.repeat(40) },
      { Path: 'reboot.ps1', Type: 'file', Checksum: 'd'.repeat(40) },
    ],
    isEnabled: false,
    isValid: true,
    ValidationErrors: ['Timeout was missing'],
    Config: { Name: 'Reboot', Enabled: false },
  },
  // Server 3.3.0+: a Script.json that failed to parse.
  {
    ID: 'broken',
    Name: 'broken',
    Description: '',
    Colour: 6,
    Weight: 0,
    Confirmation: false,
    Platforms: {},
    Arguments: {},
    CompatiblePlatforms: [],
    Files: [],
    isEnabled: false,
    isValid: false,
    ParseError: 'Invalid JSON: Unexpected end of JSON input',
    RawText: '{',
    ValidationErrors: [],
    Config: null,
  },
  // Server 3.0.0 - 3.2.x: one Path, a LabelStyle, no Platforms.
  {
    ID: 'legacy-restart',
    Name: 'Restart Media',
    Type: 'Batch',
    Path: 'restart.bat',
    LabelStyle: 'danger',
    Weight: 2,
    Confirmation: true,
    Files: [{ Path: 'restart.bat', Type: 'file', Checksum: 'e'.repeat(40) }],
    isEnabled: true,
    isValid: true,
  },
];

// What this catalog hashed to before ScriptManager was typed against the wire
// catalog. Changing it changes every client's reported fingerprint.
const CATALOG_FINGERPRINT = '1790a133cdbf356c3604bfd3a8f6c7066f609227a4f78cd3381b4404cba55d38';

test('the deployment fingerprint of every catalog generation is pinned', async () => {
  const { Manager } = loadScriptManager();
  assert.equal(await Manager.GetExpectedDeploymentFingerprint(CATALOG), CATALOG_FINGERPRINT);
});

test('the fingerprint ignores the order of scripts and of their files', async () => {
  const { Manager } = loadScriptManager();
  const Shuffled = [...CATALOG]
    .reverse()
    .map((Script) => ({ ...Script, Files: [...Script.Files].reverse() }));
  assert.equal(await Manager.GetExpectedDeploymentFingerprint(Shuffled), CATALOG_FINGERPRINT);
});

test('an empty catalog hashes to sha256("[]"), as on the server', async () => {
  // The e2e perf harness reports this value for a client with no scripts.
  const { Manager } = loadScriptManager();
  const Empty = crypto.createHash('sha256').update('[]').digest('hex');
  assert.equal(await Manager.GetExpectedDeploymentFingerprint([]), Empty);
});

test('a 3.0.0 - 3.2.x entry runs its one Path on every platform', async () => {
  const { Manager, scriptsDir } = loadScriptManager();
  const Legacy = CATALOG.find((Script) => Script.ID === 'legacy-restart');
  placeScriptFile(scriptsDir, Legacy.ID, Legacy.Path);
  await Manager.SetScripts([Legacy]);

  assert.deepEqual(Manager.GetLaunchState(Legacy.ID), {
    Found: true,
    Enabled: true,
    DisabledReason: '',
    Name: 'Restart Media',
  });
});

test('a 3.3.0+ entry runs the launch file named for this platform', async () => {
  const { Manager, scriptsDir } = loadScriptManager();
  const Script = {
    ...CATALOG.find((Entry) => Entry.ID === 'open-show'),
    Platforms: { Windows: '', macOS: '', Linux: '', [PLATFORM_KEY]: 'run/here.sh' },
  };
  placeScriptFile(scriptsDir, Script.ID, 'run/here.sh');
  await Manager.SetScripts([Script]);

  const State = Manager.GetLaunchState(Script.ID);
  assert.equal(State.Enabled, true, State.DisabledReason);
});

test('isEnabled false disables a script even when its launch file is in place', async () => {
  const { Manager, scriptsDir } = loadScriptManager();
  const Script = {
    ...CATALOG.find((Entry) => Entry.ID === 'reboot'),
    Platforms: { Windows: '', macOS: '', Linux: '', [PLATFORM_KEY]: 'reboot.sh' },
  };
  placeScriptFile(scriptsDir, Script.ID, 'reboot.sh');
  await Manager.SetScripts([Script]);

  assert.deepEqual(Manager.GetLaunchState(Script.ID), {
    Found: true,
    Enabled: false,
    DisabledReason: 'Script is disabled.',
    Name: 'Reboot',
  });
  const [Err, Ran] = await Manager.Execute('req-disabled', Script.ID);
  assert.equal(Err, 'Script is disabled.');
  assert.equal(Ran, false);
});

test('an entry whose Script.json failed to parse is listed but never run or deployed', async () => {
  const { Manager } = loadScriptManager();
  const Broken = CATALOG.find((Script) => Script.ID === 'broken');
  await Manager.SetScripts([Broken]);

  const [Entry] = Manager.GetTrayScriptEntries();
  assert.equal(Entry.Script.ID, 'broken');
  assert.equal(Entry.Enabled, false);
  assert.equal(Entry.DisabledReason, 'Invalid JSON: Unexpected end of JSON input');

  await assert.rejects(
    Manager.DownloadScripts('10.0.0.10', 3000, [Broken]),
    /Invalid command JSON \(Script\.json\) for broken \(Invalid JSON: Unexpected end of JSON input\)/
  );
});
