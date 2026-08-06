'use strict';

const fs = require('fs');
const {
  collectClashMiniProxyDelays,
  fetchClashMiniProxyNames,
  getClashMiniManualGroupName,
  getClashMiniRuntimeRoot,
  getClashMiniStatus,
  invokeClashMiniControl,
  normalizeProbeTimeout,
  normalizeProbeUrl,
  readClashProbeSettings,
  waitForClashMiniControlApi,
} = require('./clash-mini-core');

function resolveLatencyConcurrency(totalCount, requestedConcurrency) {
  const total = Math.max(1, Math.floor(Number(totalCount) || 0));
  const defaultConcurrency = total >= 80 ? 8 : total >= 24 ? 6 : total >= 12 ? 4 : 3;
  const requested = Number(requestedConcurrency);
  const base = Number.isFinite(requested) && requested > 0 ? Math.floor(requested) : defaultConcurrency;
  return Math.max(1, Math.min(total, 12, base));
}

function markSelectedProxy(proxies, current) {
  const selectedName = String(current || '').trim();
  return proxies.map((item) => ({ ...item, selected: item.name === selectedName }));
}

function createUnmeasuredProxies(names, current, delayText = '待测速') {
  const selectedName = String(current || '').trim();
  return names.map((name) => ({ name, delay: null, delayText, ok: false, selected: name === selectedName }));
}

async function readDelayHistory(coreDir, names) {
  const response = await invokeClashMiniControl(coreDir, 'get', '/proxies', { timeoutMs: 5000 });
  const proxies = response && typeof response.proxies === 'object' ? response.proxies : {};
  return names.map((name) => {
    const history = Array.isArray(proxies[name]?.history) ? proxies[name].history : [];
    const delay = Number(history.at(-1)?.delay);
    const hasDelay = Number.isFinite(delay) && delay > 0;
    return { name, delay: hasDelay ? delay : null, delayText: hasDelay ? `${Math.round(delay)}ms` : '待测速', ok: hasDelay };
  });
}

async function resolveProxyGroupData(coreDir, options) {
  const groupName = String(options.groupName || getClashMiniManualGroupName(coreDir)).trim() || '节点选择';
  const apiReady = await waitForClashMiniControlApi(coreDir, 15000);
  if (!apiReady) return { error: { ok: false, error: 'Clash Mini 控制接口未就绪', running: true, groupName, names: [], current: '' } };
  const groupInfo = await fetchClashMiniProxyNames(coreDir, groupName);
  const candidates = Array.isArray(options.names) && options.names.length ? options.names : groupInfo.names;
  const names = Array.from(new Set(candidates.map((item) => String(item || '').trim()).filter(Boolean)));
  return { groupName, groupInfo, names };
}

async function loadProxyDelayOptions(coreDir, names, current, options) {
  const settings = /** @type {Record<string, any>} */ (readClashProbeSettings() || {});
  const latencyUrl = normalizeProbeUrl(options.url || settings.latencyUrl, 'https://www.gstatic.com/generate_204');
  const timeout = normalizeProbeTimeout(options.timeout || settings.latencyTimeoutMs, 5000);
  let history = createUnmeasuredProxies(names, current);
  try {
    history = await readDelayHistory(coreDir, names);
  } catch (_) {}
  if (options.includeDelays === false) return { latencyUrl, timeout, proxies: markSelectedProxy(history, current) };
  const missingNames = history.filter((item) => item.delay == null).map((item) => item.name);
  if (missingNames.length === 0) return { latencyUrl, timeout, proxies: markSelectedProxy(history, current) };
  const concurrency = resolveLatencyConcurrency(missingNames.length, options.concurrency);
  const measured = await collectClashMiniProxyDelays(coreDir, missingNames, latencyUrl, timeout, concurrency);
  const measuredByName = new Map(measured.map((item) => [item.name, item]));
  return {
    latencyUrl,
    timeout,
    proxies: markSelectedProxy(history.map((item) => measuredByName.get(item.name) || item), current),
  };
}

async function getClashMiniProxyGroupOptions(_ui, options = {}) {
  const status = getClashMiniStatus();
  const fallbackGroup = String(options.groupName || getClashMiniManualGroupName(getClashMiniRuntimeRoot())).trim() || '节点选择';
  if (!status.running) return { ok: false, error: 'Clash Mini 未运行', running: false, groupName: fallbackGroup, names: [], current: '' };
  const coreDir = status.coreDir || getClashMiniRuntimeRoot();
  if (!coreDir || !fs.existsSync(coreDir)) return { ok: false, error: 'Clash Mini 运行目录不存在', running: false, names: [], current: '' };
  const groupData = await resolveProxyGroupData(coreDir, options);
  if (groupData.error) return groupData.error;
  const { groupName, groupInfo, names } = groupData;
  const delayOptions = await loadProxyDelayOptions(coreDir, names, groupInfo.current, options);
  return {
    ok: true, running: true, groupName, current: groupInfo.current || '', names,
    url: delayOptions.latencyUrl, timeout: delayOptions.timeout, proxies: delayOptions.proxies,
  };
}

module.exports = { getClashMiniProxyGroupOptions, resolveLatencyConcurrency };
