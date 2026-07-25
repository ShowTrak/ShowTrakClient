const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

// Exercises src/Modules/LaunchCountdownOverlay/index.ts.
//
// This is the highest consequence-per-line module in the client. The countdown
// IS the abort window for a run-on-launch script: the script only runs when the
// promise resolves 'expired'. If it ever resolves 'expired' when it should not
// have, a destructive startup script (a shutdown, a reimage) runs unattended
// and can trap an auto-launching machine in a boot loop with no way in.
//
// So the property under test throughout is: **'expired' is only ever reached by
// the timer actually running out.** Every failure mode — no window, a throwing
// BrowserWindow constructor, a superseded countdown, a resolve handler that
// throws — must fail CLOSED to 'cancelled'.
//
// Follows the harness style of identify-overlay-window-bounds.test.js.

const MODULE_PATH = path.join(
  __dirname,
  '..',
  'dist',
  'Modules',
  'LaunchCountdownOverlay',
  'index.js'
);

function createHarness({ constructorThrows = false, screenThrows = false } = {}) {
  const created = [];
  const logs = { warns: [], errors: [], logs: [] };

  class FakeBrowserWindow {
    constructor(options) {
      if (constructorThrows) throw new Error('no display available');
      this.options = options;
      this.destroyed = false;
      this.showCount = 0;
      this.focusCount = 0;
      this.loadedFile = null;
      this.loadedSearch = null;
      this.alwaysOnTop = [];
      this.readyHandlers = [];
      this.inputHandlers = [];
      this.webContents = {
        on: (event, cb) => {
          if (event === 'before-input-event') this.inputHandlers.push(cb);
        },
      };
      created.push(this);
    }

    setAlwaysOnTop(...args) {
      this.alwaysOnTop.push(args);
    }
    setVisibleOnAllWorkspaces() {}
    loadFile(file, options) {
      this.loadedFile = file;
      this.loadedSearch = options && options.search;
    }
    once(event, cb) {
      if (event === 'ready-to-show') this.readyHandlers.push(cb);
    }
    isDestroyed() {
      return this.destroyed;
    }
    show() {
      this.showCount += 1;
    }
    focus() {
      this.focusCount += 1;
    }
    destroy() {
      this.destroyed = true;
    }

    /** Drive the renderer lifecycle the way Electron would. */
    emitReadyToShow() {
      for (const Handler of this.readyHandlers.splice(0)) Handler();
    }
    /** Drive a key press through the before-input-event fallback. */
    pressKey(key, type = 'keyDown') {
      for (const Handler of this.inputHandlers) Handler({}, { type, key });
    }
  }

  const { Manager } = loadWithMocks(MODULE_PATH, {
    electron: {
      BrowserWindow: FakeBrowserWindow,
      screen: {
        getPrimaryDisplay: () => {
          if (screenThrows) throw new Error('no screen');
          return { workArea: { x: 100, y: 50, width: 1920, height: 1080 } };
        },
      },
    },
    '../Logger': {
      CreateLogger: () => ({
        log: (...args) => logs.logs.push(args),
        info: () => {},
        warn: (...args) => logs.warns.push(args),
        error: (...args) => logs.errors.push(args),
        debug: () => {},
        success: () => {},
        database: () => {},
        databaseError: () => {},
      }),
    },
  });

  return { Manager, created, logs, last: () => created[created.length - 1] };
}

/** Resolve after `ms`, giving the module's real timer room to fire. */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- The expiry path (the only route to running the script) ----------------

test('the countdown resolves expired only after the timer runs out', async () => {
  const H = createHarness();
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 1 });

  let Settled = null;
  Pending.then((O) => (Settled = O));

  await wait(50);
  assert.equal(Settled, null, 'resolved before the countdown elapsed');

  assert.equal(await Pending, 'expired');
});

test('a sub-second or malformed duration is clamped to at least one second', async () => {
  // Math.max(1, ...) — a zero/NaN duration must not collapse the abort window
  // to nothing, which would run the script instantly.
  for (const Seconds of [0, -5, 0.4, null, undefined, NaN, 'soon', {}]) {
    const H = createHarness();
    const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds });

    let Settled = null;
    Pending.then((O) => (Settled = O));
    await wait(50);
    assert.equal(Settled, null, `duration ${JSON.stringify(Seconds)} gave no abort window`);

    H.Manager.HandleUserCancel();
    assert.equal(await Pending, 'cancelled');
  }
});

