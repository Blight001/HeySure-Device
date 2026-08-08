'use strict';

const modeValue = (values, description) => ({ type: 'string', enum: values, description });
const modeObject = (values, description) => ({
  type: 'object',
  additionalProperties: false,
  properties: { mode: modeValue(values, description) },
});
const customValueObject = (modes, description, maxLength = 2048) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: modeValue(modes, description),
    value: { type: 'string', maxLength },
  },
});
const seededObject = (modes, description) => ({
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: modeValue(modes, description),
    seed: { type: 'string', maxLength: 64 },
  },
});

const BROWSER_SETTINGS_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  description: '该栏目的浏览器环境配置增量；只修改传入字段，未传入字段保持不变。Cookie 会话请使用 browser_file 的 save_session 操作，不通过本工具传输。',
  properties: {
    os: modeValue(['win7', 'win8', 'win10', 'win11'], '操作系统指纹'),
    browserVersion: { type: 'string', description: '浏览器版本指纹，例如 126.0.0.0' },
    kernelVersion: { type: 'string', description: '内核版本；auto 表示自动' },
    proxy: {
      type: 'object', additionalProperties: false,
      properties: {
        mode: modeValue(['default', 'none', 'custom'], '代理模式'),
        protocol: modeValue(['http', 'https', 'socks4', 'socks5'], '自定义代理协议'),
        host: { type: 'string' }, port: { type: 'integer', minimum: 1, maximum: 65535 },
        username: { type: 'string' }, password: { type: 'string' },
        apiUrl: { type: 'string', description: '代理提取 API 地址' },
      },
    },
    homepage: {
      type: 'object', additionalProperties: false,
      properties: {
        mode: modeValue(['default', 'custom'], '主页模式'),
        url: { type: 'string', description: '自定义 HTTP/HTTPS 主页' },
      },
    },
    ua: customValueObject(['default', 'custom'], 'User-Agent 模式'),
    secChUa: {
      type: 'object', additionalProperties: false,
      properties: {
        mode: modeValue(['default', 'custom'], 'Sec-CH-UA 模式'),
        brands: {
          type: 'array', maxItems: 8,
          items: {
            type: 'object', additionalProperties: false, required: ['brand', 'version'],
            properties: { brand: { type: 'string' }, version: { type: 'string' } },
          },
        },
      },
    },
    language: customValueObject(['custom'], '语言模式；值为空时跟随系统', 80),
    timezone: customValueObject(['ip', 'custom'], '时区模式', 100),
    webrtc: modeObject(['replace', 'allow', 'block'], 'WebRTC 模式'),
    geolocation: {
      type: 'object', additionalProperties: false,
      properties: {
        permission: modeValue(['ask', 'allow', 'block'], '定位权限'),
        mode: modeValue(['ip', 'custom'], '定位来源'),
        longitude: { type: 'number', minimum: -180, maximum: 180 },
        latitude: { type: 'number', minimum: -90, maximum: 90 },
        accuracy: { type: 'number', minimum: 1, maximum: 100000 },
      },
    },
    resolution: {
      type: 'object', additionalProperties: false,
      properties: {
        mode: modeValue(['follow', 'custom'], '分辨率模式'),
        width: { type: 'integer', minimum: 800, maximum: 7680 },
        height: { type: 'integer', minimum: 600, maximum: 4320 },
      },
    },
    fonts: seededObject(['system', 'random'], '字体模式'),
    canvas: seededObject(['default', 'noise'], 'Canvas 模式'),
    webglImage: seededObject(['default', 'noise'], 'WebGL 图像模式'),
    webglMetadata: {
      type: 'object', additionalProperties: false,
      properties: {
        mode: modeValue(['default', 'custom'], 'WebGL 元数据模式'),
        vendor: { type: 'string' }, renderer: { type: 'string' },
      },
    },
    webgpu: modeObject(['default', 'webgl'], 'WebGPU 模式'),
    audioContext: seededObject(['default', 'noise'], 'AudioContext 模式'),
    clientRects: seededObject(['default', 'noise'], 'ClientRects 模式'),
    speechVoices: seededObject(['default', 'noise'], '语音列表模式'),
    cpu: { type: 'integer', minimum: 1, maximum: 64 },
    memory: { type: 'integer', minimum: 1, maximum: 64 },
    deviceName: customValueObject(['default', 'custom'], '设备名称模式', 80),
    macAddress: customValueObject(['default', 'custom'], 'MAC 地址模式', 32),
    doNotTrack: { type: 'boolean' },
    sslEnabled: { type: 'boolean' },
    portScanProtection: {
      type: 'object', additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        allowList: { type: 'array', maxItems: 100, items: { type: 'integer', minimum: 1, maximum: 65535 } },
      },
    },
    hardwareAcceleration: { type: 'boolean' },
    launchArgs: customValueObject(['default', 'custom'], 'Chromium 启动参数模式', 10000),
  },
};

const WINDOWS_TAB_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'open', 'create', 'edit', 'close'],
      description: '窗口操作：list 列表、open 打开、create 新建、edit 编辑名称/环境、close 关闭。',
    },
    history_id: { type: 'string', description: '窗口记录 ID；open/edit/close 推荐使用，来自 action=list' },
    name: { type: 'string', description: '定位窗口的现有名称；action=create 时表示新窗口名称' },
    url: { type: 'string', description: 'action=create 的初始 HTTP/HTTPS 地址' },
    new_name: { type: 'string', description: 'action=edit 时设置的新窗口名称' },
    settings: BROWSER_SETTINGS_PATCH_SCHEMA,
    restart: { type: 'boolean', description: 'action=edit 且窗口已打开时是否重启 Chromium 以立即应用环境，默认 true' },
    include_settings: { type: 'boolean', description: 'action=list 时是否返回脱敏后的环境配置，默认 false' },
  },
};

module.exports = {
  BROWSER_SETTINGS_PATCH_SCHEMA,
  WINDOWS_TAB_INPUT_SCHEMA,
};
