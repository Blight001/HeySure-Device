const test = require('node:test');
const assert = require('node:assert/strict');
const { createTabHelpers } = require('../../src/app/main/services/tab-helpers');

function createWindowSink() {
  const messages = [];
  return {
    messages,
    window: {
      isDestroyed: () => false,
      webContents: { send: (channel, payload) => messages.push({ channel, payload }) },
    },
  };
}

test('tab payload reports the applied Chromium snapshot instead of pending settings', () => {
  const tabs = new Map([['browser-1', {
    id: 'browser-1',
    fixedTitle: '测试浏览器',
    runtimeType: 'chromium',
    runtimeStatus: 'ready',
    networkMagicApplied: false,
    browserProfile: {
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      sourceIp: '203.0.113.20',
      regionLabel: '日本',
    },
    browserSettings: {
      os: 'win11',
      language: { mode: 'ip' },
    },
  }]]);
  const appliedProfile = {
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
    proxyServer: '',
    hardwareAcceleration: false,
    extensionCount: 3,
    browserSettings: {
      os: 'win10',
      browserVersion: '140',
      kernelVersion: 'auto',
      cookieCount: 2,
      language: { mode: 'custom', value: 'zh-CN' },
      timezone: { mode: 'custom', value: 'Asia/Shanghai' },
      hardwareAcceleration: false,
    },
    browserEnvironment: {
      browserBrand: 'AI-FREE',
      browserType: 'chrome',
      browserVersion: '140.0.0.0',
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      sourceIp: '198.51.100.10',
      regionLabel: '中国大陆',
    },
  };
  const helpers = createTabHelpers({
    getTabs: () => tabs,
    getActiveTabId: () => 'browser-1',
    browserRuntimeManager: {
      getState: () => ({ bounds: { width: 1280, height: 720 } }),
      chromium: { instances: new Map([['browser-1', { appliedProfile }]]) },
    },
  });

  const [payload] = helpers.buildTabsPayload();
  assert.equal(payload.browserProfile.locale, 'zh-CN');
  assert.equal(payload.browserProfile.timezoneId, 'Asia/Shanghai');
  assert.equal(payload.browserProfile.sourceIp, '198.51.100.10');
  assert.equal(payload.browserSettings.os, 'win10');
  assert.equal(payload.browserSettings.cookieCount, 2);
  assert.equal(payload.browserSettings.language.value, 'zh-CN');
  assert.equal(payload.networkMagicEnabled, false);
  assert.deepEqual(payload.runtimeEnvironment, {
    windowWidth: 1280,
    windowHeight: 720,
    hardwareAcceleration: false,
    extensionCount: 3,
  });
});

test('tab payload exposes network magic only when it is applied to that browser', () => {
  const tab = {
    id: 'browser-2',
    title: '代理浏览器',
    runtimeType: 'chromium',
    runtimeStatus: 'ready',
    networkMagicApplied: true,
    browserProfile: { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
  };
  const helpers = createTabHelpers({
    getTabs: () => new Map([[tab.id, tab]]),
    getActiveTabId: () => tab.id,
    browserRuntimeManager: {
      chromium: {
        instances: new Map([[tab.id, {
          appliedProfile: {
            locale: 'ja-JP',
            timezoneId: 'Asia/Tokyo',
            proxyServer: 'http://127.0.0.1:7890',
            browserEnvironment: tab.browserProfile,
          },
        }]]),
      },
    },
  });

  assert.equal(helpers.buildTabsPayload()[0].networkMagicEnabled, true);
  tab.networkMagicApplied = false;
  assert.equal(helpers.buildTabsPayload()[0].networkMagicEnabled, false);
});

test('update-tabs sends the same applied environment to the shell', () => {
  const sink = createWindowSink();
  const tabs = new Map([['browser-3', {
    id: 'browser-3', fixedTitle: '窗口', runtimeType: 'chromium', runtimeStatus: 'ready',
  }]]);
  const helpers = createTabHelpers({
    getTabs: () => tabs,
    getMainWindow: () => sink.window,
    getActiveTabId: () => 'browser-3',
  });

  helpers.updateTabs(true);
  assert.equal(sink.messages.length, 1);
  assert.equal(sink.messages[0].channel, 'update-tabs');
  assert.equal(sink.messages[0].payload[0].title, '窗口');
});
