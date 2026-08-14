function clearDragIndicators() {
  if (!tabsContainer) return;
  tabsContainer.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.remove('dragging', 'drop-before', 'drop-after');
  });
  dragHoverTabId = null;
  dragHoverPosition = null;
}

// 获取/读取/解析：getDropPosition的具体业务逻辑。
function getDropPosition(event, tabElement) {
  if (!tabElement) return 'before';
  const rect = tabElement.getBoundingClientRect();
  const midpoint = rect.left + rect.width / 2;
  return event.clientX < midpoint ? 'before' : 'after';
}

// 设置/更新/持久化：updateDragHoverState的具体业务逻辑。
function updateDragHoverState(tabElement, position) {
  if (!tabsContainer) return;
  tabsContainer.querySelectorAll('.tab').forEach((tab) => {
    tab.classList.remove('drop-before', 'drop-after');
  });
  if (!tabElement) return;
  tabElement.classList.add(position === 'after' ? 'drop-after' : 'drop-before');
  dragHoverTabId = tabElement.dataset.id || null;
  dragHoverPosition = position;
}

// 启动/打开/显示：showTabContextMenu的具体业务逻辑。
async function showTabContextMenu(tab, event) {
  const tabId = String(tab?.id || '').trim();
  try {
    if (typeof ShellApi.showTabContextMenu !== 'function') {
      throw new Error('当前环境不支持标签菜单');
    }
    const resp = await ShellApi.showTabContextMenu( {
      tabId,
      x: Number(event?.clientX ?? 0),
      y: Number(event?.clientY ?? 0),
    });
    if (!resp || resp.ok !== true) {
      throw new Error((resp && (resp.message || resp.error)) || '打开菜单失败');
    }
  } catch (err) {
    showControllerError('打开标签菜单失败', err);
  }
}

function formatRuntimeStatus(status) {
  return ({
    starting: '正在启动',
    'waiting-pipe': '正在连接内核',
    'waiting-window': '正在等待浏览器窗口',
    attaching: '正在嵌入窗口',
    ready: '运行中',
    hidden: '后台运行',
    stopping: '正在关闭',
    stopped: '已关闭',
    crashed: '异常退出',
    error: '运行异常',
  })[String(status || '').trim().toLowerCase()] || '状态确认中';
}

function formatBrowserLocale(locale) {
  const value = String(locale || '').trim();
  if (!value) return '';
  try {
    const name = new Intl.DisplayNames(['zh-CN'], { type: 'language' }).of(value);
    if (name && name !== value) return `${name}（${value}）`;
  } catch (_) {}
  return value;
}

function formatRequestLanguages(value) {
  const languages = String(value || '').split(',')
    .map((item) => item.split(';')[0].trim())
    .filter((item, index, values) => item && values.indexOf(item) === index);
  return languages.map((item) => formatBrowserLocale(item)).join('、');
}

function formatOperatingSystemFromUserAgent(userAgent) {
  const value = String(userAgent || '');
  if (/Windows NT 10\.0/i.test(value)) return /(?:Win64|x64)/i.test(value) ? 'Windows 10/11（64 位）' : 'Windows 10/11';
  if (/Windows NT 6\.3/i.test(value)) return 'Windows 8.1';
  if (/Windows NT 6\.2/i.test(value)) return 'Windows 8';
  if (/Windows NT 6\.1/i.test(value)) return 'Windows 7';
  if (/Android/i.test(value)) return 'Android';
  if (/(?:iPhone|iPad|iPod)/i.test(value)) return 'iOS / iPadOS';
  if (/Mac OS X/i.test(value)) return 'macOS';
  if (/Linux/i.test(value)) return 'Linux';
  return '';
}

