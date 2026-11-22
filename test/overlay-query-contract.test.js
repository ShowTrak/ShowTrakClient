// The overlay windows get their data in the URL the main process loads them
// with, not over IPC: IdentifyOverlayQuery and LaunchCountdownQuery in
// @showtrak/protocol/client. Both halves are typed by those contracts; these
// tests take the URL each main-process module actually builds and load the page
// that reads it, so the two cannot drift apart at run time either.

const test = require('node:test');
const { mock } = test;
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');
const { installDom, clearDom, loadRenderer } = require('./helpers/fake-dom');

const DIST = path.join(__dirname, '..', 'dist');
const APP = path.join(__dirname, '..', 'dist-test', 'UI', 'js', 'app');
const { ToQueryString } = require(path.join(DIST, 'Modules', 'Utils', 'index.js'));

test.afterEach(() => {
  mock.timers.reset();
  clearDom();
});

/** Electron stand-ins that record the `search` every window is loaded with. */
function fakeElectron(Displays) {
  const Searches = [];
  class BrowserWindow {
    constructor() {
      this.webContents = { on: () => {} };
    }
    loadFile(_File, Options) {
      Searches.push(Options.search);
    }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setBounds() {}
    once() {}
    on() {}
    show() {}
    focus() {}
    isDestroyed() {
      return false;
    }
    destroy() {}
  }
  return {
    Searches,
    electron: {
      BrowserWindow,
      screen: { getAllDisplays: () => Displays, getPrimaryDisplay: () => Displays[0] },
    },
  };
}

function loadOverlayModule(Name, electron) {
  return loadWithMocks(path.join(DIST, 'Modules', Name, 'index.js'), {
    electron,
    '../Logger': { CreateLogger: () => createSilentLogger() },
  }).Manager;
}

// --- ToQueryString ----------------------------------------------------------

test('ToQueryString writes the names in order and encodes every value', () => {
  assert.equal(
    ToQueryString({ script: 'Reboot PC & Wait?', seconds: '7' }),
    '?script=Reboot%20PC%20%26%20Wait%3F&seconds=7'
  );
  assert.equal(
    ToQueryString({ data: '{"IPs":["10.0.0.1"]}', screenNumber: '2' }),
    `?data=${encodeURIComponent('{"IPs":["10.0.0.1"]}')}&screenNumber=2`
  );
  assert.equal(ToQueryString({ a: '' }), '?a=');
});

// --- Identify overlay -------------------------------------------------------

test('the identify page shows what the main process put in its URL, on every display', () => {
  const Displays = [
    { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 2 },
    { bounds: { x: 1920, y: 0, width: 1280, height: 1024 }, scaleFactor: 1 },
  ];
  const { Searches, electron } = fakeElectron(Displays);
  const Identify = loadOverlayModule('IdentifyOverlay', electron);

  Identify.Show({
    Hostname: 'foh-01',
    Nickname: 'FOH & Stage "Left" 100%',
    IPs: ['10.0.0.50', '192.168.1.50'],
  });
  assert.equal(Searches.length, 2);

  for (const [Index, Search] of Searches.entries()) {
    const Dom = installDom({
      ids: ['nickname', 'hostname', 'screen-number', 'resolution-label', 'ips', 'ips-empty'],
      search: Search,
      api: { IdentifyAPI: { Close: () => {} } },
    });
    loadRenderer(path.join(APP, 'identify-overlay.js'));

    assert.equal(Dom.el('nickname').textContent, 'FOH & Stage "Left" 100%');
    assert.equal(Dom.el('hostname').textContent, 'foh-01');
    assert.deepEqual(
      Dom.el('ips').children.map((Child) => Child.textContent),
      ['10.0.0.50', '192.168.1.50']
    );
    assert.equal(Dom.el('screen-number').textContent, String(Index + 1));
    assert.equal(
      Dom.el('resolution-label').textContent,
      Index === 0 ? 'Screen 1 (3840x2160)' : 'Screen 2 (1280x1024)'
    );
    clearDom();
  }
});

// --- Launch countdown -------------------------------------------------------

test('the countdown page shows the script and duration the main process put in its URL', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { Searches, electron } = fakeElectron([
    { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
  ]);
  const Countdown = loadOverlayModule('LaunchCountdownOverlay', electron);

  const Pending = Countdown.Show({ ScriptName: 'Reboot PC & Wait? #2', Seconds: 7.9 });
  assert.equal(Searches.length, 1);
  Countdown.HandleUserCancel();
  assert.equal(await Pending, 'cancelled');

  const Dom = installDom({
    ids: ['script-name', 'countdown', 'cancel'],
    search: Searches[0],
    api: { LaunchCountdownAPI: { Cancel: () => {} } },
  });
  loadRenderer(path.join(APP, 'launch-countdown.js'));

  assert.equal(Dom.el('script-name').textContent, 'Reboot PC & Wait? #2');
  assert.equal(Dom.el('countdown').textContent, '7');
});
