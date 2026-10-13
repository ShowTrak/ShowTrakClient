const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// The macOS audio backend and the helpers every backend shares.
//
// child_process is mocked throughout, so these assert the same behaviour on the
// Linux and Windows CI runners as on a Mac. The profiler fixture mirrors the shape
// `system_profiler SPAudioDataType -json` produced on macOS 15 (captured on a
// MacBook Pro with an NDI virtual device installed), trimmed to what is parsed.

const DIST = path.join(__dirname, '..', 'dist', 'Modules', 'AudioMonitor');
const loggerStub = { CreateLogger: () => createSilentLogger() };

const PROFILER_FIXTURE = JSON.stringify({
  SPAudioDataType: [
    {
      _name: 'coreaudio_device',
      _items: [
        {
          _name: 'MacBook Pro Microphone',
          coreaudio_default_audio_input_device: 'spaudio_yes',
          coreaudio_device_input: 1,
          coreaudio_device_manufacturer: 'Apple Inc.',
          coreaudio_device_srate: 48000,
          coreaudio_device_transport: 'coreaudio_device_type_builtin',
        },
        {
          _name: 'MacBook Pro Speakers',
          coreaudio_default_audio_output_device: 'spaudio_yes',
          coreaudio_default_audio_system_device: 'spaudio_yes',
          coreaudio_device_manufacturer: 'Apple Inc.',
          coreaudio_device_output: 2,
          coreaudio_device_srate: 48000,
          coreaudio_device_transport: 'coreaudio_device_type_builtin',
        },
        {
          _name: 'Scarlett 18i20',
          coreaudio_device_input: 18,
          coreaudio_device_output: 20,
          coreaudio_device_manufacturer: 'Focusrite',
          coreaudio_device_srate: 96000,
          coreaudio_device_transport: 'coreaudio_device_type_usb',
        },
      ],
    },
  ],
});

function loadShared() {
  return loadWithMocks(path.join(DIST, 'shared.js'), {});
}

function loadMac({ execFile } = {}) {
  const calls = [];
  const mod = loadWithMocks(path.join(DIST, 'macos.js'), {
    child_process: {
      execFile: (command, args, options, callback) => {
        calls.push({ command, args, options });
        const [error, stdout] = execFile ? execFile(command, args) : [null, ''];
        callback(error, stdout);
      },
    },
    '../Logger': loggerStub,
  });
  return { mod, calls };
}

// ---------------------------------------------------------------------------
// shared.ts
// ---------------------------------------------------------------------------

test('NormalizeVolume keeps whole non-negative levels and rejects junk', () => {
  const { NormalizeVolume } = loadShared();
  assert.equal(NormalizeVolume(44), 44);
  assert.equal(NormalizeVolume('71'), 71);
  assert.equal(NormalizeVolume(49.6), 50);
  // PulseAudio boost is reported as-is, not clamped to 100.
  assert.equal(NormalizeVolume(150), 150);
  assert.equal(NormalizeVolume(-3), 0);
  for (const value of [null, undefined, '', 'missing value', NaN, Infinity]) {
    assert.equal(NormalizeVolume(value), null, String(value));
  }
});

test('PositiveInteger accepts counts and rates, and rejects zero, negatives and junk', () => {
  const { PositiveInteger } = loadShared();
  assert.equal(PositiveInteger(2), 2);
  assert.equal(PositiveInteger('48000'), 48000);
  assert.equal(PositiveInteger(44100.4), 44100);
  for (const value of [0, -2, null, undefined, '', 'x', NaN]) {
    assert.equal(PositiveInteger(value), null, String(value));
  }
});

test('Slugify reduces names to lower-case dash-separated tokens', () => {
  const { Slugify } = loadShared();
  assert.equal(Slugify('Apple Inc.'), 'apple-inc');
  assert.equal(Slugify('  Scarlett 18i20 (USB)  '), 'scarlett-18i20-usb');
  assert.equal(Slugify(null), '');
  assert.equal(Slugify('---'), '');
});

test('DisambiguateEndpointIDs suffixes repeats in enumeration order and leaves uniques alone', () => {
  const { DisambiguateEndpointIDs } = loadShared();
  const out = DisambiguateEndpointIDs([
    { EndpointID: 'a' },
    { EndpointID: 'b' },
    { EndpointID: 'a' },
    { EndpointID: 'a' },
  ]);
  assert.deepEqual(
    out.map((e) => e.EndpointID),
    ['a', 'b', 'a#2', 'a#3']
  );
});

test('NormalizeTransport maps unknown values to unknown', () => {
  const { NormalizeTransport } = loadShared();
  assert.equal(NormalizeTransport('USB'), 'usb');
  assert.equal(NormalizeTransport('  hdmi '), 'hdmi');
  assert.equal(NormalizeTransport('carrier-pigeon'), 'unknown');
  assert.equal(NormalizeTransport(null), 'unknown');
});

