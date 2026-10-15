const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// PowerMonitor: battery, mains and sleep/resume, reported as `PowerStatus`.
//
// The parsers are tested against the text each platform really prints; the
// monitor itself against a scripted sampler and a fake Electron powerMonitor,
// so the lifecycle rules — listeners attached once, timestamps that outlive a
// reconnect — are pinned down independently of the machine running the suite.

const DIST = path.join(__dirname, '..', 'dist', 'Modules', 'PowerMonitor');
const loggerStub = { CreateLogger: () => createSilentLogger() };

function loadSamplers(mocks = {}) {
  return loadWithMocks(path.join(DIST, 'samplers.js'), { '../Logger': loggerStub, ...mocks });
}

// ---------------------------------------------------------------------------
// macOS: pmset -g batt
// ---------------------------------------------------------------------------

test('pmset: discharging on battery, with a runtime estimate', () => {
  const { ParsePmsetBatt } = loadSamplers();
  const reading = ParsePmsetBatt(
    "Now drawing from 'Battery Power'\n" +
      ' -InternalBattery-0 (id=22216803)\t78%; discharging; 3:03 remaining present: true\n'
  );
  assert.deepEqual(reading, {
    Battery: { Percent: 78, Charging: false, TimeRemainingMinutes: 183 },
    OnBattery: true,
  });
});

test('pmset: charging on AC reports no runtime (the estimate is time to full)', () => {
  const { ParsePmsetBatt } = loadSamplers();
  const reading = ParsePmsetBatt(
    "Now drawing from 'AC Power'\n" +
      ' -InternalBattery-0 (id=4653155)\t85%; charging; 1:23 remaining present: true\n'
  );
  assert.deepEqual(reading, {
    Battery: { Percent: 85, Charging: true, TimeRemainingMinutes: null },
    OnBattery: false,
  });
});

test('pmset: charged, finishing charge, not charging and no estimate', () => {
  const { ParsePmsetBatt } = loadSamplers();
  const charged = ParsePmsetBatt(
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true\n"
  );
  assert.deepEqual(charged.Battery, { Percent: 100, Charging: false, TimeRemainingMinutes: null });

  const finishing = ParsePmsetBatt(
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t98%; finishing charge; 0:10 remaining present: true\n"
  );
  assert.equal(finishing.Battery.Charging, true);

  const held = ParsePmsetBatt(
    "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; AC attached; not charging present: true\n"
  );
  assert.deepEqual(held.Battery, { Percent: 80, Charging: false, TimeRemainingMinutes: null });

  const noEstimate = ParsePmsetBatt(
    "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t64%; discharging; (no estimate) present: true\n"
  );
  assert.deepEqual(noEstimate.Battery, {
    Percent: 64,
    Charging: false,
    TimeRemainingMinutes: null,
  });
});

test('pmset: a Mac with no battery (or only a UPS) has Battery null', () => {
  const { ParsePmsetBatt } = loadSamplers();
  assert.deepEqual(ParsePmsetBatt("Now drawing from 'AC Power'\n"), {
    Battery: null,
    OnBattery: false,
  });
  const ups = ParsePmsetBatt(
    "Now drawing from 'UPS Power'\n -CP1500PFCLCD (id=123)\t90%; discharging; 0:45 remaining present: true\n"
  );
  assert.equal(ups.Battery, null, "a UPS is not the machine's battery");
  assert.equal(ups.OnBattery, true, 'but running from it is not running from mains');
});

// ---------------------------------------------------------------------------
// Windows: Win32_Battery
// ---------------------------------------------------------------------------

test('Win32_Battery: discharging laptop', () => {
  const { ParseWin32Battery, MapWin32Battery } = loadSamplers();
  const rows = ParseWin32Battery('[{"Percent":57,"Status":1,"RunTime":142}]');
  assert.deepEqual(MapWin32Battery(rows), {
    Battery: { Percent: 57, Charging: false, TimeRemainingMinutes: 142 },
    OnBattery: true,
  });
});

