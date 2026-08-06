const {
  normalizeLicenseUsage,
  toFiniteNumber,
} = require('../utils/normalizers');
const {
  normalizeLicenseKeyValue,
  normalizeLicenseRecord,
  normalizeLicenseRecords,
} = require('../utils/license-records');

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function createRuntimeConfig() {
  return {
    serverBase: '',
    platformName: '',
    targetUrl: '',
    tutorialUrl: '',
    browserSettings: {},
    allowedPlatforms: [],
    woolPlatforms: [],
    systemProxyEnabled: null,
    removeWatermarkEnabled: true,
    translateExtEnabled: false,
    autoValidatePending: false,
  };
}

function createEmptyValidationState() {
  return {
    bound: false,
    validated: false,
    key: '',
    deviceId: '',
    licenseValidated: false,
    cardStatus: '',
    cardExpiryDate: '',
    expiryDate: '',
    expireAt: '',
    daysLeft: null,
    expiresInSeconds: null,
    licenseUsage: null,
    maxUsageTimes: null,
    usedUsageTimes: null,
    remainingUsageTimes: null,
    canSelfUnbind: false,
    remainingUnbindTimes: null,
    maxUnbindTimes: null,
    usedUnbindTimes: null,
    deviceBindCount: null,
    maxDeviceCount: null,
    deviceBindingStatus: '',
    deviceBindingSummary: '',
    accountType: '',
    accountTypeLabel: '',
    currentAccountType: '',
    currentAccountTypeLabel: '',
    lastValidatedAt: null,
    result: null,
    message: '',
  };
}

function pickValidationSource(input = {}) {
  return input.result || input.source || input.data || input.payload || input || {};
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeLicenseKeyValue).filter(Boolean);
}

function normalizeWoolPlatform(item = {}) {
  const rawSubUrls = firstDefined(item.subUrls, item.sub_urls, []);
  const subUrls = Array.isArray(rawSubUrls)
    ? rawSubUrls.map(normalizeLicenseKeyValue).filter(Boolean)
    : [];
  const targetUrl = normalizeLicenseKeyValue(item.targetUrl || item.target_url) || subUrls[0] || '';
  return {
    name: normalizeLicenseKeyValue(item.name || item.platform || item.platform_name),
    platform: normalizeLicenseKeyValue(item.platform || item.name || item.platform_name),
    targetUrl,
    subUrls,
    launchOnly: item.launchOnly === true || item.launch_only === true,
    permissionGranted: item.permissionGranted === true || item.permission_granted === true,
    quota: item.quota && typeof item.quota === 'object' ? clone(item.quota) : null,
  };
}

function normalizeWoolPlatforms(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeWoolPlatform).filter((item) => item.name && item.targetUrl);
}

function applyStringConfig(config, partial, field) {
  if (partial[field] !== undefined) {
    config[field] = normalizeLicenseKeyValue(partial[field]);
  }
}

function applyBooleanConfig(config, partial, field) {
  if (partial[field] !== undefined) {
    config[field] = partial[field] === true;
  }
}

function applyRuntimeConfig(config, partial) {
  for (const field of ['serverBase', 'platformName', 'targetUrl', 'tutorialUrl']) {
    applyStringConfig(config, partial, field);
  }
  if (partial.browserSettings !== undefined) {
    config.browserSettings = partial.browserSettings && typeof partial.browserSettings === 'object'
      ? clone(partial.browserSettings)
      : {};
  }
  if (partial.allowedPlatforms !== undefined) {
    config.allowedPlatforms = normalizeStringList(partial.allowedPlatforms);
  }
  if (partial.woolPlatforms !== undefined) {
    config.woolPlatforms = normalizeWoolPlatforms(partial.woolPlatforms);
  }
  for (const field of [
    'systemProxyEnabled',
    'removeWatermarkEnabled',
    'translateExtEnabled',
    'autoValidatePending',
  ]) {
    applyBooleanConfig(config, partial, field);
  }
}

