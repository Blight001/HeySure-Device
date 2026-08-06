const AppShellUtils = window.RendererControllerUtils || {};
const AiApi = window.aiFree?.ai || {};
const BrowserApi = window.aiFree?.browser || {};
const ShellApi = window.aiFree?.shell || {};
const UiApi = window.aiFree?.ui || {};
const UpdatesApi = window.aiFree?.updates || {};
const showControllerError = AppShellUtils.showUserError
  ? (prefix, err) => AppShellUtils.showUserError(`${prefix}: ${err && (err.message || String(err))}`)
  : (prefix, err) => console.warn(`[标签栏] ${prefix}:`, err && (err.message || String(err)));
const APP_THEME_STORAGE_KEY = 'ai-free.control-panel.theme';
const appShellUpdateState = { activated: false, version: '' };
let aiConnectedBrowserProfileIds = new Set();

function isAiConnectedBrowserProfile(tabId) {
  return aiConnectedBrowserProfileIds.has(String(tabId));
}

function syncAiConnectedBrowserHighlight() {
  for (const [tabId, tabElement] of tabElementById.entries()) {
    tabElement.classList.toggle('ai-browser-connected', isAiConnectedBrowserProfile(tabId));
  }
}

function normalizeAppTheme(theme) {
  const value = String(theme || '').trim();
  return value === 'light' || value === 'gold' ? value : 'dark';
}

function getSavedAppTheme() {
  try {
    return normalizeAppTheme(localStorage.getItem(APP_THEME_STORAGE_KEY));
  } catch (_) {
    return 'dark';
  }
}

function applyAppShellTheme(theme, options = {}) {
  const nextTheme = normalizeAppTheme(theme);
  const isLight = nextTheme === 'light';
  document.documentElement.classList.toggle('theme-light', isLight);
  document.documentElement.classList.toggle('theme-gold', nextTheme === 'gold');
  document.documentElement.dataset.theme = nextTheme;
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  if (themeToggleBtn) {
    themeToggleBtn.title = isLight ? '切换到深色模式' : '切换到白色模式';
    themeToggleBtn.setAttribute('aria-label', themeToggleBtn.title);
    themeToggleBtn.setAttribute('aria-pressed', String(isLight));
  }
  if (options.persist === true) {
    try {
      localStorage.setItem(APP_THEME_STORAGE_KEY, nextTheme);
    } catch (_) {}
  }
}

applyAppShellTheme(getSavedAppTheme());

if (window.aiFree) {
  UiApi.onAppThemeChanged( (theme) => {
    applyAppShellTheme(theme, { persist: true });
  });
  ShellApi.onIndependentBrowserCreateFailed( (payload = {}) => {
    if (String(payload?.tabId || '') === String(pendingRenameTabId || '')) pendingRenameTabId = null;
    finishIndependentBrowserCreation(payload);
    showControllerError('新建浏览器窗口失败', new Error(payload?.error || '浏览器环境启动失败'));
  });
  ShellApi.onIndependentBrowserCreateComplete( (payload = {}) => {
    finishIndependentBrowserCreation(payload);
  });
  UpdatesApi.onActivated( (payload = {}) => {
    appShellUpdateState.activated = true;
    renderAppShellUpdateProgress({ ...payload, phase: 'confirmed' });
  });
  UpdatesApi.onProgress( (payload = {}) => {
    renderAppShellUpdateProgress(payload);
  });
  UpdatesApi.onComplete( (payload = {}) => {
    appShellUpdateState.activated = true;
    renderAppShellUpdateProgress({ ...payload, phase: 'completed', percent: 100 });
  });
  UpdatesApi.onError( () => resetAppShellUpdateProgress());
  UpdatesApi.onSkip( () => resetAppShellUpdateProgress());
  AiApi.onBrowserSelectionChanged( (payload = {}) => {
    const ids = Array.isArray(payload?.profileIds)
      ? payload.profileIds
      : (payload?.profileId ? [payload.profileId] : []);
    aiConnectedBrowserProfileIds = new Set(ids.map((id) => String(id || '')).filter(Boolean));
    syncAiConnectedBrowserHighlight();
  });
}

