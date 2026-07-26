// src/main/app-updater.ts
//
// Before main.ts was decomposed this logic sat inside a 1,652-line file at ~51%
// coverage and could not be loaded on its own. It decides whether a client in the
// field successfully self-updates or bricks itself trying, and the LAN path in
// particular reports success/failure back to the operator's execution panel — so
// "reported success but did not update" is the failure mode that matters.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, withMocks } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'main', 'app-updater.js');

const silentLogger = {
  log: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  success: () => {},
  silent: () => {},
};

/**
 * Load app-updater with a controllable environment.
 *
 * @param isPackaged        app.isPackaged — gates the real updater paths
 * @param version           Config.Application.Version, for the LAN version check
 * @param pushes            collects PushToRenderer calls
 */
function buildMocks({ isPackaged = true, version = '3.14.0', pushes = [] } = {}) {
  // electron-updater must be mocked, not just electron: it dereferences
  // app.getVersion() the moment its `autoUpdater` getter is touched, so the real
  // package cannot be constructed outside a running Electron main process. Its
  // API surface is verified separately against a real Electron by
  // scripts/electron-api-probe.js.
  const electronUpdaterMock = {
    autoUpdater: {
      on: () => {},
      setFeedURL: () => {},
      checkForUpdates: async () => ({}),
      quitAndInstall: () => {},
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowDowngrade: false,
      updateConfigPath: '',
    },
  };

  return {
    electron: {
      app: { isPackaged, getVersion: () => version },
      autoUpdater: {
        on: () => {},
        setFeedURL: () => {},
        checkForUpdates: () => {},
        quitAndInstall: () => {},
      },
    },
    'electron-updater': electronUpdaterMock,
    '../Modules/Logger': { CreateLogger: () => silentLogger },
    '../Modules/Config': { Config: { Application: { Version: version, Name: 'ShowTrak Client' } } },
    './renderer-bus': {
      PushToRenderer: (channel, payload) => pushes.push([channel, payload]),
    },
    './tray': { destroyTray: () => {}, hasTray: () => false },
    './app-window': {
      hasMainWindow: () => false,
      isAppQuitRequested: () => false,
      removeCloseGuard: () => {},
      setAppQuitRequested: () => {},
    },
  };
}

/**
 * Load app-updater AND run the test body with the mocks still installed.
 *
 * This has to wrap the body, not just the load. ensureAutoUpdater() does a LAZY
 * `require('electron-updater')` inside a function — deliberately, because that
 * package dereferences app.getVersion() at construction and cannot be loaded
 * outside a running Electron main process. loadWithMocks restores Module._load
 * as soon as the initial require returns, so a lazy require executed later in
 * the test would resolve to the REAL electron-updater and throw. Keeping the
 * mocks installed for the whole body is what makes the updater paths reachable.
 */
async function withUpdater(options, run) {
  const mocks = buildMocks(options);
  return withMocks(mocks, () => run(loadWithMocks(MODULE_PATH, mocks)));
}

test('mapUpdaterStateToProgress maps every state the LAN panel can show', async () => {
  await withUpdater({}, async ({ mapUpdaterStateToProgress }) => {
    assert.deepEqual(mapUpdaterStateToProgress({ state: 'checking' }), [5, 'Checking for updates']);
    assert.deepEqual(mapUpdaterStateToProgress({ state: 'available' }), [15, 'Update available']);
    assert.deepEqual(mapUpdaterStateToProgress({ state: 'downloaded' }), [100, 'Downloaded']);
    assert.deepEqual(mapUpdaterStateToProgress({ state: 'installing' }), [
      100,
      'Installing update',
    ]);
    assert.deepEqual(mapUpdaterStateToProgress({ state: 'none' }), [100, 'Already up to date']);

    // Case is normalised, so a differently-cased state from either updater still maps.
    assert.deepEqual(mapUpdaterStateToProgress({ state: 'CHECKING' }), [5, 'Checking for updates']);

    // Unknown / missing state must not read as progress.
    assert.deepEqual(mapUpdaterStateToProgress({ state: 'wat' }), [0, 'Waiting']);
    assert.deepEqual(mapUpdaterStateToProgress({}), [0, 'Waiting']);
    assert.deepEqual(mapUpdaterStateToProgress(), [0, 'Waiting']);
  });
});

