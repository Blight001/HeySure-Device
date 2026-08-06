'use strict';

const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const { CLASH_MINI_RULE_MODE } = require('./clash-mini-constants');
const {
  copyDirectoryRecursive,
  copyDirectoryRecursiveAsync,
  getClashMiniAppRoots,
  getClashMiniCoreRoots,
  getClashMiniProfileRoots,
  resolveBundledClashMiniCoreDir,
  getClashMiniRuntimeRoot,
  resolveClashMiniCoreDir,
  resolveClashMiniExecutable,
  getLocalAssetRelativePaths,
  buildLocalAssetManifest,
  readLocalAssetMarker,
  writeLocalAssetMarker,
  writeLocalAssetMarkerAsync,
  isLocalAssetSizeCurrent,
  syncLocalGeoAssets,
  syncLocalGeoAssetsAsync,
  prepareClashMiniRuntimeDirAsync,
  purgeClashMiniRuntimeConfigFiles,
} = require('./clash-mini-assets');
const {
  parseYamlMaybe,
  looksLikeRuntimeClashConfig,
  looksLikeProfilesIndex,
  readYamlIfExists,
  readClashMiniRuntimeConfig,
  getClashMiniProxyEndpoint,
  getClashMiniControlEndpoint,
  getClashMiniControlSecret,
  getClashMiniManualGroupName,
  getClashMiniConfigProxyNames,
  buildClashMiniControlUrl,
  buildClashMiniControlHeaders,
  extractDelayValue,
  normalizeProxyNameList,
  fetchClashMiniProxyNames,
  probeClashMiniProxyDelay,
  probeClashMiniGroupDelay,
  formatClashMiniDelayText,
  collectClashMiniProxyDelays,
  normalizeProbeTimeout,
  normalizeProbeUrl,
  readClashProbeSettings,
  probeLatencyUrl,
  waitForClashMiniControlApi,
  invokeClashMiniControl,
  ensureClashMiniRuleMode,
} = require('./clash-mini-control');

function resolveClashMiniProfileFile(coreDir, profilesIndex) {
  const items = Array.isArray(profilesIndex?.items) ? profilesIndex.items : [];
  const currentUid = String(profilesIndex?.current || profilesIndex?.getCurrentProfile || '').trim();
  const currentItem = (currentUid && items.length > 0)
    ? items.find((item) => String(item?.uid || '').trim() === currentUid)
    : null;
  const candidateNames = [
    currentItem?.file && String(currentItem.file).trim(),
    currentUid && `${currentUid}.yaml`,
    currentItem?.uid && `${String(currentItem.uid).trim()}.yaml`,
  ].filter(Boolean);
  return findExistingProfilePath(coreDir, candidateNames);
}

function findExistingProfilePath(coreDir, candidateNames) {
  const candidates = [path.join(coreDir, 'profiles'), coreDir]
    .flatMap((root) => candidateNames.map((name) => path.join(root, name)));
  return candidates.find((filePath) => fs.existsSync(filePath)) || null;
}

const MIN_USABLE_GEO_DATABASE_SIZE = 1024 * 1024;
const CLASH_MINI_DOMESTIC_DIRECT_RULES = [
  // AI-FREE owns the embedded Chromium version. Keep Chromium component and
  // model update traffic away from paid proxy nodes even if a subscription
  // contains broader Google proxy rules later in the rule list.
  'DOMAIN-SUFFIX,gvt1.com,DIRECT',
  'DOMAIN,dl.google.com,DIRECT',
  'DOMAIN,clients2.google.com,DIRECT',
  'DOMAIN,update.googleapis.com,DIRECT',
  'DOMAIN,android.clients.google.com,DIRECT',
  'DOMAIN,content-autofill.googleapis.com,DIRECT',
  'DOMAIN,optimizationguide-pa.googleapis.com,DIRECT',
  'DOMAIN-SUFFIX,baidu.com,DIRECT',
  'DOMAIN-SUFFIX,baidubce.com,DIRECT',
  'DOMAIN-SUFFIX,bdstatic.com,DIRECT',
  'DOMAIN-SUFFIX,bdimg.com,DIRECT',
  'DOMAIN-SUFFIX,cn,DIRECT',
  'GEOSITE,CN,DIRECT',
  'GEOIP,CN,DIRECT,no-resolve',
];

