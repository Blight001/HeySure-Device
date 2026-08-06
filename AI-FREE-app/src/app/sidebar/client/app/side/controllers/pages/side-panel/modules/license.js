// 侧边栏许可证 / 验证相关逻辑

// 设置/更新/持久化：setLicenseButtonsDisabled的具体业务逻辑。
function setLicenseButtonsDisabled(disabled) {
  if (typeof setLicenseRequiredButtonsDisabled === 'function') {
    setLicenseRequiredButtonsDisabled(disabled);
  } else {
    setButtonsDisabled('.requires-license', disabled);
    setButtonsDisabled('#open-dream-page-btn', disabled);
  }
  setAccountTabDisabled(disabled);
}

// 设置/更新/持久化：setAutoValidateStatus的具体业务逻辑。
function setAutoValidateStatus(message, level) {
  if (message) {
    console.log('[侧边栏][自动验证]', message, level ? `(${level})` : '');
  }
}

let autoValidateTimer = null;
let licenseCredentialsUpdateRevision = 0;

// 停止/关闭/清理：clearAutoValidateTimer的具体业务逻辑。
function clearAutoValidateTimer() {
  if (autoValidateTimer) {
    clearTimeout(autoValidateTimer);
    autoValidateTimer = null;
  }
}

function getLicenseStateField(data, snakeName, camelName) {
  return data[snakeName] !== undefined && data[snakeName] !== null ? data[snakeName] : data[camelName];
}

function hasTrueLicenseStateField(data, names) {
  return names.some((name) => data[name] === true);
}

function getLicenseRegionInfo(data, isValidated) {
  if (!isValidated) return null;
  return normalizeRegionRoutingInfo(data.regionInfo || data.region_info || data.licenseRegionInfo || null);
}

// 处理：captureLicenseState的具体业务逻辑。
function captureLicenseState(payload, { key = '', deviceId = '', bound = true } = {}) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const isValidated = bound === true || hasTrueLicenseStateField(data, ['licenseValidated', 'validated']);
  return {
    key,
    deviceId,
    bound: !!bound,
    regionInfo: getLicenseRegionInfo(data, isValidated),
    canSelfUnbind: hasTrueLicenseStateField(data, ['can_self_unbind', 'canSelfUnbind']),
    remainingUnbindTimes: toFiniteNumber(getLicenseStateField(data, 'remaining_unbind_times', 'remainingUnbindTimes')),
    maxUnbindTimes: toFiniteNumber(getLicenseStateField(data, 'max_unbind_times', 'maxUnbindTimes')),
    usedUnbindTimes: toFiniteNumber(getLicenseStateField(data, 'used_unbind_times', 'usedUnbindTimes')),
    deviceBindCount: toFiniteNumber(getLicenseStateField(data, 'device_bind_count', 'deviceBindCount')),
    maxDeviceCount: toFiniteNumber(getLicenseStateField(data, 'max_device_count', 'maxDeviceCount')),
    deviceBindingStatus: data.device_binding_status || data.deviceBindingStatus || '',
    deviceBindingSummary: data.device_binding_summary || data.deviceBindingSummary || '',
  };
}

// 设置/更新/持久化：applyValidateButtonState的具体业务逻辑。
function applyValidateButtonState(state) {
  currentLicenseState = {
    ...currentLicenseState,
    ...state,
    key: state && Object.prototype.hasOwnProperty.call(state, 'key') ? String(state.key || '') : currentLicenseState.key,
    deviceId: state && Object.prototype.hasOwnProperty.call(state, 'deviceId') ? String(state.deviceId || '') : currentLicenseState.deviceId,
    bound: !!(state && state.bound),
  };
}

// 创建/初始化：createBoundLicenseSnapshot的具体业务逻辑。
function createBoundLicenseSnapshot({ key, deviceId } = {}) {
  return {
    bound: true,
    key: key !== undefined ? key : currentLicenseState.key,
    deviceId: deviceId !== undefined ? deviceId : currentLicenseState.deviceId,
    canSelfUnbind: currentLicenseState.canSelfUnbind,
    remainingUnbindTimes: currentLicenseState.remainingUnbindTimes,
    maxUnbindTimes: currentLicenseState.maxUnbindTimes,
    usedUnbindTimes: currentLicenseState.usedUnbindTimes,
    deviceBindCount: currentLicenseState.deviceBindCount,
    maxDeviceCount: currentLicenseState.maxDeviceCount,
    deviceBindingStatus: currentLicenseState.deviceBindingStatus,
    deviceBindingSummary: currentLicenseState.deviceBindingSummary,
  };
}

