let aiServerDeviceBusy = false;

function aiServerDeviceErrorMessage(error, fallback = '') {
  return String(error?.error || error?.message || fallback || error || '');
}

function showAiConfigPage(page = 'custom') {
  const selected = page === 'server' ? 'server' : 'custom';
  document.querySelectorAll('[data-ai-config-page]').forEach((button) => {
    const active = button.dataset.aiConfigPage === selected;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('[data-ai-config-content]').forEach((content) => {
    content.hidden = content.dataset.aiConfigContent !== selected;
  });
  const subtitle = el('ai-config-page-subtitle');
  if (subtitle) {
    subtitle.textContent = selected === 'server'
      ? '登录 HeySure，把当前软件注册为可调用 MCP 的自定义设备'
      : '支持 OpenAI Chat Completions 兼容接口';
  }
  if (selected === 'server') void loadAiServerDeviceStatus();
}

function setAiServerDeviceBusy(busy) {
  aiServerDeviceBusy = busy === true;
  el('ai-server-device-form')?.querySelectorAll?.('input, button')?.forEach?.((control) => {
    control.disabled = aiServerDeviceBusy;
  });
  const loginButton = el('ai-server-device-login');
  if (loginButton) loginButton.textContent = aiServerDeviceBusy ? '连接中…' : '登录并连接';
}

function applyAiServerDeviceFields(status) {
  const server = el('ai-server-device-server');
  const account = el('ai-server-device-account');
  const serviceName = el('ai-server-device-name');
  if (server && status.server) server.value = String(status.server);
  if (account && status.account && !account.value) account.value = String(status.account);
  if (serviceName && status.serviceName) serviceName.value = String(status.serviceName);
}

function renderAiServerDeviceSummary(status) {
  const summary = el('ai-server-device-summary');
  if (!summary) return;
  summary.hidden = !status.serviceId;
  summary.textContent = status.serviceId
    ? `设备 ${status.serviceId} · MCP ${Number(status.toolCount || 0)} 个${status.aiConfigId == null ? '' : ` · AI #${status.aiConfigId}`}${status.remembered ? ' · 已启用自动连接' : ''}`
    : '';
}

function renderAiServerDeviceStatus(status = {}) {
  applyAiServerDeviceFields(status);
  const target = el('ai-server-device-status');
  if (target) {
    target.textContent = String(status.message || '尚未连接 AI 服务器');
    target.dataset.type = status.phase === 'registered' ? 'success' : (status.phase === 'error' ? 'error' : 'info');
  }
  renderAiServerDeviceSummary(status);
  const logout = el('ai-server-device-logout');
  if (logout) logout.hidden = !status.connected && !status.registered;
}

async function loadAiServerDeviceStatus() {
  const getStatus = window.aiFree?.ai?.getServerDeviceStatus;
  if (!getStatus) return;
  try {
    const result = await getStatus();
    if (!result?.ok) throw new Error(aiServerDeviceErrorMessage(result, '读取设备状态失败'));
    renderAiServerDeviceStatus(result.status || {});
  } catch (error) {
    const target = el('ai-server-device-status');
    if (target) target.textContent = aiServerDeviceErrorMessage(error);
  }
}

function buildAiServerDevicePayload() {
  return {
    server: String(el('ai-server-device-server')?.value || '').trim(),
    account: String(el('ai-server-device-account')?.value || '').trim(),
    password: String(el('ai-server-device-password')?.value || ''),
    serviceName: String(el('ai-server-device-name')?.value || '').trim(),
  };
}

function renderAiServerDeviceWarning(warning) {
  if (!warning) return;
  const target = el('ai-server-device-status');
  if (target) target.textContent = `连接成功，但${warning}`;
}

async function loginAiServerDevice(event) {
  event?.preventDefault?.();
  const login = window.aiFree?.ai?.loginServerDevice;
  if (!login || aiServerDeviceBusy) return;
  setAiServerDeviceBusy(true);
  try {
    const result = await login(buildAiServerDevicePayload());
    renderAiServerDeviceStatus(result?.status || {});
    if (!result?.ok) throw new Error(aiServerDeviceErrorMessage(result, '登录 AI 服务器失败'));
    renderAiServerDeviceWarning(result.warning);
    const password = el('ai-server-device-password');
    if (password) password.value = '';
  } catch (error) {
    const target = el('ai-server-device-status');
    if (target) {
      target.textContent = aiServerDeviceErrorMessage(error);
      target.dataset.type = 'error';
    }
  } finally {
    setAiServerDeviceBusy(false);
  }
}

async function logoutAiServerDevice() {
  const logout = window.aiFree?.ai?.logoutServerDevice;
  if (!logout || aiServerDeviceBusy) return;
  setAiServerDeviceBusy(true);
  try {
    const result = await logout();
    if (!result?.ok) throw new Error(aiServerDeviceErrorMessage(result, '断开连接失败'));
    renderAiServerDeviceStatus(result.status || {});
  } catch (error) {
    const target = el('ai-server-device-status');
    if (target) target.textContent = aiServerDeviceErrorMessage(error);
  } finally {
    setAiServerDeviceBusy(false);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (document.documentElement.classList.contains('browser-settings-page')) return;
  document.querySelectorAll('[data-ai-config-page]').forEach((button) => {
    button.addEventListener('click', () => showAiConfigPage(button.dataset.aiConfigPage));
  });
  el('ai-server-device-form')?.addEventListener('submit', loginAiServerDevice);
  el('ai-server-device-logout')?.addEventListener('click', logoutAiServerDevice);
  window.aiFree?.ai?.onServerDeviceStatus?.(renderAiServerDeviceStatus);
});
