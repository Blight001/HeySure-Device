// 侧边栏功能可用性与运行时值同步。
// TCP 连接状态展示已移除：功能按钮只由账号登录状态驱动。

let currentRemainingUsageText = '';
const woolPlatformQuotaText = new Map();

function appendQuotaUsageText(parts, quota) {
  const remaining = Number(quota.remaining_usage_times);
  if (quota.remaining_usage_times === null || quota.remaining_usage_times === undefined) {
    parts.push('无限次');
  } else if (Number.isFinite(remaining)) {
    parts.push(`剩余 ${Math.max(0, remaining)} 次`);
  }
}

function appendQuotaValidityText(parts, quota) {
  const seconds = Number(quota.remaining_seconds);
  if (!Number.isFinite(seconds)) {
    if (!quota.expiry_date && !quota.validity_seconds) parts.push('长期有效');
    else if (quota.validity_seconds && !quota.activated_at) parts.push('首次使用计时');
    return;
  }
  if (seconds <= 0) parts.push('已到期');
  else if (seconds >= 86400) parts.push(`剩余 ${Math.ceil(seconds / 86400)} 天`);
  else if (seconds >= 3600) parts.push(`剩余 ${Math.ceil(seconds / 3600)} 小时`);
  else parts.push(`剩余 ${Math.max(1, Math.ceil(seconds / 60))} 分钟`);
}

function formatWoolPlatformQuotaText(quota) {
  if (!quota || typeof quota !== 'object') return '';
  if (quota.enabled === false) return '未开通';
  if (quota.expired === true) return '已过期';
  if (quota.exhausted === true) return '次数已用尽';

  const parts = [];
  appendQuotaUsageText(parts, quota);
  appendQuotaValidityText(parts, quota);
  return parts.join(' · ');
}

function applyWoolPlatformButtonLabel(button) {
  if (!button) return;
  const baseLabel = String(button.dataset.baseLabel || button.textContent || '').replace(/\s*\(剩余次数：.*\)$/, '').trim();
  button.dataset.baseLabel = baseLabel;
  button.replaceChildren(document.createTextNode(baseLabel));
  const platform = String(button.dataset.platform || '').trim();
  const quotaText = woolPlatformQuotaText.get(platform) || currentRemainingUsageText;
  if (quotaText && platform) {
    const remaining = document.createElement('span');
    remaining.className = 'wool-platform-remaining';
    remaining.textContent = `（${quotaText}）`;
    button.appendChild(remaining);
  }
}

function setWoolPlatformRemainingUsage(value, platform = '') {
  const platformName = String(platform || '').trim();
  if (platformName) {
    woolPlatformQuotaText.set(platformName, String(value ?? '').trim());
  } else {
    currentRemainingUsageText = String(value ?? '').trim();
  }
  document.querySelectorAll('.open-wool-platform-btn').forEach(applyWoolPlatformButtonLabel);
}

// 设置/更新/持久化：setButtonsDisabled的具体业务逻辑。
function setButtonsDisabled(selector, disabled) {
  document.querySelectorAll(selector).forEach((button) => {
    button.disabled = disabled;
  });
}

// 设置/更新/持久化：setLicenseRequiredButtonsDisabled的具体业务逻辑。
function setLicenseRequiredButtonsDisabled(disabled) {
  // 羊毛资源主入口不再依赖隐藏的许可证按钮。未登录点击时由入口处理器
  // 跳转个人中心；登录后仅由服务器下发的平台额度决定是否可用。
  document.querySelectorAll('.open-wool-platform-btn').forEach((button) => {
    if (button.dataset.busy !== '1') {
      button.disabled = button.dataset.quotaUnavailable === 'true';
    }
  });
  syncLoggedOutProtectedEntryAvailability();
}

// 设置/更新/持久化：setAccountTabDisabled的具体业务逻辑。
function setAccountTabDisabled(disabled) {
  const accountTabBtn = safeGetEl('account-history-toggle-btn');
  if (accountTabBtn) {
    accountTabBtn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    accountTabBtn.classList.toggle('is-disabled', !!disabled);
  }
}

