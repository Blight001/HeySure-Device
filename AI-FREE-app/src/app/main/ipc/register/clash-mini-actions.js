const fs = require('fs');
const {
  emitClashMiniLog,
  fetchClashMiniProxyNames,
  getClashMiniManualGroupName,
  getClashMiniRuntimeRoot,
  getClashMiniStatus,
  normalizeProbeTimeout,
  normalizeProbeUrl,
  probeClashMiniGroupDelay,
  probeClashMiniProxyDelay,
  readClashProbeSettings,
  startClashMiniProcess,
  waitForClashMiniControlApi,
  invokeClashMiniControl,
} = require('./clash-mini-core');
const {
  getClashMiniProxyGroupOptions,
  resolveLatencyConcurrency,
} = require('./clash-mini-proxy-options');

// 读取一批节点当前最新一条 delay history（时间戳 + 延迟）。
// 批量测速期间靠对比时间戳变化识别“该节点已出结果”，实现增量进度。
async function readLatestDelayHistorySnapshot(coreDir, names) {
  const response = await invokeClashMiniControl(coreDir, 'get', '/proxies', { timeoutMs: 5000 });
  const proxies = response && typeof response === 'object' && response.proxies && typeof response.proxies === 'object'
    ? response.proxies
    : {};
  const snapshot = new Map();
  names.forEach((name) => {
    const history = Array.isArray(proxies[name]?.history) ? proxies[name].history : [];
    const latest = history.length > 0 ? history[history.length - 1] : null;
    snapshot.set(name, {
      time: String(latest?.time || ''),
      delay: Number(latest?.delay),
    });
  });
  return snapshot;
}

function latencyHistoryChanged(current, before) {
  return Boolean(current && current.time && current.time !== before?.time);
}

function processLatencyHistoryEntry(context, name, index, currentBest) {
  const { snapshot, baseline, reported, reportProgress } = context;
  if (reported.has(name)) return currentBest;
  const current = snapshot.get(name);
  const before = baseline.get(name);
  if (!latencyHistoryChanged(current, before)) return currentBest;
    reported.add(name);
    const delay = Number(current.delay);
    const normalizedDelay = Number.isFinite(delay) && delay > 0 ? delay : null;
    const best = normalizedDelay != null && (!currentBest || normalizedDelay < currentBest.delay)
      ? { name, delay: normalizedDelay }
      : currentBest;
    reportProgress({
      phase: 'probe', index, completed: reported.size, name, delay: normalizedDelay,
      ...(normalizedDelay == null ? { error: '超时' } : {}),
      bestName: best?.name || '', bestDelay: best?.delay || null,
    });
  return best;
}

function reportNewLatencyHistory(context) {
  let best = context.currentBest;
  for (const [index, name] of context.uniqueNames.entries()) {
    best = processLatencyHistoryEntry(context, name, index, best);
  }
  return best;
}

// 批量路径：一次 /group/{组名}/delay 让内核并发测完整组，外部只等结果。
// 期间每 800ms 轮询一次本地控制接口的 history，把已出结果的节点增量推给界面。
// 成功返回 entries 数组；端点不可用（老内核 404 等）返回 null，由调用方回退。
async function runGroupBatchLatencyTest({ coreDir, groupName, uniqueNames, latencyUrl, timeout, reportProgress, ui }) {
  let baseline = null;
  try {
    baseline = await readLatestDelayHistorySnapshot(coreDir, uniqueNames);
  } catch (_) {
    // 基线读取失败则放弃增量进度（否则会把旧测速记录误报成新结果），批量测速本身不受影响。
    baseline = null;
  }

  const batchPromise = probeClashMiniGroupDelay(coreDir, groupName, latencyUrl, timeout);

  let pollingActive = baseline !== null;
  const reported = new Set();
  let best = null;
  const poller = (async () => {
    while (pollingActive) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (!pollingActive) break;
      let snapshot = null;
      try {
        snapshot = await readLatestDelayHistorySnapshot(coreDir, uniqueNames);
      } catch (_) {
        break;
      }
      best = reportNewLatencyHistory({ snapshot, baseline, uniqueNames, reported, currentBest: best, reportProgress });
    }
  })();

  let delayMap = null;
  try {
    delayMap = await batchPromise;
  } catch (error) {
    pollingActive = false;
    await poller.catch(() => {});
    emitClashMiniLog(ui, 'warning', `批量测速接口不可用，回退逐节点测速: ${error?.message || error}`);
    return null;
  }
  pollingActive = false;
  await poller.catch(() => {});

  return uniqueNames.map((name) => {
    const delay = Number(delayMap[name]);
    const normalizedDelay = Number.isFinite(delay) && delay > 0 ? delay : null;
    return normalizedDelay != null
      ? { name, delay: normalizedDelay }
      : { name, delay: null, error: '超时' };
  });
}