const PROVIDER_FILE_BY_NAME = {
  cn_ip: 'providers/cn_ip.mrs',
  cn_domain: 'providers/cn_domain.mrs',
  private_domain: 'providers/private_domain.mrs',
  'geolocation-!cn': 'providers/geolocation-!cn.mrs',
};

const PROVIDER_FILE_BY_SOURCE_SUFFIX = {
  '/geo/geoip/cn.mrs': 'providers/cn_ip.mrs',
  '/geo/geosite/cn.mrs': 'providers/cn_domain.mrs',
  '/geo/geosite/private.mrs': 'providers/private_domain.mrs',
  '/geo/geosite/geolocation-!cn.mrs': 'providers/geolocation-!cn.mrs',
};

// Mihomo 会在控制端口监听前同步初始化 GEOIP/GEOSITE 数据。首次启动时如果
// 本地没有数据库且 GitHub 不可达，进程会卡在下载阶段，形成“代理尚未启动，
// 但启动代理又需要先下载”的死锁。数据库存在时保留完整分流；数据库缺失时
// 只移除依赖 Geo 数据的规则，让代理先以现有域名/IP/MATCH 规则离线启动。
function hasUsableClashMiniGeoFile(coreDir, candidates) {
  if (!coreDir) return false;
  return candidates.some((name) => {
    try {
      return fs.statSync(path.join(coreDir, name)).size >= MIN_USABLE_GEO_DATABASE_SIZE;
    } catch (_) {
      return false;
    }
  });
}

function getClashMiniGeoDatabaseAvailability(coreDir, config = {}) {
  const geodataMode = config && config['geodata-mode'] === true;
  const geoIpCandidates = geodataMode
    ? ['GeoIP.dat', 'geoip.dat']
    : ['geoip.metadb'];
  return {
    geoIp: hasUsableClashMiniGeoFile(coreDir, geoIpCandidates),
    geoSite: hasUsableClashMiniGeoFile(coreDir, ['GeoSite.dat', 'geosite.dat']),
  };
}

function repairMalformedHttpsUrls(value, stats) {
  if (typeof value === 'string') {
    const repaired = value.replace(/^https:\/{3,}(?=[^/])/i, 'https://');
    if (repaired !== value) stats.fixedUrls += 1;
    return repaired;
  }
  if (Array.isArray(value)) {
    return value.map((item) => repairMalformedHttpsUrls(item, stats));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, repairMalformedHttpsUrls(item, stats)]),
    );
  }
  return value;
}

// 将服务器下发的远程 Geo/规则配置改写为随包内置文件，确保启动和分流
// 不依赖 jsDelivr 或其它外部下载源。
function localizeGeoAndProviders(config, coreDir, stats) {
  const next = { ...config };
  if (next['geo-auto-update'] !== false) {
    next['geo-auto-update'] = false;
    stats.geoLocalized = true;
  }
  if (hasLocalAsset(coreDir, 'geoip.metadb') && hasLocalAsset(coreDir, 'geosite.dat') && next['geox-url']) {
    delete next['geox-url'];
    stats.geoLocalized = true;
  }
  const providers = next['rule-providers'];
  if (isRecord(providers)) next['rule-providers'] = localizeProviders(providers, coreDir, stats);
  return next;
}