test('Win32_Battery: charging states, and the "unknown runtime" sentinel', () => {
  const { ParseWin32Battery, MapWin32Battery, _internal } = loadSamplers();
  for (const status of [6, 7, 8, 9]) {
    const reading = MapWin32Battery(
      ParseWin32Battery(
        JSON.stringify({ Percent: 40, Status: status, RunTime: _internal.WIN32_RUNTIME_UNKNOWN })
      )
    );
    assert.equal(reading.Battery.Charging, true, `status ${status}`);
    assert.equal(reading.Battery.TimeRemainingMinutes, null);
    assert.equal(reading.OnBattery, false);
  }
  // 2 is what Windows reports on AC whether or not it is charging: on mains,
  // charging unknown, and 71582788 is "no estimate".
  const onAc = MapWin32Battery(ParseWin32Battery('{"Percent":100,"Status":2,"RunTime":71582788}'));
  assert.deepEqual(onAc, {
    Battery: { Percent: 100, Charging: null, TimeRemainingMinutes: null },
    OnBattery: false,
  });
});

test('Win32_Battery: no instance is a desktop (Battery null), not an error', () => {
  const { ParseWin32Battery, MapWin32Battery } = loadSamplers();
  assert.deepEqual(MapWin32Battery(ParseWin32Battery('[]')), { Battery: null, OnBattery: null });
  assert.deepEqual(MapWin32Battery(ParseWin32Battery('')), { Battery: null, OnBattery: null });
});

test('Win32_Battery: two batteries average their charge', () => {
  const { ParseWin32Battery, MapWin32Battery } = loadSamplers();
  const reading = MapWin32Battery(
    ParseWin32Battery(
      '[{"Percent":80,"Status":1,"RunTime":200},{"Percent":40,"Status":1,"RunTime":null}]'
    )
  );
  assert.equal(reading.Battery.Percent, 60);
  assert.equal(reading.Battery.TimeRemainingMinutes, 200);
});

test('Win32_Battery: output that is not the battery list is an error', () => {
  const { ParseWin32Battery } = loadSamplers();
  assert.throws(() => ParseWin32Battery('Get-CimInstance : Access denied'));
});

test('Windows reads through the persistent host and falls back to a one-shot spawn', async () => {
  const runs = [];
  const execs = [];
  let hostAnswer = [null, '[{"Percent":90,"Status":2,"RunTime":71582788}]'];
  const { CollectWindowsPower, WINDOWS_BATTERY_SCRIPT } = loadSamplers({
    '../ProcessMonitor/powershell-host': {
      CreatePowerShellHost: () => ({
        Run: async (script) => {
          runs.push(script);
          return hostAnswer;
        },
        Dispose: () => {},
      }),
    },
    '../AudioMonitor/shared': {
      RunCommand: async (command, args) => {
        execs.push([command, args]);
        return [null, '[]'];
      },
    },
  });
  assert.doesNotMatch(WINDOWS_BATTERY_SCRIPT, /\n/);
  assert.match(WINDOWS_BATTERY_SCRIPT, /-ErrorAction Stop/);

  const [err, reading] = await CollectWindowsPower();
  assert.equal(err, null);
  assert.equal(reading.Backend, 'wmi');
  assert.equal(reading.Battery.Percent, 90);
  assert.equal(execs.length, 0);

  hostAnswer = [new Error('PowerShell host unavailable'), null];
  const [err2, reading2] = await CollectWindowsPower();
  assert.equal(err2, null);
  assert.equal(reading2.Battery, null);
  assert.equal(execs[0][0], 'powershell.exe');
});

// ---------------------------------------------------------------------------
// Linux: /sys/class/power_supply
// ---------------------------------------------------------------------------

