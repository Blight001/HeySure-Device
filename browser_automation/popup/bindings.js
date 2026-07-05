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
    importCookiesFromText,
    savePreset,
    loadPreset,
    saveCookieCredentialRecord,
    captureCurrentTab,
    clearCurrentPageCache,
    getCurrentActiveTabForCookieManager,
    refreshCookieManagerList,
    openCookieManagerPanel,
    closeCookieManagerPanel,
    deleteCookieManagerItem
} = cookieModule;

const ACCOUNT_KEY = shared.STORAGE_KEYS.ACCOUNT_KEY;
const PASSWORD_KEY = shared.STORAGE_KEYS.PASSWORD_KEY;
const COOKIE_NOTE_KEY = shared.STORAGE_KEYS.COOKIE_NOTE_KEY;
const COOKIE_CARD_KEY = shared.STORAGE_KEYS.COOKIE_CARD_KEY;
const COOKIE_CREDENTIAL_CACHE_LIST_KEY = shared.STORAGE_KEYS.COOKIE_CREDENTIAL_CACHE_LIST_KEY;
const COOKIE_CREDENTIAL_SELECTED_DATE_KEY = shared.STORAGE_KEYS.COOKIE_CREDENTIAL_SELECTED_DATE_KEY;
const COOKIE_CREDENTIAL_SEARCH_KEY = shared.STORAGE_KEYS.COOKIE_CREDENTIAL_SEARCH_KEY;
const COOKIE_CREDENTIAL_CACHE_MAX_ITEMS = 50;
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
const cookieNoteInput = document.getElementById('cookie-note');
const cookieCardKeyInput = document.getElementById('cookie-card-key');
const cookieImportFileInput = document.getElementById('cookie-import-file');
const copyCookieAccountButton = document.getElementById('copy-cookie-account');
const copyCookiePasswordButton = document.getElementById('copy-cookie-password');
const generateCookiePasswordButton = document.getElementById('generate-cookie-password');
const copyAccountPasswordButton = document.getElementById('copy-account-password');
const importCookieButton = document.getElementById('import-cookie');
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
const cookieManagerPanelNode = document.getElementById('cookie-manager-panel');
const closeCookieManagerButton = document.getElementById('close-cookie-manager');
const refreshCookieManagerButton = document.getElementById('refresh-cookie-manager');
const downloadCookieManagerButton = document.getElementById('download-cookie-manager');
const clearAllCookieManagerButton = document.getElementById('clear-all-cookie-manager');
const cookieManagerListNode = document.getElementById('cookie-manager-list');
const statusNode = document.getElementById('status');
const cookieCredentialCountNode = document.getElementById('cookie-credential-count');
const cookieCredentialListNode = document.getElementById('cookie-credential-list');
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
const TUTORIAL_URL = 'https://www.yuque.com/heysure/mn6q55/lyorlysczr8eh39b?singleDoc#';
const runtimeStateStorage = chrome.storage.session || chrome.storage.local;
let activeDebugErrorReason = '';
let debugProgressAutoHideTimer = null;

await import('./automation-workbench.js');
const workbenchModule = globalThis.CookieCaptureAutomationWorkbench || {};
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
} = workbenchModule;
const { generateCookiePassword } = shared;

await import('./automation-flow.js');

const flowModule = globalThis.CookieCaptureAutomationFlow || {};
const {
    loadCardIntoEditor,
    loadCardCache,
    clearCardCache,
    deleteSelectedCardCache,
    readSelectedCardFiles,
    readSelectedCardFile,
    sendStandaloneMessage,
    openCardEditorSidebar,
    resolveCardForRun,
    importSelectedCardFilesToCache,
    importAndStartCard,
    loopCard
} = flowModule;
accountInput?.addEventListener('input', () => {
    void savePreset();
});

passwordInput?.addEventListener('input', () => {
    void savePreset();
});

cookieNoteInput?.addEventListener('input', () => {
    void savePreset();
});

cookieCardKeyInput?.addEventListener('input', () => {
    void savePreset();
});

