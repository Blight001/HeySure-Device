function closeVipBenefitsDialog() {
  const dialog = safeGetEl('vip-benefits-dialog');
  if (!dialog || dialog.hidden) return;
  dialog.hidden = true;
  dialog.setAttribute('aria-hidden', 'true');
}

function applyVipComparisonColumns(element, tierCount) {
  if (!element) return;
  element.style.gridTemplateColumns = `minmax(90px, 1.25fr) minmax(54px, .8fr) repeat(${Math.max(1, tierCount)}, minmax(64px, .8fr))`;
}

function renderVipPermissionComparison(items = [], tiers = []) {
  const container = safeGetEl('vip-permission-rows');
  const table = safeGetEl('vip-permission-table');
  const tierList = Array.isArray(tiers) ? tiers : [];
  const comparisonItems = Array.isArray(items) ? items.filter((item) => (
    item?.code !== 'weekly_wool_quota'
    || tierList.some((tier) => Number(tier?.weekly_wool_quota || 0) > 0)
  )) : [];
  const hasComparison = Boolean(container && comparisonItems.length && tierList.length);
  if (table) table.hidden = !hasComparison;
  if (!hasComparison) {
    container?.replaceChildren();
    return;
  }
  const head = safeGetEl('vip-permission-head');
  if (head) {
    const labels = ['功能', '普通', ...tierList.map((item) => String(item.display_name || item.tier || '会员'))];
    head.replaceChildren(...labels.map((label) => {
      const cell = document.createElement('strong');
      cell.textContent = label;
      return cell;
    }));
    applyVipComparisonColumns(head, tierList.length);
  }
  container.replaceChildren(...comparisonItems.map((item) => {
    const row = document.createElement('div');
    row.className = 'vip-permission-row';
    const name = document.createElement('span');
    const free = document.createElement('span');
    name.textContent = String(item?.name || 'VIP 权益');
    free.textContent = String(item?.free || '-');
    const tierCells = tierList.map((tier) => {
      const cell = document.createElement('strong');
      cell.textContent = String(item?.tiers?.[tier.tier] ?? item?.[tier.tier] ?? '-');
      return cell;
    });
    row.append(name, free, ...tierCells);
    applyVipComparisonColumns(row, tierList.length);
    return row;
  }));
}

function selectVipPlan(code) {
  selectedVipPlanCode = String(code || `${selectedVipTier}_quarterly`);
  document.querySelectorAll('.vip-plan-option').forEach((button) => {
    button.classList.toggle('is-selected', button.dataset.vipPlan === selectedVipPlanCode);
  });
  const selected = document.querySelector(`.vip-plan-option[data-vip-plan="${selectedVipPlanCode}"]`);
  const status = safeGetEl('vip-plan-status');
  if (status && selected) {
    status.textContent = `已选择 ${selected.querySelector('span')?.textContent || 'VIP 套餐'}，请使用对应礼品码开通`;
  }
}

function renderVipPlanTier(tier) {
  const requestedTier = String(tier || '').trim().toLowerCase();
  selectedVipTier = vipTierCatalog.some((item) => item.tier === requestedTier)
    ? requestedTier
    : (vipTierCatalog[0]?.tier || 'vip');
  document.querySelectorAll('#vip-tier-tabs [data-vip-tier]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.vipTier === selectedVipTier);
  });
  const list = safeGetEl('vip-plan-list');
  const plans = vipPlanCatalog.filter((plan) => plan.tier === selectedVipTier);
  if (list) {
    list.hidden = plans.length === 0;
    if (!plans.length) {
      list.replaceChildren();
    } else list.replaceChildren(...plans.map((plan) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `vip-plan-option${plan.billing_cycle === 'quarterly' ? ' is-recommended' : ''}`;
      button.dataset.vipPlan = String(plan.code || '');
      if (plan.billing_cycle === 'quarterly') {
        const badge = document.createElement('em');
        badge.textContent = '推荐';
        button.appendChild(badge);
      }
      const name = document.createElement('span');
      const price = document.createElement('strong');
      const duration = document.createElement('small');
      name.textContent = String(plan.name || '会员套餐');
      price.textContent = `¥${Number(plan.price_cents || 0) / 100}`;
      duration.textContent = `${Number(plan.duration_days || 0)} 天`;
      button.append(name, price, duration);
      return button;
    }));
  }
  const preferred = plans.find((plan) => plan.code === selectedVipPlanCode)
    || plans.find((plan) => plan.billing_cycle === 'quarterly') || plans[0];
  if (preferred) selectVipPlan(preferred.code);
}

