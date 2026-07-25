const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

// Exercises the per-platform resolvers in src/Modules/DisplayMonitor/identity.ts.
//
// display-identity.test.js already covers the EDID parser and the pure matcher.
// What was untested is everything that talks to the OS — the three resolvers
// that actually produce the identities the matcher consumes.
//
// Why it matters: Electron's `display.id` is a runtime handle that changes on
// reboot. These resolvers are what give a monitor a durable identity, which is
// what "critical display missing" alerts are keyed on. A resolver that returns
// a fingerprint of the wrong stability — one that changes on reboot, or one
// that is identical across two monitors of the same model — turns that alert
// into either a false alarm every restart or a missed one when a screen dies.
//
// Every resolver is also FAIL-SOFT by design: missing tools, denied permissions
// and unusual hardware must all produce an empty list rather than an exception,
// because the caller falls back to a session-scoped id and the client has to
// keep running either way.
//
// Fixture provenance: the macOS JSON shape (key names, the `"4112 x 2658"`
// spacing, the `spdisplays_yes` sentinel) was captured from a real
// `system_profiler SPDisplaysDataType -json` run; the identifying values are
// synthetic.

const IDENTITY_PATH = path.join(
  __dirname,
  '..',
  'dist',
  'Modules',
  'DisplayMonitor',
  'identity.js'
);

