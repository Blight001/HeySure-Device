const PRESET_ACCOUNT_KEY = 'cookie-capture-account';
const PRESET_PASSWORD_KEY = 'cookie-capture-password';
const STANDALONE_LAST_CARD_KEY = 'cookie-capture-standalone-last-card';
const REGISTER_CARD_CACHE_KEY = 'cookie-capture-register-card-cache';
const REGISTER_CARD_CACHE_NAME_KEY = 'cookie-capture-register-card-cache-name';
const REGISTER_CARD_CACHE_TIME_KEY = 'cookie-capture-register-card-cache-time';
const REGISTER_CARD_CACHE_LIST_KEY = 'cookie-capture-register-card-cache-list';
const REGISTER_CARD_SELECTED_ID_KEY = 'cookie-capture-register-card-cache-selected-id';
const TEMP_EMAIL_CARD_CACHE_KEY = 'cookie-capture-temp-email-card-cache';
const TEMP_EMAIL_CARD_CACHE_NAME_KEY = 'cookie-capture-temp-email-card-cache-name';
const TEMP_EMAIL_CARD_CACHE_TIME_KEY = 'cookie-capture-temp-email-card-cache-time';
const TEMP_EMAIL_CARD_CACHE_LIST_KEY = 'cookie-capture-temp-email-card-cache-list';
const TEMP_EMAIL_CARD_SELECTED_ID_KEY = 'cookie-capture-temp-email-card-cache-selected-id';
const CARD_SIDEBAR_STATE_KEY = 'cookie-capture-card-sidebar-state';
const STANDALONE_PROGRESS_STATE_KEY = 'cookie-capture-standalone-progress-state';
const STANDALONE_DEBUG_CONTROL_STATE_KEY = 'cookie-capture-standalone-debug-control-state';
let tempEmailRuntimeContext = null;
const runtimeStateStorage = chrome.storage.session || chrome.storage.local;
const standaloneRegistrationSessions = new Map();

function sanitizeFilePart(value = '') {
    return String(value || '')
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
}

