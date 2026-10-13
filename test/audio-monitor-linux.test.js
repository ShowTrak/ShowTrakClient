const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// The Linux audio backend: pactl (PulseAudio, or PipeWire via pipewire-pulse),
// with ALSA's aplay/arecord as the fallback when no sound server answers.
//
// The fixtures follow `pactl list` as PulseAudio 15/16 and pipewire-pulse print it
// under LC_ALL=C: tab-indented fields, a doubly-indented Properties block, and a
// "Monitor of Sink" field on every source.

const DIST = path.join(__dirname, '..', 'dist', 'Modules', 'AudioMonitor');

const SINKS = [
  'Sink #0',
  '\tState: SUSPENDED',
  '\tName: alsa_output.usb-Focusrite_Scarlett_2i2_USB-00.analog-stereo',
  '\tDescription: Scarlett 2i2 USB Analog Stereo',
  '\tDriver: module-alsa-card.c',
  '\tSample Specification: s32le 2ch 48000Hz',
  '\tChannel Map: front-left,front-right',
  '\tMute: no',
  '\tVolume: front-left: 52429 /  80% / -5.81 dB,   front-right: 52429 /  80% / -5.81 dB',
  '\t        balance 0.00',
  '\tBase Volume: 65536 / 100% / 0.00 dB',
  '\tMonitor Source: alsa_output.usb-Focusrite_Scarlett_2i2_USB-00.analog-stereo.monitor',
  '\tProperties:',
  '\t\talsa.card_name = "Scarlett 2i2 USB"',
  '\t\tdevice.bus = "usb"',
  '\t\tdevice.vendor.name = "Focusrite-Novation"',
  '\t\tdevice.description = "Scarlett 2i2 USB Analog Stereo"',
  '\tPorts:',
  '\t\tanalog-output: Analog Output (type: Line, priority: 9900, availability unknown)',
  '\tActive Port: analog-output',
  '\tFormats:',
  '\t\tpcm',
  '',
  'Sink #1',
  '\tName: alsa_output.pci-0000_01_00.1.hdmi-stereo',
  '\tDescription: GA104 High Definition Audio Controller Digital Stereo (HDMI)',
  '\tSample Specification: s16le 2ch 44100Hz',
  '\tMute: yes',
  '\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 32768 /  50% / -18.06 dB',
  '\tProperties:',
  '\t\tdevice.bus = "pci"',
  '\t\tdevice.vendor.name = "NVIDIA Corporation"',
  '\tActive Port: hdmi-output-0',
  '',
  'Sink #2',
  '\tName: bluez_output.00_11_22_33_44_55.1',
  '\tDescription: Headset',
  '\tSample Specification: s16le 1ch 16000Hz',
  '\tMute: no',
  '\tVolume: mono: 98304 / 150% / 10.57 dB',
  '\tProperties:',
  '\t\tdevice.bus = "bluetooth"',
].join('\n');

const SOURCES = [
  'Source #0',
  '\tName: alsa_output.usb-Focusrite_Scarlett_2i2_USB-00.analog-stereo.monitor',
  '\tDescription: Monitor of Scarlett 2i2 USB Analog Stereo',
  '\tSample Specification: s32le 2ch 48000Hz',
  '\tMute: no',
  '\tMonitor of Sink: alsa_output.usb-Focusrite_Scarlett_2i2_USB-00.analog-stereo',
  '\tProperties:',
  '\t\tdevice.class = "monitor"',
  '',
  'Source #1',
  '\tName: alsa_input.usb-Focusrite_Scarlett_2i2_USB-00.analog-stereo',
  '\tDescription: Scarlett 2i2 USB Analog Stereo',
  '\tSample Specification: s32le 2ch 48000Hz',
  '\tMute: no',
  '\tVolume: front-left: 65536 / 100% / 0.00 dB,   front-right: 65536 / 100% / 0.00 dB',
  '\tMonitor of Sink: n/a',
  '\tProperties:',
  '\t\tdevice.bus = "usb"',
  '\t\tdevice.vendor.name = "Focusrite-Novation"',
  '',
  'Source #3',
  '\tName: aes67_dante_rx',
  '\tDescription: Dante RX (AES67)',
  '\tSample Specification: s24le 8ch 48000Hz',
  '\tMute: no',
  '\tMonitor of Sink: n/a',
  '\tProperties:',
  '\t\tfactory.name = "support.null-audio-sink"',
  '',
  'Source #2',
  '\tName: pipewire_monitor_only',
  '\tDescription: Tap',
  '\tMonitor of Sink: n/a',
  '\tProperties:',
  '\t\tdevice.class = "monitor"',
].join('\n');

