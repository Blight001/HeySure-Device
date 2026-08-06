function getClashMiniConfigSignature(key, deviceId) {
  return `${String(key || '').trim()}::${String(deviceId || '').trim()}`;
}

// 获取/读取/解析：resolveClashMiniCredentialsSnapshot的具体业务逻辑。
async function resolveClashMiniCredentialsSnapshot({ key = '', deviceId = '' } = {}) {
  let nextKey = String(key || '').trim();
  let nextDeviceId = String(deviceId || '').trim();

  if (!nextKey || !nextDeviceId) {
    const credentials = await loadClashMiniStoredCredentials();
    const filled = fillMissingClashCredentials(nextKey, nextDeviceId, credentials);
    nextKey = filled.key;
    nextDeviceId = filled.deviceId;
  }

  if (!nextDeviceId) nextDeviceId = await loadClashMiniDeviceId();

  return {
    key: nextKey,
    deviceId: nextDeviceId,
  };
}

function fillMissingClashCredentials(key, deviceId, credentials) {
  return {
    key: key || firstClashCredential(safeGetEl('session-token')?.value, credentials.key, globalCurrentKey),
    deviceId: deviceId || firstClashCredential(safeGetEl('device-id')?.value, credentials.deviceId, globalCurrentDeviceId),
  };
}

async function loadClashMiniDeviceId() {
  if (typeof window.aiFree?.license?.getDeviceId !== 'function') return '';
  const response = await window.aiFree.license.getDeviceId().catch(() => null);
  return String(response || '').trim();
}

async function loadClashMiniStoredCredentials() {
  const response = await window.aiFree.license.getUserCredentials().catch(() => null);
  return response?.ok === true && response.credentials ? response.credentials : {};
}

function firstClashCredential(...values) {
  return values.map((value) => String(value || '').trim()).find(Boolean) || '';
}

// 同步/连接：syncClashMiniConfigFromServer的具体业务逻辑。
async function syncClashMiniConfigFromServer(options = {}) {
  if (typeof window.aiFree?.network?.getClashConfig !== 'function') {
    throw new Error('当前环境不支持获取 Clash 配置');
  }

  const { key, deviceId } = await resolveClashMiniCredentialsSnapshot(options);

  if (!key || !deviceId) {
    throw new Error('账号未登录或缺少设备号，无法获取 Clash 配置');
  }

  const clashResp = await window.aiFree.network.getClashConfig( { key, deviceId });
  assertClashConfigResponse(clashResp);

  const configContent = String(clashResp.content || clashResp.configContent || '').trim();
  const subscriptionUrl = String(clashResp.proxySubscriptionUrl || '').trim();
  const importContent = configContent || '';

  const saveResp = await window.aiFree.network.saveClashConfig( {
    clashConfig: importContent,
    configContent: importContent,
    content: importContent,
    subscriptionUrl,
  });

  assertClashConfigSaved(saveResp);

  return {
    key,
    deviceId,
    clashResp,
    saveResp,
  };
}

function assertClashConfigResponse(response) {
  if (response?.ok === true) return;
  throw new Error(response?.error || response?.message || '获取客户端配置失败');
}

function assertClashConfigSaved(response) {
  if (response?.ok === true) return;
  if (response?.rawContent) {
    console.error('[侧边栏][Clash] 导入失败时的原始配置内容:');
    console.error(response.rawContent);
  }
  throw new Error(response?.error || response?.message || '导入 Clash 配置失败');
}

// 校验/保护：ensureClashMiniConfigPreheated的具体业务逻辑。
async function ensureClashMiniConfigPreheated(options = {}) {
  const { key, deviceId } = await resolveClashMiniCredentialsSnapshot(options);
  if (!key || !deviceId) {
    throw new Error('账号未登录或缺少设备号，无法预热 Clash 配置');
  }

  const signature = getClashMiniConfigSignature(key, deviceId);
  const force = options.force === true;
  if (force && clashMiniConfigPreheatState.promise) {
    await clashMiniConfigPreheatState.promise.catch(() => {});
  }
  if (!force && clashMiniConfigPreheatState.result && clashMiniConfigPreheatState.signature === signature) {
    return clashMiniConfigPreheatState.result;
  }

  if (!force && clashMiniConfigPreheatState.promise && clashMiniConfigPreheatState.signature === signature) {
    return clashMiniConfigPreheatState.promise;
  }

// 处理：promise的具体业务逻辑。
  const promise = (async () => {
    console.log('[侧边栏][Clash] 开始预热客户端配置...');
    const result = await syncClashMiniConfigFromServer({ key, deviceId });
    clashMiniConfigPreheatState.result = result;
    clashMiniConfigPreheatState.signature = signature;
    return result;
  })();

  clashMiniConfigPreheatState.signature = signature;
  clashMiniConfigPreheatState.promise = promise;

  try {
    return await promise;
  } catch (error) {
    if (clashMiniConfigPreheatState.signature === signature) {
      clashMiniConfigPreheatState.result = null;
      clashMiniConfigPreheatState.signature = '';
    }
    throw error;
  } finally {
    if (clashMiniConfigPreheatState.promise === promise) {
      clashMiniConfigPreheatState.promise = null;
    }
  }
}

function markVpnNodesTesting(names) {
  const requested = new Set(names);
  clashMiniProxyState.proxies = clashMiniProxyState.proxies.map((item) => (
    requested.has(item.name) ? { ...item, delay: null, delayText: '测速中...' } : item
  ));
  scheduleVpnNodeSelectorRender();
}

async function retestVpnNodes(names = null) {
  if (typeof window.aiFree?.network?.testMinLatency !== 'function' || !isVpnEnabled) return null;
  const requestedNames = normalizeVpnLatencyNames(names);
  const taskKey = requestedNames.length ? requestedNames.join('\u0001') : '*';
  if (vpnLatencyTestsInFlight.has(taskKey)) return null;

  vpnLatencyTestsInFlight.add(taskKey);
  const affectedNames = requestedNames.length ? requestedNames : getVpnNodeSelectorNames();
  markVpnNodesTesting(affectedNames);
  testLatencyBtn?.setAttribute('aria-busy', 'true');
  try {
    return await invokeVpnLatencyTest(requestedNames);
  } catch (error) {
    console.warn('[侧边栏][Clash] 节点测速失败:', error?.message || error);
    return null;
  } finally {
    vpnLatencyTestsInFlight.delete(taskKey);
    if (vpnLatencyTestsInFlight.size === 0) testLatencyBtn?.removeAttribute('aria-busy');
  }
}

function normalizeVpnLatencyNames(names) {
  if (!Array.isArray(names)) return [];
  return Array.from(new Set(names.map((name) => String(name || '').trim()).filter(Boolean)));
}

async function invokeVpnLatencyTest(requestedNames) {
  const options = { selectBest: false, reportProgress: true };
  if (requestedNames.length) options.names = requestedNames;
  const result = await window.aiFree.network.testMinLatency(options);
  if (Array.isArray(result?.entries)) {
    applyLatencyResultEntries(result.entries);
    syncVpnNodeSelectorState();
    scheduleVpnNodeSelectorRender({ forceFull: true });
  }
  if (result?.ok !== true) throw new Error(result?.error || result?.message || '节点测速失败');
  return result;
}