function formatBrowserTimezone(timezoneId) {
  const value = String(timezoneId || '').trim();
  if (!value) return '';
  return ({
    'Asia/Shanghai': '中国标准时间（UTC+8）',
    'Asia/Hong_Kong': '香港时间（UTC+8）',
    'Asia/Taipei': '台北时间（UTC+8）',
    'Asia/Tokyo': '日本标准时间（UTC+9）',
    'Asia/Seoul': '韩国标准时间（UTC+9）',
    'Asia/Singapore': '新加坡时间（UTC+8）',
    'America/New_York': '美国东部时间',
    'America/Toronto': '加拿大东部时间',
    'Europe/London': '英国时间',
    'Europe/Berlin': '德国时间',
    'Europe/Paris': '法国时间',
    'Europe/Amsterdam': '荷兰时间',
    'Europe/Moscow': '莫斯科时间（UTC+3）',
    'Australia/Sydney': '悉尼时间',
    'Asia/Kolkata': '印度标准时间（UTC+5:30）',
    'Asia/Bangkok': '泰国时间（UTC+7）',
  })[value] || value;
}

function formatBrowserRegion(profile = {}) {
  const countryCode = String(profile.sourceCountryCode || '').trim().toUpperCase();
  const rawCountry = String(profile.sourceCountry || '').trim();
  let country = '';
  const regionCode = countryCode || (/^[a-z]{2}$/i.test(rawCountry) ? rawCountry.toUpperCase() : '');
  if (regionCode) {
    try { country = new Intl.DisplayNames(['zh-CN'], { type: 'region' }).of(regionCode) || ''; } catch (_) {}
  }
  if (!country) country = rawCountry || String(profile.regionLabel || profile.region || '').trim();
  const details = [profile.sourceRegion, profile.sourceCity]
    .map((item) => String(item || '').trim())
    .filter((item, index, values) => item && item !== country && values.indexOf(item) === index);
  return [country, ...details].filter(Boolean).join(' / ');
}

function resolveChromiumDisplayVersion(profile = {}) {
  const explicit = String(profile.majorVersion || profile.browserVersion || '').trim().split('.')[0];
  if (/^\d+$/.test(explicit)) return explicit;
  const match = String(profile.userAgent || '').match(/(?:Chromium|Chrome)\/(\d+)/i);
  return match ? match[1] : '';
}

function settingLabel(value, labels, fallback = '默认') {
  return labels[String(value || '').trim()] || fallback;
}

function enabledLabel(value) {
  return value === true ? '已开启' : '已关闭';
}

function safeDisplayUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    const suffix = parsed.search || parsed.hash ? '（含隐藏参数）' : '';
    return `${parsed.origin}${parsed.pathname}${suffix}`;
  } catch (_) {
    return raw;
  }
}

function safeDisplayLaunchArgs(value) {
  return String(value || '').split(/\r?\n|\s+(?=--)/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (/^--[^=\s]*(?:password|passwd|token|secret|cookie|auth|key)[^=\s]*(?:=|\s+)/i.test(item)) {
        return `${item.match(/^--[^=\s]+/)?.[0] || '--敏感参数'}=已配置（已隐藏）`;
      }
      return item.replace(/:\/\/[^/@\s]+@/g, '://***:***@');
    })
    .join('；');
}

function formatProxySetting(proxy = {}, networkMagicEnabled = false) {
  const mode = String(proxy.mode || 'default');
  let value = settingLabel(mode, {
    default: '默认',
    none: '不使用浏览器自定义代理',
    custom: '自定义',
  });
  if (mode === 'custom') {
    const endpoint = [String(proxy.host || '').trim(), proxy.port].filter(Boolean).join(':');
    value += `${endpoint ? `（${String(proxy.protocol || 'http').toUpperCase()} ${endpoint}）` : ''}`;
    if (proxy.authenticationConfigured) value += '；已配置认证';
    if (proxy.apiConfigured) value += '；已配置提取接口';
  }
  if (networkMagicEnabled) value += '；当前由网络魔法接管';
  return value;
}

function formatUaBrands(brands = []) {
  return (Array.isArray(brands) ? brands : [])
    .map((item) => `${String(item?.brand || '').trim()} ${String(item?.version || '').trim()}`.trim())
    .filter(Boolean)
    .join('、');
}