/** A fake sysfs: `tree` maps a supply name to its attribute files. */
function sysfs(tree) {
  return {
    ReadDir: (dir) => {
      if (dir !== '/sys/class/power_supply') {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return Object.keys(tree);
    },
    ReadFile: (file) => {
      const [, , , , supply, attribute] = file.split('/');
      const value = tree[supply] && tree[supply][attribute];
      return value === undefined ? null : `${value}\n`;
    },
  };
}

test('sysfs: a discharging laptop, with runtime from energy over power', () => {
  const { ReadLinuxPowerSupply } = loadSamplers();
  const reading = ReadLinuxPowerSupply(
    '/sys/class/power_supply',
    sysfs({
      AC: { type: 'Mains', online: '0' },
      BAT0: {
        type: 'Battery',
        status: 'Discharging',
        capacity: '73',
        energy_now: '36000000',
        power_now: '12000000',
      },
    })
  );
  assert.deepEqual(reading, {
    Battery: { Percent: 73, Charging: false, TimeRemainingMinutes: 180 },
    OnBattery: true,
  });
});

test('sysfs: charging on mains; a USB-C charger counts as mains', () => {
  const { ReadLinuxPowerSupply } = loadSamplers();
  const reading = ReadLinuxPowerSupply(
    '/sys/class/power_supply',
    sysfs({
      ucsi_source_psy_USBC000_001: { type: 'USB', online: '1' },
      BAT0: { type: 'Battery', status: 'Charging', capacity: '41' },
    })
  );
  assert.deepEqual(reading, {
    Battery: { Percent: 41, Charging: true, TimeRemainingMinutes: null },
    OnBattery: false,
  });
});

test('sysfs: a mouse battery is not the machine battery', () => {
  const { ReadLinuxPowerSupply } = loadSamplers();
  const reading = ReadLinuxPowerSupply(
    '/sys/class/power_supply',
    sysfs({
      hidpp_battery_0: { type: 'Battery', scope: 'Device', status: 'Discharging', capacity: '20' },
    })
  );
  assert.deepEqual(reading, { Battery: null, OnBattery: null });
});

test('sysfs: a desktop with no supplies, or no power_supply class at all, has Battery null', () => {
  const { ReadLinuxPowerSupply } = loadSamplers();
  assert.deepEqual(ReadLinuxPowerSupply('/sys/class/power_supply', sysfs({})), {
    Battery: null,
    OnBattery: null,
  });
  assert.deepEqual(ReadLinuxPowerSupply('/nonexistent', sysfs({})), {
    Battery: null,
    OnBattery: null,
  });
  assert.throws(() =>
    ReadLinuxPowerSupply('/sys/class/power_supply', {
      ReadDir: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      ReadFile: () => null,
    })
  );
});

// ---------------------------------------------------------------------------
// The monitor
// ---------------------------------------------------------------------------

function fakePowerMonitor({ onBattery = false } = {}) {
  const emitter = new EventEmitter();
  emitter.onBattery = onBattery;
  emitter.isOnBatteryPower = () => emitter.onBattery;
  return emitter;
}

function okReading(battery = { Percent: 80, Charging: false, TimeRemainingMinutes: 120 }) {
  return { Ok: true, Reading: { Backend: 'pmset', Battery: battery, OnBattery: true } };
}

function loadMonitor({ powerMonitor = fakePowerMonitor(), collect } = {}) {
  const state = { collections: 0, disposals: 0, next: okReading() };
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
  const mod = loadWithMocks(path.join(DIST, 'index.js'), {
    electron: { powerMonitor },
    './samplers': {
      CollectPower: async () => {
        state.collections += 1;
        return collect ? collect() : state.next;
      },
      DisposePowerSamplers: () => {
        state.disposals += 1;
      },
    },
    '../Logger': loggerStub,
  });
  return {
    ...mod,
    state,
    intervals,
    powerMonitor,
    restore: () => {
      global.setInterval = originalSetInterval;
      global.clearInterval = originalClearInterval;
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

test('BuildSnapshot: Electron decides OnBattery; runtime is dropped on mains', () => {
  const { BuildSnapshot, restore } = loadMonitor();
  try {
    const stamps = { LastSuspendAt: null, LastResumeAt: null };
    const onBattery = BuildSnapshot(okReading(), true, stamps, 'darwin', 5);
    assert.deepEqual(onBattery, {
      SampledAt: 5,
      Status: { State: 'ok', Message: null, Platform: 'darwin', Backend: 'pmset' },
      Battery: { Percent: 80, Charging: false, TimeRemainingMinutes: 120 },
      OnBattery: true,
      LastSuspendAt: null,
      LastResumeAt: null,
    });
    const onMains = BuildSnapshot(okReading(), false, stamps, 'darwin', 5);
    assert.equal(onMains.OnBattery, false);
    assert.equal(onMains.Battery.TimeRemainingMinutes, null);
    // Outside Electron the platform's own reading stands in.
    assert.equal(BuildSnapshot(okReading(), null, stamps, 'darwin', 5).OnBattery, true);
  } finally {
    restore();
  }
});

test('BuildSnapshot: a desktop is ok with no battery; failures are errors; nothing at all is unsupported', () => {
  const { BuildSnapshot, restore } = loadMonitor();
  try {
    const stamps = { LastSuspendAt: null, LastResumeAt: null };
    const desktop = BuildSnapshot(
      { Ok: true, Reading: { Backend: 'wmi', Battery: null, OnBattery: null } },
      false,
      stamps,
      'win32',
      1
    );
    assert.equal(desktop.Status.State, 'ok');
    assert.equal(desktop.Battery, null);
    assert.equal(desktop.OnBattery, false);

    const failed = BuildSnapshot(
      { Ok: false, Unsupported: false, Error: new Error('WMI is broken') },
      false,
      stamps,
      'win32',
      1
    );
    assert.deepEqual(failed.Status, {
      State: 'error',
      Message: 'WMI is broken',
      Platform: 'win32',
      Backend: null,
    });
    assert.equal(failed.OnBattery, false, 'what Electron knows is still reported');

    const unsupported = BuildSnapshot(
      { Ok: false, Unsupported: true, Error: new Error('not here') },
      null,
      stamps,
      'aix',
      1
    );
    assert.equal(unsupported.Status.State, 'unsupported');
    const electronOnly = BuildSnapshot(
      { Ok: false, Unsupported: true, Error: new Error('not here') },
      false,
      stamps,
      'freebsd',
      1
    );
    assert.equal(electronOnly.Status.State, 'ok');
    assert.equal(electronOnly.Status.Backend, 'electron');
  } finally {
    restore();
  }
});

test('the runtime estimate wobbling by a minute or two is not a change', () => {
  const { BuildSnapshot, SnapshotSignature, restore } = loadMonitor();
  try {
    const stamps = { LastSuspendAt: null, LastResumeAt: null };
    const at = (minutes, percent = 80) =>
      SnapshotSignature(
        BuildSnapshot(
          okReading({ Percent: percent, Charging: false, TimeRemainingMinutes: minutes }),
          true,
          stamps,
          'linux',
          1
        )
      );
    assert.equal(at(121), at(122));
    assert.notEqual(at(121), at(140));
    assert.notEqual(at(121, 80), at(121, 79), 'a percent of charge is a change');
  } finally {
    restore();
  }
});

test('reports on start, then only on change or keepalive', async () => {
  const H = loadMonitor();
  const realNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    const socket = fakeSocket();
    await H.Manager.Start(socket);
    assert.equal(socket.emits.length, 1);
    assert.equal(socket.emits[0][0], 'PowerStatus');

    now += 30_000;
    H.intervals[0].callback();
    await flush();
    assert.equal(socket.emits.length, 1, 'nothing changed');

    H.state.next = okReading({ Percent: 79, Charging: false, TimeRemainingMinutes: 118 });
    now += 30_000;
    H.intervals[0].callback();
    await flush();
    assert.equal(socket.emits.length, 2);
    assert.equal(socket.emits[1][1].Battery.Percent, 79);

    now += 60_000;
    H.intervals[0].callback();
    await flush();
    assert.equal(socket.emits.length, 3, 'keepalive');
    H.Manager.Dispose();
  } finally {
    Date.now = realNow;
    H.restore();
  }
});

test('suspend and resume are timestamped, reported at once, and survive a reconnect', async () => {
  const H = loadMonitor();
  const realNow = Date.now;
  let now = 2_000_000;
  Date.now = () => now;
  try {
    const first = fakeSocket();
    await H.Manager.Start(first);

    now = 2_100_000;
    H.powerMonitor.emit('suspend');
    // Best effort and immediate: no sample is started for a process about to freeze.
    const collectionsBefore = H.state.collections;
    const suspendReport = first.emits[first.emits.length - 1][1];
    assert.equal(suspendReport.LastSuspendAt, 2_100_000);
    assert.equal(H.state.collections, collectionsBefore);

    // The link drops while asleep.
    H.Manager.Stop();

    now = 2_500_000;
    H.powerMonitor.emit('resume');
    await flush();

    const second = fakeSocket();
    await H.Manager.Start(second);
    const [event, snapshot] = second.emits[0];
    assert.equal(event, 'PowerStatus');
    // The server detects the sleep by diffing these, so a reconnect must not
    // reset them.
    assert.equal(snapshot.LastSuspendAt, 2_100_000);
    assert.equal(snapshot.LastResumeAt, 2_500_000);
    H.Manager.Dispose();
  } finally {
    Date.now = realNow;
    H.restore();
  }
});

test('mains/battery switches resample immediately', async () => {
  const H = loadMonitor();
  try {
    const socket = fakeSocket();
    await H.Manager.Start(socket);
    H.powerMonitor.onBattery = true;
    H.powerMonitor.emit('on-battery');
    await flush();
    assert.equal(socket.emits.length, 2);
    assert.equal(socket.emits[1][1].OnBattery, true);
    H.Manager.Dispose();
  } finally {
    H.restore();
  }
});

test('listeners are attached once across reconnects and removed on teardown', async () => {
  const H = loadMonitor();
  try {
    await H.Manager.Start(fakeSocket());
    H.Manager.Stop();
    await H.Manager.Start(fakeSocket());
    H.Manager.Stop();
    await H.Manager.Start(fakeSocket());
    for (const event of ['suspend', 'resume', 'on-ac', 'on-battery']) {
      assert.equal(H.powerMonitor.listenerCount(event), 1, event);
    }
    assert.equal(H.intervals.length, 1, 'one poll timer, never stacked');

    H.Manager.Dispose();
    for (const event of ['suspend', 'resume', 'on-ac', 'on-battery']) {
      assert.equal(H.powerMonitor.listenerCount(event), 0, event);
    }
    assert.equal(H.intervals.length, 0);
    assert.ok(H.state.disposals >= 1, 'the PowerShell host is released');
  } finally {
    H.restore();
  }
});

test('a disconnected socket gets nothing; a suspend while disconnected is still recorded', async () => {
  const H = loadMonitor();
  try {
    const socket = fakeSocket();
    await H.Manager.Start(socket);
    H.Manager.Stop();
    const emitted = socket.emits.length;
    H.powerMonitor.emit('suspend');
    H.powerMonitor.emit('on-ac');
    await flush();
    assert.equal(socket.emits.length, emitted);
    const next = fakeSocket();
    await H.Manager.Start(next);
    assert.notEqual(next.emits[0][1].LastSuspendAt, null);
    H.Manager.Dispose();
  } finally {
    H.restore();
  }
});