cookieCredentialDateFilterNode?.addEventListener('change', () => {
    setCookieCredentialSelectedDate(cookieCredentialDateFilterNode.value);
    void saveCookieCredentialFilterState();
    void rerenderCookieCredentialCacheUi().catch(() => {});
});

cookieCredentialSearchNode?.addEventListener('input', () => {
    setCookieCredentialSearchQuery(cookieCredentialSearchNode.value);
    void saveCookieCredentialFilterState();
    void rerenderCookieCredentialCacheUi().catch(() => {});
});

generateCookiePasswordButton?.addEventListener('click', () => {
    const password = generateCookiePassword(12);
    if (passwordInput) {
        passwordInput.value = password;
    }
    void savePreset();
    showActionToast('已生成 12 位随机密码', 'success');
});

copyAccountPasswordButton?.addEventListener('click', () => {
    void (async () => {
        copyAccountPasswordButton.disabled = true;
        try {
            const account = String(accountInput?.value || '').trim();
            const password = String(passwordInput?.value || '').trim();
            await copyTextToClipboard(`${account}   ${password}`);
            showActionToast('已复制账号密码', 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '复制账号密码失败', 'error');
        } finally {
            copyAccountPasswordButton.disabled = false;
        }
    })();
});

copyCookieAccountButton?.addEventListener('click', () => {
    void (async () => {
        copyCookieAccountButton.disabled = true;
        try {
            await copyCookieInputValue(accountInput, '账号');
            showActionToast('已复制账号', 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '复制账号失败', 'error');
        } finally {
            copyCookieAccountButton.disabled = false;
        }
    })();
});

copyCookiePasswordButton?.addEventListener('click', () => {
    void (async () => {
        copyCookiePasswordButton.disabled = true;
        try {
            await copyCookieInputValue(passwordInput, '密码');
            showActionToast('已复制密码', 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '复制密码失败', 'error');
        } finally {
            copyCookiePasswordButton.disabled = false;
        }
    })();
});

saveCookieCredentialsButton?.addEventListener('click', () => {
    void (async () => {
        saveCookieCredentialsButton.disabled = true;
        try {
            const saved = await saveCookieCredentialRecord();
            showActionToast(
                `已保存缓存记录${saved.note ? `: ${saved.note}` : ''}${saved.cardKey ? ` / ${saved.cardKey}` : ''}`,
                'success'
            );
        } catch (error) {
            showActionToast(error && error.message ? error.message : '保存缓存失败', 'error');
        } finally {
            saveCookieCredentialsButton.disabled = false;
        }
    })();
});

saveCookieCredentialEditButton?.addEventListener('click', () => {
    void (async () => {
        saveCookieCredentialEditButton.disabled = true;
        try {
            const saved = await saveCookieCredentialEditRecord();
            showActionToast(
                `已更新缓存记录${saved.note ? `: ${saved.note}` : ''}${saved.cardKey ? ` / ${saved.cardKey}` : ''}`,
                'success'
            );
        } catch (error) {
            showActionToast(error && error.message ? error.message : '保存修改失败', 'error');
        } finally {
            saveCookieCredentialEditButton.disabled = false;
        }
    })();
});

