function collectStorageSnapshot() {
    const collect = (storage) => {
        const result = {};
        try {
            if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function') {
                return result;
            }

            for (let index = 0; index < storage.length; index += 1) {
                const key = storage.key(index);
                if (!key) {
                    continue;
                }
                result[key] = storage.getItem(key);
            }
        } catch (_error) {
        }
        return result;
    };

    return {
        url: String(window.location.href || ''),
        origin: String(window.location.origin || ''),
        title: String(document.title || ''),
        localStorage: collect(window.localStorage),
        sessionStorage: collect(window.sessionStorage)
    };
}

async function getActiveTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return Array.isArray(tabs) ? tabs.find((tab) => tab && Number(tab.id || 0) > 0) || null : null;
}

function extractTabMatchKey(url = '') {
    const normalized = normalizeTargetUrl(String(url || '').trim());
    if (!normalized) {
        return '';
    }

    try {
        return new URL(normalized).origin;
    } catch (_error) {
        return normalized;
    }
}

async function findExistingTabByUrl(url = '') {
    const matchKey = extractTabMatchKey(url);
    if (!matchKey) {
        return null;
    }

    const tabs = await chrome.tabs.query({}).catch(() => []);
    const candidates = Array.isArray(tabs) ? tabs.filter((tab) => tab && Number(tab.id || 0) > 0 && typeof tab.url === 'string') : [];
    const exactMatch = candidates.find((tab) => {
        const tabKey = extractTabMatchKey(tab.url || '');
        return tabKey && tabKey === matchKey;
    });
    if (exactMatch) {
        return exactMatch;
    }

    return candidates.find((tab) => {
        const tabUrl = String(tab.url || '').trim();
        return tabUrl && tabUrl.includes(matchKey);
    }) || null;
}

async function getOrFindActiveTab(url = '') {
    const existingTab = await findExistingTabByUrl(url).catch(() => null);
    if (existingTab) {
        return existingTab;
    }

    return getActiveTab();
}

async function readPageSnapshot(tabId) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: collectStorageSnapshot
    });

    const result = Array.isArray(results) ? results[0] : null;
    return result && result.result ? result.result : null;
}

async function readCookies(pageUrl = '') {
    const normalizedUrl = normalizeCaptureUrl(pageUrl);
    if (!normalizedUrl) {
        return [];
    }

    try {
        return await chrome.cookies.getAll({ url: normalizedUrl });
    } catch (_error) {
        return [];
    }
}

function isHttpPageUrl(value = '') {
    try {
        const parsed = new URL(String(value || '').trim());
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (_error) {
        return false;
    }
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    if (currentTab && currentTab.status === 'complete') {
        return currentTab;
    }

    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 0);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            reject(new Error('页面加载超时'));
        }, Math.max(1000, deadline - Date.now()));

        const onUpdated = (updatedTabId, changeInfo, tab) => {
            if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
                return;
            }

            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve(tab);
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
    });
}

async function navigateTabToUrl(tabId = 0, pageUrl = '') {
    const normalizedTabId = Number(tabId || 0) || 0;
    const normalizedPageUrl = normalizeTargetUrl(String(pageUrl || '').trim());
    if (!normalizedTabId || !isHttpPageUrl(normalizedPageUrl)) {
        return null;
    }

    const tab = await chrome.tabs.get(normalizedTabId).catch(() => null);
    if (!tab) {
        throw new Error('未找到可跳转的目标标签页');
    }

    const currentUrl = normalizeTargetUrl(String(tab.url || '').trim());
    if (currentUrl === normalizedPageUrl) {
        return tab;
    }

    await chrome.tabs.update(normalizedTabId, { url: normalizedPageUrl });
    return waitForTabComplete(normalizedTabId, 20000);
}

