const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichBrowserConnectionNames } = require('../../src/app/main/features/ai-chat/connection-names');

test('插件连接显示对应 AI-FREE 浏览器的自定义名称', () => {
  const connections = [
    { id: 'connection-1', browserProcessId: 1201, name: 'AI自动化浏览器' },
    { id: 'connection-2', browserProcessId: 1202, name: '插件自定义名称' },
  ];
  const tabs = new Map([
    ['browser-a', { id: 'browser-a', runtimeType: 'chromium', fixedTitle: '运营账号 A' }],
    ['browser-b', { id: 'browser-b', runtimeType: 'chromium', fixedTitle: '客服账号 B' }],
  ]);
  const states = [
    { profileId: 'browser-a', pid: 1201 },
    { profileId: 'browser-b', pid: 1202 },
  ];

  assert.deepEqual(enrichBrowserConnectionNames(connections, tabs, states), [
    {
      id: 'connection-1',
      browserProcessId: 1201,
      name: '运营账号 A',
      profileId: 'browser-a',
      browserName: '运营账号 A',
      pluginName: 'AI自动化浏览器',
    },
    {
      id: 'connection-2',
      browserProcessId: 1202,
      name: '客服账号 B',
      profileId: 'browser-b',
      browserName: '客服账号 B',
      pluginName: '插件自定义名称',
    },
  ]);
});

test('外部浏览器无法匹配 AI-FREE 实例时保留插件名称', () => {
  const connection = { id: 'external', browserProcessId: 9001, name: '我的 Chrome' };
  assert.deepEqual(enrichBrowserConnectionNames([connection], [], []), [connection]);
});

test('旧 Profile 未上报 PID 时按启动时间匹配教程和一键启动浏览器', () => {
  const connections = [
    { id: 'tutorial-plugin', name: 'AI自动化浏览器', connectedAt: 10_003 },
    { id: 'account-plugin', name: 'AI自动化浏览器', connectedAt: 20_004 },
  ];
  const tabs = new Map([
    ['tutorial', { id: 'tutorial', runtimeType: 'chromium', fixedTitle: '软件教程' }],
    ['account', { id: 'account', runtimeType: 'chromium', fixedTitle: '一键账号-小红书' }],
  ]);
  const states = [
    { profileId: 'tutorial', pid: 3101, startedAt: 10_000 },
    { profileId: 'account', pid: 3102, startedAt: 20_000 },
  ];

  const result = enrichBrowserConnectionNames(connections, tabs, states);
  assert.equal(result[0].name, '软件教程');
  assert.equal(result[1].name, '一键账号-小红书');
});

test('启动时间相距过远的外部插件不会误关联到 AI-FREE 浏览器', () => {
  const connection = { id: 'external', name: '我的 Chrome', connectedAt: 100_000 };
  const tabs = [{ id: 'tutorial', runtimeType: 'chromium', fixedTitle: '软件教程' }];
  const states = [{ profileId: 'tutorial', pid: 3101, startedAt: 10_000 }];
  assert.deepEqual(enrichBrowserConnectionNames([connection], tabs, states), [connection]);
});
