'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const os = require('node:os');
const test = require('node:test');

const browserRegion = require('../../../src/app/main/utils/browser-region');
const {
  normalizeAiFreeBrowserSettings,
  parseCookieJson,
} = require('../../../src/app/main/utils/ai-free-browser-settings');
const { getHardwareFingerprint } = require('../../../src/app/main/utils/hardware-js');
const storeUtils = require('../../../src/app/main/ipc/register/store-utils');

test('browser region presets reject automatic values and preserve immutable metadata', () => {
  assert.equal(browserRegion.getBrowserRegionPreset(''), null);
  assert.equal(browserRegion.getBrowserRegionPreset(' AUTO '), null);
  assert.equal(browserRegion.getBrowserRegionPreset('system'), null);
  assert.equal(browserRegion.getBrowserRegionPreset('unknown'), null);
  assert.deepEqual(browserRegion.getBrowserRegionPreset(' JP '), {
    key: 'jp', label: '日本', locale: 'ja-JP', timezoneId: 'Asia/Tokyo',
    acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7',
  });
});

test('locale inference covers language, territory, aliases and unsupported input', () => {
  const cases = new Map([
    ['', null], ['zh', 'cn'], ['zh-HK', 'hk'], ['zh_TW', 'tw'], ['ja-JP', 'jp'], ['ko-KR', 'kr'],
    ['en-SG', 'sg'], ['en-GB', 'gb'], ['en-UK', 'gb'], ['en-CA', 'ca'], ['en-AU', 'au'], ['en-IN', 'in'],
    ['en', 'us'], ['de-DE', 'de'], ['fr-FR', 'fr'], ['nl-NL', 'nl'], ['ru-RU', 'ru'], ['th-TH', 'th'],
    ['es-ES', null],
  ]);
  for (const [locale, expected] of cases) assert.equal(browserRegion.inferBrowserRegionKeyFromLocale(locale), expected, locale);
});

test('browser settings migrate legacy automatic language without performing detection', () => {
  const normalized = normalizeAiFreeBrowserSettings({
    language: { mode: 'ip' },
    timezone: { mode: 'ip' },
    geolocation: { mode: 'ip' },
  });
  assert.deepEqual(normalized.language, { mode: 'custom', value: '' });
  assert.equal(normalized.timezone.mode, 'ip');
  assert.equal(normalized.geolocation.mode, 'ip');
  assert.deepEqual(parseCookieJson({ cookies: '{invalid' }), []);
  assert.equal(
    normalizeAiFreeBrowserSettings({ proxy: { mode: 'magic' } }).proxy.mode,
    'default',
  );
});

test('boolean and license binding normalizers cover wire aliases and fallbacks', () => {
  for (const value of [true, 1, -1, '1', ' TRUE ', 'yes', 'on', 'enabled']) assert.equal(storeUtils.toBoolean(value), true);
  for (const value of [false, 0, '0', ' FALSE ', 'no', 'off', 'disabled']) assert.equal(storeUtils.toBoolean(value, true), false);
  assert.equal(storeUtils.toBoolean('unknown', true), true);
  assert.equal(storeUtils.toBoolean(null), false);
  assert.deepEqual(storeUtils.normalizeLicenseBinding({
    can_self_unbind: true,
    max_usage_times: '10', usedUsageTimes: 3, remaining_usage_times: '7',
    remainingUnbindTimes: 2, max_unbind_times: 5, usedUnbindTimes: 3,
    device_bind_count: 1, maxDeviceCount: 2,
    device_binding_status: 'bound', deviceBindingSummary: '1/2',
  }), {
    canSelfUnbind: true, maxUsageTimes: 10, usedUsageTimes: 3, remainingUsageTimes: 7,
    remainingUnbindTimes: 2, maxUnbindTimes: 5, usedUnbindTimes: 3,
    deviceBindCount: 1, maxDeviceCount: 2, deviceBindingStatus: 'bound', deviceBindingSummary: '1/2',
  });
  assert.deepEqual(storeUtils.buildUnboundCredentialRecord({ key: 'old', deviceId: 'discarded' }, {}), { key: 'old' });
  assert.deepEqual(storeUtils.buildUnboundCredentialRecord({}, { key: 'new', deviceId: 'discarded' }), { key: 'new' });
});

test('credential persistence merges stores, updates cache and contains dependency failures', () => {
  let written = null;
  const credentials = [];
  const deps = {
    readStoreConfigSafe: () => ({ keep: true, userCredentials: { deviceId: 'old' } }),
    writeStoreConfigSafe: (value) => { written = value; return true; },
    licenseCache: { setCredentials: (value) => credentials.push(value) },
  };
  assert.equal(storeUtils.persistSavedLicenseKeySafe(deps, ' key ', ' device '), true);
  assert.deepEqual(written, { keep: true, userCredentials: { deviceId: 'device', key: 'key' } });
  assert.deepEqual(credentials, [{ key: 'key', deviceId: 'device' }]);
  assert.equal(storeUtils.persistSavedLicenseKeySafe(deps, ''), false);
  assert.equal(storeUtils.saveLicenseCredentialsSafe(deps, '', 'device-only'), false);
  assert.deepEqual(credentials.at(-1), { key: '', deviceId: 'device-only' });
  assert.equal(storeUtils.persistSavedLicenseKeySafe({ readStoreConfigSafe: () => { throw new Error('read'); } }, 'key'), false);
  assert.equal(storeUtils.persistSavedLicenseKeySafe({}, 'key'), false);
});

test('hardware fingerprint prefers sync id, falls back to async id and stays deterministic offline', async () => {
  const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  assert.equal(await getHardwareFingerprint({ machineIdSync: () => 'sync-id', machineId: async () => 'unused' }), digest('sync-id'));
  assert.equal(await getHardwareFingerprint({ machineIdSync: () => { throw new Error('sync'); }, machineId: async () => 'async-id' }), digest('async-id'));
  const fallback = await getHardwareFingerprint({ machineIdSync: () => '', machineId: async () => '' });
  assert.equal(fallback, digest(`fallback|${[os.hostname(), process.platform, process.arch].filter(Boolean).join('|')}`));
});