async function restoreBrowserStorageToCurrentPage(tabId = 0, browserStorage = []) {
    const normalizedTabId = Number(tabId || 0) || 0;
    const normalizedEntries = Array.isArray(browserStorage)
        ? browserStorage.map((entry, index) => normalizeBrowserStorageEntry(entry, index))
        : [];

    if (!normalizedTabId) {
        throw new Error('未找到可恢复浏览器存储的目标标签页');
    }

    const mergedLocalStorage = {};
    const mergedSessionStorage = {};
    let entryCount = 0;

    for (const entry of normalizedEntries) {
        const localStorageEntries = entry.localStorage && typeof entry.localStorage === 'object' ? entry.localStorage : {};
        const sessionStorageEntries = entry.sessionStorage && typeof entry.sessionStorage === 'object' ? entry.sessionStorage : {};
        if (Object.keys(localStorageEntries).length === 0 && Object.keys(sessionStorageEntries).length === 0) {
            continue;
        }

        entryCount += 1;
        Object.assign(mergedLocalStorage, localStorageEntries);
        Object.assign(mergedSessionStorage, sessionStorageEntries);
    }

    if (Object.keys(mergedLocalStorage).length === 0 && Object.keys(mergedSessionStorage).length === 0) {
        return {
            success: true,
            tabId: normalizedTabId,
            browserStorageCount: 0,
            restoredLocalStorageCount: 0,
            restoredSessionStorageCount: 0
        };
    }

    const results = await chrome.scripting.executeScript({
        target: { tabId: normalizedTabId },
        args: [{
            localStorage: mergedLocalStorage,
            sessionStorage: mergedSessionStorage
        }],
        func: async (payload) => {
            const result = {
                restoredLocalStorageCount: 0,
                restoredSessionStorageCount: 0
            };

            try {
                if (window.localStorage && typeof window.localStorage.clear === 'function') {
                    window.localStorage.clear();
                    const localStorageEntries = payload && payload.localStorage && typeof payload.localStorage === 'object' ? payload.localStorage : {};
                    for (const [key, value] of Object.entries(localStorageEntries)) {
                        window.localStorage.setItem(key, value);
                    }
                    result.restoredLocalStorageCount = Object.keys(localStorageEntries).length;
                }
            } catch (_error) {
            }

            try {
                if (window.sessionStorage && typeof window.sessionStorage.clear === 'function') {
                    window.sessionStorage.clear();
                    const sessionStorageEntries = payload && payload.sessionStorage && typeof payload.sessionStorage === 'object' ? payload.sessionStorage : {};
                    for (const [key, value] of Object.entries(sessionStorageEntries)) {
                        window.sessionStorage.setItem(key, value);
                    }
                    result.restoredSessionStorageCount = Object.keys(sessionStorageEntries).length;
                }
            } catch (_error) {
            }

            return result;
        }
    }).catch(() => []);

    const scriptResult = Array.isArray(results) ? results[0] : null;
    const storageCounts = scriptResult && scriptResult.result && typeof scriptResult.result === 'object'
        ? scriptResult.result
        : {
            restoredLocalStorageCount: 0,
            restoredSessionStorageCount: 0
        };

    return {
        success: true,
        tabId: normalizedTabId,
        browserStorageCount: entryCount,
        restoredLocalStorageCount: Number(storageCounts.restoredLocalStorageCount || 0) || 0,
        restoredSessionStorageCount: Number(storageCounts.restoredSessionStorageCount || 0) || 0
    };
}

function normalizeCookieImportBool(value = false) {
    return value === true || value === 'true' || value === 'TRUE' || value === 1 || value === '1';
}

function normalizeCookieImportSameSite(value = '') {
    const text = String(value || '').trim().toLowerCase();
    if (!text) {
        return '';
    }

    if (text === 'lax') return 'lax';
    if (text === 'strict') return 'strict';
    if (text === 'no_restriction' || text === 'none') return 'no_restriction';
    return '';
}

function normalizeCookieImportEntry(entry = {}, fallbackIndex = 0) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const name = String(source.name || source.key || source.cookieName || '').trim();
    const value = String(source.value ?? source.content ?? source.cookieValue ?? '').trim();
    const domain = String(source.domain || source.host || source.cookieDomain || '').trim().replace(/^\./, '');
    const path = String(source.path || source.cookiePath || '/').trim() || '/';
    const secure = normalizeCookieImportBool(source.secure);
    const httpOnly = normalizeCookieImportBool(source.httpOnly || source.http_only || source.httponly);
    const hostOnly = normalizeCookieImportBool(source.hostOnly || source.host_only || source.hostonly);
    const sameSite = normalizeCookieImportSameSite(source.sameSite || source.samesite);
    let expirationDate = Number(source.expirationDate || source.expires || source.expire || 0);
    if (Number.isFinite(expirationDate) && expirationDate > 1e12) {
        expirationDate = Math.floor(expirationDate / 1000);
    }
    const result = {
        name,
        value,
        domain,
        path,
        secure,
        httpOnly,
        hostOnly
    };

    if (sameSite) {
        result.sameSite = sameSite;
    }

    if (Number.isFinite(expirationDate) && expirationDate > 0) {
        result.expirationDate = expirationDate;
    }

    if (source.session === true) {
        result.session = true;
    }

    if (!result.name && !result.value && !domain) {
        result.name = `cookie_${fallbackIndex + 1}`;
    }

    return result;
}

