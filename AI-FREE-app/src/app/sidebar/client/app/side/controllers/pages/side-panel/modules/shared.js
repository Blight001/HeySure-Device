// 侧边栏共享底座：状态、工具函数、通用格式化逻辑
//
// 说明：
// - 这里保留旧的全局变量名，避免一次性改动所有模块
// - 同时把状态集中到 SidePanelShared.state 里，后续可以逐步迁移到命名空间访问

(function initSidePanelShared() {
  const SidePanelSharedUtils = window.RendererControllerUtils || {};
  const MessageUtils = window.AiFreeMessageUtils || {};
  const safeGetEl = SidePanelSharedUtils.getEl || ((id) => document.getElementById(id));
  const withBusyButton = SidePanelSharedUtils.withBusyButton || ((btn, _companions, fn, options = {}) => {
    if (!btn) return null;
    if (btn.dataset.busy === '1') return null;
    btn.dataset.busy = '1';
    btn.disabled = true;
    const originalText = btn.textContent;
    return Promise.resolve()
      .then(fn)
      .finally(() => {
        btn.dataset.busy = '0';
        btn.disabled = false;
        if (!options.preserveTextAfterResolve) {
          btn.textContent = originalText;
        }
      });
  });
  const escapeHtml = SidePanelSharedUtils.escapeHtml || ((text) => String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;'));
  const formatValidationDate = SidePanelSharedUtils.formatDateTimeCN || ((value) => {
    if (!value && value !== 0) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  });
  const formatRemainingValidity = SidePanelSharedUtils.formatRemainingValidity || (() => '');
  const toFiniteNumber = SidePanelSharedUtils.toFiniteNumber || ((value) => {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  });

  const MAX_ANNOUNCEMENTS = 10;
  const sidePanelState = {
    session: {
      hasValidatedInSession: false,
      cookieImportUnlocked: false,
    },
    runtime: {
      dreamUrl: '',
      currentPlatformName: '',
    },
    vpn: {
      vpnSwitchBtn: null,
      testLatencyBtn: null,
      vpnButtons: [],
      isVpnEnabled: false,
      vpnNodeSelectorToggleBtn: null,
      vpnNodeSelectorPanel: null,
      vpnNodeSelectorGrid: null,
      vpnNodeSelectorGroup: null,
      clashMiniProxyState: {
        groupName: '节点选择',
        current: '',
        names: [],
        proxies: [],
      },
      vpnNodeSelectorBusy: false,
      vpnNodeSelectorHideTimer: null,
    },
    announcements: {
      items: [],
    },
    license: {
      globalCurrentKey: '',
      globalCurrentDeviceId: '',
      currentLicenseState: {
        key: '',
        deviceId: '',
        bound: false,
        regionInfo: null,
        canSelfUnbind: false,
        remainingUnbindTimes: null,
        maxUnbindTimes: null,
        usedUnbindTimes: null,
        deviceBindCount: null,
        maxDeviceCount: null,
        deviceBindingStatus: '',
        deviceBindingSummary: '',
      },
    },
    account: {
      currentAccountId: null,
      lastAccountListSnapshot: [],
      selectedPermanentAccountIds: new Set(),
    },
  };

// 处理：safeJsonStringify的具体业务逻辑。
  function safeJsonStringify(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch (err) {
      return `[Unserializable: ${err?.message || String(err)}]`;
    }
  }

// 格式化/规范化：formatConnectionStatusForLog的具体业务逻辑。
  function formatConnectionStatusForLog(status) {
    if (!status || typeof status !== 'object') {
      return String(status);
    }
    return safeJsonStringify({
      status: status.status || '',
      message: status.message || '',
      mode: status.mode || '',
      host: status.host || '',
      port: status.port || '',
    });
  }

// 处理：debounce的具体业务逻辑。
  function debounce(func, delayMs) {
    let timeout;
    return function (...args) {
      clearTimeout(timeout);
      timeout = setTimeout(() => func.apply(this, args), delayMs);
    };
  }

  const sanitizeUserFacingMessage = MessageUtils.sanitizeUserFacingMessage || ((message, fallback = '账号处理失败') => {
    const text = String(message || '').replace(/\s+/g, ' ').trim();
    return text || fallback;
  });

// 获取/读取/解析：extractValidationPayload的具体业务逻辑。
  function extractValidationPayload(result) {
    if (!result || typeof result !== 'object') return null;
    const nested = result.result && typeof result.result === 'object'
      ? result.result
      : (result.data && typeof result.data === 'object' ? result.data : null);
    return nested || result;
  }

  function getUsageField(payload, licenseUsage, names) {
    const sources = [payload, licenseUsage].filter((source) => source && typeof source === 'object');
    for (const source of sources) {
      for (const name of names) {
        if (source[name] !== undefined && source[name] !== null) return source[name];
      }
    }
    return null;
  }

// 格式化/规范化：formatUsageTimesText的具体业务逻辑。
  function formatUsageTimesText(result) {
    const payload = extractValidationPayload(result);
    if (!payload) return '';
    const licenseUsage = payload.licenseUsage && typeof payload.licenseUsage === 'object'
      ? payload.licenseUsage
      : null;

// 处理：toNumber的具体业务逻辑。
    const toNumber = (value) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };

    const maxUsageTimes = toNumber(getUsageField(payload, licenseUsage, ['max_usage_times', 'maxUsageTimes']));
    const usedUsageTimes = toNumber(getUsageField(payload, licenseUsage, ['used_usage_times', 'usedUsageTimes']));
    const remainingUsageTimes = toNumber(getUsageField(payload, licenseUsage, ['remaining_usage_times', 'remainingUsageTimes']));

    if (maxUsageTimes === 0) {
      return '无限制';
    }

    if (remainingUsageTimes !== null) {
      return String(remainingUsageTimes);
    }

    if (maxUsageTimes !== null && usedUsageTimes !== null) {
      return String(Math.max(maxUsageTimes - usedUsageTimes, 0));
    }

    return '未知';
  }

// 处理：defineWindowStateProxy的具体业务逻辑。
  function defineWindowStateProxy(name, getter, setter) {
    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: getter,
        set: setter,
      });
    } catch (_) {
      try {
        window[name] = getter();
      } catch (err) {
        console.warn(`[侧边栏] 无法初始化全局状态 ${name}:`, err?.message || err);
      }
    }
  }

  defineWindowStateProxy('DREAM_URL', () => sidePanelState.runtime.dreamUrl, (value) => {
    sidePanelState.runtime.dreamUrl = String(value || '').trim() || 'https://dreamina.capcut.com/ai-tool/home?';
  });
  defineWindowStateProxy('hasValidatedInSession', () => sidePanelState.session.hasValidatedInSession, (value) => {
    sidePanelState.session.hasValidatedInSession = value === true;
  });
  defineWindowStateProxy('cookieImportUnlocked', () => sidePanelState.session.cookieImportUnlocked, (value) => {
    sidePanelState.session.cookieImportUnlocked = value === true;
  });
  defineWindowStateProxy('vpnSwitchBtn', () => sidePanelState.vpn.vpnSwitchBtn, (value) => {
    sidePanelState.vpn.vpnSwitchBtn = value || null;
  });
  defineWindowStateProxy('testLatencyBtn', () => sidePanelState.vpn.testLatencyBtn, (value) => {
    sidePanelState.vpn.testLatencyBtn = value || null;
  });
  defineWindowStateProxy('vpnButtons', () => sidePanelState.vpn.vpnButtons, (value) => {
    sidePanelState.vpn.vpnButtons = Array.isArray(value) ? value : [];
  });
  defineWindowStateProxy('isVpnEnabled', () => sidePanelState.vpn.isVpnEnabled, (value) => {
    sidePanelState.vpn.isVpnEnabled = value === true;
  });
  defineWindowStateProxy('vpnNodeSelectorToggleBtn', () => sidePanelState.vpn.vpnNodeSelectorToggleBtn, (value) => {
    sidePanelState.vpn.vpnNodeSelectorToggleBtn = value || null;
  });
  defineWindowStateProxy('vpnNodeSelectorPanel', () => sidePanelState.vpn.vpnNodeSelectorPanel, (value) => {
    sidePanelState.vpn.vpnNodeSelectorPanel = value || null;
  });
  defineWindowStateProxy('vpnNodeSelectorGrid', () => sidePanelState.vpn.vpnNodeSelectorGrid, (value) => {
    sidePanelState.vpn.vpnNodeSelectorGrid = value || null;
  });
  defineWindowStateProxy('vpnNodeSelectorGroup', () => sidePanelState.vpn.vpnNodeSelectorGroup, (value) => {
    sidePanelState.vpn.vpnNodeSelectorGroup = value || null;
  });
  defineWindowStateProxy('clashMiniProxyState', () => sidePanelState.vpn.clashMiniProxyState, (value) => {
    sidePanelState.vpn.clashMiniProxyState = value && typeof value === 'object'
      ? value
      : {
          groupName: '节点选择',
          current: '',
          names: [],
          proxies: [],
        };
  });
  defineWindowStateProxy('vpnNodeSelectorBusy', () => sidePanelState.vpn.vpnNodeSelectorBusy, (value) => {
    sidePanelState.vpn.vpnNodeSelectorBusy = value === true;
  });
  defineWindowStateProxy('vpnNodeSelectorHideTimer', () => sidePanelState.vpn.vpnNodeSelectorHideTimer, (value) => {
    sidePanelState.vpn.vpnNodeSelectorHideTimer = value || null;
  });
  defineWindowStateProxy('announcements', () => sidePanelState.announcements.items, (value) => {
    sidePanelState.announcements.items = Array.isArray(value) ? value : [];
  });
  defineWindowStateProxy('MAX_ANNOUNCEMENTS', () => MAX_ANNOUNCEMENTS);
  defineWindowStateProxy('globalCurrentKey', () => sidePanelState.license.globalCurrentKey, (value) => {
    sidePanelState.license.globalCurrentKey = String(value || '').trim();
  });
  defineWindowStateProxy('globalCurrentDeviceId', () => sidePanelState.license.globalCurrentDeviceId, (value) => {
    sidePanelState.license.globalCurrentDeviceId = String(value || '').trim();
  });
  defineWindowStateProxy('currentLicenseState', () => sidePanelState.license.currentLicenseState, (value) => {
    sidePanelState.license.currentLicenseState = value && typeof value === 'object'
      ? value
      : {
          key: '',
          deviceId: '',
          bound: false,
          regionInfo: null,
          canSelfUnbind: false,
          remainingUnbindTimes: null,
          maxUnbindTimes: null,
          usedUnbindTimes: null,
          deviceBindCount: null,
          maxDeviceCount: null,
          deviceBindingStatus: '',
          deviceBindingSummary: '',
        };
  });
  defineWindowStateProxy('currentAccountId', () => sidePanelState.account.currentAccountId, (value) => {
    const normalized = String(value || '').trim();
    sidePanelState.account.currentAccountId = normalized || null;
  });
  defineWindowStateProxy('lastAccountListSnapshot', () => sidePanelState.account.lastAccountListSnapshot, (value) => {
    sidePanelState.account.lastAccountListSnapshot = Array.isArray(value) ? value : [];
  });
  defineWindowStateProxy('selectedPermanentAccountIds', () => sidePanelState.account.selectedPermanentAccountIds, (value) => {
    sidePanelState.account.selectedPermanentAccountIds = value instanceof Set ? value : new Set();
  });
  defineWindowStateProxy('currentPlatformName', () => sidePanelState.runtime.currentPlatformName, (value) => {
    sidePanelState.runtime.currentPlatformName = String(value || '').trim();
  });

  const sharedApi = {
    state: sidePanelState,
    utils: {
      safeGetEl,
      withBusyButton,
      escapeHtml,
      formatValidationDate,
      formatRemainingValidity,
      toFiniteNumber,
      safeJsonStringify,
      formatConnectionStatusForLog,
      debounce,
      sanitizeUserFacingMessage,
      extractValidationPayload,
      formatUsageTimesText,
    },
  };

  window.SidePanelShared = Object.assign({}, window.SidePanelShared, sharedApi);

  window.safeGetEl = safeGetEl;
  window.withBusyButton = withBusyButton;
  window.escapeHtml = escapeHtml;
  window.formatValidationDate = formatValidationDate;
  window.formatRemainingValidity = formatRemainingValidity;
  window.toFiniteNumber = toFiniteNumber;
  window.safeJsonStringify = safeJsonStringify;
  window.formatConnectionStatusForLog = formatConnectionStatusForLog;
  window.debounce = debounce;
  window.sanitizeUserFacingMessage = sanitizeUserFacingMessage;
  window.extractValidationPayload = extractValidationPayload;
  window.formatUsageTimesText = formatUsageTimesText;

  window.SidePanelShared.safeGetEl = safeGetEl;
  window.SidePanelShared.withBusyButton = withBusyButton;
  window.SidePanelShared.escapeHtml = escapeHtml;
  window.SidePanelShared.formatValidationDate = formatValidationDate;
  window.SidePanelShared.formatRemainingValidity = formatRemainingValidity;
  window.SidePanelShared.toFiniteNumber = toFiniteNumber;
  window.SidePanelShared.safeJsonStringify = safeJsonStringify;
  window.SidePanelShared.formatConnectionStatusForLog = formatConnectionStatusForLog;
  window.SidePanelShared.debounce = debounce;
  window.SidePanelShared.sanitizeUserFacingMessage = sanitizeUserFacingMessage;
  window.SidePanelShared.extractValidationPayload = extractValidationPayload;
  window.SidePanelShared.formatUsageTimesText = formatUsageTimesText;
}());