function buildBasicSettingsTooltip(settings = {}, profile = {}, networkMagicEnabled = false) {
  const os = settingLabel(settings.os, {
    win7: 'Windows 7', win8: 'Windows 8', win10: 'Windows 10', win11: 'Windows 11',
  });
  const currentVersion = resolveChromiumDisplayVersion(profile);
  const browserVersion = settings.browserVersion
    ? `指定 ${settings.browserVersion}`
    : `自动匹配${currentVersion ? `（当前 ${currentVersion}）` : ''}`;
  const kernelVersion = !settings.kernelVersion || settings.kernelVersion === 'auto'
    ? '自动匹配'
    : settings.kernelVersion;
  const homepage = settings.homepage?.mode === 'custom'
    ? `自定义（${safeDisplayUrl(settings.homepage?.url) || '未填写'}）`
    : '默认主页';
  return [
    '【基础设置】',
    `操作系统：${os}`,
    `浏览器版本：${browserVersion}`,
    `内核版本：${kernelVersion}`,
    `代理设置：${formatProxySetting(settings.proxy, networkMagicEnabled)}`,
    `Cookie：${Math.max(0, Number(settings.cookieCount) || 0)} 条`,
    `启动主页：${homepage}`,
  ];
}

function tooltipObject(source, key) {
  const value = source && source[key];
  return value && typeof value === 'object' ? value : {};
}

function buildAdvancedIdentityTooltip(settings, profile) {
  const language = tooltipObject(settings, 'language');
  const timezoneSetting = tooltipObject(settings, 'timezone');
  const ua = tooltipObject(settings, 'ua');
  const secChUa = tooltipObject(settings, 'secChUa');
  const webrtc = tooltipObject(settings, 'webrtc');
  const locale = String(profile.locale || language.value || '').trim();
  const timezone = String(profile.timezoneId || timezoneSetting.value || '').trim();
  const acceptLanguage = String(profile.acceptLanguage || '').trim();
  const userAgent = String(profile.userAgent || '').trim();
  const brands = formatUaBrands(profile.uaBrands) || formatUaBrands(secChUa.brands);
  const lines = [
    `User Agent：${settingLabel(ua.mode, { default: '默认生成', custom: '自定义' })}`,
  ];
  if (userAgent) lines.push(`用户代理（UA）：${userAgent}`);
  lines.push(
    `Sec-CH-UA：${settingLabel(secChUa.mode, { default: '默认生成', custom: '自定义' })}${brands ? `（${brands}）` : ''}`,
    `语言：${language.value ? '自定义' : '跟随系统'}${locale ? `（当前 ${formatBrowserLocale(locale)}）` : ''}`,
    `网页请求语言：${acceptLanguage ? formatRequestLanguages(acceptLanguage) : '自动'}`,
    `时区：${timezoneSetting.mode === 'custom' ? '自定义' : '基于 IP 自动匹配'}${timezone ? `（当前 ${formatBrowserTimezone(timezone)}）` : ''}`,
    `WebRTC：${settingLabel(webrtc.mode, { replace: '替换', allow: '允许', block: '禁止' })}`,
  );
  return lines;
}

function formatGeolocationSetting(settings) {
  const geo = tooltipObject(settings, 'geolocation');
  const mode = geo.mode === 'custom'
    ? `自定义（经度 ${geo.longitude}，纬度 ${geo.latitude}，精度 ${geo.accuracy} 米）` : '基于 IP 自动匹配';
  return { geo, mode };
}

function formatResolutionSetting(settings, runtimeEnvironment) {
  const resolution = tooltipObject(settings, 'resolution');
  const value = resolution.mode === 'custom'
    ? `自定义 ${resolution.width} × ${resolution.height}` : '跟随电脑';
  const current = runtimeEnvironment.windowWidth > 0 && runtimeEnvironment.windowHeight > 0
    ? `；当前窗口 ${runtimeEnvironment.windowWidth} × ${runtimeEnvironment.windowHeight}` : '';
  return value + current;
}