test('the renderer is told the script name and clamped duration', async () => {
  const H = createHarness();
  const Pending = H.Manager.Show({ ScriptName: 'Reboot PC & Wait', Seconds: 7 });

  const Win = H.last();
  assert.match(Win.loadedSearch, /script=Reboot%20PC%20%26%20Wait/);
  assert.match(Win.loadedSearch, /seconds=7/);

  H.Manager.HandleUserCancel();
  await Pending;
});

test('a missing script name falls back to a generic label', async () => {
  const H = createHarness();
  const Pending = H.Manager.Show({ Seconds: 5 });
  assert.match(H.last().loadedSearch, /script=startup%20script/);
  H.Manager.HandleUserCancel();
  await Pending;
});

// --- Every abort route ------------------------------------------------------

test('the Cancel action resolves cancelled and never runs the script', async () => {
  const H = createHarness();
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });

  H.Manager.HandleUserCancel();
  assert.equal(await Pending, 'cancelled');
});

test('Escape and Shift abort via the before-input-event fallback', async () => {
  // The keyboard path exists so an operator can abort even if the renderer
  // script failed to load and the Cancel button is dead.
  for (const Key of ['Escape', 'Shift']) {
    const H = createHarness();
    const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });

    H.last().pressKey(Key);
    assert.equal(await Pending, 'cancelled', `${Key} did not abort`);
  }
});

test('key-up events and other keys do not abort', async () => {
  const H = createHarness();
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });
  const Win = H.last();

  Win.pressKey('Escape', 'keyUp');
  Win.pressKey('a');
  Win.pressKey('Enter');
  Win.pressKey(undefined);

  let Settled = null;
  Pending.then((O) => (Settled = O));
  await wait(30);
  assert.equal(Settled, null, 'an unrelated key aborted the countdown');

  H.Manager.HandleUserCancel();
  await Pending;
});

test('cancelling twice settles only once', async () => {
  const H = createHarness();
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });

  H.Manager.HandleUserCancel();
  H.Manager.HandleUserCancel();
  H.last().pressKey('Escape');

  assert.equal(await Pending, 'cancelled');
  assert.equal(H.created.length, 1);
});

test('HandleUserCancel with no countdown running is a no-op', () => {
  const H = createHarness();
  assert.doesNotThrow(() => H.Manager.HandleUserCancel());
  assert.equal(H.created.length, 0);
});

test('cancelling stops the expiry timer so expired can never arrive late', async () => {
  // If the timer survived the cancel, the script would run a second later —
  // after the operator had already aborted it.
  const H = createHarness();
  const Outcomes = [];
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 1 });
  Pending.then((O) => Outcomes.push(O));

  H.Manager.HandleUserCancel();
  await wait(1200);

  assert.deepEqual(Outcomes, ['cancelled']);
});

// --- Failing closed ---------------------------------------------------------

test('a window that cannot be created resolves cancelled, never expired', async () => {
  // Without a visible abort window there is no way for an operator to stop the
  // script, so the only safe answer is to refuse to run it.
  const H = createHarness({ constructorThrows: true });
  const Outcome = await H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });

  assert.equal(Outcome, 'cancelled');
  assert.equal(H.Manager.IsActive(), false);
  assert.equal(H.logs.errors.length, 1);
});

test('a failed window leaves no state that would break the next countdown', async () => {
  const H = createHarness({ constructorThrows: true });
  assert.equal(await H.Manager.Show({ Seconds: 30 }), 'cancelled');
  // A second attempt must not be short-circuited by a stale resolver.
  assert.equal(await H.Manager.Show({ Seconds: 30 }), 'cancelled');
});

test('a starting countdown supersedes a previous one as cancelled', async () => {
  // Two run-on-launch scripts racing must not leave the first one resolving
  // 'expired' behind the operator's back.
  const H = createHarness();
  const First = H.Manager.Show({ ScriptName: 'first', Seconds: 30 });
  const Second = H.Manager.Show({ ScriptName: 'second', Seconds: 30 });

  assert.equal(await First, 'cancelled');
  assert.equal(H.created.length, 2);
  assert.equal(H.created[0].destroyed, true, 'the superseded window should be torn down');

  H.Manager.HandleUserCancel();
  assert.equal(await Second, 'cancelled');
});

test('a throwing resolve handler is contained and still tears the window down', async () => {
  const H = createHarness();
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });
  // Attach a rejecting continuation the way a caller might.
  Pending.then(() => {
    throw new Error('caller blew up');
  }).catch(() => {});

  assert.doesNotThrow(() => H.Manager.HandleUserCancel());
  await Pending;
  assert.equal(H.Manager.IsActive(), false);
});

