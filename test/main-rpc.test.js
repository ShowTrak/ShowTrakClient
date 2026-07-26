// src/main/rpc.ts
//
// The IPC handler wrapper. Its whole job is that a rejected or failing request
// comes back as a Go-style [error, value] tuple instead of throwing across the
// contextBridge — a throw there surfaces in the renderer as an opaque
// "Error invoking remote method", which is how a validation message stops
// reaching the operator.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks } = require('./test-helpers');

const MODULE_PATH = path.join(__dirname, '..', 'dist', 'main', 'rpc.js');

function loadRpc({ errors = [] } = {}) {
  const handlers = new Map();
  const mod = loadWithMocks(MODULE_PATH, {
    electron: {
      ipcMain: {
        handle: (channel, fn) => handlers.set(channel, fn),
      },
    },
    '../Modules/Logger': {
      CreateLogger: () => ({
        log: () => {},
        info: () => {},
        warn: () => {},
        debug: () => {},
        success: () => {},
        silent: () => {},
        error: (...args) => errors.push(args),
      }),
    },
  });
  // Invoke a registered channel the way ipcMain would (event first, then args).
  const invoke = (channel, ...args) => handlers.get(channel)(null, ...args);
  return { ...mod, handlers, invoke };
}

test('assertNoArgs accepts an empty payload and rejects anything else', () => {
  const { assertNoArgs } = loadRpc();
  assert.doesNotThrow(() => assertNoArgs('Loaded', []));
  assert.throws(() => assertNoArgs('Loaded', [1]), /Loaded does not accept arguments/);
  assert.throws(() => assertNoArgs('Loaded', [undefined]), /does not accept arguments/);
  assert.throws(() => assertNoArgs('Loaded', [null, null]), /does not accept arguments/);
});

test('validationErrorPayload always yields a [message, null] tuple', () => {
  const { validationErrorPayload } = loadRpc();
  assert.deepEqual(validationErrorPayload(new Error('nope')), ['nope', null]);
  assert.deepEqual(validationErrorPayload({ message: 'objecty' }), ['objecty', null]);
  assert.deepEqual(validationErrorPayload('bare string'), ['bare string', null]);
  // Falsy inputs must still produce a usable message rather than "null".
  assert.deepEqual(validationErrorPayload(null), ['Invalid request', null]);
  assert.deepEqual(validationErrorPayload(undefined), ['Invalid request', null]);
  assert.deepEqual(validationErrorPayload(''), ['Invalid request', null]);
});

test('a resolving handler passes its value through untouched', async () => {
  const { Handle, invoke } = loadRpc();
  Handle('Tuple', () => [null, { ok: true }]);
  assert.deepEqual(await invoke('Tuple'), [null, { ok: true }]);
});

test('a bare non-tuple return is preserved (GetVersion depends on this)', async () => {
  // GetVersion answers with a plain string, not a tuple. The wrapper must not
  // helpfully wrap it — the preload reads it as `string`.
  const { Handle, invoke } = loadRpc();
  Handle('GetVersion', () => '3.14.0');
  assert.equal(await invoke('GetVersion'), '3.14.0');
});

test('an async handler is awaited', async () => {
  const { Handle, invoke } = loadRpc();
  Handle('Async', async () => {
    await new Promise((resolve) => setImmediate(resolve));
    return [null, 'done'];
  });
  assert.deepEqual(await invoke('Async'), [null, 'done']);
});

test('a synchronous throw becomes an error tuple, not a rejection', async () => {
  const { Handle, invoke } = loadRpc();
  Handle('Throws', () => {
    throw new Error('bad input');
  });
  assert.deepEqual(await invoke('Throws'), ['bad input', null]);
});

test('an async rejection becomes an error tuple, not a rejection', async () => {
  const { Handle, invoke } = loadRpc();
  Handle('Rejects', async () => {
    throw new Error('disk gone');
  });
  assert.deepEqual(await invoke('Rejects'), ['disk gone', null]);
});

test('the handler receives the raw args array', async () => {
  const { Handle, invoke } = loadRpc();
  let seen = null;
  Handle('Args', (args) => {
    seen = args;
    return [null, true];
  });
  await invoke('Args', '10.0.0.5', 3000);
  assert.deepEqual(seen, ['10.0.0.5', 3000]);
});

test('errorLog logs on failure only, and never on success', async () => {
  const errors = [];
  const { Handle, invoke } = loadRpc({ errors });

  Handle(
    'Logged',
    (args) => {
      if (args[0] === 'boom') throw new Error('it broke');
      return [null, true];
    },
    { errorLog: 'Logged channel failed' }
  );

  await invoke('Logged', 'fine');
  assert.deepEqual(errors, [], 'a successful call must not log an error');

  await invoke('Logged', 'boom');
  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], 'Logged channel failed');
});

test('without errorLog a failure is still tupled but not logged', async () => {
  const errors = [];
  const { Handle, invoke } = loadRpc({ errors });
  Handle('Quiet', () => {
    throw new Error('quietly bad');
  });
  assert.deepEqual(await invoke('Quiet'), ['quietly bad', null]);
  assert.deepEqual(errors, []);
});

test('assertNoArgs inside a handler surfaces as an error tuple', async () => {
  // The composition the real handlers use.
  const { Handle, assertNoArgs, invoke } = loadRpc();
  Handle('Strict', (args) => {
    assertNoArgs('Strict', args);
    return [null, true];
  });

  assert.deepEqual(await invoke('Strict'), [null, true]);
  assert.deepEqual(await invoke('Strict', 'unexpected'), [
    'Strict does not accept arguments',
    null,
  ]);
});
