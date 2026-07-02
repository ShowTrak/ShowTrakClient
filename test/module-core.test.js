const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { loadWithMocks, withMocks } = require('./test-helpers');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('AppData initialize creates required directories and open folder checks existence', async () => {
  const appDataRoot = tempDir('showtrak-client-appdata-');
  const oldAppData = process.env.APPDATA;
  process.env.APPDATA = appDataRoot;

  const opened = [];
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'AppData', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    electron: {
      shell: {
        openPath: (folderPath) => {
          opened.push(folderPath);
        },
      },
    },
  });

  try {
    Manager.Initialize();
    Manager.Initialize();

    const profileDir = Manager.GetProfileDirectory();
    const logsDir = Manager.GetLogsDirectory();
    const scriptsDir = Manager.GetScriptsDirectory();

    assert.equal(fs.existsSync(profileDir), true);
    assert.equal(fs.existsSync(logsDir), true);
    assert.equal(fs.existsSync(scriptsDir), true);

    assert.equal(
      withMocks(
        {
          electron: {
            shell: {
              openPath: (folderPath) => {
                opened.push(folderPath);
              },
            },
          },
        },
        () => Manager.OpenFolder(profileDir)
      ),
      true
    );
    assert.equal(Manager.OpenFolder(path.join(appDataRoot, 'missing')), false);
    assert.equal(opened.length, 1);
  } finally {
    process.env.APPDATA = oldAppData;
  }
});

test('Broadcast manager emits and handles events', async () => {
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'Broadcast', 'index.js');
  const { Manager } = require(modulePath);

  let payload = null;
  Manager.once('unit:test:event', (value) => {
    payload = value;
  });

  Manager.emit('unit:test:event', { ok: true });
  assert.deepEqual(payload, { ok: true });
});

test('ChecksumManager.Checksum resolves file checksum value', async () => {
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'ChecksumManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    checksum: {
      file: (_filePath, callback) => callback(null, 'abc123'),
    },
  });

  const result = await Manager.Checksum('/tmp/anything');
  assert.equal(result, 'abc123');
});

test('Config exposes app and shared versions', async () => {
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'Config', 'index.js');
  const { Config } = require(modulePath);
  assert.equal(typeof Config.Application.Version, 'string');
  assert.equal(Config.Shared.Version, Config.Application.Version);
  assert.equal(Config.Application.Name, 'ShowTrak Client');
});

test('UUID manager delegates to uuid.v4', async () => {
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'UUID', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    uuid: {
      v4: () => 'uuid-value',
    },
  });

  assert.equal(Manager.Generate(), 'uuid-value');
});

test('Utils.Wait resolves asynchronously', async () => {
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'Utils', 'index.js');
  const Utils = require(modulePath);

  const start = Date.now();
  await Utils.Wait(5);
  assert.equal(Date.now() >= start, true);
});

test('ProfileManager creates and updates profile states', async () => {
  const profileRoot = tempDir('showtrak-client-profile-');
  const emitted = [];
  const fs = require('node:fs');
  const manualServerPath = path.join(profileRoot, 'ManualServer.json');

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'ProfileManager', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {} }),
    },
    '../AppData': {
      Manager: {
        Initialize: () => {},
        GetProfileDirectory: () => profileRoot,
      },
    },
    '../Broadcast': {
      Manager: {
        emit: (event, payload) => emitted.push([event, payload]),
      },
    },
    '../UUID': {
      Manager: {
        Generate: () => 'generated-uuid',
      },
    },
  });

  const profileA = await Manager.GetProfile();
  assert.equal(profileA.UUID, 'generated-uuid');
  assert.equal(profileA.Adopted, false);

  await Manager.Adopt('127.0.0.1', 9000, { ServerIdentity: 'server-token-a' });
  const adopted = await Manager.GetProfile();
  assert.equal(adopted.Adopted, true);
  assert.equal(adopted.Server.IP, '127.0.0.1');
  assert.equal(adopted.Server.ServerIdentity, 'server-token-a');
  assert.equal(adopted.ServerIdentityLock, 'server-token-a');

  await Manager.UpdateServerEndpoint('127.0.0.2', 9000);
  const recovered = await Manager.GetProfile();
  assert.equal(recovered.Server.IP, '127.0.0.2');
  assert.equal(recovered.Server.ServerIdentity, 'server-token-a');

  // Manual server endpoint persists through adoption transitions so cross-VLAN
  // agents keep targeting the operator-defined server.
  await Manager.SetManualServer('10.20.30.40', 3000);
  const withManual = await Manager.GetProfile();
  assert.deepEqual(withManual.ManualServer, { Host: '10.20.30.40', Port: 3000 });
  assert.equal(fs.existsSync(manualServerPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(manualServerPath, 'utf-8')), {
    Host: '10.20.30.40',
    Port: 3000,
  });

  const manualLookup = await Manager.GetManualServer();
  assert.deepEqual(manualLookup, { Host: '10.20.30.40', Port: 3000 });

  await Manager.Adopt('10.20.30.40', 3000, { ServerIdentity: 'server-token-b' });
  const adoptedManual = await Manager.GetProfile();
  assert.deepEqual(adoptedManual.ManualServer, { Host: '10.20.30.40', Port: 3000 });

  await Manager.ResetAdopption();
  const resetWithManual = await Manager.GetProfile();
  assert.equal(resetWithManual.Adopted, false);
  assert.deepEqual(resetWithManual.ManualServer, { Host: '10.20.30.40', Port: 3000 });
  assert.equal(resetWithManual.ServerIdentityLock, 'server-token-b');

  await assert.rejects(() => Manager.SetManualServer('', 3000));
  await assert.rejects(() => Manager.SetManualServer('10.20.30.40', 70000));

  await Manager.ClearManualServer();
  const cleared = await Manager.GetProfile();
  assert.equal(Object.prototype.hasOwnProperty.call(cleared, 'ManualServer'), false);
  assert.equal(await Manager.GetManualServer(), null);
  assert.equal(fs.existsSync(manualServerPath), false);

  await Manager.ResetAdopption();
  const reset = await Manager.GetProfile();
  assert.equal(reset.Adopted, false);

  await Manager.ResetProfileToFactoryDefaults();
  const resetFactory = await Manager.GetProfile();
  assert.equal(resetFactory.UUID, 'generated-uuid');
  assert.equal(resetFactory.Adopted, false);
  assert.equal(fs.existsSync(manualServerPath), false);

  await Manager.ForceResetProfile();
  const resetForced = await Manager.GetProfile();
  assert.equal(resetForced.UUID, 'generated-uuid');

  assert.equal(
    emitted.some(([event]) => event === 'ProfileUpdated'),
    true
  );
});

