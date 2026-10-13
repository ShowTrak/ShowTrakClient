const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// AudioMonitor: the poller that turns platform samples into `AudioDevices`
// reports, and the handler behind the server's `SetAudioLevel` requests.
//
// The samplers are replaced by a scripted fake, so every test here is about the
// reporting contract — when a snapshot goes out, which requests are refused and
// why — rather than about any one operating system.

const DIST = path.join(__dirname, '..', 'dist', 'Modules', 'AudioMonitor');

const realShared = () => loadWithMocks(path.join(DIST, 'shared.js'), {});

function endpoint(overrides = {}) {
  return {
    EndpointID: 'out-1',
    Direction: 'output',
    Name: 'Speakers',
    Manufacturer: null,
    Transport: 'builtin',
    Channels: 2,
    SampleRate: 48000,
    IsDefault: true,
    Volume: 50,
    Muted: false,
    ...overrides,
  };
}

function okCollection(endpoints, capabilities, extra = {}) {
  return {
    Ok: true,
    Sample: {
      Backend: 'coreaudio',
      Endpoints: endpoints,
      Capabilities: capabilities || realShared().COREAUDIO_CAPABILITIES,
      ...extra,
    },
  };
}

function loadMonitor({ collect, set } = {}) {
  const state = {
    collections: 0,
    disposals: 0,
    setCalls: [],
    next: okCollection([endpoint()]),
    collect: collect || null,
  };
  const {
    Manager,
    BuildSnapshot,
    SnapshotSignature,
    ParseLevelRequest,
    PlatformLabel,
    _constants,
  } = loadWithMocks(path.join(DIST, 'index.js'), {
    './samplers': {
      CollectAudio: async () => {
        state.collections += 1;
        if (state.collect) return state.collect();
        return state.next;
      },
      SetAudioLevel: async (Endpoint, Change) => {
        state.setCalls.push({ Endpoint, Change });
        return set ? set(Endpoint, Change) : [null, true];
      },
      DisposeAudioSamplers: () => {
        state.disposals += 1;
      },
    },
    '../Logger': { CreateLogger: () => createSilentLogger() },
  });
  return {
    Manager,
    BuildSnapshot,
    SnapshotSignature,
    ParseLevelRequest,
    PlatformLabel,
    _constants,
    state,
  };
}

function fakeSocket() {
  const emits = [];
  return {
    connected: true,
    emits,
    emit: (event, payload) => emits.push([event, payload]),
  };
}

// Let every queued promise continuation run. A few macrotask turns covers the
// sample -> report chain without depending on how many awaits it contains.
async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('PlatformLabel names the three supported platforms for operators', () => {
  const { PlatformLabel } = loadMonitor();
  assert.equal(PlatformLabel('darwin'), 'macOS');
  assert.equal(PlatformLabel('win32'), 'Windows');
  assert.equal(PlatformLabel('linux'), 'Linux');
  assert.equal(PlatformLabel('freebsd'), 'freebsd');
});

test('BuildSnapshot reports a good sample as ok, carrying any backend note as the message', () => {
  const { BuildSnapshot } = loadMonitor();
  const snapshot = BuildSnapshot(
    okCollection([endpoint()], undefined, { Note: 'ALSA only' }),
    'linux',
    42
  );
  assert.equal(snapshot.SampledAt, 42);
  assert.deepEqual(snapshot.Status, {
    State: 'ok',
    Message: 'ALSA only',
    Platform: 'linux',
    Backend: 'coreaudio',
  });
  assert.equal(snapshot.Endpoints.length, 1);
  assert.equal(BuildSnapshot(okCollection([]), 'darwin').Status.Message, null);
});

test('BuildSnapshot separates "cannot work here" from "failed this time"', () => {
  const { BuildSnapshot } = loadMonitor();
  const unsupported = BuildSnapshot(
    { Ok: false, Unsupported: true, Error: new Error('no audio stack') },
    'linux'
  );
  assert.equal(unsupported.Status.State, 'unsupported');
  assert.equal(unsupported.Status.Message, 'no audio stack');
  assert.equal(unsupported.Status.Backend, null);
  assert.deepEqual(unsupported.Endpoints, []);
  assert.equal(unsupported.Capabilities.OutputVolume, 'none');

  const failed = BuildSnapshot({ Ok: false, Unsupported: false, Error: null }, 'win32');
  assert.equal(failed.Status.State, 'error');
  assert.equal(failed.Status.Message, 'Audio devices could not be read');
});

