const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { loadWithMocks, createSilentLogger } = require('./test-helpers');

// Exercises the shared network-error classifier and src/Modules/ProcessGuards.
//
// The classifier now lives in the shared submodule (@showtrak/protocol/runtime)
// rather than in each app: it was duplicated in the Server and the Client, and
// the copies drifted. It is required here by package name, which also proves the
// `file:./shared` symlink and the package's exports map resolve from a test
// process.
//
// Both were added on 2026-07-25 during the TypeScript migration and were, until
// now, verified only by live reproduction (unplugging Ethernet, piping stdout to
// `head`) — the classifier itself had 0% function coverage.
//
// What they protect: the agent runs unattended on machines nobody is watching.
// A NIC flap makes the mDNS browser throw `send EADDRNOTAVAIL 224.0.0.251:5353`
// from inside libuv, where no try/catch of ours can reach it. The guard
// downgrades that class of fault to a warning and deliberately does NOT exit —
// a degraded agent can still be reached and re-adopted, a dead one needs a
// physical visit.
//
// So the classifier has two failure directions and both are bad:
//   - too narrow -> a routine NIC flap kills the agent;
//   - too wide  -> a real bug is silently swallowed as "transient".

const PROCESS_GUARDS_PATH = path.join(
  __dirname,
  '..',
  'dist',
  'Modules',
  'ProcessGuards',
  'index.js'
);

const NetworkErrors = require('@showtrak/protocol/runtime');
const { IsTransientNetworkError, DescribeError, TRANSIENT_NETWORK_ERROR_CODES } = NetworkErrors;

/** A Node-style system error. */
function sysError(code, message = `send ${code} 224.0.0.251:5353`) {
  return Object.assign(new Error(message), { code });
}

// --- IsTransientNetworkError: the transient side ---------------------------

test('every code in the table is classified as transient', () => {
  // The table IS the contract; if an entry stops matching, the condition it
  // covers starts killing the agent again.
  for (const Code of TRANSIENT_NETWORK_ERROR_CODES) {
    assert.equal(IsTransientNetworkError(sysError(Code)), true, `${Code} not classified`);
  }
});

test('the table covers the conditions the guard exists for', () => {
  // Pinned explicitly so a well-meaning trim of the list fails here rather than
  // in the field. EADDRNOTAVAIL is the canonical mDNS-on-NIC-loss symptom;
  // EPIPE is a closed stdout when the agent is launched detached.
  for (const Code of [
    'EADDRNOTAVAIL',
    'ENETUNREACH',
    'ENETDOWN',
    'ENETRESET',
    'EHOSTUNREACH',
    'EHOSTDOWN',
    'ENODEV',
    'EPIPE',
    'ECONNRESET',
    'ECONNREFUSED',
    'ERR_SOCKET_DGRAM_NOT_RUNNING',
    'ERR_SOCKET_CANNOT_SEND',
  ]) {
    assert.ok(TRANSIENT_NETWORK_ERROR_CODES.has(Code), `${Code} missing from the table`);
  }
});

test('a wrapped error with no code is classified from its message', () => {
  // Some libraries re-throw and keep only the text, so the message scan is the
  // fallback that keeps those recognisable.
  assert.equal(IsTransientNetworkError(new Error('send EADDRNOTAVAIL 224.0.0.251:5353')), true);
  assert.equal(IsTransientNetworkError(new Error('read ECONNRESET')), true);
});

test('a bare string error is classified from its text', () => {
  assert.equal(IsTransientNetworkError('send EADDRNOTAVAIL 224.0.0.251:5353'), true);
  assert.equal(IsTransientNetworkError('write EPIPE'), true);
});

test('the code property wins over the message', () => {
  // A transient-looking message on a genuinely different error must not be
  // reclassified by the text scan.
  assert.equal(IsTransientNetworkError(sysError('EACCES', 'send EADDRNOTAVAIL ...')), false);
});

// --- IsTransientNetworkError: the fatal side -------------------------------

