'use strict';

const { setLicenseRuntimeConfig } = require('../../utils/runtime-config');
const { buildStoredAccountSession, normalizeAccountSession } = require('../../utils/account-session');
const { getServerMode, isServerBaseAllowedForMode } = require('../../utils/server-mode');
const { markVipServerVerified } = require('../../utils/vip-access');
const { normalizeValidationRuntimeConfig } = require('../../lib/http-client');
const { saveLicenseCredentialsSafe } = require('../../ipc/register/store-utils');
const { callOptional, firstText } = require('../../../shared/safe-values');

function normalizeAuthenticationInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  const requestedMode = firstText(source.mode).trim().toLowerCase();
  return {
    username: firstText(source.username).trim(),
    password: firstText(source.password),
    mode: firstText({ register: 'register', device: 'device' }[requestedMode], 'login'),
  };
}

function getAuthenticationInputError({ mode, username, password }) {
  if (mode !== 'device' && (!username || !password)) return '请输入用户名和密码';
  return '';
}

function buildAuthenticationFailure(authenticated) {
  const source = authenticated && typeof authenticated === 'object' ? authenticated : {};
  return {
    ...source,
    ok: false,
    message: firstText(source.message, '账号验证失败'),
    error: source.error,
  };
}

function getAuthenticatedDataError(data) {
  if (!data.username) return '登录响应缺少账号信息';
  if (!data.sessionToken) return '登录响应缺少账号会话';
  if (!data.sessionToken.startsWith('afs_')) return '账号服务返回了无效会话，请更新服务端后重新登录';
  if (!isServerBaseAllowedForMode(data.resolved.serverBase)) {
    const modeText = getServerMode() === 'local' ? '本地调试' : '正式远程';
    return `账号服务返回的服务器地址与${modeText}模式不匹配`;
  }
  return '';
}

function resolveAuthenticatedPayload(authenticated, username) {
  const validation = markVipServerVerified(
    authenticated.validation && typeof authenticated.validation === 'object' ? authenticated.validation : {},
  );
  const account = markVipServerVerified(authenticated.account || {});
  const resolved = {
    ...authenticated,
    ...validation,
    serverBase: firstText(
      authenticated.serverBase, authenticated.server_base, authenticated.address_HTTP,
      authenticated.addressHttp, authenticated.client_address, authenticated.clientAddress,
      validation.serverBase, validation.server_base, validation.address_HTTP,
      validation.addressHttp, validation.client_address, validation.clientAddress,
    ),
    platformName: firstText(
      authenticated.platform_name, authenticated.platformName,
      validation.platform_name, validation.platformName,
    ),
  };
  return {
    account,
    resolved,
    username: firstText(authenticated.account && authenticated.account.username, username).trim(),
    sessionToken: firstText(authenticated.session_token, authenticated.sessionToken).trim(),
  };
}

function persistAuthenticatedSession(context, data, deviceId) {
  const { readStoreConfigSafe, writeStoreConfigSafe, licenseCache, getGlobalHttpClient } = context;
  context.applyResolvedConfigToStore({ resolved: data.resolved });
  saveLicenseCredentialsSafe({ readStoreConfigSafe, writeStoreConfigSafe, licenseCache }, data.sessionToken, deviceId);
  const currentStore = readStoreConfigSafe();
  const storedSession = buildStoredAccountSession({
    current: currentStore?.userCredentials || {},
    username: data.username,
    sessionToken: data.sessionToken,
    deviceId,
    platformName: String(data.resolved.platformName || '').trim(),
    serverBase: String(data.resolved.serverBase || '').trim(),
    serverMode: getServerMode(),
    account: data.account,
    validation: data.resolved,
  });
  writeStoreConfigSafe({ ...currentStore, userCredentials: storedSession });
  callOptional(licenseCache, 'setValidationState', {
    key: data.sessionToken,
    deviceId,
    validated: true,
    bound: true,
    licenseValidated: true,
    result: data.resolved,
    message: data.authenticatedMessage || '登录成功',
  });
  setLicenseRuntimeConfig(licenseCache, normalizeValidationRuntimeConfig(data.resolved));
  callOptional(licenseCache, 'setRuntimeConfig', { autoValidatePending: false });
  const httpClient = callOptional(context, 'getGlobalHttpClient');
  if (httpClient && Object.prototype.hasOwnProperty.call(httpClient, 'runtimeServerBase')) {
    httpClient.runtimeServerBase = String(data.resolved.serverBase || '').trim().replace(/\/+$/, '');
  }
}

