const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// TemperatureMonitor: sensor readings and macOS thermal pressure, reported as
// `Temperatures`.
//
// Every source is exercised through its parser with fixtures in the shape the
// platform produces — LibreHardwareMonitor's WMI rows, the ACPI thermal-zone
// counters in tenths of a kelvin, sysfs millidegrees, nvidia-smi CSV — and the
// monitor through a scripted sampler.

const DIST = path.join(__dirname, '..', 'dist', 'Modules', 'TemperatureMonitor');
const loggerStub = { CreateLogger: () => createSilentLogger() };

const loadShared = () => loadWithMocks(path.join(DIST, 'sensors.js'), { '../Logger': loggerStub });
const loadWindows = (mocks = {}) =>
  loadWithMocks(path.join(DIST, 'windows.js'), { '../Logger': loggerStub, ...mocks });
const loadLinux = () => loadWithMocks(path.join(DIST, 'linux.js'), { '../Logger': loggerStub });

// ---------------------------------------------------------------------------
// Shared rules
// ---------------------------------------------------------------------------

test('SanitizeSensors drops implausible readings, rounds, de-duplicates and caps', () => {
  const { SanitizeSensors, MAX_REPORTED_SENSORS } = loadShared();
  const out = SanitizeSensors([
    { Name: 'CPU Package', Kind: 'cpu', Celsius: 61.26 },
    { Name: 'Unplugged header', Kind: 'other', Celsius: -128 },
    { Name: 'Broken', Kind: 'other', Celsius: 255 },
    { Name: 'NaN', Kind: 'other', Celsius: Number.NaN },
    { Name: 'acpitz', Kind: 'system', Celsius: 27.8 },
    { Name: 'acpitz', Kind: 'system', Celsius: 29.94 },
  ]);
  assert.deepEqual(out, [
    { Name: 'CPU Package', Kind: 'cpu', Celsius: 61.3 },
    { Name: 'acpitz', Kind: 'system', Celsius: 27.8 },
    { Name: 'acpitz #2', Kind: 'system', Celsius: 29.9 },
  ]);

  const many = Array.from({ length: 50 }, (_, i) => ({
    Name: `S${i}`,
    Kind: 'other',
    Celsius: 40,
  }));
  assert.equal(SanitizeSensors(many).length, MAX_REPORTED_SENSORS);
});

test('KindFromDriver maps Linux drivers and zones', () => {
  const { KindFromDriver } = loadShared();
  for (const driver of ['coretemp', 'k10temp', 'zenpower', 'cpu_thermal', 'x86_pkg_temp']) {
    assert.equal(KindFromDriver(driver), 'cpu', driver);
  }
  for (const driver of ['amdgpu', 'nouveau', 'radeon'])
    assert.equal(KindFromDriver(driver), 'gpu', driver);
  for (const driver of ['nvme', 'drivetemp'])
    assert.equal(KindFromDriver(driver), 'storage', driver);
  assert.equal(KindFromDriver('acpitz'), 'system');
  assert.equal(KindFromDriver('BAT0'), 'battery');
  assert.equal(KindFromDriver('iwlwifi_1'), 'other');
});

test('KindFromIdentifier maps LibreHardwareMonitor / OpenHardwareMonitor identifiers', () => {
  const { KindFromIdentifier } = loadShared();
  assert.equal(KindFromIdentifier('/intelcpu/0/temperature/0'), 'cpu');
  assert.equal(KindFromIdentifier('/amdcpu/0/temperature/2'), 'cpu');
  assert.equal(KindFromIdentifier('/gpu-nvidia/0/temperature/0'), 'gpu');
  assert.equal(KindFromIdentifier('/nvidiagpu/0/temperature/0'), 'gpu');
  assert.equal(KindFromIdentifier('/nvme/0/temperature/0'), 'storage');
  assert.equal(KindFromIdentifier('/hdd/1/temperature/0'), 'storage');
  assert.equal(KindFromIdentifier('/lpc/nct6798d/temperature/1'), 'other');
});