test('a failing screen lookup still shows the overlay at default size', async () => {
  // Losing the display metrics must not cost the abort window entirely.
  const H = createHarness({ screenThrows: true });
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });

  const Win = H.last();
  assert.equal(Win.options.width, 560);
  assert.equal(Win.options.height, 320);
  assert.equal(H.logs.warns.length, 1);

  H.Manager.HandleUserCancel();
  await Pending;
});

// --- Window configuration ---------------------------------------------------

test('the overlay is centred on the primary display work area', async () => {
  const H = createHarness();
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });

  const Win = H.last();
  assert.equal(Win.options.x, Math.round(100 + (1920 - 560) / 2));
  assert.equal(Win.options.y, Math.round(50 + (1080 - 320) / 2));

  H.Manager.HandleUserCancel();
  await Pending;
});

test('the overlay is always-on-top, unmovable and has devTools disabled', async () => {
  // The operator must be able to see and reach it, and must not be able to
  // shove it off-screen or open devTools on a hardened window.
  const H = createHarness();
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });

  const { options } = H.last();
  assert.equal(options.alwaysOnTop, true);
  assert.equal(options.movable, false);
  assert.equal(options.resizable, false);
  assert.equal(options.minimizable, false);
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.focusable, true);
  assert.equal(options.webPreferences.devTools, false);
  // Escalated above normal always-on-top so a fullscreen app cannot hide it.
  assert.deepEqual(H.last().alwaysOnTop[0], [true, 'screen-saver']);

  H.Manager.HandleUserCancel();
  await Pending;
});

test('Configure supplies the hardened webPreferences used by the overlay', async () => {
  const H = createHarness();
  H.Manager.Configure({
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });

  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });
  const { webPreferences } = H.last().options;
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.nodeIntegration, false);
  // The preload is always forced on regardless of what was configured.
  assert.match(String(webPreferences.preload), /launch-countdown-preload\.js$/);

  H.Manager.HandleUserCancel();
  await Pending;
});

test('Configure with no webPreferences keeps the hardened defaults', async () => {
  const H = createHarness();
  H.Manager.Configure();
  H.Manager.Configure({});

  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });
  const { webPreferences } = H.last().options;
  assert.equal(webPreferences.contextIsolation, true);
  assert.equal(webPreferences.sandbox, true);
  assert.equal(webPreferences.nodeIntegration, false);
  assert.equal(webPreferences.webSecurity, true);

  H.Manager.HandleUserCancel();
  await Pending;
});

// --- Lifecycle --------------------------------------------------------------

test('the overlay is shown and focused once ready', async () => {
  const H = createHarness();
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });

  const Win = H.last();
  assert.equal(Win.showCount, 0, 'shown before ready-to-show');
  Win.emitReadyToShow();
  assert.equal(Win.showCount, 1);
  assert.equal(Win.focusCount, 1);

  H.Manager.HandleUserCancel();
  await Pending;
});

test('a ready-to-show arriving after teardown does not resurrect the window', async () => {
  const H = createHarness();
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });
  const Win = H.last();

  H.Manager.HandleUserCancel();
  await Pending;

  assert.doesNotThrow(() => Win.emitReadyToShow());
  assert.equal(Win.showCount, 0);
});

test('IsActive tracks the overlay lifetime', async () => {
  const H = createHarness();
  assert.equal(H.Manager.IsActive(), false);

  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });
  assert.equal(H.Manager.IsActive(), true);

  H.Manager.HandleUserCancel();
  await Pending;
  assert.equal(H.Manager.IsActive(), false);
});

test('Hide destroys the window and is safe to call repeatedly', async () => {
  const H = createHarness();
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });
  const Win = H.last();

  H.Manager.Hide();
  assert.equal(Win.destroyed, true);
  assert.equal(H.Manager.IsActive(), false);
  assert.doesNotThrow(() => H.Manager.Hide());

  H.Manager.HandleUserCancel();
  await Pending;
});

test('Hide tolerates a window that is already destroyed', async () => {
  const H = createHarness();
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 30 });
  H.last().destroyed = true;

  assert.doesNotThrow(() => H.Manager.Hide());

  H.Manager.HandleUserCancel();
  await Pending;
});

test('expiry tears the overlay down as well as resolving', async () => {
  const H = createHarness();
  const Pending = H.Manager.Show({ ScriptName: 'reboot', Seconds: 1 });
  const Win = H.last();

  assert.equal(await Pending, 'expired');
  assert.equal(Win.destroyed, true);
  assert.equal(H.Manager.IsActive(), false);
});
