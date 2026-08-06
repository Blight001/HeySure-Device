'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAccountService } = require('../../../src/app/main/features/account/account-service');

function successfulContext(overrides = {}) {
  const stored = [];
  const events = [];
  return {
    stored,
    events,
    context: {
      authenticateAccount: async () => ({
        ok: true,
        session_token: 'afs_internal-session',
        account: { username: 'alice' },
        validation: {},
        serverBase: 'https://account.example',
        platformName: 'default',
      }),
      computeDeviceId: async () => 'trusted-machine-id',
      readStoreConfigSafe: () => stored.at(-1) || {},
      writeStoreConfigSafe: (value) => { stored.push(value); return true; },
      licenseCache: {
        setCredentials() {},
        setValidationState(value) { this.validation = value; },
        getValidationState() { return this.validation; },
        setRuntimeConfig() {},
      },
      getGlobalHttpClient: () => ({ runtimeServerBase: '' }),
      applyResolvedConfigToStore() {},
      sendToSide: (channel, payload) => events.push({ channel, payload }),
      ...overrides,
    },
  };
}

test('认证只提交主进程计算的设备号并忽略渲染层伪造值', async () => {
  const calls = [];
  const fixture = successfulContext({
    authenticateAccount: async (input) => {
      calls.push(input);
      return {
        ok: true,
        session_token: 'afs_internal-session',
        account: { username: 'alice' },
        validation: {},
        serverBase: 'https://account.example',
      };
    },
  });
  const service = createAccountService(fixture.context);
  const result = await service.authenticate({ username: 'alice', password: 'pw', deviceId: 'spoofed' });

  assert.equal(result.ok, true);
  assert.equal(calls[0].device_id, 'trusted-machine-id');
  assert.equal(Object.prototype.hasOwnProperty.call(calls[0], 'deviceId'), false);
});

test('登录持久化和服务器地址就绪后立即刷新公告，再异步刷新平台', async () => {
  const order = [];
  const fixture = successfulContext({
    applyResolvedConfigToStore: () => order.push('server-ready'),
    refreshAnnouncements: () => order.push('announcements'),
    refreshAllowedPlatformsAndNotify: () => order.push('platforms'),
  });
  const result = await createAccountService(fixture.context).authenticate({ username: 'alice', password: 'pw' });

  assert.equal(result.ok, true);
  assert.deepEqual(order.slice(0, 2), ['server-ready', 'announcements']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['server-ready', 'announcements', 'platforms']);
  assert.equal(fixture.events.some((event) => event.channel === 'account-session-updated'), true);
});

test('退出登录清除凭据和运行时状态，但不关闭 Chromium', async () => {
  const calls = [];
  const fixture = successfulContext({
    stopProxy: async () => calls.push('stop-proxy'),
  });
  fixture.stored.push({ userCredentials: { key: 'key' }, keep: true });
  const result = await createAccountService(fixture.context).logout();

  assert.deepEqual(result, { ok: true, message: '已退出账号' });
  assert.deepEqual(calls, ['stop-proxy']);
  assert.equal(fixture.stored.at(-1).userCredentials, undefined);
  assert.equal(fixture.stored.at(-1).keep, true);
});

test('认证输入、设备号和失败响应在持久化前被完整校验', async () => {
  assert.deepEqual(await createAccountService({}).authenticate({}), { ok: false, message: '账号服务未就绪' });
  const fixture = successfulContext();
  const service = createAccountService(fixture.context);
  assert.deepEqual(await service.authenticate({ username: '', password: '' }), { ok: false, message: '请输入用户名和密码' });
  fixture.context.computeDeviceId = async () => '获取失败';
  assert.deepEqual(await service.authenticate({ username: 'a', password: 'b' }), { ok: false, message: '无法读取本机设备号，请重启软件后重试' });
  fixture.context.computeDeviceId = async () => 'device';
  fixture.context.authenticateAccount = async () => null;
  assert.deepEqual(await service.authenticate({ username: 'a', password: 'b' }), { ok: false, message: '账号验证失败', error: undefined });
  fixture.context.authenticateAccount = async () => ({ ok: false, error: 'denied' });
  assert.deepEqual(await service.authenticate({ username: 'a', password: 'b' }), { ok: false, message: '账号验证失败', error: 'denied' });
});

test('认证拒绝缺少账号、账号会话和与运行模式不匹配的服务器', async () => {
  const fixture = successfulContext();
  const service = createAccountService(fixture.context);
  fixture.context.authenticateAccount = async () => ({ ok: true, session_token: 'afs_test', account: {}, validation: {}, serverBase: 'https://account.example' });
  assert.equal((await service.authenticate({ username: '', password: '', mode: 'device' })).message, '登录响应缺少账号信息');
  fixture.context.authenticateAccount = async () => ({ ok: true, account: { username: 'alice' }, validation: {}, serverBase: 'https://account.example' });
  assert.equal((await service.authenticate({ username: 'alice', password: 'pw' })).message, '登录响应缺少账号会话');
  fixture.context.authenticateAccount = async () => ({ ok: true, session_token: 'afs_test', account: { username: 'alice' }, validation: {}, serverBase: 'http://127.0.0.1:3000' });
  assert.match((await service.authenticate({ username: 'alice', password: 'pw' })).message, /模式不匹配/);
});

test('注册和设备登录返回对应消息并兼容响应字段别名', async () => {
  const fixture = successfulContext({
    authenticateAccount: async ({ mode }) => ({
      ok: true,
      session_token: 'afs_test',
      account: { username: mode === 'device' ? 'device-user' : 'register-user' },
      validation: { addressHttp: 'https://account.example', platformName: 'fixture' },
    }),
  });
  const service = createAccountService(fixture.context);
  assert.equal((await service.authenticate({ username: 'new', password: 'pw', mode: 'register' })).message, '注册成功');
  assert.equal((await service.authenticate({ mode: 'device' })).message, '设备号登录成功');
});

test('公告、平台刷新与退出代理失败只记录警告', async () => {
  const warnings = [];
  const fixture = successfulContext({
    refreshAnnouncements: () => { throw new Error('announcement failed'); },
    refreshAllowedPlatformsAndNotify: async () => { throw new Error('platform failed'); },
    stopProxy: async () => { throw new Error('proxy failed'); },
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  assert.equal((await createAccountService(fixture.context).authenticate({ username: 'a', password: 'b' })).ok, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await createAccountService(fixture.context).logout()).ok, true);
  assert.equal(warnings.length, 3);
});

test('session view only authenticates records matching current server mode', () => {
  const fixture = successfulContext();
  fixture.stored.push({ userCredentials: {
    authType: 'account', authenticated: true, username: 'alice', sessionToken: 'afs_test', deviceId: 'device',
    serverMode: 'remote', serverBase: 'https://account.example', platformName: 'fixture', account: {}, validation: {},
  } });
  const session = createAccountService(fixture.context).getSession();
  assert.equal(session.ok, true);
  assert.equal(session.username, 'alice');
  assert.equal(session.authenticated, true);
  fixture.stored.push({ userCredentials: { ...fixture.stored.at(-1).userCredentials, serverBase: 'http://127.0.0.1:3000' } });
  assert.equal(createAccountService(fixture.context).getSession().authenticated, false);
});