test('ParseNvidiaSmi reads index, name and temperature, skipping unreadable GPUs', () => {
  const { ParseNvidiaSmi } = loadShared();
  assert.deepEqual(
    ParseNvidiaSmi(
      '0, NVIDIA GeForce RTX 3080, 54\r\n1, NVIDIA RTX A4000, [N/A]\r\n2, Quadro P2000, 41\r\n'
    ),
    [
      { Name: 'GPU 0 (NVIDIA GeForce RTX 3080)', Kind: 'gpu', Celsius: 54 },
      { Name: 'GPU 2 (Quadro P2000)', Kind: 'gpu', Celsius: 41 },
    ]
  );
  assert.deepEqual(ParseNvidiaSmi(''), []);
});

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

test('Windows: LibreHardwareMonitor rows become named, kinded sensors', () => {
  const { ParseWindowsTemperatures, MapWindowsTemperatures } = loadWindows();
  const parsed = ParseWindowsTemperatures(
    JSON.stringify({
      Source: 'librehardwaremonitor',
      Rows: [
        {
          Name: 'CPU Package',
          Value: 62.5,
          Identifier: '/intelcpu/0/temperature/6',
          Hardware: 'Intel Core i7-9700K',
        },
        {
          Name: 'Core #1 Distance to TjMax',
          Value: 38,
          Identifier: '/intelcpu/0/temperature/8',
          Hardware: 'Intel Core i7-9700K',
        },
        {
          Name: 'GPU Core',
          Value: 48,
          Identifier: '/gpu-nvidia/0/temperature/0',
          Hardware: 'NVIDIA GeForce RTX 3080',
        },
        {
          Name: 'Temperature',
          Value: 35,
          Identifier: '/nvme/0/temperature/0',
          Hardware: 'Samsung SSD 980 PRO 1TB',
        },
        {
          Name: 'Temperature #1',
          Value: 33,
          Identifier: '/lpc/nct6798d/temperature/0',
          Hardware: 'Nuvoton NCT6798D',
        },
      ],
    })
  );
  assert.equal(parsed.Source, 'librehardwaremonitor');
  assert.deepEqual(MapWindowsTemperatures(parsed.Source, parsed.Rows), [
    { Name: 'CPU Package', Kind: 'cpu', Celsius: 62.5 },
    { Name: 'GPU Core', Kind: 'gpu', Celsius: 48 },
    // A generic name is qualified with the hardware it belongs to.
    { Name: 'Samsung SSD 980 PRO 1TB Temperature', Kind: 'storage', Celsius: 35 },
    { Name: 'Temperature #1', Kind: 'other', Celsius: 33 },
  ]);
});

test('Windows: thermal-zone counters are tenths of a kelvin', () => {
  const { ParseWindowsTemperatures, MapWindowsTemperatures } = loadWindows();
  const parsed = ParseWindowsTemperatures(
    JSON.stringify({ Source: 'thermalzone-perf', Rows: { Name: '\\_TZ.CPUZ', Value: 3282 } })
  );
  const sensors = MapWindowsTemperatures(parsed.Source, parsed.Rows);
  assert.equal(sensors.length, 1, 'one zone serialised as a bare object is still read');
  assert.equal(sensors[0].Name, 'CPUZ');
  assert.equal(sensors[0].Kind, 'cpu');
  assert.ok(Math.abs(sensors[0].Celsius - 55.05) < 1e-9);

  const acpi = ParseWindowsTemperatures(
    JSON.stringify({
      Source: 'acpi',
      Rows: [
        { Name: 'ACPI\\ThermalZone\\TZ00_0', Value: 3010 },
        { Name: 'ACPI\\ThermalZone\\TZ01_0', Value: 0 },
      ],
    })
  );
  const acpiSensors = MapWindowsTemperatures(acpi.Source, acpi.Rows);
  assert.equal(acpiSensors.length, 1, 'a zone reading 0 K is not a reading');
  assert.equal(acpiSensors[0].Name, 'TZ00_0');
  assert.equal(acpiSensors[0].Kind, 'system');
});

test('Windows: no source is an empty reading; garbage is an error', () => {
  const { ParseWindowsTemperatures, MapWindowsTemperatures } = loadWindows();
  const none = ParseWindowsTemperatures('{"Source":null,"Rows":[]}');
  assert.equal(none.Source, null);
  assert.deepEqual(MapWindowsTemperatures(none.Source, none.Rows), []);
  assert.throws(() => ParseWindowsTemperatures(''));
  assert.throws(() => ParseWindowsTemperatures('Get-CimInstance : Invalid namespace'));
});

