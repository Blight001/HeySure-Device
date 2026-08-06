'use strict';

const { buildStoredAccountSession, normalizeAccountSession } = require('../../utils/account-session');
const { markVipServerVerified } = require('../../utils/vip-access');
const { setLicenseRuntimeConfig } = require('../../utils/runtime-config');
const { normalizeValidationRuntimeConfig } = require('../../lib/http-client');
const { callOptional, firstText } = require('../../../shared/safe-values');

function errorResult(error) {
  return { ok: false, message: error?.message || String(error) };
}

function createVipSession(currentStore, credentials, redeemed, validation) {
  const account = markVipServerVerified({
    ...(credentials.account || {}),
    is_vip: true,
    vip_active: true,
    vip_tier: validation.vip_tier || redeemed.vip_tier || 'vip',
    vip_expiry_date: validation.vip_expiry_date ?? redeemed.vip_expiry_date ?? null,
  });
  const storedSession = buildStoredAccountSession({
    current: currentStore.userCredentials || {},
    username: credentials.username,
    sessionToken: credentials.key,
    deviceId: credentials.deviceId,
    platformName: credentials.platformName,
    serverBase: credentials.serverBase,
    serverMode: credentials.serverMode,
    account,
    validation,
  });
  return {
    account,
    storedSession,
    publicSession: {
      authenticated: true,
      username: credentials.username,
      platformName: credentials.platformName,
      account,
      validation,
    },
  };
}

function getClient(deps) {
  return callOptional(deps, 'getGlobalHttpClient');
}

async function refreshVipValidation(client, credentials, redeemed) {
  let validation = markVipServerVerified({
    ...(credentials.validation || {}),
    is_vip: true,
    vip_active: true,
    vip_tier: firstText(redeemed.vip_tier, 'vip'),
    vip_expiry_date: redeemed.vip_expiry_date || null,
  });
  if (typeof client.validateSession !== 'function') return validation;
  const refreshed = await client.validateSession(credentials.key, credentials.deviceId);
  if (refreshed && refreshed.valid === true) validation = markVipServerVerified(refreshed);
  return validation;
}

async function refreshWoolValidation(deps, client, key, deviceId, redeemed) {
  if (typeof client.validateSession !== 'function') return null;
  const validation = await client.validateSession(key, deviceId);
  const valid = validation && (validation.valid === true || validation.ok === true);
  if (!valid) return validation;
  setLicenseRuntimeConfig(deps.licenseCache, normalizeValidationRuntimeConfig(validation));
  callOptional(deps.licenseCache, 'setValidationState', {
    key, deviceId, bound: true, validated: true, licenseValidated: true,
    result: validation,
    message: firstText(redeemed.message, '羊毛礼品码兑换成功'),
  });
  await Promise.resolve(callOptional(deps, 'refreshAllowedPlatformsAndNotify'));
  return validation;
}

async function getVipPlans(deps) {
    try {
      const credentials = normalizeAccountSession(deps.readStoreConfigSafe()?.userCredentials || {});
      if (!credentials.key || !credentials.deviceId) return { ok: false, message: '请先在个人中心登录账号' };
      const client = getClient(deps);
      if (typeof client?.getVipPlans !== 'function') return { ok: false, message: 'VIP 套餐服务尚未就绪' };
      return await client.getVipPlans(credentials.key, credentials.deviceId);
    } catch (error) {
      return errorResult(error);
    }
}

async function redeemVipGiftCode(deps, input = {}) {
    try {
      const currentStore = deps.readStoreConfigSafe() || {};
      const credentials = normalizeAccountSession(currentStore.userCredentials || {});
      credentials.deviceId = firstText(await deps.computeDeviceId()).trim();
      const code = firstText(input.code).trim();
      if (!credentials.key || !credentials.deviceId) return { ok: false, message: '请先在个人中心登录账号' };
      if (!code) return { ok: false, message: '请输入礼品码' };
      const client = getClient(deps);
      if (typeof client?.redeemVipGiftCode !== 'function') return { ok: false, message: 'VIP 礼品码服务尚未就绪' };
      const redeemed = await client.redeemVipGiftCode(credentials.key, credentials.deviceId, code);
      if (!redeemed || redeemed.ok !== true) return redeemed;
      const validation = await refreshVipValidation(client, credentials, redeemed);
      const state = createVipSession(currentStore, credentials, redeemed, validation);
      deps.writeStoreConfigSafe({ ...currentStore, userCredentials: state.storedSession });
      callOptional(deps.licenseCache, 'setValidationState', {
        key: credentials.key,
        deviceId: credentials.deviceId,
        bound: true,
        validated: true,
        licenseValidated: true,
        result: validation,
        message: firstText(redeemed.message, 'VIP 开通成功'),
      });
      callOptional(deps, 'sendToSide', 'account-session-updated', state.publicSession);
      return { ...redeemed, validation, session: state.publicSession };
    } catch (error) {
      return errorResult(error);
    }
}

async function redeemWoolGiftCode(deps, input = {}) {
    try {
      const store = deps.readStoreConfigSafe();
      const credentials = normalizeAccountSession(store?.userCredentials || {});
      const key = firstText(credentials.key).trim();
      const deviceId = firstText(await deps.computeDeviceId()).trim();
      const code = firstText(input.code).trim();
      if (!key || !deviceId) return { ok: false, message: '请先在个人中心登录账号' };
      if (!code) return { ok: false, message: '请输入礼品码' };
      const client = getClient(deps);
      if (typeof client?.redeemWoolGiftCode !== 'function') return { ok: false, message: '羊毛礼品码服务尚未就绪' };
      const redeemed = await client.redeemWoolGiftCode(key, deviceId, code);
      if (!redeemed || redeemed.ok !== true) return redeemed;
      const validation = await refreshWoolValidation(deps, client, key, deviceId, redeemed);
      return { ...redeemed, validation };
    } catch (error) {
      return errorResult(error);
    }
}

function createLicenseService(deps = {}) {
  return {
    getDeviceId: deps.computeDeviceId,
    getVipPlans: () => getVipPlans(deps),
    redeemVipGiftCode: (input) => redeemVipGiftCode(deps, input),
    redeemWoolGiftCode: (input) => redeemWoolGiftCode(deps, input),
  };
}

module.exports = { createLicenseService, createVipSession };
