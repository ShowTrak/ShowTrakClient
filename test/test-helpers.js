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

  try {
    return run();
  } finally {
    Module._load = originalLoad;
  }
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

module.exports = {
  withMocks,
  loadWithMocks,
  normalizeRequest,
};
