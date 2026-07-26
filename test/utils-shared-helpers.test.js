// src/Modules/Utils — ReadIdentityToken and ErrorMessage.
//
// Both replaced a hand-written ladder that appeared in six modules. ReadIdentityToken
// in particular now backs the server-identity check, which is what stops a
// recovering client re-homing onto another operator's server on a shared LAN, so
// its treatment of "absent" vs "blank" vs "present" is load-bearing rather than
// cosmetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { ReadIdentityToken, ErrorMessage } = require(
  path.join(__dirname, '..', 'dist', 'Modules', 'Utils', 'index.js')
);

test('ReadIdentityToken returns the trimmed token when present', () => {
  assert.equal(ReadIdentityToken({ ServerIdentity: 'srv-abc' }), 'srv-abc');
  assert.equal(ReadIdentityToken({ ServerIdentity: '  srv-abc  ' }), 'srv-abc');
  assert.equal(ReadIdentityToken({ ServerIdentity: '\tsrv-abc\n' }), 'srv-abc');
});

test('ReadIdentityToken yields empty string for every flavour of absent', () => {
  // '' is the "unconstrained" sentinel every call site compares against, so all
  // of these must collapse to exactly that rather than to undefined or 'null'.
  assert.equal(ReadIdentityToken(null), '');
  assert.equal(ReadIdentityToken(undefined), '');
  assert.equal(ReadIdentityToken({}), '');
  assert.equal(ReadIdentityToken({ ServerIdentity: undefined }), '');
  assert.equal(ReadIdentityToken({ ServerIdentity: null }), '');
  assert.equal(ReadIdentityToken({ ServerIdentity: '' }), '');
  assert.equal(ReadIdentityToken({ ServerIdentity: '   ' }), '', 'whitespace is not an identity');
});

test('ReadIdentityToken refuses non-string values rather than coercing them', () => {
  // A number or object here would previously have been String()-ed somewhere
  // downstream and compared as e.g. '[object Object]'.
  assert.equal(ReadIdentityToken({ ServerIdentity: 42 }), '');
  assert.equal(ReadIdentityToken({ ServerIdentity: true }), '');
  assert.equal(ReadIdentityToken({ ServerIdentity: {} }), '');
  assert.equal(ReadIdentityToken({ ServerIdentity: ['a'] }), '');
});

test('ReadIdentityToken tolerates non-object sources', () => {
  assert.equal(ReadIdentityToken('srv-abc'), '', 'a bare string is not an identity carrier');
  assert.equal(ReadIdentityToken(0), '');
  assert.equal(ReadIdentityToken(false), '');
});

test('ReadIdentityToken can read an alternate key', () => {
  // discovery.ts uses this for the ExpectedServerIdentity option.
  assert.equal(
    ReadIdentityToken({ ExpectedServerIdentity: ' srv-x ' }, 'ExpectedServerIdentity'),
    'srv-x'
  );
  assert.equal(ReadIdentityToken({ ServerIdentity: 'srv-x' }, 'ExpectedServerIdentity'), '');
});

test('the `|| null` idiom converts cleanly for call sites that need null', () => {
  // AdoptionClient, ProfileManager and MainClient's Unadopt need null, not ''.
  assert.equal(ReadIdentityToken({ ServerIdentity: 'srv-a' }) || null, 'srv-a');
  assert.equal(ReadIdentityToken({}) || null, null);
  assert.equal(ReadIdentityToken({ ServerIdentity: '  ' }) || null, null);
});

test('ErrorMessage prefers .message', () => {
  assert.equal(ErrorMessage(new Error('socket closed')), 'socket closed');
  assert.equal(ErrorMessage({ message: 'plain object' }), 'plain object');
  assert.equal(ErrorMessage(new TypeError('wrong type')), 'wrong type');
});

test('ErrorMessage falls back to the stringified value before the fallback', () => {
  // Several modules here reject with a bare string; reporting the generic
  // fallback instead would discard the only diagnostic the operator gets.
  assert.equal(ErrorMessage('bare string failure'), 'bare string failure');
  assert.equal(ErrorMessage(404), '404');
});

test('ErrorMessage uses the fallback only for genuinely empty values', () => {
  assert.equal(ErrorMessage(null, 'unknown_error'), 'unknown_error');
  assert.equal(ErrorMessage(undefined, 'unknown_error'), 'unknown_error');
  assert.equal(ErrorMessage('', 'unknown_error'), 'unknown_error');
  assert.equal(ErrorMessage(0, 'unknown_error'), 'unknown_error');
  // An error whose message is empty has nothing to report: String()-ing it would
  // yield the useless literal 'Error'.
  assert.equal(ErrorMessage(new Error(''), 'unknown_error'), 'unknown_error');
  // Likewise a plain object, whose String() form is '[object Object]'.
  assert.equal(ErrorMessage({}, 'unknown_error'), 'unknown_error');
  assert.equal(ErrorMessage([], 'unknown_error'), 'unknown_error');
});

test('ErrorMessage has a usable default fallback', () => {
  assert.equal(ErrorMessage(null), 'Unknown error');
});

test('ErrorMessage never returns a non-string', () => {
  for (const input of [null, undefined, 0, '', {}, [], new Error('x'), 'y', 42, false]) {
    assert.equal(typeof ErrorMessage(input), 'string', `expected a string for ${String(input)}`);
  }
});
