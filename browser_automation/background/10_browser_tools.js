// background/10_browser_tools.js — 三类浏览器 MCP 工具的后台封装：
//   · 导航与搜索：browser_tab（list/switch/replace/navigate/close/back/forward）
//   · 页面观察：  browser_observe
//   · 页面交互：  browser_action（click/double_click/right_click/scroll/type/press_key）/
//                browser_wait
// 移植自 device/extension/src/lib/tools/browser.ts：本插件没有 debugger/CDP 权限，
// 点击/输入/按键都是合成事件（非 CDP trusted 事件）。真正的扫描/交互逻辑在
// content/observe.js 的 window.__hsObserve 里（含同源 iframe / Shadow DOM / 媒体识别），
// 这里只是薄封装 + 旧标签页补注入。

// ── content/observe.js 调用封装（含旧标签页补注入兜底）───────────────────────
async function callObserveMethod(tabId, method, callArgs) {
    const invoke = () => chrome.scripting.executeScript({
        target: { tabId },
        args: [method, callArgs],
        func: (methodName, methodArgs) => {
            if (!window.__hsObserve || typeof window.__hsObserve[methodName] !== 'function') {
                return { __hsObserveMissing: true };
            }
            return window.__hsObserve[methodName].apply(window.__hsObserve, methodArgs);
        }
    });

    let results = await invoke();
    let value = Array.isArray(results) && results[0] ? results[0].result : undefined;

    if (value && value.__hsObserveMissing === true) {
        // 扩展安装/刷新之前就打开的标签页不会自动获得 manifest 声明的内容脚本，这里补注入一次再重试。
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content/observe.js'] }).catch(() => {});
        results = await invoke();
        value = Array.isArray(results) && results[0] ? results[0].result : undefined;
    }

    if (value && value.__hsObserveMissing === true) {
        throw new Error('页面观察/交互脚本不可用（可能是浏览器内部页面、扩展页面或受限页面）');
    }

    return value;
}

// ── 导航与搜索：browser_tab ───────────────────────────────────────────────
function tabSummary(tab) {
    return { id: tab.id, url: tab.url, title: tab.title, active: !!tab.active, windowId: tab.windowId };
}

async function focusTab(tabId) {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId !== undefined) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
    return chrome.tabs.get(tabId);
}

function tabIdArg(args = {}) {
    const raw = args.tab_id ?? args.tabId ?? args.id;
    const n = Number(raw);
    return Number.isFinite(n) ? n : NaN;
}

async function resolveTargetTabForAction(args = {}) {
    const requested = tabIdArg(args);
    if (Number.isFinite(requested) && requested > 0) return chrome.tabs.get(requested);
    const active = await getActiveTab();
    if (!active) throw new Error('未找到可操作的当前标签页');
    return active;
}

async function toolBrowserTabList() {
    const tabs = await chrome.tabs.query({});
    const activeTab = tabs.find((t) => t.active) || null;
    return {
        success: true,
        action: 'list',
        count: tabs.length,
        activeTabId: activeTab ? activeTab.id : null,
        activeTab: activeTab ? tabSummary(activeTab) : null,
        tabs: tabs.map(tabSummary)
    };
}

async function toolBrowserTabSwitch(args = {}) {
    const tabId = tabIdArg(args);
    if (!Number.isFinite(tabId) || tabId <= 0) throw new Error('switch 需要提供 tab_id');
    const refreshed = await focusTab(tabId);
    return { success: true, action: 'switch', ...tabSummary(refreshed) };
}

// 导航成功回执附 cardStep：与 browser_action 的 cardStep 回执一致，探索路径可直接固化进卡片 steps。
function navigateCardStep(href) {
    let host = '';
    try { host = new URL(href).hostname; } catch (_error) {}
    return { name: `打开 ${host || '网址'}`, type: 'navigate', url: href };
}

async function toolBrowserTabReplace(args = {}) {
    const href = normalizeTargetUrl(args.url);
    if (!href) throw new Error('replace 需要提供 url');
    let tab;
    try {
        tab = await resolveTargetTabForAction(args);
    } catch (_error) {
        const created = await chrome.tabs.create({ url: href, active: true });
        await waitForTabComplete(created.id, 20000).catch(() => {});
        const refreshed = await chrome.tabs.get(created.id);
        return { success: true, action: 'replace', ...tabSummary(refreshed), cardStep: navigateCardStep(href), note: '未找到可用的目标标签页，已在新标签页打开。' };
    }
    const currentUrl = normalizeTargetUrl(String(tab.url || '').trim());
    if (currentUrl === href) {
        await focusTab(tab.id).catch(() => {});
        const refreshed = await chrome.tabs.get(tab.id);
        return { success: true, action: 'replace', ...tabSummary(refreshed), cardStep: navigateCardStep(href), note: '已在目标网页，无需跳转' };
    }
    await chrome.tabs.update(tab.id, { url: href, active: true });
    await focusTab(tab.id);
    await waitForTabComplete(tab.id, 20000).catch(() => {});
    const refreshed = await chrome.tabs.get(tab.id);
    return { success: true, action: 'replace', ...tabSummary(refreshed), cardStep: navigateCardStep(href) };
}