function notifyAuthenticatedSession(context, data, deviceId) {
  const { logger = console, licenseCache } = context;
  try {
    void Promise.resolve(callOptional(context, 'refreshAnnouncements')).catch((error) => {
      callOptional(logger, 'warn', '[账号] 登录后获取公告失败:', firstText(error && error.message, error));
    });
  } catch (error) {
    callOptional(logger, 'warn', '[账号] 登录后获取公告失败:', firstText(error && error.message, error));
  }
  setImmediate(() => {
    void Promise.resolve(callOptional(context, 'refreshAllowedPlatformsAndNotify')).catch((error) => {
      callOptional(logger, 'warn', '[账号] 登录后同步平台配置失败:', firstText(error && error.message, error));
    });
  });
  const validation = callOptional(licenseCache, 'getValidationState') || data.resolved;
  callOptional(context, 'sendToSide', 'license-credentials-updated', {
    key: data.sessionToken,
    deviceId,
    username: data.username,
    account: data.account,
    validation,
  });
  callOptional(context, 'sendToSide', 'account-session-updated', {
    authenticated: true,
    username: data.username,
    platformName: String(data.resolved.platformName || '').trim(),
    account: data.account,
    validation,
  });
  return validation;
}

async function authenticate(context, input = {}) {
  if (typeof context.authenticateAccount !== 'function') return { ok: false, message: '账号服务未就绪' };
  const request = normalizeAuthenticationInput(input);
  const inputError = getAuthenticationInputError(request);
  if (inputError) return { ok: false, message: inputError };
  const deviceId = firstText(await context.computeDeviceId()).trim();
  if (!deviceId || deviceId === '获取失败') return { ok: false, message: '无法读取本机设备号，请重启软件后重试' };
  const authenticated = await context.authenticateAccount({
    mode: request.mode,
    username: request.username,
    password: request.password,
    device_id: deviceId,
  });
  if (!authenticated || authenticated.ok !== true) {
    return buildAuthenticationFailure(authenticated);
  }
  const data = {
    ...resolveAuthenticatedPayload(authenticated, request.username),
    authenticatedMessage: authenticated.message,
  };
  const dataError = getAuthenticatedDataError(data);
  if (dataError) return { ok: false, message: dataError };
  persistAuthenticatedSession(context, data, deviceId);
  const validation = notifyAuthenticatedSession(context, data, deviceId);
  return {
    ok: true,
    message: firstText({ register: '注册成功', device: '设备号登录成功' }[request.mode], '登录成功'),
    account: data.account,
    platformName: data.resolved.platformName,
    validation,
  };
}

async function logout(context) {
  const currentStore = context.readStoreConfigSafe() || {};
  const session = normalizeAccountSession(currentStore.userCredentials || {});
  const httpClient = callOptional(context, 'getGlobalHttpClient');
  if (session.key && typeof httpClient?.logoutAccount === 'function') {
    try {
      await httpClient.logoutAccount(session.key);
    } catch (error) {
      callOptional(context.logger, 'warn', '[账号] 服务端退出失败:', firstText(error && error.message, error));
    }
  }
  const nextStore = { ...currentStore };
  delete nextStore.userCredentials;
  context.writeStoreConfigSafe(nextStore);
  callOptional(context.licenseCache, 'setCredentials', { key: '', deviceId: '' });
  callOptional(context.licenseCache, 'clearValidationState');
  callOptional(context.licenseCache, 'setRuntimeConfig', {
    serverBase: '', platformName: '', targetUrl: '', tutorialUrl: '', allowedPlatforms: [], autoValidatePending: false,
  });
  callOptional(context, 'setRuntimeServerBase', '');
  callOptional(context, 'setRuntimeTcpConfig', null);
  if (httpClient && Object.prototype.hasOwnProperty.call(httpClient, 'runtimeServerBase')) httpClient.runtimeServerBase = '';
  try {
    await callOptional(context, 'stopProxy', { sendToSide: context.sendToSide });
  } catch (error) {
    callOptional(context.logger, 'warn', '[账号] 退出时关闭 Clash Mini 失败:', firstText(error && error.message, error));
  }
  callOptional(context, 'sendToSide', 'license-credentials-updated', { key: '', deviceId: '', username: '', loggedOut: true });
  callOptional(context, 'sendToSide', 'account-session-updated', { authenticated: false });
  return { ok: true, message: '已退出账号' };
}

function getSession(context) {
  const store = context.readStoreConfigSafe();
  const credentials = normalizeAccountSession(store && store.userCredentials);
  const authenticated = credentials.authenticated
    && credentials.serverMode === getServerMode()
    && isServerBaseAllowedForMode(credentials.serverBase);
  return {
    ok: true,
    username: credentials.username,
    platformName: credentials.platformName,
    account: credentials.account,
    validation: credentials.validation,
    authenticated,
  };
}

function createAccountService(context = {}) {
  return {
    authenticate: (input) => authenticate(context, input),
    getSession: () => getSession(context),
    logout: () => logout(context),
  };
}

module.exports = { createAccountService };
