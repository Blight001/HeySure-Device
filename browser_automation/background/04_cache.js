function normalizeCardData(cardData) {
    if (!cardData || typeof cardData !== 'object' || Array.isArray(cardData)) {
        throw new Error('自动化卡片内容格式不正确');
    }

    const steps = Array.isArray(cardData.steps) ? [...cardData.steps] : [];
    if (steps.length === 0) {
        throw new Error('自动化卡片缺少 steps 步骤');
    }

    const normalized = { ...cardData, steps };
    if (!String(normalized.name || '').trim()) {
        normalized.name = `automation_${Date.now()}`;
    }
    return normalized;
}

function normalizeCardCacheEntry(entry = {}, index = 0) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const cardData = normalizeCardData(source.cardData || source);
    return {
        id: String(source.id || source.cacheId || `${cardData.name || 'automation'}_${index + 1}`).trim(),
        cardData,
        cardName: String(source.cardName || cardData.name || '').trim() || cardData.name,
        savedAt: String(source.savedAt || source.updatedAt || new Date().toISOString()).trim(),
        selected: source.selected === true
    };
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

    const cachedCard = stored[AUTOMATION_CARD_CACHE_KEY];
    if (!cachedCard || typeof cachedCard !== 'object') {
        return { items: [], selectedId: '' };
    }

    const normalized = normalizeCardData(cachedCard);
    const legacyId = String(stored[AUTOMATION_CARD_CACHE_NAME_KEY] || normalized.name || 'automation').trim() || 'automation';
    return {
        items: [{
            id: legacyId,
            cardData: normalized,
            cardName: String(stored[AUTOMATION_CARD_CACHE_NAME_KEY] || normalized.name || '').trim() || normalized.name,
            savedAt: String(stored[AUTOMATION_CARD_CACHE_TIME_KEY] || '').trim()
        }],
        selectedId: legacyId
    };
}

async function loadCardCache() {
    const state = await loadCardCacheState();
    if (!state.items.length) {
        return null;
    }
    const selectedCard = state.items.find((item) => item.id === state.selectedId) || state.items[0];
    if (!selectedCard) {
        return null;
    }
    return {
        cardData: selectedCard.cardData,
        cardName: String(selectedCard.cardName || selectedCard.cardData?.name || '').trim(),
        savedAt: String(selectedCard.savedAt || '').trim(),
        items: state.items,
        selectedId: state.selectedId
    };
}

async function saveCardCacheState(cardData, selectedId = '') {
    const safeCardData = normalizeCardData(cardData);
    const state = await loadCardCacheState().catch(() => ({ items: [], selectedId: '' }));
    const nextItem = normalizeCardCacheEntry({
        id: String(selectedId || state.selectedId || safeCardData.name || 'automation').trim() || safeCardData.name || 'automation',
        cardData: safeCardData,
        cardName: safeCardData.name,
        savedAt: new Date().toISOString()
    });
    const nextItems = state.items.filter((item) => item.id !== nextItem.id);
    nextItems.push(nextItem);
    const nextSelectedId = nextItem.id;
    await chrome.storage.local.set({
        [AUTOMATION_CARD_CACHE_LIST_KEY]: nextItems,
        [AUTOMATION_CARD_SELECTED_ID_KEY]: nextSelectedId,
        [AUTOMATION_CARD_CACHE_KEY]: safeCardData,
        [AUTOMATION_CARD_CACHE_NAME_KEY]: String(safeCardData.name || '').trim(),
        [AUTOMATION_CARD_CACHE_TIME_KEY]: new Date().toISOString()
    }).catch(() => {});
    return {
        items: nextItems,
        selectedId: nextSelectedId,
        cardData: safeCardData
    };
}

async function deleteCardCacheEntry(id) {
    const targetId = String(id || '').trim();
    if (!targetId) {
        throw new Error('缺少要删除的自动化卡片 id');
    }

    const state = await loadCardCacheState().catch(() => ({ items: [], selectedId: '' }));
    if (!state.items.some((item) => item.id === targetId)) {
        throw new Error(`未找到自动化卡片: ${targetId}`);
    }

    const nextItems = state.items.filter((item) => item.id !== targetId);
    const nextSelectedId = state.selectedId === targetId ? String(nextItems[0]?.id || '') : state.selectedId;
    await chrome.storage.local.set({
        [AUTOMATION_CARD_CACHE_LIST_KEY]: nextItems,
        [AUTOMATION_CARD_SELECTED_ID_KEY]: nextSelectedId,
        [AUTOMATION_CARD_CACHE_KEY]: nextItems.find((item) => item.id === nextSelectedId)?.cardData || nextItems[0]?.cardData || {},
        [AUTOMATION_CARD_CACHE_NAME_KEY]: nextItems.find((item) => item.id === nextSelectedId)?.cardName || nextItems[0]?.cardName || '',
        [AUTOMATION_CARD_CACHE_TIME_KEY]: nextItems.find((item) => item.id === nextSelectedId)?.savedAt || nextItems[0]?.savedAt || ''
    }).catch(() => {});

    return {
        deleted: true,
        id: targetId,
        items: nextItems,
        selectedId: nextSelectedId
    };
}

