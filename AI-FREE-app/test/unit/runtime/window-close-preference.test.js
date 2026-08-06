'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  readWindowCloseBehavior,
  writeWindowCloseBehavior,
} = require('../../../src/app/main/features/window/window-close-preference');

test('窗口关闭方式兼容缺失和损坏的旧配置', () => {
  assert.equal(readWindowCloseBehavior(() => ({})), 'ask');
  assert.equal(readWindowCloseBehavior(() => ({ windowCloseBehavior: 'unknown' })), 'ask');
  assert.equal(readWindowCloseBehavior(() => { throw new Error('broken'); }), 'ask');
});

test('窗口关闭方式与现有配置合并后持久化', () => {
  let saved = null;
  const result = writeWindowCloseBehavior(
    () => ({ existing: true }),
    (next) => { saved = next; return true; },
    'hide',
  );
  assert.deepEqual(result, { ok: true, data: { behavior: 'hide' } });
  assert.deepEqual(saved, { existing: true, windowCloseBehavior: 'hide' });
});

test('拒绝无效窗口关闭方式且不写配置', () => {
  let writes = 0;
  const result = writeWindowCloseBehavior(
    () => ({}),
    () => { writes += 1; return true; },
    'invalid',
  );
  assert.equal(result.ok, false);
  assert.equal(writes, 0);
});
