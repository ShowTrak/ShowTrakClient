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
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
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
    '../HardwareIdentity': {
      Manager: {
        Resolve: async () => ({
          UUID: 'generated-uuid',
          Source: 'firmware',
          Witness: 'firmware-witness',
        }),
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
      CreateLogger: () => ({ log: () => {}, warn: () => {}, error: () => {} }),
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
    '../HardwareIdentity': {
      Manager: {
        Resolve: async () => ({
          UUID: 'generated-uuid',
          Source: 'firmware',
          Witness: 'firmware-witness',
        }),
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

  // A legacy profile carries a random UUID that a Clonezilla image would have
  // duplicated across machines, so it is deliberately replaced by the
  // hardware-derived one. This costs a one-time re-adopt and is the whole point
  // of the feature.
  assert.equal(profile.UUID, 'generated-uuid');
  assert.equal(profile.Identity.Source, 'firmware');
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

test('DisplayMonitor formats displays and registers change listeners', async () => {
  const registeredEvents = [];
  const fakeScreen = {
    getAllDisplays: () => [
      {
        id: 100,
        label: 'Built-in',
        size: { width: 1920, height: 1080 },
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        scaleFactor: 2,
        displayFrequency: 60,
        rotation: 0,
        internal: true,
      },
      {
        id: 200,
        label: 'External',
        size: { width: 2560, height: 1440 },
        bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
        scaleFactor: 1,
        displayFrequency: 144,
        rotation: 0,
        internal: false,
      },
    ],
    getPrimaryDisplay: () => ({ id: 100 }),
    on: (event) => registeredEvents.push(event),
  };

  const modulePath = path.join(__dirname, '..', 'src', 'Modules', 'DisplayMonitor', 'index.js');
  const mod = loadWithMocks(modulePath, {
    '../Logger': {
      CreateLogger: () => ({ log: () => {}, error: () => {} }),
    },
    electron: { screen: fakeScreen },
  });
  const { Manager } = mod;

  // Override the (OS-specific) hardware identity lookup so the test is fully
  // deterministic and never shells out. The external monitor gets a stable
  // EDID fingerprint; the built-in panel is left unidentified.
  mod._internal.GetDisplayIdentities = async () => [
    { Fingerprint: 'edid:DEL:1234:SER9', Name: 'DELL U2721', Width: 2560, Height: 1440 },
  ];

  const [err, displays] = await Manager.GetDisplays();
  assert.equal(err, null);
  assert.equal(displays.length, 2);
  // Built-in panel: no identity match -> stable composite from resolution +
  // refresh (physical 3840x2160 @60, internal panel).
  assert.equal(displays[0].SessionID, '100');
  assert.equal(displays[0].ScreenNumber, 1);
  assert.equal(displays[0].DisplayID, 'attr:::3840x2160@60:i');
  assert.equal(displays[0].IsStableIdentity, true);
  assert.equal(displays[0].IdentitySource, 'attributes');
  assert.equal(displays[0].Width, 1920);
  assert.equal(displays[0].Height, 1080);
  assert.equal(displays[0].RefreshRate, 60);
  assert.equal(displays[0].Primary, true);
  // External monitor: matched by resolution -> stable EDID id + label.
  assert.equal(displays[1].SessionID, '200');
  assert.equal(displays[1].ScreenNumber, 2);
  assert.equal(displays[1].DisplayID, 'edid:DEL:1234:SER9');
  assert.equal(displays[1].HardwareID, 'edid:DEL:1234:SER9');
  assert.equal(displays[1].IsStableIdentity, true);
  assert.equal(displays[1].IdentitySource, 'edid');
  // Electron already provided a label, so it is preserved over the EDID name.
  assert.equal(displays[1].Label, 'External');
  assert.equal(displays[1].Primary, false);

  let changeFired = 0;
  Manager.OnDisplayChange(() => {
    changeFired += 1;
  });
  assert.deepEqual(registeredEvents, [
    'display-added',
    'display-removed',
    'display-metrics-changed',
  ]);
  void changeFired;
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