function createNormalizedUsage(input, source) {
  const sourceUsage = source && typeof source.licenseUsage === 'object' ? source.licenseUsage : {};
  const inputUsage = input.licenseUsage && typeof input.licenseUsage === 'object' ? input.licenseUsage : {};
  return normalizeLicenseUsage({ ...source, ...input, ...sourceUsage, ...inputUsage });
}

function createValidationDates(input, source, usage) {
  const cardExpiryDate = firstDefined(
    input.cardExpiryDate,
    input.expiryDate,
    input.expireAt,
    source.cardExpiryDate,
    source.expiryDate,
    source.expireAt,
    source.expire_at,
    usage?.expire_at,
    '',
  );
  return {
    cardExpiryDate: String(cardExpiryDate).trim(),
    expiryDate: String(firstDefined(input.expiryDate, source.expiryDate, '')),
    expireAt: String(firstDefined(input.expireAt, source.expireAt, source.expire_at, usage?.expire_at, '')),
    daysLeft: toFiniteNumber(firstDefined(input.daysLeft, source.daysLeft, source.days_left, usage?.days_left, null)),
    expiresInSeconds: toFiniteNumber(firstDefined(
      input.expiresInSeconds,
      source.expiresInSeconds,
      source.expires_in_seconds,
      usage?.expires_in_seconds,
      null,
    )),
  };
}

function createValidationAccount(input, source) {
  const accountType = String(firstDefined(input.accountType, input.account_type, source.accountType, source.account_type, ''));
  const accountTypeLabel = String(firstDefined(
    input.accountTypeLabel,
    input.account_type_label,
    source.accountTypeLabel,
    source.account_type_label,
    '',
  ));
  return {
    accountType,
    accountTypeLabel,
    currentAccountType: String(firstDefined(
      input.currentAccountType,
      source.currentAccountType,
      accountType,
      source.account_type,
      '',
    )),
    currentAccountTypeLabel: String(firstDefined(
      input.currentAccountTypeLabel,
      source.currentAccountTypeLabel,
      accountTypeLabel,
      source.account_type_label,
      '',
    )),
  };
}

function trueByDefault(value) {
  return value !== undefined ? value === true : true;
}

function createUsageValidation(usage) {
  return {
    licenseUsage: usage ? clone(usage) : null,
    maxUsageTimes: usage?.max_usage_times ?? null,
    usedUsageTimes: usage?.used_usage_times ?? null,
    remainingUsageTimes: usage?.remaining_usage_times ?? null,
  };
}

function createBindingValidation(input) {
  return {
    canSelfUnbind: input.canSelfUnbind === true,
    remainingUnbindTimes: input.remainingUnbindTimes ?? null,
    maxUnbindTimes: input.maxUnbindTimes ?? null,
    usedUnbindTimes: input.usedUnbindTimes ?? null,
    deviceBindCount: input.deviceBindCount ?? null,
    maxDeviceCount: input.maxDeviceCount ?? null,
    deviceBindingStatus: String(input.deviceBindingStatus || ''),
    deviceBindingSummary: String(input.deviceBindingSummary || ''),
  };
}

function createValidationState(input, credentials) {
  const key = normalizeLicenseKeyValue(input.key || credentials.key);
  const deviceId = normalizeLicenseKeyValue(input.deviceId || credentials.deviceId);
  const source = pickValidationSource(input);
  const usage = createNormalizedUsage(input, source);
  const dates = createValidationDates(input, source, usage);
  const account = createValidationAccount(input, source);
  return {
    ...createEmptyValidationState(),
    bound: trueByDefault(input.bound),
    validated: trueByDefault(input.validated),
    key,
    deviceId,
    licenseValidated: trueByDefault(input.licenseValidated),
    cardStatus: String(input.cardStatus || source.cardStatus || source.status || ''),
    ...dates,
    ...createUsageValidation(usage),
    ...createBindingValidation(input),
    ...account,
    lastValidatedAt: input.lastValidatedAt || new Date().toISOString(),
    result: clone(source),
    message: String(input.message || ''),
  };
}