let tabsContainer = document.getElementById('tabs-container');
let addTabBtn = document.getElementById('add-tab-btn');
let newBrowserWindowBtn = document.getElementById('new-browser-window-btn');

function setBrowserEmptyStateVisible(tabs = []) {
  window.AppShellHome?.setVisible(tabs);
}

function setBrowserEmptyStateSidebarVisible(visible) {
  document.documentElement.classList.toggle('sidebar-collapsed', visible !== true);
}

function setAppShellUpdateVisible(visible) {
  const widget = document.getElementById('update-widget');
  if (widget) widget.hidden = !visible;
}

function resetAppShellUpdateProgress() {
  appShellUpdateState.activated = false;
  appShellUpdateState.version = '';
  const ring = document.getElementById('update-widget-ring');
  const percent = document.getElementById('update-widget-percent');
  const widget = document.getElementById('update-widget');
  if (ring) ring.style.setProperty('--update-progress', '0%');
  if (percent) percent.textContent = '0%';
  if (widget) widget.title = '准备更新';
  setAppShellUpdateVisible(false);
}

function normalizeAppShellUpdatePayload(payload) {
  const phase = String(payload.phase || '').trim().toLowerCase();
  const rawPercent = Number(payload.percent);
  const percent = Number.isFinite(rawPercent)
    ? Math.max(0, Math.min(100, Math.round(rawPercent)))
    : (phase === 'completed' ? 100 : 0);
  const versionFields = ['version', 'targetVersion', 'latestVersion', 'latest_version'];
  const version = versionFields.map((field) => payload[field]).find(Boolean);
  return {
    phase,
    percent,
    version: String(version || '').trim(),
    message: String(payload.message || payload.content || '').trim(),
  };
}

function updateAppShellProgressElements(progress) {
  const ring = document.getElementById('update-widget-ring');
  const percent = document.getElementById('update-widget-percent');
  if (ring) ring.style.setProperty('--update-progress', `${progress}%`);
  if (percent) percent.textContent = `${progress}%`;
}

function renderAppShellUpdateProgress(payload = {}) {
  const normalized = normalizeAppShellUpdatePayload(payload);
  const { phase, percent: percentValue, version, message } = normalized;
  if (phase === 'error' || phase === 'failed' || phase === 'skip') {
    resetAppShellUpdateProgress();
    return;
  }
  if (!appShellUpdateState.activated && !['confirmed', 'downloading', 'opening', 'completed'].includes(phase)) {
    return;
  }

  if (version) appShellUpdateState.version = version;

  updateAppShellProgressElements(percentValue);
  const widget = document.getElementById('update-widget');
  if (widget) {
    const versionLabel = appShellUpdateState.version ? ` v${appShellUpdateState.version}` : '';
    widget.title = phase === 'completed'
      ? `更新${versionLabel}已下载完成`
      : (message || `正在更新${versionLabel}：${percentValue}%`);
  }
  setAppShellUpdateVisible(true);
}

function bindThemeToggleBtnOnce() {
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  if (!themeToggleBtn || themeToggleBtn.dataset.bound === '1') return;
  themeToggleBtn.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const currentTheme = document.documentElement.dataset.theme || 'dark';
    const nextTheme = currentTheme === 'light' ? 'dark' : 'light';
    applyAppShellTheme(nextTheme, { persist: true });
    UiApi.emitAppThemeChanged( nextTheme);
  });
  themeToggleBtn.dataset.bound = '1';
  applyAppShellTheme(document.documentElement.dataset.theme || 'dark');
}

// 监听/绑定：onReady的具体业务逻辑。
function onReady(fn) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
  else fn();
}

