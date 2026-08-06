function closeAccountProfileMenu() {
  const menu = safeGetEl('account-profile-menu');
  const avatar = safeGetEl('account-profile-avatar');
  if (menu) menu.hidden = true;
  if (avatar) avatar.setAttribute('aria-expanded', 'false');
}

function toggleAccountProfileMenu(event) {
  event?.stopPropagation?.();
  const profile = safeGetEl('sidebar-account-session');
  const menu = safeGetEl('account-profile-menu');
  const avatar = safeGetEl('account-profile-avatar');
  if (profile?.dataset.authenticated !== 'true' || !menu || !avatar) return;
  const opening = menu.hidden;
  menu.hidden = !opening;
  avatar.setAttribute('aria-expanded', opening ? 'true' : 'false');
}

function formatAccountUsageNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '--';
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 }).format(Math.max(0, number));
}

function setAccountUsageText(id, value) {
  const element = safeGetEl(id);
  if (element) element.textContent = value;
}

/** 根据剩余比例返回状态：pending | unlimited | ok | warn | critical | exhausted */
function resolveAccountUsageStatus({ hasData, unlimited, exhausted, remainingRatio }) {
  if (!hasData) return 'pending';
  if (unlimited) return 'unlimited';
  if (exhausted) return 'exhausted';
  if (!Number.isFinite(remainingRatio)) return 'ok';
  if (remainingRatio <= 0) return 'exhausted';
  if (remainingRatio <= 0.1) return 'critical';
  if (remainingRatio <= 0.25) return 'warn';
  return 'ok';
}

function setAccountUsageStatus(cardSelector, badgeId, status, label) {
  const card = document.querySelector(cardSelector);
  const badge = safeGetEl(badgeId);
  if (card) card.dataset.status = status;
  if (badge) {
    badge.dataset.status = status;
    badge.textContent = label;
  }
}

function formatAccountUsagePercent(ratio) {
  if (!Number.isFinite(ratio)) return '--';
  const percent = Math.max(0, Math.min(100, ratio * 100));
  if (percent > 0 && percent < 0.1) return '<0.1%';
  if (percent >= 99.95 && percent < 100) return '99.9%';
  return `${percent.toFixed(percent >= 10 || percent === 0 ? 0 : 1)}%`;
}

function setAccountUsageProgress(barId, percent, status) {
  const bar = safeGetEl(barId);
  if (!bar) return;
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  bar.style.width = `${clamped}%`;
  bar.dataset.status = status;
}

function renderAccountProxyTrafficUsage(quota) {
  const usage = quota && typeof quota === 'object' ? quota : null;
  const unlimited = Boolean(usage && usage.unlimited);
  const exhausted = Boolean(usage && usage.exhausted);
  const ratios = resolveUsageRatios({
    total: usage ? Number(usage.quota_bytes) : NaN,
    remaining: usage ? Number(usage.remaining_bytes) : NaN,
    used: usage ? Number(usage.used_bytes) : NaN,
    unlimited,
    exhausted,
  });
  const status = resolveAccountUsageStatus({
    hasData: Boolean(usage), unlimited, exhausted, remainingRatio: ratios.remaining,
  });
  const statusLabel = resolveUsageStatusLabel(Boolean(usage), unlimited, status);

  setAccountUsageStatus('.account-traffic-usage', 'account-traffic-status', status, statusLabel);
  setAccountUsageProgress('account-traffic-progress', resolveUsageProgress(unlimited, ratios.remaining), status);
  setAccountUsageText('account-traffic-percent', formatUsagePercent(usage, unlimited, ratios.used));
  setAccountUsageText('account-traffic-total', formatTrafficQuotaValue(usage, unlimited, 'quota_bytes'));
  setAccountUsageText('account-traffic-remaining', formatTrafficQuotaValue(usage, unlimited, 'remaining_bytes'));
  setAccountUsageText('account-traffic-used', usage ? formatProxyTrafficBytes(usage.used_bytes) : '--');
  setAccountUsageText('account-traffic-upload', usage ? formatProxyTrafficBytes(usage.upload_used_bytes) : '--');
  setAccountUsageText('account-traffic-download', usage ? formatProxyTrafficBytes(usage.download_used_bytes) : '--');
}

function renderAccountAiUsage(quota) {
  const normalized = window.AiFreeQuotaDisplay?.normalizeAIQuota?.(quota) || quota;
  const usage = normalized && typeof normalized === 'object' ? normalized : null;
  const unlimited = Boolean(usage && usage.unlimited);
  const total = usage ? Number(usage.quota) : NaN;
  const used = usage ? Number(usage.used) : NaN;
  const remaining = usage ? Number(usage.remaining ?? (total - used)) : NaN;
  const exhausted = !unlimited && (Number.isFinite(remaining) ? remaining <= 0 : false);
  const ratios = resolveUsageRatios({ total, remaining, used, unlimited, exhausted });
  const status = resolveAccountUsageStatus({
    hasData: Boolean(usage), unlimited, exhausted, remainingRatio: ratios.remaining,
  });
  const statusLabel = resolveUsageStatusLabel(Boolean(usage), unlimited, status);

  setAccountUsageStatus('.account-ai-usage', 'account-ai-status', status, statusLabel);
  setAccountUsageProgress('account-ai-progress', resolveUsageProgress(unlimited, ratios.remaining), status);
  setAccountUsageText('account-ai-percent', formatUsagePercent(usage, unlimited, ratios.used));
  setAccountUsageText('account-ai-total', formatAiQuotaValue(usage, unlimited, total));
  setAccountUsageText('account-ai-remaining', formatAiQuotaValue(usage, unlimited, remaining));
  setAccountUsageText('account-ai-used', usage ? `${formatAccountUsageNumber(used)} 点` : '--');
}