async function probeLatencyNode(coreDir, name, latencyUrl, timeout) {
  try {
    const probe = await probeClashMiniProxyDelay(coreDir, name, latencyUrl, timeout);
    const delay = Number(probe.delay);
    return { entry: { name, delay: Number.isFinite(delay) ? delay : null } };
  } catch (error) {
    const message = error?.message || String(error);
    return { entry: { name, delay: null, error: message }, error: message };
  }
}

function updateLatencyBest(best, entry) {
  if (entry.delay == null || entry.delay <= 0) return best;
  return !best || entry.delay < best.delay ? { name: entry.name, delay: entry.delay } : best;
}

// 回退路径：老内核不支持组批量测速时，沿用外部 worker 池逐节点探测。
async function runPerNodeLatencyTest({ coreDir, uniqueNames, latencyUrl, timeout, concurrency, reportProgress }) {
  const entries = new Array(uniqueNames.length);
  let cursor = 0;
  let completed = 0;
  let best = null;

  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < uniqueNames.length) {
      const currentIndex = cursor++;
      const name = uniqueNames[currentIndex];
      const outcome = await probeLatencyNode(coreDir, name, latencyUrl, timeout);
      entries[currentIndex] = outcome.entry;
      completed += 1;
      best = updateLatencyBest(best, outcome.entry);
      reportProgress({
        phase: 'probe', index: currentIndex, completed, name, delay: outcome.entry.delay,
        ...(outcome.error ? { error: outcome.error } : {}),
        bestName: best?.name || '', bestDelay: best?.delay || null,
      });
    }
  });

  await Promise.all(workers);
  return entries;
}

async function ensureClashMiniRunning(ui) {
  let status = getClashMiniStatus();
  if (!status.running) {
    emitClashMiniLog(ui, 'info', '最低延时测试需要先启动 Clash Mini，正在尝试启动');
    const startResult = await startClashMiniProcess(ui);
    if (!startResult?.ok) return { error: startResult };
    status = getClashMiniStatus();
  }
  const coreDir = status.coreDir || getClashMiniRuntimeRoot();
  if (!coreDir || !fs.existsSync(coreDir)) return { error: { ok: false, error: 'Clash Mini 运行目录不存在' } };
  return { coreDir };
}

function resolveLatencySettings(coreDir, options) {
  const settings = /** @type {Record<string, any>} */ (readClashProbeSettings() || {});
  return {
    latencyUrl: normalizeProbeUrl(options.url || settings.latencyUrl, 'https://www.gstatic.com/generate_204'),
    timeout: normalizeProbeTimeout(options.timeout || settings.latencyTimeoutMs, 5000),
    groupName: String(options.groupName || getClashMiniManualGroupName(coreDir)).trim() || '节点选择',
  };
}

async function resolveLatencyCandidates(coreDir, groupName, options) {
  const groupInfo = await fetchClashMiniProxyNames(coreDir, groupName);
  const candidates = Array.isArray(options.names) && options.names.length ? options.names : groupInfo.names;
  return Array.from(new Set(candidates.map((item) => String(item || '').trim()).filter(Boolean)));
}

function createLatencyProgressReporter(ui, context, enabled) {
  return (payload = {}) => {
    if (!enabled) return;
    try {
      const selection = context.selectBest === false
        ? { ...payload, bestName: '', bestDelay: null }
        : payload;
      ui?.sendToSide?.('clash-mini-latency-progress', {
        groupName: context.groupName,
        url: context.latencyUrl,
        timeout: context.timeout,
        total: context.uniqueNames.length,
        ...selection,
      });
    } catch (_) {}
  };
}

async function runLatencyProbes(ui, options, context, reportProgress) {
  const requestedSubset = Array.isArray(options.names) && options.names.length > 0;
  emitClashMiniLog(ui, 'info', `参与测试的节点数量: ${context.uniqueNames.length}`);
  if (!requestedSubset) {
    const entries = await runGroupBatchLatencyTest({ ...context, reportProgress, ui });
    if (entries) return entries;
  }
  const concurrency = resolveLatencyConcurrency(context.uniqueNames.length, options.concurrency);
  emitClashMiniLog(ui, 'info', `逐节点测速，并发度: ${concurrency}`);
  return runPerNodeLatencyTest({ ...context, concurrency, reportProgress });
}

function selectBestLatencyEntry(entries) {
  return entries
    .filter((item) => typeof item.delay === 'number' && Number.isFinite(item.delay) && item.delay > 0)
    .sort((a, b) => a.delay - b.delay)[0] || null;
}

