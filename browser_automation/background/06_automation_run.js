function isVerificationStepName(value = '') {
    return /验证码|verification|verify|verification code|verification_code|code|otp|校验码|确认码|动态码/i.test(String(value || '').trim());
}

function isEmailStepName(value = '') {
    return /邮箱|email|mail|电子邮箱|邮箱地址|e-mail/i.test(String(value || '').trim());
}

// 构建详细的失败原因（用于进度、最终错误、MCP 返回）
function buildDetailedFailureReason({
    stepIndex = 0,
    stepName = '',
    stepType = '',
    reason = '',
    attempt = 1,
    maxAttempts = 3,
    selector = '',
    extra = ''
} = {}) {
    const parts = [];
    const idx = Number(stepIndex) || 0;
    if (idx > 0) parts.push(`步骤 ${idx}`);
    if (stepName) parts.push(`「${String(stepName).trim()}」`);
    if (stepType) parts.push(`(${stepType})`);
    let head = parts.join(' ');
    if (selector) {
        const shortSel = String(selector).trim().slice(0, 100);
        head += ` selector=${shortSel}${String(selector).length > 100 ? '...' : ''}`;
    }
    if (attempt > 1) {
        head += ` [尝试 ${attempt}/${maxAttempts}]`;
    }
    let msg = reason ? String(reason).trim() : '执行失败';
    if (extra) msg += ` ${String(extra).trim()}`;
    return head ? `${head} 失败: ${msg}` : msg;
}

// 失败现场快照：步骤最终失败时抓当前页 URL/标题 + 近似候选元素（复用 content/observe.js 的 scan），
// 随失败结果返回给 AI —— AI 无需再补一轮 browser_observe 即可定位替代 selector。
// 依赖 10_browser_tools.js 的 callObserveMethod（importScripts 全部加载后全局可见）。
async function captureCardFailureSnapshot(tabId, { selector = '', stepName = '' } = {}) {
    const snapshot = { url: '', title: '', candidates: [] };
    try {
        const tab = await chrome.tabs.get(tabId);
        snapshot.url = String(tab?.url || '');
        snapshot.title = String(tab?.title || '');
    } catch (_error) {}
    try {
        // 关键词优先取 text= 选择器值或步骤名，能拿到语义上更贴近的候选；无命中时退回整页扫描
        let keyword = '';
        const textMatch = String(selector || '').trim().match(/^text[=:](.+)$/i);
        if (textMatch) {
            keyword = textMatch[1].trim();
        } else {
            const name = String(stepName || '').trim();
            if (name && !/^步骤\d+$/.test(name)) {
                keyword = name.replace(/^(点击|输入|等待)\s*/, '').slice(0, 20);
            }
        }
        const scanArgs = { include_text: false, limit: 20, max_items: 20, allow_truncate: true, mark: false };
        let scan = keyword
            ? await callObserveMethod(tabId, 'scan', [{ ...scanArgs, keyword }]).catch(() => null)
            : null;
        if (!scan || !Array.isArray(scan.items) || scan.items.length === 0) {
            scan = await callObserveMethod(tabId, 'scan', [scanArgs]).catch(() => null);
        }
        if (scan && Array.isArray(scan.items)) {
            snapshot.candidates = scan.items
                .filter((item) => item && item.kind === 'interactive')
                .slice(0, 15)
                .map((item) => ({
                    tag: item.tag,
                    selector: item.selector,
                    text: item.text,
                    name: item.name,
                    placeholder: item.placeholder,
                    ariaLabel: item.ariaLabel,
                    ...(item.inFrame === true ? { inFrame: true } : {})
                }));
        }
    } catch (_error) {}
    return snapshot;
}

