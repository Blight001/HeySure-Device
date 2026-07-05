const shared = globalThis.CookieCaptureShared || {};
const ACCOUNT_KEY = shared.STORAGE_KEYS.ACCOUNT_KEY;
const PASSWORD_KEY = shared.STORAGE_KEYS.PASSWORD_KEY;
const AUTOMATION_CARD_CACHE_KEY = shared.STORAGE_KEYS.AUTOMATION_CARD_CACHE_KEY;
const AUTOMATION_CARD_CACHE_NAME_KEY = shared.STORAGE_KEYS.AUTOMATION_CARD_CACHE_NAME_KEY;
const AUTOMATION_CARD_CACHE_TIME_KEY = shared.STORAGE_KEYS.AUTOMATION_CARD_CACHE_TIME_KEY;
const AUTOMATION_CARD_CACHE_LIST_KEY = shared.STORAGE_KEYS.AUTOMATION_CARD_CACHE_LIST_KEY;
const AUTOMATION_CARD_SELECTED_ID_KEY = shared.STORAGE_KEYS.AUTOMATION_CARD_SELECTED_ID_KEY;
const LAST_MAIN_PANEL_KEY = shared.STORAGE_KEYS.LAST_MAIN_PANEL_KEY;
const STANDALONE_PROGRESS_STATE_KEY = shared.STORAGE_KEYS.STANDALONE_PROGRESS_STATE_KEY;
const STANDALONE_DEBUG_CONTROL_STATE_KEY = shared.STORAGE_KEYS.STANDALONE_DEBUG_CONTROL_STATE_KEY;

const accountInput = document.getElementById('account');
const passwordInput = document.getElementById('password');
const copyAccountPasswordButton = document.getElementById('copy-account-password');
const generateCookiePasswordButton = document.getElementById('generate-cookie-password');
const cardFileInput = document.getElementById('card-file');
const pickCardFileButton = document.getElementById('pick-card-file');
const importCardButton = document.getElementById('import-card');
const loopCardButton = document.getElementById('loop-card');
const cardFileNameNode = document.getElementById('card-file-name');
const cardCacheBadgeNode = document.getElementById('card-cache-badge');
const cardCacheListNode = document.getElementById('card-cache-list');
const deleteCardButton = document.getElementById('delete-card');
const cardEditor = document.getElementById('card-editor');
const loadCardToEditorButton = document.getElementById('load-card-to-editor');
const saveCardEditorButton = document.getElementById('save-card-editor');
const exportCardButton = document.getElementById('export-card');
const appendStepButton = document.getElementById('append-step');
const stepTypeSelect = document.getElementById('step-type');
const stepNameInput = document.getElementById('step-name');
const stepSelectorInput = document.getElementById('step-selector');
const stepTextInput = document.getElementById('step-text');
const stepUrlInput = document.getElementById('step-url');
const stepTimeoutInput = document.getElementById('step-timeout');
const heroTutorialButton = document.getElementById('hero-tutorial');
const openCardSidebarButton = document.getElementById('open-card-sidebar');
const mainTabsNode = document.getElementById('main-tabs');
const mainTabButtons = Array.from(document.querySelectorAll('[data-main-tab]'));
const mainPanels = Array.from(document.querySelectorAll('[data-main-panel]'));
const debugProgressPanel = document.getElementById('debug-progress-panel');
const debugProgressTextNode = document.getElementById('debug-progress-text');
const debugProgressPercentNode = document.getElementById('debug-progress-percent');
const debugProgressFillNode = document.getElementById('debug-progress-fill');
const debugProgressMetaNode = document.getElementById('debug-progress-meta');
const debugProgressErrorNode = document.getElementById('debug-progress-error');
const runControlStopButton = document.getElementById('run-control-stop');
const debugControlModeNode = document.getElementById('debug-control-mode');
const debugControlStepButton = document.getElementById('debug-control-step');
const debugControlLoopButton = document.getElementById('debug-control-loop');
const debugControlPauseButton = document.getElementById('debug-control-pause');
const debugControlStopButton = document.getElementById('debug-control-stop');
const toastStackNode = document.getElementById('toast-stack');
const sidebarEditorShell = document.getElementById('sidebar-editor-shell');
const sidebarCardNameInput = document.getElementById('sidebar-card-name');
const sidebarCardWebsiteInput = document.getElementById('sidebar-card-website');
const sidebarCardDescriptionInput = document.getElementById('sidebar-card-description');
const sidebarCardPasswordInput = document.getElementById('sidebar-card-password');
const sidebarCardPointsInput = document.getElementById('sidebar-card-points');
const sidebarCardRandomLengthInput = document.getElementById('sidebar-card-random-length');
const sidebarCardRandomTypeInput = document.getElementById('sidebar-card-random-type');
const sidebarCardPopupsInput = document.getElementById('sidebar-card-popups');
const sidebarCardUploadServerUrlInput = document.getElementById('sidebar-card-upload-server-url');
const sidebarCardUploadCardKeyInput = document.getElementById('sidebar-card-upload-card-key');
const sidebarCardRawJsonInput = document.getElementById('sidebar-card-raw-json');
const sidebarStepTemplateSelect = document.getElementById('sidebar-step-template');
const sidebarAddStepButton = document.getElementById('sidebar-add-step');
const sidebarLoadCardButton = document.getElementById('sidebar-load-card');
const sidebarSaveCardButton = document.getElementById('sidebar-save-card');
const sidebarExportCardButton = document.getElementById('sidebar-export-card');
const sidebarLoopButton = document.getElementById('sidebar-loop-card');
const sidebarRefreshCardButton = document.getElementById('sidebar-refresh-card');
const sidebarCloseButton = document.getElementById('sidebar-close');
const sidebarTutorialButton = document.getElementById('sidebar-tutorial');
const sidebarStepListNode = document.getElementById('sidebar-step-list');
const sidebarEditorMetaNode = document.getElementById('sidebar-editor-meta');

const runtimeStateStorage = chrome.storage.session || chrome.storage.local;
let activeDebugErrorReason = '';
let debugProgressAutoHideTimer = null;

function clearDebugProgressAutoHideTimer() {
    if (debugProgressAutoHideTimer) {
        clearTimeout(debugProgressAutoHideTimer);
        debugProgressAutoHideTimer = null;
    }
}

function scheduleDebugProgressAutoHide(delayMs = 3000) {
    clearDebugProgressAutoHideTimer();
    debugProgressAutoHideTimer = window.setTimeout(() => {
        debugProgressAutoHideTimer = null;
        resetDebugProgress();
    }, Math.max(0, Number(delayMs) || 0));
}