test('SnapshotSignature ignores the sample time but sees a level change', () => {
  const { BuildSnapshot, SnapshotSignature } = loadMonitor();
  const a = BuildSnapshot(okCollection([endpoint()]), 'darwin', 1);
  const b = BuildSnapshot(okCollection([endpoint()]), 'darwin', 2);
  const c = BuildSnapshot(okCollection([endpoint({ Volume: 51 })]), 'darwin', 3);
  assert.equal(SnapshotSignature(a), SnapshotSignature(b));
  assert.notEqual(SnapshotSignature(a), SnapshotSignature(c));
});

test('ParseLevelRequest validates every field of an untrusted request', () => {
  const { ParseLevelRequest } = loadMonitor();
  assert.deepEqual(ParseLevelRequest({ EndpointID: ' out-1 ', Volume: 49.5 }), {
    EndpointID: 'out-1',
    Change: { Volume: 50 },
  });
  assert.deepEqual(ParseLevelRequest({ EndpointID: 'x', Muted: true, Volume: null }), {
    EndpointID: 'x',
    Change: { Muted: true },
  });
  const errors = [
    [null, /Invalid/],
    ['string', /Invalid/],
    [{}, /device is required/],
    [{ EndpointID: 'x'.repeat(513), Volume: 1 }, /device is required/],
    [{ EndpointID: 'x', Volume: '50' }, /must be a number/],
    [{ EndpointID: 'x', Volume: NaN }, /must be a number/],
    [{ EndpointID: 'x', Volume: 101 }, /between 0 and 100/],
    [{ EndpointID: 'x', Volume: -1 }, /between 0 and 100/],
    [{ EndpointID: 'x', Muted: 'yes' }, /true or false/],
    [{ EndpointID: 'x' }, /Nothing to change/],
  ];
  for (const [request, pattern] of errors) {
    const result = ParseLevelRequest(request);
    assert.match(result.Error, pattern, JSON.stringify(request));
  }
});

test('Start reports immediately even when nothing has changed since a previous session', async () => {
  const { Manager, state } = loadMonitor();
  const first = fakeSocket();
  await Manager.Start(first);
  assert.equal(first.emits.length, 1);
  assert.equal(first.emits[0][0], 'AudioDevices');
  assert.equal(first.emits[0][1].Status.State, 'ok');

  const second = fakeSocket();
  await Manager.Start(second);
  assert.equal(second.emits.length, 1, 'a new connection gets the full picture again');
  assert.equal(state.collections, 2);
  Manager.Stop();
});

test('Start against a socket that is not connected samples but does not emit', async () => {
  const { Manager } = loadMonitor();
  const socket = fakeSocket();
  socket.connected = false;
  await Manager.Start(socket);
  assert.equal(socket.emits.length, 0);
  assert.ok(Manager.GetLastSnapshot());
  Manager.Stop();
  await Manager.Start(null);
  assert.ok(Manager.GetLastSnapshot());
  Manager.Stop();
});

test('the poll reports a change at once, stays quiet otherwise, and keeps alive every 20s', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  const { Manager, state, _constants } = loadMonitor();
  const socket = fakeSocket();
  await Manager.Start(socket);
  assert.equal(socket.emits.length, 1);

  t.mock.timers.tick(_constants.POLL_INTERVAL_MS);
  await flush();
  assert.equal(state.collections, 2);
  assert.equal(socket.emits.length, 1, 'unchanged: no report');

  state.next = okCollection([endpoint({ Muted: true })]);
  t.mock.timers.tick(_constants.POLL_INTERVAL_MS);
  await flush();
  assert.equal(socket.emits.length, 2, 'a mute is reported on the next poll');
  assert.equal(socket.emits[1][1].Endpoints[0].Muted, true);

  // Unchanged for a full keepalive interval: re-sent so history stays dense.
  for (
    let elapsed = 0;
    elapsed < _constants.KEEPALIVE_INTERVAL_MS;
    elapsed += _constants.POLL_INTERVAL_MS
  ) {
    t.mock.timers.tick(_constants.POLL_INTERVAL_MS);
    await flush();
  }
  assert.equal(socket.emits.length, 3);
  Manager.Stop();
});

