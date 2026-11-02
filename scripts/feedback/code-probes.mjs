// Frozen external probes; never supplied as model feedback during execution.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [workspace, original, output] = process.argv.slice(2);
const checks = [];
const check = (id, fn) => { try { fn(); checks.push({id, passed: true}); } catch (error) { checks.push({id, passed: false, detail: String(error.stack ?? error).slice(0, 1800)}); } };
try {
  const source = await readFile(resolve(workspace, 'project/src/index.js'), 'utf8');
  const module = await import(pathToFileURL(resolve(workspace, 'project/src/index.js')));
  const reference = (await import(pathToFileURL(resolve(original, 'src/index.js')))).default;
  const clsx = module.default;
  check('export-compatibility', () => { assert.equal(clsx, module.clsx); assert.deepEqual(Object.keys(module).sort(), ['clsx', 'default']); });
  check('legacy-ordinary-differential', () => {
    const values = ['', 'a b', ' a ', 0, -0, 1, -3, .2, NaN, Infinity, -Infinity, true, false, null, undefined, 1n, Symbol('x'), () => 4,
      {a: 1, b: false, c: []}, ['a', ['', ['z', 3]]], Object.assign(Object.create(null), {key: true})];
    for (const value of values) {
      for (const args of [[value], ['prefix', value, 'tail'], [[value, ['nested', value]]]]) assert.equal(clsx(...args), reference(...args));
    }
  });
  check('inherited-keys-and-getters-are-excluded', () => {
    let reads = 0;
    const proto = {legacyLeak: true};
    Object.defineProperty(proto, 'bad', {enumerable: true, get() { reads++; throw Error('inherited getter'); }});
    const obj = Object.create(proto); obj.keep = 'yes'; obj.skip = 0;
    assert.equal(clsx('start', obj, 'end'), 'start keep end'); assert.equal(reads, 0);
  });
  check('own-enumerability-and-shadowed-names', () => {
    const obj = Object.create(null);
    for (const name of ['hasOwnProperty', 'constructor', '__proto__']) Object.defineProperty(obj, name, {value: 1, enumerable: true});
    Object.defineProperty(obj, 'hidden', {get() {throw Error('hidden read');}});
    obj[Symbol('ignored')] = true;
    assert.equal(clsx(obj), 'hasOwnProperty constructor __proto__');
  });
  check('own-array-indices-including-nonenumerable', () => {
    const proto = Object.create(Array.prototype);
    Object.defineProperty(proto, '1', {get() { throw Error('hole getter'); }});
    const array = new Array(4); Object.setPrototypeOf(array, proto);
    array[0] = 'a'; Object.defineProperty(array, '2', {value: 'b', enumerable: false}); array[3] = {c: true}; array.extra = 'wrong';
    assert.equal(clsx(array), 'a b c');
  });
  check('nested-own-keys-no-mutation-or-dedup', () => {
    const value = Object.freeze(Object.assign(Object.create({bad: true}), {good: 1}));
    const nested = Object.freeze(['a', Object.freeze([value, 'a'])]);
    assert.equal(clsx(nested, nested), 'a good a a good a'); assert.deepEqual(Object.keys(value), ['good']);
  });
  check('original-numeric-key-order', () => {
    const obj = Object.assign(Object.create({inherited: true}), {z: true, 9: true, 2: true, a: true});
    assert.equal(clsx(obj), '2 9 z a');
  });
  check('old-node-standard-library-compatibility', () => { assert(!/\bObject\.hasOwn\s*\(/.test(source)); });
} catch (error) { checks.push({id:'module-load', passed:false, detail:String(error.stack ?? error).slice(0, 1800)}); }
await writeFile(output, JSON.stringify({checks}, null, 2));