test('download progress is clamped and rounded, never NaN', async () => {
  await withUpdater({}, async ({ mapUpdaterStateToProgress }) => {
    const pct = (percent) => mapUpdaterStateToProgress({ state: 'downloading', percent })[0];

    assert.equal(pct(0), 0);
    assert.equal(pct(42.4), 42);
    assert.equal(pct(42.6), 43);
    assert.equal(pct(100), 100);
    // A bad percent must not escape as NaN into a progress bar.
    assert.equal(pct(-5), 0);
    assert.equal(pct(1000), 100);
    assert.equal(pct('abc'), 0);
    assert.equal(pct(undefined), 0);
    assert.equal(pct(Infinity), 0);

    assert.equal(
      mapUpdaterStateToProgress({ state: 'downloading', percent: 37 })[1],
      'Downloading 37%'
    );
  });
});

test('an error state surfaces the error text, falling back to a generic label', async () => {
  await withUpdater({}, async ({ mapUpdaterStateToProgress }) => {
    assert.deepEqual(mapUpdaterStateToProgress({ state: 'error', error: 'disk full' }), [
      0,
      'disk full',
    ]);
    assert.deepEqual(mapUpdaterStateToProgress({ state: 'error' }), [0, 'Update error']);
  });
});

test('normalizeVersionToken makes version comparison tolerant of tag spelling', async () => {
  await withUpdater({}, async ({ normalizeVersionToken }) => {
    // The point of this: a server may ask for "v3.14.0" while the app reports
    // "3.14.0". Treating those as different would report a phantom update failure.
    assert.equal(normalizeVersionToken('v3.14.0'), '3.14.0');
    assert.equal(normalizeVersionToken('V3.14.0'), '3.14.0');
    assert.equal(normalizeVersionToken('  3.14.0  '), '3.14.0');
    assert.equal(normalizeVersionToken('3.14.0-BETA'), '3.14.0-beta');
    assert.equal(normalizeVersionToken(null), '');
    assert.equal(normalizeVersionToken(undefined), '');
  });
});

test('isSquirrelWindows is false on non-Windows platforms', async () => {
  await withUpdater({}, async ({ isSquirrelWindows }) => {
    if (process.platform === 'win32') {
      // On Windows the answer depends on whether Update.exe sits above the binary,
      // which is a property of the install, not of this code.
      assert.equal(typeof isSquirrelWindows(), 'boolean');
    } else {
      assert.equal(isSquirrelWindows(), false);
    }
  });
});

test('sendAppUpdateStatus records the status and pushes it to the renderer', async () => {
  const pushes = [];
  await withUpdater({ pushes }, async ({ sendAppUpdateStatus, getAppUpdateStatus }) => {
    assert.equal(getAppUpdateStatus(), null);

    sendAppUpdateStatus({ state: 'checking' });
    assert.deepEqual(getAppUpdateStatus(), { state: 'checking' });
    assert.deepEqual(pushes, [['AppUpdate:Status', { state: 'checking' }]]);

    sendAppUpdateStatus({ state: 'downloading', percent: 50 });
    assert.deepEqual(getAppUpdateStatus(), { state: 'downloading', percent: 50 });
    assert.equal(pushes.length, 2);
  });
});

test('an unpackaged build refuses a remote self-update instead of pretending', async () => {
  await withUpdater({ isPackaged: false }, async ({ handleRemoteUpdateRequest }) => {
    let reported = 'not called';
    await handleRemoteUpdateRequest((err) => {
      reported = err;
    });
    assert.match(String(reported), /not packaged/i);
  });
});

test('a LAN update with no feed URL fails fast', async () => {
  await withUpdater({ isPackaged: true }, async ({ handleRemoteLanUpdateRequest }) => {
    let reported = 'not called';
    await handleRemoteLanUpdateRequest({}, undefined, (err) => {
      reported = err;
    });
    assert.match(String(reported), /Missing LAN update feed URL/);
  });
});

test('an unpackaged build refuses a LAN update', async () => {
  await withUpdater({ isPackaged: false }, async ({ handleRemoteLanUpdateRequest }) => {
    let reported = 'not called';
    await handleRemoteLanUpdateRequest(
      { FeedURL: 'http://10.0.0.1:3000/updates/' },
      undefined,
      (err) => {
        reported = err;
      }
    );
    assert.match(String(reported), /not packaged/i);
  });
});