const {
    sanitizeFilePart,
    buildPresetFileName,
    generateCookiePassword,
    setStatus,
    copyTextToClipboard,
    downloadJsonFile,
    showToast,
    showActionToast,
    buildCardExportFileName,
    normalizeCardData,
    stringifyCardData,
    parseEditorCardData,
    escapeHtml,
    setCardFileName
} = shared;

async function openTutorialPage() {
    await chrome.tabs.create({
        url: TUTORIAL_URL,
        active: true
    });
}

async function loadLastMainPanel() {
    const stored = await chrome.storage.local.get([LAST_MAIN_PANEL_KEY]).catch(() => ({}));
    const value = stored && typeof stored === 'object' ? String(stored[LAST_MAIN_PANEL_KEY] || '').trim() : '';
    return ['card', 'cookie'].includes(value) ? value : 'card';
}

async function saveLastMainPanel(panelName = 'card') {
    const normalized = ['card', 'cookie'].includes(String(panelName || '').trim())
        ? String(panelName || '').trim()
        : 'card';
    await chrome.storage.local.set({
        [LAST_MAIN_PANEL_KEY]: normalized
    }).catch(() => {});
    return normalized;
}

function activateMainPanel(panelName = 'card', options = {}) {
    const normalized = String(panelName || 'card').trim() || 'card';

    mainPanels.forEach((panel) => {
        const active = String(panel.dataset.mainPanel || '').trim() === normalized;
        panel.classList.toggle('is-active', active);
    });

    mainTabButtons.forEach((button) => {
        const active = String(button.dataset.mainTab || '').trim() === normalized;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    if (options.persist !== false) {
        void saveLastMainPanel(normalized);
    }
}

mainTabButtons.forEach((button) => {
    button.addEventListener('click', () => {
        activateMainPanel(String(button.dataset.mainTab || 'card').trim() || 'card');
    });
});

function setCardCacheBadge(text = '') {
    if (!cardCacheBadgeNode) {
        return;
    }
    cardCacheBadgeNode.textContent = text || '无';
}

function buildCardCacheId(cardData = {}, sourceName = '') {
    const namePart = sanitizeFilePart(String(cardData?.name || sourceName || 'automation'));
    const timePart = new Date().toISOString().replace(/[:.]/g, '-');
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `${namePart || 'automation'}_${timePart}_${randomPart}`;
}

function normalizeCardCacheEntry(entry = {}, index = 0) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const cardData = normalizeCardData(source.cardData || source, source.cardName || source.name || `automation_${index + 1}`, { allowEmptySteps: true });
    const id = String(source.id || source.cacheId || '').trim() || buildCardCacheId(cardData, source.sourceName || source.fileName || source.cardName || '');
    return {
        id,
        cardData,
        cardName: String(source.cardName || cardData.name || '').trim() || cardData.name,
        sourceName: String(source.sourceName || source.fileName || '').trim(),
        savedAt: String(source.savedAt || source.updatedAt || new Date().toISOString()).trim(),
        selected: source.selected === true
    };
}

function buildCardListLabel(item = {}, isSelected = false) {
    const savedAt = String(item.savedAt || '').trim();
    const stepsCount = Array.isArray(item.cardData?.steps) ? item.cardData.steps.length : 0;
    const savedAtText = savedAt ? (() => {
        const date = new Date(savedAt);
        return Number.isNaN(date.getTime()) ? savedAt : date.toLocaleString('zh-CN', { hour12: false });
    })() : '';
    const metaParts = [
        stepsCount > 0 ? `${stepsCount} 步` : '无步骤',
        savedAtText
    ].filter(Boolean);
    return {
        title: String(item.cardData?.name || item.cardName || '未命名自动化卡片').trim() || '未命名自动化卡片',
        meta: metaParts.join(' · '),
        selected: isSelected
    };
}

function renderCardCacheList(state = { items: [], selectedId: '' }) {
    if (!cardCacheListNode) {
        return;
    }

    const items = Array.isArray(state.items) ? state.items : [];
    const selectedId = String(state.selectedId || '').trim();
    if (cardCacheBadgeNode) {
        cardCacheBadgeNode.textContent = items.length > 0 ? `${items.length} 张` : '0 张';
    }

    if (items.length === 0) {
        cardCacheListNode.innerHTML = '<div class="card-cache-empty">暂无已缓存卡片，导入后会显示在这里。</div>';
        if (cardFileNameNode) {
            cardFileNameNode.textContent = '未选择卡片';
        }
        return;
    }

    cardCacheListNode.innerHTML = items.map((item, index) => {
        const active = String(item.id || '').trim() === selectedId;
        const label = buildCardListLabel(item, active);
        const timeText = label.meta ? `<div class="card-cache-item__meta">${escapeHtml(label.meta)}</div>` : '';
        return `
          <div class="card-cache-item${active ? ' is-active' : ''}" data-card-cache-item data-card-id="${escapeHtml(item.id)}">
            <div>
              <div class="card-cache-item__title">${escapeHtml(label.title)}</div>
              ${timeText}
            </div>
            <div class="card-cache-item__actions">
              ${active ? '<div class="chip">已选中</div>' : '<div class="chip">未选中</div>'}
              <button type="button" class="button-secondary" data-card-cache-action="select">选择</button>
            </div>
          </div>
        `;
    }).join('');

    const selectedItem = items.find((item) => String(item.id || '').trim() === selectedId) || items[0] || null;
    if (cardFileNameNode) {
        cardFileNameNode.textContent = selectedItem ? selectedItem.cardData?.name || selectedItem.cardName || '未命名自动化卡片' : '未选择卡片';
    }
}

function normalizeProgressValue(value = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return 0;
    }
    return Math.max(0, Math.min(100, number));
}

function setDebugProgress(state = {}) {
    if (!debugProgressPanel) {
        return;
    }

    clearDebugProgressAutoHideTimer();

    const hasProgress = Number.isFinite(Number(state.progress));
    const progress = hasProgress ? normalizeProgressValue(state.progress) : null;
    const text = String(state.message || '等待开始').trim() || '等待开始';
    const meta = String(state.meta || '').trim();
    const hasErrorReason = Object.prototype.hasOwnProperty.call(state, 'errorReason');
    const nextErrorReason = hasErrorReason ? String(state.errorReason || '').trim() : activeDebugErrorReason;
    const phase = String(state.phase || '').trim();
    const visible = state.visible !== false;
    const mode = String(state.mode || '').trim().toLowerCase();

    if (hasErrorReason) {
        activeDebugErrorReason = nextErrorReason;
    } else if (state.kind !== 'error' && ['start', 'password_ready', 'step_start', 'step_complete', 'step_skip', 'save_cookies', 'finished', 'debug_complete'].includes(phase)) {
        activeDebugErrorReason = '';
    }

    debugProgressPanel.classList.toggle('is-visible', visible);
    debugProgressPanel.classList.toggle('is-error', state.kind === 'error');
    debugProgressPanel.dataset.mode = mode || '';

    if (hasProgress && debugProgressFillNode) {
        debugProgressFillNode.style.width = `${progress}%`;
    }
    if (hasProgress && debugProgressPercentNode) {
        debugProgressPercentNode.textContent = `${Math.round(progress)}%`;
    }
    if (debugProgressTextNode) {
        debugProgressTextNode.textContent = text;
    }
    if (debugProgressMetaNode) {
        debugProgressMetaNode.textContent = meta;
    }
    if (debugProgressErrorNode) {
        debugProgressErrorNode.textContent = activeDebugErrorReason ? `错误原因：${activeDebugErrorReason}` : '';
    }

    if (runControlStopButton) {
        const showRunStop = visible && mode === 'run';
        runControlStopButton.disabled = !showRunStop;
        runControlStopButton.hidden = !showRunStop;
    }
}