function buildFileName(account = '', password = '') {
    const normalizedAccount = sanitizeFilePart(account);
    const normalizedPassword = sanitizeFilePart(password);
    if (normalizedAccount && normalizedPassword) {
        return `${normalizedAccount}_${normalizedPassword}.json`;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `cookie_${timestamp}.json`;
}

function buildRegistrationFileName(cardName = '', account = '', password = '') {
    const baseName = sanitizeFilePart(cardName) || 'registration';
    const normalizedAccount = sanitizeFilePart(account);
    const normalizedPassword = sanitizeFilePart(password);
    if (normalizedAccount && normalizedPassword) {
        return `${baseName}_${normalizedAccount}_${normalizedPassword}.json`;
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `${baseName}_${timestamp}.json`;
}

function buildCaptureFileName(account = '', password = '') {
    return buildFileName(account, password);
}

function normalizeCaptureUrl(url = '') {
    const text = String(url || '').trim();
    if (!text) {
        return '';
    }

    try {
        const parsed = new URL(text);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return parsed.origin;
        }
        return '';
    } catch (_error) {
        return '';
    }
}

function normalizeRegistrationUrl(value = '') {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }

    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(raw)) {
        return raw;
    }

    if (/^(?:localhost|127(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/i.test(raw) || /(?:\.[a-zA-Z]{2,})(?::\d+)?(?:\/|$)/.test(raw)) {
        return `https://${raw}`;
    }

    return raw;
}

function normalizeText(value = '') {
    return String(value || '').trim();
}

function normalizeSelectorList(rawList) {
    const items = Array.isArray(rawList)
        ? rawList
        : typeof rawList === 'string'
            ? rawList.split(/\r?\n/)
            : rawList && typeof rawList === 'object'
                ? [rawList]
                : [];

    const selectors = [];
    const seen = new Set();

    for (const item of items) {
        let selector = '';
        if (typeof item === 'string') {
            selector = item.trim();
        } else if (item && typeof item === 'object') {
            selector = String(
                item.selector
                || item.target
                || item.element
                || item.closeSelector
                || item.close_selector
                || item.dismissSelector
                || item.dismiss_selector
                || ''
            ).trim();
        }

        if (!selector || seen.has(selector)) {
            continue;
        }

        seen.add(selector);
        selectors.push(selector);
    }

    return selectors;
}

function formatStepProgressLabel(stepIndex = 0, stepTotal = 0, stepName = '') {
    const indexValue = Number(stepIndex || 0) || 0;
    const totalValue = Number(stepTotal || 0) || 0;
    const nameValue = String(stepName || '').trim();
    const stepPart = indexValue > 0 && totalValue > 0 ? `第 ${indexValue}/${totalValue} 步` : indexValue > 0 ? `第 ${indexValue} 步` : '步骤';
    return nameValue ? `${stepPart} · ${nameValue}` : stepPart;
}

function normalizeTempEmailProvider(raw = {}, index = 0) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const name = normalizeText(source.name || source.siteName || source.id || `临时邮箱 ${index + 1}`) || `临时邮箱 ${index + 1}`;
    return {
        id: normalizeText(source.id || name || `temp-email-provider-${index + 1}`).replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase() || `temp-email-provider-${index + 1}`,
        name,
        url: normalizeText(source.url || source.link || source.website || ''),
        closePopupSelectors: normalizeSelectorList(
            source.closePopupSelectors
            || source.close_popup_selectors
            || source.closePopups
            || source.close_popups
            || source.initSteps
            || source.steps
            || source.init_steps
        ),
        emailElement: normalizeText(source.emailElement || source.email_element || source.emailSelector || source.email_selector || ''),
        refreshButton: normalizeText(source.refreshButton || source.refresh_button || source.refreshSelector || source.refresh_selector || ''),
        codeClickElement: normalizeText(source.codeClickElement || source.code_click_element || source.codeClickSelector || source.code_click_selector || ''),
        codeElement: normalizeText(source.codeElement || source.code_element || source.codeSelector || source.code_selector || '')
    };
}

function normalizeTempEmailCardData(cardData) {
    if (!cardData || typeof cardData !== 'object' || Array.isArray(cardData)) {
        return {
            name: '临时邮箱',
            selectedProviderId: '',
            providers: [],
            url: ''
        };
    }

    const providers = Array.isArray(cardData.providers)
        ? cardData.providers.map((provider, index) => normalizeTempEmailProvider(provider, index))
        : cardData.url
            ? [normalizeTempEmailProvider(cardData, 0)]
            : [];

    const selectedProviderId = normalizeText(
        cardData.selected_provider
        || cardData.selectedProviderId
        || cardData.current_provider
        || cardData.currentProviderId
        || providers[0]?.id
        || ''
    ).replace(/[^a-zA-Z0-9_-]+/g, '-').toLowerCase() || providers[0].id;

    const normalized = {
        ...cardData,
        name: normalizeText(cardData.name || '临时邮箱卡片') || '临时邮箱卡片',
        selectedProviderId,
        providers,
        url: normalizeText(cardData.url || '')
    };

    return normalized;
}

function buildTempEmailCardCacheId(cardData = {}, sourceName = '') {
    const namePart = sanitizeFilePart(String(cardData?.name || sourceName || 'temp-email'));
    const timePart = new Date().toISOString().replace(/[:.]/g, '-');
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `${namePart || 'temp-email'}_${timePart}_${randomPart}`;
}

function normalizeTempEmailCardCacheEntry(entry = {}, index = 0) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const cardData = normalizeTempEmailCardData(source.cardData || source);
    return {
        id: String(source.id || source.cacheId || '').trim() || buildTempEmailCardCacheId(cardData, source.sourceName || source.fileName || source.cardName || ''),
        cardData,
        cardName: String(source.cardName || cardData.name || '').trim() || cardData.name,
        sourceName: String(source.sourceName || source.fileName || '').trim(),
        savedAt: String(source.savedAt || source.updatedAt || new Date().toISOString()).trim(),
        selected: source.selected === true
    };
}