function normalizeBrowserStorageEntry(entry = {}, fallbackIndex = 0) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const normalizeStorageMap = (value = {}) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }

        const result = {};
        for (const [key, item] of Object.entries(value)) {
            if (!String(key || '').trim()) {
                continue;
            }
            result[String(key)] = item == null ? '' : String(item);
        }
        return result;
    };

    return {
        id: String(source.id || `browser-storage-${fallbackIndex + 1}`).trim(),
        url: String(source.url || '').trim(),
        origin: String(source.origin || '').trim(),
        localStorage: normalizeStorageMap(source.localStorage || source.local_storage || {}),
        sessionStorage: normalizeStorageMap(source.sessionStorage || source.session_storage || {})
    };
}

function buildCookieSetUrl(pageUrl = '', cookie = {}) {
    const normalizedPageUrl = String(pageUrl || '').trim();
    const cookieDomain = String(cookie?.domain || '').trim().replace(/^\./, '');
    const path = String(cookie?.path || '/').trim() || '/';
    const secure = cookie?.secure === true;

    if (cookieDomain) {
        const protocol = secure ? 'https:' : 'http:';
        return `${protocol}//${cookieDomain}${path}`;
    }

    if (!normalizedPageUrl) {
        return '';
    }

    try {
        const parsed = new URL(normalizedPageUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return '';
        }

        const protocol = secure ? 'https:' : parsed.protocol;
        return `${protocol}//${parsed.hostname}${path}`;
    } catch (_error) {
        return '';
    }
}

function buildCookieSetCandidates(pageUrl = '', cookie = {}) {
    const normalizedPageUrl = String(pageUrl || '').trim();
    const cookieDomain = String(cookie?.domain || '').trim().replace(/^\./, '');
    const path = String(cookie?.path || '/').trim() || '/';
    const secure = cookie?.secure === true;
    const hostOnly = cookie?.hostOnly === true;
    const candidates = [];

    const addCandidate = (url = '', includeDomain = false) => {
        const normalizedUrl = String(url || '').trim();
        if (!normalizedUrl) {
            return;
        }
        const key = `${normalizedUrl}__${includeDomain ? 'domain' : 'nodomain'}`;
        if (candidates.some((item) => item.key === key)) {
            return;
        }
        candidates.push({
            key,
            url: normalizedUrl,
            includeDomain
        });
    };

    let parsedPageUrl = null;
    if (normalizedPageUrl) {
        try {
            const parsed = new URL(normalizedPageUrl);
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                parsedPageUrl = parsed;
            }
        } catch (_error) {
        }
    }

    const pageHostUrl = parsedPageUrl
        ? `${secure ? 'https:' : parsedPageUrl.protocol}//${parsedPageUrl.hostname}${path}`
        : '';

    const domainUrl = cookieDomain
        ? `${secure ? 'https:' : 'https:'}//${cookieDomain}${path}`
        : '';

    if (hostOnly) {
        addCandidate(pageHostUrl || domainUrl, false);
        if (!pageHostUrl && domainUrl) {
            addCandidate(domainUrl, false);
        }
        return candidates;
    }

    if (cookieDomain) {
        addCandidate(domainUrl, true);
    }
    if (pageHostUrl) {
        addCandidate(pageHostUrl, false);
    }
    if (!cookieDomain && normalizedPageUrl) {
        addCandidate(pageHostUrl || normalizedPageUrl, false);
    }

    return candidates;
}