function buildAdvancedFingerprintTooltip(settings, runtimeEnvironment) {
  const { geo, mode: geoMode } = formatGeolocationSetting(settings);
  const group = (name) => tooltipObject(settings, name);
  const webgl = group('webglMetadata');
  return [
    `地理位置权限：${settingLabel(geo.permission, { ask: '询问', allow: '允许', block: '禁止' })}`,
    `地理位置：${geoMode}`,
    `分辨率：${formatResolutionSetting(settings, runtimeEnvironment)}`,
    `字体：${settingLabel(group('fonts').mode, { system: '系统默认', random: '随机匹配' })}`,
    `Canvas：${settingLabel(group('canvas').mode, { default: '默认', noise: '随机噪声' })}`,
    `WebGL 图像：${settingLabel(group('webglImage').mode, { default: '默认', noise: '随机噪声' })}`,
    `WebGL 元数据：${settingLabel(webgl.mode, { default: '默认', custom: '自定义' })}`,
    `WebGL 厂商：${webgl.vendor || '默认'}`,
    `WebGL 渲染器：${webgl.renderer || '默认'}`,
    `WebGPU：${settingLabel(group('webgpu').mode, { default: '默认', webgl: '基于 WebGL' })}`,
    `AudioContext：${settingLabel(group('audioContext').mode, { default: '默认', noise: '随机噪声' })}`,
    `ClientRects：${settingLabel(group('clientRects').mode, { default: '默认', noise: '随机噪声' })}`,
    `语音列表：${settingLabel(group('speechVoices').mode, { default: '默认', noise: '随机匹配' })}`,
  ];
}

function formatCustomSetting(group, formatter = (value) => value) {
  return group.mode === 'custom' ? `自定义（${formatter(group.value) || '未填写'}）` : '默认';
}

function buildAdvancedSystemTooltip(settings, runtimeEnvironment) {
  const deviceName = tooltipObject(settings, 'deviceName');
  const macAddress = tooltipObject(settings, 'macAddress');
  const launchArgs = tooltipObject(settings, 'launchArgs');
  const portProtection = tooltipObject(settings, 'portScanProtection');
  const allowList = Array.isArray(portProtection.allowList) && portProtection.allowList.length
    ? portProtection.allowList.join('、') : '无';
  return [
    `CPU：${Math.max(1, Number(settings.cpu) || 1)} 核`,
    `设备内存指纹：${Math.max(1, Number(settings.memory) || 1)} GB`,
    `设备名称：${formatCustomSetting(deviceName)}`,
    `MAC 地址：${formatCustomSetting(macAddress)}`,
    `禁止跟踪（DNT）：${enabledLabel(settings.doNotTrack)}`,
    `SSL：${enabledLabel(settings.sslEnabled)}`,
    `端口扫描保护：${enabledLabel(portProtection.enabled)}`,
    `端口扫描白名单：${allowList}`,
    `硬件加速：${enabledLabel(runtimeEnvironment.hardwareAcceleration !== false)}`,
    `启动参数：${formatCustomSetting(launchArgs, safeDisplayLaunchArgs)}`,
  ];
}

function buildAdvancedSettingsTooltip(settings = {}, profile = {}, runtimeEnvironment = null) {
  const environment = runtimeEnvironment || { hardwareAcceleration: settings.hardwareAcceleration };
  return ['【高级设置】',
    ...buildAdvancedIdentityTooltip(settings, profile),
    ...buildAdvancedFingerprintTooltip(settings, environment),
    ...buildAdvancedSystemTooltip(settings, environment)];
}

