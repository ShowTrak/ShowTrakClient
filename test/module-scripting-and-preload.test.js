const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { loadWithMocks, withMocks } = require('./test-helpers');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('ScriptManager executes scripts and handles missing scripts', async () => {
  const scriptsDir = tempDir('showtrak-client-scripts-');
  const profileDir = tempDir('showtrak-client-profile-');

  const spawnCalls = [];
  const childProcessMock = {
    spawn: (command, args) => {
      spawnCalls.push([command, args]);
      return {
        stdout: { on: (event, cb) => event === 'data' && cb(Buffer.from('ok')) },
        stderr: { on: () => {} },
        on: (event, cb) => {
          if (event === 'close') cb(0);
        },
      };
    },
  };
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'ScriptManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {}, success: () => {} }),
    },
    '../AppData': {
      Manager: {
        GetScriptsDirectory: () => scriptsDir,
        GetProfileDirectory: () => profileDir,
      },
    },
    '../ChecksumManager': {
      Manager: {
        Checksum: async () => 'sum',
      },
    },
  });

  await Manager.SetScripts([]);
  const [missingErr, missingOk] = await Manager.Execute('r1', 'missing');
  assert.equal(missingErr, 'Script not found');
  assert.equal(missingOk, false);

  const scriptId = 'script-1';
  const scriptFolder = path.join(scriptsDir, scriptId);
  fs.mkdirSync(scriptFolder, { recursive: true });
  const scriptFile = path.join(scriptFolder, 'macos.sh');
  fs.writeFileSync(scriptFile, 'echo hello', 'utf8');

  await Manager.SetScripts([
    {
      ID: scriptId,
      Name: 'Demo',
      Enabled: true,
      Platforms: { macOS: 'macos.sh' },
      Arguments: { macOS: '--flag value' },
      Files: [{ Path: 'macos.sh', Type: 'file', Checksum: 'sum' }],
    },
  ]);

  const [okErr, ok] = await withMocks({ child_process: childProcessMock }, () =>
    Manager.Execute('r2', scriptId)
  );
  assert.equal(okErr, null);
  assert.equal(ok, true);
  assert.equal(spawnCalls.length, 1);

  await Manager.SetScripts([
    {
      ID: scriptId,
      Name: 'Demo',
      Enabled: true,
      Platforms: { macOS: 'missing.sh' },
      Files: [{ Path: 'missing.sh', Type: 'file', Checksum: 'sum' }],
    },
  ]);

  const [missingFileErr, missingFileOk] = await Manager.Execute('r3', scriptId);
  assert.equal(missingFileErr, 'Script file for this operating system was not found');
  assert.equal(missingFileOk, false);
});

test('ScriptManager download, fingerprint, and delete flow', async () => {
  const scriptsDir = tempDir('showtrak-client-scripts-dl-');
  const profileDir = tempDir('showtrak-client-profile-dl-');

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    arrayBuffer: async () => Buffer.from('echo deployed').buffer,
  });

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'ScriptManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {}, success: () => {} }),
    },
    '../AppData': {
      Manager: {
        GetScriptsDirectory: () => scriptsDir,
        GetProfileDirectory: () => profileDir,
      },
    },
    '../ChecksumManager': {
      Manager: {
        Checksum: async () => 'different-sum',
      },
    },
  });

  try {
    const scripts = [
      {
        ID: 'script-2',
        Name: 'Deploy Script',
        Enabled: true,
        Platforms: { macOS: 'macos.sh' },
        Arguments: { macOS: '' },
        Files: [
          { Path: 'bin', Type: 'directory' },
          { Path: 'macos.sh', Type: 'file', Checksum: 'expected' },
        ],
      },
    ];

    await Manager.DownloadScripts('127.0.0.1', 8080, scripts);
    const downloadedPath = path.join(scriptsDir, 'script-2', 'macos.sh');
    assert.equal(fs.existsSync(downloadedPath), true);

    const expectedFingerprint = await Manager.GetExpectedDeploymentFingerprint(scripts);
    const appliedFingerprint = await Manager.GetLastAppliedDeploymentFingerprint();
    assert.equal(appliedFingerprint, expectedFingerprint);

    await Manager.DeleteScripts();
    assert.equal(fs.existsSync(downloadedPath), false);
    const afterDelete = await Manager.GetLastAppliedDeploymentFingerprint();
    assert.equal(afterDelete, null);
  } finally {
    global.fetch = originalFetch;
  }
});

