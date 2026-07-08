const statusNode = document.getElementById('status');
const toastStackNode = document.getElementById('toast-stack');
const cardFileNameNode = document.getElementById('card-file-name');

const STORAGE_KEYS = {
    ACCOUNT_KEY: 'cookie-capture-account',
    PASSWORD_KEY: 'cookie-capture-password',
    COOKIE_NOTE_KEY: 'cookie-capture-note',
    COOKIE_CARD_KEY: 'cookie-capture-card-key',
    COOKIE_CREDENTIAL_CACHE_LIST_KEY: 'cookie-capture-credential-cache-list',
    COOKIE_CREDENTIAL_SELECTED_DATE_KEY: 'cookie-capture-credential-selected-date',
    COOKIE_CREDENTIAL_SEARCH_KEY: 'cookie-capture-credential-search',
    AUTOMATION_CARD_CACHE_KEY: 'cookie-capture-automation-card-cache',
    AUTOMATION_CARD_CACHE_NAME_KEY: 'cookie-capture-automation-card-cache-name',
    AUTOMATION_CARD_CACHE_TIME_KEY: 'cookie-capture-automation-card-cache-time',
    AUTOMATION_CARD_CACHE_LIST_KEY: 'cookie-capture-automation-card-cache-list',
    AUTOMATION_CARD_SELECTED_ID_KEY: 'cookie-capture-automation-card-cache-selected-id',
    LAST_MAIN_PANEL_KEY: 'cookie-capture-last-main-panel',
    STANDALONE_PROGRESS_STATE_KEY: 'cookie-capture-standalone-progress-state',

};

function sanitizeFilePart(value = '') {
    return String(value || '')
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function buildPresetFileName(account = '', password = '') {
    const normalizedAccount = sanitizeFilePart(account);
    const normalizedPassword = sanitizeFilePart(password);
    if (normalizedAccount && normalizedPassword) {
        return `${normalizedAccount}_${normalizedPassword}.json`;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `cookie_${timestamp}.json`;
}

function generateCookiePassword(length = 12) {
    const size = Math.max(12, Number(length) || 12);
    const lower = 'abcdefghijklmnopqrstuvwxyz';
    const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const digits = '0123456789';
    const specials = '!@#$%^&*()+-=[]{}|;:,.<>?';
    const groups = [lower, upper, digits, specials];
    const all = groups.join('');
    const randomIndex = (max) => {
        const range = Math.max(1, Number(max) || 1);
        if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
            const buffer = new Uint32Array(1);
            window.crypto.getRandomValues(buffer);
            return buffer[0] % range;
        }
        return Math.floor(Math.random() * range);
    };
    const pick = (alphabet) => alphabet[randomIndex(alphabet.length)];

    const chars = [
        pick(lower),
        pick(upper),
        pick(digits),
        pick(specials)
    ];

    while (chars.length < size) {
        chars.push(pick(all));
    }

    for (let index = chars.length - 1; index > 0; index -= 1) {
        const swapIndex = randomIndex(index + 1);
        [chars[index], chars[swapIndex]] = [chars[swapIndex], chars[index]];
    }

    return chars.join('');
}

function setStatus(text, type = '') {
    if (!statusNode) {
        return;
    }
    statusNode.textContent = text || '';
    statusNode.className = `status ${type || ''}`.trim();
}

async function copyTextToClipboard(text = '') {
    const content = String(text || '');
    if (!content) {
        throw new Error('没有可复制的内容');
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(content);
        return true;
    }

    const textarea = document.createElement('textarea');
    textarea.value = content;
    textarea.readOnly = true;
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    const copied = document.execCommand('copy');
    textarea.remove();

    if (!copied) {
        throw new Error('复制失败');
    }

    return true;
}

async function downloadJsonFile(fileName = 'export.json', data = {}) {
    const jsonText = JSON.stringify(data, null, 2);
    const downloadUrl = `data:application/json;charset=utf-8,${encodeURIComponent(jsonText)}`;
    await chrome.downloads.download({
        url: downloadUrl,
        filename: fileName,
        saveAs: true,
        conflictAction: 'uniquify'
    });
}

let toastCounter = 0;
const toastTimers = new Map();

function showToast(message, kind = 'info', durationMs = 2600) {
    if (!toastStackNode) {
        return null;
    }

    const text = String(message || '').trim();
    if (!text) {
        return null;
    }

    const toast = document.createElement('div');
    const toastId = `toast-${Date.now()}-${toastCounter += 1}`;
    toast.id = toastId;
    toast.className = `toast-item toast-${kind}`;
    toast.textContent = text;
    toastStackNode.appendChild(toast);

    requestAnimationFrame(() => {
        toast.classList.add('is-visible');
    });

    const timeout = window.setTimeout(() => {
        toast.classList.remove('is-visible');
        window.setTimeout(() => {
            toast.remove();
        }, 180);
        toastTimers.delete(toastId);
    }, Math.max(1200, Number(durationMs) || 2600));

    toastTimers.set(toastId, timeout);

    while (toastStackNode.children.length > 4) {
        const first = toastStackNode.firstElementChild;
        if (!first) {
            break;
        }
        const firstTimer = toastTimers.get(first.id);
        if (firstTimer) {
            window.clearTimeout(firstTimer);
            toastTimers.delete(first.id);
        }
        first.remove();
    }

    return toast;
}

function showActionToast(message, kind = 'info', durationMs = 2600) {
    return showToast(message, kind, durationMs);
}

function buildCardExportFileName(cardName = '') {
    const normalizedName = sanitizeFilePart(cardName);
    if (normalizedName) {
        return `${normalizedName}.json`;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `automation_card_${timestamp}.json`;
}

function normalizeCardData(cardData, fileName = '', options = {}) {
    if (!cardData || typeof cardData !== 'object' || Array.isArray(cardData)) {
        throw new Error('自动化卡片内容格式不正确');
    }

    const steps = Array.isArray(cardData.steps) ? cardData.steps : [];
    const allowEmptySteps = options && options.allowEmptySteps === true;
    if (!allowEmptySteps && steps.length === 0) {
        throw new Error('自动化卡片缺少 steps 步骤');
    }

    const normalized = { ...cardData };
    normalized.steps = steps;
    if (!String(normalized.name || '').trim()) {
        normalized.name = sanitizeFilePart(String(fileName || '').replace(/\.json$/i, '')) || '未命名自动化卡片';
    }

    return normalized;
}

function stringifyCardData(cardData) {
    return JSON.stringify(cardData, null, 2);
}

function parseEditorCardData(text = '', options = {}) {
    const rawText = String(text || '').trim();
    if (!rawText) {
        throw new Error('自动化卡片编辑器内容不能为空');
    }

    let cardData;
    try {
        cardData = JSON.parse(rawText);
    } catch (_error) {
        throw new Error('自动化卡片编辑器不是有效的 JSON');
    }

    return normalizeCardData(cardData, cardData?.name || '', options);
}

function setCardFileName(text = '') {
    if (!cardFileNameNode) {
        return;
    }
    cardFileNameNode.textContent = text || '未选择卡片';
}

function escapeHtml(value = '') {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

globalThis.CookieCaptureShared = {
    STORAGE_KEYS,
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
    setCardFileName,
    escapeHtml
};