// 创建/初始化：buildTabTooltip的具体业务逻辑。
function tooltipProfileLines(profile, runtimeEnvironment) {
  const lines = [];
  const sourceIp = String(profile.sourceIp || '').trim();
  const region = formatBrowserRegion(profile);
  const userAgent = String(profile.userAgent || '').trim();
  if (sourceIp) lines.push(`出口 IP：${sourceIp}`);
  if (region) lines.push(`出口地区：${region}`);
  const operatingSystem = formatOperatingSystemFromUserAgent(userAgent);
  if (operatingSystem) lines.push(`系统标识：${operatingSystem}`);
  if (runtimeEnvironment) lines.push(`已加载扩展：${Math.max(0, Number(runtimeEnvironment.extensionCount) || 0)} 个`);
  return lines;
}

function tooltipDefaultLocaleLines(profile) {
  const lines = [];
  const locale = String(profile.locale || '').trim();
  const timezoneId = String(profile.timezoneId || '').trim();
  const acceptLanguage = String(profile.acceptLanguage || '').trim();
  const userAgent = String(profile.userAgent || '').trim();
  if (locale) lines.push(`浏览器语言：${formatBrowserLocale(locale)}`);
  if (timezoneId) lines.push(`浏览器时区：${formatBrowserTimezone(timezoneId)}`);
  if (acceptLanguage) lines.push(`网页请求语言：${formatRequestLanguages(acceptLanguage)}`);
  if (userAgent) lines.push(`用户代理（UA）：${userAgent}`);
  return lines;
}

function tabTooltipObject(tab, key) {
  const value = tab && tab[key];
  return value && typeof value === 'object' ? value : null;
}

function buildTabTooltip(tab) {
  const title = String(tab?.title || '').trim() || '未命名标签页';
  const profile = tabTooltipObject(tab, 'browserProfile') || {};
  const browserSettings = tabTooltipObject(tab, 'browserSettings');
  const runtimeEnvironment = tabTooltipObject(tab, 'runtimeEnvironment');
  const version = resolveChromiumDisplayVersion(profile);
  const lines = [
    `浏览器名称：${title}`,
    `运行状态：${formatRuntimeStatus(tab?.runtimeStatus)}`,
    `浏览器内核：AI-FREE Chromium${version ? ` ${version}` : ''}`,
  ];
  lines.push(...tooltipProfileLines(profile, runtimeEnvironment));
  if (tab?.networkMagicEnabled === true) lines.push('网络魔法：已开启（当前浏览器已应用）');
  if (browserSettings) {
    lines.push(...buildBasicSettingsTooltip(browserSettings, profile, tab?.networkMagicEnabled === true));
    lines.push(...buildAdvancedSettingsTooltip(browserSettings, profile, runtimeEnvironment));
  } else {
    lines.push(...tooltipDefaultLocaleLines(profile));
  }
  return lines.join('\n');
}

// 设置/更新/持久化：applyAdaptiveTabSizing的具体业务逻辑。
function applyAdaptiveTabSizing() {
  if (!tabsContainer) return;
  const tabs = tabsContainer.querySelectorAll('.tab');
  if (!tabs.length) return;

  const rect = tabsContainer.getBoundingClientRect();
  const containerWidth = Math.max(rect.width || tabsContainer.clientWidth || 0, 0);
  const tabCount = tabs.length;
  const gapCount = Math.max(tabCount - 1, 0);
  const tabGap = parseFloat(getComputedStyle(tabsContainer).gap) || 4;
  const createButtonWidth = newBrowserWindowBtn?.offsetWidth || 0;
  const availableWidth = Math.max(containerWidth - createButtonWidth - ((gapCount + 1) * tabGap), 320);
  const idealWidth = Math.floor(availableWidth / tabCount);
  const tabWidth = Math.max(108, Math.min(220, idealWidth));

  tabs.forEach((tab) => {
    tab.style.flex = `0 0 ${tabWidth}px`;
    tab.style.width = `${tabWidth}px`;
    tab.style.maxWidth = `${tabWidth}px`;
    tab.style.minWidth = `${tabWidth}px`;
  });
}
