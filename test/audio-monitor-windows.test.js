const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');
const { createFakePowerShell } = require('./helpers/fake-powershell');

// The Windows audio backend.
//
// The real backend compiles a C# Core Audio shim into a persistent PowerShell
// host. Neither can run on the macOS/Linux CI runners, so the host is replaced by
// a scripted fake and these tests pin the contract around it: what script is
// sent, how its JSON is read, and that a dead host falls back to a one-shot
// powershell.exe. The shim itself was compile-checked at C# language version 5
// (what Windows PowerShell 5.1's Add-Type uses) during development; the source
// assertions below guard the C# 5 constraints against regression.

const DIST = path.join(__dirname, '..', 'dist', 'Modules', 'AudioMonitor');

const ROWS = [
  {
    Id: '{0.0.0.00000000}.{aaaa}',
    Flow: 'output',
    Name: 'Speakers (Focusrite USB Audio)',
    Manufacturer: 'Focusrite',
    Channels: 2,
    SampleRate: 48000,
    IsDefault: true,
    Volume: 80,
    Muted: false,
  },
  {
    Id: '{0.0.1.00000000}.{bbbb}',
    Flow: 'input',
    Name: 'Analogue 1 + 2 (Focusrite USB Audio)',
    Manufacturer: null,
    Channels: 0,
    SampleRate: 0,
    IsDefault: false,
    Volume: null,
    Muted: null,
  },
];

function loadWindows({ hostRun, execFile } = {}) {
  const hostCalls = [];
  const execCalls = [];
  const { PowerShell } = createFakePowerShell({
    host: (script, { name, options }) => {
      hostCalls.push({
        host: name,
        script,
        timeout: options.TimeoutMs,
        prelude: options.Prelude || null,
      });
      return hostRun ? hostRun(script) : [null, JSON.stringify(ROWS)];
    },
    oneShot: (script, args) => {
      execCalls.push({ command: 'powershell.exe', args });
      return execFile ? execFile('powershell.exe', args) : [null, ''];
    },
  });
  const mod = loadWithMocks(path.join(DIST, 'windows.js'), {
    '../PowerShell': PowerShell,
    '../Logger': { CreateLogger: () => createSilentLogger() },
  });
  return { mod, hostCalls, execCalls };
}

const decodeBase64Args = (script) =>
  [...script.matchAll(/FromBase64String\('([^']+)'\)/g)].map((m) =>
    Buffer.from(m[1], 'base64').toString('utf8')
  );

test('the shim stays inside C# 5 and declares COM methods without PreserveSig', () => {
  const { mod } = loadWindows();
  const shim = mod.WINDOWS_AUDIO_SHIM;
  assert.equal(/\$"/.test(shim), false, 'string interpolation is C# 6');
  assert.equal(/\bout var\b/.test(shim), false, '`out var` is C# 7');
  assert.equal(/\)\s*=>/.test(shim), false, 'expression-bodied members are C# 6');
  assert.equal(/\?\./.test(shim), false, 'null-conditional is C# 6');
  assert.equal(/PreserveSig/.test(shim), false);
  // The interfaces the shim depends on, by IID.
  for (const iid of [
    'A95664D2-9614-4F35-A746-DE8DB63617E6',
    '0BD7A1BE-7A1A-44DB-8397-CC5392387B5E',
    'D666063F-1587-4E43-81F1-B948E807363F',
    '886d8eeb-8cf2-4446-8d02-cdba1dbdcf99',
    '5CDF2C82-841E-4546-9722-0CF74078229A',
  ]) {
    assert.ok(shim.includes(iid), iid);
  }
});

test('the shim rides in a prelude, sent once per host process, not with every sample', () => {
  const { mod } = loadWindows();
  const script = mod.WINDOWS_QUERY_SCRIPT;
  const prelude = mod.WINDOWS_AUDIO_PRELUDE;
  assert.equal(script.includes('\n'), false, 'the host evaluates one line per request');
  assert.equal(prelude.Script.includes('\n'), false);
  assert.match(script, /\[ShowTrak\.AudioEndpoints\]::Query\(\)$/);
  // The 13.7 KB shim is no longer part of the per-sample script.
  assert.deepEqual(decodeBase64Args(script), []);
  assert.ok(script.length < 400, `the per-sample script is small (${script.length} chars)`);
  assert.deepEqual(decodeBase64Args(prelude.Script), [mod.WINDOWS_AUDIO_SHIM]);
  assert.match(prelude.Script, /if \(-not \('ShowTrak\.AudioEndpoints' -as \[type\]\)\)/);
  // A failed compile is remembered, so the sample can say why the type is missing.
  assert.match(prelude.Script, /ShowTrakAudioShimError/);
  assert.match(script, /ShowTrakAudioShimError/);
});

