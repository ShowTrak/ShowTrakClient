const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

// Exercises the log-level gating in src/Modules/Logger/index.ts.
//
// Background: `debug()` used to be gated on `Config.Production`, but Logger
// imported the Config *module* rather than its `Config` export, so the flag was
// always undefined and nothing was ever suppressed. Rather than restore a
// boolean, the Server's level model was ported so both apps behave the same.
//
// Two properties matter, and they pull against each other:
//   - a shipped client must not fill its log with debug chatter, because that
//     is the file the operator sends back when something goes wrong;
//   - that same client has to be able to PRODUCE that detail on demand, from
//     site, without a rebuild — which is what LOG_LEVEL is for, and why debug
//     output reaches the file and not only a console nobody is watching.
//
// The level is read at module load, so every case reloads the module.

const LOGGER_PATH = path.join(__dirname, '..', 'dist', 'Modules', 'Logger', 'index.js');

// Every `colors.x()` becomes a pass-through, so assertions read plain text.
// `__esModule` must answer undefined: TypeScript's __importDefault helper checks
// it, and a Proxy that returns a function for EVERY key makes the helper treat
// this stub as an ES module and hand back the Proxy itself as `.default`.
const IDENTITY_COLORS = new Proxy(
  {},
  {
    get: (_target, prop) => {
      if (prop === '__esModule' || typeof prop === 'symbol') return undefined;
      return (value) => String(value);
    },
  }
);

/**
 * Load Logger with a scripted environment and capture both sinks.
 *
 * `packaged` models Electron's `process.defaultApp`, which is set only when the
 * app was launched from a checkout — its absence is what the module reads as
 * "this is a shipped build".
 */
