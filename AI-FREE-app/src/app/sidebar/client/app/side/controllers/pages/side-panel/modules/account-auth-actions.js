async function submitSidebarAccountAuth() {
  const submit = safeGetEl('sidebar-auth-submit');
  if (!submit || submit.dataset.busy === '1') return;
  const form = readSidebarAuthForm();
  const validationError = validateSidebarAuthInput(form.username, form.password, form.passwordConfirm, form.registering);
  if (validationError) return setSidebarAuthStatus(validationError, 'error');

  const originalText = submit.textContent;
  submit.dataset.busy = '1';
  submit.disabled = true;
  submit.textContent = submit.dataset.loadingText || '处理中...';
  setSidebarAuthStatus(form.registering ? '正在创建账号...' : '正在登录...');

  try {
    const response = await invokeSidebarAccountAuth({
      mode: sidebarAccountAuthMode,
      username: form.username,
      password: form.password,
    });
    renderSidebarAuthSuccess(response, form.username);
  } catch (error) {
    setSidebarAuthStatus(error?.message || String(error), 'error');
  } finally {
    submit.dataset.busy = '0';
    submit.disabled = false;
    submit.textContent = originalText;
  }
}

function readSidebarAuthForm() {
  return {
    username: String(safeGetEl('sidebar-auth-username')?.value || '').trim(),
    password: String(safeGetEl('sidebar-auth-password')?.value || ''),
    passwordConfirm: String(safeGetEl('sidebar-auth-password-confirm')?.value || ''),
    registering: sidebarAccountAuthMode === 'register',
  };
}

function renderSidebarAuthSuccess(response, username) {
  if (!response?.ok) throw new Error(response?.message || '账号操作失败，请稍后重试');
  renderSidebarAccountSession({
    authenticated: true,
    username,
    platformName: response.platformName || '',
    account: response.account || {},
    validation: response.validation || {},
  });
}

function validateSidebarAuthInput(username, password, confirmation, registering) {
  if (!username) return '请输入用户名';
  if (password.length < 6) return '密码至少需要 6 位';
  if (registering && password !== confirmation) return '两次输入的密码不一致';
  return '';
}