test('a periodic poll shares a sample already in flight instead of stacking another', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let release;
  const { Manager, state, _constants } = loadMonitor();
  const socket = fakeSocket();
  await Manager.Start(socket);
  state.collect = () =>
    new Promise((resolve) => {
      release = () => resolve(okCollection([endpoint()]));
    });
  t.mock.timers.tick(_constants.POLL_INTERVAL_MS);
  await flush();
  t.mock.timers.tick(_constants.POLL_INTERVAL_MS);
  await flush();
  assert.equal(state.collections, 2, 'the second tick found the first still running');
  release();
  await flush();
  Manager.Stop();
});

test('a sample that finishes after Stop never reports to the old socket', async () => {
  let release;
  const { Manager, state } = loadMonitor();
  state.collect = () =>
    new Promise((resolve) => {
      release = () => resolve(okCollection([endpoint()]));
    });
  const socket = fakeSocket();
  const started = Manager.Start(socket);
  await flush();
  Manager.Stop();
  release();
  await started;
  assert.equal(socket.emits.length, 0);
  assert.equal(Manager.GetLastSnapshot(), null);
  assert.equal(state.disposals, 1, 'Stop releases the samplers (the Windows host)');
});

test('a sample that throws is logged and the monitor keeps going', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { Manager, state, _constants } = loadMonitor();
  const socket = fakeSocket();
  state.collect = () => Promise.reject(new Error('boom'));
  await Manager.Start(socket);
  assert.equal(socket.emits.length, 0);
  state.collect = null;
  t.mock.timers.tick(_constants.POLL_INTERVAL_MS);
  await flush();
  assert.equal(socket.emits.length, 1);
  Manager.Stop();
});

test('a failed sample is reported as an error snapshot', async () => {
  const { Manager, state } = loadMonitor();
  state.next = { Ok: false, Unsupported: false, Error: new Error('profiler crashed') };
  const socket = fakeSocket();
  await Manager.Start(socket);
  assert.equal(socket.emits[0][1].Status.State, 'error');
  assert.equal(socket.emits[0][1].Status.Message, 'profiler crashed');
  Manager.Stop();
});

test('RequestSample coalesces a burst of hotplugs into one sample after the settle delay', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const { Manager, state, _constants } = loadMonitor();
  Manager.RequestSample(); // not started: ignored
  t.mock.timers.tick(_constants.HOTPLUG_SETTLE_MS);
  await flush();
  assert.equal(state.collections, 0);

  const socket = fakeSocket();
  await Manager.Start(socket);
  state.next = okCollection([endpoint(), endpoint({ EndpointID: 'usb-in', Direction: 'input' })]);
  Manager.RequestSample();
  t.mock.timers.tick(_constants.HOTPLUG_SETTLE_MS - 1);
  Manager.RequestSample();
  t.mock.timers.tick(_constants.HOTPLUG_SETTLE_MS - 1);
  await flush();
  assert.equal(state.collections, 1, 'still settling');
  t.mock.timers.tick(1);
  await flush();
  assert.equal(state.collections, 2);
  assert.equal(socket.emits.length, 2);
  assert.equal(socket.emits[1][1].Endpoints.length, 2);
  Manager.Stop();
});

test('SetLevel refuses a malformed request without touching the audio stack', async () => {
  const { Manager, state } = loadMonitor();
  const result = await Manager.SetLevel({ EndpointID: 'out-1' });
  assert.deepEqual(result, { Success: false, Error: 'Nothing to change' });
  assert.equal(state.collections, 0);
  assert.equal(state.setCalls.length, 0);
});

test('SetLevel samples first when it has never seen the devices', async () => {
  const { Manager, state } = loadMonitor();
  const result = await Manager.SetLevel({ EndpointID: 'out-1', Volume: 20 });
  assert.deepEqual(result, { Success: true, Error: null });
  assert.equal(state.setCalls.length, 1);
  assert.equal(state.setCalls[0].Endpoint.Name, 'Speakers');
  assert.deepEqual(state.setCalls[0].Change, { Volume: 20 });
});