test('a LAN update reaching "downloaded" reports success', async () => {
  const pushes = [];
  await withUpdater({ pushes }, async ({ handleRemoteLanUpdateRequest, sendAppUpdateStatus }) => {
    const progress = [];
    let reported = 'not called';
    const done = handleRemoteLanUpdateRequest(
      { FeedURL: 'http://10.0.0.1:3000/updates/client/latest/' },
      (percent, text) => progress.push([percent, text]),
      (err) => {
        reported = err;
      }
    );

    // performUpdateCheck's real work is stubbed out (the electron autoUpdater mock
    // does nothing), so drive the session the way the updater's events would.
    await new Promise((resolve) => setImmediate(resolve));
    sendAppUpdateStatus({ state: 'downloading', percent: 40 });
    sendAppUpdateStatus({ state: 'downloaded' });
    await done;

    assert.equal(reported, null, 'a completed download must report success');
    // The initial 'checking' tick plus the two driven states.
    assert.deepEqual(progress[0], [5, 'Checking for updates']);
    assert.ok(
      progress.some(([p, t]) => p === 40 && t === 'Downloading 40%'),
      `expected a 40% progress tick, got ${JSON.stringify(progress)}`
    );
    assert.deepEqual(progress.at(-1), [100, 'Downloaded']);
  });
});

test('a LAN update that errors reports the error text back to the server', async () => {
  await withUpdater({}, async ({ handleRemoteLanUpdateRequest, sendAppUpdateStatus }) => {
    let reported = 'not called';
    const done = handleRemoteLanUpdateRequest(
      { FeedURL: 'http://10.0.0.1:3000/updates/' },
      undefined,
      (err) => {
        reported = err;
      }
    );
    await new Promise((resolve) => setImmediate(resolve));
    sendAppUpdateStatus({ state: 'error', error: 'signature mismatch' });
    await done;

    assert.match(String(reported), /signature mismatch/);
  });
});

test('"already up to date" is success when no specific version was requested', async () => {
  await withUpdater(
    { version: '3.14.0' },
    async ({ handleRemoteLanUpdateRequest, sendAppUpdateStatus }) => {
      let reported = 'not called';
      const done = handleRemoteLanUpdateRequest(
        { FeedURL: 'http://10.0.0.1:3000/updates/' },
        undefined,
        (err) => {
          reported = err;
        }
      );
      await new Promise((resolve) => setImmediate(resolve));
      sendAppUpdateStatus({ state: 'none' });
      await done;

      assert.equal(reported, null);
    }
  );
});

test('"already up to date" is success when we are already ON the requested version', async () => {
  await withUpdater(
    { version: '3.14.0' },
    async ({ handleRemoteLanUpdateRequest, sendAppUpdateStatus }) => {
      let reported = 'not called';
      const done = handleRemoteLanUpdateRequest(
        { FeedURL: 'http://10.0.0.1:3000/updates/', ReleaseVersion: 'v3.14.0' },
        undefined,
        (err) => {
          reported = err;
        }
      );
      await new Promise((resolve) => setImmediate(resolve));
      sendAppUpdateStatus({ state: 'none' });
      await done;

      assert.equal(reported, null, 'v3.14.0 and 3.14.0 must compare equal');
    }
  );
});

test('"already up to date" is a FAILURE when a different version was requested', async () => {
  await withUpdater(
    { version: '3.14.0' },
    async ({ handleRemoteLanUpdateRequest, sendAppUpdateStatus }) => {
      let reported = 'not called';
      const done = handleRemoteLanUpdateRequest(
        { FeedURL: 'http://10.0.0.1:3000/updates/', ReleaseVersion: '3.15.0' },
        undefined,
        (err) => {
          reported = err;
        }
      );
      await new Promise((resolve) => setImmediate(resolve));
      sendAppUpdateStatus({ state: 'none' });
      await done;

      assert.match(String(reported), /3\.15\.0.*unavailable/i);
    }
  );
});

test('a throwing progress callback does not fail the update', async () => {
  await withUpdater({}, async ({ handleRemoteLanUpdateRequest, sendAppUpdateStatus }) => {
    let reported = 'not called';
    const done = handleRemoteLanUpdateRequest(
      { FeedURL: 'http://10.0.0.1:3000/updates/' },
      () => {
        throw new Error('socket closed');
      },
      (err) => {
        reported = err;
      }
    );
    await new Promise((resolve) => setImmediate(resolve));
    sendAppUpdateStatus({ state: 'downloaded' });
    await done;

    assert.equal(reported, null);
  });
});

test('installUpdate on an unpackaged build reports installing then installed', async () => {
  const pushes = [];
  await withUpdater({ isPackaged: false, pushes }, async ({ installUpdate }) => {
    installUpdate();
    assert.deepEqual(pushes.at(-1), ['AppUpdate:Status', { state: 'installing' }]);

    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.deepEqual(pushes.at(-1), ['AppUpdate:Status', { state: 'installed' }]);
  });
});
