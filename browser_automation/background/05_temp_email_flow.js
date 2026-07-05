async function readSelectorTextFromTab(tabId, selector = '') {
    const targetSelector = String(selector || '').trim();
    if (!targetSelector) {
        return '';
    }

    const result = await executePageAction(tabId, {
        type: 'get_credits',
        selector: targetSelector,
        timeoutMs: 8000,
        intervalMs: 250,
        defaultValue: ''
    }).catch(() => null);

    if (!result || result.success !== true) {
        return '';
    }

    return String(result.value || '').trim();
}

async function readVerificationTextFromTab(tabId, provider = {}) {
    const candidates = [];
    const codeElement = String(provider?.codeElement || '').trim();
    if (codeElement) {
        candidates.push(codeElement);
    }
    candidates.push(
        '.code',
        '[class*="code"]',
        '[id*="code"]',
        '[data-code]',
        '[data-testid*="code"]',
        'body',
        'html'
    );

    for (const selector of candidates) {
        const text = await readSelectorTextFromTab(tabId, selector).catch(() => '');
        if (String(text || '').trim()) {
            return String(text || '').trim();
        }
    }

    return '';
}

function normalizeVerificationCodeResult(result = '') {
    if (typeof result === 'string') {
        return {
            code: String(result || '').trim(),
            verificationTime: '',
            debug: null
        };
    }

    if (result && typeof result === 'object') {
        return {
            code: String(
                result.code
                || result.verificationCode
                || result.smsCode
                || result.sms_code
                || ''
            ).trim(),
            verificationTime: String(
                result.verificationTime
                || result.verification_time
                || result.time
                || result.receivedAt
                || result.received_at
                || result.fetchedAt
                || result.fetched_at
                || ''
            ).trim(),
            debug: result.debug && typeof result.debug === 'object' ? result.debug : null
        };
    }

    return {
        code: '',
        verificationTime: '',
        debug: null
    };
}

async function clickSelectorsOnTab(tabId, selectors = []) {
    const normalizedSelectors = normalizeSelectorList(selectors);
    for (const selector of normalizedSelectors) {
        const result = await executePageAction(tabId, {
            type: 'click',
            selector,
            timeoutMs: 3000,
            intervalMs: 250
        }).catch(() => null);
        if (result && result.success === true) {
            await sleep(250);
        }
    }
}

const TEMP_EMAIL_WEB_CONTROL_URL_KEY = 'cookie-capture-temp-email-web-control-url';
let tempEmailWebControlUrlCache = '';

async function loadTempEmailWebControlUrlFromStorage() {
    const stored = await chrome.storage.local.get([TEMP_EMAIL_WEB_CONTROL_URL_KEY]).catch(() => ({}));
    return String(stored[TEMP_EMAIL_WEB_CONTROL_URL_KEY] || '').trim();
}

async function saveTempEmailWebControlUrlToStorage(url = '') {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) {
        return;
    }

    await chrome.storage.local.set({
        [TEMP_EMAIL_WEB_CONTROL_URL_KEY]: normalizedUrl
    }).catch(() => {});
}

async function readTempEmailWebControlUrlFromTab(tabId = 0) {
    const normalizedTabId = Number(tabId || 0) || 0;
    if (!normalizedTabId) {
        return '';
    }

    const results = await chrome.scripting.executeScript({
        target: { tabId: normalizedTabId },
        func: () => String(
            window.__WEB_CONTROL_URL__
            || window.__WEB_CONTROL_RUNTIME__?.webControlUrl
            || window.__WEB_CONTROL_RUNTIME__?.webUiUrl
            || ''
        ).trim()
    }).catch(() => []);

    const result = Array.isArray(results) ? results[0] : null;
    return String(result?.result || '').trim();
}

