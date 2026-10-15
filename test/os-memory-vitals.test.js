// Memory and uptime vitals.
//
// macOS's `os.freemem()` excludes reclaimable file cache, so `total - free` read
// close to 100% on any Mac that had been up a while. The client now reports what
// Activity Monitor calls "Memory Used", parsed from vm_stat by a slow background
// sampler (GetVitals runs every second and must not spawn).
//
// The OS module starts its samplers at import time, so `global.setInterval` is
// stubbed while loading it and child_process is mocked, as in
// os-uptime-format.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'OS', 'index.js');

function loadOS({ uptime = 0, execFile } = {}) {
  const originalSetInterval = global.setInterval;
  global.setInterval = () => ({ id: 'sampler' });
  try {
    return loadWithMocks(MODULE_PATH, {
      os: {
        hostname: () => 'unit-host',
        totalmem: () => 100,
        freemem: () => 30,
        uptime: () => uptime,
        cpus: () => [{ times: { user: 1, nice: 1, sys: 1, idle: 7, irq: 0 } }],
        networkInterfaces: () => ({}),
      },
      // Never answers unless a test says otherwise: the "no sample yet" state.
      child_process: { execFile: execFile || (() => {}) },
    });
  } finally {
    global.setInterval = originalSetInterval;
  }
}

// Captured from an Apple silicon Mac (16K pages).
const VM_STAT_ARM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                  2363551.
Pages active:                                2787657.
Pages inactive:                              2300590.
Pages speculative:                            490746.
Pages throttled:                                   0.
Pages wired down:                             319713.
Pages purgeable:                              334527.
"Translation faults":                    10246661689.
Pages copy-on-write:                       666061521.
Pages zero filled:                        7920357570.
Pages reactivated:                           3172888.
Pages purged:                               20265642.
File-backed pages:                           1937336.
Anonymous pages:                             3641657.
Pages stored in compressor:                   268908.
Pages occupied by compressor:                  67265.
Decompressions:                               738967.
Compressions:                                1624547.
Pageins:                                    65957751.
Pageouts:                                        272.
Swapins:                                      559287.
Swapouts:                                     668429.
`;

// The shape an Intel Mac prints (4K pages).
const VM_STAT_INTEL = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                               12345.
Pages active:                            800000.
Pages inactive:                          700000.
Pages speculative:                        20000.
Pages throttled:                              0.
Pages wired down:                        400000.
Pages purgeable:                          50000.
"Translation faults":                 123456789.
Pages copy-on-write:                    1234567.
Pages zero filled:                     98765432.
Pages reactivated:                        12345.
Pages purged:                             54321.
File-backed pages:                       600000.
Anonymous pages:                         900000.
Pages stored in compressor:              300000.
Pages occupied by compressor:            100000.
`;

test('ParseVmStat computes app + wired + compressed, as Activity Monitor does', () => {
  const { ParseVmStat } = loadOS();
  // (anonymous - purgeable + wired + compressor) * page size
  assert.equal(ParseVmStat(VM_STAT_ARM), (3641657 - 334527 + 319713 + 67265) * 16384);
  assert.equal(ParseVmStat(VM_STAT_INTEL), (900000 - 50000 + 400000 + 100000) * 4096);
});

test('ParseVmStat takes the page size from the header rather than assuming one', () => {
  const { ParseVmStat } = loadOS();
  const Arm = ParseVmStat(VM_STAT_ARM);
  const Relabelled = ParseVmStat(VM_STAT_ARM.replace('16384', '4096'));
  assert.equal(Arm, Relabelled * 4);
});

test('ParseVmStat rejects anything that is not vm_stat output', () => {
  const { ParseVmStat } = loadOS();
  assert.equal(ParseVmStat(''), null);
  assert.equal(ParseVmStat('vm_stat: command not found'), null);
  // No header: the page size is unknown, so no figure at all.
  assert.equal(ParseVmStat(VM_STAT_ARM.split('\n').slice(1).join('\n')), null);
  // A required counter missing.
  assert.equal(ParseVmStat(VM_STAT_ARM.replace(/^Anonymous pages:.*$/m, '')), null);
});

test('ComputeUsedMemory uses the vm_stat figure on macOS only, clamped to the total', () => {
  const { ComputeUsedMemory } = loadOS();
  assert.equal(ComputeUsedMemory(100, 30, 40, 'darwin'), 40);
  // Before the first sample, or after a failure: total - free, as before.
  assert.equal(ComputeUsedMemory(100, 30, null, 'darwin'), 70);
  // Other platforms never use it.
  assert.equal(ComputeUsedMemory(100, 30, 40, 'win32'), 70);
  assert.equal(ComputeUsedMemory(100, 30, 40, 'linux'), 70);
  assert.equal(ComputeUsedMemory(100, 30, 500, 'darwin'), 100);
  assert.equal(ComputeUsedMemory(100, 130, null, 'linux'), 0);
});

test('GetVitals reports uptime in whole seconds alongside the formatted string', async () => {
  const { Manager } = loadOS({ uptime: 90061.75 });
  const Vitals = await Manager.GetVitals();
  assert.equal(Vitals.Uptime.Seconds, 90061);
  assert.equal(Vitals.Uptime.Formatted, '25:01:01');
});

test('GetVitals falls back to total - free until a memory sample exists', async () => {
  const { Manager } = loadOS();
  const Vitals = await Manager.GetVitals();
  assert.equal(Vitals.Ram.Total, 100);
  assert.equal(Vitals.Ram.Used, 70);
  assert.equal(Vitals.Ram.UsagePercentage, '70.00', 'still a two-decimal string on the wire');
});

test('on macOS, GetVitals reads the cached vm_stat figure without spawning per call', async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('the sampler only runs on macOS');
    return;
  }
  const calls = [];
  const { Manager } = loadOS({
    execFile: (command, args, options, callback) => {
      calls.push(command);
      // 100 bytes total in this fixture, so a tiny page size keeps it in range.
      callback(
        null,
        'Mach Virtual Memory Statistics: (page size of 1 bytes)\n' +
          'Pages wired down: 10.\nPages purgeable: 5.\nAnonymous pages: 30.\n' +
          'Pages occupied by compressor: 5.\n'
      );
    },
  });
  const First = await Manager.GetVitals();
  const Second = await Manager.GetVitals();
  assert.equal(First.Ram.Used, 40);
  assert.equal(First.Ram.UsagePercentage, '40.00');
  assert.equal(Second.Ram.Used, 40);
  assert.deepEqual(calls, ['vm_stat'], 'one sample at start, none per GetVitals');
});