function loadLogger({ level, nodeEnv, packaged = false } = {}) {
  const LogRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'showtrak-logger-'));
  const printed = [];
  const appended = [];

  const PrevLevel = process.env.LOG_LEVEL;
  const PrevNodeEnv = process.env.NODE_ENV;
  const PrevDefaultApp = process.defaultApp;

  if (level === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = level;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  if (packaged) delete process.defaultApp;
  else process.defaultApp = true;

  const OriginalLog = console.log;
  console.log = (...args) => printed.push(args);

  let Mod;
  try {
    Mod = loadWithMocks(LOGGER_PATH, {
      colors: IDENTITY_COLORS,
      'electron-squirrel-startup': false,
      '../AppData': { Manager: { GetLogsDirectory: () => LogRoot } },
      fs: {
        existsSync: () => true,
        mkdirSync: () => {},
        writeFileSync: () => {},
        appendFileSync: (_target, content) => appended.push(String(content)),
      },
      path,
    });
  } finally {
    console.log = OriginalLog;
    if (PrevLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = PrevLevel;
    if (PrevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = PrevNodeEnv;
    if (PrevDefaultApp === undefined) delete process.defaultApp;
    else process.defaultApp = PrevDefaultApp;
  }

  /** Call one method and report where its output landed. */
  const emit = (method, message = 'msg') => {
    printed.length = 0;
    appended.length = 0;
    const OriginalConsole = console.log;
    console.log = (...args) => printed.push(args);
    try {
      Mod.CreateLogger('Unit')[method](message);
    } finally {
      console.log = OriginalConsole;
    }
    return { console: printed.length > 0, file: appended.length > 0 };
  };

  return { Mod, emit };
}

const CHATTY = ['log', 'info', 'success'];
const LOUD = ['warn', 'error', 'databaseError'];

// --- Defaults ---------------------------------------------------------------

test('a development run keeps debug output', () => {
  // Running from a checkout is exactly when the detail is wanted, and it is the
  // behaviour that existed before the gate — so nothing regresses locally.
  const { emit } = loadLogger({ packaged: false });
  assert.deepEqual(emit('debug'), { console: true, file: true });
});

test('a shipped build suppresses debug output by default', () => {
  // A packaged Electron app has no NODE_ENV, so this only works because the
  // module also checks process.defaultApp — the same test app.isPackaged makes.
  // Without it every client in the field would still log at debug, which is the
  // bug this replaced.
  const { emit } = loadLogger({ packaged: true });
  assert.deepEqual(emit('debug'), { console: false, file: false });
});

test('NODE_ENV=production suppresses debug even when run from a checkout', () => {
  const { emit } = loadLogger({ packaged: false, nodeEnv: 'production' });
  assert.deepEqual(emit('debug'), { console: false, file: false });
});

test('a shipped build still records everything an operator needs', () => {
  // The point of the gate is quieter logs, NOT thinner ones: every level that
  // explains a failure has to survive into the file the operator sends back.
  const { emit } = loadLogger({ packaged: true });

  for (const Method of [...CHATTY, ...LOUD]) {
    assert.deepEqual(emit(Method), { console: true, file: true }, `${Method} was suppressed`);
  }
});

// --- The field override -----------------------------------------------------

test('LOG_LEVEL=debug re-enables debug output on a shipped client', () => {
  // This is the whole reason for choosing a level model over a boolean: a
  // misbehaving client on site can be relaunched with more detail, without a
  // rebuild and without physical access.
  const { emit } = loadLogger({ packaged: true, level: 'debug' });
  assert.deepEqual(emit('debug'), { console: true, file: true });
});

test('debug output reaches the log FILE, not just the console', () => {
  // A packaged Electron client has no console anyone is reading, so
  // console-only debug would make the override useless in the one situation it
  // exists for.
  const { emit } = loadLogger({ packaged: true, level: 'debug' });
  assert.equal(emit('debug').file, true);
  assert.equal(emit('database').file, true);
});

test('LOG_LEVEL can also quieten a client below the default', () => {
  const { emit } = loadLogger({ packaged: true, level: 'warn' });

  for (const Method of CHATTY) {
    assert.deepEqual(emit(Method), { console: false, file: false }, `${Method} survived`);
  }
  for (const Method of LOUD) {
    assert.deepEqual(emit(Method), { console: true, file: true }, `${Method} was lost`);
  }
});

test('LOG_LEVEL=error keeps only what the client cannot recover from', () => {
  const { emit } = loadLogger({ packaged: true, level: 'error' });

  assert.equal(emit('error').file, true);
  assert.equal(emit('databaseError').file, true, 'a DB failure is why the client misbehaves next');
  assert.equal(emit('warn').file, false);
  assert.equal(emit('info').file, false);
});

test('LOG_LEVEL is case-insensitive', () => {
  const { emit } = loadLogger({ packaged: true, level: 'DEBUG' });
  assert.equal(emit('debug').file, true);
});

test('an unrecognised LOG_LEVEL falls back to the default rather than silencing everything', () => {
  // The dangerous failure: a typo in a launch script turning the log off
  // entirely on the machine you were trying to diagnose.
  for (const Level of ['verbose', 'yes', '', '4']) {
    const { emit } = loadLogger({ packaged: true, level: Level });
    assert.equal(emit('error').file, true, `LOG_LEVEL=${JSON.stringify(Level)} silenced errors`);
    assert.equal(emit('info').file, true, `LOG_LEVEL=${JSON.stringify(Level)} silenced info`);
  }
});

// --- silent() ---------------------------------------------------------------

test('silent() is never gated by level', () => {
  // It exists to put something in the file that was never meant for the
  // console; suppressing it by level would lose the record rather than quieten
  // it.
  for (const Level of ['error', 'warn', 'info', 'debug']) {
    const { emit } = loadLogger({ packaged: true, level: Level });
    assert.deepEqual(emit('silent'), { console: false, file: true }, `level ${Level}`);
  }
});

// --- configure() ------------------------------------------------------------

test('configure() changes the level at runtime', () => {
  const { Mod, emit } = loadLogger({ packaged: true });
  assert.equal(emit('debug').file, false);

  Mod.configure({ level: 'debug' });
  assert.equal(emit('debug').file, true);

  Mod.configure({ level: 'error' });
  assert.equal(emit('info').file, false);
});

test('configure() ignores an empty call rather than resetting the level', () => {
  const { Mod, emit } = loadLogger({ packaged: true, level: 'debug' });

  Mod.configure();
  Mod.configure({});
  assert.equal(emit('debug').file, true, 'the active level was clobbered');
});

test('a logger created before configure() still honours the new level', () => {
  // The level lives on the module, not the instance — every module in the app
  // holds a logger it created at import time, so a per-instance level would
  // mean configure() only affected code that ran afterwards.
  const { Mod } = loadLogger({ packaged: true });
  const Early = Mod.CreateLogger('Early');

  const printed = [];
  const OriginalLog = console.log;
  console.log = (...args) => printed.push(args);
  try {
    Early.debug('before');
    assert.equal(printed.length, 0);

    Mod.configure({ level: 'debug' });
    Early.debug('after');
    assert.equal(printed.length, 1);
  } finally {
    console.log = OriginalLog;
  }
});