cookieCredentialListNode?.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[data-cookie-credential-action]') : null;
    if (!button) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const itemNode = button.closest('[data-cookie-credential-item]');
    const cardId = String(itemNode?.dataset?.cookieId || '').trim();
    const action = String(button.dataset.cookieCredentialAction || '').trim();

    void (async () => {
        button.disabled = true;
        try {
            if (action === 'copy-group-account-password') {
                const groupDate = String(button.dataset.cookieGroupDate || '').trim();
                const groupItems = await copyCookieCredentialAccountPasswordGroup(groupDate);
                showActionToast(`已复制 ${groupItems.length} 条账号密码`, 'success');
                return;
            }

            if (!cardId) {
                throw new Error('未找到可操作的缓存记录');
            }

            if (action === 'copy') {
                const item = await copyCookieCredentialItem(cardId);
                showActionToast(`已复制完整信息: ${item.note || item.cardKey || item.account || '记录'}`, 'success');
                return;
            }

            if (action === 'copy-account-password') {
                const item = await copyCookieCredentialAccountPasswordItem(cardId);
                showActionToast(`已复制账号密码: ${item.note || item.cardKey || item.account || '记录'}`, 'success');
                return;
            }

            if (action === 'edit') {
                const item = await editCookieCredentialItem(cardId);
                showActionToast(`已载入编辑: ${item.note || item.cardKey || item.account || '记录'}`, 'success');
                return;
            }

            if (action === 'delete') {
                const item = await deleteCookieCredentialItem(cardId);
                if (item) {
                    showActionToast(`已删除缓存记录: ${item.note || item.cardKey || item.account || '记录'}`, 'success');
                }
                return;
            }

            throw new Error('未知操作');
        } catch (error) {
            const fallback = action === 'copy'
                ? '复制完整信息失败'
                : action === 'copy-account-password'
                    ? '复制账号密码失败'
                    : action === 'copy-group-account-password'
                        ? '复制分组账号密码失败'
                : action === 'edit'
                    ? '编辑缓存失败'
                    : action === 'delete'
                        ? '删除缓存失败'
                        : '操作失败';
            showActionToast(error && error.message ? error.message : fallback, 'error');
        } finally {
            button.disabled = false;
        }
    })();
});

cancelCookieEditButton?.addEventListener('click', () => {
    void closeCookieCredentialEditPanel('已取消编辑');
});

cookieCredentialEditPanelNode?.addEventListener('click', (event) => {
    if (event.target === cookieCredentialEditPanelNode) {
        void closeCookieCredentialEditPanel('已关闭编辑弹窗');
    }
});

document.addEventListener('keydown', (event) => {
    if (String(event.key || '').toLowerCase() !== 'escape') {
        return;
    }
    if (!cookieCredentialEditPanelNode || !cookieCredentialEditPanelNode.classList.contains('is-visible')) {
        return;
    }
    void closeCookieCredentialEditPanel('已关闭编辑弹窗');
});

cardFileInput?.addEventListener('change', () => {
    const files = Array.from(cardFileInput.files || []).filter(Boolean);
    if (files.length === 0) {
        void refreshCardCacheUi().catch(() => {});
        return;
    }

    setCardFileName(files.length === 1 ? files[0].name : `已选择 ${files.length} 个文件`);
    showActionToast(files.length > 1 ? `已选择 ${files.length} 个自动化卡片` : `已选择: ${files[0].name}`, 'info');
});

pickCardFileButton?.addEventListener('click', () => {
    cardFileInput?.click();
});

deleteCardButton?.addEventListener('click', () => {
    void deleteSelectedCardCache().then(() => {
        showActionToast('已删除选中自动化卡片', 'success');
    }).catch((error) => {
        showActionToast(error && error.message ? error.message : '删除选中卡片失败', 'error');
    });
});

cardCacheListNode?.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[data-card-cache-action="select"]') : null;
    if (!button) {
        return;
    }

    const item = button.closest('[data-card-cache-item]');
    const cardId = String(item?.dataset.cardId || '').trim();
    if (!cardId) {
        return;
    }

    void (async () => {
        button.disabled = true;
        try {
            const selected = await selectCardCacheItem(cardId);
            showActionToast(`已选中自动化卡片: ${selected.cardName || selected.cardData?.name || '未命名'}`, 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '选择自动化卡片失败', 'error');
        } finally {
            button.disabled = false;
        }
    })();
});

captureButton?.addEventListener('click', () => {
    void openCookieManagerPanel();
});

closeCookieManagerButton?.addEventListener('click', () => {
    closeCookieManagerPanel();
});

cookieManagerPanelNode?.addEventListener('click', (event) => {
    if (event.target === cookieManagerPanelNode) {
        closeCookieManagerPanel();
    }
});