async function importCookiesToCurrentPage(tabId = 0, pageUrl = '', cookies = []) {
    const normalizedTabId = Number(tabId || 0) || 0;
    const normalizedPageUrl = String(pageUrl || '').trim();
    const normalizedCookies = Array.isArray(cookies)
        ? cookies.map((cookie, index) => normalizeCookieImportEntry(cookie, index)).filter((cookie) => String(cookie.name || '').trim())
        : [];

    if (!normalizedTabId) {
        throw new Error('未找到可注入 Cookie 的目标标签页');
    }

    if (!normalizedCookies.length) {
        throw new Error('未识别到可注入的 Cookie 数据');
    }

    const results = [];
    const errors = [];

    for (const [index, cookie] of normalizedCookies.entries()) {
        const candidates = buildCookieSetCandidates(normalizedPageUrl, cookie);
        if (!candidates.length || !cookie.name) {
            errors.push({
                index,
                cookie,
                error: '无法生成 Cookie 注入地址'
            });
            continue;
        }

        let savedCookie = null;
        let lastError = '';

        for (const candidate of candidates) {
            const cookieArgs = {
                url: candidate.url,
                name: String(cookie.name || '').trim(),
                value: String(cookie.value ?? '').trim()
            };

            if (candidate.includeDomain && !cookie.hostOnly && String(cookie.domain || '').trim()) {
                cookieArgs.domain = String(cookie.domain || '').trim();
            }
            if (String(cookie.path || '').trim()) {
                cookieArgs.path = String(cookie.path || '').trim();
            }
            if (cookie.secure === true) {
                cookieArgs.secure = true;
            }
            if (cookie.httpOnly === true) {
                cookieArgs.httpOnly = true;
            }
            const sameSite = normalizeCookieImportSameSite(cookie.sameSite || '');
            if (sameSite) {
                cookieArgs.sameSite = sameSite;
            }
            if (Number.isFinite(Number(cookie.expirationDate)) && Number(cookie.expirationDate) > 0) {
                cookieArgs.expirationDate = Number(cookie.expirationDate);
            }

            try {
                savedCookie = await chrome.cookies.set(cookieArgs);
                if (savedCookie) {
                    break;
                }
                lastError = 'Cookie 写入失败';
            } catch (error) {
                lastError = error && error.message ? error.message : 'Cookie 写入失败';
            }
        }

        if (savedCookie) {
            results.push(savedCookie);
        } else {
            errors.push({
                index,
                cookie,
                error: lastError || 'Cookie 写入失败'
            });
        }
    }

    const firstError = errors.length > 0
        ? errors[0].error || 'Cookie 写入失败'
        : '';
    const success = results.length > 0;

    return {
        success,
        tabId: normalizedTabId,
        pageUrl: normalizedPageUrl,
        importedCount: results.length,
        failedCount: errors.length,
        errors,
        firstError,
        message: success
            ? errors.length > 0
            ? `已注入 ${results.length} 条 Cookie，失败 ${errors.length} 条`
                : `已注入 ${results.length} 条 Cookie`
            : `未能注入任何 Cookie${firstError ? `：${firstError}` : ''}`
    };
}