test('ScriptManager handles invalid configs and launcher errors', async () => {
  const scriptsDir = tempDir('showtrak-client-scripts-err-');
  const profileDir = tempDir('showtrak-client-profile-err-');

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Error',
    arrayBuffer: async () => new ArrayBuffer(0),
  });

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'ScriptManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {}, success: () => {} }),
    },
    '../AppData': {
      Manager: {
        GetScriptsDirectory: () => scriptsDir,
        GetProfileDirectory: () => profileDir,
      },
    },
    '../ChecksumManager': {
      Manager: {
        Checksum: async () => 'same-sum',
      },
    },
  });

  try {
    const badScripts = [
      null,
      { ID: '', Name: 'invalid-id' },
      { ID: 'bad-parse', isValid: false, ParseError: 'Broken JSON' },
      {
        ID: 'bad-download',
        Name: 'Bad Download',
        Files: [{ Path: 'macos.sh', Type: 'file', Checksum: 'expected' }],
      },
    ];

    await assert.rejects(async () => {
      await Manager.DownloadScripts('127.0.0.1', 8081, badScripts);
    }, /Invalid command JSON|Failed to download/);

    const scriptId = 'script-exec-errors';
    await Manager.SetScripts([
      {
        ID: scriptId,
        Name: 'No Path',
        Platforms: {},
      },
    ]);
    const [noPathErr, noPathSuccess] = await Manager.Execute('r-no-path', scriptId);
    assert.equal(noPathErr, 'No script is configured for this operating system');
    assert.equal(noPathSuccess, false);

    await Manager.SetScripts([
      {
        ID: scriptId,
        Name: 'Missing Directory',
        Platforms: { macOS: 'macos.sh' },
      },
    ]);
    const [missingDirErr, missingDirSuccess] = await Manager.Execute('r-missing-dir', scriptId);
    assert.equal(missingDirErr, 'Script path does not exist');
    assert.equal(missingDirSuccess, false);

    const scriptFolder = path.join(scriptsDir, scriptId);
    fs.mkdirSync(scriptFolder, { recursive: true });
    fs.writeFileSync(path.join(scriptFolder, 'macos.sh'), 'echo ok', 'utf8');

    await Manager.SetScripts([
      {
        ID: scriptId,
        Name: 'Spawn Error',
        Platforms: { macOS: 'macos.sh' },
      },
    ]);

    const [spawnErr, spawnSuccess] = await withMocks(
      {
        child_process: {
          spawn: () => ({
            stdout: { on: () => {} },
            stderr: { on: () => {} },
            on: (event, cb) => {
              if (event === 'error') cb(new Error('spawn failed'));
            },
          }),
        },
      },
      () => Manager.Execute('r-spawn-fail', scriptId)
    );
    assert.equal(spawnErr, 'An error occured during script execution');
    assert.equal(spawnSuccess, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('preload exposes safe API wrappers and subscriptions', async () => {
  let exposedName = null;
  let exposedAPI = null;
  const invoked = [];
  const listeners = new Map();

  const modulePath = path.join(__dirname, '..', 'src', 'preload.js');
  loadWithMocks(modulePath, {
    electron: {
      contextBridge: {
        exposeInMainWorld: (name, api) => {
          exposedName = name;
          exposedAPI = api;
        },
      },
      ipcRenderer: {
        invoke: async (channel, ...args) => {
          invoked.push([channel, args]);
          return { channel, args };
        },
        on: (channel, handler) => {
          listeners.set(channel, handler);
        },
        removeListener: (channel, handler) => {
          const current = listeners.get(channel);
          if (current === handler) listeners.delete(channel);
        },
      },
    },
  });

  assert.equal(exposedName, 'API');
  const versionResponse = await exposedAPI.GetVersion();
  assert.equal(versionResponse.channel, 'GetVersion');

  await exposedAPI.Loaded();
  await exposedAPI.Shutdown();
  await exposedAPI.Minimise();
  await exposedAPI.CheckForAppUpdates();
  await exposedAPI.InstallAppUpdate();
  assert.equal(invoked.length, 6);

  let profilePayload = null;
  const unsubscribeProfile = exposedAPI.SetProfile((profile) => {
    profilePayload = profile;
  });
  listeners.get('SetProfile')({}, { UUID: 'u1' });
  assert.deepEqual(profilePayload, { UUID: 'u1' });

  let updatePayload = null;
  const unsubscribeUpdate = exposedAPI.OnAppUpdateStatus((status) => {
    updatePayload = status;
  });
  listeners.get('AppUpdate:Status')({}, { state: 'checking' });
  assert.deepEqual(updatePayload, { state: 'checking' });

  let processPayload = null;
  const unsubscribeProcess = exposedAPI.OnProcessMonitorStatus((status) => {
    processPayload = status;
  });
  listeners.get('ProcessMonitorStatus')({}, { State: 'ok' });
  assert.deepEqual(processPayload, { State: 'ok' });

  let recoveryPayload = null;
  const unsubscribeRecovery = exposedAPI.OnServerRecoveryStatus((status) => {
    recoveryPayload = status;
  });
  listeners.get('ServerRecoveryStatus')({}, { State: 'Discovering' });
  assert.deepEqual(recoveryPayload, { State: 'Discovering' });

  unsubscribeProfile();
  unsubscribeUpdate();
  unsubscribeProcess();
  unsubscribeRecovery();

  assert.equal(listeners.has('SetProfile'), false);

  assert.throws(() => exposedAPI.SetProfile('not-a-function'), /must be a function/);
});