test('SetLevel applies the change, then reports before acknowledging', async () => {
  const { Manager, state } = loadMonitor();
  const socket = fakeSocket();
  await Manager.Start(socket);
  state.next = okCollection([endpoint({ Volume: 20 })]);
  const result = await Manager.SetLevel({ EndpointID: 'out-1', Volume: 20 });
  assert.deepEqual(result, { Success: true, Error: null });
  assert.equal(socket.emits.length, 2);
  assert.equal(socket.emits[1][1].Endpoints[0].Volume, 20);
  Manager.Stop();
});

test('SetLevel only acts on endpoints the client itself reported', async () => {
  const { Manager, state } = loadMonitor();
  await Manager.Start(fakeSocket());
  const result = await Manager.SetLevel({ EndpointID: 'pulse:output:not-here', Volume: 20 });
  assert.equal(result.Success, false);
  assert.match(result.Error, /no longer present/);
  assert.equal(state.setCalls.length, 0);
  Manager.Stop();
});

test('SetLevel explains a scope the platform does not reach', async () => {
  const { COREAUDIO_CAPABILITIES, ALSA_CAPABILITIES } = realShared();
  const { Manager, state } = loadMonitor();
  state.next = okCollection(
    [endpoint({ EndpointID: 'mic', Direction: 'input', IsDefault: false })],
    COREAUDIO_CAPABILITIES
  );
  await Manager.Start(fakeSocket());
  const level = await Manager.SetLevel({ EndpointID: 'mic', Volume: 10 });
  assert.match(level.Error, /can only change the level of the default input/);
  const mute = await Manager.SetLevel({ EndpointID: 'mic', Muted: true });
  assert.match(mute.Error, /Changing the mute of this device is not available on/);

  state.next = okCollection([endpoint()], ALSA_CAPABILITIES);
  await Manager.Start(fakeSocket());
  const alsa = await Manager.SetLevel({ EndpointID: 'out-1', Volume: 10 });
  assert.match(alsa.Error, /Changing the level of this device is not available on/);
  assert.equal(state.setCalls.length, 0);
  Manager.Stop();
});

test('SetLevel passes on the backend failure and the monitor state', async () => {
  const failing = loadMonitor({ set: () => [new Error('Access is denied'), null] });
  await failing.Manager.Start(fakeSocket());
  assert.deepEqual(await failing.Manager.SetLevel({ EndpointID: 'out-1', Muted: true }), {
    Success: false,
    Error: 'Access is denied',
  });
  failing.Manager.Stop();

  const broken = loadMonitor();
  broken.state.next = { Ok: false, Unsupported: true, Error: new Error('No audio stack') };
  await broken.Manager.Start(fakeSocket());
  assert.deepEqual(await broken.Manager.SetLevel({ EndpointID: 'out-1', Muted: true }), {
    Success: false,
    Error: 'No audio stack',
  });
  broken.Manager.Stop();
});

test('SetLevel waits for an in-flight sample, then samples again after the change', async () => {
  let release;
  const { Manager, state } = loadMonitor();
  const socket = fakeSocket();
  await Manager.Start(socket);
  state.collect = () =>
    new Promise((resolve) => {
      release = () => resolve(okCollection([endpoint({ Volume: 5 })]));
    });
  const pending = Manager.SetLevel({ EndpointID: 'out-1', Volume: 5 });
  await flush();
  assert.equal(state.collections, 2, 'the post-change sample is running');
  release();
  const result = await pending;
  assert.equal(result.Success, true);
  assert.equal(socket.emits[socket.emits.length - 1][1].Endpoints[0].Volume, 5);
  Manager.Stop();
});

// ---------------------------------------------------------------------------
// samplers.ts — the per-platform dispatch
// ---------------------------------------------------------------------------

function loadSamplers(outcomes = {}) {
  const calls = [];
  const backend =
    (name) =>
    async (...args) => {
      calls.push([name, ...args]);
      return outcomes[name] || [null, { Backend: name, Endpoints: [], Capabilities: {} }];
    };
  class NoLinuxAudioStackError extends Error {}
  const mod = loadWithMocks(path.join(DIST, 'samplers.js'), {
    './macos': { CollectMacAudio: backend('mac'), SetMacAudioLevel: backend('setMac') },
    './windows': {
      CollectWindowsAudio: backend('win'),
      SetWindowsAudioLevel: backend('setWin'),
      DisposeWindowsAudio: () => calls.push(['disposeWin']),
    },
    './linux': {
      CollectLinuxAudio: backend('linux'),
      SetLinuxAudioLevel: backend('setLinux'),
      NoLinuxAudioStackError,
    },
  });
  return { mod, calls, NoLinuxAudioStackError };
}

