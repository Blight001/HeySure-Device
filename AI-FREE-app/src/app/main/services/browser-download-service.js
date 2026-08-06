'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveInside } = require('./ai-sandbox-file-tools');
const { resolvePublicDownloadHost, secureDownloadFetch } = require('./browser-download-network-policy');

const DEFAULT_MAX_BYTES = 250 * 1024 * 1024;
const MAX_ALLOWED_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function normalizeUrl(value) {
  const parsed = new URL(String(value || '').trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('下载链接只支持 HTTP/HTTPS');
  if (parsed.username || parsed.password) throw new Error('下载链接不能包含用户名或密码');
  return parsed;
}

function sanitizeFileName(value, fallback = 'download.bin') {
  const base = path.basename(String(value || '').trim())
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 160);
  return base && !/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(base) ? base : fallback;
}

function dispositionFileName(header) {
  const value = String(header || '');
  const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.replace(/^"|"$/g, '')); } catch (_) {}
  }
  return value.match(/filename\s*=\s*"([^"]+)"/i)?.[1]
    || value.match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim() || '';
}

function suggestedFileName(response, finalUrl, requested) {
  if (requested) return sanitizeFileName(requested);
  const headerName = dispositionFileName(response.headers.get('content-disposition'));
  let urlName = finalUrl.pathname.split('/').pop() || '';
  try { urlName = decodeURIComponent(urlName); } catch (_) {}
  return sanitizeFileName(headerName || urlName, 'download.bin');
}

function assertExpectedMediaResponse(response, expectedType) {
  if (!['image', 'video', 'audio'].includes(expectedType)) return;
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (/^(?:text\/html|application\/json|text\/plain)\b/.test(contentType)) {
    throw new Error(`媒体下载返回了非媒体内容: ${contentType || 'unknown'}`);
  }
}

function cookieDomainMatches(cookie, url) {
  const domain = String(cookie?.domain || '').replace(/^\./, '').toLowerCase();
  const host = url.hostname.toLowerCase();
  if (!domain) return false;
  return cookie?.hostOnly === true
    ? host === domain
    : host === domain || host.endsWith(`.${domain}`);
}

function cookieMatches(cookie, url) {
  if (!cookieDomainMatches(cookie, url)) return false;
  const cookiePath = String(cookie?.path || '/');
  const pathMatches = url.pathname === cookiePath || url.pathname.startsWith(
    cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`,
  );
  if (!pathMatches || (cookie?.secure && url.protocol !== 'https:')) return false;
  return !cookie?.expirationDate || Number(cookie.expirationDate) > Date.now() / 1000;
}

function cookieHeader(cookies, url) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => cookieMatches(cookie, url))
    .filter((cookie) => /^[^=;\s\u0000-\u001f]+$/.test(String(cookie.name || ''))
      && !/[\r\n\u0000]/.test(String(cookie.value || '')))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

function safeRequestHeader(value, maxLength) {
  const text = String(value || '').trim();
  return text && text.length <= maxLength && !/[\r\n\u0000]/.test(text) ? text : '';
}

function downloadRequestHeaders(input, current) {
  const headers = { Accept: '*/*' };
  const cookie = cookieHeader(input.cookies, current);
  if (cookie) headers.Cookie = cookie;
  const userAgent = safeRequestHeader(input.user_agent, 512);
  if (userAgent) headers['User-Agent'] = userAgent;
  try {
    const referer = normalizeUrl(input.referer);
    if (referer.href.length <= 4096) headers.Referer = referer.href;
  } catch (_) {}
  return headers;
}

async function discardResponse(response) {
  if (typeof response.body?.cancel === 'function') return response.body.cancel();
  response.body?.destroy?.();
}

async function fetchWithRedirects(fetchImpl, sourceUrl, input, signal, resolveHost) {
  let current = normalizeUrl(sourceUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (fetchImpl) await resolvePublicDownloadHost(current, resolveHost);
    const headers = downloadRequestHeaders(input, current);
    const response = fetchImpl
      ? await fetchImpl(current, { headers, redirect: 'manual', signal })
      : await secureDownloadFetch(current, { headers, signal }, resolveHost);
    if (response.status < 300 || response.status >= 400) return { response, finalUrl: current };
    const location = response.headers.get('location');
    if (!location || redirects === MAX_REDIRECTS) throw new Error('下载重定向次数过多或缺少目标地址');
    await discardResponse(response);
    current = normalizeUrl(new URL(location, current).href);
  }
  throw new Error('下载重定向次数过多');
}

function resolveTargetDirectory(sandboxDir, directory) {
  const resolved = resolveInside(sandboxDir, directory);
  fs.mkdirSync(resolved.target, { recursive: true });
  const realTarget = fs.realpathSync(resolved.target);
  resolveInside(sandboxDir, path.relative(sandboxDir, realTarget));
  return { ...resolved, target: realTarget };
}

function availableTarget(directory, fileName, overwrite) {
  const target = path.join(directory, fileName);
  if (overwrite || !fs.existsSync(target)) return target;
  const parsed = path.parse(fileName);
  for (let index = 1; index <= 9999; index += 1) {
    const candidate = path.join(directory, `${parsed.name} (${index})${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('同名下载文件过多');
}

async function writeResponseBody(response, tempPath, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error(`下载文件超过大小限制 ${maxBytes} bytes`);
  const handle = await fs.promises.open(tempPath, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of response.body || []) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new Error(`下载文件超过大小限制 ${maxBytes} bytes`);
      hash.update(buffer);
      await handle.write(buffer);
    }
  } finally {
    await handle.close();
  }
  return { size, sha256: hash.digest('hex') };
}

