const Module = require('node:module');

function withMocks(mocks = {}, run) {
  const originalLoad = Module._load;
  Module._load = function patchedLoader(request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) {
      return mocks[request];
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return run();
  } finally {
    Module._load = originalLoad;
  }
}

function loadWithMocks(modulePath, mocks = {}) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return withMocks(mocks, () => require(modulePath));
}

module.exports = {
  withMocks,
  loadWithMocks,
};