async function resolveTempEmailWebControlUrl({ tabId = 0, forceRefresh = false } = {}) {
    if (!forceRefresh && tempEmailWebControlUrlCache) {
        return tempEmailWebControlUrlCache;
    }

    if (!forceRefresh) {
        const contextUrl = String(tempEmailRuntimeContext?.webControlUrl || '').trim();
        if (contextUrl) {
            tempEmailWebControlUrlCache = contextUrl;
            await saveTempEmailWebControlUrlToStorage(contextUrl);
            return contextUrl;
        }

        const storedUrl = await loadTempEmailWebControlUrlFromStorage().catch(() => '');
        if (storedUrl) {
            tempEmailWebControlUrlCache = storedUrl;
            return storedUrl;
        }
    }

    const candidateTabs = [];
    const normalizedTabId = Number(tabId || 0) || 0;
    if (normalizedTabId) {
        candidateTabs.push(normalizedTabId);
    }

    if (!candidateTabs.length) {
        const activeTab = await getActiveTab().catch(() => null);
        if (activeTab && Number.isFinite(Number(activeTab.id || 0))) {
            candidateTabs.push(Number(activeTab.id));
        }
    }

    for (const candidateTabId of candidateTabs) {
        const url = await readTempEmailWebControlUrlFromTab(candidateTabId).catch(() => '');
        if (url) {
            tempEmailWebControlUrlCache = url;
            await saveTempEmailWebControlUrlToStorage(url);
            return url;
        }
    }

    const fallbackUrl = 'http://127.0.0.1:18765';
    tempEmailWebControlUrlCache = fallbackUrl;
    return fallbackUrl;
}

async function requestTempEmailControlInvoke(channel = '', args = [], options = {}) {
    const baseUrl = await resolveTempEmailWebControlUrl({
        tabId: options.tabId || 0,
        forceRefresh: options.forceRefresh === true
    });

    const url = `${String(baseUrl || '').trim().replace(/\/+$/, '')}/api/invoke`;
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            channel: String(channel || '').trim(),
            args: Array.isArray(args) ? args : []
        })
    }).catch((error) => {
        throw new Error(error && error.message ? error.message : '请求软件 HTTP 控制失败');
    });

    const rawText = await response.text().catch(() => '');
    let data = null;
    if (rawText) {
        try {
            data = JSON.parse(rawText);
        } catch (_error) {
            data = null;
        }
    }

    if (!response.ok) {
        throw new Error(String(data?.error || rawText || `HTTP ${response.status}`).trim() || '软件 HTTP 控制请求失败');
    }

    return data?.result ?? null;
}

function stripHtmlTags(text = '') {
    return String(text || '').replace(/<[^>]*>/g, ' ');
}

async function invokeTempEmailControl(channel = '', payload = {}, options = {}) {
    const result = await requestTempEmailControlInvoke(channel, [payload], options).catch((error) => {
        throw new Error(error && error.message ? error.message : '请求软件临时邮箱控制失败');
    });
    return result || {};
}

async function invokeTempEmailControlWithRetry(channel = '', payload = {}, options = {}, retryOptions = {}) {
    const label = String(retryOptions.label || channel || '临时邮箱HTTP请求').trim() || '临时邮箱HTTP请求';
    const baseIntervalMs = Number.isFinite(Number(retryOptions.intervalMs))
        ? Math.max(500, Number(retryOptions.intervalMs))
        : 1500;
    const maxIntervalMs = Number.isFinite(Number(retryOptions.maxIntervalMs))
        ? Math.max(baseIntervalMs, Number(retryOptions.maxIntervalMs))
        : 5000;
    const validate = typeof retryOptions.validate === 'function' ? retryOptions.validate : null;
    let intervalMs = baseIntervalMs;
    let attempt = 0;
    const controlTabId = Number(retryOptions.controlTabId || payload.tabId || payload.runTabId || 0) || 0;

    while (true) {
        if (controlTabId) {
            await throwIfStopped(controlTabId);
        }
        attempt += 1;
        try {
            const response = await invokeTempEmailControl(channel, payload, options);
            if (validate) {
                const validationResult = validate(response);
                if (validationResult !== true) {
                    throw new Error(
                        typeof validationResult === 'string'
                            ? validationResult
                            : String(retryOptions.emptyMessage || `${label}未返回有效结果`).trim() || `${label}未返回有效结果`
                    );
                }
            }
            return response || {};
        } catch (error) {
            if (attempt === 1 || attempt % 10 === 0) {
                console.warn(`[cookie_capture] ${label}失败，${intervalMs}ms后重试:`, error && error.message ? error.message : error);
            }
            await sleepWithStandaloneStopCheck(intervalMs, controlTabId);
            intervalMs = Math.min(maxIntervalMs, Math.max(baseIntervalMs, Math.floor(intervalMs * 1.5)));
        }
    }
}

