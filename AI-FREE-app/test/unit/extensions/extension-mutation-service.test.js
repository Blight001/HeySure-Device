'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createExtensionMutationService } = require('../../../src/app/main/features/extensions/extension-mutation-service');

function createFixture(overrides = {}) {
  const state = { plugins: [
    { id: 'builtin', path: '/builtin', builtin: true, enabled: true },
    { id: 'local', path: '/local', builtin: false, enabled: false },
    { id: 'missing', path: '/missing', builtin: false, enabled: false, missing: true },
  ] };
  const calls = [];
  const warnings = [];
  const deps = {
    buildPluginRecord: (pluginPath, existing, options) => ({ ...existing, ...options, path: pluginPath, name: 'Imported' }),
    emitStateChanged: () => calls.push('emit'),
    getPluginById: (id) => state.plugins.find((plugin) => plugin.id === id),
    getPublicState: () => ({ plugins: state.plugins.map((plugin) => ({ ...plugin })) }),
    getState: () => state,
    hashId: () => 'hash',
    loadPluginIntoAllCurrentSessions: async (plugin) => calls.push(`load:${plugin.id}`),
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
    normalizeAbsolutePath: (value) => String(value || '').trim(),
    onPluginStateChanged: async (change) => ({ ok: true, change }),
    persistState: () => calls.push('persist'),
    readManifest: (pluginPath) => { if (pluginPath === '/invalid') throw new Error('bad manifest'); },
    syncLegacyTranslateSetting: () => calls.push('legacy'),
    toPublicPlugin: (plugin) => ({ id: plugin.id, enabled: plugin.enabled }),
    unloadPluginFromAllSessions: async (plugin) => calls.push(`unload:${plugin.id}`),
    ...overrides,
  };
  return { calls, service: createExtensionMutationService(deps), state, warnings };
}

test('enable and disable validate plugin state and refresh sessions', async () => {
  const fixture = createFixture();
  assert.equal((await fixture.service.setPluginEnabled('unknown', true)).message, '插件不存在');
  assert.equal((await fixture.service.setPluginEnabled('missing', true)).message, '插件目录不存在，请重新导入');
  const enabled = await fixture.service.setPluginEnabled('local', true);
  assert.equal(enabled.ok, true);
  assert.equal(enabled.plugin.enabled, true);
  assert.deepEqual(fixture.calls.slice(0, 4), ['persist', 'load:local', 'legacy', 'emit']);
  const disabled = await fixture.service.setPluginEnabled('local', false);
  assert.equal(disabled.ok, true);
  assert.equal(fixture.service.isPluginEnabled('local'), false);
  assert.ok(fixture.calls.includes('unload:local'));
});

test('refresh failures do not roll back persisted enable state', async () => {
  const fixture = createFixture({ onPluginStateChanged: async () => { throw new Error('refresh failed'); } });
  const result = await fixture.service.setPluginEnabled('local', true);
  assert.equal(result.ok, true);
  assert.deepEqual(result.browserRefresh, { ok: false, message: 'refresh failed' });
  assert.match(fixture.warnings[0], /浏览器刷新失败/);
});

test('import validates paths, replaces existing records and reports refresh failures', async () => {
  const fixture = createFixture({ onPluginStateChanged: async () => { throw new Error('restart failed'); } });
  assert.equal((await fixture.service.importPlugin('')).message, '未选择插件目录');
  assert.equal((await fixture.service.importPlugin('/builtin')).message, '该目录是内置插件，无需重复导入');
  assert.equal((await fixture.service.importPlugin('/invalid')).message, 'bad manifest');
  fixture.state.plugins.find((plugin) => plugin.id === 'local').enabled = true;
  const imported = await fixture.service.importPlugin('/local');
  assert.equal(imported.ok, true);
  assert.equal(imported.plugin.id, 'local');
  assert.deepEqual(imported.browserRefresh, { ok: false, message: 'restart failed' });
  assert.ok(fixture.calls.includes('unload:local'));
  assert.ok(fixture.calls.includes('load:local'));
  const fresh = await fixture.service.importPlugin('/new');
  assert.equal(fresh.plugin.id, 'local-hash');
});

test('remove protects builtins, unloads local plugins and tolerates refresh errors', async () => {
  const fixture = createFixture({ onPluginStateChanged: async () => { throw new Error('refresh failed'); } });
  assert.equal((await fixture.service.removePlugin('unknown')).message, '插件不存在');
  assert.equal((await fixture.service.removePlugin('builtin')).message, '内置插件不能删除，可以关闭开关禁用');
  const removed = await fixture.service.removePlugin('local');
  assert.equal(removed.ok, true);
  assert.equal(fixture.state.plugins.some((plugin) => plugin.id === 'local'), false);
  assert.ok(fixture.calls.includes('unload:local'));
  assert.match(fixture.warnings[0], /插件已删除/);
});
