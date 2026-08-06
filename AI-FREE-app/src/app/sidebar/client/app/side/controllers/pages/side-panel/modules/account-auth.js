// 个人中心账号资料卡、内嵌登录注册表单与会话切换。

let sidebarAccountAuthMode = 'login';
let sidebarAuthPreviousFocus = null;
let selectedVipPlanCode = 'vip_quarterly';
let selectedVipTier = 'vip';
let vipPlanCatalog = [];
let vipTierCatalog = [];
let vipPlansOpenRequested = false;

function invokeSidebarAccountAuth(payload, timeoutMs = 20000) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('登录请求超时，请检查服务器或重启软件后重试')), timeoutMs);
  });
  return Promise.race([
    window.aiFree.account.authenticate(payload),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function setSidebarAuthStatus(message = '', type = '') {
  const status = safeGetEl('sidebar-auth-status');
  if (!status) return;
  status.textContent = String(message || '');
  status.dataset.type = type;
}

function setSidebarAuthMode(mode) {
  sidebarAccountAuthMode = mode === 'register' ? 'register' : 'login';
  const registering = sidebarAccountAuthMode === 'register';
  const modeSwitch = safeGetEl('sidebar-auth-mode-switch');
  const modeLabel = safeGetEl('sidebar-auth-mode-label');
  if (modeSwitch) {
    modeSwitch.dataset.targetMode = registering ? 'login' : 'register';
    modeSwitch.setAttribute('aria-label', registering ? '切换到登录' : '切换到注册');
  }
  if (modeLabel) modeLabel.textContent = registering ? '去登录' : '去注册';
  const confirmGroup = safeGetEl('sidebar-auth-confirm-group');
  if (confirmGroup) confirmGroup.hidden = !registering;

  const password = safeGetEl('sidebar-auth-password');
  if (password) password.autocomplete = registering ? 'new-password' : 'current-password';
  const submit = safeGetEl('sidebar-auth-submit');
  if (submit) {
    submit.textContent = registering ? '注册并登录' : '登录';
    submit.dataset.loadingText = registering ? '注册中...' : '登录中...';
  }
  setSidebarAuthStatus('');
}

function openSidebarAccountAuth(mode = 'login') {
  const panel = safeGetEl('sidebar-account-auth');
  if (!panel) return;
  if (panel.hidden) sidebarAuthPreviousFocus = document.activeElement;
  setSidebarAuthMode(mode);
  panel.hidden = false;
  panel.setAttribute('aria-hidden', 'false');
  if (safeGetEl('account-center-panel')?.classList.contains('active')) {
    setTimeout(() => safeGetEl('sidebar-auth-username')?.focus(), 0);
  }
}

function closeSidebarAccountAuth() {
  const panel = safeGetEl('sidebar-account-auth');
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  panel.setAttribute('aria-hidden', 'true');
  const password = safeGetEl('sidebar-auth-password');
  const confirmation = safeGetEl('sidebar-auth-password-confirm');
  if (password) password.value = '';
  if (confirmation) confirmation.value = '';
  setSidebarAuthStatus('');
  sidebarAuthPreviousFocus?.focus?.();
  sidebarAuthPreviousFocus = null;
}

function openAccountCenterPanel() {
  if (!safeGetEl('account-center-panel')) {
    if (document.documentElement?.classList?.contains('ai-control-page')) {
      try { sessionStorage.setItem('ai-free.account-center.open-login', 'true'); } catch (_) {}
      location.assign('./account-center.html');
      return;
    }
    window.aiFree?.ui?.requestAccountCenter?.();
    return;
  }
  window.activateSidebarPanel?.('account-center-panel');
  if (!isSidebarAccountAuthenticated()) openSidebarAccountAuth('login');
}

function isSidebarAccountAuthenticated() {
  const profile = safeGetEl('sidebar-account-session');
  if (profile) return profile.dataset.authenticated === 'true';
  return document.documentElement.dataset.accountAuthenticated === 'true';
}

// 返回 true 表示本次操作已被登录门禁接管，只切换侧边栏栏目，
// 不发起任何业务服务器请求。
async function redirectToSidebarAccountLogin() {
  if (isSidebarAccountAuthenticated()) return false;
  if (!safeGetEl('sidebar-account-session')) {
    const session = await window.aiFree?.account?.getSession?.().catch(() => null);
    const authenticated = session?.authenticated === true;
    document.documentElement.dataset.accountAuthenticated = String(authenticated);
    if (authenticated) return false;
  }
  openAccountCenterPanel();
  return true;
}

window.openAccountCenterPanel = openAccountCenterPanel;
window.isSidebarAccountAuthenticated = isSidebarAccountAuthenticated;
window.redirectToSidebarAccountLogin = redirectToSidebarAccountLogin;

document.addEventListener?.('DOMContentLoaded', () => {
  if (!safeGetEl('account-center-panel')) return;
  let shouldOpenLogin = false;
  try {
    shouldOpenLogin = sessionStorage.getItem('ai-free.account-center.open-login') === 'true';
    sessionStorage.removeItem('ai-free.account-center.open-login');
  } catch (_) {}
  if (shouldOpenLogin && !isSidebarAccountAuthenticated()) openSidebarAccountAuth('login');
});

function collectSidebarVipSources(session) {
  const validation = session.validation && typeof session.validation === 'object' ? session.validation : {};
  return [validation.result, validation, session.result, session, session.account]
    .filter((item) => item && typeof item === 'object');
}

function readSidebarVipStatus(sources) {
  const statusKeys = ['is_vip', 'isVip', 'vip_active', 'vipActive'];
  for (const source of sources) {
    if (!statusKeys.some((key) => Object.prototype.hasOwnProperty.call(source, key))) continue;
    return statusKeys.some((key) => source[key] === true || Number(source[key]) === 1);
  }
  return false;
}

function readSidebarVipMetadata(sources) {
  let expiryDate = '';
  let tier = 'vip';
  for (const source of sources) {
    const candidate = String(source.vip_expiry_date || source.vipExpiryDate || '').trim();
    if (!expiryDate && candidate) expiryDate = candidate;
    const candidateTier = String(source.vip_tier || source.vipTier || '').trim().toLowerCase();
    if (/^[a-z][a-z0-9_-]{1,31}$/.test(candidateTier)) tier = candidateTier;
  }
  return { expiryDate, tier };
}

function resolveSidebarVipState(session = {}) {
  const sources = collectSidebarVipSources(session);
  const verification = sources.find((source) => source.vip_server_verified === true);
  const verifiedAt = Date.parse(String((verification && verification.vip_verified_at) || ''));
  const now = Date.now();
  const serverVerified = Number.isFinite(verifiedAt)
    && verifiedAt <= now + 60 * 1000
    && now - verifiedAt <= 10 * 60 * 1000;
  const enabled = readSidebarVipStatus(sources);
  const { expiryDate, tier } = readSidebarVipMetadata(sources);
  const expiresAt = expiryDate ? Date.parse(expiryDate.includes('T') ? expiryDate : expiryDate.replace(' ', 'T')) : null;
  const active = serverVerified && enabled
    && (expiresAt === null || (Number.isFinite(expiresAt) && expiresAt > now));
  return { active, tier: active ? tier : null, expiryDate, permanent: active && !expiryDate };
}