async function loadTempEmailControlState(options = {}) {
    const response = await invokeTempEmailControlWithRetry('temp-email-load-config', {}, options, {
        label: '加载临时邮箱配置',
        validate: (result) => {
            const state = result && typeof result === 'object' ? result.state || null : null;
            return state ? true : '临时邮箱配置未返回';
        },
        emptyMessage: '临时邮箱配置未返回'
    });
    return response && typeof response === 'object' ? response.state || null : null;
}

async function resolveTempEmailProviderId(payload = {}, context = null, options = {}) {
    const directProviderId = String(
        payload.providerId
        || payload.selectedProviderId
        || context?.providerId
        || context?.selectedProviderId
        || ''
    ).trim();
    if (directProviderId) {
        return directProviderId;
    }

    const state = await loadTempEmailControlState(options).catch(() => null);
    return String(
        state?.selectedProviderId
        || state?.currentProviderId
        || state?.provider?.id
        || ''
    ).trim();
}

function normalizeVerificationCandidate(value = '') {
    return String(value || '').trim().replace(/[\s\r\n_-]+/g, '').replace(/[^A-Z0-9]/gi, '');
}

function getRecordTimestamp(record = {}) {
    const candidates = [record.timestamp, record.created_at, record.createdAt, record.sent_at, record.sentAt, record.date, record.time];
    for (const candidate of candidates) {
        if (candidate === undefined || candidate === null || candidate === '') {
            continue;
        }
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            return candidate < 1e12 ? candidate * 1000 : candidate;
        }
        const numeric = Number(candidate);
        if (Number.isFinite(numeric)) {
            return numeric < 1e12 ? numeric * 1000 : numeric;
        }
        const parsed = Date.parse(String(candidate));
        if (Number.isFinite(parsed)) {
            return parsed;
        }
    }
    return 0;
}

function extractVerificationCodeFromText(text = '') {
    const rawText = String(text || '');
    const normalized = rawText.replace(/\s+/g, ' ').trim();
    if (!normalized || !/(verification|confirmation|activation|security|authentication|code|验证码|校验码|确认码|动态码|otp)/i.test(normalized)) {
        return '';
    }

    const patterns = [
        /(?:verification|confirmation|activation|security|authentication)\s+code\s*[:：]?\s*([A-Z0-9]{4,15})/i,
        /(?:verification\s+code|verify\s+code|auth\s+code|security\s+code|access\s+code|otp\s+code|one[-\s]?time\s+code|验证码|校验码|确认码|动态码)\s*[:：]?\s*([A-Z0-9]{4,15})/i,
        /\b([A-Z0-9]{4,15})\b/
    ];

    for (const pattern of patterns) {
        const match = normalized.match(pattern);
        if (!match) {
            continue;
        }

        const code = normalizeVerificationCandidate(match[1]);
        if (code) {
            return code;
        }
    }

    return '';
}

function extractVerificationCodeFromEmailRecord(record = {}) {
    if (!record || typeof record !== 'object') {
        return '';
    }

    const directFields = [
        record.code,
        record.verification_code,
        record.verificationCode,
        record.otp,
        record.otp_code,
        record.otpCode
    ];

    for (const value of directFields) {
        const code = normalizeVerificationCandidate(value);
        if (code) {
            return code;
        }
    }

    const candidates = [
        record.subject,
        record.content,
        record.html_content,
        record.text,
        record.body,
        record.snippet
    ];

    for (const candidate of candidates) {
        const rawText = String(candidate || '');
        const normalizedText = /<[^>]+>/.test(rawText) ? stripHtmlTags(rawText) : rawText;
        const code = extractVerificationCodeFromText(normalizedText);
        if (code) {
            return code;
        }
    }

    return '';
}

