// Uptime formatting.
//
// The old implementation formatted a DURATION with a TIME-OF-DAY formatter
// (`new Date(s * 1000).toISOString().substr(11, 8)`), so it wrapped at 24h: a
// machine up 25h reported "01:00:00". The >24h cases below are the whole point
// of this suite — everything under a day passed before the fix too.
//
// The OS module starts a 1s CPU sampler at import time, so `global.setInterval`
// is stubbed before loading it (the same approach module-networking.test.js
// uses); without that the test process never exits.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'OS', 'index.js');

const HOUR = 3600;
const DAY = 24 * HOUR;

function loadOS({ uptime = 0 } = {}) {
  const originalSetInterval = global.setInterval;
  global.setInterval = () => ({ id: 'cpu-sampler' });
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
      macaddress: { all: () => Promise.resolve({}) },
    });
  } finally {
    global.setInterval = originalSetInterval;
  }
}

test('FormatUptime renders sub-day durations as HH:mm:ss', () => {
  const { FormatUptime } = loadOS();
  assert.equal(FormatUptime(0), '00:00:00');
  assert.equal(FormatUptime(1), '00:00:01');
  assert.equal(FormatUptime(59), '00:00:59');
  assert.equal(FormatUptime(60), '00:01:00');
  assert.equal(FormatUptime(3599), '00:59:59');
  assert.equal(FormatUptime(HOUR), '01:00:00');
  assert.equal(FormatUptime(3661), '01:01:01');
  assert.equal(FormatUptime(23 * HOUR + 59 * 60 + 59), '23:59:59');
});

test('FormatUptime does not wrap at 24 hours', () => {
  const { FormatUptime } = loadOS();
  // The regression the old formatter had: each of these previously came back
  // mod-24h, e.g. 25h01m30s -> "01:01:30".
  assert.equal(FormatUptime(DAY), '24:00:00');
  assert.equal(FormatUptime(DAY + 1), '24:00:01');
  assert.equal(FormatUptime(25 * HOUR + 60 + 30), '25:01:30');
  assert.equal(FormatUptime(7 * DAY), '168:00:00');
  assert.equal(FormatUptime(100 * DAY + 3 * HOUR + 4 * 60 + 5), '2403:04:05');
});

test('FormatUptime stays inside the 32-character wire limit', () => {
  // The server stores Vitals.Uptime.Formatted as an opaque string capped at 32
  // characters, so an unbounded hours field has to be checked against it.
  const { FormatUptime } = loadOS();
  const formatted = FormatUptime(10 * 365 * DAY);
  assert.equal(formatted, '87600:00:00');
  assert.ok(formatted.length <= 32);
});

test('FormatUptime degrades to zero for unusable input', () => {
  const { FormatUptime } = loadOS();
  // os.uptime() should never hand us these, but a monitoring agent must not
  // emit "NaN:NaN:NaN" if it ever does.
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, -1, 'abc', {}, []]) {
    assert.equal(FormatUptime(bad), '00:00:00', `expected 00:00:00 for ${JSON.stringify(bad)}`);
  }
});

test('FormatUptime truncates fractional seconds rather than rounding up', () => {
  const { FormatUptime } = loadOS();
  assert.equal(FormatUptime(59.9), '00:00:59');
  assert.equal(FormatUptime(HOUR - 0.1), '00:59:59');
});

test('GetVitals reports a multi-day uptime without wrapping', async () => {
  const { Manager } = loadOS({ uptime: 25 * HOUR + 60 + 30 });
  const vitals = await Manager.GetVitals();
  assert.equal(vitals.Uptime.Formatted, '25:01:30');
});
