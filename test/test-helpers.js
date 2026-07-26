const Module = require('node:module');

// Strip the relative prefix from a require request so a mock matches the module
// it names regardless of where in the tree the requiring file sits.
//
// Mocks are registered with the string main.ts itself used — './Modules/Logger'.
// Once main.ts was decomposed into src/main/*.ts, those files reach the same
// module as '../Modules/Logger', and an exact-string match silently stopped
// intercepting: the real Logger loaded, wrote to the real log directory, and the
// test still passed while no longer testing through its stub. Normalising both
// sides to 'Modules/Logger' keeps a mock pinned to a module identity rather than
// to one caller's relative depth.
//
// Bare specifiers ('electron', 'socket.io-client') have no prefix to strip and
// are unaffected.
function normalizeRequest(request) {
  if (typeof request !== 'string') return request;
  return request.replace(/^(?:\.\.?\/)+/, '');
}

function withMocks(mocks = {}, run) {
  // Precompute the normalised lookup once per withMocks call. Exact matches take
  // precedence so a test can still target one specific spelling if it needs to.
  const normalized = new Map();
  for (const key of Object.keys(mocks)) {
    const normalizedKey = normalizeRequest(key);
    // First registration wins, so an exact key is never shadowed by a later one
    // that happens to normalise to the same thing.
    if (!normalized.has(normalizedKey)) normalized.set(normalizedKey, mocks[key]);
  }

  const originalLoad = Module._load;
  Module._load = function patchedLoader(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    const normalizedRequest = normalizeRequest(request);
    if (normalized.has(normalizedRequest)) {
      return normalized.get(normalizedRequest);
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  const restore = () => {
    Module._load = originalLoad;
  };

  // An ASYNC body has to keep the mocks installed until it settles, not until it
  // returns its promise. Restoring in a plain `finally` unpatched Module._load the
  // moment the async function hit its first await, so any LAZY `require()` later
  // in the body — e.g. app-updater's deliberate `require('electron-updater')`
  // inside ensureAutoUpdater — resolved to the real module and threw.
  let result;
  try {
    result = run();
  } catch (err) {
    restore();
    throw err;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (value) => {
        restore();
        return value;
      },
      (err) => {
        restore();
        throw err;
      }
    );
  }
  restore();
  return result;
}

// Load a module fresh (bypassing require.cache) with `mocks` intercepting its
// dependencies.
//
// Only the entry module is evicted from the cache. That was fine while main.js
// was one file, but a decomposed main.js pulls in src/main/*.js, and those would
// be served from cache on a second load — still holding the PREVIOUS test's
// mocked Logger, window and updater state. `clearCache` evicts the whole
// first-party subtree so each load genuinely re-runs it.
function loadWithMocks(modulePath, mocks = {}, { clearCache = true } = {}) {
  const resolved = require.resolve(modulePath);
  if (clearCache) {
    clearFirstPartyCache(resolved);
  } else {
    delete require.cache[resolved];
  }
  return withMocks(mocks, () => require(modulePath));
}

// Evict `entry` and every already-loaded module under the same build root
// (dist/ or dist-test/), leaving node_modules cached.
function clearFirstPartyCache(entry) {
  const root = findBuildRoot(entry);
  for (const key of Object.keys(require.cache)) {
    if (key.includes('node_modules')) continue;
    if (root && !key.startsWith(root)) continue;
    delete require.cache[key];
  }
  delete require.cache[entry];
}

function findBuildRoot(entry) {
  const match = /^(.*[/\\](?:dist|dist-test))[/\\]/.exec(entry);
  return match ? match[1] : null;
}

// A Logger stub covering the whole logger surface — and anything added to it later.
//
// Stubs were previously written inline as partial object literals, so a module
// that started calling a method the stub omitted failed with
// "Logger.debug is not a function" from inside the code under test. That is a
// test-harness gap masquerading as a product bug, and it is not the stub author's
// job to track the Logger's surface. Unknown properties resolve to a no-op.
//
// Pass `overrides` to capture a level, e.g.
// `createSilentLogger({ error: (...a) => errors.push(a) })`.
function createSilentLogger(overrides = {}) {
  const noop = () => {};
  const base = {
    log: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    success: noop,
    silent: noop,
    database: noop,
    databaseError: noop,
    ...overrides,
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return typeof prop === 'string' ? noop : undefined;
    },
    has() {
      return true;
    },
  });
}

module.exports = {
  withMocks,
  loadWithMocks,
  normalizeRequest,
  createSilentLogger,
};
