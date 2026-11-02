import { test } from 'node:test';
import assert from 'node:assert/strict';
import fn, { clsx } from '../project/src/index.js';

test('exports and ordinary legacy values retain their behavior', () => {
  assert.equal(fn, clsx);
  assert.equal(fn('a', false, 0, NaN, null, undefined, true, 1, Infinity, ['b', ['', ['c']]], 1n, () => 'bad'), 'a 1 Infinity b c');
  assert.equal(fn({ a: 1, b: 0, c: [] }, 'a'), 'a c a');
});
test('dictionaries include own enumerable string keys only', () => {
  const proto = { inherited: true };
  Object.defineProperty(proto, 'neverRead', { enumerable: true, get() { throw new Error('inherited getter read'); } });
  const value = Object.create(proto);
  value.own = 1;
  Object.defineProperty(value, 'hidden', { value: true });
  value[Symbol('ignored')] = true;
  assert.equal(fn(value), 'own');
});
test('shadowed builtins and null prototypes are ordinary dictionary keys', () => {
  const value = Object.create(null);
  value.hasOwnProperty = true; value.constructor = 1;
  Object.defineProperty(value, '__proto__', { enumerable: true, value: 'truthy' });
  assert.equal(fn(value), 'hasOwnProperty constructor __proto__');
});
test('sparse arrays skip inherited numeric indices and extra named properties', () => {
  const array = new Array(3);
  const proto = Object.create(Array.prototype);
  Object.defineProperty(proto, '1', { get() { throw new Error('inherited array hole read'); } });
  Object.setPrototypeOf(array, proto);
  array[0] = 'a'; array[2] = { b: true }; array.extra = 'ignored';
  assert.equal(fn(array), 'a b');
});
test('deep frozen nested inputs are unchanged and work recursively', () => {
  const value = Object.freeze(['a', Object.freeze([Object.freeze({ b: true, c: false }), 'd'])]);
  assert.equal(fn(value), 'a b d');
  assert.equal(value[1][1], 'd');
});