async function importSnapshotToCurrentPage(tabId = 0, pageUrl = '', cookies = [], browserStorage = []) {
    const normalizedTabId = Number(tabId || 0) || 0;
    const normalizedPageUrl = String(pageUrl || '').trim();
    const normalizedCookies = Array.isArray(cookies) ? cookies : [];
    const normalizedBrowserStorage = Array.isArray(browserStorage) ? browserStorage : [];
    const targetPageUrl = isHttpPageUrl(normalizedPageUrl) ? normalizedPageUrl : '';

    if (targetPageUrl) {
        await navigateTabToUrl(normalizedTabId, targetPageUrl).catch(() => {});
    }

    const storageResult = await restoreBrowserStorageToCurrentPage(normalizedTabId, normalizedBrowserStorage).catch((error) => ({
        success: false,
        browserStorageCount: 0,
        restoredLocalStorageCount: 0,
        restoredSessionStorageCount: 0,
        error: error && error.message ? error.message : '浏览器存储恢复失败'
    }));

    const cookieResult = await importCookiesToCurrentPage(normalizedTabId, targetPageUrl || normalizedPageUrl, normalizedCookies).catch((error) => ({
        success: false,
        importedCount: 0,
        failedCount: normalizedCookies.length,
        firstError: error && error.message ? error.message : 'Cookie 写入失败',
        message: error && error.message ? error.message : 'Cookie 写入失败',
        error: error && error.message ? error.message : 'Cookie 写入失败'
    }));

    const importedCount = Number(cookieResult.importedCount || 0) || 0;
    const failedCount = Number(cookieResult.failedCount || 0) || 0;
    const restoredLocalStorageCount = Number(storageResult.restoredLocalStorageCount || 0) || 0;
    const restoredSessionStorageCount = Number(storageResult.restoredSessionStorageCount || 0) || 0;
    const browserStorageCount = Number(storageResult.browserStorageCount || 0) || 0;
    const success = importedCount > 0 || restoredLocalStorageCount > 0 || restoredSessionStorageCount > 0;
    const parts = [];

    if (browserStorageCount > 0) {
        parts.push(`浏览器存储 ${browserStorageCount} 组`);
    }
    if (restoredLocalStorageCount > 0) {
        parts.push(`localStorage ${restoredLocalStorageCount} 项`);
    }
    if (restoredSessionStorageCount > 0) {
        parts.push(`sessionStorage ${restoredSessionStorageCount} 项`);
    }
    if (importedCount > 0) {
        parts.push(`Cookie ${importedCount} 条`);
    }
    if (failedCount > 0) {
        parts.push(`失败 ${failedCount} 条`);
    }
    if (storageResult.success === false && storageResult.error) {
        parts.push(storageResult.error);
    }
    if (cookieResult.success === false && cookieResult.firstError) {
        parts.push(cookieResult.firstError);
    }

    return {
        success,
        tabId: normalizedTabId,
        pageUrl: normalizedPageUrl,
        browserStorageCount,
        restoredLocalStorageCount,
        restoredSessionStorageCount,
        importedCount,
        failedCount,
        firstError: cookieResult.firstError || storageResult.error || '',
        message: parts.length > 0
            ? `已导入 ${parts.join('，')}`
            : success
                ? '已完成导入'
                : '导入失败',
        storageError: storageResult.success === false ? storageResult.error : '',
        cookieError: cookieResult.success === false ? cookieResult.firstError || cookieResult.error || '' : ''
    };
}

function buildCookieRemovalUrl(pageUrl = '', cookie = {}) {
    const normalizedPageUrl = String(pageUrl || '').trim();
    if (!normalizedPageUrl) {
        return '';
    }

    try {
        const parsed = new URL(normalizedPageUrl);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return '';
        }

        const cookieDomain = String(cookie?.domain || '').trim().replace(/^\./, '');
        const host = cookieDomain || parsed.hostname;
        const path = String(cookie?.path || '/').trim() || '/';
        const secure = cookie?.secure === true;
        const protocol = secure ? 'https:' : parsed.protocol;
        return `${protocol}//${host}${path}`;
    } catch (_error) {
        return '';
    }
}

