function sessionControlText(...values) {
  const value = values.find((item) => item !== undefined && item !== null && item !== '');
  return value === undefined ? '' : String(value).trim();
}

function triggerNetworkMagicAfterLogin(sessionToken, deviceId, label) {
  try {
    if (typeof autoStartNetworkMagicIfEligible !== 'function') return;
    void autoStartNetworkMagicIfEligible({
      startBtn: safeGetEl('start-clash-mini-btn'),
      vpnBtn: safeGetEl('VPN-switch'),
      key: sessionToken,
      deviceId,
    });
  } catch (error) {
    console.warn(label, sessionControlText(error?.message, error));
  }
}

function applyAuthenticatedAccountFeatureAccess(session = {}) {
  if (session.authenticated !== true) return;
  const validation = session.validation && typeof session.validation === 'object'
    ? session.validation
    : {};
  const tokenInput = safeGetEl('session-token');
  const deviceInput = safeGetEl('device-id');
  const sessionToken = sessionControlText(
    session.sessionToken,
    currentLicenseState.key,
    tokenInput?.value,
  );
  const deviceId = sessionControlText(
    session.deviceId,
    session.device_id,
    currentLicenseState.deviceId,
    deviceInput?.value,
  );
  applyLicenseCredentialsToInput({ key: sessionToken, deviceId });
  applyValidatedLicenseResult(validation, { key: sessionToken, deviceId });
  enableAllLicenseRequiredButtons();
}

function restoreLoadedAccountSession(credentials) {
  const sessionToken = sessionControlText(credentials.key);
  const deviceId = sessionControlText(credentials.deviceId);
  const tokenInput = safeGetEl('session-token');
  if (tokenInput) tokenInput.value = sessionToken;
  globalCurrentKey = sessionToken;
  globalCurrentDeviceId = deviceId;
  hasValidatedInSession = false;
  applyValidateButtonState({ key: sessionToken, deviceId, bound: false });
  setLicenseButtonsDisabled(true);
  if (!sessionToken || credentials.validated !== true || credentials.bound !== true) return;
  displayExpirationInfo(credentials);
  applyValidatedLicenseResult(credentials, { key: sessionToken, deviceId });
  enableAllLicenseRequiredButtons();
  setAutoValidateStatus('已恢复账号登录状态');
  triggerNetworkMagicAfterLogin(
    sessionToken,
    deviceId,
    '[侧边栏] 恢复账号状态后自动开启网络魔法失败:',
  );
}

async function loadAccountSessionCredentials() {
  try {
    const requestRevision = licenseCredentialsUpdateRevision;
    const result = await window.aiFree.license.getUserCredentials();
    if (!result?.ok || !result.credentials) return;
    if (requestRevision !== licenseCredentialsUpdateRevision) return;
    restoreLoadedAccountSession(result.credentials);
  } catch (error) {
    console.warn('[前端] 加载账号会话失败:', error);
  }
}

function bindLicenseValidationControls() {
  if (!safeGetEl('session-token')) return;
  void loadAccountSessionCredentials();
  bindLicenseCredentialsListener();
}