async function openTempEmailDesktopWindow(payload = {}, context = null) {
    const providerId = await resolveTempEmailProviderId(payload, context, {
        tabId: payload.tabId || context?.tabId || 0,
        forceRefresh: payload.forceRefresh === true
    });
    const controlPayload = {
        ...payload,
        providerId,
        sessionId: payload.sessionId || context?.sessionId || 'default'
    };
    const response = await invokeTempEmailControlWithRetry('temp-email-open-provider', controlPayload, {
        tabId: payload.tabId || context?.tabId || 0,
        forceRefresh: payload.forceRefresh === true
    }, {
        label: '打开临时邮箱浏览器',
        validate: (result) => {
            if (!result || result.success === false) {
                return '打开临时邮箱浏览器失败';
            }
            const openedUrl = String(result?.url || result?.state?.url || '').trim();
            const browserId = String(result?.browserId || result?.state?.browserId || '').trim();
            return openedUrl || browserId ? true : '打开临时邮箱浏览器未返回有效信息';
        },
        emptyMessage: '打开临时邮箱浏览器未返回有效信息'
    });
    return {
        success: response?.success !== false,
        url: String(response?.url || response?.state?.url || '').trim(),
        browserId: String(response?.browserId || response?.state?.browserId || '').trim(),
        raw: response
    };
}

async function closeTempEmailDesktopWindow(payload = {}, context = null) {
    const response = await invokeTempEmailControlWithRetry('temp-email-close-provider', {
        ...payload,
        sessionId: payload.sessionId || context?.sessionId || 'default'
    }, {
        tabId: payload.tabId || context?.tabId || 0,
        forceRefresh: payload.forceRefresh === true
    }, {
        label: '关闭临时邮箱浏览器',
        validate: (result) => {
            if (!result || result.success === false) {
                return '关闭临时邮箱浏览器失败';
            }
            return result.closed !== false || '关闭临时邮箱浏览器未完成';
        },
        emptyMessage: '关闭临时邮箱浏览器未完成'
    });
    tempEmailRuntimeContext = null;
    return {
        success: response?.success !== false,
        closed: response?.closed !== false,
        tabId: Number(payload.tabId || context?.runTabId || context?.tabId || 0) || 0,
        email: String(response?.email || context?.email || payload.email || '').trim()
    };
}

async function getTempEmailDesktopEmail(payload = {}, context = null) {
    const existingEmail = String(payload.email || context?.email || '').trim();
    if (existingEmail && payload.forceRefresh !== true && payload.refreshExistingTab !== true) {
        return {
            success: true,
            email: existingEmail,
            raw: null
        };
    }

    const providerId = await resolveTempEmailProviderId(payload, context, {
        tabId: payload.tabId || context?.tabId || 0,
        forceRefresh: payload.forceRefresh === true
    });
    const channel = payload.forceRefresh === true || payload.refreshExistingTab === true
        ? 'temp-email-refresh-email'
        : 'temp-email-get-email';
    const response = await invokeTempEmailControlWithRetry(channel, {
        ...payload,
        providerId,
        sessionId: payload.sessionId || context?.sessionId || 'default',
        email: existingEmail
    }, {
        tabId: payload.tabId || context?.tabId || 0,
        forceRefresh: payload.forceRefresh === true
    }, {
        label: '获取临时邮箱地址',
        validate: (result) => {
            if (!result || result.success === false) {
                return '获取邮箱失败';
            }
            const emailValue = String(result?.email || result?.state?.email || result?.state?.currentEmail || '').trim();
            return emailValue ? true : '未返回邮箱地址';
        },
        emptyMessage: '未返回邮箱地址'
    });

    const email = String(response?.email || response?.state?.email || response?.state?.currentEmail || '').trim();
    return {
        success: true,
        email,
        raw: response
    };
}