// 处理：isLicenseValidated的具体业务逻辑。
function isLicenseValidated() {
  const accountSession = safeGetEl('sidebar-account-session');
  if (accountSession) return accountSession.dataset.authenticated === 'true';
  return document.documentElement.dataset.accountAuthenticated === 'true';
}

// 未登录时，受保护的主入口仍保持可点击；真正的点击处理器会在任何
// IPC/网络操作前跳转到登录。测速和手动选路不是登录入口，继续禁用。
function syncLoggedOutProtectedEntryAvailability() {
  const authenticated = isLicenseValidated();

  const restoreAuthenticatedTitle = (button) => {
    if (!button?.hasAttribute('data-authenticated-title')) return;
    button.title = button.dataset.authenticatedTitle || '';
    button.removeAttribute('data-authenticated-title');
  };

  if (authenticated) {
    document.querySelectorAll('.open-wool-platform-btn').forEach((button) => {
      restoreAuthenticatedTitle(button);
      if (button.dataset.busy !== '1') {
        button.disabled = button.dataset.quotaUnavailable === 'true';
      }
    });
    const vpnButton = safeGetEl('VPN-switch');
    restoreAuthenticatedTitle(vpnButton);
    if (vpnButton && vpnButton.dataset.busy !== '1') {
      vpnButton.disabled = false;
    }
    return;
  }

  document.querySelectorAll('.open-wool-platform-btn').forEach((button) => {
    if (button.dataset.busy !== '1') {
      if (button.title !== '登录后使用羊毛资源') {
        button.dataset.authenticatedTitle = button.title || '';
      }
      button.disabled = false;
      button.title = '登录后使用羊毛资源';
    }
  });

  const vpnButton = safeGetEl('VPN-switch');
  if (vpnButton && vpnButton.dataset.busy !== '1') {
    if (vpnButton.title !== '登录后使用网络魔法') {
      vpnButton.dataset.authenticatedTitle = vpnButton.title || '';
    }
    vpnButton.disabled = false;
    vpnButton.title = '登录后使用网络魔法';
  }
}

// 设置/更新/持久化：applyFeatureAvailability的具体业务逻辑。
function applyFeatureAvailability({
  licenseRequiredDisabled = true,
  vpnDisabled = true,
  accountTabDisabled = true,
} = {}) {
  setLicenseRequiredButtonsDisabled(licenseRequiredDisabled);
  // 主开关必须始终可作为登录入口；测速等二级操作仍由代理运行状态控制。
  setButtonsDisabled('.VPN-btn:not(#VPN-switch)', vpnDisabled);
  setAccountTabDisabled(accountTabDisabled);
  syncLatencyButtonState();
  syncLoggedOutProtectedEntryAvailability();
}

// 设置/更新/持久化：setDreamButtonPlatformName的具体业务逻辑。
function setDreamButtonPlatformName(platformName) {
  const normalized = String(platformName || '').trim();
  if (!normalized) return;
  currentPlatformName = normalized;
  const dreamBtn = safeGetEl('open-dream-page-btn');
  if (dreamBtn) {
    dreamBtn.dataset.baseLabel = `一键启动 ${normalized}`;
    dreamBtn.dataset.platform = normalized;
    applyWoolPlatformButtonLabel(dreamBtn);
  }
}

function firstWoolPlatformText(source, fields) {
  for (const field of fields) {
    const value = String(source[field] || '').trim();
    if (value) return value;
  }
  return '';
}

function normalizeWoolPlatformButtonInput(item) {
  const source = item && typeof item === 'object' ? item : {};
  const rawSubUrls = Array.isArray(source.subUrls) ? source.subUrls : source.sub_urls;
  const subUrls = Array.isArray(rawSubUrls)
    ? rawSubUrls.map(url => String(url || '').trim()).filter(Boolean)
    : [];
  const targetUrl = firstWoolPlatformText(source, ['targetUrl', 'target_url']) || subUrls[0] || '';
  return {
    name: firstWoolPlatformText(source, ['name', 'platform', 'platform_name']),
    targetUrl,
    subUrls,
    launchOnly: source.launchOnly === true || source.launch_only === true,
    permissionGranted: source.permissionGranted === true || source.permission_granted === true,
    quota: source.quota && typeof source.quota === 'object' ? source.quota : null,
  };
}