class LicenseCache {
  constructor() {
    this.listeners = new Set();
    this.state = {
      credentials: { key: '', deviceId: '' },
      config: createRuntimeConfig(),
      validation: createEmptyValidationState(),
      records: [],
    };
  }

  notifyChange() {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      try { listener(snapshot); } catch (_) {}
    }
  }

  subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @param {Record<string, any>} [credentials] */
  setCredentials({ key, deviceId } = {}) {
    const nextKey = normalizeLicenseKeyValue(key);
    const nextDeviceId = normalizeLicenseKeyValue(deviceId);
    if (key !== undefined) {
      this.state.credentials.key = nextKey;
      this.state.validation.key = nextKey;
    }
    if (deviceId !== undefined) {
      this.state.credentials.deviceId = nextDeviceId;
      this.state.validation.deviceId = nextDeviceId;
    }
    return this.getCredentials();
  }

  getCredentials() {
    return clone(this.state.credentials) || { key: '', deviceId: '' };
  }

  setRuntimeConfig(partial = {}) {
    if (partial && typeof partial === 'object') {
      applyRuntimeConfig(this.state.config, partial);
    }
    return this.getRuntimeConfig();
  }

  getRuntimeConfig() {
    return clone(this.state.config) || createRuntimeConfig();
  }

  setValidationState(input = {}) {
    this.state.validation = createValidationState(input, this.state.credentials);
    this.state.credentials.key = this.state.validation.key;
    this.state.credentials.deviceId = this.state.validation.deviceId;
    const result = this.getValidationState();
    this.notifyChange();
    return result;
  }

  setUnboundState(input = {}) {
    const key = normalizeLicenseKeyValue(input.key || this.state.credentials.key);
    const deviceId = normalizeLicenseKeyValue(input.deviceId || this.state.credentials.deviceId);
    this.state.validation = {
      ...createEmptyValidationState(),
      key,
      deviceId,
      bound: false,
      validated: false,
      licenseValidated: false,
      licenseUsage: null,
    };
    this.state.credentials = { key, deviceId };
    const result = this.getValidationState();
    this.notifyChange();
    return result;
  }

  clearValidationState() {
    this.state.validation = {
      ...createEmptyValidationState(),
      key: this.state.credentials.key,
      deviceId: this.state.credentials.deviceId,
    };
    const result = this.getValidationState();
    this.notifyChange();
    return result;
  }

  getValidationState() {
    return clone(this.state.validation) || createEmptyValidationState();
  }

  getSnapshot() {
    return {
      ...this.getCredentials(),
      ...this.getValidationState(),
      ...this.getRuntimeConfig(),
    };
  }

  getRecords() {
    return clone(this.state.records) || [];
  }

  setRecords(records) {
    this.state.records = normalizeLicenseRecords(records);
    return this.getRecords();
  }

  appendRecord(entry = {}) {
    const normalized = normalizeLicenseRecord(entry);
    if (!normalized) return null;
    this.state.records = this.state.records.filter((item) => String(item.keyValue || '') !== normalized.keyValue);
    this.state.records.unshift(normalized);
    this.state.records = this.state.records.slice(0, 50);
    return clone(normalized);
  }

  /** @param {Record<string, any>} [identity] */
  deleteRecord({ keyValue, id } = {}) {
    const normalizedKey = normalizeLicenseKeyValue(keyValue);
    const normalizedId = normalizeLicenseKeyValue(id);
    const before = this.state.records.length;
    this.state.records = this.state.records.filter((item) => {
      const itemKey = normalizeLicenseKeyValue(item?.keyValue);
      const itemId = normalizeLicenseKeyValue(item?.id);
      if (normalizedId && itemId === normalizedId) return false;
      if (normalizedKey && itemKey === normalizedKey) return false;
      return true;
    });
    return before - this.state.records.length;
  }

  clearRecords() {
    this.state.records = [];
    return [];
  }
}

function createLicenseCache() {
  return new LicenseCache();
}

module.exports = {
  createLicenseCache,
};