test('CollectAudio routes each platform to its backend', async () => {
  const { mod, calls } = loadSamplers();
  for (const [platform, name] of [
    ['darwin', 'mac'],
    ['win32', 'win'],
    ['linux', 'linux'],
  ]) {
    const result = await mod.CollectAudio(platform);
    assert.equal(result.Ok, true);
    assert.equal(result.Sample.Backend, name);
  }
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['mac', 'win', 'linux']
  );
});

test('CollectAudio marks an unknown platform as unsupported', async () => {
  const { mod } = loadSamplers();
  const other = await mod.CollectAudio('aix');
  assert.equal(other.Ok, false);
  assert.equal(other.Unsupported, true);
  assert.match(other.Error.message, /not available on aix/);
});

test('CollectAudio treats any other backend failure as an error, not unsupported', async () => {
  const { mod } = loadSamplers({ linux: [new Error('pactl crashed'), null] });
  const result = await mod.CollectAudio('linux');
  assert.equal(result.Ok, false);
  assert.equal(result.Unsupported, false);
  assert.equal(result.Error.message, 'pactl crashed');
});

test("CollectAudio reports Unsupported for the backend's own NoLinuxAudioStackError", async () => {
  class NoLinuxAudioStackError extends Error {}
  const mod = loadWithMocks(path.join(DIST, 'samplers.js'), {
    './macos': {},
    './windows': { DisposeWindowsAudio: () => {} },
    './linux': {
      NoLinuxAudioStackError,
      CollectLinuxAudio: async () => [new NoLinuxAudioStackError('no stack'), null],
    },
  });
  const result = await mod.CollectAudio('linux');
  assert.equal(result.Ok, false);
  assert.equal(result.Unsupported, true);
  assert.equal(result.Error.message, 'no stack');
});

test('CollectAudio substitutes an error when a backend returns neither value nor error', async () => {
  const { mod } = loadSamplers({ mac: [null, null] });
  const result = await mod.CollectAudio('darwin');
  assert.equal(result.Ok, false);
  assert.equal(result.Unsupported, false);
  assert.match(result.Error.message, /Audio sample failed/);
});

test('SetAudioLevel routes by platform and refuses elsewhere; Dispose releases Windows', async () => {
  const { mod, calls } = loadSamplers();
  const ep = endpoint();
  await mod.SetAudioLevel(ep, { Volume: 1 }, 'darwin');
  await mod.SetAudioLevel(ep, { Volume: 2 }, 'win32');
  await mod.SetAudioLevel(ep, { Volume: 3 }, 'linux');
  const [error] = await mod.SetAudioLevel(ep, { Volume: 4 }, 'aix');
  assert.match(error.message, /not available on aix/);
  mod.DisposeAudioSamplers();
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['setMac', 'setWin', 'setLinux', 'disposeWin']
  );
  assert.deepEqual(calls[1][2], { Volume: 2 });
});

test('a level change made while a poll is sampling queues a fresh sample behind it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  let release;
  const { Manager, state, _constants } = loadMonitor();
  const socket = fakeSocket();
  await Manager.Start(socket);
  // The next sample (the periodic poll) hangs until released; later ones answer
  // at once with the post-change level.
  let blocked = true;
  state.collect = () => {
    if (!blocked) return Promise.resolve(okCollection([endpoint({ Volume: 7 })]));
    blocked = false;
    return new Promise((resolve) => {
      release = () => resolve(okCollection([endpoint()]));
    });
  };
  t.mock.timers.tick(_constants.POLL_INTERVAL_MS);
  await flush();
  assert.equal(state.collections, 2, 'the poll is in flight');

  const pending = Manager.SetLevel({ EndpointID: 'out-1', Volume: 7 });
  await flush();
  assert.equal(state.collections, 2, 'the post-change sample waits for the poll');
  release();
  assert.deepEqual(await pending, { Success: true, Error: null });
  assert.equal(state.collections, 3, 'and then runs fresh rather than sharing the stale one');
  assert.equal(socket.emits[socket.emits.length - 1][1].Endpoints[0].Volume, 7);
  Manager.Stop();
});
