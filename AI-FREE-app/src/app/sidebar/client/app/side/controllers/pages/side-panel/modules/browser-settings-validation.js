'use strict';

function validateBrowserCookies(setting) {
  let cookies;
  try { cookies = JSON.parse(String(setting.cookies || '[]')); } catch (_) { throw new Error('Cookie 必须是有效的 JSON 数组'); }
  if (!Array.isArray(cookies)) throw new Error('Cookie 顶层必须是数组');
}

function validateBrowserClientHints(setting) {
  if (!setting.secChUa || setting.secChUa.mode !== 'custom') return;
  try {
    if (!Array.isArray(JSON.parse(value('sec-ch-ua-brands', '[]')))) throw new Error();
  } catch (_) {
    throw new Error('Sec-CH-UA 必须是有效的 JSON 数组');
  }
}

function validateBrowserHomepage(setting) {
  if (!setting.homepage || setting.homepage.mode !== 'custom') return;
  try {
    const parsed = new URL(setting.homepage.url);
    if (!/^https?:$/.test(parsed.protocol)) throw new Error();
  } catch (_) {
    throw new Error('启动主页必须是有效的 HTTP/HTTPS 地址');
  }
}

window.validateAiFreeBrowserSettings = function validateAiFreeBrowserSettings(setting) {
  validateBrowserCookies(setting);
  validateBrowserClientHints(setting);
  const proxy = setting.proxy || {};
  const ua = setting.ua || {};
  const macAddress = setting.macAddress || {};
  if (proxy.mode === 'custom' && (!proxy.host || !Number(proxy.port))) throw new Error('自定义代理需要填写主机和端口');
  if (ua.mode === 'custom' && !String(ua.value || '').trim()) throw new Error('自定义 User Agent 不能为空');
  validateBrowserHomepage(setting);
  if (macAddress.mode === 'custom' && !/^([0-9A-F]{2}[-:]){5}[0-9A-F]{2}$/i.test(macAddress.value || '')) throw new Error('MAC 地址格式不正确');
}
