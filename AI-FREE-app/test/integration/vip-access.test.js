'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createTabManager } = require('../../src/app/main/services/tab-manager');
const {
  FREE_BROWSER_WINDOW_LIMIT,
  clearVipServerVerification,
  markVipServerVerified,
  resolveVipAccess,
} = require('../../src/app/main/utils/vip-access');

test('VIP 状态支持永久、有效期和过期判断', () => {
  const now = Date.parse('2026-01-01T00:00:00');
  const verified = (value) => markVipServerVerified(value, now);
  assert.equal(resolveVipAccess({ account: verified({ is_vip: 1, vip_expiry_date: null }) }, now).isVip, true);
  assert.equal(resolveVipAccess({ validation: verified({ is_vip: true, vip_expiry_date: '2026-02-01 00:00:00' }) }, now).isVip, true);
  assert.equal(resolveVipAccess({ validation: verified({ is_vip: true, vip_expiry_date: '2025-12-01 00:00:00' }) }, now).isVip, false);
  assert.equal(resolveVipAccess({ account: verified({ is_vip: true }), validation: { is_vip: false } }, now).isVip, false);
});

test('手工篡改本地 VIP 字段不能形成服务端验证状态', () => {
  const now = Date.parse('2026-01-01T00:00:00');
  const forged = {
    account: { is_vip: true, vip_expiry_date: null },
    validation: { is_vip: true, vip_active: true },
  };
  assert.equal(resolveVipAccess(forged, now).isVip, false);
  const stale = markVipServerVerified({ is_vip: true }, now - (11 * 60 * 1000));
  assert.equal(resolveVipAccess(stale, now).isVip, false);
  const previouslyVerified = {
    result: markVipServerVerified({ is_vip: true }, now),
    is_vip: true,
  };
  assert.equal(resolveVipAccess(clearVipServerVerification(previouslyVerified), now).isVip, false);
});

test('普通用户打开第六个独立浏览器时由主进程拦截', async () => {
  const tabs = new Map();
  for (let index = 0; index < FREE_BROWSER_WINDOW_LIMIT; index += 1) {
    tabs.set(`browser-${index}`, { id: `browser-${index}`, runtimeType: 'chromium' });
  }
  const events = [];
  const manager = createTabManager({
    browserRuntimeManager: { chromium: new EventEmitter() },
    getTabs: () => tabs,
    getMainWindow: () => ({ isDestroyed: () => false }),
    getActiveTabId: () => 'browser-0',
    getIsSidebarVisible: () => true,
    licenseCache: { getSnapshot: () => ({ result: { is_vip: false } }) },
    updateTabs() {},
    sendToSide(channel, payload) { events.push({ channel, payload }); },
  });

  await assert.rejects(
    manager.addTab('chrome://newtab/', { tabId: 'browser-6' }),
    (error) => error?.code === 'VIP_BROWSER_WINDOW_LIMIT',
  );
  assert.equal(tabs.size, FREE_BROWSER_WINDOW_LIMIT);
  assert.equal(events.at(-1)?.channel, 'vip-access-required');
});
