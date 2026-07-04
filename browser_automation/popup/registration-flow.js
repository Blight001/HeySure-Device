try {
    const layout = new URL(window.location.href).searchParams.get('layout') === 'sidebar' ? 'sidebar' : 'popup';
    document.documentElement.dataset.layout = layout;
} catch (_error) {
    document.documentElement.dataset.layout = 'popup';
}

await import('./shared.js');
await import('./cookie-credentials.js');

const shared = globalThis.CookieCaptureShared || {};
const cookieModule = globalThis.CookieCaptureCookieCredentials || {};
const {
    formatCookieCredentialTime,
    padCookieCredentialDatePart,
    getTodayCookieCredentialDateKey,
    getCookieCredentialDateKey,
    getCookieCredentialDateFromKey,
    getCookieCredentialYesterdayKey,
    formatCookieCredentialDateLabel,
    formatCookieCredentialTimeLabel,
    buildCookieCredentialSearchText,
    normalizeCookieCredentialSearchQuery,
    cookieCredentialItemMatchesQuery,
    buildCookieCredentialCacheId,
    normalizeCookieCredentialCacheEntry,
    buildCookieCredentialListLabel,
    buildCookieCredentialClipboardText,
    buildCookieCredentialAccountPasswordText,
    buildCookieCredentialGroupAccountPasswordText,
    focusCookieCredentialEditPanel,
    closeCookieCredentialEditPanel,
    syncCookieCredentialEditUi,
    setCookieCredentialEditTarget,
    clearCookieCredentialEditTarget,
    loadCookieCredentialCacheState,
    saveCookieCredentialCacheState,
    loadCookieCredentialFilterState,
    saveCookieCredentialFilterState,
    setCookieCredentialSelectedDate,
    setCookieCredentialSearchQuery,
    getCookieCredentialSelectedDateValue,
    getCookieCredentialVisibleItems,
    buildCookieCredentialDateOptions,
    renderCookieCredentialDateFilterOptions,
    buildCookieCredentialEmptyMessage,
    renderCookieCredentialCacheList,
    refreshCookieCredentialCacheUi,
    rerenderCookieCredentialCacheUi,
    copyCookieInputValue,
    copyCookieCredentialItem,
    copyCookieCredentialAccountPasswordItem,
    copyCookieCredentialAccountPasswordGroup,
    editCookieCredentialItem,
    saveCookieCredentialEditRecord,
    deleteCookieCredentialItem,
    savePreset,
    loadPreset,
    saveCookieCredentialRecord,
    captureCurrentTab,
    clearCurrentPageCache
} = cookieModule;

const ACCOUNT_KEY = shared.STORAGE_KEYS.ACCOUNT_KEY;
const PASSWORD_KEY = shared.STORAGE_KEYS.PASSWORD_KEY;
const COOKIE_NOTE_KEY = shared.STORAGE_KEYS.COOKIE_NOTE_KEY;
const COOKIE_CARD_KEY = shared.STORAGE_KEYS.COOKIE_CARD_KEY;
const COOKIE_CREDENTIAL_CACHE_LIST_KEY = shared.STORAGE_KEYS.COOKIE_CREDENTIAL_CACHE_LIST_KEY;
const COOKIE_CREDENTIAL_SELECTED_DATE_KEY = shared.STORAGE_KEYS.COOKIE_CREDENTIAL_SELECTED_DATE_KEY;
const COOKIE_CREDENTIAL_SEARCH_KEY = shared.STORAGE_KEYS.COOKIE_CREDENTIAL_SEARCH_KEY;
const COOKIE_CREDENTIAL_CACHE_MAX_ITEMS = 50;
const REGISTER_CARD_CACHE_KEY = shared.STORAGE_KEYS.REGISTER_CARD_CACHE_KEY;
const REGISTER_CARD_CACHE_NAME_KEY = shared.STORAGE_KEYS.REGISTER_CARD_CACHE_NAME_KEY;
const REGISTER_CARD_CACHE_TIME_KEY = shared.STORAGE_KEYS.REGISTER_CARD_CACHE_TIME_KEY;
const REGISTER_CARD_CACHE_LIST_KEY = shared.STORAGE_KEYS.REGISTER_CARD_CACHE_LIST_KEY;
const REGISTER_CARD_SELECTED_ID_KEY = shared.STORAGE_KEYS.REGISTER_CARD_SELECTED_ID_KEY;
const LAST_MAIN_PANEL_KEY = shared.STORAGE_KEYS.LAST_MAIN_PANEL_KEY;
const STANDALONE_PROGRESS_STATE_KEY = shared.STORAGE_KEYS.STANDALONE_PROGRESS_STATE_KEY;
const STANDALONE_DEBUG_CONTROL_STATE_KEY = shared.STORAGE_KEYS.STANDALONE_DEBUG_CONTROL_STATE_KEY;