function resetDebugProgress() {
    clearDebugProgressAutoHideTimer();
    if (!debugProgressPanel) {
        return;
    }

    debugProgressPanel.classList.remove('is-visible', 'is-error');
    if (debugProgressFillNode) {
        debugProgressFillNode.style.width = '0%';
    }
    if (debugProgressPercentNode) {
        debugProgressPercentNode.textContent = '0%';
    }
    if (debugProgressTextNode) {
        debugProgressTextNode.textContent = '等待开始';
    }
    if (debugProgressMetaNode) {
        debugProgressMetaNode.textContent = '';
    }
    if (debugProgressErrorNode) {
        debugProgressErrorNode.textContent = '';
    }
    activeDebugErrorReason = '';
    if (debugProgressPanel) {
        debugProgressPanel.dataset.mode = '';
    }
    if (runControlStopButton) {
        runControlStopButton.hidden = true;
        runControlStopButton.disabled = true;
    }
}

async function loadStandaloneProgressState() {
    const stored = await runtimeStateStorage.get([STANDALONE_PROGRESS_STATE_KEY]).catch(() => ({}));
    const state = stored && typeof stored === 'object' ? stored[STANDALONE_PROGRESS_STATE_KEY] : null;
    if (!state || typeof state !== 'object') {
        return null;
    }

    const progressValue = Number(state.progress);
    return {
        tabId: Number(state.tabId || 0) || null,
        cardName: String(state.cardName || '').trim(),
        message: String(state.message || '等待开始').trim() || '等待开始',
        phase: String(state.phase || '').trim(),
        mode: String(state.mode || '').trim(),
        isLooping: state.isLooping === true,
        kind: String(state.kind || '').trim(),
        errorReason: String(state.errorReason || '').trim(),
        stepIndex: Number(state.stepIndex || 0) || 0,
        stepTotal: Number(state.stepTotal || 0) || 0,
        stepName: String(state.stepName || '').trim(),
        previousStepName: String(state.previousStepName || '').trim(),
        nextStepName: String(state.nextStepName || '').trim(),
        running: state.running === true,
        visible: state.visible !== false,
        progress: Number.isFinite(progressValue) ? progressValue : undefined,
        updatedAt: String(state.updatedAt || '').trim()
    };
}

async function loadStandaloneDebugControlState() {
    const stored = await runtimeStateStorage.get([STANDALONE_DEBUG_CONTROL_STATE_KEY]).catch(() => ({}));
    const state = stored && typeof stored === 'object' ? stored[STANDALONE_DEBUG_CONTROL_STATE_KEY] : null;
    if (!state || typeof state !== 'object') {
        return null;
    }

    return {
        tabId: Number(state.tabId || 0) || null,
        cardName: String(state.cardName || '').trim(),
        mode: String(state.mode || 'loop').trim() || 'loop',
        stepBudget: Math.max(0, Number(state.stepBudget || 0) || 0),
        running: state.running !== false,
        updatedAt: String(state.updatedAt || '').trim()
    };
}

const STEP_TYPE_LABELS = {
    navigate: '访问网页',
    click: '点击元素',
    type: '输入内容',
    wait: '等待条件',
    wait_verification_code: '等待验证码',
    get_credits: '获取积分',
    save_cookies: '获取Cookie',
    clear_current_page_cache: '清理当前页缓存',
    external_script: '执行脚本',
    screenshot: '截图'
};

function formatStepTypeLabel(stepType = '') {
    const normalized = String(stepType || '').trim();
    return STEP_TYPE_LABELS[normalized] || normalized || '步骤';
}

function normalizeDebugControlMode(value = 'loop') {
    const mode = String(value || 'loop').trim().toLowerCase();
    if (mode === 'step' || mode === 'pause' || mode === 'loop') {
        return mode;
    }
    return 'loop';
}

function setDebugControlMode(mode = 'loop') {
    const normalized = normalizeDebugControlMode(mode);
    const label = normalized === 'step' ? '逐步运行' : normalized === 'pause' ? '暂停' : '循环运行';

    if (debugControlModeNode) {
        debugControlModeNode.textContent = `当前：${label}`;
    }

    const buttons = [
        [debugControlStepButton, 'step'],
        [debugControlLoopButton, 'loop'],
        [debugControlPauseButton, 'pause']
    ];

    for (const [button, buttonMode] of buttons) {
        if (!button) {
            continue;
        }
        button.classList.toggle('is-active', buttonMode === normalized);
        button.setAttribute('aria-pressed', buttonMode === normalized ? 'true' : 'false');
    }

}

function setLoopButtonState(isRunning = false) {
    const label = isRunning ? '停止执行' : '循环执行';
    if (loopCardButton) {
        loopCardButton.textContent = label;
        loopCardButton.setAttribute('aria-pressed', isRunning ? 'true' : 'false');
    }
    if (sidebarLoopButton) {
        sidebarLoopButton.textContent = label;
        sidebarLoopButton.setAttribute('aria-pressed', isRunning ? 'true' : 'false');
    }
}

async function refreshLoopButtonState() {
    try {
        const state = await loadStandaloneProgressState();
        const isRunning = Boolean(state && state.running === true);
        setLoopButtonState(isRunning);
        return isRunning;
    } catch (_error) {
        setLoopButtonState(false);
        return false;
    }
}

async function refreshDebugControlUi() {
    try {
        const state = await loadStandaloneDebugControlState();
        if (!state) {
            setDebugControlMode('step');
            return;
        }
        setDebugControlMode(state.mode || 'loop');
    } catch (_error) {
        setDebugControlMode('step');
    }
}

async function sendDebugControlAction(mode) {
    const normalized = normalizeDebugControlMode(mode);
    const response = await chrome.runtime.sendMessage({
        type: 'card-run-control',
        payload: {
            mode: normalized
        }
    });

    if (!response || response.success !== true) {
        throw new Error(response?.error || '更新调试控制失败');
    }

    setDebugControlMode(response.controlMode || normalized);
    return response;
}