test('Scope helpers: a default scope reaches only the current default endpoint', () => {
  const { ScopeReaches, VolumeScope, MuteScope, COREAUDIO_CAPABILITIES, WASAPI_CAPABILITIES } =
    loadShared();
  assert.equal(ScopeReaches('device', { IsDefault: false }), true);
  assert.equal(ScopeReaches('default', { IsDefault: true }), true);
  assert.equal(ScopeReaches('default', { IsDefault: false }), false);
  assert.equal(ScopeReaches('none', { IsDefault: true }), false);
  assert.equal(VolumeScope(COREAUDIO_CAPABILITIES, 'input'), 'default');
  assert.equal(MuteScope(COREAUDIO_CAPABILITIES, 'input'), 'none');
  assert.equal(MuteScope(COREAUDIO_CAPABILITIES, 'output'), 'default');
  assert.equal(VolumeScope(WASAPI_CAPABILITIES, 'output'), 'device');
});

test('ErrorText and IsMissingCommand read thrown values defensively', () => {
  const { ErrorText, IsMissingCommand } = loadShared();
  assert.equal(ErrorText(new Error('boom'), 'fallback'), 'boom');
  assert.equal(ErrorText('  plain  ', 'fallback'), 'plain');
  assert.equal(ErrorText({ message: '' }, 'fallback'), 'fallback');
  assert.equal(ErrorText(null, 'fallback'), 'fallback');
  assert.equal(IsMissingCommand(Object.assign(new Error('x'), { code: 'ENOENT' })), true);
  assert.equal(IsMissingCommand(Object.assign(new Error('x'), { code: 'EACCES' })), false);
  assert.equal(IsMissingCommand(null), false);
});

test('RunCommand passes args as an array without a shell, and forwards env only when given', async () => {
  const calls = [];
  const { RunCommand } = loadWithMocks(path.join(DIST, 'shared.js'), {
    child_process: {
      execFile: (command, args, options, callback) => {
        calls.push({ command, args, options });
        if (command === 'fails') return callback(new Error('nope'), '');
        callback(null, 'out');
      },
    },
  });
  assert.deepEqual(await RunCommand('ok', ['a b', '$(rm -rf /)']), [null, 'out']);
  assert.deepEqual(calls[0].args, ['a b', '$(rm -rf /)']);
  assert.equal(calls[0].options.shell, undefined);
  assert.equal('env' in calls[0].options, false);
  const [error, value] = await RunCommand('fails', [], { LC_ALL: 'C' });
  assert.equal(error.message, 'nope');
  assert.equal(value, null);
  assert.equal(calls[1].options.env.LC_ALL, 'C');
});

// ---------------------------------------------------------------------------
// macos.ts
// ---------------------------------------------------------------------------

test('ParseSystemProfilerAudio splits duplex devices into one endpoint per direction', () => {
  const { mod } = loadMac();
  const endpoints = mod.ParseSystemProfilerAudio(PROFILER_FIXTURE);
  assert.deepEqual(
    endpoints.map((e) => [e.EndpointID, e.Direction, e.Channels, e.IsDefault]),
    [
      ['coreaudio:input:apple-inc:macbook-pro-microphone', 'input', 1, true],
      ['coreaudio:output:apple-inc:macbook-pro-speakers', 'output', 2, true],
      ['coreaudio:input:focusrite:scarlett-18i20', 'input', 18, false],
      ['coreaudio:output:focusrite:scarlett-18i20', 'output', 20, false],
    ]
  );
  const scarlett = endpoints[2];
  assert.equal(scarlett.Name, 'Scarlett 18i20');
  assert.equal(scarlett.Manufacturer, 'Focusrite');
  assert.equal(scarlett.Transport, 'usb');
  assert.equal(scarlett.SampleRate, 96000);
  // Levels come from `volume settings` afterwards, never from the profiler.
  assert.equal(scarlett.Volume, null);
  assert.equal(scarlett.Muted, null);
});

test('ParseSystemProfilerAudio gives identical devices distinct ids', () => {
  const { mod } = loadMac();
  const twin = {
    _name: 'USB Audio CODEC',
    coreaudio_device_output: 2,
    coreaudio_device_manufacturer: 'Burr-Brown',
  };
  const endpoints = mod.ParseSystemProfilerAudio(
    JSON.stringify({ SPAudioDataType: [{ _items: [twin, twin] }] })
  );
  assert.deepEqual(
    endpoints.map((e) => e.EndpointID),
    ['coreaudio:output:burr-brown:usb-audio-codec', 'coreaudio:output:burr-brown:usb-audio-codec#2']
  );
});

