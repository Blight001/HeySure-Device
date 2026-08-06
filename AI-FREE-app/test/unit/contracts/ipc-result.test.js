// 单元测试：contracts/ipc-result.js 统一返回契约。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', '..');
const { AppError, ok, fail, wrapIpcResult } = require(path.join(root, 'src', 'app', 'contracts', 'ipc-result.js'));

test('ok 包装数据', () => {
  assert.deepEqual(ok({ a: 1 }), { ok: true, data: { a: 1 } });
});

test('fail(AppError) 保留 code/retryable/details', () => {
  const err = new AppError('VIP_REQUIRED', '需要会员', { retryable: false, details: { plan: 'free' } });
  assert.deepEqual(fail(err), {
    ok: false,
    error: { code: 'VIP_REQUIRED', message: '需要会员', retryable: false, details: { plan: 'free' } },
  });
});

test('fail(普通 Error) 使用 fallbackCode 且不可重试', () => {
  const result = fail(new Error('boom'), 'NETWORK_ERROR');
  assert.deepEqual(result, { ok: false, error: { code: 'NETWORK_ERROR', message: 'boom', retryable: false } });
});

test('wrapIpcResult：正常返回套 ok，抛错映射 fail', async () => {
  const good = wrapIpcResult(async (x) => x * 2);
  assert.deepEqual(await good(21), { ok: true, data: 42 });

  const bad = wrapIpcResult(async () => { throw new AppError('TIMEOUT', '超时', { retryable: true }); });
  assert.deepEqual(await bad(), { ok: false, error: { code: 'TIMEOUT', message: '超时', retryable: true } });

  const plain = wrapIpcResult(async () => { throw new Error('oops'); }, { fallbackCode: 'IO_ERROR' });
  const result = await plain();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'IO_ERROR');
});