function resolveUsageRatios({ total, remaining, used, unlimited, exhausted }) {
  if (unlimited) return { remaining: 1, used: 0 };
  const hasTotal = Number.isFinite(total) && total > 0;
  return {
    remaining: hasTotal && Number.isFinite(remaining) ? remaining / total : (exhausted ? 0 : NaN),
    used: hasTotal && Number.isFinite(used) ? used / total : (exhausted ? 1 : NaN),
  };
}

function resolveUsageStatusLabel(hasData, unlimited, status) {
  if (!hasData) return '待同步';
  if (unlimited) return '不限量';
  if (status === 'exhausted') return '已用完';
  return ['critical', 'warn'].includes(status) ? '偏低' : '可用';
}

function resolveUsageProgress(unlimited, remainingRatio) {
  if (unlimited) return 8;
  return Number.isFinite(remainingRatio) ? remainingRatio * 100 : 0;
}

function formatUsagePercent(usage, unlimited, usedRatio) {
  if (!usage) return '--';
  return unlimited ? '—' : formatAccountUsagePercent(usedRatio);
}

function formatTrafficQuotaValue(usage, unlimited, key) {
  if (!usage) return '--';
  return unlimited ? '不限量' : formatProxyTrafficBytes(usage[key]);
}

function formatAiQuotaValue(usage, unlimited, value) {
  if (!usage) return '--';
  return unlimited ? '不限量' : `${formatAccountUsageNumber(value)} 点`;
}

window.renderAccountAiUsage = renderAccountAiUsage;

function renderSidebarAccountSession(session = {}) {
  const authenticated = session.authenticated === true;
  const username = authenticated ? String(session.username || '').trim() : '';
  applyAccountSessionElements(collectAccountSessionElements(), authenticated, username);
  applySidebarAuthenticatedAccess(authenticated, session);
  renderAccountVipState(authenticated ? session : {});
  if (typeof syncLoggedOutProtectedEntryAvailability === 'function') {
    syncLoggedOutProtectedEntryAvailability();
  }
  closeAccountProfileMenu();
  if (authenticated) renderAuthenticatedSidebarSession(session);
  else renderLoggedOutSidebarSession();
}

function collectAccountSessionElements() {
  return {
    profile: safeGetEl('sidebar-account-session'),
    usernameDisplay: safeGetEl('account-username-display'),
    usernameInput: safeGetEl('sidebar-auth-username'),
    profileName: safeGetEl('account-profile-name'),
    giftInput: safeGetEl('unified-gift-code'),
    giftButton: safeGetEl('unified-redeem-gift'),
    usageDetails: safeGetEl('account-usage-details'),
    vipCard: safeGetEl('account-vip-card'),
  };
}

function applyAccountSessionElements(elements, authenticated, username) {
  if (elements.profile) elements.profile.dataset.authenticated = authenticated ? 'true' : 'false';
  if (elements.vipCard) elements.vipCard.hidden = !authenticated;
  if (elements.usernameDisplay) elements.usernameDisplay.value = username;
  if (elements.usernameInput && username) elements.usernameInput.value = username;
  if (elements.profileName) elements.profileName.textContent = username || '未登录';
  updateGiftCodeInput(elements.giftInput, authenticated);
  if (elements.giftButton) elements.giftButton.disabled = !authenticated;
  if (elements.usageDetails) elements.usageDetails.hidden = !authenticated;
}

function applySidebarAuthenticatedAccess(authenticated, session) {
  if (authenticated && typeof applyAuthenticatedAccountFeatureAccess === 'function') {
    applyAuthenticatedAccountFeatureAccess(session);
  }
}

function updateGiftCodeInput(input, authenticated) {
  if (!input) return;
  input.disabled = !authenticated;
  input.placeholder = authenticated ? '输入兑换码' : '登录后输入兑换码';
  if (!authenticated) input.value = '';
}

function renderLoggedOutSidebarSession() {
  if (typeof setWoolPlatformRemainingUsage === 'function') setWoolPlatformRemainingUsage('');
  closeVipBenefitsDialog();
  renderAccountProxyTrafficUsage(null);
  renderAccountAiUsage(null);
  openSidebarAccountAuth(sidebarAccountAuthMode);
}

function renderAuthenticatedSidebarSession(session) {
  const account = session.account && typeof session.account === 'object' ? session.account : {};
  const validation = session.validation && typeof session.validation === 'object' ? session.validation : {};
  if (typeof displayExpirationInfo === 'function') displayExpirationInfo({ ...account, ...validation });
  closeSidebarAccountAuth();
  window.aiFree?.network?.getProxyTrafficQuota?.().then((result) => {
    if (result?.ok && result.quota && typeof renderProxyTrafficQuota === 'function') renderProxyTrafficQuota(result.quota);
  }).catch(() => {});
  window.aiFree?.ai?.getModels?.().then((result) => {
    if (result?.ok) renderAccountAiUsage(result.quota || null);
  }).catch(() => {});
}