async function getTempEmailDesktopCode(payload = {}, context = null) {
    const apiContext = context && typeof context === 'object' ? context : {};
    const controlTabId = Number(payload.tabId || payload.runTabId || apiContext.runTabId || apiContext.tabId || 0) || 0;
    let email = String(payload.email || apiContext.email || '').trim();
    if (controlTabId) {
        await throwIfStopped(controlTabId);
    }
    if (!email) {
        const emailResult = await getTempEmailDesktopEmail({
            ...payload,
            forceRefresh: false
        }, apiContext);
        email = String(emailResult?.email || '').trim();
        if (email && apiContext && typeof apiContext === 'object') {
            apiContext.email = email;
        }
    }
    if (!email) {
        return {
            success: false,
            error: '临时邮箱地址为空',
            email: ''
        };
    }

    const providerId = await resolveTempEmailProviderId(payload, apiContext, {
        tabId: payload.tabId || apiContext.tabId || 0,
        forceRefresh: payload.forceRefresh === true
    });
    if (controlTabId) {
        await throwIfStopped(controlTabId);
    }
    const response = await invokeTempEmailControlWithRetry('temp-email-get-code', {
        ...payload,
        providerId,
        sessionId: payload.sessionId || apiContext.sessionId || 'default',
        email
    }, {
        tabId: payload.tabId || apiContext.tabId || 0,
        forceRefresh: payload.forceRefresh === true
    }, {
        label: '获取验证码',
        controlTabId,
        validate: (result) => {
            if (!result || result.success === false) {
                return '获取验证码失败';
            }
            const codeValue = String(result?.code || result?.state?.code || '').trim();
            return codeValue ? true : '未找到验证码';
        },
        emptyMessage: '未找到验证码'
    });

    const code = String(response?.code || response?.state?.code || '').trim();
    return {
        success: true,
        code,
        email,
        raw: response,
        verificationTime: String(
            response?.verificationTime
            || response?.verification_time
            || response?.codeTime
            || response?.code_time
            || ''
        ).trim()
    };
}

async function ensureTempEmailContext(tempEmailPayload = {}, emitProgress = async () => {}, progressBase = 10) {
    const runtimeContext = await getRuntimeTempEmailContext();
    const controlTabId = Number(tempEmailPayload.tabId || tempEmailPayload.runTabId || runtimeContext?.runTabId || runtimeContext?.tabId || 0) || 0;
    const webControlUrl = await resolveTempEmailWebControlUrl({
        tabId: controlTabId,
        forceRefresh: false
    }).catch(() => '');
    const sessionId = String(
        tempEmailPayload.sessionId
        || tempEmailPayload.taskId
        || tempEmailPayload.browserSessionId
        || runtimeContext?.sessionId
        || 'default'
    ).trim() || 'default';
    const existingEmail = String(tempEmailPayload.email || runtimeContext?.email || '').trim();
    const context = {
        tabId: 0,
        runTabId: controlTabId,
        email: existingEmail,
        browserId: '',
        url: '',
        desktopMode: false,
        sessionId,
        webControlUrl
    };

    if (!context.email) {
        await emitProgress({
            message: '正在通过软件 HTTP 控制打开临时邮箱浏览器...',
            progress: progressBase,
            mode: tempEmailPayload.debugMode === true ? 'debug' : 'run',
            phase: 'open_temp_email'
        });
        if (!runtimeContext || !String(runtimeContext.browserId || runtimeContext.url || '').trim()) {
            const openResult = await openTempEmailDesktopWindow(tempEmailPayload, context);
            context.browserId = String(openResult.browserId || '').trim();
            context.url = String(openResult.url || '').trim();
        } else {
            context.browserId = String(runtimeContext.browserId || '').trim();
            context.url = String(runtimeContext.url || '').trim();
        }
    } else {
        await emitProgress({
            message: `已使用现有临时邮箱地址: ${context.email}`,
            progress: progressBase,
            mode: tempEmailPayload.debugMode === true ? 'debug' : 'run',
            phase: 'temp_email_ready'
        });
    }

    await emitProgress({
        message: context.email
            ? `已获取临时邮箱地址: ${context.email}`
            : '已打开临时邮箱浏览器，等待获取邮箱',
        progress: Math.min(35, progressBase + 25),
        mode: tempEmailPayload.debugMode === true ? 'debug' : 'run',
        phase: 'temp_email_ready'
    });
    tempEmailRuntimeContext = context;
    return context;
}