const accountInput = document.getElementById('account');
const passwordInput = document.getElementById('password');
const cookieNoteInput = document.getElementById('cookie-note');
const cookieCardKeyInput = document.getElementById('cookie-card-key');
const copyCookieAccountButton = document.getElementById('copy-cookie-account');
const copyCookiePasswordButton = document.getElementById('copy-cookie-password');
const generateCookiePasswordButton = document.getElementById('generate-cookie-password');
const copyAccountPasswordButton = document.getElementById('copy-account-password');
const saveCookieCredentialsButton = document.getElementById('save-cookie-credentials');
const cookieCredentialEditPanelNode = document.getElementById('cookie-credential-edit-panel');
const cookieCredentialEditPanelSubtitleNode = document.getElementById('cookie-credential-edit-panel-subtitle');
const editCookieAccountInput = document.getElementById('edit-account');
const editCookiePasswordInput = document.getElementById('edit-password');
const editCookieNoteInput = document.getElementById('edit-note');
const editCookieCardKeyInput = document.getElementById('edit-card-key');
const saveCookieCredentialEditButton = document.getElementById('save-cookie-credential-edit');
const cancelCookieEditButton = document.getElementById('cancel-cookie-edit');
const cookieCredentialDateFilterNode = document.getElementById('cookie-credential-date-filter');
const cookieCredentialSearchNode = document.getElementById('cookie-credential-search');
const captureButton = document.getElementById('capture');
const clearCurrentPageCacheButton = document.getElementById('clear-current-page-cache');
const statusNode = document.getElementById('status');
const cookieCredentialCountNode = document.getElementById('cookie-credential-count');
const cookieCredentialListNode = document.getElementById('cookie-credential-list');
const registerCardFileInput = document.getElementById('register-card-file');
const pickRegisterCardFileButton = document.getElementById('pick-register-card-file');
const importRegisterCardButton = document.getElementById('import-register-card');
const loopRegisterCardButton = document.getElementById('loop-register-card');
const cardFileNameNode = document.getElementById('card-file-name');
const cardCacheBadgeNode = document.getElementById('card-cache-badge');
const cardCacheListNode = document.getElementById('card-cache-list');
const deleteRegisterCardButton = document.getElementById('delete-register-card');
const registerCardEditor = document.getElementById('register-card-editor');
const loadCardToEditorButton = document.getElementById('load-card-to-editor');
const saveCardEditorButton = document.getElementById('save-card-editor');
const exportRegisterCardButton = document.getElementById('export-register-card');
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
const sidebarLoopRegisterButton = document.getElementById('sidebar-loop-register-card');
const sidebarRefreshCardButton = document.getElementById('sidebar-refresh-card');
const sidebarCloseButton = document.getElementById('sidebar-close');
const sidebarTutorialButton = document.getElementById('sidebar-tutorial');
const sidebarStepListNode = document.getElementById('sidebar-step-list');
const sidebarEditorMetaNode = document.getElementById('sidebar-editor-meta');
const TUTORIAL_URL = 'https://www.yuque.com/heysure/mn6q55/lyorlysczr8eh39b?singleDoc#';
const runtimeStateStorage = chrome.storage.session || chrome.storage.local;
let activeDebugErrorReason = '';
let debugProgressAutoHideTimer = null;

