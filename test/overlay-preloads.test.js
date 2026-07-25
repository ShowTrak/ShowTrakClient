const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

// Exercises src/identify-preload.ts and src/launch-countdown-preload.ts.
//
// Both are tiny, but they are security boundaries: each runs with
// contextIsolation in an always-on-top window and decides exactly what the
// overlay renderer may reach. The properties worth pinning are that each
// exposes ONE method on ONE global and forwards to ONE channel — because the
// failure mode of a preload is not a crash, it is quietly handing the renderer
// more surface than intended.
//
// The launch-countdown one also carries real consequence: its single Cancel
// call is the wire behind the abort button for a run-on-launch script (see
// launch-countdown-overlay.test.js).

function loadPreload(file, globalName) {
  const exposed = [];
  const invoked = [];

  loadWithMocks(path.join(__dirname, '..', 'dist', `${file}.js`), {
    electron: {
      contextBridge: {
        exposeInMainWorld: (name, api) => exposed.push({ name, api }),
      },
      ipcRenderer: {
        invoke: async (channel, ...args) => {
          invoked.push({ channel, args });
          return { ok: true, channel };
        },
      },
    },
  });

  assert.equal(exposed.length, 1, `${file} should expose exactly one global`);
  assert.equal(exposed[0].name, globalName);
  return { api: exposed[0].api, invoked };
}

// --- identify-preload -------------------------------------------------------

test('the identify preload exposes only IdentifyAPI.Close', () => {
  const { api } = loadPreload('identify-preload', 'IdentifyAPI');
  assert.deepEqual(Object.keys(api), ['Close']);
  assert.equal(typeof api.Close, 'function');
});

test('IdentifyAPI.Close invokes the Identify:Close channel and returns its result', async () => {
  const { api, invoked } = loadPreload('identify-preload', 'IdentifyAPI');

  const Result = await api.Close();
  assert.deepEqual(invoked, [{ channel: 'Identify:Close', args: [] }]);
  assert.deepEqual(Result, { ok: true, channel: 'Identify:Close' });
});

test('the identify preload ignores renderer-supplied arguments', () => {
  // The renderer must not be able to steer the call — the channel is fixed and
  // nothing it passes is forwarded to the main process.
  const { api, invoked } = loadPreload('identify-preload', 'IdentifyAPI');
  api.Close('extra', { evil: true });
  assert.deepEqual(invoked, [{ channel: 'Identify:Close', args: [] }]);
});

// --- launch-countdown-preload ----------------------------------------------

test('the launch countdown preload exposes only LaunchCountdownAPI.Cancel', () => {
  const { api } = loadPreload('launch-countdown-preload', 'LaunchCountdownAPI');
  assert.deepEqual(Object.keys(api), ['Cancel']);
  assert.equal(typeof api.Cancel, 'function');
});

test('LaunchCountdownAPI.Cancel invokes the LaunchCountdown:Cancel channel', async () => {
  // This is the wire behind the abort button for a run-on-launch script.
  const { api, invoked } = loadPreload('launch-countdown-preload', 'LaunchCountdownAPI');

  const Result = await api.Cancel();
  assert.deepEqual(invoked, [{ channel: 'LaunchCountdown:Cancel', args: [] }]);
  assert.deepEqual(Result, { ok: true, channel: 'LaunchCountdown:Cancel' });
});

test('the launch countdown preload ignores renderer-supplied arguments', () => {
  const { api, invoked } = loadPreload('launch-countdown-preload', 'LaunchCountdownAPI');
  api.Cancel('extra', 42);
  assert.deepEqual(invoked, [{ channel: 'LaunchCountdown:Cancel', args: [] }]);
});

// --- Cross-checks -----------------------------------------------------------

test('the two overlay preloads share no global and no channel', () => {
  // Each overlay window loads exactly one of these; a name or channel collision
  // would let one overlay drive the other's main-process handler.
  const Identify = loadPreload('identify-preload', 'IdentifyAPI');
  const Countdown = loadPreload('launch-countdown-preload', 'LaunchCountdownAPI');

  Identify.api.Close();
  Countdown.api.Cancel();

  assert.notEqual(Identify.invoked[0].channel, Countdown.invoked[0].channel);
});

test('neither overlay preload exposes ipcRenderer or a general invoke escape hatch', () => {
  // The whole point of contextIsolation: the renderer gets the named method and
  // nothing else. A leaked `invoke`/`send`/`on` would reopen the boundary.
  for (const [File, Global] of [
    ['identify-preload', 'IdentifyAPI'],
    ['launch-countdown-preload', 'LaunchCountdownAPI'],
  ]) {
    const { api } = loadPreload(File, Global);
    for (const Leak of ['invoke', 'send', 'sendSync', 'on', 'once', 'ipcRenderer', 'require']) {
      assert.equal(api[Leak], undefined, `${File} leaked ${Leak}`);
    }
    assert.equal(Object.keys(api).length, 1, `${File} exposes more than one method`);
  }
});