test('ParseSystemProfilerAudio tolerates missing names, string counts and other nesting', () => {
  const { mod } = loadMac();
  const endpoints = mod.ParseSystemProfilerAudio(
    JSON.stringify({
      wrapper: [{ nested: { coreaudio_device_input: '2', coreaudio_device_output: 0 } }],
    })
  );
  assert.equal(endpoints.length, 1);
  assert.equal(endpoints[0].Name, 'Audio Device');
  assert.equal(endpoints[0].Manufacturer, null);
  assert.equal(endpoints[0].EndpointID, 'coreaudio:input:unknown:audio-device');
  assert.equal(endpoints[0].Channels, 2);
  assert.equal(endpoints[0].Transport, 'unknown');
  assert.equal(endpoints[0].SampleRate, null);
  assert.deepEqual(mod.ParseSystemProfilerAudio('{"SPAudioDataType":[]}'), []);
  assert.throws(() => mod.ParseSystemProfilerAudio('not json'));
});

test('MapMacTransport maps each CoreAudio transport type', () => {
  const { mod } = loadMac();
  const cases = {
    coreaudio_device_type_builtin: 'builtin',
    coreaudio_device_type_usb: 'usb',
    coreaudio_device_type_bluetooth: 'bluetooth',
    coreaudio_device_type_bluetoothle: 'bluetooth',
    coreaudio_device_type_hdmi: 'hdmi',
    coreaudio_device_type_displayport: 'displayport',
    coreaudio_device_type_thunderbolt: 'thunderbolt',
    coreaudio_device_type_firewire: 'firewire',
    coreaudio_device_type_pci: 'pci',
    coreaudio_device_type_avb: 'network',
    coreaudio_device_type_virtual: 'virtual',
    coreaudio_device_type_aggregate: 'aggregate',
    coreaudio_device_type_autoaggregate: 'aggregate',
    coreaudio_device_type_airplay: 'airplay',
    coreaudio_device_type_unknown: 'unknown',
    '': 'unknown',
  };
  for (const [raw, expected] of Object.entries(cases)) {
    assert.equal(mod.MapMacTransport(raw), expected, raw);
  }
  assert.equal(mod.MapMacTransport(undefined), 'unknown');
});

test('ParseVolumeSettings reads both levels and the output mute', () => {
  const { mod } = loadMac();
  assert.deepEqual(
    mod.ParseVolumeSettings(
      'output volume:44, input volume:71, alert volume:100, output muted:false'
    ),
    { OutputVolume: 44, InputVolume: 71, OutputMuted: false }
  );
  assert.equal(mod.ParseVolumeSettings('output muted:true').OutputMuted, true);
});

test('ParseVolumeSettings reads "missing value" (no software volume) as unknown, not zero', () => {
  const { mod } = loadMac();
  assert.deepEqual(
    mod.ParseVolumeSettings(
      'output volume:missing value, input volume:missing value, alert volume:100, output muted:missing value'
    ),
    { OutputVolume: null, InputVolume: null, OutputMuted: null }
  );
  assert.deepEqual(mod.ParseVolumeSettings(''), {
    OutputVolume: null,
    InputVolume: null,
    OutputMuted: null,
  });
});

test('ApplyVolumeSettings attaches levels to the default endpoints only', () => {
  const { mod } = loadMac();
  const endpoints = mod.ParseSystemProfilerAudio(PROFILER_FIXTURE);
  const applied = mod.ApplyVolumeSettings(endpoints, {
    OutputVolume: 31,
    InputVolume: 71,
    OutputMuted: true,
  });
  const byId = Object.fromEntries(applied.map((e) => [e.EndpointID, e]));
  assert.equal(byId['coreaudio:output:apple-inc:macbook-pro-speakers'].Volume, 31);
  assert.equal(byId['coreaudio:output:apple-inc:macbook-pro-speakers'].Muted, true);
  assert.equal(byId['coreaudio:input:apple-inc:macbook-pro-microphone'].Volume, 71);
  // macOS has no input mute to read.
  assert.equal(byId['coreaudio:input:apple-inc:macbook-pro-microphone'].Muted, null);
  assert.equal(byId['coreaudio:output:focusrite:scarlett-18i20'].Volume, null);
});

test('CollectMacAudio reads the profiler then the volume settings', async () => {
  const { mod, calls } = loadMac({
    execFile: (command) =>
      command === 'system_profiler'
        ? [null, PROFILER_FIXTURE]
        : [null, 'output volume:31, input volume:71, alert volume:100, output muted:false'],
  });
  const [error, sample] = await mod.CollectMacAudio();
  assert.equal(error, null);
  assert.equal(sample.Backend, 'coreaudio');
  assert.equal(sample.Capabilities.InputVolume, 'default');
  assert.equal(sample.Endpoints.find((e) => e.Direction === 'output' && e.IsDefault).Volume, 31);
  assert.deepEqual(calls[0].args, ['SPAudioDataType', '-json']);
  assert.deepEqual(calls[1].args, ['-e', 'get volume settings']);
});