document.addEventListener('keydown', (event) => {
    if (String(event.key || '').toLowerCase() !== 'escape') {
        return;
    }
    if (!cookieManagerPanelNode || !cookieManagerPanelNode.classList.contains('is-visible')) {
        return;
    }
    closeCookieManagerPanel();
});

refreshCookieManagerButton?.addEventListener('click', () => {
    void (async () => {
        refreshCookieManagerButton.disabled = true;
        try {
            await refreshCookieManagerList();
        } catch (error) {
            showActionToast(error && error.message ? error.message : '刷新 Cookie 列表失败', 'error');
        } finally {
            refreshCookieManagerButton.disabled = false;
        }
    })();
});

downloadCookieManagerButton?.addEventListener('click', () => {
    void (async () => {
        downloadCookieManagerButton.disabled = true;
        try {
            await captureCurrentTab();
        } finally {
            downloadCookieManagerButton.disabled = false;
        }
    })();
});

clearAllCookieManagerButton?.addEventListener('click', () => {
    void (async () => {
        clearAllCookieManagerButton.disabled = true;
        try {
            await clearCurrentPageCache();
            await refreshCookieManagerList().catch(() => {});
        } finally {
            clearAllCookieManagerButton.disabled = false;
        }
    })();
});

cookieManagerListNode?.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[data-cookie-manager-action="delete"]') : null;
    if (!button) {
        return;
    }

    const itemNode = button.closest('[data-cookie-manager-item]');
    void (async () => {
        button.disabled = true;
        try {
            const result = await deleteCookieManagerItem(itemNode);
            showActionToast(`已删除 Cookie: ${result.name}`, 'success');
            await refreshCookieManagerList().catch(() => {});
        } catch (error) {
            showActionToast(error && error.message ? error.message : '删除 Cookie 失败', 'error');
            button.disabled = false;
        }
    })();
});

importCookieButton?.addEventListener('click', () => {
    if (cookieImportFileInput) {
        cookieImportFileInput.value = '';
        cookieImportFileInput.click();
    }
});

cookieImportFileInput?.addEventListener('change', () => {
    void (async () => {
        const file = cookieImportFileInput.files && cookieImportFileInput.files[0] ? cookieImportFileInput.files[0] : null;
        cookieImportFileInput.value = '';
        if (!file) {
            return;
        }

        importCookieButton && (importCookieButton.disabled = true);
        try {
            const text = await file.text();
            await importCookiesFromText(text, file.name || '');
        } catch (error) {
            showActionToast(error && error.message ? error.message : 'Cookie 导入失败', 'error');
            setStatus(error && error.message ? error.message : 'Cookie 导入失败', 'error');
        } finally {
            if (importCookieButton) {
                importCookieButton.disabled = false;
            }
        }
    })();
});

clearCurrentPageCacheButton?.addEventListener('click', () => {
    void clearCurrentPageCache();
});

importCardButton?.addEventListener('click', () => {
    void importAndStartCard();
});

loopCardButton?.addEventListener('click', () => {
    void loopCard();
});

debugControlStepButton?.addEventListener('click', () => {
    void (async () => {
        debugControlStepButton.disabled = true;
        try {
            await sendDebugControlAction('step');
            showActionToast('已切换为逐步运行', 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '切换逐步运行失败', 'error');
        } finally {
            debugControlStepButton.disabled = false;
        }
    })();
});

debugControlLoopButton?.addEventListener('click', () => {
    void (async () => {
        debugControlLoopButton.disabled = true;
        try {
            await sendDebugControlAction('loop');
            showActionToast('已切换为循环运行', 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '切换循环运行失败', 'error');
        } finally {
            debugControlLoopButton.disabled = false;
        }
    })();
});

debugControlPauseButton?.addEventListener('click', () => {
    void (async () => {
        debugControlPauseButton.disabled = true;
        try {
            await sendDebugControlAction('pause');
            showActionToast('已暂停调试运行', 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '暂停调试失败', 'error');
        } finally {
            debugControlPauseButton.disabled = false;
        }
    })();
});

