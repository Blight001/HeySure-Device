'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readJsonFileSafe,
  readStoreConfigFile,
  writeJsonFileSafe,
  writeStoreConfigFile,
} = require('../../../src/app/main/utils/json-store');

test('JSON store round-trips nested files and applies explicit fallbacks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-json-store-'));
  try {
    const file = path.join(root, 'nested', 'store.json');
    assert.equal(writeJsonFileSafe(file, { value: 1 }), true);
    assert.deepEqual(readJsonFileSafe(file), { value: 1 });
    assert.equal(writeJsonFileSafe(file, null), true);
    assert.deepEqual(readJsonFileSafe(file), {});
    const fallback = [];
    assert.equal(readJsonFileSafe(path.join(root, 'missing.json'), { fallback }), fallback);
    assert.deepEqual(readJsonFileSafe(''), {});
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('malformed reads and failed writes warn with caller prefixes', () => {
  const warnings = [];
  const logger = { warn: (...args) => warnings.push(args) };
  const malformedFs = { existsSync: () => true, readFileSync: () => '{invalid' };
  const fallback = { safe: true };
  assert.equal(readJsonFileSafe('fixture.json', { fs: malformedFs, fallback, logger, logPrefix: 'Fixture', readErrorMessage: 'bad read' }), fallback);
  assert.match(warnings[0][0], /^\[Fixture\] bad read/);
  const throwingFs = { mkdirSync: () => { throw new Error('disk full'); } };
  assert.equal(writeJsonFileSafe('fixture.json', { value: 1 }, {
    fs: throwingFs, path, logger, logPrefix: 'Fixture', writeErrorMessage: 'bad write',
  }), false);
  assert.match(warnings[1][0], /^\[Fixture\] bad write/);
  assert.equal(writeJsonFileSafe('', {}, { logger }), false);
  assert.deepEqual(readJsonFileSafe('fixture.json', { fs: malformedFs, logger: null }), {});
});

test('store wrappers resolve function and string paths and preserve caller options', () => {
  const memory = new Map();
  const fakeFs = {
    existsSync: (file) => memory.has(file),
    readFileSync: (file) => memory.get(file),
    mkdirSync: () => {},
    writeFileSync: (file, value) => memory.set(file, value),
  };
  const fakePath = { dirname: () => 'memory' };
  assert.equal(writeStoreConfigFile(() => 'store-a', { one: 1 }, { fs: fakeFs, path: fakePath }), true);
  assert.deepEqual(readStoreConfigFile(() => 'store-a', { fs: fakeFs }), { one: 1 });
  assert.equal(writeStoreConfigFile('store-b', { two: 2 }, { fs: fakeFs, path: fakePath }), true);
  assert.deepEqual(readStoreConfigFile('store-b', { fs: fakeFs }), { two: 2 });
  const fallback = ['fallback'];
  assert.equal(readStoreConfigFile(null, { fs: fakeFs, fallback }), fallback);
});