let toggleSidebarClickLock = false;
let draggedTabId = null;
let dragHoverTabId = null;
let dragHoverPosition = null;
const tabElementById = new Map();
let pendingRenameTabId = null;
let pendingBrowserCreationTabId = null;
let independentBrowserCreationPending = false;
const BROWSER_HISTORY_GESTURE_THRESHOLD = 32;
const browserHistoryGestureState = {
  pointerId: null,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
  active: false,
  selectedId: '',
  history: null,
  loading: false,
  loadToken: 0,
  popupLayout: null,
};
let suppressNewBrowserWindowClick = false;

function setIndependentBrowserCreationPending(pending) {
  independentBrowserCreationPending = pending === true;
  newBrowserWindowBtn = document.getElementById('new-browser-window-btn');
  if (newBrowserWindowBtn) {
    newBrowserWindowBtn.disabled = independentBrowserCreationPending;
    newBrowserWindowBtn.setAttribute('aria-busy', String(independentBrowserCreationPending));
  }
  const homeCreateButton = document.getElementById('browser-settings-create-browser');
  if (homeCreateButton) {
    homeCreateButton.disabled = independentBrowserCreationPending;
    homeCreateButton.setAttribute('aria-busy', String(independentBrowserCreationPending));
    homeCreateButton.querySelector('span').textContent = independentBrowserCreationPending
      ? '正在创建浏览器…'
      : '新建浏览器';
  }
}

function finishIndependentBrowserCreation(payload = {}) {
  const completedTabId = String(payload?.tabId || '').trim();
  if (pendingBrowserCreationTabId
    && completedTabId
    && completedTabId !== pendingBrowserCreationTabId) return;
  pendingBrowserCreationTabId = null;
  setIndependentBrowserCreationPending(false);
}

function updateBrowserHistoryGestureSelection(clientX, clientY) {
  const layout = browserHistoryGestureState.popupLayout;
  if (!layout || !browserHistoryGestureState.active) return;
  const insidePopup = clientX >= layout.x
    && clientX <= layout.x + layout.width
    && clientY >= layout.y
    && clientY <= layout.y + layout.height;
  const relativeY = clientY - layout.y;
  const selectedRow = insidePopup
    ? (Array.isArray(layout.rows) ? layout.rows : []).find((row) => relativeY >= row.top && relativeY <= row.bottom)
    : null;
  const selectedId = String(selectedRow?.id || '');
  if (selectedId === browserHistoryGestureState.selectedId) return;
  browserHistoryGestureState.selectedId = selectedId;
  ShellApi.updateBrowserHistoryGestureSelection( {
    historyId: selectedId,
  });
}

async function renderBrowserHistoryGesturePopup(loadToken) {
  const button = document.getElementById('new-browser-window-btn');
  if (!button || !browserHistoryGestureState.active) return;
  const buttonRect = button.getBoundingClientRect();
  const theme = document.documentElement.classList.contains('theme-light') ? 'light' : 'dark';
  try {
    const response = await ShellApi.showBrowserHistoryGesturePopup( {
      anchor: {
        left: buttonRect.left,
        top: buttonRect.top,
        right: buttonRect.right,
        bottom: buttonRect.bottom,
      },
      history: Array.isArray(browserHistoryGestureState.history) ? browserHistoryGestureState.history : [],
      theme,
    });
    if (loadToken !== browserHistoryGestureState.loadToken || !browserHistoryGestureState.active) {
      ShellApi.closeBrowserHistoryGesturePopup();
      return;
    }
    if (!response?.ok || !response.layout) throw new Error(response?.error || '显示浏览器历史失败');
    browserHistoryGestureState.popupLayout = response.layout;
    updateBrowserHistoryGestureSelection(browserHistoryGestureState.lastX, browserHistoryGestureState.lastY);
  } catch (error) {
    if (loadToken !== browserHistoryGestureState.loadToken || !browserHistoryGestureState.active) return;
    showControllerError('显示浏览器历史失败', error);
    finishBrowserHistoryPointer({ suppressClick: true });
  }
}