test('ProfileManager migrates legacy manual server storage from Profile.json', async () => {
  const profileRoot = tempDir('showtrak-client-profile-migrate-');
  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'ProfileManager', 'index.js');
  const fs = require('node:fs');

  fs.writeFileSync(
    path.join(profileRoot, 'Profile.json'),
    JSON.stringify(
      {
        UUID: 'legacy-uuid',
        Adopted: false,
        ManualServer: { Host: '192.168.10.5', Port: 4000 },
      },
      null,
      2
    )
  );

  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, error: () => {} }),
    },
    '../AppData': {
      Manager: {
        Initialize: () => {},
        GetProfileDirectory: () => profileRoot,
      },
    },
    '../Broadcast': {
      Manager: {
        emit: () => {},
      },
    },
    '../UUID': {
      Manager: {
        Generate: () => 'generated-uuid',
      },
    },
  });

  const profile = await Manager.GetProfile();
  const storedProfile = JSON.parse(
    fs.readFileSync(path.join(profileRoot, 'Profile.json'), 'utf-8')
  );
  const storedManual = JSON.parse(
    fs.readFileSync(path.join(profileRoot, 'ManualServer.json'), 'utf-8')
  );

  assert.equal(profile.UUID, 'legacy-uuid');
  assert.deepEqual(profile.ManualServer, { Host: '192.168.10.5', Port: 4000 });
  assert.equal(Object.prototype.hasOwnProperty.call(storedProfile, 'ManualServer'), false);
  assert.deepEqual(storedManual, { Host: '192.168.10.5', Port: 4000 });
});

test('USBMonitor formats connected devices and emits callbacks', async () => {
  let lastInstance = null;

  class FakeWebUSB {
    constructor() {
      this.listeners = new Map();
      lastInstance = this;
    }

    async getDevices() {
      return [
        {
          vendorId: 10,
          productId: 11,
          manufacturerName: 'Vendor',
          productName: 'Device',
          serialNumber: 'SER1',
        },
      ];
    }

    addEventListener(event, handler) {
      this.listeners.set(event, handler);
    }

    emit(event, device) {
      const handler = this.listeners.get(event);
      if (handler) handler({ device });
    }
  }

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'USBMonitor', 'index.js');
  const { Manager } = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, error: () => {} }),
    },
    usb: {
      WebUSB: FakeWebUSB,
    },
  });

  const [err, devices] = await Manager.GetUSBDevices();
  assert.equal(err, null);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].VendorID, 10);

  let connected = null;
  let disconnected = null;
  Manager.OnUSBConnect((device) => {
    connected = device;
  });
  Manager.OnUSBDisconnect((device) => {
    disconnected = device;
  });

  const rawDevice = {
    vendorId: 22,
    productId: 33,
    manufacturerName: 'Acme',
    productName: 'Thing',
    serialNumber: 'S2',
  };

  lastInstance.emit('connect', rawDevice);
  lastInstance.emit('disconnect', rawDevice);

  assert.equal(connected.ProductID, 33);
  assert.equal(disconnected.SerialNumber, 'S2');
});

test('Logger writes file lines and supports all log levels', async () => {
  const logRoot = tempDir('showtrak-client-logger-');
  const appended = [];
  const printed = [];
  const createdFiles = new Set();

  const originalConsoleLog = console.log;
  console.log = (...args) => printed.push(args);

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'Logger', 'index.js');
  const { CreateLogger } = loadWithMocks(modulePath, {
    '../Config': { Production: false },
    colors: {
      cyan: (value) => String(value),
      magenta: (value) => String(value),
      rainbow: (value) => String(value),
      red: (value) => String(value),
      grey: (value) => String(value),
      green: (value) => String(value),
    },
    fs: {
      existsSync: (target) => createdFiles.has(target) || fs.existsSync(target),
      mkdirSync: (target, options) => {
        fs.mkdirSync(target, options);
        createdFiles.add(target);
      },
      writeFileSync: (target, content) => {
        fs.writeFileSync(target, content, 'utf8');
        createdFiles.add(target);
      },
      appendFileSync: (target, content) => {
        appended.push([target, content]);
        fs.appendFileSync(target, content, 'utf8');
      },
    },
    path,
    'electron-squirrel-startup': false,
    '../AppData': {
      Manager: {
        GetLogsDirectory: () => logRoot,
      },
    },
  });

  try {
    const logger = CreateLogger('Unit');
    logger.log('log');
    logger.info('info');
    logger.silent('silent');
    logger.warn('warn');
    logger.error('error');
    logger.debug('debug');
    logger.success('success');
    logger.database('db');
    logger.databaseError('dberr');

    assert.equal(printed.length > 0, true);
    assert.equal(appended.length >= 8, true);
  } finally {
    console.log = originalConsoleLog;
  }
});