async function commitTempFile(tempPath, targetPath, overwrite) {
  if (overwrite) {
    await fs.promises.rm(targetPath, { force: true });
    return fs.promises.rename(tempPath, targetPath);
  }
  await fs.promises.link(tempPath, targetPath);
  await fs.promises.rm(tempPath, { force: true });
}

async function writeJsonAtomic(targetPath, value, overwrite) {
  const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.part`);
  try {
    await fs.promises.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await commitTempFile(tempPath, targetPath, overwrite);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
  }
}

function sessionFileName(session, requested) {
  if (requested) return sanitizeFileName(requested.endsWith('.json') ? requested : `${requested}.json`);
  let host = 'browser-session';
  try { host = new URL(session?.pageUrl || session?.url || '').hostname || host; } catch (_) {}
  return sanitizeFileName(`${host}-session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}

function createBrowserDownloadService(options = {}) {
  const configuredDir = path.resolve(String(options.sandboxDir || 'AI-Workspace'));
  fs.mkdirSync(configuredDir, { recursive: true });
  const sandboxDir = fs.realpathSync(configuredDir);
  const fetchImpl = options.fetchImpl || null;
  const resolveHost = options.resolveHost;

  async function download(input) {
    const maxBytes = Math.min(MAX_ALLOWED_BYTES, Math.max(1, Number(input.max_bytes) || DEFAULT_MAX_BYTES));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(300000, Math.max(1000, Number(input.timeout_ms) || 120000)));
    let tempPath = '';
    try {
      const { response, finalUrl } = await fetchWithRedirects(
        fetchImpl, input.url, input, controller.signal, resolveHost,
      );
      if (!response.ok) throw new Error(`下载请求失败: HTTP ${response.status}`);
      assertExpectedMediaResponse(response, String(input.media_type || ''));
      const directory = resolveTargetDirectory(sandboxDir, input.directory);
      const targetPath = availableTarget(directory.target, suggestedFileName(response, finalUrl, input.filename), input.overwrite === true);
      tempPath = path.join(directory.target, `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.part`);
      const written = await writeResponseBody(response, tempPath, maxBytes);
      await commitTempFile(tempPath, targetPath, input.overwrite === true);
      tempPath = '';
      return { success: true, action: 'download', file_name: path.basename(targetPath), relative_path: path.relative(sandboxDir, targetPath), absolute_path: targetPath, final_url: finalUrl.href, mime_type: response.headers.get('content-type') || '', ...written };
    } finally {
      clearTimeout(timer);
      if (tempPath) await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  async function saveSession(input) {
    if (!input.session || typeof input.session !== 'object') throw new Error('缺少要保存的 Cookie/Storage 会话数据');
    const directory = resolveTargetDirectory(sandboxDir, input.directory || 'sessions');
    const targetPath = availableTarget(directory.target, sessionFileName(input.session, input.filename), input.overwrite === true);
    await writeJsonAtomic(targetPath, input.session, input.overwrite === true);
    return { success: true, action: 'save_session', file_name: path.basename(targetPath), relative_path: path.relative(sandboxDir, targetPath), absolute_path: targetPath, cookie_count: Array.isArray(input.session.cookies) ? input.session.cookies.length : 0 };
  }

  return {
    execute: async (input = {}) => {
      const action = String(input.action || 'download').trim().toLowerCase();
      if (action === 'info') return { success: true, action, workspace_path: sandboxDir };
      if (action === 'download') return download(input);
      if (action === 'save_session') return saveSession(input);
      throw new Error(`未知下载操作: ${action}`);
    },
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  MAX_ALLOWED_BYTES,
  cookieHeader,
  createBrowserDownloadService,
  sanitizeFileName,
};