async function runStandaloneCard(payload = {}) {
    const providedCardData = payload.cardData && typeof payload.cardData === 'object'
        ? payload.cardData
        : null;
    const cachedCard = providedCardData ? null : await loadCardCache().catch(() => null);
    const cardData = normalizeStandaloneSteps(providedCardData || cachedCard?.cardData || {});
    const progressMode = 'run';

    // 变量输入：每个 type 步骤的输入文本都是一个「变量」，默认取步骤自身 text；
    // 运行前可由 MCP inputs / 注册面板输入框按变量键覆盖（见 resolveStepVariableKey / normalizeRunInputs）。
    // 不再区分账号/密码，也不再随机生成密码；若某变量键恰为 account/password/email，则仍会流入 Cookie 命名与结果。
    const runInputs = normalizeRunInputs(payload, cardData);
    const providedAccount = String(payload.account || runInputs.account || cardData.account || '').trim();
    const providedPassword = String(payload.password || runInputs.password || cardData.password || '').trim();
    const providedEmail = String(payload.email || runInputs.email || cardData.email || '').trim();
    const totalSteps = Array.isArray(cardData.steps) ? cardData.steps.length : 0;
    const stepProgressStart = 20;
    const stepProgressEnd = 90;
    const stepProgressSpan = totalSteps > 0 ? (stepProgressEnd - stepProgressStart) / totalSteps : 0;
    const retryFailedStepInRunMode = true;
    const stepRetryDelayMs = Math.max(1000, Number(payload.step_retry_delay_ms || payload.stepRetryDelayMs || payload.retryDelayMs || 2000));
    const MAX_STEP_RETRIES = 3;
    let tabId = 0;
    let currentCardName = '';

    // ── 执行明细采集 ─────────────────────────────────────────────────────────
    // 把每一步的开始 / 完成 / 重试 / 跳过与各自耗时累积成结构化 trace，随最终结果
    // （成功或失败）一并返回给 MCP/AI —— 之前结果只有最终状态，过程细节仅通过 task:progress
    // 实时推送、结束后无从查看。现在返回 result.execution：完整执行过程、每步尝试次数、每步耗时。
    const runStartedAtMs = Date.now();
    const runStartedAt = new Date(runStartedAtMs).toISOString();
    const executionTrace = [];
    const traceTiming = new Map(); // stepIndex -> { startMs, attemptStartMs }
    const findTraceEntry = (idx) => executionTrace.find((entry) => entry.stepIndex === idx);
    // 由 emitProgress 单点驱动：每次进度上报都带 phase/stepIndex/stepName/kind/errorReason，
    // 据此推导每步状态与耗时，无需改动十几处步骤分支。
    const recordExecutionTrace = (state) => {
        try {
            const phase = String(state.phase || '');
            const idx = Number(state.stepIndex) || 0;
            if (!idx) return;
            const now = Date.now();
            if (phase === 'step_start') {
                let entry = findTraceEntry(idx);
                if (!entry) {
                    entry = {
                        stepIndex: idx,
                        stepName: String(state.stepName || ''),
                        status: 'running',
                        attempts: 0,
                        startedAt: new Date(now).toISOString(),
                        finishedAt: '',
                        durationMs: 0,
                        attemptDetails: []
                    };
                    executionTrace.push(entry);
                    traceTiming.set(idx, { startMs: now, attemptStartMs: now });
                } else {
                    const timing = traceTiming.get(idx) || { startMs: now };
                    timing.attemptStartMs = now;
                    traceTiming.set(idx, timing);
                }
                entry.attempts += 1;
                return;
            }
            const entry = findTraceEntry(idx);
            if (!entry) return;
            const timing = traceTiming.get(idx) || { startMs: now, attemptStartMs: now };
            const attemptMs = Math.max(0, now - (timing.attemptStartMs || now));
            const totalMs = Math.max(0, now - (timing.startMs || now));
            if (phase === 'step_complete') {
                entry.status = state.kind === 'error' ? 'completed_with_warning' : 'success';
                entry.finishedAt = new Date(now).toISOString();
                entry.durationMs = totalMs;
                entry.message = String(state.message || '');
                entry.attemptDetails.push({ attempt: entry.attempts, result: 'success', durationMs: attemptMs });
            } else if (phase === 'step_skip') {
                entry.status = 'skipped';
                entry.finishedAt = new Date(now).toISOString();
                entry.durationMs = totalMs;
                entry.message = String(state.message || '');
                entry.attemptDetails.push({ attempt: entry.attempts, result: 'skipped', durationMs: attemptMs });
            } else if (phase === 'step_retry') {
                // step_retry 同时用于「重试」(retrying:true) 与「达上限最终失败」(retrying:false)
                entry.attemptDetails.push({
                    attempt: entry.attempts,
                    result: 'failed',
                    error: String(state.errorReason || state.message || ''),
                    durationMs: attemptMs
                });
                if (state.retrying === false) {
                    entry.status = 'failed';
                    entry.finishedAt = new Date(now).toISOString();
                    entry.durationMs = totalMs;
                    entry.errorReason = String(state.errorReason || '');
                    entry.errorCode = String(state.errorCode || '');
                }
            }
        } catch (_traceError) {}
    };
    const buildExecutionSummary = () => {
        const finishedMs = Date.now();
        const stepsTotal = Array.isArray(executionState?.cardData?.steps)
            ? executionState.cardData.steps.length
            : (Array.isArray(cardData.steps) ? cardData.steps.length : 0);
        const succeeded = executionTrace.filter((entry) => entry.status === 'success' || entry.status === 'completed_with_warning').length;
        const failed = executionTrace.filter((entry) => entry.status === 'failed').length;
        const skipped = executionTrace.filter((entry) => entry.status === 'skipped').length;
        const retries = executionTrace.reduce((sum, entry) => sum + Math.max(0, (entry.attempts || 1) - 1), 0);
        return {
            startedAt: runStartedAt,
            finishedAt: new Date(finishedMs).toISOString(),
            durationMs: finishedMs - runStartedAtMs,
            stepsTotal,
            stepsExecuted: executionTrace.length,
            succeeded,
            failed,
            skipped,
            retries,
            steps: executionTrace
        };
    };

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
            payloadState.tabId = tabId;
            payloadState.cardName = currentCardName;
            payloadState.running = payloadState.running === false ? false : true;
            recordExecutionTrace(payloadState);
            await saveStandaloneProgressState(payloadState);
            await chrome.runtime.sendMessage({
                type: 'card-run-progress',
                ...payloadState
            });
        } catch (_error) {
        }
    };

    const context = {
        // 先铺入运行前提供的变量覆盖值（{key} 模板与后续步骤可直接引用），再用具名字段收敛
        ...runInputs,
        account: providedAccount,
        password: providedPassword,
        // 允许 run 预置验证码（失败续跑时回传上次已获取的 code，{code} 模板直接可用；wait_verification_code 成功后会写入）
        code: String(payload.code || runInputs.code || '').trim(),
        email: providedEmail,
        tempEmailCardName: '',
        tempEmailProviderName: '',
        tempEmailAddress: ''
    };

    const tab = await getOrFindActiveTab(cardData.website || '');
    if (!tab || !Number.isFinite(Number(tab.id || 0))) {
        throw new Error('卡片执行失败：未找到可用的当前标签页');
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
    if (isTabStopped(tabId)) {
        throw createStopError();
    }
    let tempEmailContext = null;

    // 重试控制：执行失败最多尝试 3 次，避免无限循环
    let stepAttempt = 1;
    let lastFailedStepIndex = -1;
    let maxRetriesExceeded = false;
    let lastDetailedError = '';  // 记录最后一次详细失败原因，用于最终返回/MCP
    let lastFailureDetails = null;  // 结构化失败详情（errorCode/步骤/selector/现场快照），挂到最终 error.failure
    const makeStepFailureError = (fallbackMessage) => {
        const err = new Error(lastDetailedError || fallbackMessage);
        if (lastFailureDetails) {
            err.failure = lastFailureDetails;
        }
        return err;
    };
    try {
        if (providedCardData && currentCardName) {
            await saveCardCacheState(cardData).catch(() => {});
        }

        await chrome.storage.local.set({
            [STANDALONE_LAST_CARD_KEY]: currentCardName
        }).catch(() => {});

        await emitProgress({
            message: `开始本地执行: ${currentCardName || '未命名卡片'}`,
            progress: 5,
            phase: 'start'
        });

        tempEmailContext = await ensureTempEmailContext({
            openTempEmailTab: payload.openTempEmailTab === true,
            refreshExistingTab: true,
            pageLoadTimeoutMs: Number(payload.tempEmailPageLoadTimeoutMs || payload.pageLoadTimeoutMs || 30000),
            tabId,
            runTabId: tabId,
            account: context.account,
            email: context.email
        }, emitProgress, 10);
        const overrideKeyCount = Object.keys(runInputs).length;
        await emitProgress({
            message: overrideKeyCount > 0
                ? `执行变量已就绪（${overrideKeyCount} 个覆盖值）`
                : '执行变量已就绪（使用步骤默认文本）',
            progress: 18,
            phase: 'inputs_ready'
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
            cookiesSaved: false
        };

    let index = 0;
    // 失败修复续跑：run 传 start_step（1-based，与失败结果 stepIndex 同一套序号，
    // 含 website 自动插入的 navigate 前置步骤）时跳过已成功的步骤，页面保持失败现场直接继续。
    const startStepRequest = Math.floor(Number(payload.start_step || payload.startStep || 0) || 0);
    if (startStepRequest > 1) {
        const totalRunSteps = Array.isArray(cardData.steps) ? cardData.steps.length : 0;
        if (startStepRequest > totalRunSteps) {
            throw new Error(`start_step=${startStepRequest} 超出步骤总数 ${totalRunSteps}（序号与失败结果 stepIndex 一致；卡片 website 自动插入的 navigate 前置步骤算第 1 步）`);
        }
        index = startStepRequest - 1;
        await emitProgress({
            message: `从第 ${startStepRequest}/${totalRunSteps} 步继续执行（跳过前 ${index} 步，页面保持当前状态）`,
            progress: stepProgressStart,
            phase: 'resume_from_step'
        });
    }
    while (index < (Array.isArray(executionState.cardData?.steps) ? executionState.cardData.steps.length : 0)) {
        if (isTabStopped(tabId)) {
            throw createStopError();
        }
        const activeCardData = executionState.cardData || cardData;
        const steps = Array.isArray(activeCardData.steps) ? activeCardData.steps : [];
        if (index >= steps.length) {
            break;
        }

        const step = steps[index];
        if (!step || typeof step !== 'object') {
            const invErr = buildDetailedFailureReason({ stepIndex: index + 1, stepName: `步骤${index + 1}`, stepType: 'invalid', reason: '步骤配置无效' });
            lastDetailedError = invErr;
            throw new Error(invErr);
        }

        // 计算当前步骤尝试次数（仅在 retry 模式下递增）
        if (index !== lastFailedStepIndex) {
            stepAttempt = 1;
            lastFailedStepIndex = index;
        } else if (retryFailedStepInRunMode) {
            stepAttempt++;
        }
        const currentAttempt = stepAttempt;
        const maxAttempts = MAX_STEP_RETRIES;

        const stepType = String(step.type || '').trim().toLowerCase();
        const stepName = String(step.name || `步骤${index + 1}`).trim() || `步骤${index + 1}`;
        // 智能填充提示，需在 step_start 进度上报（下方）之前声明，避免 TDZ 崩溃
        let magicFillNote = '';
        const liveTotalSteps = steps.length;
        const liveStepSpan = liveTotalSteps > 0 ? (stepProgressEnd - stepProgressStart) / liveTotalSteps : 0;
        const stepStartProgress = Math.min(stepProgressEnd, stepProgressStart + (index * liveStepSpan));
        const stepEndProgress = Math.min(stepProgressEnd, stepProgressStart + ((index + 1) * liveStepSpan));
        const attemptInfo = (retryFailedStepInRunMode && currentAttempt > 1) ? ` (尝试 ${currentAttempt}/${maxAttempts})` : '';
        const stepLabel = formatStepProgressLabel(index + 1, liveTotalSteps, stepName) + attemptInfo;
        const previousStepName = index > 0 ? String(steps[index - 1]?.name || `步骤${index}`).trim() || `步骤${index}` : '';
        const nextStepName = index + 1 < liveTotalSteps
            ? String(steps[index + 1]?.name || `步骤${index + 2}`).trim() || `步骤${index + 2}`
            : '';
        const handleStepFailure = async ({
            error,
            message = '',
            retryMessage = '',
            errorReason = '',
            phase = 'step_retry',
            stepType = '',
            selector = '',
            errorCode = ''
        } = {}) => {
            const rawReason = String(errorReason || error?.message || error || '').trim();
            const normalizedErrorCode = String(errorCode || error?.stepCode || 'STEP_FAILED').trim();
            const detailed = buildDetailedFailureReason({
                stepIndex: index + 1,
                stepName,
                stepType,
                reason: rawReason,
                attempt: currentAttempt,
                maxAttempts,
                selector
            });
            lastDetailedError = detailed;

            if (retryFailedStepInRunMode) {
                if (currentAttempt >= maxAttempts) {
                    // 最终失败：抓现场快照（URL/标题/近似候选元素）+ 结构化详情，供 MCP 失败结果与续跑使用
                    let failureSnapshot = null;
                    try {
                        failureSnapshot = await captureCardFailureSnapshot(tabId, { selector, stepName });
                    } catch (_snapError) {}
                    lastFailureDetails = {
                        errorCode: normalizedErrorCode,
                        stepIndex: index + 1,
                        stepTotal: liveTotalSteps,
                        stepName,
                        stepType,
                        selector: String(selector || '').trim(),
                        attempts: currentAttempt,
                        failureSnapshot
                    };
                    await emitProgress({
                        message: retryMessage || detailed,
                        progress: stepStartProgress,
                        kind: 'error',
                        mode: progressMode,
                        phase,
                        stepIndex: index + 1,
                        stepTotal: liveTotalSteps,
                        stepName,
                        previousStepName,
                        nextStepName,
                        errorReason: detailed,
                        errorCode: normalizedErrorCode,
                        running: false,
                        retrying: false
                    });
                    maxRetriesExceeded = true;
                    return 'max_reached';
                }
                await emitProgress({
                    message: retryMessage || `${stepLabel} · 执行失败，正在重试 (${currentAttempt}/${maxAttempts})`,
                    progress: stepStartProgress,
                    kind: 'error',
                    mode: progressMode,
                    phase,
                    stepIndex: index + 1,
                    stepTotal: liveTotalSteps,
                    stepName,
                    previousStepName,
                    nextStepName,
                    errorReason: detailed,
                    errorCode: normalizedErrorCode,
                    running: true,
                    retrying: true
                });
                await sleep(stepRetryDelayMs);
                return 'retrying';
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
                errorReason: detailed,
                message: message || detailed,
                previousStepName,
                nextStepName
            }, emitProgress);
            return 'paused';
        };
        await emitProgress({
            message: `${stepLabel} · 开始执行${magicFillNote}`,
            progress: stepStartProgress,
            phase: 'step_start',
            stepIndex: index + 1,
            stepTotal: liveTotalSteps,
            stepName,
            previousStepName,
            nextStepName
        });

        if (isTabStopped(tabId)) {
            throw createStopError();
        }

        if (stepType === 'navigate') {
            try {
                const url = normalizeTargetUrl(resolveTemplate(step.url || '', context) || resolveTemplate(activeCardData.website || '', context));
                if (!url) {
                    const handled = await handleStepFailure({
                        error: new Error(`步骤 ${stepName} 缺少有效 URL`),
                        message: `${stepLabel} · 缺少有效 URL`,
                        retryMessage: `${stepLabel} · 缺少有效 URL，正在重试`,
                        errorReason: `步骤 ${stepName} 缺少有效 URL`,
                        stepType: 'navigate',
                        selector: '',
                        errorCode: 'MISSING_URL'
                    });
                    // 缺 URL 不会自愈：达到重试上限必须抛出，否则 continue 会在同一步骤死循环
                    if (handled === 'max_reached') {
                        throw makeStepFailureError(`${stepLabel} 失败（缺少有效 URL）`);
                    }
                    continue;
                }

                const currentTab = await chrome.tabs.get(tabId).catch(() => null);
                const currentTabUrl = normalizeTargetUrl(String(currentTab?.url || '').trim());
                if (currentTabUrl === url) {
                    await emitProgress({
                        message: `${stepLabel} · 已在目标网页，无需跳转`,
                        progress: stepEndProgress,
                        phase: 'step_complete',
                        stepIndex: index + 1,
                        stepTotal: liveTotalSteps,
                        stepName
                    });
                } else {
                    await chrome.tabs.update(tabId, { url });
                    await waitForTabComplete(tabId, Number(step.timeout || 30000));
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
                const handled = await handleStepFailure({
                    error,
                    message: error && error.message ? error.message : `${stepLabel} · 导航失败，已暂停等待修改`,
                    retryMessage: error && error.message ? `${stepLabel} · ${error.message}，正在重试` : `${stepLabel} · 导航失败，正在重试`,
                    errorReason: error && error.message ? error.message : `步骤 ${stepName} 导航失败`,
                    stepType: 'navigate',
                    selector: step.url || activeCardData.website || '',
                    errorCode: error && error.message === '页面加载超时' ? 'NAVIGATION_TIMEOUT' : 'NAVIGATE_FAILED'
                });
                if (handled === 'max_reached') {
                    throw makeStepFailureError(`${stepLabel} 失败（已重试 ${currentAttempt} 次达到上限）`);
                }
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
                    retryForever: step.retry_forever === true
                }, tempEmailContext, emitProgress));
                const code = String(codeResult.code || '').trim();
                if (!code) {
                    const handled = await handleStepFailure({
                        error: new Error('等待验证码超时'),
                        message: `${stepLabel} · 等待验证码超时，已暂停`,
                        retryMessage: `${stepLabel} · 等待验证码超时，正在重试`,
                        errorReason: '等待验证码超时',
                        stepType: 'wait_verification_code',
                        errorCode: 'VERIFICATION_CODE_TIMEOUT'
                    });
                    if (handled === 'max_reached') {
                        const d = lastDetailedError || `${stepLabel} 失败（已重试 ${currentAttempt} 次达到上限）`;
                        throw new Error(d);
                    }
                    continue;
                }

                context.code = code;
                if (codeResult.verificationTime) {
                    context.codeTime = codeResult.verificationTime;
                    context.code_time = codeResult.verificationTime;
                    result.codeTime = codeResult.verificationTime;
                    result.code_time = codeResult.verificationTime;
                }
                await emitProgress({
                    message: `${stepLabel} · 已获取验证码${codeResult.verificationTime ? `（时间: ${codeResult.verificationTime}）` : ''}（后续步骤用 {code} 模板引用）`,
                    progress: stepEndProgress,
                    phase: 'step_complete',
                    stepIndex: index + 1,
                    stepTotal: liveTotalSteps,
                    stepName
                });
                index += 1;
                continue;
            } catch (error) {
                const handled = await handleStepFailure({
                    error,
                    message: error && error.message ? error.message : `${stepLabel} · 等待验证码失败，已暂停等待修改`,
                    retryMessage: error && error.message ? `${stepLabel} · ${error.message}，正在重试` : `${stepLabel} · 等待验证码失败，正在重试`,
                    errorReason: error && error.message ? error.message : '等待验证码失败',
                    stepType: 'wait_verification_code',
                    errorCode: 'VERIFICATION_CODE_FAILED'
                });
                if (handled === 'max_reached') {
                    throw makeStepFailureError(`${stepLabel} 失败（已重试 ${currentAttempt} 次达到上限）`);
                }
                continue;
            }
        }

        if (stepType === 'save_cookies') {
            const captureAccount = String(context.email || context.account || result.account || payload.account || '').trim();
            const capturePassword = String(context.code || result.password || payload.password || '').trim();
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
                const handled = await handleStepFailure({
                    error,
                    message: error && error.message ? error.message : `${stepLabel} · 清理当前页缓存失败，已暂停等待修改`,
                    retryMessage: error && error.message ? `${stepLabel} · ${error.message}，正在重试` : `${stepLabel} · 清理当前页缓存失败，正在重试`,
                    errorReason: error && error.message ? error.message : '清理当前页缓存失败',
                    stepType: 'clear_current_page_cache',
                    errorCode: 'CLEAR_CACHE_FAILED'
                });
                if (handled === 'max_reached') {
                    throw makeStepFailureError(`${stepLabel} 失败（已重试 ${currentAttempt} 次达到上限）`);
                }
                continue;
            }
        }

        const resolvedSelector = resolveTemplate(step.selector || '', context);
        let rawText = resolveTemplate(step.text || '', context);
        if (stepType === 'type') {
            // 每个 type 步骤 = 一个变量槽。默认取步骤 text，运行前可按变量键覆盖（MCP inputs / 注册面板）。
            // 不再按步骤名智能识别验证码/邮箱：验证码请把默认文本写成 {code} 模板（wait_verification_code 会注入）。
            // 变量键的顺序回退（var1/var2/...）按 type 步骤在整卡中的绝对序号计算，
            // 这样 start_step 续跑跳过前面步骤时，同一步骤仍拿到相同的 varN 键。
            let typeOrdinal = 0;
            for (let scan = 0; scan <= index && scan < steps.length; scan += 1) {
                if (String(steps[scan]?.type || '').trim().toLowerCase() === 'type') {
                    typeOrdinal += 1;
                }
            }
            const variableKey = resolveStepVariableKey(step, typeOrdinal);
            const hasOverride = Object.prototype.hasOwnProperty.call(runInputs, variableKey)
                && runInputs[variableKey] !== undefined
                && runInputs[variableKey] !== null;
            const baseText = hasOverride ? String(runInputs[variableKey]) : String(step.text || '');
            rawText = resolveTemplate(baseText, context);
            // 把该变量的最终取值回写进上下文，供后续步骤 {key} 引用及 Cookie 命名/结果使用
            context[variableKey] = rawText;
            if (hasOverride) {
                magicFillNote = `（变量 ${variableKey} 覆盖）`;
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
                const waitResult = await executePageAction(tabId, {
                    ...actionPayload,
                    type: 'wait',
                    hidden: step.wait_for_element_hidden ? true : false,
                    selector: resolvedSelector,
                    timeoutMs: Number(step.timeout || step.wait_ms || step.waitMs || 3000),
                    intervalMs: Number(step.wait_for_element_interval_ms || 200)
                });
                if (!waitResult || waitResult.success !== true) {
                    const waitError = new Error(waitResult?.error || `等待步骤失败: ${stepName}`);
                    waitError.stepCode = waitResult?.code || 'WAIT_TIMEOUT';
                    throw waitError;
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
                const handled = await handleStepFailure({
                    error,
                    message: error && error.message ? error.message : `${stepLabel} · 等待步骤失败，已暂停等待修改`,
                    retryMessage: error && error.message ? `${stepLabel} · ${error.message}，正在重试` : `${stepLabel} · 等待步骤失败，正在重试`,
                    errorReason: error && error.message ? error.message : `等待步骤失败: ${stepName}`,
                    stepType: 'wait',
                    selector: resolvedSelector
                });
                if (handled === 'max_reached') {
                    throw makeStepFailureError(`${stepLabel} 失败（已重试 ${currentAttempt} 次达到上限）`);
                }
                continue;
            }
        }

        if (stepType === 'get_credits') {
            try {
                const creditResult = await executePageAction(tabId, actionPayload);
                if (!creditResult || creditResult.success !== true) {
                    const creditError = new Error(creditResult?.error || `获取积分失败: ${stepName}`);
                    creditError.stepCode = creditResult?.code || 'GET_CREDITS_FAILED';
                    throw creditError;
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
                const handled = await handleStepFailure({
                    error,
                    message: error && error.message ? error.message : `${stepLabel} · 获取积分失败，已暂停等待修改`,
                    retryMessage: error && error.message ? `${stepLabel} · ${error.message}，正在重试` : `${stepLabel} · 获取积分失败，正在重试`,
                    errorReason: error && error.message ? error.message : `获取积分失败: ${stepName}`,
                    stepType: 'get_credits',
                    selector: resolvedSelector
                });
                if (handled === 'max_reached') {
                    throw makeStepFailureError(`${stepLabel} 失败（已重试 ${currentAttempt} 次达到上限）`);
                }
                continue;
            }
        }

        if (stepType === 'external_script') {
            try {
                // Try MAIN world injection for external_script to maximize access and sometimes reduce isolated-world eval friction.
                // Note: page CSP (script-src without 'unsafe-eval') can still block new Function / eval inside the provided script.
                const scriptCode = String(actionPayload.script || '').trim();
                let scriptResult;
                if (scriptCode) {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId },
                        world: 'MAIN',
                        func: (code) => {
                            try {
                                // Execute user code in page MAIN world (still subject to page CSP for eval constructs)
                                const fn = new Function('return (async () => { ' + code + ' })();');
                                return fn();
                            } catch (e) {
                                return { __error: true, message: e && e.message ? e.message : String(e) };
                            }
                        },
                        args: [scriptCode]
                    });
                    const r = Array.isArray(results) ? results[0] : null;
                    const val = r && r.result;
                    if (val && val.__error) {
                        scriptResult = { success: false, error: val.message };
                    } else {
                        scriptResult = { success: true, result: val };
                    }
                } else {
                    scriptResult = { success: true };
                }

                if (!scriptResult || scriptResult.success !== true) {
                    const scriptError = new Error(scriptResult?.error || `脚本步骤失败: ${stepName}`);
                    scriptError.stepCode = 'SCRIPT_ERROR';
                    throw scriptError;
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
                const handled = await handleStepFailure({
                    error,
                    message: error && error.message ? error.message : `${stepLabel} · 脚本步骤失败，已暂停等待修改`,
                    retryMessage: error && error.message ? `${stepLabel} · ${error.message}，正在重试` : `${stepLabel} · 脚本步骤失败，正在重试`,
                    errorReason: error && error.message ? error.message : `脚本步骤失败: ${stepName}`,
                    stepType: 'external_script',
                    selector: resolvedSelector
                });
                if (handled === 'max_reached') {
                    throw makeStepFailureError(`${stepLabel} 失败（已重试 ${currentAttempt} 次达到上限）`);
                }
                continue;
            }
        }

        if (stepType === 'screenshot') {
            try {
                const tabInfo = await chrome.tabs.get(tabId).catch(() => null);
                const winId = tabInfo && Number.isFinite(Number(tabInfo.windowId)) ? tabInfo.windowId : chrome.windows.WINDOW_ID_CURRENT;
                const dataUrl = await chrome.tabs.captureVisibleTab(winId, { format: 'png' });
                const ts = new Date().toISOString().replace(/[:.]/g, '-');
                const safeName = (currentCardName || 'card').replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 40) || 'card';
                const filename = `automation_screenshots/${safeName}_${ts}.png`;
                await chrome.downloads.download({ url: dataUrl, filename, saveAs: false, conflictAction: 'uniquify' });
                await emitProgress({
                    message: `${stepLabel} · 截图已保存（${filename}）`,
                    progress: stepEndProgress,
                    phase: 'step_complete',
                    stepIndex: index + 1,
                    stepTotal: liveTotalSteps,
                    stepName
                });
            } catch (err) {
                await emitProgress({
                    message: `${stepLabel} · 截图失败（${err && err.message ? err.message : '未知错误'}），已跳过`,
                    progress: stepEndProgress,
                    kind: 'error',
                    phase: 'step_complete',
                    stepIndex: index + 1,
                    stepTotal: liveTotalSteps,
                    stepName
                });
            }
            index += 1;
            continue;
        }

        const selectors = normalizeSelectorCandidates(step.by || 'css_selector', resolvedSelector);
        let stepExecuted = false;
        let lastError = '';
        let lastErrorCode = '';
        let lastTriedSelector = String(resolvedSelector || '').trim();

        for (const selector of selectors) {
            lastTriedSelector = selector;
            try {
                const actionResult = await executePageAction(tabId, {
                    ...actionPayload,
                    selector,
                    type: stepType === 'click' ? 'click' : stepType === 'type' ? 'type' : stepType
                });

                if (actionResult && actionResult.success === true) {
                    stepExecuted = true;
                    break;
                }

                lastError = actionResult?.error || lastError;
                lastErrorCode = actionResult?.code || lastErrorCode;
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

            const handled = await handleStepFailure({
                error: new Error(lastError || '步骤执行失败'),
                message: lastError || `${stepLabel} · 执行失败，已暂停等待修改`,
                retryMessage: lastError ? `${stepLabel} · ${lastError}，正在重试` : `${stepLabel} · 执行失败，正在重试`,
                errorReason: lastError || '步骤执行失败',
                stepType,
                selector: lastTriedSelector,
                errorCode: lastErrorCode
            });
            if (handled === 'max_reached') {
                throw makeStepFailureError(`${stepLabel} 失败（已重试 ${currentAttempt} 次达到上限）`);
            }
            continue;
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

    if (maxRetriesExceeded) {
        throw makeStepFailureError('卡片执行失败：步骤重试已达 3 次上限');
    }

    result.success = true;

    await emitProgress({
        message: `本地执行完成: ${currentCardName || '未命名卡片'}`,
        progress: 100,
        phase: 'finished'
    });
    result.execution = buildExecutionSummary();
    return result;
    } catch (error) {
        if (isTabStopped(tabId) || isStopError(error)) {
            try {
                const lastState = await loadStandaloneProgressState().catch(() => null);
                const stoppedProgress = Number.isFinite(Number(lastState?.progress))
                    ? Number(lastState.progress)
                    : 0;
                await saveStandaloneProgressState({
                    ...(lastState && typeof lastState === 'object' ? lastState : {}),
                    tabId,
                    cardName: currentCardName,
                    message: '已停止执行',
                    phase: 'stopped',
                    mode: '',
                    kind: '',
                    errorReason: '',
                    progress: stoppedProgress,
                    running: false,
                    stopped: true,
                    visible: true
                }).catch(() => {});
                // finished message will be sent by the stop handler
            } catch (_e) {}
            return { success: false, stopped: true, cardName: currentCardName, execution: buildExecutionSummary() };
        }

        // 卡片执行失败时主动释放状态
        try {
            const lastState = await loadStandaloneProgressState().catch(() => null);
            const failProgress = Number.isFinite(Number(lastState?.progress))
                ? Number(lastState.progress)
                : 0;
            const baseMsg = (error && error.message ? error.message : '卡片执行失败');
            const failMessage = lastDetailedError || baseMsg;
            await saveStandaloneProgressState({
                ...(lastState && typeof lastState === 'object' ? lastState : {}),
                tabId,
                cardName: currentCardName,
                message: failMessage,
                phase: 'failed',
                mode: '',
                kind: 'error',
                errorReason: failMessage,
                progress: failProgress,
                running: false,
                visible: true
            }).catch(() => {});
            await emitProgress({
                message: failMessage,
                progress: failProgress,
                phase: 'failed',
                kind: 'error',
                errorReason: failMessage,
                running: false
            }).catch(() => {});
        } catch (_e) {}

        // 结构化失败详情 + 运行上下文挂到 error 上：09_agent_socket.js 的 run 捕获后
        // 据此返回 errorCode / failureSnapshot / context，供 AI 修复卡片并 start_step 续跑。
        try {
            if (!error.failure && lastFailureDetails) {
                error.failure = lastFailureDetails;
            }
            if (error.failure && !error.failure.context) {
                error.failure.context = {
                    account: String(context.account || ''),
                    password: String(context.password || ''),
                    email: String(context.email || ''),
                    code: String(context.code || '')
                };
            }
        } catch (_ctxError) {}

        // 完整执行明细（每步过程/尝试次数/耗时）挂到 error 上，供 09_agent_socket.js
        // 失败结果一并回传，让 AI 即使失败也能看到到失败前每一步都发生了什么。
        try {
            error.execution = buildExecutionSummary();
        } catch (_execError) {}

        throw error;
    } finally {
        if (tempEmailContext) {
            await closeTempEmailDesktopWindow({
                sessionId: tempEmailContext.sessionId || payload.sessionId || payload.taskId || payload.browserSessionId || 'default',
                tabId,
                email: tempEmailContext.email || context.email || ''
            }, tempEmailContext).catch(() => {});
        }
        stoppedTabs.delete(tabId);
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

    const saveToServer = !!(payload.saveToServer || payload.save_to_server);
    const base = {
        success: true,
        fileName,
        cookieCount: cookies.length,
        browserStorageCount: browserStorage.length,
        pageUrl: savePayload.pageUrl,
        upload
    };
    if (saveToServer) {
        base.cookies = cookies;
        base.browserStorage = browserStorage;
        base.data = savePayload;
        base.save_to_server = true;
    }
    return base;
}