async function waitForVerificationCode(payload = {}, tempEmailContext = null, emitProgress = async () => {}) {
    const timeoutMs = Number.isFinite(Number(payload.timeoutMs)) ? Number(payload.timeoutMs) : 300000;
    const intervalCandidate = Number(payload.intervalMs);
    const intervalMs = Number.isFinite(intervalCandidate) && intervalCandidate > 0 ? intervalCandidate : 1500;
    const progressBase = Number.isFinite(Number(payload.progressBase)) ? Number(payload.progressBase) : null;
    const progressSpan = Number.isFinite(Number(payload.progressSpan)) ? Number(payload.progressSpan) : null;
    const progressMode = String(payload.mode || '').trim() || 'run';
    const stepName = String(payload.stepName || '等待验证码').trim() || '等待验证码';
    const stepIndex = Number.isFinite(Number(payload.stepIndex)) ? Number(payload.stepIndex) : null;
    const stepTotal = Number.isFinite(Number(payload.stepTotal)) ? Number(payload.stepTotal) : null;
    const controlTabId = Number(payload.tabId || 0) || Number(tempEmailContext?.runTabId || 0) || Number(tempEmailContext?.tabId || 0);
    const sessionId = String(
        payload.sessionId
        || payload.taskId
        || payload.browserSessionId
        || tempEmailContext?.sessionId
        || 'default'
    ).trim() || 'default';
    let email = String(tempEmailContext?.email || payload.email || '').trim();
    if (controlTabId) {
        await throwIfStopped(controlTabId);
    }
    if (!email) {
        const emailResult = await getTempEmailDesktopEmail({
            ...payload,
            forceRefresh: false
        }, tempEmailContext || payload);
        email = String(emailResult?.email || '').trim();
        if (email && tempEmailContext && typeof tempEmailContext === 'object') {
            tempEmailContext.email = email;
        }
    }
    if (!email) {
        return '';
    }

    if (controlTabId) {
        await waitForStandaloneDebugControl(controlTabId, emitProgress, {
            mode: progressMode,
            progress: Number.isFinite(progressBase) && Number.isFinite(progressSpan)
                ? Math.max(0, Math.min(100, progressBase))
                : undefined,
            stepIndex,
            stepTotal,
            stepName
        });
    }

    if (Number.isFinite(progressBase) && Number.isFinite(progressSpan)) {
        await emitProgress({
            message: `${formatStepProgressLabel(stepIndex, stepTotal, stepName)} · 等待验证码`,
            progress: Math.max(0, Math.min(100, progressBase)),
            mode: progressMode,
            phase: 'wait_verification_code',
            stepIndex,
            stepTotal,
            stepName
        });
    }

    const codeResult = await getTempEmailDesktopCode({
        ...payload,
        tabId: controlTabId || payload.tabId,
        email,
        sessionId,
        timeoutMs,
        intervalMs
    }, {
        ...tempEmailContext,
        email,
        sessionId
    });
    const code = String(codeResult.code || '').trim();
    if (code) {
        return {
            code,
            verificationTime: String(codeResult.verificationTime || '').trim(),
            debug: codeResult.debug || null
        };
    }
    return '';
}

async function pauseAtStep({
    tabId = 0,
    cardName = '',
    stepName = '',
    stepIndex = 0,
    stepTotal = 0,
    previousStepName = '',
    nextStepName = '',
    progress = undefined,
    errorReason = '',
    message = '步骤执行失败，已暂停等待修改',
    phase = 'step_failed_pause'
} = {}, emitProgress = async () => {}) {
    const normalizedTabId = Number(tabId || 0) || 0;
    if (!normalizedTabId) {
        return;
    }

    await saveStandaloneDebugControlState({
        tabId: normalizedTabId,
        cardName: String(cardName || '').trim(),
        mode: 'pause',
        stepBudget: 0,
        running: true
    }).catch(() => {});

    await emitProgress({
        message: stepName ? `${message}: ${stepName}` : message,
        progress,
        kind: 'error',
        mode: 'debug',
        phase,
        stepIndex,
        stepTotal,
        stepName,
        previousStepName: String(previousStepName || '').trim(),
        nextStepName: String(nextStepName || '').trim(),
        errorReason: String(errorReason || '').trim(),
        running: true
    });
}

// 说明：临时邮箱「调试栏目」相关的入口函数（handleTempEmailOpen / GetEmail /
// Refresh / GetCode / Close）已随该栏目一并移除。以上的引擎函数
// （ensureTempEmailContext / waitForVerificationCode / getTempEmailDesktopEmail /
// closeTempEmailDesktopWindow 等）仍由自动化流程 06_automation_run.js 的
// wait_verification_code 步骤内部调用，故保留。