async function refreshBrowserAfterProxyChange(ui, warningMessage) {
  if (typeof ui?.applyClashMiniBrowserProxy !== 'function') return;
  await Promise.resolve(ui.applyClashMiniBrowserProxy(true, { forceProfileRefresh: true })).catch((error) => {
    emitClashMiniLog(ui, 'warn', `${warningMessage}: ${error?.message || error}`);
  });
}

// 最低延时测试主流程：优先用内核组批量测速（一次调用、总耗时≈单节点超时上限），
// 失败时回退外部逐节点探测；两条路径共用进度上报、选优与切换逻辑。
async function testClashMiniLowestLatency(ui, options = {}) {
  const runtime = await ensureClashMiniRunning(ui);
  if (runtime.error) return runtime.error;
  const { coreDir } = runtime;
  const settings = resolveLatencySettings(coreDir, options);
  const { latencyUrl, timeout, groupName } = settings;

  emitClashMiniLog(ui, 'info', `准备测试最低延时: 分组=${groupName}，URL=${latencyUrl}，超时=${timeout}ms`);

  const apiReady = await waitForClashMiniControlApi(coreDir, 15000);
  if (!apiReady) {
    return { ok: false, error: 'Clash Mini 控制接口未就绪' };
  }

  const uniqueNames = await resolveLatencyCandidates(coreDir, groupName, options);
  if (uniqueNames.length === 0) {
    return { ok: false, error: `分组 ${groupName} 中没有可测试的节点` };
  }

  const context = { coreDir, groupName, uniqueNames, latencyUrl, timeout, selectBest: options.selectBest !== false };
  const reportProgress = createLatencyProgressReporter(ui, context, options.reportProgress !== false);

  reportProgress({ phase: 'start' });

  const entries = await runLatencyProbes(ui, options, context, reportProgress);
  const best = selectBestLatencyEntry(entries);
  if (!best) {
    reportProgress({ phase: 'done', entries, bestName: '', bestDelay: null });
    return {
      ok: false,
      error: '未找到可用的最低延时节点',
      entries,
      groupName,
      url: latencyUrl,
      timeout,
    };
  }

  const selectBest = options.selectBest !== false;
  if (selectBest) {
    await invokeClashMiniControl(coreDir, 'put', `/proxies/${encodeURIComponent(groupName)}`, {
      data: { name: best.name },
      timeoutMs: 10000,
    });
    await refreshBrowserAfterProxyChange(ui, '最低延时节点切换后刷新浏览器地区失败');
  }

  emitClashMiniLog(ui, 'info', selectBest
    ? `最低延时节点已选中: ${best.name} (${best.delay}ms)`
    : `节点测速完成，最低延时: ${best.name} (${best.delay}ms)`);
  reportProgress({
    phase: 'done',
    entries,
    bestName: selectBest ? best.name : '',
    bestDelay: selectBest ? best.delay : null,
  });

  return {
    ok: true,
    entries,
    groupName,
    url: latencyUrl,
    timeout,
    best,
    bestName: best.name,
    bestDelay: best.delay,
    running: true,
  };
}

async function switchClashMiniProxyNode(ui, options = {}) {
  let status = getClashMiniStatus();
  if (!status.running) {
    return {
      ok: false,
      error: 'Clash Mini 未运行',
      running: false,
    };
  }

  const coreDir = status.coreDir || getClashMiniRuntimeRoot();
  if (!coreDir || !fs.existsSync(coreDir)) {
    return { ok: false, error: 'Clash Mini 运行目录不存在' };
  }

  const groupName = String(options.groupName || getClashMiniManualGroupName(coreDir)).trim() || '节点选择';
  const nodeName = String(options.nodeName || options.name || '').trim();
  if (!nodeName) {
    return { ok: false, error: '未提供要切换的节点名称' };
  }

  const apiReady = await waitForClashMiniControlApi(coreDir, 15000);
  if (!apiReady) {
    return { ok: false, error: 'Clash Mini 控制接口未就绪' };
  }

  await invokeClashMiniControl(coreDir, 'put', `/proxies/${encodeURIComponent(groupName)}`, {
    data: { name: nodeName },
    timeoutMs: 10000,
  });

  if (typeof ui?.applyClashMiniBrowserProxy === 'function') {
    await Promise.resolve(ui.applyClashMiniBrowserProxy(true, {
      forceProfileRefresh: true,
    })).catch((error) => {
      emitClashMiniLog(ui, 'warn', `节点切换后刷新浏览器地区失败: ${error?.message || error}`);
    });
  }

  emitClashMiniLog(ui, 'info', `节点已切换: ${groupName} -> ${nodeName}`);

  return {
    ok: true,
    running: true,
    groupName,
    current: nodeName,
    name: nodeName,
  };
}

module.exports = {
  getClashMiniProxyGroupOptions,
  resolveLatencyConcurrency,
  switchClashMiniProxyNode,
  testClashMiniLowestLatency,
};