test('BuildWindowsLevelScript passes the id as base64 and encodes skipped values as -1', () => {
  const { mod } = loadWindows();
  const hostile = "{0.0.0}.{x}'); Remove-Item C:\\ -Recurse; ('\u2019";
  const both = mod.BuildWindowsLevelScript(hostile, { Volume: 64.6, Muted: true });
  assert.equal(both.includes('Remove-Item'), false);
  assert.equal(decodeBase64Args(both)[0], hostile);
  assert.match(both, /, 65, 1\)$/);
  assert.match(mod.BuildWindowsLevelScript('id', { Volume: 140 }), /, 100, -1\)$/);
  assert.match(mod.BuildWindowsLevelScript('id', { Volume: -2 }), /, 0, -1\)$/);
  assert.match(mod.BuildWindowsLevelScript('id', { Muted: false }), /, -1, 0\)$/);
});

test('ToWindowsDeviceID strips the backend prefix and rejects foreign ids', () => {
  const { mod } = loadWindows();
  assert.equal(mod.ToWindowsDeviceID('wasapi:{0.0.0}.{x}'), '{0.0.0}.{x}');
  assert.equal(mod.ToWindowsDeviceID('pulse:output:x'), null);
});

test('ParseWindowsAudio maps rows to endpoints and reads zero format values as unknown', () => {
  const { mod } = loadWindows();
  const endpoints = mod.ParseWindowsAudio(`noise before\n${JSON.stringify(ROWS)}\n`);
  assert.deepEqual(endpoints[0], {
    EndpointID: 'wasapi:{0.0.0.00000000}.{aaaa}',
    Direction: 'output',
    Name: 'Speakers (Focusrite USB Audio)',
    Manufacturer: 'Focusrite',
    Transport: null,
    Channels: 2,
    SampleRate: 48000,
    IsDefault: true,
    Volume: 80,
    Muted: false,
  });
  assert.equal(endpoints[1].Direction, 'input');
  assert.equal(endpoints[1].Channels, null);
  assert.equal(endpoints[1].SampleRate, null);
  assert.equal(endpoints[1].Manufacturer, null);
  assert.equal(endpoints[1].Volume, null);
  assert.equal(endpoints[1].Muted, null);
});

test('ParseWindowsAudio skips rows without an id and names nameless endpoints by direction', () => {
  const { mod } = loadWindows();
  const endpoints = mod.ParseWindowsAudio(
    JSON.stringify([null, 'x', { Flow: 'output' }, { Id: 'a', Flow: 'input' }, { Id: 'b' }])
  );
  assert.deepEqual(
    endpoints.map((e) => [e.EndpointID, e.Name]),
    [
      ['wasapi:a', 'Audio Input'],
      ['wasapi:b', 'Audio Output'],
    ]
  );
  assert.throws(() => mod.ParseWindowsAudio('no list here'), /no device list/);
  assert.throws(() => mod.ParseWindowsAudio('[1,2'), /no device list/);
  // An array buried in other output is not a device list; an empty list here
  // would read as "every critical device is missing".
  assert.throws(() => mod.ParseWindowsAudio('{"a":[1]}'), /no device list/);
  assert.throws(() => mod.ParseWindowsAudio('[1,2'), /no device list/);
  assert.throws(() => mod.ParseWindowsAudio('[oops]'), SyntaxError);
});

test('CollectWindowsAudio uses the shared Desktop host, allowing the first compile time', async () => {
  const { mod, hostCalls, execCalls } = loadWindows();
  const [error, sample] = await mod.CollectWindowsAudio();
  assert.equal(error, null);
  assert.equal(sample.Backend, 'wasapi');
  assert.equal(sample.Capabilities.OutputVolume, 'device');
  assert.equal(sample.Capabilities.Transport, false);
  assert.equal(sample.Endpoints.length, 2);
  assert.equal(hostCalls[0].host, 'PowerShell:Desktop');
  assert.equal(hostCalls[0].script, mod.WINDOWS_QUERY_SCRIPT);
  assert.equal(hostCalls[0].prelude, mod.WINDOWS_AUDIO_PRELUDE);
  assert.ok(hostCalls[0].timeout + hostCalls[0].prelude.ExtraTimeoutMs >= 15000);
  assert.equal(execCalls.length, 0);
});