debugControlStopButton?.addEventListener('click', () => {
    void (async () => {
        debugControlStopButton.disabled = true;
        try {
            await sendStopAction();
            showActionToast('已停止调试流程', 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '停止调试失败', 'error');
        } finally {
            debugControlStopButton.disabled = false;
        }
    })();
});

runControlStopButton?.addEventListener('click', () => {
    void (async () => {
        runControlStopButton.disabled = true;
        try {
            await sendStopAction();
            showActionToast('已停止执行流程', 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '停止执行失败', 'error');
        } finally {
            runControlStopButton.disabled = false;
        }
    })();
});

loadCardToEditorButton?.addEventListener('click', () => {
    void (async () => {
        loadCardToEditorButton.disabled = true;
        try {
            const cardData = await loadCardIntoEditor();
            showActionToast(`已载入自动化卡片: ${cardData.name || '未命名'}`, 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '载入自动化卡片失败', 'error');
        } finally {
            loadCardToEditorButton.disabled = false;
        }
    })();
});

openCardSidebarButton?.addEventListener('click', () => {
    void (async () => {
        openCardSidebarButton.disabled = true;
        showActionToast('正在打开右侧编辑栏...', 'info');
        try {
            const result = await openCardEditorSidebar();
            showActionToast(result?.closed ? '已关闭右侧编辑栏' : '已打开右侧编辑栏', 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '打开右侧编辑栏失败', 'error');
        } finally {
            openCardSidebarButton.disabled = false;
        }
    })();
});

saveCardEditorButton?.addEventListener('click', () => {
    void (async () => {
        saveCardEditorButton.disabled = true;
        try {
            const saved = await saveEditorCardToCache();
            showActionToast(`已保存自动化卡片: ${saved.name}`, 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '保存编辑失败', 'error');
        } finally {
            saveCardEditorButton.disabled = false;
        }
    })();
});

exportCardButton?.addEventListener('click', () => {
    void (async () => {
        exportCardButton.disabled = true;
        try {
            const result = await exportCard();
            showActionToast(`已导出自动化卡片: ${result.fileName}`, 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '导出自动化卡片失败', 'error');
        } finally {
            exportCardButton.disabled = false;
        }
    })();
});

appendStepButton?.addEventListener('click', () => {
    void (async () => {
        appendStepButton.disabled = true;
        try {
            const cardData = insertDebugStepIntoEditor();
            showActionToast(`已添加步骤，当前共 ${Array.isArray(cardData.steps) ? cardData.steps.length : 0} 步`, 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '添加步骤失败', 'error');
        } finally {
            appendStepButton.disabled = false;
        }
    })();
});

sidebarLoadCardButton?.addEventListener('click', () => {
    void (async () => {
        sidebarLoadCardButton.disabled = true;
        try {
            const cardData = await loadCardIntoEditor();
            showActionToast(`已载入自动化卡片: ${cardData.name || '未命名'}`, 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '载入自动化卡片失败', 'error');
        } finally {
            sidebarLoadCardButton.disabled = false;
        }
    })();
});

sidebarTutorialButton?.addEventListener('click', () => {
    void (async () => {
        sidebarTutorialButton.disabled = true;
        try {
            await openTutorialPage();
            showActionToast('已打开教程', 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '打开教程失败', 'error');
        } finally {
            sidebarTutorialButton.disabled = false;
        }
    })();
});

heroTutorialButton?.addEventListener('click', () => {
    void (async () => {
        heroTutorialButton.disabled = true;
        try {
            await openTutorialPage();
            showActionToast('已打开教程', 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '打开教程失败', 'error');
        } finally {
            heroTutorialButton.disabled = false;
        }
    })();
});

sidebarSaveCardButton?.addEventListener('click', () => {
    void (async () => {
        sidebarSaveCardButton.disabled = true;
        try {
            const saved = await saveEditorCardToCache();
            showActionToast(`已保存自动化卡片: ${saved.name}`, 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '保存自动化卡片失败', 'error');
        } finally {
            sidebarSaveCardButton.disabled = false;
        }
    })();
});