// 处理：restoreBoundLicenseState的具体业务逻辑。
function restoreBoundLicenseState({ key, deviceId } = {}) {
  applyValidateButtonState(createBoundLicenseSnapshot({ key, deviceId }));
}

// 设置/更新/持久化：applyValidatedLicenseResult的具体业务逻辑。
function applyValidatedLicenseResult(payload, { key, deviceId } = {}) {
  const nextState = captureLicenseState(payload, {
    key,
    deviceId,
    bound: true,
  });
  hasValidatedInSession = true;
  applyValidateButtonState(nextState);
}

// 设置/更新/持久化：applyLicenseCredentialsToInput的具体业务逻辑。
function applyLicenseCredentialsToInput({ key = '', deviceId = '' } = {}) {
  const keyInput = safeGetEl('session-token');
  const deviceIdInput = safeGetEl('device-id');
  const normalizedKey = String(key || '').trim();
  const normalizedDeviceId = String(deviceId || '').trim();

  if (keyInput && normalizedKey) {
    keyInput.value = normalizedKey;
  }
  if (deviceIdInput && normalizedDeviceId) {
    deviceIdInput.value = normalizedDeviceId;
  }

  if (normalizedKey) {
    globalCurrentKey = normalizedKey;
    currentLicenseState.key = normalizedKey;
  }
  if (normalizedDeviceId) {
    globalCurrentDeviceId = normalizedDeviceId;
    currentLicenseState.deviceId = normalizedDeviceId;
  }
}

// 设置/更新/持久化：applyValidationFailureState的具体业务逻辑。
function applyValidationFailureState({ disableLicenseButtons = false } = {}) {
  hasValidatedInSession = false;
  resetLicenseStateToValidate();
  updateButtonStatesBasedOnConnection(false);
  if (disableLicenseButtons) {
    setLicenseButtonsDisabled(true);
  }
}

// 停止/关闭/清理：resetLicenseSummaryDisplay的具体业务逻辑。
function resetLicenseSummaryDisplay() {
  if (typeof setWoolPlatformRemainingUsage === 'function') {
    setWoolPlatformRemainingUsage('');
  }
}

// 停止/关闭/清理：resetLicenseStateToValidate的具体业务逻辑。
function resetLicenseStateToValidate() {
  currentLicenseState = {
    ...currentLicenseState,
    bound: false,
    regionInfo: null,
    canSelfUnbind: false,
    remainingUnbindTimes: null,
    maxUnbindTimes: null,
    usedUnbindTimes: null,
    deviceBindCount: null,
    maxDeviceCount: null,
    deviceBindingStatus: '',
    deviceBindingSummary: '',
  };
  resetLicenseSummaryDisplay();
  if (typeof renderWoolPlatformButtons === 'function') {
    renderWoolPlatformButtons([]);
  }
  applyValidateButtonState({ bound: false });
}

// 启动/打开/显示：displayExpirationInfo的具体业务逻辑。
function displayExpirationInfo(result) {
  try {
    const payload = extractValidationPayload(result);
    if (!payload) return;
    const woolPlatforms = payload.woolPlatforms || payload.wool_platforms;
    if (Array.isArray(woolPlatforms) && typeof renderWoolPlatformButtons === 'function') {
      renderWoolPlatformButtons(woolPlatforms);
      return;
    }
    const usageText = formatUsageTimesText(payload);
    if (typeof setWoolPlatformRemainingUsage === 'function') {
      setWoolPlatformRemainingUsage(usageText);
    }
  } catch (e) {
    console.error('更新到期时间显示失败:', e);
  }
}

// 同步/连接：bindServerAccountCookieListener的具体业务逻辑。
function bindServerAccountCookieListener() {
  if (!window.aiFree?.account?.onServerAccountCookieReceived) {
    return;
  }

  window.aiFree.account.onServerAccountCookieReceived(handleServerAccountCookie);
}

