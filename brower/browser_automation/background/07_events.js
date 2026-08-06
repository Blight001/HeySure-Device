chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete') {
        return;
    }

    if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
        return;
    }

    void (async () => {
        const sidebarState = await loadCardSidebarState().catch(() => null);
        if (!sidebarState || sidebarState.open !== true || Number(sidebarState.tabId || 0) !== Number(tabId)) {
            return;
        }

        await injectCardEditorSidebar(Number(tabId), sidebarState.width || 820).catch(() => {});
    })();
});

chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
        const sidebarState = await loadCardSidebarState().catch(() => null);
        if (sidebarState && Number(sidebarState.tabId || 0) === Number(tabId)) {
            await clearCardSidebarState();
        }
    })();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') {
        return false;
    }

    if (message.type === 'cookie-capture-start') {
        (async () => {
            try {
                const result = await captureCurrentTab(message.payload || {});
                sendResponse(result);
            } catch (error) {
                sendResponse({
                    success: false,
                    error: error && error.message ? error.message : '抓取失败'
                });
            }
        })();
        return true;
    }

    if (message.type === 'cookie-capture-clear-current-page-cache') {
        (async () => {
            try {
                const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
                const result = await clearCurrentPageCache(payload.tabId || 0);
                sendResponse(result);
            } catch (error) {
                sendResponse({
                    success: false,
                    error: error && error.message ? error.message : '清理当前页面缓存失败'
                });
            }
        })();
        return true;
    }

    if (message.type === 'cookie-capture-list-cookies') {
        (async () => {
            try {
                const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
                const result = await listCurrentTabCookies(payload.tabId || 0);
                sendResponse(result);
            } catch (error) {
                sendResponse({
                    success: false,
                    error: error && error.message ? error.message : '获取 Cookie 列表失败'
                });
            }
        })();
        return true;
    }

    if (message.type === 'cookie-capture-remove-cookie') {
        (async () => {
            try {
                const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
                const result = await removeCurrentTabCookie(payload.tabId || 0, payload.cookie || {});
                sendResponse(result);
            } catch (error) {
                sendResponse({
                    success: false,
                    error: error && error.message ? error.message : '删除 Cookie 失败'
                });
            }
        })();
        return true;
    }

    if (message.type === 'cookie-capture-import-cookies') {
        (async () => {
            try {
                const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
                const result = await importSnapshotToCurrentPage(
                    payload.tabId || 0,
                    payload.pageUrl || payload.tabUrl || '',
                    payload.cookies || [],
                    payload.browserStorage || []
                );
                const importedCount = Number(result.importedCount || 0) || 0;
                const failedCount = Number(result.failedCount || 0) || 0;
                const storageCount = Number(result.browserStorageCount || 0) || 0;
                const restoredLocalStorageCount = Number(result.restoredLocalStorageCount || 0) || 0;
                const restoredSessionStorageCount = Number(result.restoredSessionStorageCount || 0) || 0;
                const responseParts = [];
                if (storageCount > 0) {
                    responseParts.push(`浏览器存储 ${storageCount} 组`);
                }
                if (restoredLocalStorageCount > 0) {
                    responseParts.push(`localStorage ${restoredLocalStorageCount} 项`);
                }
                if (restoredSessionStorageCount > 0) {
                    responseParts.push(`sessionStorage ${restoredSessionStorageCount} 项`);
                }
                if (importedCount > 0) {
                    responseParts.push(`Cookie ${importedCount} 条`);
                }
                if (failedCount > 0) {
                    responseParts.push(`失败 ${failedCount} 条${result.firstError ? `，首个错误：${result.firstError}` : ''}`);
                }
                const responseMessage = responseParts.length > 0
                    ? `已导入 ${responseParts.join('，')}，请刷新页面生效`
                    : result.message || '未导入任何内容';
                sendResponse({
                    ...result,
                    success: result.success === true,
                    message: responseMessage,
                    error: result.success === true ? '' : responseMessage
                });
            } catch (error) {
                sendResponse({
                    success: false,
                    message: error && error.message ? error.message : 'Cookie 注入失败',
                    error: error && error.message ? error.message : 'Cookie 注入失败'
                });
            }
        })();
        return true;
    }

    if (message.type === 'card-run-start') {
        (async () => {
            try {
                const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
                const result = await runStandaloneCard(payload);

                if (result && result.stopped) {
                    sendResponse({ success: false, stopped: true });
                    return;
                }

                const success = result?.success === true;

                    try {
                        const lastState = await loadStandaloneProgressState().catch(() => null);
                        await saveStandaloneProgressState({
                            ...(lastState && typeof lastState === 'object' ? lastState : {}),
                            tabId: lastState?.tabId || null,
                            cardName: String(result?.cardName || lastState?.cardName || payload?.cardData?.name || '').trim(),
                            message: String(success
                                ? `执行完成: ${result.cardName || '未命名卡片'}`
                                : result?.error || '执行失败'),
                            phase: success ? 'finished' : 'failed',
                            mode: '',
                            kind: success ? '' : 'error',
                            errorReason: success ? '' : String(result?.error || '').trim(),
                            progress: success ? 100 : Number.isFinite(Number(lastState?.progress)) ? Number(lastState.progress) : 0,
                            running: false,
                            visible: true
                        });
                    } catch (_error) {
                    }

                    try {
                        await chrome.runtime.sendMessage({
                            type: 'card-run-finished',
                            success,
                            stopped: false,
                            continuation: false,
                            progress: success ? 100 : 0,
                            mode: 'run',
                            errorReason: success ? '' : String(result?.error || '').trim(),
                            message: success
                                ? `执行完成: ${result.cardName || '未命名卡片'}`
                                : result?.error || '执行失败'
                        });
                    } catch (_error) {
                    }

                sendResponse(result);
            } catch (error) {
                try {
                    const lastState = await loadStandaloneProgressState().catch(() => null);
                    const baseErr = error && error.message ? error.message : '执行失败';
                    // 优先使用进度中保存的详细错误原因（步骤+selector+尝试次数等）
                    const detailedErr = (lastState && (lastState.errorReason || lastState.message)) || baseErr;
                    await saveStandaloneProgressState({
                        ...(lastState && typeof lastState === 'object' ? lastState : {}),
                        tabId: lastState?.tabId || null,
                        cardName: String(message.payload?.cardData?.name || lastState?.cardName || '').trim(),
                        message: detailedErr,
                        phase: 'failed',
                        mode: '',
                        kind: 'error',
                        errorReason: detailedErr,
                        progress: Number.isFinite(Number(lastState?.progress)) ? Number(lastState.progress) : 0,
                        running: false,
                        visible: true
                    });
                } catch (_error) {
                }
                let detailedForFinished = error && error.message ? error.message : '执行失败';
                try {
                    const pstate = await loadStandaloneProgressState().catch(() => null);
                    if (pstate && (pstate.errorReason || pstate.message)) {
                        detailedForFinished = pstate.errorReason || pstate.message;
                    }
                    await chrome.runtime.sendMessage({
                        type: 'card-run-finished',
                        success: false,
                        progress: 0,
                        mode: 'run',
                        errorReason: detailedForFinished,
                        message: detailedForFinished
                    });
                } catch (_error) {
                }
                sendResponse({
                    success: false,
                    error: detailedForFinished
                });
            }
        })();
        return true;
    }

    if (message.type === 'card-run-stop') {
        (async () => {
            try {
                const lastState = await loadStandaloneProgressState().catch(() => null);
                const tabId = Number(lastState?.tabId || 0) || 0;

                if (tabId) {
                    markTabStopped(tabId);
                }

                const stoppedProgress = Number.isFinite(Number(lastState?.progress))
                    ? Number(lastState.progress)
                    : 0;

                await saveStandaloneProgressState({
                    ...(lastState && typeof lastState === 'object' ? lastState : {}),
                    tabId: tabId || (lastState?.tabId || null),
                    cardName: String(lastState?.cardName || '').trim(),
                    message: '已停止执行',
                    phase: 'stopped',
                    mode: String(lastState?.mode || '').trim(),
                    kind: '',
                    errorReason: '',
                    progress: stoppedProgress,
                    running: false,
                    stopped: true,
                    visible: true
                }).catch(() => {});

                await chrome.runtime.sendMessage({
                    type: 'card-run-finished',
                    success: false,
                    stopped: true,
                    continuation: false,
                    progress: stoppedProgress,
                    mode: String(lastState?.mode || '').trim(),
                    message: '已停止执行'
                }).catch(() => {});

                sendResponse({ success: true });
            } catch (error) {
                sendResponse({
                    success: false,
                    error: error && error.message ? error.message : '停止执行失败'
                });
            }
        })();
        return true;
    }

    if (message.type === 'card-sync') {
        (async () => {
            try {
                const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
                const senderTabId = Number(_sender?.tab?.id || 0);
                const result = await syncStandaloneSession(payload, senderTabId);
                sendResponse(result);
            } catch (error) {
                sendResponse({
                    success: false,
                    error: error && error.message ? error.message : '同步自动化卡片失败'
                });
            }
        })();
        return true;
    }

    if (message.type === 'open-card-editor-sidebar') {
        (async () => {
            try {
                const result = await openCardEditorSidebar(message.payload || {});
                sendResponse(result);
            } catch (error) {
                sendResponse({
                    success: false,
                    error: error && error.message ? error.message : '打开侧边栏失败'
                });
            }
        })();
        return true;
    }

    if (message.type === 'close-card-sidebar') {
        (async () => {
            try {
                // Force close by calling the injector (it removes if exists)
                const result = await openCardEditorSidebar({ forceClose: true });
                sendResponse(result);
            } catch (error) {
                // Try direct removal via executeScript as fallback
                try {
                    const tabId = _sender?.tab?.id;
                    if (tabId) {
                        await chrome.scripting.executeScript({
                            target: { tabId },
                            func: () => {
                                const host = document.getElementById('__automation_card_sidebar_root__');
                                if (host) host.remove();
                            }
                        });
                    }
                } catch (_) {}
                sendResponse({ success: true, closed: true });
            }
        })();
        return true;
    }

    if (message.type === 'card-sidebar-state-update') {
        (async () => {
            try {
                const senderTabId = Number(_sender?.tab?.id || 0);
                if (!senderTabId) {
                    sendResponse({ success: false, error: '未找到侧边栏标签页' });
                    return;
                }

                const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
                await saveCardSidebarState({
                    tabId: senderTabId,
                    width: payload.width || 820,
                    open: payload.open === true
                });
                sendResponse({ success: true });
            } catch (error) {
                sendResponse({
                    success: false,
                    error: error && error.message ? error.message : '更新侧边栏状态失败'
                });
            }
        })();
        return true;
    }

    return false;
});
