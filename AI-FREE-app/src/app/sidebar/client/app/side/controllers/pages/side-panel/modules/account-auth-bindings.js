function bindAccountDialogControls() {
  safeGetEl('sidebar-auth-mode-switch')?.addEventListener('click', (event) => {
    setSidebarAuthMode(event.currentTarget?.dataset.targetMode);
  });
  document.querySelectorAll('[data-vip-benefits-close]').forEach((element) => element.addEventListener('click', closeVipBenefitsDialog));
  safeGetEl('account-profile-avatar')?.addEventListener('click', toggleAccountProfileMenu);
  safeGetEl('account-profile-menu')?.addEventListener('click', (event) => event.stopPropagation());
  document.addEventListener('click', closeAccountProfileMenu);
  document.addEventListener('keydown', closeAccountDialogOnEscape);
}

function closeAccountDialogOnEscape(event) {
  if (event.key !== 'Escape') return;
  if (safeGetEl('vip-benefits-dialog')?.hidden === false) closeVipBenefitsDialog();
}

function bindVipPlanControls() {
  safeGetEl('vip-plan-list')?.addEventListener('click', (event) => {
    const option = event.target?.closest?.('.vip-plan-option');
    if (option?.dataset?.vipPlan) selectVipPlan(option.dataset.vipPlan);
  });
  safeGetEl('vip-tier-tabs')?.addEventListener('click', (event) => {
    const tierButton = event.target?.closest?.('[data-vip-tier]');
    if (tierButton?.dataset?.vipTier) renderVipPlanTier(tierButton.dataset.vipTier);
  });
  safeGetEl('vip-use-gift-code')?.addEventListener('click', () => {
    closeVipBenefitsDialog();
    safeGetEl('unified-gift-code')?.focus?.();
  });
  safeGetEl('vip-gold-theme-action')?.addEventListener('click', activateVipGoldTheme);
  safeGetEl('account-vip-card')?.addEventListener('click', openVipAccountCenter);
  safeGetEl('unified-redeem-gift')?.addEventListener('click', redeemUnifiedGiftCode);
  safeGetEl('unified-gift-code')?.addEventListener('keydown', redeemGiftCodeOnEnter);
}

function activateVipGoldTheme() {
  const status = safeGetEl('vip-plan-status');
  if (window.isSidebarVipActive?.() !== true) {
    if (status) status.textContent = '土豪金主题为 VIP 专属权益，请先开通 VIP';
    return;
  }
  document.documentElement.classList.remove('theme-light');
  document.documentElement.classList.add('theme-gold');
  document.documentElement.dataset.theme = 'gold';
  try { localStorage.setItem('ai-free.control-panel.theme', 'gold'); } catch (_) {}
  window.aiFree?.ui?.emitAppThemeChanged?.('gold');
  if (status) status.textContent = '土豪金主题已启用';
}

function redeemGiftCodeOnEnter(event) {
  if (event.key === 'Enter') void redeemUnifiedGiftCode();
}

function bindAccountAuthControls() {
  safeGetEl('sidebar-auth-submit')?.addEventListener('click', submitSidebarAccountAuth);
  safeGetEl('sidebar-device-login')?.addEventListener('click', submitSidebarDeviceLogin);
  safeGetEl('account-logout-btn')?.addEventListener('click', logoutSidebarAccount);
  ['sidebar-auth-username', 'sidebar-auth-password', 'sidebar-auth-password-confirm'].forEach((id) => {
    safeGetEl(id)?.addEventListener('keydown', submitAccountAuthOnEnter);
  });
}

function submitAccountAuthOnEnter(event) {
  if (event.key === 'Enter') void submitSidebarAccountAuth();
}

function subscribeAccountApi(api, method, handler) {
  if (api && typeof api[method] === 'function') api[method](handler);
}

function bindAccountApiEvents() {
  const rootApi = window.aiFree || {};
  subscribeAccountApi(rootApi.account, 'onSessionUpdated', handleAccountSessionUpdate);
  subscribeAccountApi(rootApi.ui, 'onOpenAccountCenter', openAccountCenterPanel);
  subscribeAccountApi(rootApi.license, 'onVipAccessRequired', openVipAccountCenter);
  subscribeAccountApi(rootApi.license, 'onOpenVipPlans', handleOpenVipPlans);
}

function handleAccountSessionUpdate(session = {}) {
  renderSidebarAccountSession(session);
  if (vipPlansOpenRequested && session.authenticated === true) openVipBenefitsDialog();
}

function handleOpenVipPlans() {
  openVipAccountCenter();
}

function initializeAccountSessionView() {
  setSidebarAuthMode('login');
  window.aiFree?.account?.getSession?.().then((session) => {
    renderSidebarAccountSession(session || {});
  }).catch(() => {
    renderSidebarAccountSession({ authenticated: false });
  });
}

function bindSidebarAccountAuth() {
  const modal = safeGetEl('sidebar-account-auth');
  if (!modal || modal.dataset.bound === '1') return;
  modal.dataset.bound = '1';
  bindAccountDialogControls();
  bindVipPlanControls();
  bindAccountAuthControls();
  bindAccountApiEvents();
  initializeAccountSessionView();
}