await import('./register-workbench.js');
const registerModule = globalThis.CookieCaptureRegisterWorkbench || {};
const {
    clearDebugProgressAutoHideTimer,
    scheduleDebugProgressAutoHide,
    buildPresetFileName,
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
    buildRegisterCardExportFileName,
    buildRegisterCardCacheId,
    normalizeRegisterCardCacheEntry,
    buildRegisterCardListLabel,
    renderRegisterCardCacheList,
    normalizeProgressValue,
    setDebugProgress,
    resetDebugProgress,
    loadStandaloneProgressState,
    loadStandaloneDebugControlState,
    formatStepTypeLabel,
    normalizeDebugControlMode,
    setDebugControlMode,
    setRegisterLoopButtonState,
    refreshRegisterLoopButtonState,
    refreshDebugControlUi,
    sendDebugControlAction,
    sendRegistrationStopAction,
    syncSidebarCardToRunningDebugSession,
    normalizeCardData,
    stringifyCardData,
    parseEditorCardData,
    setRegisterCardEditorValue,
    getRegisterCardEditorValue,
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
    getRegisterCardDataForExport,
    exportRegisterCard,
    loadRegisterCardCacheState,
    saveRegisterCardCacheState,
    refreshRegisterCardCacheUi,
    selectRegisterCardCacheItem,
    upsertRegisterCardCache,
    renderSidebarEditorFromCurrentState,
    saveCardCache,
    saveEditorCardToCache
} = registerModule;

async function loadRegisterCardIntoEditor() {
    const imported = await importSelectedRegisterCardFilesToCache().catch(() => null);
    const cachedCard = await loadCardCache().catch(() => null);
    const cardData = imported?.selectedItem?.cardData || cachedCard?.cardData || null;
    if (!cardData) {
        throw new Error('没有可载入的注册卡片');
    }
    if (isSidebarLayout()) {
        renderSidebarCardEditor(cardData);
        syncSidebarEditorToHiddenJson();
    } else {
        setRegisterCardEditorValue(cardData);
    }
    if (cardData?.name) {
        setCardFileName(cardData.name);
    }
    return cardData;
}