async function sendStopAction() {
    const response = await chrome.runtime.sendMessage({
        type: 'card-run-stop',
        payload: {}
    });

    if (!response || response.success !== true) {
        throw new Error(response?.error || '停止执行失败');
    }

    return response;
}

async function syncSidebarCardToRunningDebugSession() {
    if (!isSidebarLayout()) {
        return { synced: false };
    }

    const cardData = getSidebarCardDataFromEditor();
    if (!cardData) {
        return { synced: false };
    }

    const normalizedCard = normalizeCardData(cardData, cardData?.name || 'automation', { allowEmptySteps: true });
    const [progressState, controlState] = await Promise.all([
        loadStandaloneProgressState().catch(() => null),
        loadStandaloneDebugControlState().catch(() => null)
    ]);

    const runningTabId = Number(progressState?.tabId || controlState?.tabId || 0);
    const isRunningDebug = Boolean(
        runningTabId > 0
        && progressState?.running === true
        && String(progressState?.mode || '').trim() === 'debug'
    );

    if (!isRunningDebug) {
        await saveCardCache(normalizedCard);
        return { synced: false, cardName: normalizedCard.name };
    }

    const response = await chrome.runtime.sendMessage({
        type: 'card-sync',
        payload: {
            tabId: runningTabId,
            cardData: normalizedCard
        }
    });

    if (!response || response.success !== true) {
        throw new Error(response?.error || '同步调试卡片失败');
    }

    return {
        synced: true,
        cardName: response.cardName || normalizedCard.name,
        stepCount: Number(response.stepCount || 0) || 0
    };
}

function setCardEditorValue(cardData) {
    if (!cardEditor) {
        return;
    }
    cardEditor.value = stringifyCardData(cardData || {});
}

function getCardEditorValue() {
    return String(cardEditor?.value || '');
}

function isVerificationStepName(value = '') {
    return /验证码|verification|verify|verification code|verification_code|code|otp|校验码|确认码|动态码/i.test(String(value || '').trim());
}

function isEmailStepName(value = '') {
    return /邮箱|email|mail|电子邮箱|邮箱地址|e-mail/i.test(String(value || '').trim());
}

function createDebugStepTemplate() {
    const stepType = String(stepTypeSelect?.value || 'click').trim();
    const stepLabel = formatStepTypeLabel(stepType);
    const stepName = String(stepNameInput?.value || '').trim() || (stepType === 'save_cookies' || stepType === 'clear_current_page_cache' ? stepLabel : `调试 ${stepLabel}`);
    const timeout = Number(stepTimeoutInput?.value || 15000);
    const step = {
        name: stepName,
        type: stepType
    };

    if (Number.isFinite(timeout) && timeout > 0) {
        step.timeout = timeout;
    }

    if (stepType === 'navigate') {
        step.url = String(stepUrlInput?.value || '').trim() || 'https://example.com';
    } else if (stepType === 'type') {
        step.selector = String(stepSelectorInput?.value || '').trim();
        const typedText = String(stepTextInput?.value || '').trim();
        step.text = typedText || (isVerificationStepName(stepName) ? '{code}' : isEmailStepName(stepName) ? '{email}' : '{account}');
        step.by = 'css_selector';
    } else if (stepType === 'save_cookies') {
        step.name = stepName || '获取Cookie';
    } else if (stepType === 'clear_current_page_cache') {
        step.name = stepName || '清理当前页缓存';
    } else if (stepType === 'click' || stepType === 'wait' || stepType === 'get_credits' || stepType === 'external_script') {
        step.selector = String(stepSelectorInput?.value || '').trim();
        step.by = 'css_selector';
    }

    return step;
}

function insertDebugStepIntoEditor() {
    const cardData = parseEditorCardData(getCardEditorValue(), { allowEmptySteps: true });
    const steps = Array.isArray(cardData.steps) ? [...cardData.steps] : [];
    steps.push(createDebugStepTemplate());
    cardData.steps = steps;
    setCardEditorValue(cardData);
    return cardData;
}

function isSidebarLayout() {
    return String(document.documentElement?.dataset.layout || '').trim() === 'sidebar';
}

function normalizeSidebarPopupsInput(value = '') {
    const raw = String(value || '').trim();
    if (!raw) {
        return [];
    }

    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
        return raw.split(/\r?\n/).map((line) => String(line || '').trim()).filter(Boolean).map((selector) => ({
            name: selector,
            selector
        }));
    }
}

function formatSidebarPopupsInput(popups = []) {
    if (!Array.isArray(popups) || popups.length === 0) {
        return '';
    }

    return JSON.stringify(popups, null, 2);
}

function decodeHtmlEntities(value = '') {
    return String(value || '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&');
}

function escapeCssIdentifier(value = '') {
    const text = String(value || '');
    if (typeof CSS !== 'undefined' && CSS && typeof CSS.escape === 'function') {
        return CSS.escape(text);
    }
    return text.replace(/[^a-zA-Z0-9_-]/g, (match) => `\\${match}`);
}