// 渲染/刷新：按当前用户获准的羊毛平台生成独立启动按钮。
function renderWoolPlatformButtons(platforms) {
  const container = safeGetEl('wool-platform-buttons');
  if (!container) return;
  const items = (Array.isArray(platforms) ? platforms : [])
    .map(normalizeWoolPlatformButtonInput)
    .filter((item) => item.name && item.targetUrl && item.permissionGranted);

  const sectionTitle = safeGetEl('wool-resource-title');
  if (sectionTitle) sectionTitle.hidden = items.length === 0;

  container.innerHTML = '';
  container.hidden = items.length === 0;
  woolPlatformQuotaText.clear();
  items.forEach((item) => {
    const quotaText = formatWoolPlatformQuotaText(item.quota);
    if (quotaText) woolPlatformQuotaText.set(item.name, quotaText);
  });
  if (!items.length) {
    return;
  }

  items.forEach((item, index) => {
    const button = document.createElement('button');
    if (index === 0) button.id = 'open-dream-page-btn';
    button.type = 'button';
    button.className = 'main-button btn-large-blue requires-license open-wool-platform-btn';
    button.dataset.platform = item.name;
    button.dataset.targetUrl = item.targetUrl;
    button.dataset.subUrls = JSON.stringify(item.subUrls);
    button.dataset.launchOnly = item.launchOnly ? 'true' : 'false';
    button.dataset.baseLabel = `一键启动 ${item.name}`;
    applyWoolPlatformButtonLabel(button);
    const quotaUnavailable = !item.launchOnly && (item.quota?.expired === true || item.quota?.exhausted === true);
    button.dataset.quotaUnavailable = quotaUnavailable ? 'true' : 'false';
    button.disabled = quotaUnavailable;
    if (item.quota?.account_type) button.title = `账号类型：${item.quota.account_type}`;
    container.appendChild(button);
  });
  syncLoggedOutProtectedEntryAvailability();
}

// 设置/更新/持久化：setTutorialLinkHref的具体业务逻辑。
function setTutorialLinkHref(tutorialUrl) {
  const normalized = String(tutorialUrl || '').trim();
  const tutorialEntries = [safeGetEl('tutorial-link'), safeGetEl('browser-settings-tutorial')].filter(Boolean);
  tutorialEntries.forEach((tutorialLink) => {
    if (normalized) {
      tutorialLink.setAttribute('href', normalized);
      tutorialLink.dataset.tutorialUrl = normalized;
      tutorialLink.removeAttribute('aria-disabled');
      tutorialLink.title = '打开服务器下发的教程链接';
    } else {
      tutorialLink.removeAttribute('href');
      tutorialLink.dataset.tutorialUrl = '';
      tutorialLink.setAttribute('aria-disabled', 'true');
      tutorialLink.title = '教程链接尚未同步';
    }
  });
}

// 设置/更新/持久化：setTargetUrl的具体业务逻辑。
function setTargetUrl(nextTargetUrl) {
  DREAM_URL = String(nextTargetUrl || '').trim() || 'https://dreamina.capcut.com/ai-tool/home?';
  const buttons = document.querySelectorAll('.open-wool-platform-btn');
  if (buttons.length === 1 && !String(buttons[0].dataset.targetUrl || '').trim()) {
    buttons[0].dataset.targetUrl = DREAM_URL;
  }
}

// 设置/更新/持久化：根据账号登录状态刷新功能按钮可用性。
// 参数保留以兼容既有调用点；语义为“服务可用”（HTTP 通信下恒为可用），
// 实际是否放开功能取决于账号是否已登录。
function updateButtonStatesBasedOnConnection(available) {
  if (available) {
    if (isLicenseValidated()) {
      applyFeatureAvailability({
        licenseRequiredDisabled: false,
        vpnDisabled: false,
        accountTabDisabled: false,
      });
    } else {
      applyFeatureAvailability();
    }
  } else {
    applyFeatureAvailability({
      licenseRequiredDisabled: true,
      vpnDisabled: !isLicenseValidated(),
      accountTabDisabled: true,
    });

  }
}

// 设置/更新/持久化：enableAllLicenseRequiredButtons的具体业务逻辑。
function enableAllLicenseRequiredButtons() {
  setLicenseRequiredButtonsDisabled(false);
  setButtonsDisabled('.VPN-btn', false);
  setAccountTabDisabled(false);
  syncLatencyButtonState();
}