async function loadCardCache() {
    const state = await loadRegisterCardCacheState();
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

async function clearCardCache() {
    await chrome.storage.local.remove([
        REGISTER_CARD_CACHE_LIST_KEY,
        REGISTER_CARD_SELECTED_ID_KEY,
        REGISTER_CARD_CACHE_KEY,
        REGISTER_CARD_CACHE_NAME_KEY,
        REGISTER_CARD_CACHE_TIME_KEY
    ]);
    if (registerCardFileInput) {
        registerCardFileInput.value = '';
    }
    renderRegisterCardCacheList({ items: [], selectedId: '' });
    setCardFileName('未选择卡片');
}

async function deleteSelectedRegisterCardCache() {
    const state = await loadRegisterCardCacheState().catch(() => ({ items: [], selectedId: '' }));
    const items = Array.isArray(state.items) ? state.items : [];
    if (!items.length) {
        throw new Error('没有可删除的注册卡片');
    }

    const selectedId = String(state.selectedId || items[0]?.id || '').trim();
    const selectedIndex = items.findIndex((item) => String(item.id || '').trim() === selectedId);
    const removeIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const deletedItem = items[removeIndex] || null;
    const nextItems = items.slice();
    nextItems.splice(removeIndex, 1);

    if (nextItems.length === 0) {
        await chrome.storage.local.remove([
            REGISTER_CARD_CACHE_LIST_KEY,
            REGISTER_CARD_SELECTED_ID_KEY,
            REGISTER_CARD_CACHE_KEY,
            REGISTER_CARD_CACHE_NAME_KEY,
            REGISTER_CARD_CACHE_TIME_KEY
        ]);
        renderRegisterCardCacheList({ items: [], selectedId: '' });
        setCardFileName('未选择卡片');
        return deletedItem;
    }

    const nextSelectedId = String(nextItems[0]?.id || '').trim();
    await saveRegisterCardCacheState(nextItems, nextSelectedId);
    const nextItem = nextItems.find((item) => item.id === nextSelectedId) || nextItems[0];
    if (isSidebarLayout()) {
        renderSidebarCardEditor(nextItem.cardData);
        syncSidebarEditorToHiddenJson();
    } else {
        setRegisterCardEditorValue(nextItem.cardData);
    }
    renderRegisterCardCacheList({
        items: nextItems,
        selectedId: nextSelectedId
    });
    setCardFileName(nextItem.cardData?.name || nextItem.cardName || '未选择卡片');
    return deletedItem;
}

async function readSelectedCardFiles() {
    const files = Array.from(registerCardFileInput?.files || []).filter(Boolean);
    if (files.length === 0) {
        return [];
    }

    const cards = [];
    for (const file of files) {
        const rawText = await file.text();
        let cardData;
        try {
            cardData = JSON.parse(rawText);
        } catch (_error) {
            throw new Error(`注册卡片文件不是有效的 JSON: ${file.name}`);
        }
        cards.push(normalizeCardData(cardData, file.name, { allowEmptySteps: true }));
    }

    return cards;
}

async function readSelectedCardFile() {
    const cards = await readSelectedCardFiles();
    return cards[0] || null;
}

function sendStandaloneMessage(payload) {
    return chrome.runtime.sendMessage(payload);
}

async function openCardEditorSidebar() {
    const result = await chrome.runtime.sendMessage({
        type: 'open-card-editor-sidebar',
        payload: {
            width: 900
        }
    });

    if (!result || result.success !== true) {
        throw new Error(result?.error || '打开侧边栏失败');
    }

    return result;
}

async function resolveRegisterCardForRun() {
    if (isSidebarLayout()) {
        const cardData = normalizeCardData(getSidebarCardDataFromEditor(), 'registration');
        await saveCardCache(cardData);
        return cardData;
    }

    const editorText = getRegisterCardEditorValue().trim();
    if (editorText) {
        const cardData = parseEditorCardData(editorText);
        await saveCardCache(cardData);
        return cardData;
    }

    const imported = await importSelectedRegisterCardFilesToCache().catch(() => null);
    if (imported?.selectedItem?.cardData) {
        const cardData = normalizeCardData(imported.selectedItem.cardData, imported.selectedItem.cardName || 'registration');
        setRegisterCardEditorValue(cardData);
        await saveCardCache(cardData);
        return cardData;
    }

    const cachedCard = await loadCardCache().catch(() => null);
    if (cachedCard?.cardData) {
        const cardData = normalizeCardData(cachedCard.cardData, cachedCard?.cardName || cachedCard.cardData?.name || 'registration');
        setRegisterCardEditorValue(cardData);
        return cardData;
    }

    throw new Error('请先导入或编辑注册卡片');
}

async function importSelectedRegisterCardFilesToCache() {
    const selectedCards = await readSelectedCardFiles();
    if (!selectedCards.length) {
        return null;
    }

    const items = [];
    for (const cardData of selectedCards) {
        const result = await upsertRegisterCardCache(cardData, {
            append: true,
            select: false,
            fileName: cardData.name
        });
        items.push({
            id: result.id,
            cardData: result.cardData,
            cardName: result.cardName,
            savedAt: new Date().toISOString(),
            sourceName: cardData.name
        });
    }

    const selectedItem = items[items.length - 1] || null;
    if (selectedItem) {
        const state = await loadRegisterCardCacheState().catch(() => ({ items: [], selectedId: '' }));
        await saveRegisterCardCacheState(state.items, selectedItem.id);
        renderRegisterCardCacheList({
            items: state.items,
            selectedId: selectedItem.id
        });
        if (isSidebarLayout()) {
            renderSidebarCardEditor(selectedItem.cardData);
            syncSidebarEditorToHiddenJson();
        } else {
            setRegisterCardEditorValue(selectedItem.cardData);
        }
        setCardFileName(selectedItem.cardName);
    }

    if (registerCardFileInput) {
        registerCardFileInput.value = '';
    }

    return {
        items,
        selectedItem
    };
}

async function importAndStartRegistration() {
    importRegisterCardButton.disabled = true;
    showActionToast('正在准备注册卡片...', 'info');
    setDebugProgress({
        visible: true,
        progress: 0,
        message: '正在启动注册流程...',
        meta: '注册模式',
        mode: 'run'
    });

    try {
        await savePreset();
        const imported = await importSelectedRegisterCardFilesToCache().catch(() => null);
        const cardData = imported?.selectedItem?.cardData || await resolveRegisterCardForRun();
        const savedCardData = await saveCardCache(cardData);

        showActionToast(`已启动本地注册: ${savedCardData.name}`, 'info');
        void sendStandaloneMessage({
            type: 'standalone-registration-start',
            payload: {
                cardData: savedCardData
            }
        }).catch((error) => {
            showActionToast(error && error.message ? error.message : '启动注册失败', 'error');
        });

    } catch (error) {
        showActionToast(error && error.message ? error.message : '导入并注册失败', 'error');
    } finally {
        importRegisterCardButton.disabled = false;
    }
}

async function registerLoopCard() {
    const isRunning = await refreshRegisterLoopButtonState();
    if (isRunning) {
        loopRegisterCardButton && (loopRegisterCardButton.disabled = true);
        sidebarLoopRegisterButton && (sidebarLoopRegisterButton.disabled = true);
        showActionToast('正在停止注册流程...', 'info');
        try {
            await sendRegistrationStopAction();
            showActionToast('已停止注册流程', 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '停止注册失败', 'error');
            await refreshRegisterLoopButtonState().catch(() => {});
        } finally {
            if (loopRegisterCardButton) {
                loopRegisterCardButton.disabled = false;
            }
            if (sidebarLoopRegisterButton) {
                sidebarLoopRegisterButton.disabled = false;
            }
        }
        return;
    }

    loopRegisterCardButton && (loopRegisterCardButton.disabled = true);
    sidebarLoopRegisterButton && (sidebarLoopRegisterButton.disabled = true);
    showActionToast('正在启动循环注册...', 'info');
    setDebugProgress({
        visible: true,
        progress: 0,
        message: '正在启动循环注册...',
        meta: '循环模式',
        mode: 'loop'
    });

    try {
        const imported = await importSelectedRegisterCardFilesToCache().catch(() => null);
        const cardData = imported?.selectedItem?.cardData || await resolveRegisterCardForRun();
        await saveCardCache(cardData);

        setRegisterLoopButtonState(true);
        void sendStandaloneMessage({
            type: 'standalone-registration-start',
            payload: {
                cardData,
                loopRegistration: true
            }
        }).catch((error) => {
            showActionToast(error && error.message ? error.message : '循环注册失败', 'error');
            void refreshRegisterLoopButtonState().catch(() => {});
        });

        showActionToast(`已开始循环注册: ${cardData.name || '未命名卡片'}`, 'success');
    } catch (error) {
        showActionToast(error && error.message ? error.message : '循环注册失败', 'error');
        await refreshRegisterLoopButtonState().catch(() => {});
    } finally {
        if (loopRegisterCardButton) {
            loopRegisterCardButton.disabled = false;
        }
        if (sidebarLoopRegisterButton) {
            sidebarLoopRegisterButton.disabled = false;
        }
    }
}
globalThis.CookieCaptureRegistrationFlow = {
    loadRegisterCardIntoEditor,
    loadCardCache,
    clearCardCache,
    deleteSelectedRegisterCardCache,
    readSelectedCardFiles,
    readSelectedCardFile,
    sendStandaloneMessage,
    openCardEditorSidebar,
    resolveRegisterCardForRun,
    importSelectedRegisterCardFilesToCache,
    importAndStartRegistration,
    registerLoopCard
};