async function submitSidebarDeviceLogin() {
  const button = safeGetEl('sidebar-device-login');
  if (!button || button.dataset.busy === '1') return;
  const originalText = button.textContent;
  button.dataset.busy = '1';
  button.disabled = true;
  button.textContent = '正在识别本机设备...';
  setSidebarAuthStatus('正在使用本机设备号找回账号...');
  try {
    const response = await invokeSidebarAccountAuth({ mode: 'device' });
    if (!response?.ok) throw new Error(response?.message || '设备号登录失败');
    renderSidebarAccountSession({
      authenticated: true,
      username: String(response.account?.username || '').trim(),
      platformName: response.platformName || '',
      account: response.account || {},
      validation: response.validation || {},
    });
  } catch (error) {
    setSidebarAuthStatus(error?.message || String(error), 'error');
  } finally {
    button.dataset.busy = '0';
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function logoutSidebarAccount() {
  const button = safeGetEl('account-logout-btn');
  if (!button || button.dataset.busy === '1') return;
  const originalText = button.textContent;
  button.dataset.busy = '1';
  button.disabled = true;
  button.textContent = '退出中...';

  try {
    const response = await window.aiFree.account.logout();
    if (!response?.ok) throw new Error(response?.message || '退出失败');
    renderSidebarAccountSession({ authenticated: false });
    setSidebarAuthMode('login');
    resetLoggedOutLicenseInputs();
  } catch (error) {
    window.MessageModal?.showErrorMessage?.('退出账号失败: ' + (error?.message || String(error)));
  } finally {
    button.dataset.busy = '0';
    button.disabled = false;
    button.textContent = originalText;
  }
}

function resetLoggedOutLicenseInputs() {
  const inputs = [safeGetEl('session-token'), safeGetEl('device-id')];
  inputs.forEach((input) => { if (input) input.value = ''; });
  if (typeof resetLicenseStateToValidate === 'function') resetLicenseStateToValidate();
  if (typeof applyFeatureAvailability === 'function') applyFeatureAvailability();
}

function unifiedGiftFailureMessage(vipResult, woolResult, aiResult, trafficResult) {
  const results = [vipResult, woolResult, trafficResult, aiResult].filter(Boolean);
  const meaningful = results.find((result) => {
    const message = String(result?.message || result?.error || '').trim();
    return message && Number(result?.status) !== 404 && !message.includes('不存在');
  });
  if (meaningful) return meaningful.message || meaningful.error;
  if (results.some((result) => Number(result?.status) >= 500)) return '服务器兑换服务异常，请稍后重试或联系管理员';
  return '兑换码不存在或已失效';
}

async function redeemUnifiedGiftCode() {
  const input = safeGetEl('unified-gift-code');
  const button = safeGetEl('unified-redeem-gift');
  const code = String(input?.value || '').trim();
  if (!code || !button || button.dataset.busy === '1') {
    if (!code) window.MessageModal?.showErrorMessage?.('请输入兑换码');
    return;
  }
  const originalText = button.textContent;
  button.dataset.busy = '1';
  button.disabled = true;
  button.textContent = '兑换中...';
  try {
    await redeemGiftAcrossServices(code, input);
  } catch (error) {
    window.MessageModal?.showErrorMessage?.(error?.message || String(error));
  } finally {
    button.dataset.busy = '0';
    button.disabled = false;
    button.textContent = originalText;
  }
}

async function redeemGiftAcrossServices(code, input) {
  const vipResult = await callGiftRedemption(() => window.aiFree.license.redeemVipGiftCode({ code }));
  if (handleVipGiftSuccess(vipResult, input)) return;
  const woolResult = await callGiftRedemption(() => window.aiFree.license.redeemWoolGiftCode({ code }));
  if (handleWoolGiftSuccess(woolResult, input)) return;
  const aiResult = await callGiftRedemption(() => window.aiFree.ai.redeemGiftCode({ code }));
  if (handleAiGiftSuccess(aiResult, input)) return;
  const trafficResult = await callGiftRedemption(() => window.aiFree.network.redeemProxyTrafficGiftCode({ code }));
  if (!trafficResult?.ok) throw new Error(unifiedGiftFailureMessage(vipResult, woolResult, aiResult, trafficResult));
  handleTrafficGiftSuccess(trafficResult, input);
}

async function callGiftRedemption(operation) {
  try {
    return await operation();
  } catch (error) {
    return { ok: false, message: error?.message || String(error) };
  }
}

function clearGiftInput(input) {
  if (input) input.value = '';
}

function handleVipGiftSuccess(result, input) {
  if (!result?.ok) return false;
  clearGiftInput(input);
  renderSidebarAccountSession(result.session || {
    authenticated: true,
    username: safeGetEl('account-username-display')?.value || '',
    account: { is_vip: true, vip_tier: result.vip_tier || 'vip', vip_expiry_date: result.vip_expiry_date || null },
    validation: result.validation || {},
  });
  window.MessageModal?.showSuccessMessage?.(result.message || 'VIP 开通成功');
  return true;
}

function handleWoolGiftSuccess(result, input) {
  if (!result?.ok) return false;
  const platforms = result.validation?.woolPlatforms || result.validation?.wool_platforms;
  if (Array.isArray(platforms) && typeof renderWoolPlatformButtons === 'function') renderWoolPlatformButtons(platforms);
  clearGiftInput(input);
  window.MessageModal?.showSuccessMessage?.(result.message || '羊毛额度兑换成功');
  return true;
}

function handleAiGiftSuccess(result, input) {
  if (!result?.ok) return false;
  const quota = window.AiFreeQuotaDisplay?.recordAIResetAfterRedeem?.(result.quota, result.added_quota) || result.quota;
  if (quota) window.dispatchEvent(new CustomEvent('ai-control-quota-updated', { detail: quota }));
  clearGiftInput(input);
  window.MessageModal?.showSuccessMessage?.(result.message || '对话额度兑换成功');
  return true;
}

function handleTrafficGiftSuccess(result, input) {
  clearGiftInput(input);
  const quota = window.AiFreeQuotaDisplay?.recordTrafficResetAfterRedeem?.(result.quota, result.added_bytes) || result.quota;
  if (quota && typeof renderProxyTrafficQuota === 'function') renderProxyTrafficQuota(quota);
  window.MessageModal?.showSuccessMessage?.(result.message || '流量兑换成功');
}