async function loadTempEmailCardCacheState() {
    const stored = await chrome.storage.local.get([
        TEMP_EMAIL_CARD_CACHE_LIST_KEY,
        TEMP_EMAIL_CARD_SELECTED_ID_KEY,
        TEMP_EMAIL_CARD_CACHE_KEY,
        TEMP_EMAIL_CARD_CACHE_NAME_KEY,
        TEMP_EMAIL_CARD_CACHE_TIME_KEY
    ]);

    const list = Array.isArray(stored[TEMP_EMAIL_CARD_CACHE_LIST_KEY]) ? stored[TEMP_EMAIL_CARD_CACHE_LIST_KEY] : [];
    if (list.length > 0) {
        const items = list.map((item, index) => normalizeTempEmailCardCacheEntry(item, index));
        let selectedId = String(stored[TEMP_EMAIL_CARD_SELECTED_ID_KEY] || '').trim();
        if (!selectedId || !items.some((item) => item.id === selectedId)) {
            selectedId = String(items[0]?.id || '').trim();
        }
        return { items, selectedId };
    }

    const cachedCard = stored[TEMP_EMAIL_CARD_CACHE_KEY];
    if (!cachedCard || typeof cachedCard !== 'object') {
        return { items: [], selectedId: '' };
    }

    const normalized = normalizeTempEmailCardData(cachedCard);
    const legacyId = String(stored[TEMP_EMAIL_CARD_CACHE_NAME_KEY] || normalized.name || 'temp-email').trim() || 'temp-email';
    return {
        items: [{
            id: legacyId,
            cardData: normalized,
            cardName: String(stored[TEMP_EMAIL_CARD_CACHE_NAME_KEY] || normalized.name || '').trim() || normalized.name,
            savedAt: String(stored[TEMP_EMAIL_CARD_CACHE_TIME_KEY] || '').trim()
        }],
        selectedId: legacyId
    };
}

async function saveTempEmailCardCacheState(items = [], selectedId = '') {
    const normalizedItems = Array.isArray(items) ? items.map((item, index) => normalizeTempEmailCardCacheEntry(item, index)) : [];
    const normalizedSelectedId = String(selectedId || normalizedItems[0]?.id || '').trim();
    await chrome.storage.local.set({
        [TEMP_EMAIL_CARD_CACHE_LIST_KEY]: normalizedItems,
        [TEMP_EMAIL_CARD_SELECTED_ID_KEY]: normalizedSelectedId,
        [TEMP_EMAIL_CARD_CACHE_KEY]: normalizedItems.find((item) => item.id === normalizedSelectedId)?.cardData || normalizedItems[0]?.cardData || {},
        [TEMP_EMAIL_CARD_CACHE_NAME_KEY]: normalizedItems.find((item) => item.id === normalizedSelectedId)?.cardName || normalizedItems[0]?.cardName || '',
        [TEMP_EMAIL_CARD_CACHE_TIME_KEY]: normalizedItems.find((item) => item.id === normalizedSelectedId)?.savedAt || normalizedItems[0]?.savedAt || ''
    }).catch(() => {});
    return {
        items: normalizedItems,
        selectedId: normalizedSelectedId
    };
}

function resolveTempEmailProvider(cardData = {}) {
    const providers = Array.isArray(cardData.providers) ? cardData.providers : [];
    if (providers.length === 0) {
        return null;
    }

    const selectedProviderId = normalizeText(cardData.selectedProviderId || cardData.selected_provider || '');
    if (selectedProviderId) {
        const matched = providers.find((provider) => provider && provider.id === selectedProviderId);
        if (matched) {
            return matched;
        }
    }

    return providers[0] || null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

