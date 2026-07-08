const shared = globalThis.CookieCaptureShared || {};
const ACCOUNT_KEY = shared.STORAGE_KEYS.ACCOUNT_KEY;
const PASSWORD_KEY = shared.STORAGE_KEYS.PASSWORD_KEY;
const AUTOMATION_CARD_CACHE_KEY = shared.STORAGE_KEYS.AUTOMATION_CARD_CACHE_KEY;
const AUTOMATION_CARD_CACHE_NAME_KEY = shared.STORAGE_KEYS.AUTOMATION_CARD_CACHE_NAME_KEY;
const AUTOMATION_CARD_CACHE_TIME_KEY = shared.STORAGE_KEYS.AUTOMATION_CARD_CACHE_TIME_KEY;
const AUTOMATION_CARD_CACHE_LIST_KEY = shared.STORAGE_KEYS.AUTOMATION_CARD_CACHE_LIST_KEY;
const AUTOMATION_CARD_SELECTED_ID_KEY = shared.STORAGE_KEYS.AUTOMATION_CARD_SELECTED_ID_KEY;
const AUTOMATION_CARD_RUN_INPUTS_KEY = shared.STORAGE_KEYS.AUTOMATION_CARD_RUN_INPUTS_KEY;
const LAST_MAIN_PANEL_KEY = shared.STORAGE_KEYS.LAST_MAIN_PANEL_KEY;
const STANDALONE_PROGRESS_STATE_KEY = shared.STORAGE_KEYS.STANDALONE_PROGRESS_STATE_KEY;


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
const cardRunInputsNode = document.getElementById('card-run-inputs');
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
const toastStackNode = document.getElementById('toast-stack');
const sidebarEditorShell = document.getElementById('sidebar-editor-shell');
const sidebarCardNameInput = document.getElementById('sidebar-card-name');
const sidebarCardWebsiteInput = document.getElementById('sidebar-card-website');
const sidebarCardDescriptionInput = document.getElementById('sidebar-card-description');
const sidebarCardPointsInput = document.getElementById('sidebar-card-points');
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

const debugProgressPanel = document.getElementById('debug-progress-panel');
const debugProgressTextNode = document.getElementById('debug-progress-text');
const debugProgressPercentNode = document.getElementById('debug-progress-percent');
const debugProgressFillNode = document.getElementById('debug-progress-fill');
const debugProgressMetaNode = document.getElementById('debug-progress-meta');
const debugProgressErrorNode = document.getElementById('debug-progress-error');
const runControlStopButton = document.getElementById('run-control-stop');

let activeDebugErrorReason = '';
let debugProgressAutoHideTimer = null;

const runtimeStateStorage = chrome.storage.session || chrome.storage.local;

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

