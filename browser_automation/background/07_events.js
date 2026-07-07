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

        const controlState = await loadStandaloneDebugControlState().catch(() => null);
        if (controlState && Number(controlState.tabId || 0) === Number(tabId)) {
            await clearStandaloneDebugControlState();
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
                const isLooping = payload.isLooping === true;
                let result = null;

                do {
                    result = await runStandaloneCard({
                        ...payload,
                        isLooping
                    });

                    const success = result?.success === true;
                    const currentControlState = await loadStandaloneDebugControlState().catch(() => null);
                    const stopRequested = Boolean(
                        currentControlState
                        && (currentControlState.stopRequested === true || currentControlState.running === false)
                    );
                    const stopped = result?.stopped === true || (isLooping && success && stopRequested);
                    const continuation = isLooping && success && !stopped && !stopRequested;

                    try {
                        const lastState = await loadStandaloneProgressState().catch(() => null);
                        await saveStandaloneProgressState({
                            ...(lastState && typeof lastState === 'object' ? lastState : {}),
                            tabId: lastState?.tabId || null,
                            cardName: String(result?.cardName || lastState?.cardName || payload?.cardData?.name || '').trim(),
                            message: String(continuation
                                ? `本轮执行完成: ${result.cardName || '未命名卡片'}`
                                : success
                                    ? `执行完成: ${result.cardName || '未命名卡片'}`
                                    : stopped
                                        ? `已停止执行: ${result.cardName || '未命名卡片'}`
                                        : result?.error || '执行失败'),
                            phase: continuation ? 'loop_iteration_finished' : success ? 'finished' : stopped ? 'stopped' : 'failed',
                            mode: continuation ? 'loop' : '',
                            isLooping: continuation,
                            kind: continuation || success || stopped ? '' : 'error',
                            errorReason: continuation || success || stopped ? '' : String(result?.error || '').trim(),
                            progress: continuation
                                ? 100
                                : success
                                    ? 100
                                    : stopped
                                        ? Number.isFinite(Number(lastState?.progress))
                                            ? Number(lastState.progress)
                                            : 0
                                        : 0,
                            running: continuation,
                            visible: true
                        });
                        await saveStandaloneDebugControlState({
                            tabId: lastState?.tabId || null,
                            cardName: String(result?.cardName || lastState?.cardName || payload?.cardData?.name || '').trim(),
                            mode: continuation ? 'loop' : 'pause',
                            stepBudget: 0,
                            running: continuation,
                            isLooping: continuation,
                            stopRequested: false
                        });
                    } catch (_error) {
                    }

                    try {
                        await chrome.runtime.sendMessage({
                            type: 'card-run-finished',
                            success,
                            stopped,
                            continuation,
                            isLooping,
                            progress: success || continuation ? 100 : stopped ? Number(result?.progress || 0) : 0,
                            mode: continuation ? 'loop' : message.payload?.debugMode === true ? 'debug' : 'run',
                            errorReason: success || stopped ? '' : String(result?.error || '').trim(),
                            message: continuation
                                ? `本轮执行完成: ${result.cardName || '未命名卡片'}`
                                : success
                                    ? `执行完成: ${result.cardName || '未命名卡片'}`
                                    : stopped
                                        ? `已停止执行: ${result.cardName || '未命名卡片'}`
                                        : result?.error || '执行失败'
                        });
                    } catch (_error) {
                    }

                    if (!continuation) {
                        break;
                    }

                    const controlState = await loadStandaloneDebugControlState().catch(() => null);
                    if (!controlState || controlState.stopRequested === true || controlState.running === false) {
                        break;
                    }

                    await sleep(250);
                } while (true);

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
                        isLooping: false,
                        kind: 'error',
                        errorReason: detailedErr,
                        progress: Number.isFinite(Number(lastState?.progress)) ? Number(lastState.progress) : 0,
                        running: false,
                        visible: true
                    });
                    await saveStandaloneDebugControlState({
                        tabId: lastState?.tabId || null,
                        cardName: String(message.payload?.cardData?.name || lastState?.cardName || '').trim(),
                        mode: 'pause',
                        stepBudget: 0,
                        running: false,
                        isLooping: false
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
                        mode: message.payload?.debugMode === true ? 'debug' : 'run',
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

    if (message.type === 'card-run-control') {
        (async () => {
            try {
                const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
                const requestedMode = String(payload.mode || 'loop').trim().toLowerCase();
                const controlState = await loadStandaloneDebugControlState().catch(() => null);
                const progressState = await loadStandaloneProgressState().catch(() => null);
                const tabId = Number(payload.tabId || controlState?.tabId || progressState?.tabId || 0);
                if (!tabId) {
                    sendResponse({ success: false, error: '当前没有可控制的调试任务' });
                    return;
                }

                const normalizedMode = requestedMode === 'step' || requestedMode === 'pause' ? requestedMode : 'loop';
                const existingBudget = Number(controlState?.stepBudget || 0) || 0;
                const nextStepBudget = normalizedMode === 'step'
                    ? (controlState?.mode === 'step' ? existingBudget + 1 : 1)
                    : 0;

                const saved = await saveStandaloneDebugControlState({
                    tabId,
                    cardName: controlState?.cardName || progressState?.cardName || '',
                    mode: normalizedMode,
                    stepBudget: nextStepBudget,
                    running: controlState?.running !== false && progressState?.running !== false
                });

                sendResponse({
                    success: true,
                    controlMode: saved.mode,
                    stepBudget: saved.stepBudget,
                    running: saved.running
                });
            } catch (error) {
                sendResponse({
                    success: false,
                    error: error && error.message ? error.message : '更新调试控制失败'
                });
            }
        })();
        return true;
    }

    if (message.type === 'card-run-stop') {
        (async () => {
            try {
                const controlState = await loadStandaloneDebugControlState().catch(() => null);
                const progressState = await loadStandaloneProgressState().catch(() => null);
                const tabId = Number(controlState?.tabId || progressState?.tabId || 0);
                if (!tabId) {
                    sendResponse({ success: false, error: '当前没有正在运行的自动化任务' });
                    return;
                }

                const cardName = String(controlState?.cardName || progressState?.cardName || '').trim();
                await saveStandaloneDebugControlState({
                    tabId,
                    cardName,
                    mode: controlState?.mode || 'pause',
                    stepBudget: 0,
                    running: false,
                    isLooping: false,
                    stopRequested: true
                });
                await saveStandaloneProgressState({
                    ...(progressState && typeof progressState === 'object' ? progressState : {}),
                    tabId,
                    cardName,
                    message: '正在停止执行流程...',
                    phase: 'stopping',
                    mode: '',
                    isLooping: false,
                    kind: '',
                    errorReason: '',
                    running: true,
                    visible: true
                });

                sendResponse({
                    success: true,
                    stopped: true
                });
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
                    error: error && error.message ? error.message : '同步调试卡片失败'
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