function getServerCookieCredentials(data) {
  const keyInput = document.getElementById('session-token');
  const deviceIdInput = document.getElementById('device-id');
  if (!keyInput || !deviceIdInput) return null;
  return {
    key: data.key || String(keyInput.value || '').trim(),
    deviceId: data.deviceId || String(deviceIdInput.value || '').trim(),
  };
}

function showServerCookieError(platform, message) {
  const text = sanitizeUserFacingMessage(message, '自动处理失败');
  console.error('[侧边栏] 自动处理服务器推送账号失败:', text);
  if (window.MessageModal) window.MessageModal.showErrorMessage(`自动处理${platform}账号失败：${text}`);
}

async function openServerPushedAccount(data, credentials) {
  const contentApi = window.aiFree && window.aiFree.content;
  if (!contentApi || typeof contentApi.openDreamPage !== 'function') {
    console.error('[侧边栏] openDreamPage方法不可用，无法自动处理');
    if (window.MessageModal) window.MessageModal.showErrorMessage('系统功能未就绪，无法自动处理账号');
    return;
  }
  try {
    const result = await contentApi.openDreamPage({
      ...credentials,
      serverPushedData: {
        platform: data.platform,
        cookies: data.cookies,
        userId: data.userId,
        currentAccountType: data.currentAccountType,
        currentAccountTypeLabel: data.currentAccountTypeLabel,
        current_account_type: data.current_account_type,
        current_account_type_label: data.current_account_type_label,
      },
    });
    if (!result || result.ok !== true) showServerCookieError(data.platform, result && (result.message || result.error));
  } catch (error) {
    showServerCookieError(data.platform, error && error.message);
  }
}

async function handleServerAccountCookie(data) {
    try {
      if (!data.autoProcess) return;
      const credentials = getServerCookieCredentials(data);
      if (!credentials) {
        console.error('[侧边栏] 找不到账号会话或设备号');
        return;
      }
      if (!hasValidatedInSession && !credentials.key) {
        console.warn('[侧边栏] 当前账号会话无效，无法自动处理账号 Cookie');
        return;
      }
      await openServerPushedAccount(data, credentials);
    } catch (err) {
      console.error('[侧边栏] 处理服务器推送账号失败:', err);
      if (window.MessageModal) {
        window.MessageModal.showErrorMessage('处理服务器推送账号失败：' + sanitizeUserFacingMessage(err.message, '账号处理失败'));
      }
    }
}

// 同步/连接：bindLicenseCredentialsListener的具体业务逻辑。
function bindLicenseCredentialsListener() {
  if (!window.aiFree?.license?.onCredentialsUpdated) {
    return;
  }

  window.aiFree.license.onCredentialsUpdated((data = {}) => {
    licenseCredentialsUpdateRevision += 1;
    const usernameEl = safeGetEl('account-username-display');
    if (usernameEl) usernameEl.value = String(data.username || '');
    if (data.loggedOut === true) {
      const keyInput = safeGetEl('session-token');
      const deviceIdInput = safeGetEl('device-id');
      if (keyInput) keyInput.value = '';
      if (deviceIdInput) deviceIdInput.value = '';
      globalCurrentKey = '';
      globalCurrentDeviceId = '';
      hasValidatedInSession = false;
      resetLicenseStateToValidate();
      setLicenseButtonsDisabled(true);
      return;
    }
    try {
      applyLicenseCredentialsToInput({
        key: data.key,
        deviceId: data.deviceId,
      });
      if (data.validation && typeof data.validation === 'object') {
        displayExpirationInfo(data.validation);
        applyValidatedLicenseResult(data.validation, {
          key: data.key,
          deviceId: data.deviceId,
        });
        enableAllLicenseRequiredButtons();
      }
    } catch (error) {
      console.warn('[侧边栏] 处理账号会话同步失败:', error?.message || error);
    }
  });
}

// 账号登录成功本身就是主进程确认过的授权结果。把账号会话同步为许可证
// 可用状态，避免功能解锁依赖另一个 IPC 事件是否恰好被当前视图收到。