const INFO = [
  'Server String: /run/user/1000/pulse/native',
  'Server Name: PulseAudio (on PipeWire 0.3.48)',
  'Default Sink: alsa_output.usb-Focusrite_Scarlett_2i2_USB-00.analog-stereo',
  'Default Source: alsa_input.usb-Focusrite_Scarlett_2i2_USB-00.analog-stereo',
].join('\n');

const APLAY = [
  '**** List of PLAYBACK Hardware Devices ****',
  'card 0: PCH [HDA Intel PCH], device 0: ALC3246 Analog [ALC3246 Analog]',
  '  Subdevices: 1/1',
  '  Subdevice #0: subdevice #0',
  'card 1: USB [Scarlett 2i2 USB], device 0: USB Audio [USB Audio]',
].join('\n');

const ARECORD = [
  '**** List of CAPTURE Hardware Devices ****',
  'card 1: USB [Scarlett 2i2 USB], device 0: USB Audio [USB Audio]',
].join('\n');

const enoent = (command) => Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });

function loadLinux(respond) {
  const calls = [];
  const mod = loadWithMocks(path.join(DIST, 'linux.js'), {
    child_process: {
      execFile: (command, args, options, callback) => {
        calls.push({ command, args, env: options.env });
        const [error, stdout] = respond ? respond(command, args) : [null, ''];
        callback(error, stdout);
      },
    },
    '../Logger': { CreateLogger: () => createSilentLogger() },
  });
  return { mod, calls };
}

const pulseOk = (command, args) => {
  if (command === 'pactl' && args[1] === 'sinks') return [null, SINKS];
  if (command === 'pactl' && args[1] === 'sources') return [null, SOURCES];
  if (command === 'pactl' && args[0] === 'info') return [null, INFO];
  if (command === 'aplay') return [null, APLAY];
  if (command === 'arecord') return [null, ARECORD];
  return [null, ''];
};

test('ParsePactlList reads each block, its fields and only its Properties', () => {
  const { mod } = loadLinux();
  const blocks = mod.ParsePactlList(SINKS);
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].Name, 'alsa_output.usb-Focusrite_Scarlett_2i2_USB-00.analog-stereo');
  assert.equal(blocks[0].Description, 'Scarlett 2i2 USB Analog Stereo');
  assert.equal(blocks[0].SampleSpec, 's32le 2ch 48000Hz');
  assert.equal(blocks[0].Mute, 'no');
  assert.equal(blocks[0].ActivePort, 'analog-output');
  assert.equal(blocks[0].Properties['device.bus'], 'usb');
  assert.equal(blocks[0].Properties['alsa.card_name'], 'Scarlett 2i2 USB');
  // A port line is not a property, even though it is indented the same way.
  assert.equal(
    Object.keys(blocks[0].Properties).some((k) => k.startsWith('analog')),
    false
  );
  assert.deepEqual(mod.ParsePactlList(''), []);
  // A block without a Name is dropped.
  assert.deepEqual(mod.ParsePactlList('Sink #9\n\tDescription: ghost'), []);
});

test('ParsePactlList records which sink a source monitors', () => {
  const { mod } = loadLinux();
  const sources = mod.ParsePactlList(SOURCES);
  assert.equal(sources[0].MonitorOf, 'alsa_output.usb-Focusrite_Scarlett_2i2_USB-00.analog-stereo');
  assert.equal(sources[1].MonitorOf, null);
});