function showBrowserHistoryGesturePopup() {
  browserHistoryGestureState.active = true;
  browserHistoryGestureState.selectedId = '';
  browserHistoryGestureState.popupLayout = null;
  newBrowserWindowBtn?.classList.add('gesture-active');
}

function hideBrowserHistoryGesturePopup() {
  browserHistoryGestureState.active = false;
  browserHistoryGestureState.selectedId = '';
  browserHistoryGestureState.popupLayout = null;
  newBrowserWindowBtn?.classList.remove('gesture-active', 'gesture-armed');
  ShellApi.closeBrowserHistoryGesturePopup();
}

function finishBrowserHistoryPointer(options = {}) {
  const pointerId = browserHistoryGestureState.pointerId;
  browserHistoryGestureState.pointerId = null;
  browserHistoryGestureState.loadToken += 1;
  browserHistoryGestureState.loading = false;
  hideBrowserHistoryGesturePopup();
  if (newBrowserWindowBtn && pointerId !== null) {
    try {
      if (newBrowserWindowBtn.hasPointerCapture?.(pointerId)) {
        newBrowserWindowBtn.releasePointerCapture(pointerId);
      }
    } catch (_) {}
  }
  if (options.suppressClick === true) {
    suppressNewBrowserWindowClick = true;
    setTimeout(() => { suppressNewBrowserWindowClick = false; }, 0);
  }
}

async function loadBrowserHistoryForGesture(loadToken) {
  try {
    const response = await BrowserApi.getHistory();
    if (loadToken !== browserHistoryGestureState.loadToken || browserHistoryGestureState.pointerId === null) return;
    if (!response?.ok) throw new Error(response?.error || '读取浏览器历史失败');
    browserHistoryGestureState.history = Array.isArray(response.history) ? response.history : [];
  } catch (error) {
    if (loadToken !== browserHistoryGestureState.loadToken || browserHistoryGestureState.pointerId === null) return;
    browserHistoryGestureState.history = [];
    showControllerError('读取浏览器历史失败', error);
  } finally {
    if (loadToken !== browserHistoryGestureState.loadToken || browserHistoryGestureState.pointerId === null) return;
    browserHistoryGestureState.loading = false;
    if (browserHistoryGestureState.active) void renderBrowserHistoryGesturePopup(loadToken);
  }
}

async function openBrowserHistoryFromGesture(historyId) {
  if (!historyId) return;
  try {
    const response = await BrowserApi.openHistory( { historyId });
    if (!response?.ok) throw new Error(response?.error || '打开浏览器失败');
  } catch (error) {
    showControllerError('打开浏览器历史失败', error);
  }
}

function beginTabRename(tabElement, options = {}) {
  if (!tabElement || tabElement.querySelector('.tab-title-editor')) return;
  const historyId = String(tabElement.dataset.browserHistoryId || '').trim();
  const titleSpan = tabElement.querySelector('.tab-title');
  if (!historyId || !titleSpan) return;
  const previousName = String(titleSpan.textContent || '').trim() || '新建窗口';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'tab-title-editor';
  input.value = previousName;
  input.setAttribute('aria-label', '浏览器窗口名称');
  titleSpan.replaceWith(input);
  let completed = false;
  const finish = async (save) => {
    if (completed) return;
    completed = true;
    const requestedName = input.value;
    const replacement = document.createElement('span');
    replacement.className = 'tab-title';
    replacement.textContent = previousName;
    input.replaceWith(replacement);
    if (!save) return;
    try {
      const response = await BrowserApi.renameHistory( { historyId, name: requestedName });
      if (!response?.ok) throw new Error(response?.error || '重命名失败');
      replacement.textContent = response.name;
    } catch (error) {
      showControllerError('重命名浏览器窗口失败', error);
    }
  };
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('dblclick', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
  });
  // 点击窗口栏或软件内的其他位置导致编辑框失焦时，直接保存当前名称。
  if (options.commitOnBlur !== false) {
    input.addEventListener('blur', () => void finish(true));
  }
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

// 停止/关闭/清理：clearDragIndicators的具体业务逻辑。
