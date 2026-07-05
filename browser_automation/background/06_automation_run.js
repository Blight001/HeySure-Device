function isVerificationStepName(value = '') {
    return /验证码|verification|verify|verification code|verification_code|code|otp|校验码|确认码|动态码/i.test(String(value || '').trim());
}

function isEmailStepName(value = '') {
    return /邮箱|email|mail|电子邮箱|邮箱地址|e-mail/i.test(String(value || '').trim());
}

async function runStandaloneCard(payload = {}) {
    const providedCardData = payload.cardData && typeof payload.cardData === 'object'
        ? payload.cardData
        : null;
    const isLooping = payload.isLooping === true;
    const cachedCard = providedCardData ? null : await loadCardCache().catch(() => null);
    const cardData = normalizeStandaloneSteps(providedCardData || cachedCard?.cardData || {});
    const progressMode = payload.debugMode === true ? 'debug' : isLooping ? 'loop' : 'run';
    const totalSteps = Array.isArray(cardData.steps) ? cardData.steps.length : 0;
    const stepProgressStart = 40;
    const stepProgressEnd = payload.debugMode === true ? 96 : 94;
    const stepProgressSpan = totalSteps > 0 ? (stepProgressEnd - stepProgressStart) / totalSteps : 0;
    const retryFailedStepInRunMode = payload.debugMode !== true;
    const stepRetryDelayMs = Math.max(1000, Number(payload.step_retry_delay_ms || payload.stepRetryDelayMs || payload.retryDelayMs || 2000));
    let tabId = 0;
    let currentCardName = '';
    let pendingVerificationCodeInput = false;
    const emitProgress = async (message, kind = '') => {
        try {
            const payloadState = typeof message === 'object' && message !== null ? { ...message } : { message: String(message || '') };
            if (!payloadState.message) {
                payloadState.message = '';
            }
            if (kind && !payloadState.kind) {
                payloadState.kind = kind;
            }
            payloadState.mode = progressMode;
            payloadState.isLooping = isLooping;
            payloadState.tabId = tabId;
            payloadState.cardName = currentCardName;
            payloadState.running = payloadState.running === false ? false : true;
            const controlState = await loadStandaloneDebugControlState().catch(() => null);
            if (controlState && Number(controlState.tabId || 0) === tabId) {
                payloadState.controlMode = controlState.mode || 'loop';
                payloadState.controlStepBudget = controlState.stepBudget || 0;
            }
            await saveStandaloneProgressState(payloadState);
            await chrome.runtime.sendMessage({
                type: 'card-run-progress',
                ...payloadState
            });
        } catch (_error) {
        }
    };

    const context = {
        account: String(payload.account || '').trim(),
        password: generateRandomString(cardData.random?.password?.length || 12, cardData.random?.password?.type || 'mixed'),
        code: '',
        email: String(payload.email || '').trim(),
        tempEmailCardName: '',
        tempEmailProviderName: '',
        tempEmailAddress: ''
    };

    const tab = await getOrFindActiveTab(cardData.website || '');
    if (!tab || !Number.isFinite(Number(tab.id || 0))) {
        throw new Error('未找到可用的当前标签页');
    }

    tabId = Number(tab.id);
    currentCardName = String(cardData.name || '').trim();
    const executionState = {
        tabId,
        cardData,
        progressMode,
        cardName: currentCardName,
        running: true,
        updatedAt: new Date().toISOString()
    };
    standaloneSessions.set(tabId, executionState);
    let tempEmailContext = null;
    try {
        if (payload.debugMode === true) {
            await saveStandaloneDebugControlState({
                tabId,
                cardName: currentCardName,
                mode: 'step',
                stepBudget: 1,
                running: true,
                isLooping: false
            }).catch(() => {});
        } else if (isLooping) {
            const controlState = await loadStandaloneDebugControlState().catch(() => null);
            const stopRequested = controlState && Number(controlState.tabId || 0) === tabId
                ? controlState.stopRequested === true
                : false;
            await saveStandaloneDebugControlState({
                tabId,
                cardName: currentCardName,
                mode: 'loop',
                stepBudget: 0,
                running: stopRequested ? false : true,
                isLooping: true,
                stopRequested
            }).catch(() => {});
            if (stopRequested) {
                throw createStopError();
            }
        } else {
            await clearStandaloneDebugControlState().catch(() => {});
        }
        if (providedCardData && currentCardName) {
            await saveCardCacheState(cardData).catch(() => {});
        }

        await chrome.storage.local.set({
            [STANDALONE_LAST_CARD_KEY]: currentCardName
        }).catch(() => {});

        await emitProgress({
            message: `开始本地执行: ${currentCardName || '未命名卡片'}`,
            progress: 3,
            phase: 'start'
        });

        tempEmailContext = await ensureTempEmailContext({
            openTempEmailTab: payload.openTempEmailTab === true,
            refreshExistingTab: true,
            pageLoadTimeoutMs: Number(payload.tempEmailPageLoadTimeoutMs || payload.pageLoadTimeoutMs || 30000),
            debugMode: payload.debugMode === true,
            tabId,
            runTabId: tabId,
            account: context.account,
            email: context.email
        }, emitProgress, 8);
        await throwIfStopped(tabId);
        await emitProgress({
            message: `已生成随机密码: ${context.password.length} 位`,
            progress: 38,
            phase: 'password_ready'
        });

        let result = {
            success: false,
            cardName: currentCardName,
            account: context.account,
            password: context.password,
            email: context.email,
            tempEmailCardName: context.tempEmailCardName,
            tempEmailProviderName: context.tempEmailProviderName,
            codeTime: '',
            code_time: '',
            points: Number(cardData.points || 0) || 0,
            cookiesSaved: false,
            cookiesSavedByCaptureStep: false
        };

    let index = 0;
    while (index < (Array.isArray(executionState.cardData?.steps) ? executionState.cardData.steps.length : 0)) {
        await throwIfStopped(tabId);
        const activeCardData = executionState.cardData || cardData;
        const steps = Array.isArray(activeCardData.steps) ? activeCardData.steps : [];
        if (index >= steps.length) {
            break;
        }

        const step = steps[index];
        if (!step || typeof step !== 'object') {
            throw new Error(`步骤 ${index + 1} 配置无效`);
        }

        const stepType = String(step.type || '').trim().toLowerCase();
        const stepName = String(step.name || `步骤${index + 1}`).trim() || `步骤${index + 1}`;
        const liveTotalSteps = steps.length;
        const liveStepSpan = liveTotalSteps > 0 ? (stepProgressEnd - stepProgressStart) / liveTotalSteps : 0;
        const stepStartProgress = Math.min(stepProgressEnd, stepProgressStart + (index * liveStepSpan));
        const stepEndProgress = Math.min(stepProgressEnd, stepProgressStart + ((index + 1) * liveStepSpan));
        const stepLabel = formatStepProgressLabel(index + 1, liveTotalSteps, stepName);
        const previousStepName = index > 0 ? String(steps[index - 1]?.name || `步骤${index}`).trim() || `步骤${index}` : '';
        const nextStepName = index + 1 < liveTotalSteps
            ? String(steps[index + 1]?.name || `步骤${index + 2}`).trim() || `步骤${index + 2}`
            : '';
        const handleStepFailure = async ({
            error,
            message = '',
            retryMessage = '',
            errorReason = '',
            phase = 'step_retry'
        } = {}) => {
            const reason = String(errorReason || error?.message || '').trim();
            if (retryFailedStepInRunMode) {
                await emitProgress({
                    message: retryMessage || `${stepLabel} · 执行失败，正在重试`,
                    progress: stepStartProgress,
                    kind: 'error',
                    mode: progressMode,
                    phase,
                    stepIndex: index + 1,
                    stepTotal: liveTotalSteps,
                    stepName,
                    previousStepName,
                    nextStepName,
                    errorReason: reason,
                    running: true,
                    retrying: true
                });
                await sleepWithStandaloneStopCheck(stepRetryDelayMs, tabId);
                return;
            }

            executionState.currentStepIndex = index;
            executionState.currentStepName = stepName;
            executionState.pausedAtFailure = true;
            executionState.updatedAt = new Date().toISOString();
            await pauseAtStep({
                tabId,
                cardName: currentCardName,
                stepName,
                stepIndex: index + 1,
                stepTotal: liveTotalSteps,
                progress: stepStartProgress,
                errorReason: reason || String(message || '').trim(),
                message: message || error?.message || `${stepLabel} · 执行失败，已暂停等待修改`,
                previousStepName,
                nextStepName
            }, emitProgress);
            await waitForStandaloneDebugControl(tabId, emitProgress, {
                mode: progressMode,
                progress: stepStartProgress,
                stepIndex: index + 1,
                stepTotal: liveTotalSteps,
                stepName,
                previousStepName,
                nextStepName
            });
        };
        await emitProgress({
            message: `${stepLabel} · 开始执行`,
            progress: stepStartProgress,
            phase: 'step_start',
            stepIndex: index + 1,
            stepTotal: liveTotalSteps,
            stepName,
            previousStepName,
            nextStepName
        });
        await throwIfStopped(tabId);

        if (payload.debugMode === true || isLooping) {
            await waitForStandaloneDebugControl(tabId, emitProgress, {
                mode: progressMode,
                progress: stepStartProgress,
                stepIndex: index + 1,
                stepTotal: liveTotalSteps,
                stepName,
                previousStepName,
                nextStepName
            });
        }

        if (stepType === 'navigate') {
            try {
                const url = normalizeTargetUrl(resolveTemplate(step.url || '', context) || resolveTemplate(activeCardData.website || '', context));
                if (!url) {
                    await handleStepFailure({
                        error: new Error(`步骤 ${stepName} 缺少有效 URL`),
                        message: `${stepLabel} · 缺少有效 URL`,
                        retryMessage: `${stepLabel} · 缺少有效 URL，正在重试`,
                        errorReason: `步骤 ${stepName} 缺少有效 URL`
                    });
                    continue;
                }

                const currentTab = await chrome.tabs.get(tabId).catch(() => null);
                const currentTabUrl = normalizeTargetUrl(String(currentTab?.url || '').trim());
                if (currentTabUrl === url) {
                    await chrome.tabs.reload(tabId, { bypassCache: true });
                    await sleepWithStandaloneStopCheck(250, tabId);
                    await waitForTabCompleteWithStandaloneStopCheck(tabId, Number(step.timeout || 30000));
                    await emitProgress({
                        message: `${stepLabel} · 已刷新页面`,
                        progress: stepEndProgress,
                        phase: 'step_complete',
                        stepIndex: index + 1,
                        stepTotal: liveTotalSteps,
                        stepName
                    });
                } else {
                    await chrome.tabs.update(tabId, { url });
                    await waitForTabCompleteWithStandaloneStopCheck(tabId, Number(step.timeout || 30000));
                    await emitProgress({
                        message: `${stepLabel} · 已跳转`,
                        progress: stepEndProgress,
                        phase: 'step_complete',
                        stepIndex: index + 1,
                        stepTotal: liveTotalSteps,
                        stepName
                    });
                }
                index += 1;
                continue;
            } catch (error) {
                await handleStepFailure({
                    error,
                    message: error && error.message ? error.message : `${stepLabel} · 导航失败，已暂停等待修改`,
                    retryMessage: error && error.message ? `${stepLabel} · ${error.message}，正在重试` : `${stepLabel} · 导航失败，正在重试`,
                    errorReason: error && error.message ? error.message : `步骤 ${stepName} 导航失败`
                });
                continue;
            }
        }

        if (stepType === 'wait_verification_code') {
            try {
                const codeResult = normalizeVerificationCodeResult(await waitForVerificationCode({
                    timeoutMs: Number(step.timeout || 300000),
                    intervalMs: Number(step.poll_interval_ms || 1500),
                    progressBase: stepStartProgress,
                    progressSpan: Math.max(1, stepEndProgress - stepStartProgress),
                    mode: progressMode,
                    tabId,
                    stepIndex: index + 1,
                    stepTotal: liveTotalSteps,
                    stepName,
                    tabId,
                    runTabId: tabId,
                    retryForever: payload.debugMode !== true || step.retry_forever === true
                }, tempEmailContext, emitProgress));
                const code = String(codeResult.code || '').trim();
                if (!code) {
                    await handleStepFailure({
                        error: new Error('等待验证码超时'),
                        message: `${stepLabel} · 等待验证码超时，已暂停`,
                        retryMessage: `${stepLabel} · 等待验证码超时，正在重试`,
                        errorReason: '等待验证码超时'
                    });
                    continue;
                }

                context.code = code;
                if (codeResult.verificationTime) {
                    context.codeTime = codeResult.verificationTime;
                    context.code_time = codeResult.verificationTime;
                    result.codeTime = codeResult.verificationTime;
                    result.code_time = codeResult.verificationTime;
                }
                pendingVerificationCodeInput = true;
                await emitProgress({
                    message: `${stepLabel} · 已获取验证码${codeResult.verificationTime ? `（时间: ${codeResult.verificationTime}）` : ''}`,
                    progress: stepEndProgress,
                    phase: 'step_complete',
                    stepIndex: index + 1,
                    stepTotal: liveTotalSteps,
                    stepName
                });
                index += 1;
                continue;
            } catch (error) {
                await handleStepFailure({
                    error,
                    message: error && error.message ? error.message : `${stepLabel} · 等待验证码失败，已暂停等待修改`,
                    retryMessage: error && error.message ? `${stepLabel} · ${error.message}，正在重试` : `${stepLabel} · 等待验证码失败，正在重试`,
                    errorReason: error && error.message ? error.message : '等待验证码失败'
                });
                continue;
            }
        }

        if (stepType === 'save_cookies') {
            const captureAccount = String(context.email || context.account || result.account || payload.account || '').trim();
            const capturePassword = String(context.code || result.password || payload.password || '').trim();
            result.cookiesSavedByCaptureStep = true;
            if (!captureAccount || !capturePassword) {
                result.cookieSaveError = '获取Cookie 步骤缺少账号或验证码，已跳过保存';
                await emitProgress({
                    message: `${stepLabel} · ${result.cookieSaveError}`,
                    progress: stepEndProgress,
                    kind: 'error',
                    phase: 'step_skip',
                    stepIndex: index + 1,
                    stepTotal: liveTotalSteps,
                    stepName
                });
                index += 1;
                continue;
            }

            try {
                const saveResult = await saveCookieStepResult(tabId, captureAccount, capturePassword);
                result.cookiesSaved = true;
                result.savedFileName = saveResult.fileName;
                result.cookieCount = saveResult.cookieCount;
                result.browserStorageCount = saveResult.browserStorageCount;
                result.pageUrl = saveResult.pageUrl;
                result.pageTitle = saveResult.pageTitle;
            } catch (error) {
                result.cookieSaveError = error && error.message ? error.message : 'Cookie 保存失败';
            }
            await emitProgress({
                message: result.cookiesSaved === true
                    ? `${stepLabel} · Cookie 已保存`
                    : `${stepLabel} · Cookie 保存失败，继续执行`,
                progress: stepEndProgress,
                kind: result.cookiesSaved === true ? '' : 'error',
                phase: 'step_complete',
                stepIndex: index + 1,
                stepTotal: liveTotalSteps,
                stepName
            });
            index += 1;
            continue;
        }

        if (stepType === 'clear_current_page_cache') {
            try {
                const clearResult = await clearCurrentPageCache(tabId);
                const summaryParts = [];
                if (Number(clearResult.removedCookieCount || 0) > 0) {
                    summaryParts.push(`Cookie ${clearResult.removedCookieCount} 个`);
                }
                if (Number(clearResult.clearedLocalStorageCount || 0) > 0) {
                    summaryParts.push(`localStorage ${clearResult.clearedLocalStorageCount} 项`);
                }
                if (Number(clearResult.clearedSessionStorageCount || 0) > 0) {
                    summaryParts.push(`sessionStorage ${clearResult.clearedSessionStorageCount} 项`);
                }
                if (Number(clearResult.clearedCacheStorageCount || 0) > 0) {
                    summaryParts.push(`CacheStorage ${clearResult.clearedCacheStorageCount} 项`);
                }
                if (Number(clearResult.clearedIndexedDbCount || 0) > 0) {
                    summaryParts.push(`IndexedDB ${clearResult.clearedIndexedDbCount} 项`);
                }

                await emitProgress({
                    message: summaryParts.length > 0
                        ? `${stepLabel} · 已清理当前页缓存（${summaryParts.join('，')}）`
                        : `${stepLabel} · 已清理当前页缓存`,
                    progress: stepEndProgress,
                    phase: 'step_complete',
                    stepIndex: index + 1,
                    stepTotal: liveTotalSteps,
                    stepName
                });
                index += 1;
                continue;
            } catch (error) {
                await handleStepFailure({
                    error,
                    message: error && error.message ? error.message : `${stepLabel} · 清理当前页缓存失败，已暂停等待修改`,
                    retryMessage: error && error.message ? `${stepLabel} · ${error.message}，正在重试` : `${stepLabel} · 清理当前页缓存失败，正在重试`,
                    errorReason: error && error.message ? error.message : '清理当前页缓存失败'
                });
                continue;
            }
        }

        const resolvedSelector = resolveTemplate(step.selector || '', context);
        let rawText = resolveTemplate(step.text || '', context);
        const clearPendingVerificationCodeInput = stepType === 'type' && pendingVerificationCodeInput === true;
        if (stepType === 'type') {
            const verificationStep = pendingVerificationCodeInput === true
                || isVerificationStepName(stepName)
                || isVerificationStepName(step.selector)
                || isVerificationStepName(step.text);
            const emailStep = isEmailStepName(stepName)
                || isEmailStepName(step.selector)
                || isEmailStepName(step.text);

            if (verificationStep) {
                rawText = String(context.code || result.code || payload.code || '').trim() || rawText;
            } else if (emailStep) {
                let emailValue = String(context.email || tempEmailContext?.email || payload.email || result.email || '').trim();
                if (!emailValue) {
                    const emailResult = await getTempEmailDesktopEmail({
                        ...payload,
                        forceRefresh: false
                    }, tempEmailContext || context);
                    emailValue = String(emailResult?.email || '').trim();
                    if (emailValue) {
                        context.email = emailValue;
                        if (tempEmailContext) {
                            tempEmailContext.email = emailValue;
                        }
                    }
                }
                rawText = emailValue || rawText;
            }
        }
        const actionPayload = {
            type: stepType,
            selector: resolvedSelector,
            text: rawText,
            nth: step.nth,
            clearFirst: step.clear_first === true || step.clearFirst === true,
            clickBeforeType: step.click_before_type === true || step.clickBeforeType === true,
            timeoutMs: Number(step.timeout || 15000),
            intervalMs: Number(step.poll_interval_ms || step.click_poll_interval_ms || 200),
            defaultValue: step.default,
            default: step.default,
            script: resolveTemplate(step.script || '', context),
            waitForText: resolveTemplate(step.wait_for_text || '', context),
            waitForElementHidden: resolveTemplate(step.wait_for_element_hidden || '', context),
            waitForTextHidden: resolveTemplate(step.wait_for_text_hidden || '', context)
        };

        if (stepType === 'wait') {
            try {
                const waitResult = await executePageActionWithStandaloneStopCheck(tabId, {
                    ...actionPayload,
                    type: 'wait',
                    hidden: step.wait_for_element_hidden ? true : false,
                    selector: resolvedSelector,
                    timeoutMs: Number(step.timeout || step.wait_ms || step.waitMs || 3000),
                    intervalMs: Number(step.wait_for_element_interval_ms || 200)
                });
                if (!waitResult || waitResult.success !== true) {
                    throw new Error(waitResult?.error || `等待步骤失败: ${stepName}`);
                }
                await emitProgress({
                    message: `${stepLabel} · 等待完成`,
                    progress: stepEndProgress,
                    phase: 'step_complete',
                    stepIndex: index + 1,
                    stepTotal: liveTotalSteps,
                    stepName
                });
                index += 1;
                continue;
            } catch (error) {
                await handleStepFailure({
                    error,
                    message: error && error.message ? error.message : `${stepLabel} · 等待步骤失败，已暂停等待修改`,
                    retryMessage: error && error.message ? `${stepLabel} · ${error.message}，正在重试` : `${stepLabel} · 等待步骤失败，正在重试`,
                    errorReason: error && error.message ? error.message : `等待步骤失败: ${stepName}`
                });
                continue;
            }
        }

        if (stepType === 'get_credits') {
            try {
                const creditResult = await executePageActionWithStandaloneStopCheck(tabId, actionPayload);
                if (!creditResult || creditResult.success !== true) {
                    throw new Error(creditResult?.error || `获取积分失败: ${stepName}`);
                }

                const pointsValue = String(creditResult.value || '').trim();
                result.points = pointsValue || result.points;
                await emitProgress({
                    message: `${stepLabel} · 已读取`,
                    progress: stepEndProgress,
                    phase: 'step_complete',
                    stepIndex: index + 1,
                    stepTotal: liveTotalSteps,
                    stepName
                });
                index += 1;
                continue;
            } catch (error) {
                await handleStepFailure({
                    error,
                    message: error && error.message ? error.message : `${stepLabel} · 获取积分失败，已暂停等待修改`,
                    retryMessage: error && error.message ? `${stepLabel} · ${error.message}，正在重试` : `${stepLabel} · 获取积分失败，正在重试`,
                    errorReason: error && error.message ? error.message : `获取积分失败: ${stepName}`
                });
                continue;
            }
        }

        if (stepType === 'external_script') {
            try {
                const scriptResult = await executePageActionWithStandaloneStopCheck(tabId, actionPayload);
                if (!scriptResult || scriptResult.success !== true) {
                    throw new Error(scriptResult?.error || `脚本步骤失败: ${stepName}`);
                }
                await emitProgress({
                    message: `${stepLabel} · 脚本完成`,
                    progress: stepEndProgress,
                    phase: 'step_complete',
                    stepIndex: index + 1,
                    stepTotal: liveTotalSteps,
                    stepName
                });
                index += 1;
                continue;
            } catch (error) {
                await handleStepFailure({
                    error,
                    message: error && error.message ? error.message : `${stepLabel} · 脚本步骤失败，已暂停等待修改`,
                    retryMessage: error && error.message ? `${stepLabel} · ${error.message}，正在重试` : `${stepLabel} · 脚本步骤失败，正在重试`,
                    errorReason: error && error.message ? error.message : `脚本步骤失败: ${stepName}`
                });
                continue;
            }
        }

        if (stepType === 'screenshot') {
            await emitProgress({
                message: `${stepLabel} · 已处理`,
                progress: stepEndProgress,
                phase: 'step_complete',
                stepIndex: index + 1,
                stepTotal: liveTotalSteps,
                stepName
            });
            index += 1;
            continue;
        }

        const selectors = normalizeSelectorCandidates(step.by || 'css_selector', resolvedSelector);
        let stepExecuted = false;
        let lastError = '';

        for (const selector of selectors) {
            await throwIfStopped(tabId);
            try {
                const actionResult = await executePageActionWithStandaloneStopCheck(tabId, {
                    ...actionPayload,
                    selector,
                    type: stepType === 'click' ? 'click' : stepType === 'type' ? 'type' : stepType
                });

                if (actionResult && actionResult.success === true) {
                    stepExecuted = true;
                    break;
                }

                lastError = actionResult?.error || lastError;
            } catch (error) {
                lastError = error && error.message ? error.message : lastError;
            }
        }

        if (!stepExecuted) {
            if (step.optional === true || step.optional === 'true') {
                await emitProgress({
                    message: `${stepLabel} · 可选步骤已跳过`,
                    progress: stepEndProgress,
                    phase: 'step_skip',
                    stepIndex: index + 1,
                    stepTotal: liveTotalSteps,
                    stepName
                });
                index += 1;
                continue;
            }

            await handleStepFailure({
                error: new Error(lastError || '步骤执行失败'),
                message: lastError || `${stepLabel} · 执行失败，已暂停等待修改`,
                retryMessage: lastError ? `${stepLabel} · ${lastError}，正在重试` : `${stepLabel} · 执行失败，正在重试`,
                errorReason: lastError || '步骤执行失败'
            });
            continue;
        }

        if (clearPendingVerificationCodeInput) {
            pendingVerificationCodeInput = false;
        }

        await emitProgress({
            message: `${stepLabel} · 已完成`,
            progress: stepEndProgress,
            phase: 'step_complete',
            stepIndex: index + 1,
            stepTotal: liveTotalSteps,
            stepName
        });
        index += 1;
    }

    result.success = true;
    if (payload.debugMode === true) {
        await saveStandaloneDebugControlState({
            tabId,
            cardName: currentCardName,
            mode: 'pause',
            stepBudget: 0,
            running: false,
            isLooping: false
        }).catch(() => {});
        await emitProgress({
            message: '调试模式下已完成自动化步骤，跳过 Cookie 保存',
            progress: 98,
            phase: 'debug_complete'
        });
        return result;
    }

    if (isLooping) {
        await emitProgress({
            message: `本轮执行完成: ${currentCardName || '未命名卡片'}`,
            progress: 100,
            phase: 'loop_iteration_finished'
        });
        return result;
    }

    if (result.cookiesSavedByCaptureStep === true) {
        await emitProgress({
            message: 'Cookie 已在步骤中保存，跳过最终自动保存',
            progress: 97,
            phase: 'save_cookies'
        });
        await saveStandaloneDebugControlState({
            tabId,
            cardName: currentCardName,
            mode: 'pause',
            stepBudget: 0,
            running: false,
            isLooping: false
        }).catch(() => {});
        await emitProgress({
            message: `本地执行完成: ${currentCardName || '未命名卡片'}`,
            progress: 100,
            phase: 'finished'
        });
        return result;
    }

    await emitProgress({
        message: '自动化步骤执行完成，正在保存 Cookie',
        progress: 97,
        phase: 'save_cookies'
    });

    try {
        const saveResult = await saveCardResult(cardData, result, tabId);
        result.cookiesSaved = true;
        result.savedFileName = saveResult.fileName;
        result.cookieCount = saveResult.cookieCount;
        result.browserStorageCount = saveResult.browserStorageCount;
        result.pageUrl = saveResult.pageUrl;
        result.pageTitle = saveResult.pageTitle;
    } catch (error) {
        result.cookiesSaved = false;
        result.cookieSaveError = error.message;
    }

    await saveStandaloneDebugControlState({
        tabId,
        cardName: currentCardName,
        mode: 'pause',
        stepBudget: 0,
        running: false,
        isLooping: false
    }).catch(() => {});
    await emitProgress({
        message: `本地执行完成: ${currentCardName || '未命名卡片'}`,
        progress: 100,
        phase: 'finished'
    });
    return result;
    } catch (error) {
        if (isStopError(error)) {
            const lastState = await loadStandaloneProgressState().catch(() => null);
            const stoppedProgress = Number.isFinite(Number(lastState?.progress))
                ? Number(lastState.progress)
                : 0;
            const stoppedMessage = `已停止执行: ${currentCardName || '未命名卡片'}`;
            await saveStandaloneProgressState({
                ...(lastState && typeof lastState === 'object' ? lastState : {}),
                tabId,
                cardName: currentCardName,
                message: stoppedMessage,
                phase: 'stopped',
                mode: '',
                isLooping: false,
                kind: '',
                errorReason: '',
                progress: stoppedProgress,
                running: false,
                visible: true
            }).catch(() => {});
            await saveStandaloneDebugControlState({
                tabId,
                cardName: currentCardName,
                mode: 'pause',
                stepBudget: 0,
                running: false,
                isLooping: false,
                stopRequested: false
            }).catch(() => {});
            await emitProgress({
                message: stoppedMessage,
                progress: stoppedProgress,
                phase: 'stopped',
                mode: progressMode,
                kind: '',
                errorReason: '',
                running: false
            }).catch(() => {});
            return {
                success: false,
                stopped: true,
                cardName: currentCardName,
                account: String(context.account || '').trim(),
                password: String(context.password || '').trim(),
                email: String(context.email || '').trim(),
                tempEmailCardName: String(context.tempEmailCardName || '').trim(),
                tempEmailProviderName: String(context.tempEmailProviderName || '').trim(),
                codeTime: String(context.codeTime || context.code_time || '').trim(),
                code_time: String(context.codeTime || context.code_time || '').trim(),
                points: Number(cardData.points || 0) || 0,
                cookiesSaved: false,
                progress: stoppedProgress,
            error: '执行已停止'
            };
        }
        throw error;
    } finally {
        if (tempEmailContext) {
            await closeTempEmailDesktopWindow({
                sessionId: tempEmailContext.sessionId || payload.sessionId || payload.taskId || payload.browserSessionId || 'default',
                tabId,
                email: tempEmailContext.email || context.email || ''
            }, tempEmailContext).catch(() => {});
        }
        standaloneSessions.delete(tabId);
    }
}