async function clearCurrentPageCache(tabId = 0) {
    const normalizedTabId = Number(tabId || 0) || 0;
    const tab = normalizedTabId
        ? await chrome.tabs.get(normalizedTabId).catch(() => null)
        : await getActiveTab().catch(() => null);
    if (!tab || !Number.isFinite(Number(tab.id || 0))) {
        throw new Error('未找到可清理的当前标签页');
    }

    const pageUrl = String(tab.url || '').trim();
    const removedCookies = [];
    const cookies = await readCookies(pageUrl).catch(() => []);
    for (const cookie of Array.isArray(cookies) ? cookies : []) {
        const url = buildCookieRemovalUrl(pageUrl, cookie);
        if (!url || !cookie || !cookie.name) {
            continue;
        }

        const removeArgs = {
            url,
            name: String(cookie.name || '').trim()
        };
        const storeId = String(cookie.storeId || '').trim();
        if (storeId) {
            removeArgs.storeId = storeId;
        }

        const removed = await chrome.cookies.remove(removeArgs).catch(() => null);

        if (removed) {
            removedCookies.push(removed);
        }
    }

    const storageResult = await chrome.scripting.executeScript({
        target: { tabId: Number(tab.id) },
        func: async () => {
            const result = {
                clearedLocalStorageCount: 0,
                clearedSessionStorageCount: 0,
                clearedCacheStorageCount: 0,
                clearedIndexedDbCount: 0
            };

            try {
                if (window.localStorage && window.localStorage.length > 0) {
                    result.clearedLocalStorageCount = window.localStorage.length;
                    window.localStorage.clear();
                }
            } catch (_error) {
            }

            try {
                if (window.sessionStorage && window.sessionStorage.length > 0) {
                    result.clearedSessionStorageCount = window.sessionStorage.length;
                    window.sessionStorage.clear();
                }
            } catch (_error) {
            }

            try {
                if (window.caches && typeof window.caches.keys === 'function') {
                    const cacheKeys = await window.caches.keys();
                    const normalizedCacheKeys = Array.isArray(cacheKeys) ? cacheKeys : [];
                    result.clearedCacheStorageCount = normalizedCacheKeys.length;
                    await Promise.all(normalizedCacheKeys.map((key) => window.caches.delete(key).catch(() => false)));
                }
            } catch (_error) {
            }

            try {
                if (window.indexedDB && typeof window.indexedDB.databases === 'function' && typeof window.indexedDB.deleteDatabase === 'function') {
                    const databases = await window.indexedDB.databases();
                    const dbList = Array.isArray(databases) ? databases.filter((db) => db && db.name) : [];
                    result.clearedIndexedDbCount = dbList.length;
                    await Promise.all(dbList.map((db) => new Promise((resolve) => {
                        const request = window.indexedDB.deleteDatabase(db.name);
                        request.onsuccess = () => resolve(true);
                        request.onerror = () => resolve(false);
                        request.onblocked = () => resolve(false);
                    })));
                }
            } catch (_error) {
            }

            return result;
        }
    }).catch(() => []);

    const scriptResult = Array.isArray(storageResult) ? storageResult[0] : null;
    const storageCounts = scriptResult && scriptResult.result && typeof scriptResult.result === 'object'
        ? scriptResult.result
        : {
            clearedLocalStorageCount: 0,
            clearedSessionStorageCount: 0,
            clearedCacheStorageCount: 0,
            clearedIndexedDbCount: 0
        };

    return {
        success: true,
        tabId: Number(tab.id),
        pageUrl,
        removedCookieCount: removedCookies.length,
        clearedLocalStorageCount: Number(storageCounts.clearedLocalStorageCount || 0) || 0,
        clearedSessionStorageCount: Number(storageCounts.clearedSessionStorageCount || 0) || 0,
        clearedCacheStorageCount: Number(storageCounts.clearedCacheStorageCount || 0) || 0,
        clearedIndexedDbCount: Number(storageCounts.clearedIndexedDbCount || 0) || 0
    };
}

async function resolveCookieManagerTab(tabId = 0) {
    const normalizedTabId = Number(tabId || 0) || 0;
    const tab = normalizedTabId
        ? await chrome.tabs.get(normalizedTabId).catch(() => null)
        : await getActiveTab().catch(() => null);
    if (!tab || !Number.isFinite(Number(tab.id || 0))) {
        throw new Error('未找到可管理 Cookie 的当前标签页');
    }
    return tab;
}

async function listCurrentTabCookies(tabId = 0) {
    const tab = await resolveCookieManagerTab(tabId);
    const pageUrl = String(tab.url || '').trim();
    const cookies = await readCookies(pageUrl).catch(() => []);

    return {
        success: true,
        tabId: Number(tab.id),
        pageUrl,
        cookies: Array.isArray(cookies) ? cookies : []
    };
}

async function removeCurrentTabCookie(tabId = 0, cookie = {}) {
    const tab = await resolveCookieManagerTab(tabId);
    const pageUrl = String(tab.url || '').trim();
    const name = String(cookie?.name || '').trim();
    if (!name) {
        throw new Error('缺少要删除的 Cookie 名称');
    }

    const url = buildCookieRemovalUrl(pageUrl, cookie);
    if (!url) {
        throw new Error('无法定位该 Cookie 的删除地址');
    }

    const removeArgs = { url, name };
    const storeId = String(cookie?.storeId || '').trim();
    if (storeId) {
        removeArgs.storeId = storeId;
    }

    const removed = await chrome.cookies.remove(removeArgs).catch(() => null);
    if (!removed) {
        throw new Error('删除 Cookie 失败');
    }

    return {
        success: true,
        tabId: Number(tab.id),
        name,
        removed
    };
}

