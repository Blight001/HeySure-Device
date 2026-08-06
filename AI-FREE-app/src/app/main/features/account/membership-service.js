'use strict';

const { buildStoredAccountSession, normalizeAccountSession } = require('../../utils/account-session');
const { getServerMode, isServerBaseAllowedForMode } = require('../../utils/server-mode');
const { clearVipServerVerification, markVipServerVerified } = require('../../utils/vip-access');
const { setLicenseRuntimeConfig } = require('../../utils/runtime-config');
const { callOptional, firstText } = require('../../../shared/safe-values');

function getTutorialUrl(licenseCache) {
  const runtimeConfig = callOptional(licenseCache, 'getRuntimeConfig') || {};
  return firstText(runtimeConfig.tutorialUrl).trim();
}

async function validateMembership(deps, credentials) {
  const client = callOptional(deps, 'getGlobalHttpClient');
  if (client && Object.prototype.hasOwnProperty.call(client, 'runtimeServerBase')) {
    client.runtimeServerBase = firstText(credentials.serverBase).trim().replace(/\/+$/, '');
  }
  if (!client || typeof client.validateSession !== 'function') return null;
  return client.validateSession(credentials.key, credentials.deviceId);
}

function resolveMembershipState(credentials, response) {
  const verified = response?.valid === true;
  const validation = verified
    ? markVipServerVerified(response)
    : clearVipServerVerification(credentials.validation);
  const account = verified
    ? markVipServerVerified({
      ...credentials.account,
      is_vip: response.is_vip === true,
      vip_active: response.vip_active === true || response.is_vip === true,
      vip_tier: response.vip_tier || null,
      vip_expiry_date: response.vip_expiry_date || null,
    })
    : clearVipServerVerification(credentials.account);
  return { verified, validation, account };
}

function persistMembership(deps, credentials, state) {
  const currentStore = deps.readStoreConfigSafe();
  const storedSession = buildStoredAccountSession({
    current: currentStore?.userCredentials || {},
    username: credentials.username,
    sessionToken: credentials.key,
    deviceId: credentials.deviceId,
    platformName: credentials.platformName,
    serverBase: credentials.serverBase,
    serverMode: credentials.serverMode,
    account: state.account,
    validation: state.validation,
    authenticatedAt: credentials.authenticatedAt,
  });
  deps.writeStoreConfigSafe({ ...currentStore, userCredentials: storedSession });
  deps.licenseCache?.setCredentials?.({ key: credentials.key, deviceId: credentials.deviceId });
  deps.licenseCache?.setValidationState?.({
    key: credentials.key,
    deviceId: credentials.deviceId,
    validated: state.verified,
    bound: state.verified,
    licenseValidated: state.verified,
    result: state.validation,
    message: state.verified ? '会员状态已由服务器验证' : '会员状态在线验证失败，已安全降级',
  });
  setLicenseRuntimeConfig(deps.licenseCache, state.validation);
  deps.licenseCache?.setRuntimeConfig?.({ autoValidatePending: false });
}

function notifyMembershipResult(deps, credentials, state, reason, response) {
  if (reason !== 'startup') {
    deps.sendToSide?.('account-session-updated', {
      authenticated: true,
      username: credentials.username,
      platformName: credentials.platformName,
      account: state.account,
      validation: state.validation,
    });
  }
  if (!state.verified) {
    deps.logger.warn?.('[会员] 在线验证失败，本地 VIP 权限已关闭:', response?.message || response?.error || '服务不可用');
  }
}

function createMembershipService(deps = {}) {
  /** @type {Record<string, any>} */
  const normalized = { ...deps, logger: deps.logger || console, setIntervalFn: deps.setIntervalFn || setInterval };
  let refreshInFlight = null;

  async function performRefresh(credentials, reason) {
    const previousTutorialUrl = getTutorialUrl(normalized.licenseCache);
    const response = await validateMembership(normalized, credentials);
    const state = resolveMembershipState(credentials, response);
    persistMembership(normalized, credentials, state);
    const nextTutorialUrl = getTutorialUrl(normalized.licenseCache);
    if (state.verified && nextTutorialUrl && nextTutorialUrl !== previousTutorialUrl) {
      await Promise.resolve(callOptional(normalized, 'refreshAllowedPlatformsAndNotify'));
    }
    notifyMembershipResult(normalized, credentials, state, reason, response);
    return state;
  }

  async function refresh(credentials, reason = 'startup') {
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = performRefresh(credentials, reason);
    try { return await refreshInFlight; } finally { refreshInFlight = null; }
  }

  function scheduleRefresh() {
    const timer = normalized.setIntervalFn(() => {
      const current = normalizeAccountSession(normalized.readStoreConfigSafe()?.userCredentials || {});
      if (current.authenticated) {
        void refresh(current, 'periodic').catch((error) => {
          normalized.logger.warn?.('[会员] 定时验证失败:', error?.message || error);
        });
      }
    }, 5 * 60 * 1000);
    timer?.unref?.();
    return timer;
  }

  async function restore() {
    const credentials = normalizeAccountSession(normalized.readStoreConfigSafe()?.userCredentials || {});
    const serverMode = getServerMode();
    const canRestore = credentials.authenticated
      && credentials.serverMode === serverMode
      && isServerBaseAllowedForMode(credentials.serverBase, serverMode);
    if (!canRestore) {
      if (credentials.authenticated) {
        normalized.logger.log?.(`[账号] 已忽略 ${credentials.serverMode} 模式的历史登录状态，当前为 ${serverMode} 模式`);
      }
      return { restored: false };
    }
    normalized.applyResolvedConfigToStore?.({
      resolved: {
        ...credentials.validation,
        serverBase: credentials.serverBase,
        platformName: credentials.platformName,
      },
    });
    const state = await refresh(credentials, 'startup');
    normalized.logger.log?.('[账号] 已恢复账号登录状态:', credentials.username, state.verified ? '(会员已在线验证)' : '(会员安全降级)');
    return { restored: true, state, timer: scheduleRefresh() };
  }

  return { refresh, restore, scheduleRefresh };
}

module.exports = {
  createMembershipService,
  notifyMembershipResult,
  persistMembership,
  resolveMembershipState,
};