async function saveCookieStepResult(tabId, account, password) {
    const snapshot = await collectTabCookieSnapshot(tabId);
    const fileName = buildCaptureFileName(account, password);
    const savePayload = {
        account: String(account || '').trim(),
        password: String(password || '').trim(),
        pageUrl: snapshot.pageUrl,
        pageTitle: snapshot.pageTitle,
        cookies: snapshot.cookies,
        browserStorage: snapshot.browserStorage,
        capturedAt: new Date().toISOString(),
        source: 'card-run-save-cookies-step'
    };

    const jsonText = JSON.stringify(savePayload, null, 2);
    const downloadUrl = `data:application/json;charset=utf-8,${encodeURIComponent(jsonText)}`;
    await chrome.downloads.download({
        url: downloadUrl,
        filename: `automation_capture/${fileName}`,
        saveAs: false,
        conflictAction: 'overwrite'
    });

    return {
        fileName,
        cookieCount: snapshot.cookies.length,
        browserStorageCount: snapshot.browserStorage.length,
        pageUrl: savePayload.pageUrl,
        pageTitle: savePayload.pageTitle
    };
}

async function captureCurrentTab(payload = {}) {
    const tab = await getActiveTab();
    if (!tab || !Number.isFinite(Number(tab.id || 0))) {
        throw new Error('未找到可抓取的当前标签页');
    }

    const pageSnapshot = await readPageSnapshot(Number(tab.id));
    if (!pageSnapshot) {
        throw new Error('当前页面无法读取存储信息');
    }

    const cookies = await readCookies(tab.url || pageSnapshot.url || '');
    const localStorageData = pageSnapshot.localStorage && typeof pageSnapshot.localStorage === 'object'
        ? pageSnapshot.localStorage
        : {};
    const sessionStorageData = pageSnapshot.sessionStorage && typeof pageSnapshot.sessionStorage === 'object'
        ? pageSnapshot.sessionStorage
        : {};
    const browserStorage = [];

    if (Object.keys(localStorageData).length > 0 || Object.keys(sessionStorageData).length > 0) {
        browserStorage.push({
            url: pageSnapshot.url || tab.url || '',
            origin: pageSnapshot.origin || '',
            localStorage: localStorageData,
            sessionStorage: sessionStorageData
        });
    }

    if ((!Array.isArray(cookies) || cookies.length === 0) && browserStorage.length === 0) {
        throw new Error('当前页面没有可保存的 Cookie 或浏览器存储');
    }

    const account = String(payload.account || '').trim();
    const password = String(payload.password || '').trim();
    const fileName = buildFileName(account, password);
    const savePayload = {
        account,
        password,
        pageUrl: tab.url || pageSnapshot.url || '',
        pageTitle: tab.title || pageSnapshot.title || '',
        cookies,
        browserStorage,
        capturedAt: new Date().toISOString()
    };

    const jsonText = JSON.stringify(savePayload, null, 2);
    const downloadUrl = `data:application/json;charset=utf-8,${encodeURIComponent(jsonText)}`;
    await chrome.downloads.download({
        url: downloadUrl,
        filename: `cookie_capture/${fileName}`,
        saveAs: false,
        conflictAction: 'overwrite'
    });

    const serverUrl = String(payload.serverUrl || payload.server_url || '').trim();
    const upload = { attempted: false, success: false, status: 0, error: '' };
    if (serverUrl) {
        upload.attempted = true;
        const cardKey = String(payload.cardKey || payload.card_key || '').trim();
        const uploadController = new AbortController();
        const uploadTimeout = setTimeout(() => uploadController.abort(), 8000);
        try {
            const uploadPayload = cardKey ? { ...savePayload, cardKey } : savePayload;
            const response = await fetch(serverUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(uploadPayload),
                signal: uploadController.signal
            });
            upload.status = response.status;
            upload.success = response.ok;
            if (!response.ok) {
                upload.error = `HTTP ${response.status}`;
            }
        } catch (error) {
            upload.error = error && error.message ? error.message : '上传失败';
        } finally {
            clearTimeout(uploadTimeout);
        }
    }

    return {
        success: true,
        fileName,
        cookieCount: cookies.length,
        browserStorageCount: browserStorage.length,
        pageUrl: savePayload.pageUrl,
        upload
    };
}

