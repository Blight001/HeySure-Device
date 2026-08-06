'use strict';
const ELECTRON_EXTENSION_COMPAT_BODY = `(() => {
const installedKey = '__aiFreeElectronExtensionCompatInstalled';
if (globalThis[installedKey]) return;
try {
  Object.defineProperty(globalThis, installedKey, { value: true, configurable: true });
} catch (_) {
  globalThis[installedKey] = true;
}

const chromeApi = globalThis.chrome || globalThis.browser;
if (!chromeApi) return;

const tabsApi = chromeApi.tabs || null, runtimeApi = chromeApi.runtime || null;
const nativeTabsQuery = tabsApi && typeof tabsApi.query === 'function' ? tabsApi.query.bind(tabsApi) : null;
const nativeTabsUpdate = tabsApi && typeof tabsApi.update === 'function' ? tabsApi.update.bind(tabsApi) : null;
const WINDOW_ID_NONE = -1, WINDOW_ID_CURRENT = -2;

const isThenable = (value) => value && typeof value.then === 'function';
const makeEvent = () => {
  const listeners = new Set();
  return {
    addListener(listener) { if (typeof listener === 'function') listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    hasListener(listener) { return listeners.has(listener); },
    hasListeners() { return listeners.size > 0; },
    dispatch(...args) {
      for (const listener of Array.from(listeners)) {
        try { listener(...args); } catch (_) {}
      }
    },
  };
};

function callChrome(api, method, args) {
  if (!api || typeof api[method] !== 'function') {
    return Promise.reject(new Error('chrome.' + method + ' is unavailable'));
  }

  try {
    const result = api[method](...(args || []));
    if (isThenable(result)) return result;
    if (result !== undefined) return Promise.resolve(result);
  } catch (_) {
    // Retry with callback form below.
  }

  return new Promise((resolve, reject) => {
    try {
      api[method](...(args || []), (value) => {
        const lastError = runtimeApi && runtimeApi.lastError;
        if (lastError && lastError.message) {
          reject(new Error(lastError.message));
        } else {
          resolve(value);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

function withCallback(promise, callback) {
  if (typeof callback === 'function') {
    promise.then(
      (value) => callback(value),
      () => callback(undefined),
    );
    return undefined;
  }
  return promise;
}

function callNative(method, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const callback = (value) => {
      if (settled) return;
      settled = true;
      const lastError = runtimeApi && runtimeApi.lastError;
      lastError && lastError.message ? reject(new Error(lastError.message)) : resolve(value);
    };
    try {
      const result = method(...args, callback);
      if (isThenable(result)) {
        result.then(callback, reject);
      } else if (result !== undefined && !settled) {
        settled = true;
        resolve(result);
      }
    } catch (error) {
      reject(error);
    }
  });
}

// Normalize Chrome query/update options to Electron's documented subset.
// This also makes active/currentWindow calls deterministic for the current
// Electron session.
if (tabsApi && nativeTabsQuery) {
  tabsApi.query = (queryInfo, callback) => {
    const source = queryInfo && typeof queryInfo === 'object' ? queryInfo : {};
    const supported = {};
    for (const key of ['url', 'title', 'audible', 'active', 'muted']) {
      if (source[key] !== undefined) supported[key] = source[key];
    }
    const promise = callNative(nativeTabsQuery, [supported]).then((tabs) => {
      const list = Array.isArray(tabs) ? tabs : [];
      return list.map((tab, index) => ({
        ...tab,
        active: source.active === false ? !!tab.active : (index === 0 || !!tab.active),
        windowId: Number.isFinite(Number(tab && tab.windowId)) ? Number(tab.windowId) : 1,
      }));
    });
    return withCallback(promise, callback);
  };
}

if (tabsApi && nativeTabsUpdate) {
  tabsApi.update = (tabId, updateProperties, callback) => {
    if (typeof updateProperties === 'function') {
      callback = updateProperties;
      updateProperties = tabId;
      tabId = undefined;
    }
    const source = updateProperties && typeof updateProperties === 'object' ? updateProperties : {};
    const supported = {};
    if (source.url !== undefined) supported.url = source.url;
    if (source.muted !== undefined) supported.muted = source.muted;
    const args = tabId === undefined ? [supported] : [tabId, supported];
    const promise = Object.keys(supported).length
      ? callNative(nativeTabsUpdate, args)
      : (tabId === undefined ? queryTabs({ active: true }).then((tabs) => tabs[0]) : getTab(tabId));
    return withCallback(promise, callback);
  };
}

function tabWindowId(tab) {
  const id = Number(tab && tab.windowId);
  return Number.isFinite(id) ? id : 1;
}

async function queryTabs(queryInfo) {
  if (!tabsApi || typeof tabsApi.query !== 'function') return [];
  try {
    const tabs = await callChrome(tabsApi, 'query', [queryInfo || {}]);
    return Array.isArray(tabs) ? tabs : [];
  } catch (_) {
    return [];
  }
}

async function getTab(tabId) {
  if (!tabsApi || typeof tabsApi.get !== 'function') return null;
  try {
    return await callChrome(tabsApi, 'get', [tabId]);
  } catch (_) {
    return null;
  }
}

async function collectWindows(queryInfo) {
  const info = queryInfo && typeof queryInfo === 'object' ? queryInfo : {};
  const allTabs = await queryTabs({});
  const activeLastFocused = await queryTabs({ active: true, lastFocusedWindow: true });
  const activeAny = allTabs.filter((tab) => tab && tab.active);
  const focusedWindowId = tabWindowId(activeLastFocused[0] || activeAny[0] || allTabs[0]);
  const byId = new Map();

  for (const tab of allTabs) {
    const id = tabWindowId(tab);
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        focused: id === focusedWindowId,
        incognito: !!tab.incognito,
        type: 'normal',
        state: 'normal',
        alwaysOnTop: false,
        tabs: [],
      });
    }
    byId.get(id).tabs.push(tab);
  }

  if (byId.size === 0) {
    byId.set(focusedWindowId || 1, {
      id: focusedWindowId || 1,
      focused: true,
      incognito: false,
      type: 'normal',
      state: 'normal',
      alwaysOnTop: false,
      tabs: [],
    });
  }

  let windows = Array.from(byId.values()).map((win) => ({
    ...win,
    tabs: win.tabs.slice().sort((a, b) => Number(a.index || 0) - Number(b.index || 0)),
  }));

  if (Array.isArray(info.windowTypes) && info.windowTypes.length) {
    const allowed = new Set(info.windowTypes.map((type) => String(type || '')));
    windows = windows.filter((win) => allowed.has(win.type));
  }

  if (info.populate !== true) {
    windows = windows.map(({ tabs, ...win }) => win);
  }

  return windows;
}

async function getWindow(windowId, queryInfo) {
  let id = Number(windowId);
  const windows = await collectWindows({ ...(queryInfo || {}), populate: !!(queryInfo && queryInfo.populate) });
  if (id === WINDOW_ID_CURRENT || !Number.isFinite(id)) {
    return windows.find((win) => win.focused) || windows[0] || null;
  }
  return windows.find((win) => Number(win.id) === id) || null;
}

const windowsApi = chromeApi.windows || {};
if (!chromeApi.windows) {
  try {
    Object.defineProperty(chromeApi, 'windows', {
      value: windowsApi,
      configurable: true,
      enumerable: true,
    });
  } catch (_) {
    chromeApi.windows = windowsApi;
  }
}

windowsApi.WINDOW_ID_NONE = windowsApi.WINDOW_ID_NONE ?? WINDOW_ID_NONE;
windowsApi.WINDOW_ID_CURRENT = windowsApi.WINDOW_ID_CURRENT ?? WINDOW_ID_CURRENT;
windowsApi.onCreated = windowsApi.onCreated || makeEvent();
windowsApi.onRemoved = windowsApi.onRemoved || makeEvent();
windowsApi.onFocusChanged = windowsApi.onFocusChanged || makeEvent();

if (typeof windowsApi.getAll !== 'function') {
  windowsApi.getAll = (queryInfo, callback) => withCallback(collectWindows(queryInfo), callback);
}

if (typeof windowsApi.get !== 'function') {
  windowsApi.get = (windowId, queryInfo, callback) => {
    if (typeof queryInfo === 'function') {
      callback = queryInfo;
      queryInfo = {};
    }
    return withCallback(getWindow(windowId, queryInfo || {}), callback);
  };
}

if (typeof windowsApi.getCurrent !== 'function') {
  windowsApi.getCurrent = (queryInfo, callback) => {
    if (typeof queryInfo === 'function') {
      callback = queryInfo;
      queryInfo = {};
    }
    return withCallback(getWindow(WINDOW_ID_CURRENT, queryInfo || {}), callback);
  };
}

if (typeof windowsApi.getLastFocused !== 'function') {
  windowsApi.getLastFocused = (queryInfo, callback) => {
    if (typeof queryInfo === 'function') {
      callback = queryInfo;
      queryInfo = {};
    }
    return withCallback(getWindow(WINDOW_ID_CURRENT, queryInfo || {}), callback);
  };
}

if (typeof windowsApi.update !== 'function') {
  windowsApi.update = (windowId, updateInfo, callback) => {
    const promise = (async () => {
      const win = await getWindow(windowId, { populate: true });
      if (updateInfo && updateInfo.focused === true && tabsApi && typeof tabsApi.update === 'function') {
        const activeTab = (win && win.tabs || []).find((tab) => tab && tab.active) || (win && win.tabs || [])[0];
        if (activeTab && activeTab.id !== undefined) {
          try { await callChrome(tabsApi, 'update', [activeTab.id, { active: true }]); } catch (_) {}
        }
      }
      const next = await getWindow(windowId, {});
      return next || (win ? (({ tabs, ...rest }) => rest)(win) : null);
    })();
    return withCallback(promise, callback);
  };
}

if (typeof windowsApi.create !== 'function') {
  windowsApi.create = (createData, callback) => {
    const promise = (async () => {
      if (!tabsApi || typeof tabsApi.create !== 'function') {
        throw new Error('chrome.tabs.create is unavailable');
      }
      const data = createData && typeof createData === 'object' ? createData : {};
      const url = Array.isArray(data.url) ? data.url[0] : data.url;
      const tab = await callChrome(tabsApi, 'create', [{
        url: url || undefined,
        active: data.focused !== false,
      }]);
      return await getWindow(tabWindowId(tab), { populate: true });
    })();
    return withCallback(promise, callback);
  };
}

if (typeof windowsApi.remove !== 'function') {
  windowsApi.remove = (windowId, callback) => {
    const promise = (async () => {
      if (!tabsApi || typeof tabsApi.remove !== 'function') return undefined;
      const win = await getWindow(windowId, { populate: true });
      const ids = (win && win.tabs || [])
        .map((tab) => tab && tab.id)
        .filter((id) => id !== undefined && id !== null);
      if (ids.length) {
        try { await callChrome(tabsApi, 'remove', [ids]); } catch (_) {}
      }
      return undefined;
    })();
    return withCallback(promise, callback);
  };
}

// Electron intentionally implements only a subset of chrome.tabs.  Complete
// the common API surface in one place so extensions do not need Electron
// branches scattered through their business code. An internal view session has
// one app-managed tab, therefore create/remove degrade to replacing/blanking
// that view while preserving Chrome-compatible return values.
if (tabsApi) {
  tabsApi.onCreated = tabsApi.onCreated || makeEvent();
  tabsApi.onRemoved = tabsApi.onRemoved || makeEvent();
  tabsApi.onUpdated = tabsApi.onUpdated || makeEvent();
  tabsApi.onActivated = tabsApi.onActivated || makeEvent();

  if (typeof tabsApi.get !== 'function') {
    tabsApi.get = (tabId, callback) => {
      const promise = queryTabs({}).then((tabs) => {
        const found = tabs.find((tab) => Number(tab && tab.id) === Number(tabId));
        if (!found) throw new Error('No tab with id: ' + tabId);
        return found;
      });
      return withCallback(promise, callback);
    };
  }

  if (typeof tabsApi.create !== 'function') {
    tabsApi.create = (createProperties, callback) => {
      const promise = (async () => {
        const data = createProperties && typeof createProperties === 'object' ? createProperties : {};
        const before = await queryTabs({});
        const current = before.find((tab) => {
          const tabUrl = String(tab && tab.url || '').toLowerCase();
          return tabUrl.startsWith('http://') || tabUrl.startsWith('https://');
        })
          || (await queryTabs({ active: true }))[0]
          || before[0];
        if (!current) throw new Error('No Electron tab is available');
        const url = String(data.url || 'about:blank');
        const knownIds = new Set(before.map((tab) => Number(tab && tab.id)));

        // The app's window-open handler turns this into a real
        // managed tab. Poll chrome.tabs so the extension receives its ID.
        if (chromeApi.scripting && typeof chromeApi.scripting.executeScript === 'function') {
          try {
            await chromeApi.scripting.executeScript({
              target: { tabId: current.id },
              args: [url],
              func: (targetUrl) => { window.open(targetUrl, '_blank', 'noopener'); },
            });
            for (let attempt = 0; attempt < 30; attempt += 1) {
              await new Promise((resolve) => setTimeout(resolve, 100));
              const after = await queryTabs({});
              const created = after.find((tab) => !knownIds.has(Number(tab && tab.id)))
                || after.find((tab) => String(tab && tab.url || '') === url && Number(tab.id) !== Number(current.id));
              if (created) return { ...created, active: data.active !== false };
            }
          } catch (_) {}
        }

        // Last-resort behavior for pages that block window.open: navigation
        // still succeeds in the current real page instead of targeting the
        // extension's offscreen document.
        if (typeof tabsApi.update === 'function') {
          await callChrome(tabsApi, 'update', [current.id, { url }]);
        }
        return await getTab(current.id) || { ...current, url, active: true };
      })();
      return withCallback(promise, callback);
    };
  }

  if (typeof tabsApi.remove !== 'function') {
    tabsApi.remove = (tabIds, callback) => {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      const promise = Promise.all(ids.map(async (id) => {
        if (typeof tabsApi.update === 'function') {
          await callChrome(tabsApi, 'update', [id, { url: 'about:blank' }]);
        }
      })).then(() => undefined);
      return withCallback(promise, callback);
    };
  }
}

// MV3 storage.session is absent in Electron. Local storage has the same
// asynchronous contract and is a durable, deterministic fallback.
if (chromeApi.storage && !chromeApi.storage.session && chromeApi.storage.local) {
  try { chromeApi.storage.session = chromeApi.storage.local; } catch (_) {}
}

// Badge APIs are cosmetic; missing methods must never break an automation
// socket or MCP result path.
const actionApi = chromeApi.action || {};
if (!chromeApi.action) {
  try { chromeApi.action = actionApi; } catch (_) {}
}
for (const method of ['setBadgeText', 'setBadgeBackgroundColor', 'setTitle', 'setIcon']) {
  if (typeof actionApi[method] !== 'function') actionApi[method] = () => Promise.resolve();
}

// Keep MV3 keepalive code operational. Timers are scoped to the extension
// worker; recreating an alarm with the same name replaces the previous one.
const alarmsApi = chromeApi.alarms || {};
const alarmTimers = new Map();
if (!chromeApi.alarms) {
  try { chromeApi.alarms = alarmsApi; } catch (_) {}
}
alarmsApi.onAlarm = alarmsApi.onAlarm || makeEvent();
if (typeof alarmsApi.create !== 'function') {
  alarmsApi.create = (name, info) => {
    if (typeof name !== 'string') { info = name; name = ''; }
    const alarmName = String(name || '');
    const data = info && typeof info === 'object' ? info : {};
    const old = alarmTimers.get(alarmName);
    if (old) clearTimeout(old);
    const delay = Math.max(1, Number(data.delayInMinutes || data.periodInMinutes || 1)) * 60000;
    const tick = () => {
      alarmsApi.onAlarm.dispatch({ name: alarmName, scheduledTime: Date.now(), periodInMinutes: data.periodInMinutes });
      if (data.periodInMinutes) alarmTimers.set(alarmName, setTimeout(tick, delay));
      else alarmTimers.delete(alarmName);
    };
    alarmTimers.set(alarmName, setTimeout(tick, delay));
    return Promise.resolve();
  };
}
if (typeof alarmsApi.clear !== 'function') {
  alarmsApi.clear = (name, callback) => {
    const timer = alarmTimers.get(String(name || ''));
    if (timer) clearTimeout(timer);
    const removed = alarmTimers.delete(String(name || ''));
    return withCallback(Promise.resolve(removed), callback);
  };
}

// Downloads are implemented through the active page. This preserves the
// app's Session 'will-download' handling and works for data/blob/http URLs.
const downloadsApi = chromeApi.downloads || {};
let nextDownloadId = 1;
if (!chromeApi.downloads) {
  try { chromeApi.downloads = downloadsApi; } catch (_) {}
}
if (typeof downloadsApi.download !== 'function') {
  downloadsApi.download = (options, callback) => {
    const promise = (async () => {
      const data = options && typeof options === 'object' ? options : {};
      if (!data.url) throw new Error('downloads.download requires url');
      const tab = (await queryTabs({ active: true }))[0] || (await queryTabs({}))[0];
      if (!tab || !chromeApi.scripting || typeof chromeApi.scripting.executeScript !== 'function') {
        throw new Error('No page is available for the Electron download');
      }
      await chromeApi.scripting.executeScript({
        target: { tabId: tab.id },
        args: [data.url, data.filename || ''],
        func: (url, filename) => {
          const anchor = document.createElement('a');
          anchor.href = url;
          if (filename) anchor.download = filename;
          anchor.style.display = 'none';
          document.documentElement.appendChild(anchor);
          anchor.click();
          anchor.remove();
        },
      });
      return nextDownloadId++;
    })();
    return withCallback(promise, callback);
  };
}
})();
`;
function buildElectronExtensionCompatShim(marker) {
  return `/* ${marker} */${ELECTRON_EXTENSION_COMPAT_BODY}`;
}
module.exports = { buildElectronExtensionCompatShim };
