'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildChromiumArgs,
} = require('../../../src/app/main/browser-runtime/chromium-launcher');
const {
  normalizePermissionOrigins,
} = require('../../../src/app/main/browser-runtime/chromium-permission-origins');
const {
  normalizeAiFreeBrowserSettings,
} = require('../../../src/app/main/utils/ai-free-browser-settings');

test('normalizePermissionOrigins accepts exact HTTPS and loopback origins only', () => {
  assert.deepEqual(normalizePermissionOrigins([
    'https://studio.example.com',
    'https://studio.example.com:443',
    'http://localhost:8080',
    'http://127.0.0.1:3000',
    'http://remote.example.com',
    'https://*.example.com',
    'https://example.com/path',
    'https://user:password@example.com',
  ]), [
    'https://studio.example.com',
    'http://localhost:8080',
    'http://127.0.0.1:3000',
  ]);
});

test('buildChromiumArgs adds permission switches only with a valid allowlist', () => {
  const base = {
    paths: { chromiumData: 'D:\\profile', downloads: 'D:\\downloads' },
    runtimeProfileId: 'profile-1',
    pipeName: '\\\\.\\pipe\\test',
    launchToken: 'token',
  };
  const disabled = buildChromiumArgs({ ...base, profile: {} });
  assert.equal(disabled.some((arg) => arg === '--auto-grant-permissions'), false);
  assert.equal(disabled.includes('--hs-hide-toolbar'), false);

  const enabled = buildChromiumArgs({
    ...base,
    profile: { autoGrantPermissionOrigins: ['https://studio.example.com'] },
  });
  assert.equal(enabled.includes('--auto-grant-permissions'), true);
  assert.equal(enabled.includes(
    '--auto-grant-permissions-origins=https://studio.example.com',
  ), true);

  const oneClickLaunch = buildChromiumArgs({
    ...base,
    profile: { hideToolbar: true },
  });
  assert.equal(oneClickLaunch.includes('--hs-hide-toolbar'), true);
});

test('browser settings preserve a bounded permission origin configuration', () => {
  const settings = normalizeAiFreeBrowserSettings({
    automation: { permissionOrigins: [' https://studio.example.com ', ''] },
  });
  assert.deepEqual(settings.automation.permissionOrigins, ['https://studio.example.com']);
});