function renderVipTierTabs() {
  const tabs = safeGetEl('vip-tier-tabs');
  if (!tabs) return;
  tabs.hidden = vipTierCatalog.length === 0;
  tabs.replaceChildren(...vipTierCatalog.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.vipTier = String(item.tier || 'vip');
    button.textContent = String(item.display_name || item.tier || '会员');
    return button;
  }));
  if (vipTierCatalog.length) tabs.style.gridTemplateColumns = `repeat(${vipTierCatalog.length}, minmax(72px, 1fr))`;
}

function renderVipMembershipTitle(membership) {
  if (!membership || membership.is_vip !== true || !membership.vip_tier) return;
  const tier = membership.vip_tier;
  const catalogItem = vipTierCatalog.find((item) => item.tier === tier);
  const activeName = (catalogItem && catalogItem.display_name) || tier.toUpperCase();
  const title = safeGetEl('account-vip-title');
  if (title) title.textContent = `${activeName} 已开通`;
}

function renderVipThemeAction(vipActive) {
  const themeAction = safeGetEl('vip-gold-theme-action');
  if (!themeAction) return;
  themeAction.classList.toggle('is-locked', !vipActive);
  themeAction.title = vipActive ? '立即切换土豪金主题' : '开通 VIP 后解锁土豪金主题';
}

function renderVipPlans(result = {}) {
  vipPlanCatalog = Array.isArray(result.plans) ? result.plans : [];
  vipTierCatalog = Array.isArray(result.tiers) ? result.tiers : [];
  renderVipPermissionComparison(result.permission_comparison, vipTierCatalog);
  renderVipTierTabs();
  const membership = result.membership || {};
  const activeTier = membership.vip_tier;
  renderVipMembershipTitle(membership);
  renderVipPlanTier(activeTier || selectedVipTier);
  const isSidebarVipActive = typeof window.isSidebarVipActive === 'function' && window.isSidebarVipActive() === true;
  renderVipThemeAction(membership.is_vip === true || isSidebarVipActive);
}

async function loadVipPlans() {
  const status = safeGetEl('vip-plan-status');
  if (status) status.textContent = '正在读取服务器套餐与价格…';
  try {
    const result = await window.aiFree.license.getVipPlans();
    if (!result?.ok) throw new Error(result?.message || 'VIP 套餐暂时不可用');
    renderVipPlans(result);
    if (result.weekly_grant?.granted && status) {
      status.textContent = '本周会员 AI、网络魔法与羊毛额度已到账';
    }
  } catch (error) {
    if (status) status.textContent = error?.message || '套餐价格读取失败，当前显示默认价格';
  }
}

function openVipBenefitsDialog() {
  const dialog = safeGetEl('vip-benefits-dialog');
  if (!dialog) return;
  if (!isSidebarAccountAuthenticated()) {
    openSidebarAccountAuth('login');
    return;
  }
  vipPlansOpenRequested = false;
  dialog.hidden = false;
  dialog.setAttribute('aria-hidden', 'false');
  selectVipPlan(selectedVipPlanCode);
  void loadVipPlans();
  setTimeout(() => dialog.querySelector('.vip-benefits-close')?.focus?.(), 0);
}

function openVipAccountCenter() {
  vipPlansOpenRequested = true;
  openAccountCenterPanel();
  if (isSidebarAccountAuthenticated()) openVipBenefitsDialog();
}

function renderVipCardCopy(vip, title, description, action) {
  if (title) title.textContent = vip.active ? `${String(vip.tier || 'vip').toUpperCase()} 已开通` : '开通会员';
  if (description) {
    description.textContent = vip.active
      ? (vip.permanent ? '永久有效' : `有效期至 ${vip.expiryDate}`)
      : '无限浏览器窗口 · 自定义插件和模型';
  }
  if (action) action.textContent = vip.active ? '已解锁' : '立即开通';
}

function renderAccountVipState(session = {}) {
  const vip = resolveSidebarVipState(session);
  const profile = safeGetEl('sidebar-account-session');
  const card = safeGetEl('account-vip-card');
  const title = safeGetEl('account-vip-title');
  const description = safeGetEl('account-vip-description');
  const action = card && typeof card.querySelector === 'function' ? card.querySelector('.account-vip-action') : null;
  if (profile) profile.dataset.vip = vip.active ? 'true' : 'false';
  if (card) card.dataset.active = vip.active ? 'true' : 'false';
  renderVipCardCopy(vip, title, description, action);
  return vip;
}

window.isSidebarVipActive = (session) => session
  ? resolveSidebarVipState(session).active
  : safeGetEl('sidebar-account-session')?.dataset.vip === 'true';
window.openVipAccountCenter = openVipAccountCenter;
window.openVipBenefitsDialog = openVipBenefitsDialog;