async function loadCardSidebarState() {
    const stored = await runtimeStateStorage.get([CARD_SIDEBAR_STATE_KEY]).catch(() => ({}));
    const state = stored && typeof stored === 'object' ? stored[CARD_SIDEBAR_STATE_KEY] : null;
    if (!state || typeof state !== 'object') {
        return null;
    }

    return {
        tabId: Number(state.tabId || 0) || null,
        width: Math.max(520, Number(state.width || 0) || 820),
        open: state.open === true,
        updatedAt: String(state.updatedAt || '').trim()
    };
}

async function saveCardSidebarState(state = {}) {
    const nextState = {
        tabId: Number(state.tabId || 0) || null,
        width: Math.max(520, Number(state.width || 0) || 820),
        open: state.open === true,
        updatedAt: new Date().toISOString()
    };
    await runtimeStateStorage.set({
        [CARD_SIDEBAR_STATE_KEY]: nextState
    }).catch(() => {});
    return nextState;
}

async function clearCardSidebarState() {
    await runtimeStateStorage.remove([CARD_SIDEBAR_STATE_KEY]).catch(() => {});
}

async function loadStandaloneProgressState() {
    const stored = await runtimeStateStorage.get([STANDALONE_PROGRESS_STATE_KEY]).catch(() => ({}));
    const state = stored && typeof stored === 'object' ? stored[STANDALONE_PROGRESS_STATE_KEY] : null;
    if (!state || typeof state !== 'object') {
        return null;
    }

    return {
        tabId: Number(state.tabId || 0) || null,
        cardName: String(state.cardName || '').trim(),
        message: String(state.message || '').trim(),
        phase: String(state.phase || '').trim(),
        mode: String(state.mode || '').trim(),
        kind: String(state.kind || '').trim(),
        errorReason: String(state.errorReason || '').trim(),
        stepIndex: Number(state.stepIndex || 0) || 0,
        stepTotal: Number(state.stepTotal || 0) || 0,
        stepName: String(state.stepName || '').trim(),
        previousStepName: String(state.previousStepName || '').trim(),
        nextStepName: String(state.nextStepName || '').trim(),
        progress: Number.isFinite(Number(state.progress)) ? Number(state.progress) : undefined,
        running: state.running === true,
        visible: state.visible !== false,
        updatedAt: String(state.updatedAt || '').trim()
    };
}

async function saveStandaloneProgressState(state = {}) {
    const nextState = {
        tabId: Number(state.tabId || 0) || null,
        cardName: String(state.cardName || '').trim(),
        message: String(state.message || '').trim(),
        phase: String(state.phase || '').trim(),
        mode: String(state.mode || '').trim(),
        kind: String(state.kind || '').trim(),
        errorReason: String(state.errorReason || '').trim(),
        stepIndex: Number(state.stepIndex || 0) || 0,
        stepTotal: Number(state.stepTotal || 0) || 0,
        stepName: String(state.stepName || '').trim(),
        previousStepName: String(state.previousStepName || '').trim(),
        nextStepName: String(state.nextStepName || '').trim(),
        running: state.running === true,
        visible: state.visible !== false,
        updatedAt: new Date().toISOString()
    };

    if (Number.isFinite(Number(state.progress))) {
        nextState.progress = Number(state.progress);
    }

    await runtimeStateStorage.set({
        [STANDALONE_PROGRESS_STATE_KEY]: nextState
    }).catch(() => {});
    return nextState;
}

async function syncStandaloneSession(payload = {}, senderTabId = null) {
    const tabId = Number(payload.tabId || senderTabId || 0) || null;
    const providedCardData = payload.cardData && typeof payload.cardData === 'object' ? payload.cardData : null;
    if (!tabId || !providedCardData) {
        throw new Error('缺少可同步的自动化卡片');
    }

    const normalizedCard = normalizeStandaloneSteps(providedCardData);
    const session = standaloneSessions.get(tabId);
    if (session && session.cardData) {
        session.cardData = normalizedCard;
        session.cardName = String(normalizedCard.name || '').trim();
        session.updatedAt = new Date().toISOString();
    }

    await saveCardCacheState(normalizedCard).catch(() => {});

    return {
        success: true,
        tabId,
        cardName: String(normalizedCard.name || '').trim(),
        stepCount: Array.isArray(normalizedCard.steps) ? normalizedCard.steps.length : 0,
        running: Boolean(session)
    };
}

