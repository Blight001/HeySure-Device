const test = require('node:test');
const assert = require('node:assert/strict');
const { getHardwareFingerprint } = require('../../src/app/main/utils/hardware-js');

test('账号认证使用原始系统 machine-id 生成稳定 SHA-256 设备号', async () => {
  const calls = [];
  const fingerprint = await getHardwareFingerprint({
    machineIdSync: (options) => { calls.push(options); return 'system-machine-id'; },
    machineId: async () => { throw new Error('同步读取成功后不应调用异步回退'); },
  });
  assert.deepEqual(calls, [{ original: true }]);
  assert.equal(fingerprint, '544651bc5b2ab50ad1f70d02ab06380e4b3a140c775cdb2afc7e7448dc4fbcdc');
});