test('ParseSampleSpec and ParsePactlVolume read the format and the mean channel level', () => {
  const { mod } = loadLinux();
  assert.deepEqual(mod.ParseSampleSpec('s32le 2ch 48000Hz'), { Channels: 2, SampleRate: 48000 });
  assert.deepEqual(mod.ParseSampleSpec('float32le 64ch 96000Hz'), {
    Channels: 64,
    SampleRate: 96000,
  });
  assert.deepEqual(mod.ParseSampleSpec(null), { Channels: null, SampleRate: null });
  assert.equal(
    mod.ParsePactlVolume(
      'front-left: 65536 / 100% / 0.00 dB,   front-right: 32768 /  50% / -18.06 dB'
    ),
    75
  );
  assert.equal(mod.ParsePactlVolume('mono: 98304 / 150% / 10.57 dB'), 150);
  assert.equal(mod.ParsePactlVolume(null), null);
  assert.equal(mod.ParsePactlVolume('(invalid)'), null);
});

test('MapPactlTransport classifies by bus, name and port', () => {
  const { mod } = loadLinux();
  const block = (Name, Properties = {}, extra = {}) => ({
    Name,
    Description: null,
    ActivePort: null,
    Properties,
    ...extra,
  });
  assert.equal(mod.MapPactlTransport(block('bluez_output.x')), 'bluetooth');
  assert.equal(mod.MapPactlTransport(block('x', { 'device.bus': 'bluetooth' })), 'bluetooth');
  assert.equal(
    mod.MapPactlTransport(block('x', { 'device.bus': 'pci' }, { ActivePort: 'hdmi-output-0' })),
    'hdmi'
  );
  assert.equal(
    mod.MapPactlTransport(block('x', {}, { Description: 'DisplayPort audio' })),
    'displayport'
  );
  assert.equal(mod.MapPactlTransport(block('x', { 'device.bus': 'usb' })), 'usb');
  assert.equal(mod.MapPactlTransport(block('x', { 'device.bus': 'firewire' })), 'firewire');
  assert.equal(mod.MapPactlTransport(block('x', { 'device.bus': 'ieee1394' })), 'firewire');
  assert.equal(mod.MapPactlTransport(block('x', { 'device.bus': 'thunderbolt' })), 'thunderbolt');
  assert.equal(
    mod.MapPactlTransport(block('x', { 'device.bus': 'pci', 'device.form_factor': 'internal' })),
    'builtin'
  );
  assert.equal(mod.MapPactlTransport(block('x', { 'device.bus': 'pci' })), 'pci');
  assert.equal(mod.MapPactlTransport(block('null-sink')), 'virtual');
  assert.equal(mod.MapPactlTransport(block('x', { 'device.class': 'abstract' })), 'virtual');
  assert.equal(
    mod.MapPactlTransport(block('x', { 'factory.name': 'support.null-audio-sink' })),
    'virtual'
  );
  assert.equal(mod.MapPactlTransport(block('tunnel.studio.local')), 'network');
  assert.equal(mod.MapPactlTransport(block('mystery')), 'unknown');
});

test('ParsePulseDefaults reads the default sink and source', () => {
  const { mod } = loadLinux();
  assert.deepEqual(mod.ParsePulseDefaults(INFO), {
    Sink: 'alsa_output.usb-Focusrite_Scarlett_2i2_USB-00.analog-stereo',
    Source: 'alsa_input.usb-Focusrite_Scarlett_2i2_USB-00.analog-stereo',
  });
  assert.deepEqual(mod.ParsePulseDefaults(''), { Sink: null, Source: null });
});

test('BuildPulseEndpoints drops sink monitors (loopbacks), keeps real inputs, and marks defaults', () => {
  const { mod } = loadLinux();
  const endpoints = mod.BuildPulseEndpoints(
    mod.ParsePactlList(SINKS),
    mod.ParsePactlList(SOURCES),
    mod.ParsePulseDefaults(INFO)
  );
  assert.deepEqual(
    endpoints.map((e) => [e.Direction, e.Name, e.IsDefault, e.Transport, e.Volume, e.Muted]),
    [
      ['output', 'Scarlett 2i2 USB Analog Stereo', true, 'usb', 80, false],
      [
        'output',
        'GA104 High Definition Audio Controller Digital Stereo (HDMI)',
        false,
        'hdmi',
        75,
        true,
      ],
      ['output', 'Headset', false, 'bluetooth', 150, false],
      // "Monitor of ..." and the class-only monitor "Tap" are loopbacks: gone.
      ['input', 'Scarlett 2i2 USB Analog Stereo', true, 'usb', 100, false],
      // A virtual receiver is a real input as far as a show is concerned: kept.
      ['input', 'Dante RX (AES67)', false, 'virtual', null, false],
    ]
  );
  assert.equal(
    endpoints[0].EndpointID,
    'pulse:output:alsa_output.usb-Focusrite_Scarlett_2i2_USB-00.analog-stereo'
  );
  assert.equal(endpoints[0].Manufacturer, 'Focusrite-Novation');
  assert.equal(endpoints[0].Channels, 2);
  assert.equal(endpoints[0].SampleRate, 48000);
});