async function renderCardCacheList(state = { items: [], selectedId: '' }) {
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
            </div>
          </div>
        `;
    }).join('');

    const selectedItem = items.find((item) => String(item.id || '').trim() === selectedId) || items[0] || null;
    if (cardFileNameNode) {
        cardFileNameNode.textContent = selectedItem ? selectedItem.cardData?.name || selectedItem.cardName || '未命名自动化卡片' : '未选择卡片';
    }
    await renderCardRunInputs(selectedItem ? selectedItem.cardData : null);
}

// 运行前「变量输入」面板：为选中卡片的每个 type 步骤渲染一个输入框，默认值=步骤 text；
// 开始执行/循环执行时把这些框收集为 inputs 传给后台，按变量键覆盖对应步骤的输入文本。
async function renderCardRunInputs(cardData) {
    if (!cardRunInputsNode) {
        return;
    }

    const targetCardName = String((cardData && cardData.name) || '').trim();

    // 无论是否有变量，都先尝试保存上一个卡片的输入值（切换或清空时）
    const previousCardName = cardRunInputsNode.dataset.cardName || '';
    if (previousCardName && previousCardName !== targetCardName) {
        const prevVals = collectCardRunInputs();
        if (Object.keys(prevVals).length > 0) {
            saveCardRunInputsForCard(previousCardName, prevVals).catch(() => {});
        }
    }

    const variables = getCardTypeStepVariables(cardData || {});
    // 相同变量键（如手动填了相同 variable）只显示一个框，共同控制多步
    const seen = new Set();
    const uniqueVariables = [];
    variables.forEach((item) => {
        if (seen.has(item.key)) {
            return;
        }
        seen.add(item.key);
        uniqueVariables.push(item);
    });

    if (!cardData || !Array.isArray(cardData.steps) || cardData.steps.length === 0) {
        // 未选中卡片 / 卡片无步骤：隐藏面板
        cardRunInputsNode.hidden = true;
        cardRunInputsNode.innerHTML = '';
        delete cardRunInputsNode.dataset.cardSignature;
        delete cardRunInputsNode.dataset.cardName;
        return;
    }

    if (uniqueVariables.length === 0) {
        // 有卡片但没有 type（输入内容）步骤：给出可见提示，避免以为面板没渲染
        cardRunInputsNode.innerHTML = `
          <div class="card-run-inputs__title">变量输入</div>
          <div class="card-run-inputs__empty">该卡片没有「输入内容(type)」步骤，无需变量输入。</div>
        `;
        cardRunInputsNode.hidden = false;
        delete cardRunInputsNode.dataset.cardSignature;
        cardRunInputsNode.dataset.cardName = targetCardName;  // 记录当前卡片名（即使无变量）
        return;
    }

    // 保留用户已填写的值：
    // - 同一 DOM 会话用 previousValues
    // - 持久化缓存（loadCardRunInputsCache）让跨 popup 打开、卡片切换后仍记住上次输入
    // - 最后才回退到卡片定义里的 defaultText
    // 优先级：DOM 现值 > 缓存值 > 默认 text
    const signature = `${String(cardData.name || '')}::${uniqueVariables.map((item) => `${item.key}=${item.defaultText}`).join('|')}`;
    const sameCard = cardRunInputsNode.dataset.cardSignature === signature;
    const previousValues = {};
    if (sameCard) {
        cardRunInputsNode.querySelectorAll('[data-run-input-key]').forEach((node) => {
            const key = String(node.dataset.runInputKey || '').trim();
            if (key) {
                previousValues[key] = String(node.value || '');
            }
        });
    }

    // 从缓存加载本卡片上次用户输入（跨 popup 打开也有效）
    let savedValues = {};
    try {
        const cache = await loadCardRunInputsCache();
        savedValues = cache[targetCardName] || {};
    } catch (_e) {
        savedValues = {};
    }

    const rows = uniqueVariables.map((item) => {
        let currentValue;
        if (Object.prototype.hasOwnProperty.call(previousValues, item.key)) {
            currentValue = previousValues[item.key];
        } else if (Object.prototype.hasOwnProperty.call(savedValues, item.key)) {
            currentValue = savedValues[item.key];
        } else {
            currentValue = item.defaultText;
        }
        return `
      <div class="card-run-input">
        <label>步骤${item.stepIndex} · ${escapeHtml(item.label)} · <code>${escapeHtml(item.key)}</code></label>
        <input type="text" data-run-input-key="${escapeHtml(item.key)}" value="${escapeHtml(currentValue)}" placeholder="默认: ${escapeHtml(item.defaultText || '(空)')}">
      </div>
    `;
    }).join('');
    cardRunInputsNode.dataset.cardSignature = signature;
    cardRunInputsNode.dataset.cardName = targetCardName;

    cardRunInputsNode.innerHTML = `
      <div class="card-run-inputs__title">变量输入（运行前可覆盖，共 ${uniqueVariables.length} 项）</div>
      <div class="card-run-inputs__list">${rows}</div>
    `;
    cardRunInputsNode.hidden = false;

    // 绑定自动保存：用户打字时记住到缓存
    attachRunInputsAutoSave(targetCardName);
}

// 收集面板里各变量框的当前值为 { 变量键: 值 } 对象；无面板/无变量时返回空对象。
function collectCardRunInputs() {
    if (!cardRunInputsNode || cardRunInputsNode.hidden) {
        return {};
    }
    const inputs = {};
    cardRunInputsNode.querySelectorAll('[data-run-input-key]').forEach((node) => {
        const key = String(node.dataset.runInputKey || '').trim();
        if (key) {
            inputs[key] = String(node.value || '');
        }
    });
    return inputs;
}

// 变量输入持久化：把用户在「变量输入」面板填的值按卡片名称记住到 storage，
// 下次打开同一卡片时自动带回上次填写的内容，而不是重置为步骤默认 text。
async function loadCardRunInputsCache() {
    try {
        const stored = await chrome.storage.local.get([AUTOMATION_CARD_RUN_INPUTS_KEY]);
        const data = stored && stored[AUTOMATION_CARD_RUN_INPUTS_KEY];
        return (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
    } catch (_e) {
        return {};
    }
}

async function saveCardRunInputsForCard(cardName, inputs = {}) {
    const name = String(cardName || '').trim();
    if (!name) return;
    try {
        const cache = await loadCardRunInputsCache();
        cache[name] = { ...(inputs || {}) };
        await chrome.storage.local.set({ [AUTOMATION_CARD_RUN_INPUTS_KEY]: cache });
    } catch (_e) {}
}

function attachRunInputsAutoSave(cardName) {
    if (!cardRunInputsNode) return;
    const name = String(cardName || '').trim();
    if (!name) return;

    let saveTimer = null;
    const scheduleSave = () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            const vals = collectCardRunInputs();
            saveCardRunInputsForCard(name, vals).catch(() => {});
            saveTimer = null;
        }, 250);
    };

    cardRunInputsNode.querySelectorAll('[data-run-input-key]').forEach((el) => {
        el.addEventListener('input', scheduleSave);
        el.addEventListener('change', scheduleSave);
    });
}

function normalizeProgressValue(value = 0) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return 0;
    }
    return Math.max(0, Math.min(100, number));
}

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
    }, delayMs);
}

function setDebugProgress(state = {}) {
    if (!debugProgressPanel) {
        return;
    }

    clearDebugProgressAutoHideTimer();

    const hasProgress = Number.isFinite(Number(state.progress));
    const progress = hasProgress ? normalizeProgressValue(state.progress) : null;
    const text = String(state.message || '等待执行').trim() || '等待执行';
    const meta = String(state.meta || '').trim();
    const hasErrorReason = Object.prototype.hasOwnProperty.call(state, 'errorReason');
    const nextErrorReason = hasErrorReason ? String(state.errorReason || '').trim() : activeDebugErrorReason;
    const phase = String(state.phase || '').trim();
    const visible = state.visible !== false;

    if (hasErrorReason) {
        activeDebugErrorReason = nextErrorReason;
    } else if (state.kind !== 'error' && ['start', 'password_ready', 'step_start', 'step_complete', 'step_skip', 'save_cookies', 'finished', 'debug_complete'].includes(phase)) {
        activeDebugErrorReason = '';
    }

    debugProgressPanel.classList.toggle('is-visible', visible);
    debugProgressPanel.classList.toggle('is-error', state.kind === 'error');

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
        const showRunStop = visible;
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
        debugProgressTextNode.textContent = '等待执行';
    }
    if (debugProgressMetaNode) {
        debugProgressMetaNode.textContent = '';
    }
    if (debugProgressErrorNode) {
        debugProgressErrorNode.textContent = '';
    }
    activeDebugErrorReason = '';
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
        message: String(state.message || '等待执行').trim() || '等待执行',
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

// 变量键推导（须与后台 03_formatting.js 的 resolveStepVariableKey 保持一致）：
// 取步骤显式 variable 字段，否则按其在全部 type 步骤中的顺序回退为 var1/var2/...（1-based）。
function resolveStepVariableKey(step = {}, typeOrdinal = 1) {
    const explicit = String((step && step.variable) || '').trim();
    if (explicit) {
        return explicit;
    }
    const ordinal = Number.isFinite(Number(typeOrdinal)) && Number(typeOrdinal) > 0 ? Math.floor(Number(typeOrdinal)) : 1;
    return `var${ordinal}`;
}

// 收集卡片里全部 type 步骤对应的变量输入槽（用于运行前的「变量输入」面板）。
// 返回 [{ key, label, stepIndex, defaultText }]，按步骤顺序排列。
function getCardTypeStepVariables(cardData = {}) {
    const steps = Array.isArray(cardData?.steps) ? cardData.steps : [];
    const variables = [];
    let typeOrdinal = 0;
    steps.forEach((step, index) => {
        if (!step || typeof step !== 'object') {
            return;
        }
        if (String(step.type || '').trim().toLowerCase() !== 'type') {
            return;
        }
        typeOrdinal += 1;
        const key = resolveStepVariableKey(step, typeOrdinal);
        const stepName = String(step.name || `步骤${index + 1}`).trim() || `步骤${index + 1}`;
        variables.push({
            key,
            label: stepName,
            stepIndex: index + 1,
            defaultText: String(step.text || '')
        });
    });
    return variables;
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
    const template = {
        name: `步骤`,
        type: normalizedType
    };
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
    const variable = String(step?.variable || '').trim();
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
            <label>输入文本（变量默认值）</label>
            <input data-sidebar-step-field="text" type="text" value="${escapeHtml(text)}" placeholder="type 步骤要输入的默认文本；运行前可按变量名覆盖">
          </div>
          <div class="full">
            <label>变量名（仅输入步骤，留空自动按顺序 var1/var2…）</label>
            <input data-sidebar-step-field="variable" type="text" value="${escapeHtml(variable)}" placeholder="如 email / password / username">
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
    const variable = String(readField('variable') || '').trim();
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
    if (variable && String(step.type || '').trim().toLowerCase() === 'type') {
        step.variable = variable;
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
    const points = Number(sidebarCardPointsInput?.value || 0);
    // 不再收集账号/密码/随机密码：输入内容改由各 type 步骤的变量（text 默认值 + 运行前 inputs 覆盖）承载。
    const { account: _dropAccount, password: _dropPassword, random: _dropRandom, ...baseRest } = base;
    const cardData = {
        ...baseRest,
        name: String(sidebarCardNameInput?.value || base.name || '').trim() || '未命名自动化卡片',
        website: String(sidebarCardWebsiteInput?.value || base.website || '').trim(),
        description: String(sidebarCardDescriptionInput?.value || base.description || '').trim(),
        points: Number.isFinite(points) ? points : 0,
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
    if (sidebarCardPointsInput) sidebarCardPointsInput.value = String(normalized.points ?? 0);
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
    await renderCardCacheList(state);
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
    await renderCardCacheList({
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
    await renderCardCacheList({ items: nextItems, selectedId: nextSelectedId });
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
    await renderCardCacheList(state);
    return saved;
}


globalThis.CookieCaptureAutomationWorkbench = {
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
    resolveStepVariableKey,
    getCardTypeStepVariables,
    renderCardRunInputs,
    collectCardRunInputs,
    loadCardRunInputsCache,
    saveCardRunInputsForCard,
    normalizeProgressValue,
    setDebugProgress,
    resetDebugProgress,
    scheduleDebugProgressAutoHide,
    clearDebugProgressAutoHideTimer,
    loadStandaloneProgressState,
    setLoopButtonState,
    refreshLoopButtonState,
    sendStopAction,
    normalizeCardData,
    stringifyCardData,
    parseEditorCardData,
    setCardEditorValue,
    getCardEditorValue,
    isVerificationStepName,
    isEmailStepName,
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