test('CollectWindowsAudio falls back to a one-shot powershell.exe when the host fails', async () => {
  const { mod, execCalls } = loadWindows({
    hostRun: () => [new Error('PowerShell host unavailable'), null],
    execFile: () => [null, JSON.stringify(ROWS)],
  });
  const [error, sample] = await mod.CollectWindowsAudio();
  assert.equal(error, null);
  assert.equal(sample.Endpoints.length, 2);
  assert.equal(execCalls[0].command, 'powershell.exe');
  const command = execCalls[0].args[execCalls[0].args.length - 1];
  assert.ok(command.startsWith("$ErrorActionPreference = 'Stop'; "));
  // A cold powershell.exe has to compile the shim itself.
  assert.ok(command.includes(mod.WINDOWS_AUDIO_PRELUDE.Script));
  assert.ok(command.endsWith(mod.WINDOWS_QUERY_SCRIPT));
});

test('CollectWindowsAudio does not re-run a script that raised in a cold powershell.exe', async () => {
  const { mod, execCalls } = loadWindows({
    hostRun: () => [
      Object.assign(new Error('The Core Audio shim could not be compiled: blocked'), {
        code: 'ESCRIPT',
      }),
      null,
    ],
  });
  const [error] = await mod.CollectWindowsAudio();
  assert.match(error.message, /could not be compiled: blocked/);
  assert.equal(execCalls.length, 0);
});

test('CollectWindowsAudio reports the failure when both paths fail, or the output is junk', async () => {
  const dead = loadWindows({
    hostRun: () => [new Error('host down'), null],
    execFile: () => [new Error('spawn powershell.exe ENOENT'), ''],
  });
  const [error1, sample1] = await dead.mod.CollectWindowsAudio();
  assert.match(error1.message, /ENOENT/);
  assert.equal(sample1, null);

  const junk = loadWindows({ hostRun: () => [null, 'Add-Type : compile error'] });
  const [error2, sample2] = await junk.mod.CollectWindowsAudio();
  assert.match(error2.message, /no device list/);
  assert.equal(sample2, null);
});

test('SetWindowsAudioLevel sends the change for the raw device id', async () => {
  const { mod, hostCalls } = loadWindows({ hostRun: () => [null, 'ok'] });
  const result = await mod.SetWindowsAudioLevel(
    { EndpointID: 'wasapi:{0.0.0}.{x}', Direction: 'output' },
    { Volume: 30 }
  );
  assert.deepEqual(result, [null, true]);
  assert.equal(decodeBase64Args(hostCalls[0].script)[0], '{0.0.0}.{x}');
  assert.equal(hostCalls[0].prelude, mod.WINDOWS_AUDIO_PRELUDE);
  assert.match(hostCalls[0].script, /, 30, -1\)$/);
});

test('SetWindowsAudioLevel rejects foreign ids and surfaces a shim failure', async () => {
  const { mod, hostCalls } = loadWindows();
  const [foreignError] = await mod.SetWindowsAudioLevel(
    { EndpointID: 'pulse:output:x', Direction: 'output' },
    { Volume: 30 }
  );
  assert.match(foreignError.message, /Not a Windows audio endpoint/);
  assert.equal(hostCalls.length, 0);

  const failing = loadWindows({
    hostRun: () => [new Error('Element not found'), null],
    execFile: () => [new Error('Element not found'), ''],
  });
  const [error] = await failing.mod.SetWindowsAudioLevel(
    { EndpointID: 'wasapi:gone', Direction: 'input' },
    { Muted: true }
  );
  assert.equal(error.message, 'Element not found');
});

test('DisposeWindowsAudio leaves the shared host to its idle shutdown', () => {
  // A reconnect within a few minutes must not pay the shim compile again.
  const { mod } = loadWindows();
  assert.doesNotThrow(() => mod.DisposeWindowsAudio());
});