test('IsMonitorSource recognises a monitor by its sink link or its device class', () => {
  const { mod } = loadLinux();
  const [monitor, real, virtualInput, classOnly] = mod.ParsePactlList(SOURCES);
  assert.equal(mod.IsMonitorSource(virtualInput), false);
  assert.equal(mod.IsMonitorSource(monitor), true);
  assert.equal(mod.IsMonitorSource(real), false);
  assert.equal(mod.IsMonitorSource(classOnly), true);
});

test('BuildPulseEndpoints falls back through description properties and leaves mute unknown', () => {
  const { mod } = loadLinux();
  const [fromProperty, fromName] = mod.BuildPulseEndpoints(
    [
      {
        Name: 'a',
        Description: null,
        Mute: null,
        Volume: null,
        SampleSpec: null,
        MonitorOf: null,
        ActivePort: null,
        Properties: { 'device.description': 'Prop Name' },
      },
      {
        Name: 'b',
        Description: null,
        Mute: 'maybe',
        Volume: null,
        SampleSpec: null,
        MonitorOf: null,
        ActivePort: null,
        Properties: {},
      },
    ],
    [],
    { Sink: null, Source: null }
  );
  assert.equal(fromProperty.Name, 'Prop Name');
  assert.equal(fromName.Name, 'b');
  assert.equal(fromName.Muted, null);
  assert.equal(fromName.IsDefault, false);
});

test('ParseAlsaList reads one endpoint per card/device line', () => {
  const { mod } = loadLinux();
  assert.deepEqual(mod.ParseAlsaList(APLAY, 'output'), [
    {
      EndpointID: 'alsa:output:PCH:0',
      Direction: 'output',
      Name: 'HDA Intel PCH: ALC3246 Analog',
      Manufacturer: null,
      Transport: null,
      Channels: null,
      SampleRate: null,
      IsDefault: false,
      Volume: null,
      Muted: null,
    },
    {
      EndpointID: 'alsa:output:USB:0',
      Direction: 'output',
      Name: 'Scarlett 2i2 USB: USB Audio',
      Manufacturer: null,
      Transport: null,
      Channels: null,
      SampleRate: null,
      IsDefault: false,
      Volume: null,
      Muted: null,
    },
  ]);
  // A PCM named the same as its card is not repeated.
  assert.equal(
    mod.ParseAlsaList('card 2: X [Dante], device 0: Dante [Dante]', 'input')[0].Name,
    'Dante'
  );
  assert.deepEqual(
    mod.ParseAlsaList('aplay: device_list:274: no soundcards found...', 'output'),
    []
  );
});

test('CollectLinuxAudio reads pactl under the C locale', async () => {
  const { mod, calls } = loadLinux(pulseOk);
  const [error, sample] = await mod.CollectLinuxAudio();
  assert.equal(error, null);
  assert.equal(sample.Backend, 'pulseaudio');
  assert.equal(sample.Note, undefined);
  assert.equal(sample.Endpoints.length, 5);
  assert.equal(sample.Capabilities.InputMute, 'device');
  assert.deepEqual(
    calls.map((c) => [c.command, ...c.args]),
    [
      ['pactl', 'list', 'sinks'],
      ['pactl', 'list', 'sources'],
      ['pactl', 'info'],
    ]
  );
  for (const call of calls) assert.equal(call.env.LC_ALL, 'C');
});