async function toolBrowserTabNavigate(args = {}) {
    const href = normalizeTargetUrl(args.url);
    if (!href) throw new Error('navigate 需要提供 url');
    const tab = await chrome.tabs.create({ url: href, active: true });
    await focusTab(tab.id);
    await waitForTabComplete(tab.id, 20000).catch(() => {});
    const refreshed = await chrome.tabs.get(tab.id);
    return { success: true, action: 'navigate', ...tabSummary(refreshed), cardStep: navigateCardStep(href) };
}

async function toolBrowserTabClose(args = {}) {
    const requested = tabIdArg(args);
    let tabId = requested;
    if (!Number.isFinite(tabId) || tabId <= 0) {
        const active = await getActiveTab();
        if (!active) throw new Error('未找到可关闭的标签页');
        tabId = active.id;
    }
    const closing = await chrome.tabs.get(tabId);
    await chrome.tabs.remove(tabId);
    return { success: true, action: 'close', ...tabSummary(closing) };
}

async function toolBrowserTabBack(args = {}) {
    const tab = await resolveTargetTabForAction(args);
    await focusTab(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => history.back() });
    await sleep(250);
    await waitForTabComplete(tab.id, 15000).catch(() => {});
    const refreshed = await chrome.tabs.get(tab.id);
    return { success: true, action: 'back', ...tabSummary(refreshed) };
}

async function toolBrowserTabForward(args = {}) {
    const tab = await resolveTargetTabForAction(args);
    await focusTab(tab.id);
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => history.forward() });
    await sleep(250);
    await waitForTabComplete(tab.id, 15000).catch(() => {});
    const refreshed = await chrome.tabs.get(tab.id);
    return { success: true, action: 'forward', ...tabSummary(refreshed) };
}

const BROWSER_TAB_ACTIONS = ['list', 'switch', 'replace', 'navigate', 'close', 'back', 'forward'];

function normalizeBrowserTabAction(args = {}) {
    const action = String(args.action || '').trim();
    if (action === 'open' || action === 'activate') return action === 'open' ? 'navigate' : 'switch';
    if (action === 'navigate' && (args.replace_current === true || args.current_tab === true || args.same_tab === true)) {
        return 'replace';
    }
    return action;
}

async function toolBrowserTab(args = {}) {
    const action = normalizeBrowserTabAction(args);
    switch (action) {
        case 'list': return toolBrowserTabList();
        case 'switch': return toolBrowserTabSwitch(args);
        case 'replace': return toolBrowserTabReplace(args);
        case 'navigate': return toolBrowserTabNavigate(args);
        case 'close': return toolBrowserTabClose(args);
        case 'back': return toolBrowserTabBack(args);
        case 'forward': return toolBrowserTabForward(args);
        default:
            throw new Error(`browser_tab: 未知 action「${action || '(空)'}」，可选 ${BROWSER_TAB_ACTIONS.join(' / ')}`);
    }
}

// ── 页面观察：browser_observe ─────────────────────────────────────────────
async function toolBrowserObserve(args = {}) {
    const tab = await getActiveTab();
    if (!tab) throw new Error('未找到可观察的当前标签页');
    return callObserveMethod(tab.id, 'scan', [args]);
}

// ── 页面交互：browser_action ──────────────────────────────────────────────
const BROWSER_ACTION_KINDS = ['click', 'double_click', 'right_click', 'scroll', 'type', 'press_key'];

async function toolBrowserAction(args = {}) {
    const tab = await getActiveTab();
    if (!tab) throw new Error('未找到可操作的当前标签页');
    const action = String(args.action || '').trim();
    switch (action) {
        case 'click':        return callObserveMethod(tab.id, 'click', [args, 'left']);
        case 'double_click': return callObserveMethod(tab.id, 'click', [args, 'double']);
        case 'right_click':  return callObserveMethod(tab.id, 'click', [args, 'right']);
        case 'scroll':       return callObserveMethod(tab.id, 'scroll', [args]);
        case 'type':         return callObserveMethod(tab.id, 'type', [args]);
        case 'press_key':    return callObserveMethod(tab.id, 'pressKey', [args]);
        default:
            throw new Error(`browser_action: 未知 action「${action || '(空)'}」，可选 ${BROWSER_ACTION_KINDS.join(' / ')}`);
    }
}

// ── 页面交互：browser_wait ────────────────────────────────────────────────
async function toolBrowserWait(args = {}) {
    const tab = await getActiveTab();
    if (!tab) throw new Error('未找到可等待的当前标签页');
    return callObserveMethod(tab.id, 'wait', [args]);
}