test('CollectMacAudio keeps the device list when only the level read fails', async () => {
  const { mod } = loadMac({
    execFile: (command) =>
      command === 'system_profiler' ? [null, PROFILER_FIXTURE] : [new Error('osascript died'), ''],
  });
  const [error, sample] = await mod.CollectMacAudio();
  assert.equal(error, null);
  assert.equal(sample.Endpoints.length, 4);
  assert.ok(sample.Endpoints.every((e) => e.Volume === null));
});

test('CollectMacAudio fails when the profiler fails or returns garbage', async () => {
  const failing = loadMac({ execFile: () => [new Error('profiler missing'), ''] });
  const [error1, sample1] = await failing.mod.CollectMacAudio();
  assert.equal(error1.message, 'profiler missing');
  assert.equal(sample1, null);

  const garbage = loadMac({ execFile: () => [null, '<html>'] });
  const [error2, sample2] = await garbage.mod.CollectMacAudio();
  assert.ok(error2 instanceof SyntaxError);
  assert.equal(sample2, null);
});

test('BuildMacLevelScripts emits clamped AppleScript, and refuses an input mute', () => {
  const { mod } = loadMac();
  assert.deepEqual(
    mod.BuildMacLevelScripts({ Direction: 'output' }, { Volume: 140, Muted: true }),
    [null, ['set volume output volume 100', 'set volume output muted true']]
  );
  assert.deepEqual(mod.BuildMacLevelScripts({ Direction: 'input' }, { Volume: -4.6 }), [
    null,
    ['set volume input volume 0'],
  ]);
  assert.deepEqual(mod.BuildMacLevelScripts({ Direction: 'output' }, { Muted: false }), [
    null,
    ['set volume output muted false'],
  ]);
  const [error, scripts] = mod.BuildMacLevelScripts({ Direction: 'input' }, { Muted: true });
  assert.match(error.message, /offer an input mute/);
  assert.equal(scripts, null);
});

test('SetMacAudioLevel refuses a non-default endpoint without running anything', async () => {
  const { mod, calls } = loadMac();
  const [error] = await mod.SetMacAudioLevel(
    { Direction: 'output', IsDefault: false, Name: 'Scarlett 18i20' },
    { Volume: 50 }
  );
  assert.match(error.message, /only change the level of the default output/);
  assert.match(error.message, /Scarlett 18i20/);
  assert.equal(calls.length, 0);
});

test('SetMacAudioLevel runs one osascript per statement and stops at the first failure', async () => {
  const ok = loadMac();
  const endpoint = { Direction: 'output', IsDefault: true, Name: 'Speakers' };
  assert.deepEqual(await ok.mod.SetMacAudioLevel(endpoint, { Volume: 50, Muted: false }), [
    null,
    true,
  ]);
  assert.deepEqual(
    ok.calls.map((c) => c.args),
    [
      ['-e', 'set volume output volume 50'],
      ['-e', 'set volume output muted false'],
    ]
  );

  const failing = loadMac({ execFile: () => [new Error('denied'), ''] });
  const [error] = await failing.mod.SetMacAudioLevel(endpoint, { Volume: 50, Muted: false });
  assert.equal(error.message, 'denied');
  assert.equal(failing.calls.length, 1);

  const refused = loadMac();
  const [muteError] = await refused.mod.SetMacAudioLevel(
    { Direction: 'input', IsDefault: true, Name: 'Mic' },
    { Muted: true }
  );
  assert.match(muteError.message, /offer an input mute/);
  assert.equal(refused.calls.length, 0);
});

test('virtual devices such as Dante Virtual Soundcard are kept, with their channel counts', () => {
  // Nothing is filtered by transport: a virtual soundcard is often THE show
  // output, and its channel count changing is exactly what should alert.
  const { mod } = loadMac();
  const endpoints = mod.ParseSystemProfilerAudio(
    JSON.stringify({
      SPAudioDataType: [
        {
          _items: [
            {
              _name: 'Dante Virtual Soundcard',
              coreaudio_device_input: 64,
              coreaudio_device_output: 64,
              coreaudio_device_manufacturer: 'Audinate',
              coreaudio_device_srate: 48000,
              coreaudio_device_transport: 'coreaudio_device_type_virtual',
            },
          ],
        },
      ],
    })
  );
  assert.deepEqual(
    endpoints.map((e) => [e.EndpointID, e.Channels, e.Transport]),
    [
      ['coreaudio:input:audinate:dante-virtual-soundcard', 64, 'virtual'],
      ['coreaudio:output:audinate:dante-virtual-soundcard', 64, 'virtual'],
    ]
  );
});