function escapeCssAttributeValue(value = '') {
    return String(value || '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeHasTextValue(value = '') {
    return String(value || '')
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeSelectorText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function looksLikeHtmlSnippet(value = '') {
    const text = normalizeSelectorText(decodeHtmlEntities(value));
    return /^<\w[\s>]/.test(text) || /^<\/?\w/i.test(text);
}

function buildStandardSelectorFromHtmlSnippet(value = '') {
    const raw = normalizeSelectorText(decodeHtmlEntities(value));
    if (!raw || !looksLikeHtmlSnippet(raw)) {
        return {
            selector: normalizeSelectorText(value),
            converted: false
        };
    }

    const template = document.createElement('template');
    try {
        template.innerHTML = raw;
    } catch (_error) {
        return {
            selector: normalizeSelectorText(value),
            converted: false
        };
    }

    const element = template.content?.firstElementChild || null;
    if (!element) {
        return {
            selector: normalizeSelectorText(value),
            converted: false
        };
    }

    const tagName = String(element.tagName || '').toLowerCase() || '*';
    const selectorParts = [tagName];
    const id = String(element.getAttribute('id') || '').trim();
    if (id) {
        selectorParts.push(`#${escapeCssIdentifier(id)}`);
    }

    const classes = Array.from(element.classList || [])
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .filter((item) => !/^data-v-/i.test(item));
    for (const className of classes) {
        selectorParts.push(`.${escapeCssIdentifier(className)}`);
    }

    const attributes = [];
    const addAttribute = (name) => {
        const valueText = String(element.getAttribute(name) || '').trim();
        if (valueText) {
            attributes.push(`[${name}="${escapeCssAttributeValue(valueText)}"]`);
        }
    };

    if (!id) {
        if (tagName === 'input' || tagName === 'button') {
            addAttribute('type');
        }
        addAttribute('name');
        addAttribute('placeholder');
        addAttribute('aria-label');
        addAttribute('title');
        addAttribute('role');
        addAttribute('data-testid');
        addAttribute('data-test');
        addAttribute('data-cy');
        addAttribute('data-qa');

        if (attributes.length === 0) {
            const dataKeys = Array.from(element.attributes || [])
                .map((attr) => String(attr?.name || '').trim())
                .filter((name) => /^data-[a-z0-9_-]+$/i.test(name) && !/^data-v-/i.test(name));
            for (const name of dataKeys.slice(0, 2)) {
                addAttribute(name);
            }
        }
    }

    selectorParts.push(...attributes);

    const textContent = normalizeSelectorText(String(element.textContent || ''));
    if (textContent && textContent.length <= 80) {
        selectorParts.push(`:has-text("${escapeHasTextValue(textContent)}")`);
    }

    const selector = normalizeSelectorText(selectorParts.join(''));
    return {
        selector: selector || normalizeSelectorText(value),
        converted: true
    };
}

function normalizeSelectorInputValue(value = '') {
    const text = normalizeSelectorText(value);
    if (!text) {
        return {
            selector: '',
            converted: false
        };
    }

    if (looksLikeHtmlSnippet(text)) {
        return buildStandardSelectorFromHtmlSnippet(text);
    }

    return {
        selector: text,
        converted: false
    };
}

function normalizeSidebarStepSelectorControl(stepCard, control) {
    if (!stepCard || !control) {
        return {
            selector: String(control?.value || '').trim(),
            converted: false
        };
    }

    const normalized = normalizeSelectorInputValue(control.value);
    if (normalized.selector && normalized.selector !== control.value) {
        control.value = normalized.selector;
    }

    if (normalized.converted) {
        const byControl = stepCard.querySelector('[data-sidebar-step-field="by"]');
        if (byControl) {
            byControl.value = 'css_selector';
        }
    }

    return normalized;
}

function updateSidebarEditorMeta(cardData = null) {
    if (!sidebarEditorMetaNode || !isSidebarLayout()) {
        return;
    }

    if (!cardData) {
        sidebarEditorMetaNode.innerHTML = '<span class="sidebar-editor-meta__chip">未载入卡片</span>';
        return;
    }

    const stepsCount = Array.isArray(cardData.steps) ? cardData.steps.length : 0;
    const name = String(cardData.name || '未命名自动化卡片').trim() || '未命名自动化卡片';
    const website = String(cardData.website || '').trim();
    const chips = [
        `<span class="sidebar-editor-meta__chip">卡片: ${escapeHtml(name)}</span>`,
        `<span class="sidebar-editor-meta__chip">步骤: ${stepsCount}</span>`
    ];
    if (website) {
        chips.push(`<span class="sidebar-editor-meta__chip">站点: ${escapeHtml(website)}</span>`);
    }
    sidebarEditorMetaNode.innerHTML = chips.join('');
}

function buildSidebarStepTemplate(stepType = 'navigate') {
    const normalizedType = String(stepType || 'navigate').trim();
    const template = createDebugStepTemplate();
    template.type = normalizedType;

    if (normalizedType === 'navigate') {
        template.url = template.url || '';
    } else if (normalizedType === 'wait_verification_code') {
        delete template.selector;
    } else if (normalizedType === 'clear_current_page_cache') {
        template.name = '清理当前页缓存';
        delete template.selector;
        delete template.text;
        delete template.url;
        delete template.by;
        delete template.script;
        delete template.wait_for_text;
        delete template.wait_for_element_hidden;
        delete template.wait_for_text_hidden;
        delete template.clear_first;
        delete template.clearFirst;
        delete template.click_before_type;
        delete template.clickBeforeType;
    } else if (normalizedType === 'save_cookies') {
        template.name = '获取Cookie';
        delete template.selector;
        delete template.text;
    }

    return template;
}

function collectSidebarStepExpansionState() {
    const state = new Map();
    if (!sidebarStepListNode) {
        return state;
    }

    collectSidebarStepCards().forEach((card) => {
        const index = Number(card.dataset.stepIndex);
        if (Number.isInteger(index)) {
            state.set(index, card.classList.contains('is-expanded'));
        }
    });

    return state;
}

function buildSidebarStepSummary(step = {}) {
    const parts = [];
    const type = String(step?.type || 'navigate').trim() || 'navigate';
    parts.push(`类型: ${escapeHtml(formatStepTypeLabel(type))}`);

    const selector = String(step?.selector || '').trim();
    if (selector) {
        const shortSelector = selector.length > 48 ? `${selector.slice(0, 45)}...` : selector;
        parts.push(`选择器: ${escapeHtml(shortSelector)}`);
    }

    const url = String(step?.url || '').trim();
    if (url) {
        const shortUrl = url.length > 48 ? `${url.slice(0, 45)}...` : url;
        parts.push(`URL: ${escapeHtml(shortUrl)}`);
    }

    return parts.map((item) => `<span>${item}</span>`).join('');
}

function buildSidebarStepCardHtml(step = {}, index = 0, expanded = false) {
    const type = String(step?.type || 'navigate').trim() || 'navigate';
    const name = String(step?.name || `步骤${index + 1}`).trim() || `步骤${index + 1}`;
    const selector = String(step?.selector || '').trim();
    const text = String(step?.text || '').trim();
    const url = String(step?.url || '').trim();
    const timeout = String(step?.timeout ?? '').trim();
    const by = String(step?.by || 'css_selector').trim() || 'css_selector';
    const script = String(step?.script || '').trim();
    const waitForText = String(step?.wait_for_text || '').trim();
    const waitForElementHidden = String(step?.wait_for_element_hidden || '').trim();
    const optional = step?.optional === true || String(step?.optional || '').trim() === 'true';

    return `
      <div class="sidebar-step-card${expanded ? ' is-expanded' : ''}" data-sidebar-step-card data-step-index="${index}">
        <div class="sidebar-step-card__header">
          <div class="sidebar-step-card__title-wrap">
            <h4 class="sidebar-step-card__title">步骤 ${index + 1}-${name}</h4>
            <div class="sidebar-step-card__summary">${buildSidebarStepSummary(step)}</div>
          </div>
          <div class="sidebar-step-card__actions">
            <button type="button" class="button-secondary sidebar-step-card__toggle" data-sidebar-step-action="toggle" aria-expanded="${expanded ? 'true' : 'false'}">${expanded ? '收起详情' : '展开详情'}</button>
            <button type="button" class="button-secondary" data-sidebar-step-action="up">上移</button>
            <button type="button" class="button-secondary" data-sidebar-step-action="down">下移</button>
            <button type="button" class="button-secondary" data-sidebar-step-action="delete">删除</button>
          </div>
        </div>
        <div class="sidebar-step-card__body">
          <div class="sidebar-step-card__grid">
          <div class="full">
            <label>步骤名称</label>
            <input data-sidebar-step-field="name" type="text" value="${escapeHtml(name)}">
          </div>
            <div>
              <label>步骤类型</label>
              <select data-sidebar-step-field="type">
                ${[
                    ['navigate', '访问网页'],
                    ['click', '点击元素'],
                    ['type', '输入内容'],
                    ['wait', '等待条件'],
                    ['wait_verification_code', '等待验证码'],
                    ['get_credits', '获取积分'],
                    ['save_cookies', '获取Cookie'],
                    ['clear_current_page_cache', '清理当前页缓存'],
                    ['external_script', '执行脚本'],
                    ['screenshot', '截图']
                ].map(([value, label]) => `<option value="${value}"${value === type ? ' selected' : ''}>${label}</option>`).join('')}
              </select>
            </div>
            <div>
              <label>选择器类型</label>
              <select data-sidebar-step-field="by">
                ${['css_selector','text','auto'].map((item) => `<option value="${item}"${item === by ? ' selected' : ''}>${item}</option>`).join('')}
              </select>
            </div>
          <div class="full">
            <div class="sidebar-step-selector-head">
              <label>选择器</label>
              <button type="button" class="button-secondary sidebar-step-selector-btn" data-sidebar-step-action="selector">设置选择器</button>
            </div>
            <input data-sidebar-step-field="selector" type="text" value="${escapeHtml(selector)}" placeholder="可直接粘贴 HTML 元素片段">
          </div>
          <div class="full">
            <label>输入文本</label>
            <input data-sidebar-step-field="text" type="text" value="${escapeHtml(text)}">
          </div>
          <div class="full">
            <label>跳转 URL</label>
            <input data-sidebar-step-field="url" type="text" value="${escapeHtml(url)}">
          </div>
          <div>
            <label>超时(ms)</label>
            <input data-sidebar-step-field="timeout" type="number" min="0" step="100" value="${escapeHtml(timeout)}">
          </div>
            <div>
              <label>可选</label>
              <label style="display:flex;align-items:center;gap:8px;margin:0;">
                <input data-sidebar-step-field="optional" type="checkbox"${optional ? ' checked' : ''}>
                <span>跳过失败继续</span>
              </label>
            </div>
          <div class="full">
            <label>等待文本</label>
            <input data-sidebar-step-field="wait_for_text" type="text" value="${escapeHtml(waitForText)}">
          </div>
          <div class="full">
            <label>等待元素消失</label>
            <input data-sidebar-step-field="wait_for_element_hidden" type="text" value="${escapeHtml(waitForElementHidden)}">
          </div>
          <div class="full">
            <label>脚本</label>
            <textarea data-sidebar-step-field="script" rows="5">${escapeHtml(script)}</textarea>
          </div>
          </div>
        </div>
      </div>
    `;
  }

function collectSidebarStepCards() {
    if (!sidebarStepListNode) {
        return [];
    }

    return Array.from(sidebarStepListNode.querySelectorAll('[data-sidebar-step-card]'));
}

function readSidebarStepCard(stepCard, index = 0) {
    if (!stepCard) {
        return null;
    }

    const readField = (name) => {
        const control = stepCard.querySelector(`[data-sidebar-step-field="${name}"]`);
        if (!control) {
            return '';
        }

        if (control.type === 'checkbox') {
            return control.checked === true;
        }

        return String(control.value || '').trim();
    };

    const selectorControl = stepCard.querySelector('[data-sidebar-step-field="selector"]');
    const selectorNormalization = normalizeSidebarStepSelectorControl(stepCard, selectorControl);

    const step = {
        name: String(readField('name') || `步骤${index + 1}`).trim() || `步骤${index + 1}`,
        type: String(readField('type') || 'navigate').trim() || 'navigate'
    };

    const selector = String(selectorNormalization.selector || readField('selector') || '').trim();
    const text = String(readField('text') || '').trim();
    const url = String(readField('url') || '').trim();
    const by = String(readField('by') || '').trim();
    const timeoutValue = Number(readField('timeout'));
    const waitForText = String(readField('wait_for_text') || '').trim();
    const waitForElementHidden = String(readField('wait_for_element_hidden') || '').trim();
    const script = String(readField('script') || '').trim();

    if (selector) {
        step.selector = selector;
    }
    if (text) {
        step.text = text;
    }
    if (url) {
        step.url = url;
    }
    if (selectorNormalization.converted) {
        step.by = 'css_selector';
    } else if (by) {
        step.by = by;
    }
    if (Number.isFinite(timeoutValue)) {
        step.timeout = timeoutValue;
    }
    if (waitForText) {
        step.wait_for_text = waitForText;
    }
    if (waitForElementHidden) {
        step.wait_for_element_hidden = waitForElementHidden;
    }
    if (script) {
        step.script = script;
    }
    if (readField('optional') === true) {
        step.optional = true;
    }

    return step;
}

function collectSidebarSteps() {
    const cards = collectSidebarStepCards();
    const steps = cards.map((card, index) => readSidebarStepCard(card, index)).filter(Boolean);
    return steps;
}

function syncSidebarEditorToHiddenJson() {
    if (!isSidebarLayout()) {
        return null;
    }

    const cardData = collectSidebarCardDataFromForm();
    if (!cardData) {
        return null;
    }

    setCardEditorValue(cardData);
    return cardData;
}

function collectSidebarCardDataFromForm() {
    if (!isSidebarLayout()) {
        return null;
    }

    const rawJson = String(sidebarCardRawJsonInput?.value || '').trim();
    let base = {};
    if (rawJson) {
      try {
        base = JSON.parse(rawJson);
      } catch (_error) {
        base = {};
      }
    }

    const steps = collectSidebarSteps();
    const popups = normalizeSidebarPopupsInput(String(sidebarCardPopupsInput?.value || ''));
    const randomLength = Number(sidebarCardRandomLengthInput?.value || 12);
    const points = Number(sidebarCardPointsInput?.value || 0);
    const cardData = {
        ...base,
        name: String(sidebarCardNameInput?.value || base.name || '').trim() || '未命名自动化卡片',
        website: String(sidebarCardWebsiteInput?.value || base.website || '').trim(),
        description: String(sidebarCardDescriptionInput?.value || base.description || '').trim(),
        password: String(sidebarCardPasswordInput?.value || base.password || '').trim(),
        points: Number.isFinite(points) ? points : 0,
        random: {
            ...(base.random && typeof base.random === 'object' ? base.random : {}),
            password: {
                length: Number.isFinite(randomLength) ? Math.max(4, randomLength) : 12,
                type: String(sidebarCardRandomTypeInput?.value || base.random?.password?.type || 'mixed').trim() || 'mixed'
            }
        },
        popups,
        steps
    };

    if (String(sidebarCardUploadServerUrlInput?.value || '').trim()) {
        cardData.upload_server_url = String(sidebarCardUploadServerUrlInput.value || '').trim();
    }
    if (String(sidebarCardUploadCardKeyInput?.value || '').trim()) {
        cardData.upload_card_key = String(sidebarCardUploadCardKeyInput.value || '').trim();
    }
    cardData.upload = {
        ...(base.upload && typeof base.upload === 'object' ? base.upload : {}),
        server_url: cardData.upload_server_url || base.upload?.server_url || '',
        card_key: cardData.upload_card_key || base.upload?.card_key || ''
    };

    return normalizeCardData(cardData, cardData.name, { allowEmptySteps: true });
}

function renderSidebarCardEditor(cardData) {
    if (!isSidebarLayout() || !sidebarEditorShell) {
        return;
    }

    const normalized = normalizeCardData(cardData || {}, cardData?.name || 'automation', { allowEmptySteps: true });
    const previousExpandedStates = collectSidebarStepExpansionState();
    if (sidebarCardNameInput) sidebarCardNameInput.value = String(normalized.name || '');
    if (sidebarCardWebsiteInput) sidebarCardWebsiteInput.value = String(normalized.website || '');
    if (sidebarCardDescriptionInput) sidebarCardDescriptionInput.value = String(normalized.description || '');
    if (sidebarCardPasswordInput) sidebarCardPasswordInput.value = String(normalized.password || '');
    if (sidebarCardPointsInput) sidebarCardPointsInput.value = String(normalized.points ?? 0);
    if (sidebarCardRandomLengthInput) sidebarCardRandomLengthInput.value = String(normalized.random?.password?.length || 12);
    if (sidebarCardRandomTypeInput) sidebarCardRandomTypeInput.value = String(normalized.random?.password?.type || 'mixed');
    if (sidebarCardPopupsInput) sidebarCardPopupsInput.value = formatSidebarPopupsInput(normalized.popups || []);
    if (sidebarCardUploadServerUrlInput) sidebarCardUploadServerUrlInput.value = String(normalized.upload_server_url || normalized.upload?.server_url || '');
    if (sidebarCardUploadCardKeyInput) sidebarCardUploadCardKeyInput.value = String(normalized.upload_card_key || normalized.upload?.card_key || '');
    if (sidebarCardRawJsonInput) sidebarCardRawJsonInput.value = stringifyCardData(normalized);
    updateSidebarEditorMeta(normalized);

    const steps = Array.isArray(normalized.steps)
        ? normalized.steps.map((step) => {
            const normalizedSelector = normalizeSelectorInputValue(step?.selector || '');
            return {
                ...step,
                selector: normalizedSelector.selector || String(step?.selector || '').trim(),
                by: normalizedSelector.converted ? 'css_selector' : String(step?.by || '').trim()
            };
        })
        : [];
    normalized.steps = steps;
    if (!sidebarStepListNode) {
        return;
    }

    if (steps.length === 0) {
        sidebarStepListNode.innerHTML = '<div class="sidebar-step-empty">还没有步骤。先添加一条步骤开始编辑。</div>';
        return;
    }

    sidebarStepListNode.innerHTML = steps.map((step, index) => buildSidebarStepCardHtml(step, index, previousExpandedStates.get(index) === true)).join('');
}

function getSidebarCardDataFromEditor() {
    return collectSidebarCardDataFromForm();
}

async function getCardDataForExport() {
    if (isSidebarLayout()) {
        const sidebarCardData = getSidebarCardDataFromEditor();
        if (sidebarCardData) {
            return normalizeCardData(sidebarCardData, sidebarCardData?.name || 'automation', { allowEmptySteps: true });
        }
    }

    const editorText = String(getCardEditorValue() || '').trim();
    if (editorText) {
        const cardData = parseEditorCardData(editorText, { allowEmptySteps: true });
        return normalizeCardData(cardData, cardData?.name || 'automation', { allowEmptySteps: true });
    }

    const cachedCard = await loadCardCache().catch(() => null);
    if (cachedCard?.cardData) {
        return normalizeCardData(cachedCard.cardData, cachedCard.cardName || cachedCard.cardData?.name || 'automation', { allowEmptySteps: true });
    }

    throw new Error('自动化卡片编辑器内容不能为空，请先导入、编辑或保存一次卡片');
}

async function exportCard() {
    const cardData = await getCardDataForExport();
    const fileName = buildCardExportFileName(cardData.name);
    await downloadJsonFile(`automation_card/${fileName}`, cardData);
    setCardFileName(cardData.name);
    return { cardName: cardData.name, fileName };
}

async function loadCardCacheState() {
    const stored = await chrome.storage.local.get([
        AUTOMATION_CARD_CACHE_LIST_KEY,
        AUTOMATION_CARD_SELECTED_ID_KEY,
        AUTOMATION_CARD_CACHE_KEY,
        AUTOMATION_CARD_CACHE_NAME_KEY,
        AUTOMATION_CARD_CACHE_TIME_KEY
    ]);

    const list = Array.isArray(stored[AUTOMATION_CARD_CACHE_LIST_KEY]) ? stored[AUTOMATION_CARD_CACHE_LIST_KEY] : [];
    if (list.length > 0) {
        const items = list.map((item, index) => normalizeCardCacheEntry(item, index));
        let selectedId = String(stored[AUTOMATION_CARD_SELECTED_ID_KEY] || '').trim();
        if (!selectedId || !items.some((item) => item.id === selectedId)) {
            selectedId = String(items[0]?.id || '').trim();
        }
        return { items, selectedId };
    }

    const legacyCard = stored[AUTOMATION_CARD_CACHE_KEY];
    if (legacyCard && typeof legacyCard === 'object') {
        const legacyItem = normalizeCardCacheEntry({
            id: 'legacy-card',
            cardData: legacyCard,
            cardName: stored[AUTOMATION_CARD_CACHE_NAME_KEY] || legacyCard.name || '',
            savedAt: stored[AUTOMATION_CARD_CACHE_TIME_KEY] || new Date().toISOString(),
            sourceName: stored[AUTOMATION_CARD_CACHE_NAME_KEY] || ''
        }, 0);
        return {
            items: [legacyItem],
            selectedId: legacyItem.id
        };
    }

    return { items: [], selectedId: '' };
}

async function saveCardCacheState(items = [], selectedId = '') {
    const normalizedItems = Array.isArray(items) ? items.map((item, index) => normalizeCardCacheEntry(item, index)) : [];
    const normalizedSelectedId = String(selectedId || normalizedItems[0]?.id || '').trim();
    await chrome.storage.local.set({
        [AUTOMATION_CARD_CACHE_LIST_KEY]: normalizedItems,
        [AUTOMATION_CARD_SELECTED_ID_KEY]: normalizedSelectedId,
        [AUTOMATION_CARD_CACHE_KEY]: normalizedItems.find((item) => item.id === normalizedSelectedId)?.cardData || normalizedItems[0]?.cardData || {},
        [AUTOMATION_CARD_CACHE_NAME_KEY]: normalizedItems.find((item) => item.id === normalizedSelectedId)?.cardName || normalizedItems[0]?.cardName || '',
        [AUTOMATION_CARD_CACHE_TIME_KEY]: normalizedItems.find((item) => item.id === normalizedSelectedId)?.savedAt || normalizedItems[0]?.savedAt || ''
    });
    return {
        items: normalizedItems,
        selectedId: normalizedSelectedId
    };
}

async function refreshCardCacheUi() {
    const state = await loadCardCacheState().catch(() => ({ items: [], selectedId: '' }));
    renderCardCacheList(state);
    return state;
}

async function selectCardCacheItem(cardId) {
    const state = await loadCardCacheState().catch(() => ({ items: [], selectedId: '' }));
    const selectedId = String(cardId || '').trim();
    const item = state.items.find((entry) => String(entry.id || '').trim() === selectedId) || null;
    if (!item) {
        throw new Error('未找到可选中的自动化卡片');
    }

    await saveCardCacheState(state.items, item.id);
    if (isSidebarLayout()) {
        renderSidebarCardEditor(item.cardData);
        syncSidebarEditorToHiddenJson();
    } else {
        setCardEditorValue(item.cardData);
    }
    renderCardCacheList({
        items: state.items,
        selectedId: item.id
    });
    return item;
}

async function upsertCardCache(cardData, options = {}) {
    const safeCardData = normalizeCardData(cardData, cardData?.name || options.fileName || 'automation', { allowEmptySteps: true });
    const state = await loadCardCacheState().catch(() => ({ items: [], selectedId: '' }));
    const existingIndex = state.items.findIndex((item) => item.id === (options.id || state.selectedId));
    const nextItem = normalizeCardCacheEntry({
        id: options.id || (options.append === true ? buildCardCacheId(safeCardData, options.fileName || safeCardData.name) : (state.selectedId || buildCardCacheId(safeCardData, options.fileName || safeCardData.name))),
        cardData: safeCardData,
        cardName: safeCardData.name,
        sourceName: options.fileName || safeCardData.name,
        savedAt: new Date().toISOString()
    });

    const nextItems = state.items.slice();
    if (existingIndex >= 0) {
        nextItems.splice(existingIndex, 1, nextItem);
    } else if (options.append === true) {
        nextItems.push(nextItem);
    } else {
        nextItems.push(nextItem);
    }

    const nextSelectedId = options.select === false ? state.selectedId || nextItem.id : nextItem.id;
    await saveCardCacheState(nextItems, nextSelectedId);
    renderCardCacheList({ items: nextItems, selectedId: nextSelectedId });
    return {
        cardData: safeCardData,
        cardName: safeCardData.name,
        id: nextItem.id,
        selectedId: nextSelectedId
    };
}

function renderSidebarEditorFromCurrentState() {
    if (!isSidebarLayout()) {
        return;
    }

    try {
        const cardData = collectSidebarCardDataFromForm() || parseEditorCardData(getCardEditorValue() || '{}', { allowEmptySteps: true });
        renderSidebarCardEditor(cardData);
        syncSidebarEditorToHiddenJson();
    } catch (_error) {
        renderSidebarCardEditor({ name: '未命名自动化卡片', steps: [] });
        syncSidebarEditorToHiddenJson();
    }
}

async function saveCardCache(cardData) {
    const result = await upsertCardCache(cardData, { select: true });
    return result.cardData;
}

async function saveEditorCardToCache() {
    const cardData = isSidebarLayout()
        ? getSidebarCardDataFromEditor()
        : parseEditorCardData(getCardEditorValue(), { allowEmptySteps: true });
    const saved = await saveCardCache(cardData);
    const state = await loadCardCacheState().catch(() => ({ items: [], selectedId: '' }));
    renderCardCacheList(state);
    return saved;
}


globalThis.CookieCaptureAutomationWorkbench = {
    clearDebugProgressAutoHideTimer,
    scheduleDebugProgressAutoHide,
    sanitizeFilePart,
    buildPresetFileName,
    generateCookiePassword,
    setStatus,
    copyTextToClipboard,
    downloadJsonFile,
    showToast,
    showActionToast,
    openTutorialPage,
    loadLastMainPanel,
    saveLastMainPanel,
    activateMainPanel,
    setCardFileName,
    setCardCacheBadge,
    buildCardExportFileName,
    buildCardCacheId,
    normalizeCardCacheEntry,
    buildCardListLabel,
    renderCardCacheList,
    normalizeProgressValue,
    setDebugProgress,
    resetDebugProgress,
    loadStandaloneProgressState,
    loadStandaloneDebugControlState,
    formatStepTypeLabel,
    normalizeDebugControlMode,
    setDebugControlMode,
    setLoopButtonState,
    refreshLoopButtonState,
    refreshDebugControlUi,
    sendDebugControlAction,
    sendStopAction,
    syncSidebarCardToRunningDebugSession,
    normalizeCardData,
    stringifyCardData,
    parseEditorCardData,
    setCardEditorValue,
    getCardEditorValue,
    isVerificationStepName,
    isEmailStepName,
    createDebugStepTemplate,
    insertDebugStepIntoEditor,
    isSidebarLayout,
    escapeHtml,
    normalizeSidebarPopupsInput,
    formatSidebarPopupsInput,
    decodeHtmlEntities,
    escapeCssIdentifier,
    escapeCssAttributeValue,
    escapeHasTextValue,
    normalizeSelectorText,
    looksLikeHtmlSnippet,
    buildStandardSelectorFromHtmlSnippet,
    normalizeSelectorInputValue,
    normalizeSidebarStepSelectorControl,
    updateSidebarEditorMeta,
    buildSidebarStepTemplate,
    collectSidebarStepExpansionState,
    buildSidebarStepSummary,
    buildSidebarStepCardHtml,
    collectSidebarStepCards,
    readSidebarStepCard,
    collectSidebarSteps,
    syncSidebarEditorToHiddenJson,
    collectSidebarCardDataFromForm,
    renderSidebarCardEditor,
    getSidebarCardDataFromEditor,
    getCardDataForExport,
    exportCard,
    loadCardCacheState,
    saveCardCacheState,
    refreshCardCacheUi,
    selectCardCacheItem,
    upsertCardCache,
    renderSidebarEditorFromCurrentState,
    saveCardCache,
    saveEditorCardToCache
};
