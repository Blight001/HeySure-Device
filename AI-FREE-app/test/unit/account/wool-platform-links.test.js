'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { registerMiscIPC } = require('../../../src/app/main/ipc/register/misc');
const { createLicenseCache } = require('../../../src/app/main/runtime/license-cache');

test('羊毛平台缓存和 IPC 保留全部子链接与仅启动标记', async () => {
  const handlers = new Map();
  const licenseCache = createLicenseCache();
  licenseCache.setRuntimeConfig({
    woolPlatforms: [{
      platform_name: '工具导航',
      target_url: '',
      sub_urls: ['https://one.example', 'https://two.example', 'https://three.example'],
      launch_only: true,
      permission_granted: true,
    }],
  });

  registerMiscIPC({
    ipc: {
      scope: () => ({
        handle: (channel, handler) => handlers.set(channel, handler),
      }),
    },
    licenseCache,
  });

  const platforms = await handlers.get('get-wool-platforms')();
  assert.deepEqual(platforms, [{
    name: '工具导航',
    platform: '工具导航',
    targetUrl: 'https://one.example',
    subUrls: ['https://one.example', 'https://two.example', 'https://three.example'],
    launchOnly: true,
    permissionGranted: true,
    quota: null,
  }]);
});