test('CollectLinuxAudio falls back to ALSA and says why when pactl is missing', async () => {
  const { mod } = loadLinux((command, args) =>
    command === 'pactl' ? [enoent('pactl'), ''] : pulseOk(command, args)
  );
  const [error, sample] = await mod.CollectLinuxAudio();
  assert.equal(error, null);
  assert.equal(sample.Backend, 'alsa');
  assert.equal(sample.Capabilities.DefaultDevice, false);
  assert.match(sample.Note, /^pactl is not installed, so only ALSA device presence/);
  assert.deepEqual(
    sample.Endpoints.map((e) => e.EndpointID),
    ['alsa:output:PCH:0', 'alsa:output:USB:0', 'alsa:input:USB:0']
  );
});

test('CollectLinuxAudio falls back to ALSA when no sound server is running', async () => {
  const { mod } = loadLinux((command, args) =>
    command === 'pactl'
      ? [new Error('Connection failure: Connection refused'), '']
      : pulseOk(command, args)
  );
  const [error, sample] = await mod.CollectLinuxAudio();
  assert.equal(error, null);
  assert.match(
    sample.Note,
    /PulseAudio\/PipeWire is not reachable \(Connection failure: Connection refused\)/
  );
});

test('CollectLinuxAudio reports unsupported when neither pactl nor ALSA tools exist', async () => {
  const { mod } = loadLinux((command) => [enoent(command), '']);
  const [error, sample] = await mod.CollectLinuxAudio();
  assert.ok(error instanceof mod.NoLinuxAudioStackError);
  assert.match(error.message, /Install pulseaudio-utils/);
  assert.equal(sample, null);
});

test('CollectLinuxAudio surfaces the pactl error when ALSA also fails for another reason', async () => {
  const { mod } = loadLinux((command) =>
    command === 'pactl' ? [new Error('pactl crashed'), ''] : [new Error('aplay crashed'), '']
  );
  const [error, sample] = await mod.CollectLinuxAudio();
  assert.equal(error.message, 'pactl crashed');
  assert.equal(sample, null);
});

test('BuildPactlCommands ends option parsing before naming the sink, and clamps the level', () => {
  const { mod } = loadLinux();
  assert.deepEqual(
    mod.BuildPactlCommands(
      { Direction: 'output', EndpointID: 'pulse:output:-weird.name' },
      { Volume: 120, Muted: true }
    ),
    [
      null,
      [
        ['--', 'set-sink-volume', '-weird.name', '100%'],
        ['--', 'set-sink-mute', '-weird.name', '1'],
      ],
    ]
  );
  assert.deepEqual(
    mod.BuildPactlCommands({ Direction: 'input', EndpointID: 'pulse:input:mic' }, { Muted: false }),
    [null, [['--', 'set-source-mute', 'mic', '0']]]
  );
  const [error] = mod.BuildPactlCommands(
    { Direction: 'output', EndpointID: 'alsa:output:PCH:0' },
    { Volume: 10 }
  );
  assert.match(error.message, /only be listed/);
  // An id whose direction does not match its endpoint is not trusted either.
  const [mismatch] = mod.BuildPactlCommands(
    { Direction: 'input', EndpointID: 'pulse:output:x' },
    { Volume: 10 }
  );
  assert.ok(mismatch);
});

test('SetLinuxAudioLevel runs each pactl command and stops at the first failure', async () => {
  const ok = loadLinux();
  const endpoint = { Direction: 'input', EndpointID: 'pulse:input:mic' };
  assert.deepEqual(await ok.mod.SetLinuxAudioLevel(endpoint, { Volume: 40, Muted: false }), [
    null,
    true,
  ]);
  assert.deepEqual(
    ok.calls.map((c) => c.args),
    [
      ['--', 'set-source-volume', 'mic', '40%'],
      ['--', 'set-source-mute', 'mic', '0'],
    ]
  );
  assert.equal(ok.calls[0].env.LC_ALL, 'C');

  const failing = loadLinux(() => [new Error('No such entity'), '']);
  const [error] = await failing.mod.SetLinuxAudioLevel(endpoint, { Volume: 40, Muted: false });
  assert.equal(error.message, 'No such entity');
  assert.equal(failing.calls.length, 1);

  const refused = loadLinux();
  const [refusal] = await refused.mod.SetLinuxAudioLevel(
    { Direction: 'output', EndpointID: 'alsa:output:PCH:0' },
    { Volume: 1 }
  );
  assert.ok(refusal);
  assert.equal(refused.calls.length, 0);
});