test('Windows: the script tries each source in order, each on its own', () => {
  const { WINDOWS_TEMPERATURE_SCRIPT } = loadWindows();
  assert.doesNotMatch(WINDOWS_TEMPERATURE_SCRIPT, /\n/, 'the host evaluates one line per request');
  const order = [
    'root/LibreHardwareMonitor',
    'root/OpenHardwareMonitor',
    'Win32_PerfFormattedData_Counters_ThermalZoneInformation',
    'MSAcpi_ThermalZoneTemperature',
  ].map((needle) => WINDOWS_TEMPERATURE_SCRIPT.indexOf(needle));
  assert.ok(order.every((index) => index !== -1));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order
  );
  assert.match(WINDOWS_TEMPERATURE_SCRIPT, /ConvertTo-Json -Compress/);
  assert.equal((WINDOWS_TEMPERATURE_SCRIPT.match(/-ErrorAction Stop/g) || []).length >= 4, true);
});

test('Windows: reads through the persistent host, falling back to a one-shot spawn', async () => {
  let hostAnswer = [null, '{"Source":"acpi","Rows":[{"Name":"TZ00_0","Value":3000}]}'];
  const execs = [];
  const { CollectWindowsTemperatures } = loadWindows({
    '../ProcessMonitor/powershell-host': {
      CreatePowerShellHost: () => ({ Run: async () => hostAnswer, Dispose: () => {} }),
    },
    '../AudioMonitor/shared': {
      RunCommand: async (command, args) => {
        execs.push([command, args]);
        return [null, '{"Source":null,"Rows":[]}'];
      },
    },
  });
  const [err, reading] = await CollectWindowsTemperatures();
  assert.equal(err, null);
  assert.equal(reading.Backend, 'acpi');
  assert.equal(reading.Sensors.length, 1);
  assert.equal(execs.length, 0);

  hostAnswer = [new Error('PowerShell host unavailable'), null];
  const [err2, reading2] = await CollectWindowsTemperatures();
  assert.equal(err2, null);
  assert.equal(reading2.Backend, null);
  assert.equal(execs[0][0], 'powershell.exe');
});

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