// 渲染/刷新：根据账号登录状态刷新功能可用性。
function refreshFeatureAvailability() {
  updateButtonStatesBasedOnConnection(true);
}

// 渲染/刷新：refreshPlatformName的具体业务逻辑。
async function refreshPlatformName() {
  try {
    const platformName = await window.aiFree.content.getPlatformName();
    setDreamButtonPlatformName(platformName);
    return platformName;
  } catch (error) {
    console.error('[侧边栏] 获取平台名字失败:', error);
    return '';
  }
}

// 获取/读取/解析：从主进程缓存恢复“平台名 + 目标地址”，避免错过登录阶段的推送事件。
async function refreshWoolPlatforms() {
  try {
    const woolPlatforms = await window.aiFree.content.getWoolPlatforms();
    renderWoolPlatformButtons(Array.isArray(woolPlatforms) ? woolPlatforms : []);
    return Array.isArray(woolPlatforms) ? woolPlatforms : [];
  } catch (error) {
    console.error('[侧边栏] 获取羊毛平台列表失败:', error);
    return [];
  }
}

// 渲染/刷新：refreshTutorialUrl的具体业务逻辑。
async function refreshTutorialUrl() {
  try {
    const tutorialUrl = await window.aiFree.content.getTutorialUrl();
    setTutorialLinkHref(tutorialUrl);
  } catch (error) {
    console.error('[侧边栏] 获取教程链接失败:', error);
  }
}

// 渲染/刷新：refreshTargetUrl的具体业务逻辑。
async function refreshTargetUrl() {
  try {
    const targetUrl = await window.aiFree.content.getTargetUrl();
    setTargetUrl(targetUrl);
  } catch (error) {
    console.error('[侧边栏] 获取目标链接失败:', error);
    setTargetUrl('');
  }
}

// 兼容旧调用名：不再查询连接状态，仅按账号登录状态刷新功能按钮。
async function refreshConnectionState() {
  refreshFeatureAvailability();
  return null;
}

// 同步/连接：bindRuntimeValueListeners的具体业务逻辑。
function bindRuntimeValueListeners() {
  const contentApi = window.aiFree && window.aiFree.content;
  if (!contentApi) return;
  contentApi.onPlatformNameUpdated((data) => {
    try {
      const platformName = data && data.platformName;
      if (!platformName) return;
      setDreamButtonPlatformName(platformName);
      if (Array.isArray(data?.woolPlatforms)) renderWoolPlatformButtons(data.woolPlatforms);
      void refreshTutorialUrl();
    } catch (e) {
      console.warn('[侧边栏] 处理平台名称更新事件失败:', e?.message || e);
    }
  });

  contentApi.onWoolPlatformsUpdated((data) => {
    renderWoolPlatformButtons(data?.woolPlatforms || []);
  });

  contentApi.onTutorialUrlUpdated((data) => {
    try {
      const tutorialUrl = data && data.tutorialUrl;
      if (typeof tutorialUrl !== 'string') return;
      setTutorialLinkHref(tutorialUrl);
    } catch (e) {
      console.warn('[侧边栏] 处理教程链接更新事件失败:', e?.message || e);
    }
  });

  contentApi.onTargetUrlUpdated((data) => {
    try {
      const targetUrl = data && data.targetUrl;
      if (!targetUrl || typeof targetUrl !== 'string') return;
      setTargetUrl(targetUrl);
    } catch (e) {
      console.warn('[侧边栏] 处理目标链接更新事件失败:', e?.message || e);
    }
  });

}

// 获取/读取/解析：loadInitialConnectionState的具体业务逻辑。
// 保留函数名以兼容初始化流程；现仅按账号登录状态刷新功能可用性。
function loadInitialConnectionState() {
  setTimeout(() => {
    refreshFeatureAvailability();
  }, 500);
}

// 获取/读取/解析：loadInitialRuntimeValues的具体业务逻辑。
function loadInitialRuntimeValues() {
  if (!window.aiFree?.content) {
    return;
  }

  void refreshWoolPlatforms();
  void refreshPlatformName().then(() => refreshTutorialUrl());
  void refreshTargetUrl();
}