async function loadTempEmailCardCache() {
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
        const selectedCard = items.find((item) => item.id === selectedId) || items[0];
        if (!selectedCard) {
            return null;
        }
        return {
            cardData: selectedCard.cardData,
            cardName: String(selectedCard.cardName || selectedCard.cardData?.name || '').trim(),
            savedAt: String(selectedCard.savedAt || '').trim(),
            items,
            selectedId
        };
    }

    const cachedCard = stored[TEMP_EMAIL_CARD_CACHE_KEY];
    if (!cachedCard || typeof cachedCard !== 'object') {
        return null;
    }

    const normalized = normalizeTempEmailCardData(cachedCard);
    return {
        cardData: normalized,
        cardName: String(stored[TEMP_EMAIL_CARD_CACHE_NAME_KEY] || normalized.name || '').trim(),
        savedAt: String(stored[TEMP_EMAIL_CARD_CACHE_TIME_KEY] || '').trim(),
        items: [{
            id: String(stored[TEMP_EMAIL_CARD_CACHE_NAME_KEY] || normalized.name || 'temp-email').trim() || 'temp-email',
            cardData: normalized,
            cardName: String(stored[TEMP_EMAIL_CARD_CACHE_NAME_KEY] || normalized.name || '').trim() || normalized.name,
            savedAt: String(stored[TEMP_EMAIL_CARD_CACHE_TIME_KEY] || '').trim()
        }],
        selectedId: String(stored[TEMP_EMAIL_CARD_CACHE_NAME_KEY] || normalized.name || 'temp-email').trim() || 'temp-email'
    };
}

async function getRuntimeTempEmailContext() {
    if (!tempEmailRuntimeContext || typeof tempEmailRuntimeContext !== 'object') {
        return null;
    }

    if (tempEmailRuntimeContext.desktopMode === true) {
        return {
            ...tempEmailRuntimeContext,
            tabId: Number(tempEmailRuntimeContext.tabId || 0) || 0
        };
    }

    const normalizedTabId = Number(tempEmailRuntimeContext.tabId || 0) || 0;
    if (!normalizedTabId) {
        return null;
    }

    const tab = await chrome.tabs.get(normalizedTabId).catch(() => null);
    if (!tab) {
        tempEmailRuntimeContext = null;
        return null;
    }

    return {
        ...tempEmailRuntimeContext,
        tabId: normalizedTabId
    };
}

function normalizeStandaloneSteps(cardData) {
    const normalizedCard = normalizeCardData(cardData);
    const steps = Array.isArray(normalizedCard.steps) ? [...normalizedCard.steps] : [];
    const firstMeaningfulStep = steps.find((step) => step && typeof step === 'object');
    if (!firstMeaningfulStep || String(firstMeaningfulStep.type || '').trim().toLowerCase() !== 'navigate') {
        if (normalizedCard.website) {
            steps.unshift({
                name: '访问网站',
                type: 'navigate',
                url: normalizedCard.website
            });
        }
    }
    return { ...normalizedCard, steps };
}

function extractEmailAddress(text = '') {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    const match = normalized.match(/[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}/i);
    return match ? match[0] : '';
}

function extractVerificationCodeFromText(text = '') {
    const structured = String(text || '')
        .replace(/[\u00a0\u200b-\u200d\ufeff]/g, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p\s*>/gi, '\n')
        .replace(/<\/div\s*>/gi, '\n')
        .replace(/<\/h[1-6]\s*>/gi, '\n')
        .replace(/<\/li\s*>/gi, '\n')
        .replace(/<\/tr\s*>/gi, '\n')
        .replace(/<\/table\s*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'");

    const rawLines = structured
        .split(/[\r\n]+/)
        .map((line) => line.trim())
        .filter(Boolean);
    const normalized = rawLines.join(' ').replace(/\s+/g, ' ').trim();

    if (!normalized) {
        return '';
    }

    const codeKeywords = [
        /(?:验证码|验证代码|校验码|确认码|激活码|注册码|安全码|动态码|一次性密码|临时码|临时验证码)/i,
        /(?:verification\s+code|verify\s+code|auth\s+code|security\s+code|access\s+code|otp|pin|token|passcode|code)/i
    ];

    const stopWords = new Set([
        'copy', 'paste', 'valid', 'please', 'email', 'login', 'ignore', 'request', 'verification',
        'code', 'your', 'the', 'and', 'or', 'for', 'from', 'code.', 'message', 'hello', 'dear',
        'this', 'that', 'click', 'here', 'again', 'send', 'open', 'show', 'view', 'read'
    ]);

    const extractCodeToken = (line = '') => {
        const compactLine = String(line || '').replace(/\s+/g, ' ').trim();
        if (!compactLine) {
            return '';
        }

        const digitMatches = compactLine.match(/\b\d{4,8}\b/g) || [];
        if (digitMatches.length > 0) {
            return digitMatches[0];
        }

        const candidateMatches = compactLine.match(/\b[A-Z0-9]{4,15}\b/gi) || [];
        for (const candidate of candidateMatches) {
            const normalizedCandidate = String(candidate || '').trim();
            if (!normalizedCandidate) {
                continue;
            }
            const lowerCandidate = normalizedCandidate.toLowerCase();
            if (stopWords.has(lowerCandidate)) {
                continue;
            }
            if (!/[0-9]/.test(normalizedCandidate)) {
                continue;
            }
            return normalizedCandidate;
        }

        return '';
    };

    for (const line of rawLines) {
        const hasKeyword = codeKeywords.some((pattern) => pattern.test(line));
        if (!hasKeyword) {
            continue;
        }

        const candidate = extractCodeToken(line);
        if (candidate) {
            return candidate.replace(/[\s-]/g, '').trim();
        }
    }

    for (const line of rawLines) {
        const candidate = extractCodeToken(line);
        if (candidate) {
            return candidate.replace(/[\s-]/g, '').trim();
        }
    }

    const joinedPatterns = [
        /\b(\d{4,8})\b/,
        /\b([A-Z0-9]{4,15})\b/i
    ];

    for (const pattern of joinedPatterns) {
        const match = normalized.match(pattern);
        if (match && match[1]) {
            const candidate = String(match[1]).replace(/[\s-]/g, '').trim();
            if (candidate && /[0-9]/.test(candidate)) {
                return candidate;
            }
        }
    }

    return '';
}