function sysfs(files) {
  const dirs = new Map();
  for (const file of Object.keys(files)) {
    const parts = file.split('/');
    for (let i = 2; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join('/');
      if (!dirs.has(dir)) dirs.set(dir, new Set());
      dirs.get(dir).add(parts[i]);
    }
  }
  return {
    ReadDir: (dir) => {
      if (!dirs.has(dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return [...dirs.get(dir)];
    },
    ReadFile: (file) => (file in files ? `${files[file]}\n` : null),
  };
}

test('Linux: hwmon and thermal zones, with labels, kinds and no double-counted zones', () => {
  const { ReadLinuxTemperatures } = loadLinux();
  const reader = sysfs({
    '/sys/class/hwmon/hwmon0/name': 'acpitz',
    '/sys/class/hwmon/hwmon0/temp1_input': '27800',
    '/sys/class/hwmon/hwmon2/name': 'coretemp',
    '/sys/class/hwmon/hwmon2/temp1_input': '61000',
    '/sys/class/hwmon/hwmon2/temp1_label': 'Package id 0',
    '/sys/class/hwmon/hwmon2/temp2_input': '58000',
    '/sys/class/hwmon/hwmon2/temp2_label': 'Core 0',
    '/sys/class/hwmon/hwmon10/name': 'nvme',
    '/sys/class/hwmon/hwmon10/temp1_input': '38850',
    '/sys/class/hwmon/hwmon10/temp1_label': 'Composite',
    '/sys/class/thermal/thermal_zone0/type': 'acpitz',
    '/sys/class/thermal/thermal_zone0/temp': '27800',
    '/sys/class/thermal/thermal_zone1/type': 'x86_pkg_temp',
    '/sys/class/thermal/thermal_zone1/temp': '62000',
    '/sys/class/thermal/cooling_device0/type': 'Processor',
  });
  const { Sensors, Backends } = ReadLinuxTemperatures(reader);
  assert.deepEqual(Sensors, [
    { Name: 'acpitz temp1', Kind: 'system', Celsius: 27.8 },
    { Name: 'coretemp Package id 0', Kind: 'cpu', Celsius: 61 },
    { Name: 'coretemp Core 0', Kind: 'cpu', Celsius: 58 },
    { Name: 'nvme Composite', Kind: 'storage', Celsius: 38.85 },
    // acpitz is already listed through hwmon; x86_pkg_temp is not.
    { Name: 'x86_pkg_temp', Kind: 'cpu', Celsius: 62 },
  ]);
  assert.deepEqual(Backends, ['hwmon', 'thermal']);
});

test('Linux: a machine with neither class reads as no sensors, not an error', () => {
  const { ReadLinuxTemperatures } = loadLinux();
  assert.deepEqual(ReadLinuxTemperatures(sysfs({})), { Sensors: [], Backends: [] });
});

// ---------------------------------------------------------------------------
// The monitor
// ---------------------------------------------------------------------------

function loadMonitor({ powerMonitor = null, platform } = {}) {
  const state = {
    next: {
      Ok: true,
      Reading: {
        Backend: 'hwmon',
        Sensors: [{ Name: 'coretemp Package id 0', Kind: 'cpu', Celsius: 60 }],
        ThermalState: null,
      },
    },
    disposals: 0,
  };
  const intervals = [];
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  global.setInterval = (callback, ms) => {
    const handle = { callback, ms, unref() {} };
    intervals.push(handle);
    return handle;
  };
  global.clearInterval = (handle) => {
    const index = intervals.indexOf(handle);
    if (index !== -1) intervals.splice(index, 1);
  };
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  if (platform) Object.defineProperty(process, 'platform', { value: platform });
  const mod = loadWithMocks(path.join(DIST, 'index.js'), {
    electron: powerMonitor ? { powerMonitor } : {},
    './samplers': {
      CollectTemperatures: async () => state.next,
      DisposeTemperatureSamplers: () => {
        state.disposals += 1;
      },
    },
    '../Logger': loggerStub,
  });
  return {
    ...mod,
    state,
    intervals,
    restore: () => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
      if (platform) Object.defineProperty(process, 'platform', originalPlatform);
    },
  };
}

function fakeSocket() {
  const emits = [];
  return { connected: true, emits, emit: (event, payload) => emits.push([event, payload]) };
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('BuildSnapshot: sensors are ok; macOS thermal pressure alone is ok; nothing is unsupported', () => {
  const H = loadMonitor();
  try {
    const { BuildSnapshot, _internal } = H;
    const ok = BuildSnapshot(H.state.next, 'linux', 7);
    assert.deepEqual(ok, {
      SampledAt: 7,
      Status: { State: 'ok', Message: null, Platform: 'linux', Backend: 'hwmon' },
      Sensors: [{ Name: 'coretemp Package id 0', Kind: 'cpu', Celsius: 60 }],
      ThermalState: null,
    });

    const mac = BuildSnapshot(
      { Ok: true, Reading: { Backend: null, Sensors: [], ThermalState: 'fair' } },
      'darwin',
      7
    );
    assert.deepEqual(mac.Status, {
      State: 'ok',
      Message: 'macOS reports thermal pressure only; temperatures need administrator tools',
      Platform: 'darwin',
      Backend: 'thermal-state',
    });
    assert.equal(mac.ThermalState, 'fair');

    const macUnknown = BuildSnapshot(
      { Ok: true, Reading: { Backend: null, Sensors: [], ThermalState: null } },
      'darwin',
      7
    );
    assert.equal(macUnknown.Status.State, 'unsupported');

    const windows = BuildSnapshot(
      { Ok: true, Reading: { Backend: null, Sensors: [], ThermalState: null } },
      'win32',
      7
    );
    assert.equal(windows.Status.State, 'unsupported');
    assert.equal(windows.Status.Message, _internal.UNSUPPORTED_MESSAGES.win32);
    assert.match(windows.Status.Message, /LibreHardwareMonitor/);

    const failed = BuildSnapshot({ Ok: false, Error: new Error('host died') }, 'win32', 7);
    assert.equal(failed.Status.State, 'error');
    assert.equal(failed.Status.Message, 'host died');
  } finally {
    H.restore();
  }
});

test('HasMeaningfulChange: a degree or more, a new sensor, or a new thermal state', () => {
  const H = loadMonitor();
  try {
    const { HasMeaningfulChange, BuildSnapshot } = H;
    const snap = (sensors, thermal = null) =>
      BuildSnapshot(
        { Ok: true, Reading: { Backend: 'hwmon', Sensors: sensors, ThermalState: thermal } },
        'linux',
        1
      );
    const base = snap([{ Name: 'cpu', Kind: 'cpu', Celsius: 60 }]);
    assert.equal(HasMeaningfulChange(null, base), true);
    assert.equal(
      HasMeaningfulChange(base, snap([{ Name: 'cpu', Kind: 'cpu', Celsius: 60.9 }])),
      false
    );
    assert.equal(
      HasMeaningfulChange(base, snap([{ Name: 'cpu', Kind: 'cpu', Celsius: 61 }])),
      true
    );
    assert.equal(
      HasMeaningfulChange(base, snap([{ Name: 'cpu', Kind: 'cpu', Celsius: 59 }])),
      true
    );
    assert.equal(
      HasMeaningfulChange(
        base,
        snap([
          { Name: 'cpu', Kind: 'cpu', Celsius: 60 },
          { Name: 'gpu', Kind: 'gpu', Celsius: 40 },
        ])
      ),
      true
    );
    assert.equal(
      HasMeaningfulChange(base, snap([{ Name: 'cpu', Kind: 'cpu', Celsius: 60 }], 'serious')),
      true
    );
  } finally {
    H.restore();
  }
});

test('reports on start, holds back sub-degree jitter, and keeps alive', async () => {
  const H = loadMonitor();
  const realNow = Date.now;
  let now = 5_000_000;
  Date.now = () => now;
  try {
    const socket = fakeSocket();
    await H.Manager.Start(socket);
    assert.deepEqual(
      socket.emits.map(([event]) => event),
      ['Temperatures']
    );

    // Creeping up by half a degree per poll: reported once it has moved a whole
    // degree from what the server was last told, not never.
    for (const celsius of [60.5, 61.0]) {
      H.state.next = {
        Ok: true,
        Reading: {
          Backend: 'hwmon',
          Sensors: [{ Name: 'coretemp Package id 0', Kind: 'cpu', Celsius: celsius }],
          ThermalState: null,
        },
      };
      now += 30_000;
      H.intervals[0].callback();
      await flush();
    }
    assert.equal(socket.emits.length, 2);
    assert.equal(socket.emits[1][1].Sensors[0].Celsius, 61);

    now += 60_000;
    H.intervals[0].callback();
    await flush();
    assert.equal(socket.emits.length, 3, 'keepalive');
    H.Manager.Dispose();
    assert.equal(H.intervals.length, 0);
  } finally {
    Date.now = realNow;
    H.restore();
  }
});

test('macOS: a thermal state change is reported at once; the listener never stacks', async () => {
  const powerMonitor = new EventEmitter();
  const H = loadMonitor({ powerMonitor, platform: 'darwin' });
  try {
    H.state.next = { Ok: true, Reading: { Backend: null, Sensors: [], ThermalState: 'nominal' } };
    const socket = fakeSocket();
    await H.Manager.Start(socket);
    H.Manager.Stop();
    await H.Manager.Start(socket);
    assert.equal(powerMonitor.listenerCount('thermal-state-change'), 1);

    H.state.next = { Ok: true, Reading: { Backend: null, Sensors: [], ThermalState: 'serious' } };
    powerMonitor.emit('thermal-state-change', { state: 'serious' });
    await flush();
    const last = socket.emits[socket.emits.length - 1][1];
    assert.equal(last.ThermalState, 'serious');

    H.Manager.Dispose();
    assert.equal(powerMonitor.listenerCount('thermal-state-change'), 0);
  } finally {
    H.restore();
  }
});

// ---------------------------------------------------------------------------
// Sampler dispatch: nvidia-smi and thermal state
// ---------------------------------------------------------------------------

function loadSamplers({
  windows,
  thermalState = 'nominal',
  nvidia = '0, NVIDIA GeForce RTX 3080, 55\n',
  nvidiaPath = 'nvidia-smi.exe',
} = {}) {
  const runs = [];
  const lookups = [];
  const mod = loadWithMocks(path.join(DIST, 'samplers.js'), {
    '../Logger': loggerStub,
    electron: {
      powerMonitor: {
        on() {},
        removeListener() {},
        getCurrentThermalState: () => thermalState,
      },
    },
    './windows': {
      CollectWindowsTemperatures: async () => windows,
      DisposeWindowsTemperatures: () => {},
    },
    '../Utils': {
      FindOnPath: (command) => {
        lookups.push(command);
        return command === 'nvidia-smi' ? nvidiaPath : null;
      },
    },
    '../AudioMonitor/shared': {
      RunCommand: async (command, args) => {
        runs.push([command, args]);
        return [null, nvidia];
      },
      ErrorText: (error, fallback) => (error && error.message) || fallback,
    },
  });
  return { ...mod, runs, lookups };
}

test('nvidia-smi GPUs are added when the source has none, and skipped when it has one', async () => {
  const withoutGpu = loadSamplers({
    windows: [
      null,
      { Backend: 'thermalzone-perf', Sensors: [{ Name: 'CPUZ', Kind: 'cpu', Celsius: 55 }] },
    ],
  });
  const first = await withoutGpu.CollectTemperatures('win32');
  assert.equal(first.Ok, true);
  assert.equal(first.Reading.Backend, 'thermalzone-perf+nvidia-smi');
  assert.deepEqual(
    first.Reading.Sensors.map((s) => [s.Name, s.Kind]),
    [
      ['CPUZ', 'cpu'],
      ['GPU 0 (NVIDIA GeForce RTX 3080)', 'gpu'],
    ]
  );
  assert.deepEqual(withoutGpu.runs[0][1], [
    '--query-gpu=index,name,temperature.gpu',
    '--format=csv,noheader,nounits',
  ]);
  await withoutGpu.CollectTemperatures('win32');
  assert.deepEqual(withoutGpu.lookups, ['nvidia-smi'], 'PATH is searched once per process');

  const withGpu = loadSamplers({
    windows: [
      null,
      {
        Backend: 'librehardwaremonitor',
        Sensors: [{ Name: 'GPU Core', Kind: 'gpu', Celsius: 48 }],
      },
    ],
  });
  const second = await withGpu.CollectTemperatures('win32');
  assert.equal(second.Reading.Backend, 'librehardwaremonitor');
  assert.equal(withGpu.runs.length, 0, 'the same card is not listed twice');
});

test('nvidia-smi alone is enough to report; without it, nothing is unsupported, not an error', async () => {
  const gpuOnly = loadSamplers({ windows: [null, { Backend: null, Sensors: [] }] });
  const reading = await gpuOnly.CollectTemperatures('win32');
  assert.equal(reading.Reading.Backend, 'nvidia-smi');

  const nothing = loadSamplers({
    windows: [null, { Backend: null, Sensors: [] }],
    nvidiaPath: null,
  });
  const empty = await nothing.CollectTemperatures('win32');
  assert.equal(empty.Ok, true);
  assert.deepEqual(empty.Reading.Sensors, []);
  assert.equal(nothing.runs.length, 0);
});

test('macOS reads thermal pressure from Electron; "unknown" is null; other platforms never', async () => {
  const fair = loadSamplers({ thermalState: 'fair' });
  assert.equal(fair.ReadThermalState('darwin'), 'fair');
  const macReading = await fair.CollectTemperatures('darwin');
  assert.deepEqual(macReading.Reading, { Backend: null, Sensors: [], ThermalState: 'fair' });

  const unknown = loadSamplers({ thermalState: 'unknown' });
  assert.equal(unknown.ReadThermalState('darwin'), null);
  assert.equal(fair.ReadThermalState('win32'), null);
});

test('Windows: PowerShell 5.1 wrapped-array JSON is still a list of rows', () => {
  const { ParseWindowsTemperatures } = loadWindows();
  const parsed = ParseWindowsTemperatures(
    JSON.stringify({
      Source: 'acpi',
      Rows: {
        value: [
          { Name: 'TZ00_0', Value: 3000 },
          { Name: 'TZ01_0', Value: 3100 },
        ],
        Count: 2,
      },
    })
  );
  assert.equal(parsed.Rows.length, 2);
});