function hasLocalAsset(coreDir, relativePath) {
  try {
    return fs.statSync(path.join(coreDir, relativePath)).size > 0;
  } catch (_) {
    return false;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveProviderFile(name, definition) {
  const normalizedName = String(name || '').trim().toLowerCase().replace(/-/g, '_');
  const byName = PROVIDER_FILE_BY_NAME[name] || PROVIDER_FILE_BY_NAME[normalizedName];
  if (byName) return byName;
  const sourceUrl = String(definition?.url || '').trim().toLowerCase()
    .split(/[?#]/, 1)[0].replace(/\\/g, '/');
  const suffix = Object.keys(PROVIDER_FILE_BY_SOURCE_SUFFIX)
    .find((candidate) => sourceUrl.endsWith(candidate));
  return suffix ? PROVIDER_FILE_BY_SOURCE_SUFFIX[suffix] : null;
}

function localizeProviders(providers, coreDir, stats) {
  return Object.fromEntries(Object.entries(providers).map(([name, definition]) => {
    const relativePath = resolveProviderFile(name, definition);
    if (!relativePath || !hasLocalAsset(coreDir, relativePath) || !isRecord(definition)) {
      return [name, definition];
    }
    const { url, interval, proxy, ...rest } = definition;
    const localized = { ...rest, type: 'file', path: `./${relativePath}`, format: rest.format || 'mrs' };
    const removedRemoteFields = [url, interval, proxy].some((value) => value !== undefined);
    const changedShape = ['type', 'path', 'format'].some((key) => definition[key] !== localized[key]);
    if (removedRemoteFields || changedShape) stats.providersLocalized += 1;
    return [name, localized];
  }));
}

function ensureClashMiniControlFields(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return config;
  const next = { ...config };
  if (!String(next['external-controller'] || next.external_controller || '').trim()) {
    next['external-controller'] = '127.0.0.1:9090';
  }
  return next;
}

function normalizeClashMiniStartupConfig(config, coreDir) {
  const stats = createCompatibilityStats();
  if (!isRecord(config)) return { config, ...stats };
  let next = repairMalformedHttpsUrls(config, stats);
  next = localizeGeoAndProviders(next, coreDir, stats);
  next = ensureRuleMode(next, stats);
  const geoAvailability = getClashMiniGeoDatabaseAvailability(coreDir, next);
  recordGeoAvailability(stats, geoAvailability);
  next = addMissingDomesticRules(next, geoAvailability, stats);
  stats.controlFieldAdded = !String(next['external-controller'] || next.external_controller || '').trim();
  next = ensureClashMiniControlFields(next);
  if (!stats.geoDatabaseAvailable) next = applyOfflineGeoFallback(next, geoAvailability, stats);
  stats.changed = hasCompatibilityChanges(stats);
  return { config: next, ...stats };
}

function createCompatibilityStats() {
  return {
    changed: false, controlFieldAdded: false, ruleModeForced: false,
    domesticDirectRulesAdded: 0, fixedUrls: 0, geoLocalized: false,
    providersLocalized: 0, removedGeoRules: 0, offlineMatchDirectRulesRewritten: 0,
    disabledDnsGeoFilter: false, geoDatabaseAvailable: false,
    geoIpDatabaseAvailable: false, geoSiteDatabaseAvailable: false,
  };
}

function ensureRuleMode(config, stats) {
  if (String(config.mode || '').trim().toLowerCase() === CLASH_MINI_RULE_MODE) return config;
  stats.ruleModeForced = true;
  return { ...config, mode: CLASH_MINI_RULE_MODE };
}

function recordGeoAvailability(stats, availability) {
  stats.geoIpDatabaseAvailable = availability.geoIp;
  stats.geoSiteDatabaseAvailable = availability.geoSite;
  stats.geoDatabaseAvailable = availability.geoIp && availability.geoSite;
}

function addMissingDomesticRules(config, availability, stats) {
  const currentRules = Array.isArray(config.rules) ? config.rules.slice() : [];
  const normalizedRules = new Set(
    currentRules
      .filter((rule) => typeof rule === 'string')
      .map((rule) => rule.replace(/\s+/g, '').toUpperCase()),
  );
  const missingDomesticRules = CLASH_MINI_DOMESTIC_DIRECT_RULES
    .filter((rule) => availability.geoSite || !/^GEOSITE,/i.test(rule))
    .filter((rule) => availability.geoIp || !/^GEOIP,/i.test(rule))
    .filter((rule) => !normalizedRules.has(rule.replace(/\s+/g, '').toUpperCase()));
  stats.domesticDirectRulesAdded = missingDomesticRules.length;
  return missingDomesticRules.length
    ? { ...config, rules: [...missingDomesticRules, ...currentRules] }
    : config;
}

function applyOfflineGeoFallback(config, availability, stats) {
  let next = config;
  if (Array.isArray(next.rules)) {
    next = { ...next, rules: normalizeOfflineRules(next.rules, availability, stats) };
  }
  if (isRecord(next.dns)) next = { ...next, dns: normalizeOfflineDns(next.dns, availability, stats) };
  return next;
}

function normalizeOfflineRules(rules, availability, stats) {
  return rules.filter((rule) => {
    const text = typeof rule === 'string' ? rule : '';
    const unavailable = (!availability.geoIp && /(?:^|[,(])\s*GEOIP\s*,/i.test(text))
      || (!availability.geoSite && /(?:^|[,(])\s*GEOSITE\s*,/i.test(text));
    if (unavailable) stats.removedGeoRules += 1;
    return !unavailable;
  }).map((rule) => rewriteOfflineMatchRule(rule, availability, stats));
}

function rewriteOfflineMatchRule(rule, availability, stats) {
  const isProxyMatch = typeof rule === 'string'
    && /^\s*MATCH\s*,/i.test(rule)
    && !/^\s*MATCH\s*,\s*DIRECT(?:\s*,|\s*$)/i.test(rule);
  if (availability.geoIp || !isProxyMatch) return rule;
  stats.offlineMatchDirectRulesRewritten += 1;
  return 'MATCH,DIRECT';
}

function normalizeOfflineDns(source, availability, stats) {
  const dns = { ...source };
  if (isRecord(dns['fallback-filter'])) {
    dns['fallback-filter'] = normalizeFallbackFilter(dns['fallback-filter'], availability, stats);
  }
  if (!availability.geoSite && isRecord(dns['nameserver-policy'])) {
    const entries = Object.entries(dns['nameserver-policy']);
    const retained = entries.filter(([key]) => !/(?:^|,)\s*geosite:/i.test(key));
    if (retained.length !== entries.length) {
      dns['nameserver-policy'] = Object.fromEntries(retained);
      stats.disabledDnsGeoFilter = true;
    }
  }
  return dns;
}

function normalizeFallbackFilter(source, availability, stats) {
  const filter = { ...source };
  if (!availability.geoIp && (filter.geoip !== false || 'geoip-code' in filter)) {
    filter.geoip = false;
    delete filter['geoip-code'];
    stats.disabledDnsGeoFilter = true;
  }
  if (!availability.geoSite && 'geosite' in filter) {
    delete filter.geosite;
    stats.disabledDnsGeoFilter = true;
  }
  return filter;
}

function hasCompatibilityChanges(stats) {
  return [
    stats.controlFieldAdded, stats.ruleModeForced, stats.geoLocalized, stats.disabledDnsGeoFilter,
    stats.domesticDirectRulesAdded, stats.fixedUrls, stats.providersLocalized,
    stats.removedGeoRules, stats.offlineMatchDirectRulesRewritten,
  ].some(Boolean);
}

function getClashMiniCompatibilitySummary(normalized) {
  const { config: _config, ...summary } = normalized || {};
  return summary;
}

function normalizeAndWriteClashMiniRuntimeConfig(coreDir, runtimeConfigPath, config) {
  const normalized = normalizeClashMiniStartupConfig(config, coreDir);
  if (normalized.changed) {
    fs.writeFileSync(runtimeConfigPath, YAML.stringify(normalized.config), 'utf8');
    if (!normalized.geoDatabaseAvailable && (
      normalized.removedGeoRules > 0
      || normalized.offlineMatchDirectRulesRewritten > 0
      || normalized.disabledDnsGeoFilter
    )) {
      console.warn(
        '[IPC] Clash Mini 未找到可用 Geo 数据库，已启用离线启动兼容配置:',
        `移除 ${normalized.removedGeoRules} 条 Geo 规则，`
          + `将 ${normalized.offlineMatchDirectRulesRewritten} 条最终 MATCH 改为直连`,
      );
    }
    if (normalized.fixedUrls > 0) {
      console.warn('[IPC] Clash Mini 已修复配置中的异常 HTTPS 地址:', normalized.fixedUrls);
    }
  }
  return normalized;
}

function ensureClashMiniRuntimeConfig(coreDir) {
  const runtimeConfigPath = path.join(coreDir, 'config.yaml');
  const legacyConfigPath = path.join(coreDir, 'self.yaml');
  const profilesIndexPath = path.join(coreDir, 'profiles.yaml');

  const runtimeConfig = readYamlIfExists(runtimeConfigPath);
  if (looksLikeRuntimeClashConfig(runtimeConfig)) {
    const normalized = normalizeAndWriteClashMiniRuntimeConfig(coreDir, runtimeConfigPath, runtimeConfig);
    return {
      ok: true,
      configPath: runtimeConfigPath,
      source: runtimeConfigPath,
      repaired: normalized.changed,
      offlineGeoFallback: !normalized.geoDatabaseAvailable,
    };
  }

  const profilesYaml = readYamlIfExists(profilesIndexPath);
  if (looksLikeRuntimeClashConfig(profilesYaml)) {
    const normalized = normalizeAndWriteClashMiniRuntimeConfig(coreDir, runtimeConfigPath, profilesYaml);
    if (!normalized.changed) fs.writeFileSync(runtimeConfigPath, YAML.stringify(normalized.config), 'utf8');
    return { ok: true, configPath: runtimeConfigPath, source: profilesIndexPath, repaired: true, offlineGeoFallback: !normalized.geoDatabaseAvailable };
  }

  if (looksLikeProfilesIndex(profilesYaml)) {
    const profileFilePath = resolveClashMiniProfileFile(coreDir, profilesYaml);
    if (profileFilePath) {
      const profileConfig = readYamlIfExists(profileFilePath);
      if (looksLikeRuntimeClashConfig(profileConfig)) {
        const normalized = normalizeAndWriteClashMiniRuntimeConfig(coreDir, runtimeConfigPath, profileConfig);
        if (!normalized.changed) fs.writeFileSync(runtimeConfigPath, YAML.stringify(normalized.config), 'utf8');
        return { ok: true, configPath: runtimeConfigPath, source: profileFilePath, repaired: true, offlineGeoFallback: !normalized.geoDatabaseAvailable };
      }
    }
  }

  const legacyConfig = readYamlIfExists(legacyConfigPath);
  if (looksLikeRuntimeClashConfig(legacyConfig)) {
    const normalized = normalizeAndWriteClashMiniRuntimeConfig(coreDir, runtimeConfigPath, legacyConfig);
    if (!normalized.changed) fs.writeFileSync(runtimeConfigPath, YAML.stringify(normalized.config), 'utf8');
    return { ok: true, configPath: runtimeConfigPath, source: legacyConfigPath, repaired: true, offlineGeoFallback: !normalized.geoDatabaseAvailable };
  }

  return {
    ok: false,
    error: '未找到可启动的 Clash 运行配置',
    configPath: runtimeConfigPath,
  };
}

module.exports = {
  ensureClashMiniControlFields,
  getClashMiniProfileRoots,
  resolveClashMiniProfileFile,
  hasUsableClashMiniGeoFile,
  getClashMiniGeoDatabaseAvailability,
  repairMalformedHttpsUrls,
  localizeGeoAndProviders,
  normalizeClashMiniStartupConfig,
  getClashMiniCompatibilitySummary,
  normalizeAndWriteClashMiniRuntimeConfig,
  ensureClashMiniRuntimeConfig,
};