sidebarExportCardButton?.addEventListener('click', () => {
    void (async () => {
        sidebarExportCardButton.disabled = true;
        try {
            const result = await exportCard();
            showActionToast(`已导出自动化卡片: ${result.fileName}`, 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '导出自动化卡片失败', 'error');
        } finally {
            sidebarExportCardButton.disabled = false;
        }
    })();
});

sidebarLoopButton?.addEventListener('click', () => {
    void loopCard();
});

sidebarCloseButton?.addEventListener('click', () => {
    void openCardEditorSidebar().catch((error) => {
        showActionToast(error && error.message ? error.message : '关闭侧边栏失败', 'error');
    });
});

sidebarAddStepButton?.addEventListener('click', () => {
    void (async () => {
        sidebarAddStepButton.disabled = true;
        try {
            const currentCard = getSidebarCardDataFromEditor();
            const templateType = String(sidebarStepTemplateSelect?.value || 'navigate').trim();
            const nextSteps = Array.isArray(currentCard.steps) ? [...currentCard.steps] : [];
            nextSteps.push(buildSidebarStepTemplate(templateType));
            currentCard.steps = nextSteps;
            renderSidebarCardEditor(currentCard);
            syncSidebarEditorToHiddenJson();
            showActionToast(`已添加步骤，当前共 ${nextSteps.length} 步`, 'success');
        } catch (error) {
            showActionToast(error && error.message ? error.message : '添加步骤失败', 'error');
        } finally {
            sidebarAddStepButton.disabled = false;
        }
    })();
});

sidebarRefreshCardButton?.addEventListener('click', () => {
    void (async () => {
        sidebarRefreshCardButton.disabled = true;
        try {
            renderSidebarEditorFromCurrentState();
            const result = await syncSidebarCardToRunningDebugSession();
            if (result.synced === true) {
                showActionToast(`已同步到正在运行的调试: ${result.stepCount} 步`, 'success');
            } else {
                showActionToast('已刷新编辑内容', 'success');
            }
        } catch (error) {
            showActionToast(error && error.message ? error.message : '刷新失败', 'error');
        } finally {
            sidebarRefreshCardButton.disabled = false;
        }
    })();
});

sidebarCardNameInput?.addEventListener('input', () => syncSidebarEditorToHiddenJson());
sidebarCardWebsiteInput?.addEventListener('input', () => syncSidebarEditorToHiddenJson());
sidebarCardDescriptionInput?.addEventListener('input', () => syncSidebarEditorToHiddenJson());
sidebarCardPasswordInput?.addEventListener('input', () => syncSidebarEditorToHiddenJson());
sidebarCardPointsInput?.addEventListener('input', () => syncSidebarEditorToHiddenJson());
sidebarCardRandomLengthInput?.addEventListener('input', () => syncSidebarEditorToHiddenJson());
sidebarCardRandomTypeInput?.addEventListener('change', () => syncSidebarEditorToHiddenJson());
sidebarCardPopupsInput?.addEventListener('input', () => syncSidebarEditorToHiddenJson());
sidebarCardUploadServerUrlInput?.addEventListener('input', () => syncSidebarEditorToHiddenJson());
sidebarCardUploadCardKeyInput?.addEventListener('input', () => syncSidebarEditorToHiddenJson());
sidebarCardRawJsonInput?.addEventListener('input', () => {
    try {
        const raw = parseEditorCardData(String(sidebarCardRawJsonInput.value || ''), { allowEmptySteps: true });
        renderSidebarCardEditor(raw);
        syncSidebarEditorToHiddenJson();
    } catch (_error) {}
});

sidebarStepListNode?.addEventListener('input', (event) => {
    const target = event.target || null;
    if (target && target.matches && target.matches('[data-sidebar-step-field="selector"]')) {
        const card = target.closest('[data-sidebar-step-card]');
        if (card) {
            normalizeSidebarStepSelectorControl(card, target);
        }
    }
    syncSidebarEditorToHiddenJson();
});