/** Load identity.ts with a scripted OS underneath it. */
function load({ platform = 'darwin', files = {}, dirs = {}, command = () => null } = {}) {
  const commands = [];

  const Mod = loadWithMocks(IDENTITY_PATH, {
    'node:os': { platform: () => platform },
    'node:fs': {
      readdirSync: (dir) => {
        if (!(dir in dirs)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return dirs[dir];
      },
      readFileSync: (file, encoding) => {
        if (!(file in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        const Value = files[file];
        if (typeof Value === 'function') return Value();
        return encoding ? String(Value) : Buffer.isBuffer(Value) ? Value : Buffer.from(Value);
      },
    },
    'node:child_process': {
      execFile: (cmd, args, options, cb) => {
        commands.push({ cmd, args, options });
        const Result = command(cmd, args);
        if (Result instanceof Error) return cb(Result, '');
        if (Result === null || Result === undefined) return cb(new Error('ENOENT'), '');
        cb(null, Result);
      },
    },
  });

  return { Mod, commands };
}

// ===========================================================================
// macOS
// ===========================================================================

/** A display entry in the shape system_profiler really emits. */
function macDisplay(Overrides = {}) {
  return {
    _name: 'Studio Display',
    '_spdisplays_display-product-id': 'a050',
    '_spdisplays_display-serial-number': '0x1a2b3c4d',
    '_spdisplays_display-vendor-id': '610',
    _spdisplays_pixels: '5120 x 2880',
    _spdisplays_resolution: '2560 x 1440 @ 60.00Hz',
    spdisplays_main: 'spdisplays_yes',
    spdisplays_online: 'spdisplays_yes',
    ...Overrides,
  };
}

const macJson = (displays) =>
  JSON.stringify({ SPDisplaysDataType: [{ _name: 'Apple M4', spdisplays_ndrvs: displays }] });

function loadMac(displays, Options = {}) {
  return load({
    platform: 'darwin',
    command: (cmd) => (cmd === 'system_profiler' ? macJson(displays) : null),
    ...Options,
  });
}

test('macOS reads identities from system_profiler', async () => {
  const { Mod, commands } = loadMac([macDisplay()]);

  const [Identity] = await Mod.GetDisplayIdentities();

  assert.deepEqual(commands[0].args, ['SPDisplaysDataType', '-json']);
  assert.equal(Identity.Manufacturer, '610');
  assert.equal(Identity.Product, 'a050');
  assert.equal(Identity.Serial, '0x1a2b3c4d');
  assert.equal(Identity.Name, 'Studio Display');
  assert.equal(Identity.Primary, true);
  assert.equal(Identity.Fingerprint, 'mac:610:a050:0x1a2b3c4d');
});

test('macOS prefers the NATIVE pixel count over the logical resolution', async () => {
  // The matcher compares against Electron's size × scaleFactor, i.e. physical
  // pixels. On any Retina panel the logical figure is half that, so reading the
  // wrong field means the resolution pass never matches and every display falls
  // through to positional order.
  const { Mod } = loadMac([macDisplay()]);
  const [Identity] = await Mod.GetDisplayIdentities();

  assert.equal(Identity.Width, 5120);
  assert.equal(Identity.Height, 2880);
});

test('macOS falls back to the logical resolution when no pixel count is given', async () => {
  const Display = macDisplay();
  delete Display._spdisplays_pixels;

  const { Mod } = loadMac([Display]);
  const [Identity] = await Mod.GetDisplayIdentities();

  assert.equal(Identity.Width, 2560);
  assert.equal(Identity.Height, 1440);
});

test('macOS accepts the alternative key spellings system_profiler uses', async () => {
  // The underscore-prefixed and bare forms both appear across macOS versions.
  const { Mod } = loadMac([
    {
      _name: 'DELL U2720Q',
      'spdisplays_display-product-id': 'b1c2',
      'spdisplays_display-serial-number': 'SN-2',
      'spdisplays_display-vendor-id': '10ac',
      spdisplays_resolution: '3840 x 2160',
    },
  ]);

  const [Identity] = await Mod.GetDisplayIdentities();
  assert.equal(Identity.Manufacturer, '10ac');
  assert.equal(Identity.Product, 'b1c2');
  assert.equal(Identity.Serial, 'SN-2');
  assert.equal(Identity.Width, 3840);
});

test('macOS marks exactly the display the OS calls main as primary', async () => {
  // The primary flag is the matcher's highest-confidence pass, so a second
  // display wrongly flagged would steal the built-in panel's identity.
  const { Mod } = loadMac([
    macDisplay({ _name: 'Built-in', spdisplays_main: 'spdisplays_yes' }),
    macDisplay({ _name: 'External', spdisplays_main: 'spdisplays_no' }),
    macDisplay({ _name: 'Projector', spdisplays_main: undefined }),
  ]);

  const Identities = await Mod.GetDisplayIdentities();
  assert.deepEqual(
    Identities.map((I) => I.Primary),
    [true, false, false]
  );
});

test('a macOS panel with no identifying data at all gets no fingerprint', async () => {
  // Fail-soft, not fail-wrong: a null fingerprint tells the caller to use a
  // session-scoped id. Inventing one from the name would produce an identity
  // shared by every monitor of that model in the rack.
  const { Mod } = loadMac([{ _name: 'Generic Display', _spdisplays_pixels: '1920 x 1080' }]);

  const [Identity] = await Mod.GetDisplayIdentities();
  assert.equal(Identity.Fingerprint, null);
  assert.equal(Identity.Name, 'Generic Display');
  assert.equal(Identity.Width, 1920);
});

test('a serial alone is enough to fingerprint a macOS panel', async () => {
  const { Mod } = loadMac([{ _name: 'Panel', '_spdisplays_display-serial-number': 'SN-9' }]);
  const [Identity] = await Mod.GetDisplayIdentities();
  assert.equal(Identity.Fingerprint, 'mac:::SN-9');
});

test('a vendor without a product is not enough', async () => {
  const { Mod } = loadMac([{ _name: 'Panel', '_spdisplays_display-vendor-id': '610' }]);
  assert.equal((await Mod.GetDisplayIdentities())[0].Fingerprint, null);
});

test('macOS walks every GPU, so displays on a second card are not lost', async () => {
  const { Mod } = load({
    platform: 'darwin',
    command: () =>
      JSON.stringify({
        SPDisplaysDataType: [
          { _name: 'GPU 0', spdisplays_ndrvs: [macDisplay({ _name: 'A' })] },
          { _name: 'GPU 1', spdisplays_ndrvs: [macDisplay({ _name: 'B' })] },
          { _name: 'Headless GPU' }, // no attached displays
        ],
      }),
  });

  const Identities = await Mod.GetDisplayIdentities();
  assert.deepEqual(
    Identities.map((I) => I.Name),
    ['A', 'B']
  );
});

test('macOS returns nothing rather than throwing on unusable output', async () => {
  for (const [Label, Output] of [
    ['system_profiler missing', null],
    ['empty output', ''],
    ['not JSON', 'system_profiler: command not found'],
    ['unexpected top level', JSON.stringify({ SPDisplaysDataType: 'nope' })],
    ['null top level', JSON.stringify({})],
  ]) {
    const { Mod } = load({ platform: 'darwin', command: () => Output });
    assert.deepEqual(await Mod.GetDisplayIdentities(), [], Label);
  }
});

// ===========================================================================
// Linux
// ===========================================================================

/** A valid 128-byte EDID block the real parser accepts. */
function edid({ manufacturer = 'DEL', productCode = 0xa1b2, serial = 0x11223344 } = {}) {
  const Buf = Buffer.alloc(128, 0);
  for (let i = 1; i <= 6; i += 1) Buf[i] = 0xff;

  // Manufacturer: three 5-bit letters, 'A' = 1.
  const Bits =
    ((manufacturer.charCodeAt(0) - 64) << 10) |
    ((manufacturer.charCodeAt(1) - 64) << 5) |
    (manufacturer.charCodeAt(2) - 64);
  Buf[8] = (Bits >> 8) & 0x7f;
  Buf[9] = Bits & 0xff;

  Buf.writeUInt16LE(productCode, 10);
  Buf.writeUInt32LE(serial, 12);
  Buf[16] = 10;
  Buf[17] = 34;

  let Sum = 0;
  for (let i = 0; i < 127; i += 1) Sum = (Sum + Buf[i]) & 0xff;
  Buf[127] = (256 - Sum) & 0xff;
  return Buf;
}

function loadLinux(connectors) {
  const files = {};
  const Entries = [];
  for (const [Name, Spec] of Object.entries(connectors)) {
    Entries.push(Name);
    const Dir = `/sys/class/drm/${Name}`;
    if (Spec.status !== undefined) files[`${Dir}/status`] = Spec.status;
    if (Spec.edid !== undefined) files[`${Dir}/edid`] = Spec.edid;
    if (Spec.modes !== undefined) files[`${Dir}/modes`] = Spec.modes;
  }
  return load({ platform: 'linux', dirs: { '/sys/class/drm': Entries }, files });
}

test('Linux reads the EDID of each connected connector', async () => {
  const { Mod } = loadLinux({
    'card0-DP-1': { status: 'connected\n', edid: edid(), modes: '3840x2160\n1920x1080\n' },
  });

  const [Identity] = await Mod.GetDisplayIdentities();

  assert.equal(Identity.Manufacturer, 'DEL');
  assert.equal(Identity.Product, 0xa1b2);
  assert.equal(Identity.ConnectorKey, 'linux:DP-1', 'the card prefix must be stripped');
  assert.equal(Identity.Width, 3840);
  assert.equal(Identity.Height, 2160);
  assert.ok(Identity.Fingerprint);
});

test('Linux skips the card entries and the disconnected connectors', async () => {
  // A disconnected connector still has an `edid` node holding the LAST panel
  // that was plugged into it. Reading it would resurrect a monitor that is no
  // longer there, and a critical-display alert would never fire.
  const { Mod } = loadLinux({
    card0: {}, // no '-' — the card itself, not a connector
    'card0-DP-1': { status: 'connected', edid: edid({ manufacturer: 'DEL' }) },
    'card0-HDMI-A-1': { status: 'disconnected', edid: edid({ manufacturer: 'ACR' }) },
    'card0-DP-2': { status: 'unknown', edid: edid({ manufacturer: 'BNQ' }) },
  });

  const Identities = await Mod.GetDisplayIdentities();
  assert.deepEqual(
    Identities.map((I) => I.Manufacturer),
    ['DEL']
  );
});

test('Linux treats an unreadable status as connected and lets the EDID decide', async () => {
  // Some drivers expose no status node at all; refusing those would lose real
  // monitors, and an absent EDID already filters out the empty connectors.
  const { Mod } = loadLinux({ 'card0-DP-1': { edid: edid() } });

  const Identities = await Mod.GetDisplayIdentities();
  assert.equal(Identities.length, 1);
  assert.equal(Identities[0].ConnectorKey, 'linux:DP-1');
});

test('Linux skips a connector with a missing or empty EDID node', async () => {
  const { Mod } = loadLinux({
    'card0-DP-1': { status: 'connected' }, // no edid node
    'card0-DP-2': { status: 'connected', edid: Buffer.alloc(0) },
    'card0-DP-3': { status: 'connected', edid: edid() },
  });

  const Identities = await Mod.GetDisplayIdentities();
  assert.deepEqual(
    Identities.map((I) => I.ConnectorKey),
    ['linux:DP-3']
  );
});

test('Linux tolerates a missing or unparseable native mode', async () => {
  const { Mod } = loadLinux({
    'card0-DP-1': { status: 'connected', edid: edid() }, // no modes node
    'card0-DP-2': { status: 'connected', edid: edid({ serial: 2 }), modes: 'garbage\n' },
  });

  const Identities = await Mod.GetDisplayIdentities();
  assert.equal(Identities.length, 2);
  for (const Identity of Identities) {
    assert.equal(Identity.Width, null);
    assert.equal(Identity.Height, null);
  }
});

test('Linux returns nothing when /sys/class/drm is unreadable', async () => {
  // No DRM subsystem, or a container without it mounted.
  const { Mod } = load({ platform: 'linux', dirs: {} });
  assert.deepEqual(await Mod.GetDisplayIdentities(), []);
});

test('Linux never reports a display as primary', async () => {
  // /sys exposes no such concept, so the matcher's primary pass has to be a
  // no-op here rather than guessing at the first connector.
  const { Mod } = loadLinux({ 'card0-DP-1': { status: 'connected', edid: edid() } });
  assert.equal((await Mod.GetDisplayIdentities())[0].Primary, false);
});

// ===========================================================================
// Windows
// ===========================================================================

const winRow = (Overrides = {}) => ({
  Manufacturer: 'DEL',
  Name: 'DELL U2720Q',
  Serial: 'ABC123',
  Product: 'A1B2',
  Instance: 'DISPLAY\\DEL41A8\\5&1234&0&UID4353_0',
  ...Overrides,
});

function loadWindows(Output) {
  return load({
    platform: 'win32',
    command: (cmd) => (cmd === 'powershell.exe' ? Output : null),
  });
}

test('Windows reads monitor identities out of WMI', async () => {
  const { Mod, commands } = loadWindows(JSON.stringify([winRow()]));

  const [Identity] = await Mod.GetDisplayIdentities();

  assert.equal(commands[0].cmd, 'powershell.exe');
  assert.ok(commands[0].args.includes('-NonInteractive'), 'PowerShell must not be able to prompt');
  assert.match(commands[0].args.join(' '), /WmiMonitorID/);
  assert.equal(Identity.Manufacturer, 'DEL');
  assert.equal(Identity.Name, 'DELL U2720Q');
  assert.equal(Identity.Serial, 'ABC123');
  assert.equal(Identity.Fingerprint, 'edid:DEL:A1B2:ABC123');
  assert.equal(Identity.ConnectorKey, 'win:DISPLAY\\DEL41A8\\5&1234&0&UID4353_0');
});

test('Windows unwraps the single-object form ConvertTo-Json emits for one monitor', async () => {
  // PowerShell's ConvertTo-Json serialises a one-element collection as a bare
  // object, not an array — so a laptop with one screen takes a different code
  // path from a desk with two.
  const { Mod } = loadWindows(JSON.stringify(winRow()));

  const Identities = await Mod.GetDisplayIdentities();
  assert.equal(Identities.length, 1);
  assert.equal(Identities[0].Serial, 'ABC123');
});

test('Windows trims the padding WMI leaves on decoded strings', async () => {
  const { Mod } = loadWindows(
    JSON.stringify([winRow({ Manufacturer: ' DEL ', Serial: 'ABC123  ', Name: ' Panel ' })])
  );

  const [Identity] = await Mod.GetDisplayIdentities();
  assert.equal(Identity.Manufacturer, 'DEL');
  assert.equal(Identity.Name, 'Panel');
  assert.match(Identity.Fingerprint, /^edid:DEL:A1B2:ABC123/);
});

test('a Windows monitor with no serial is still fingerprinted from make and model', async () => {
  // Plenty of panels report an empty SerialNumberID. Make+model is weaker (two
  // identical monitors collide) but still survives a reboot, which is the whole
  // point — so it is deliberately kept rather than discarded.
  const { Mod } = loadWindows(JSON.stringify([winRow({ Serial: '' })]));

  const [Identity] = await Mod.GetDisplayIdentities();
  assert.equal(Identity.Serial, null);
  assert.equal(Identity.Fingerprint, 'edid:DEL:A1B2:');
});

test('a Windows monitor with neither make nor model gets no fingerprint', async () => {
  const { Mod } = loadWindows(JSON.stringify([winRow({ Manufacturer: '', Product: '' })]));
  assert.equal((await Mod.GetDisplayIdentities())[0].Fingerprint, null);
});

test('Windows skips null rows and keeps the rest', async () => {
  const { Mod } = loadWindows(
    JSON.stringify([null, winRow({ Serial: 'A' }), null, winRow({ Serial: 'B' })])
  );

  const Identities = await Mod.GetDisplayIdentities();
  assert.deepEqual(
    Identities.map((I) => I.Serial),
    ['A', 'B']
  );
});

test('a monitor with no instance path gets no connector key', async () => {
  const { Mod } = loadWindows(JSON.stringify([winRow({ Instance: '' })]));
  assert.equal((await Mod.GetDisplayIdentities())[0].ConnectorKey, null);
});

test('Windows returns nothing rather than throwing on unusable output', async () => {
  for (const [Label, Output] of [
    ['powershell missing or blocked', null],
    ['empty output', ''],
    ['whitespace only', '   \r\n'],
    ['an error message instead of JSON', 'Get-CimInstance : Access is denied.'],
  ]) {
    const { Mod } = loadWindows(Output);
    assert.deepEqual(await Mod.GetDisplayIdentities(), [], Label);
  }
});

// ===========================================================================
// Dispatch
// ===========================================================================

test('each platform is routed to its own resolver', async () => {
  const Seen = [];
  for (const Platform of ['darwin', 'win32']) {
    const { Mod } = load({
      platform: Platform,
      command: (cmd) => {
        Seen.push(cmd);
        return null;
      },
    });
    await Mod.GetDisplayIdentities();
  }
  assert.deepEqual(Seen, ['system_profiler', 'powershell.exe']);
});

test('an unrecognised platform reports no identities and runs nothing', async () => {
  // FreeBSD, or anything Electron grows support for later: no resolver is
  // better than the wrong one.
  const { Mod, commands } = load({
    platform: 'aix',
    command: () => 'should never be called',
  });

  assert.deepEqual(await Mod.GetDisplayIdentities(), []);
  assert.equal(commands.length, 0);
});

test('GetDisplayIdentities never throws, whatever the OS does', async () => {
  // The caller has no useful recovery — it just falls back to session ids — so
  // the contract is a resolved empty array, never a rejection.
  const { Mod } = load({
    platform: 'darwin',
    command: () => {
      throw new Error('spawn EPERM');
    },
  });

  await assert.doesNotReject(() => Mod.GetDisplayIdentities());
});

test('the probe is bounded by a timeout so a hung tool cannot stall display reporting', async () => {
  // system_profiler and PowerShell can both hang for minutes on a broken
  // machine; display state is reported on a heartbeat and cannot wait.
  const Mac = load({ platform: 'darwin', command: () => null });
  await Mac.Mod.GetDisplayIdentities();
  assert.ok(Mac.commands[0].options.timeout > 0);

  const Win = load({ platform: 'win32', command: () => null });
  await Win.Mod.GetDisplayIdentities();
  assert.ok(Win.commands[0].options.timeout >= Mac.commands[0].options.timeout);

  // A console window flashing up on a show machine mid-performance is its own
  // kind of failure.
  assert.equal(Win.commands[0].options.windowsHide, true);
});

// ===========================================================================
// Physical size helpers
// ===========================================================================

test('physical size multiplies the logical size by the scale factor', async () => {
  const { Mod } = load({});
  const { physicalWidth, physicalHeight } = Mod._internal;

  assert.equal(physicalWidth({ Width: 1920, ScaleFactor: 2 }), 3840);
  assert.equal(physicalHeight({ Height: 1080, ScaleFactor: 2 }), 2160);
  assert.equal(physicalWidth({ Width: '2560', ScaleFactor: 1.5 }), 3840);
  assert.equal(physicalHeight({ Height: 1440, ScaleFactor: 1.5 }), 2160);
});

test('a missing or nonsensical scale factor is treated as 1, never as 0', async () => {
  // A zero would collapse every physical size to 0, which the matcher reads as
  // "no size known" and silently degrades to positional order.
  const { Mod } = load({});
  const { physicalWidth } = Mod._internal;

  for (const Scale of [undefined, null, 0, -2, NaN, Infinity, 'big']) {
    assert.equal(physicalWidth({ Width: 1920, ScaleFactor: Scale }), 1920, `scale ${Scale}`);
  }
});

test('an unknown size is 0, not NaN', async () => {
  const { Mod } = load({});
  const { physicalWidth, physicalHeight } = Mod._internal;

  for (const Display of [null, undefined, {}, { Width: 'wide' }, { Width: null }]) {
    assert.equal(physicalWidth(Display), 0);
    assert.equal(physicalHeight(Display), 0);
  }
});