test('a programming error is NOT classified as transient', () => {
  // The direction that matters most: swallowing these would hide real bugs in
  // an agent nobody is watching.
  assert.equal(IsTransientNetworkError(new TypeError('x is not a function')), false);
  assert.equal(IsTransientNetworkError(new RangeError('out of range')), false);
  assert.equal(IsTransientNetworkError(new Error('Cannot read properties of undefined')), false);
});

test('unrelated system errors are NOT classified as transient', () => {
  for (const Code of ['EACCES', 'ENOENT', 'EADDRINUSE', 'EMFILE', 'ENOSPC', 'EPERM']) {
    assert.equal(IsTransientNetworkError(sysError(Code)), false, `${Code} wrongly swallowed`);
  }
});

test('EADDRINUSE specifically stays fatal', () => {
  // Easy to lump in with the address-family codes, but it means "something else
  // already holds this port" — a real misconfiguration the operator must see.
  assert.equal(IsTransientNetworkError(sysError('EADDRINUSE')), false);
});

test('empty and non-error values are not transient', () => {
  for (const Value of [null, undefined, 0, '', false, {}, [], 42, new Error('')]) {
    assert.equal(
      IsTransientNetworkError(Value),
      false,
      `${JSON.stringify(Value)} wrongly classified`
    );
  }
});

test('a non-string code is ignored rather than trusted', () => {
  assert.equal(IsTransientNetworkError({ code: 123 }), false);
  assert.equal(IsTransientNetworkError({ code: null }), false);
  // ...but the message fallback still applies.
  assert.equal(IsTransientNetworkError({ code: 123, message: 'send ENETDOWN' }), true);
});

// --- DescribeError ----------------------------------------------------------

test('DescribeError prefers a non-empty message', () => {
  assert.equal(DescribeError(new Error('boom')), 'boom');
  assert.equal(DescribeError({ message: 'plain object' }), 'plain object');
});

test('DescribeError falls back to String() for anything else', () => {
  assert.equal(DescribeError('a thrown string'), 'a thrown string');
  assert.equal(DescribeError(null), 'null');
  assert.equal(DescribeError(undefined), 'undefined');
  assert.equal(DescribeError(404), '404');
  assert.equal(DescribeError({ message: '' }), '[object Object]');
  assert.equal(DescribeError({ message: 42 }), '[object Object]');
});

// --- ProcessGuards ----------------------------------------------------------
//
// The guards themselves are shared (@showtrak/protocol/runtime
// InstallProcessGuards) and specified in the protocol repo
// (spec/runtime/process-guards.spec.js): one handler per fault channel, once per
// process, a NIC flap warned about and survived, a genuine bug logged at error
// level with the agent kept alive. What is the Client's is the wiring.

test('installProcessGuards installs the shared guards, logging as ProcessGuard', () => {
  const Aliases = [];
  const Installed = [];
  const Logger = createSilentLogger();
  const { installProcessGuards } = loadWithMocks(PROCESS_GUARDS_PATH, {
    '../Logger': {
      CreateLogger: (Alias) => {
        Aliases.push(Alias);
        return Logger;
      },
    },
    '@showtrak/protocol/runtime': { InstallProcessGuards: (L) => Installed.push(L) },
  });

  installProcessGuards();
  assert.deepEqual(Aliases, ['ProcessGuard']);
  assert.equal(Installed.length, 1);
  assert.equal(Installed[0], Logger);
});

test('a throwing property getter on the error DOES escape the classifier, and so the guard', () => {
  // Documented, not endorsed. The classifier reads `.code` off the thrown value;
  // a getter that throws propagates out of it, and so out of the
  // uncaughtException handler that calls it first, which is the one place a
  // throw is genuinely unrecoverable.
  //
  // Left as-is because it is not reachable in practice: Node's system errors and
  // every library in the dependency tree use plain data properties, so producing
  // this requires deliberately constructing a hostile object. Wrapping
  // ExtractCode in a try/catch would close it for one line of code, but that is
  // Tom's call.
  const Hostile = {
    get code() {
      throw new Error('hostile getter');
    },
  };
  assert.throws(() => IsTransientNetworkError(Hostile), /hostile getter/);
});