sidebarStepListNode?.addEventListener('change', (event) => {
    const target = event.target || null;
    if (target && target.matches && target.matches('[data-sidebar-step-field="selector"]')) {
        const card = target.closest('[data-sidebar-step-card]');
        if (card) {
            normalizeSidebarStepSelectorControl(card, target);
        }
    }
    syncSidebarEditorToHiddenJson();
});

sidebarStepListNode?.addEventListener('paste', (event) => {
    const target = event.target || null;
    if (!target || !target.matches || !target.matches('[data-sidebar-step-field="selector"]')) {
        return;
    }

    window.setTimeout(() => {
        const card = target.closest('[data-sidebar-step-card]');
        if (!card) {
            return;
        }
        normalizeSidebarStepSelectorControl(card, target);
        syncSidebarEditorToHiddenJson();
    }, 0);
});

sidebarStepListNode?.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[data-sidebar-step-action]') : null;
    if (!button) {
        return;
    }

    const card = button.closest('[data-sidebar-step-card]');
    if (!card) {
        return;
    }

    const currentCard = getSidebarCardDataFromEditor();
    const steps = Array.isArray(currentCard.steps) ? [...currentCard.steps] : [];
    const index = Number(card.dataset.stepIndex || Array.from(card.parentElement?.children || []).indexOf(card));
    const action = String(button.dataset.sidebarStepAction || '').trim();
    if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
        return;
    }

    if (action === 'toggle') {
        const expanded = card.classList.toggle('is-expanded');
        button.textContent = expanded ? '收起详情' : '展开详情';
        button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        return;
    }

    if (action === 'selector') {
        const selectorControl = card.querySelector('[data-sidebar-step-field="selector"]');
        if (!selectorControl) {
            return;
        }
        const currentValue = String(selectorControl.value || '').trim();
        const nextValue = window.prompt('请输入选择器或 HTML 元素片段', currentValue);
        if (nextValue === null) {
            return;
        }
        selectorControl.value = nextValue;
        const normalized = normalizeSidebarStepSelectorControl(card, selectorControl);
        syncSidebarEditorToHiddenJson();
        selectorControl.focus();
        selectorControl.setSelectionRange(selectorControl.value.length, selectorControl.value.length);
        showActionToast(normalized.converted ? '已标准化选择器' : '已更新选择器', 'success');
        return;
    }

    if (action === 'delete') {
        steps.splice(index, 1);
        currentCard.steps = steps;
        renderSidebarCardEditor(currentCard);
        syncSidebarEditorToHiddenJson();
        return;
    }

    if (action === 'up' && index > 0) {
        const [moved] = steps.splice(index, 1);
        steps.splice(index - 1, 0, moved);
        currentCard.steps = steps;
        renderSidebarCardEditor(currentCard);
        syncSidebarEditorToHiddenJson();
        return;
    }

    if (action === 'down' && index < steps.length - 1) {
        const [moved] = steps.splice(index, 1);
        steps.splice(index + 1, 0, moved);
        currentCard.steps = steps;
        renderSidebarCardEditor(currentCard);
        syncSidebarEditorToHiddenJson();
    }
});

chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message !== 'object') {
        return;
    }

    if (message.type === 'card-run-progress') {
        const text = String(message.message || '').trim();
        const progressValue = Number(message.progress);
        const hasProgress = Number.isFinite(progressValue);
        const stepIndex = Number(message.stepIndex || 0) || 0;
        const stepTotal = Number(message.stepTotal || 0) || 0;
        const stepName = String(message.stepName || '').trim();
        const previousStepName = String(message.previousStepName || '').trim();
        const nextStepName = String(message.nextStepName || '').trim();
        const errorReason = String(message.errorReason || '').trim();
        const stepLabel = stepIndex > 0
            ? (stepTotal > 0 ? `第 ${stepIndex}/${stepTotal} 步` : `第 ${stepIndex} 步`)
            : '';
        const stepMetaParts = [
            stepLabel && stepName ? `${stepLabel} · ${stepName}` : (stepName || stepLabel),
            previousStepName ? `上一步：${previousStepName}` : '',
            nextStepName ? `下一步：${nextStepName}` : ''
        ].filter(Boolean);
        const progressState = {
            visible: true,
            message: text || '正在处理调试流程...',
            kind: message.kind || '',
            errorReason,
            mode: String(message.mode || '').trim() || 'debug',
            meta: [
                ...stepMetaParts,
                hasProgress ? `${Math.round(Math.max(0, Math.min(100, progressValue)))}%` : ''
            ].filter(Boolean).join(' · ')
        };
        if (hasProgress) {
            progressState.progress = progressValue;
        }
        setDebugProgress(progressState);
        if (text) {
            setStatus(text, message.kind === 'error' ? 'error' : '');
        }
        setLoopButtonState(message.running === true);
    }

    if (message.type === 'card-run-finished') {
        const success = message.success === true;
        const stopped = message.stopped === true || String(message.message || '').includes('已停止');
        const continuation = message.isLooping === true && message.continuation === true;
        const finishedProgress = Number.isFinite(Number(message.progress))
            ? Number(message.progress)
            : (success ? 100 : 0);
        setDebugProgress({
            visible: true,
            progress: finishedProgress,
            message: String(message.message || (success ? '执行完成' : '执行失败')),
            kind: success || stopped ? '' : 'error',
            errorReason: String(message.errorReason || (!success && !stopped ? message.message || '' : '')).trim(),
            meta: continuation ? '继续循环' : stopped ? '已停止' : success ? '已完成' : '已失败',
            mode: continuation ? 'loop' : ''
        });
        void refreshDebugControlUi();
        if (message.success === true) {
            setStatus(String(message.message || '执行完成'), 'success');
        } else if (stopped) {
            setStatus(String(message.message || '执行已停止'), 'success');
        } else {
            setStatus(String(message.message || '执行失败'), 'error');
        }
        setLoopButtonState(continuation || message.running === true);
        if (stopped || !continuation) {
            scheduleDebugProgressAutoHide(3000);
        }
    }
});

void (async () => {
    resetDebugProgress();
    const lastMainPanel = await loadLastMainPanel().catch(() => 'card');
    activateMainPanel(lastMainPanel || 'card', { persist: false });
    await loadPreset();
    syncCookieCredentialEditUi();
    await refreshCookieCredentialCacheUi().catch(() => {});
    await refreshDebugControlUi();
    await refreshLoopButtonState();
    try {
        const storedProgress = await loadStandaloneProgressState();
        if (storedProgress && storedProgress.visible !== false) {
            setDebugProgress(storedProgress);
            if (String(storedProgress.phase || '').trim() === 'stopped') {
                scheduleDebugProgressAutoHide(3000);
            }
        }
    } catch (_error) {
    }
    try {
        const cacheState = await refreshCardCacheUi();
        const cached = await loadCardCache();
        if (cached?.cardName) {
            if (isSidebarLayout()) {
                renderSidebarCardEditor(cached.cardData);
                syncSidebarEditorToHiddenJson();
            } else if (!String(getCardEditorValue() || '').trim()) {
                setCardEditorValue(cached.cardData);
            }
            setCardFileName(cached.cardName);
        } else if (isSidebarLayout()) {
            renderSidebarCardEditor({ name: '未命名自动化卡片', steps: [] });
            syncSidebarEditorToHiddenJson();
            updateSidebarEditorMeta({ name: '未命名自动化卡片', steps: [] });
        } else if (cacheState.items.length === 0) {
            setCardFileName('未选择卡片');
        }
    } catch (_error) {
        renderCardCacheList({ items: [], selectedId: '' });
        if (isSidebarLayout()) {
            renderSidebarCardEditor({ name: '未命名自动化卡片', steps: [] });
            syncSidebarEditorToHiddenJson();
            updateSidebarEditorMeta({ name: '未命名自动化卡片', steps: [] });
        }
    }
})();
