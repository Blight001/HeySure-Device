const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app, dialog, BrowserWindow } = require('electron');

// ---- 下载相关全局变量 ----
const downloadPrefs = { file: null };
let lastDownloadDir = null;

// 下载处理：每个 session 只注册一次 will-download
const downloadedSessions = new WeakSet();
const pendingDownloadPaths = new Map(); // url -> absolute save path
const downloadWindowStates = new WeakMap();

// ---- 工具函数 ----
// 下载目录记忆：默认用上次选择的目录，但每次仍弹出对话框
function initDownloadPrefs() {
  try {
    downloadPrefs.file = path.join(app.getPath('userData'), 'download_prefs');
    try {
      const s = fs.readFileSync(downloadPrefs.file, 'utf8');
      const j = JSON.parse(s);
      lastDownloadDir = (j && typeof j.lastDownloadDir === 'string' && j.lastDownloadDir) || null;
    } catch (_) {
      try {
        const legacy = `${downloadPrefs.file}.json`;
        const s = fs.readFileSync(legacy, 'utf8');
        const j = JSON.parse(s);
        lastDownloadDir = (j && typeof j.lastDownloadDir === 'string' && j.lastDownloadDir) || null;
        fs.writeFileSync(downloadPrefs.file, JSON.stringify({ lastDownloadDir }, null, 2));
        try { fs.unlinkSync(legacy); } catch (_) {}
      } catch (_) {}
    }
  } catch (_) {}
}

// 设置/更新/持久化：persistLastDir的具体业务逻辑。
function persistLastDir(dir) {
  try {
    if (!dir) return;
    lastDownloadDir = dir;
    if (!downloadPrefs.file) downloadPrefs.file = path.join(app.getPath('userData'), 'download_prefs');
    fs.writeFileSync(downloadPrefs.file, JSON.stringify({ lastDownloadDir }, null, 2));
  } catch (_) {}
}

// 获取/读取/解析：getDefaultSavePath的具体业务逻辑。
function getDefaultSavePath(fileName) {
  try {
// 处理：base的具体业务逻辑。
    const base = (lastDownloadDir && typeof lastDownloadDir === 'string') ? lastDownloadDir : app.getPath('downloads');
    return path.join(base, fileName || 'download');
  } catch (_) {
    return fileName || 'download';
  }
}

// ---- 文件名/类型 辅助 ----
function safeFilename(name) {
  try {
    const INVALID = /[\\/:*?"<>|]/g; // Windows 非法字符
    let n = String(name || '').trim().replace(INVALID, '_');
    if (!n) n = 'download';
    // 去除尾部空格/点
    n = n.replace(/[\s.]+$/g, '');
    if (!n) n = 'download';
    // 控制长度
    if (n.length > 180) n = n.slice(0, 180);
    return n;
  } catch (_) { return 'download'; }
}

// 校验/保护：hasExt的具体业务逻辑。
function hasExt(name) {
  const b = path.basename(String(name||''));
  return /\.[A-Za-z0-9]{2,6}$/.test(b);
}

// 处理：mimeToExt的具体业务逻辑。
function mimeToExt(mime) {
  const m = String(mime||'').toLowerCase();
  const map = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/ogg': 'ogv',
    'video/quicktime': 'mov',
    'video/x-matroska': 'mkv',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/aac': 'aac',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/x-bmp': 'bmp',
    'image/bmp;': 'bmp',
    'image/svg+xml': 'svg',
    'image/tiff': 'tiff',
    'image/x-tiff': 'tiff',
    // 通用图片类型
    'image/': 'png', // 默认回退到png
  };
  // 精确匹配
  if (map[m]) return map[m];
  // 前缀匹配（用于处理变体类型）
  for (const [key, value] of Object.entries(map)) {
    if (m.startsWith(key)) return value;
  }
  return '';
}

// 处理：isVideoMime的具体业务逻辑。
function isVideoMime(mime) {
  const m = String(mime||'').toLowerCase();
  return m.startsWith('video/');
}

// 处理：extFromUrl的具体业务逻辑。
function extFromUrl(u) {
  try {
    const p = new URL(u).pathname;
    const b = p.split('/').pop() || '';
    const m = b.match(/\.([A-Za-z0-9]{2,6})$/);
    return m ? m[1].toLowerCase() : '';
  } catch (_) { return ''; }
}

const IMAGE_SIGNATURES = [
  { ext: 'png', parts: [[0, [0x89, 0x50, 0x4E, 0x47]]] },
  { ext: 'jpg', parts: [[0, [0xFF, 0xD8, 0xFF]]] },
  { ext: 'gif', parts: [[0, [0x47, 0x49, 0x46]]] },
  { ext: 'bmp', parts: [[0, [0x42, 0x4D]]] },
  { ext: 'webp', parts: [[0, [0x52, 0x49, 0x46, 0x46]], [8, [0x57, 0x45, 0x42, 0x50]]] },
  { ext: 'svg', parts: [[0, [0x3C, 0x73, 0x76, 0x67]]] },
  { ext: 'svg', parts: [[0, [0x3C, 0x3F, 0x78, 0x6D]]] },
  { ext: 'tiff', parts: [[0, [0x49, 0x49, 0x2A, 0x00]]] },
  { ext: 'tiff', parts: [[0, [0x4D, 0x4D, 0x00, 0x2A]]] },
];

function bufferMatchesSignature(buffer, parts) {
  return parts.every(([offset, bytes]) => bytes.every((byte, index) => buffer[offset + index] === byte));
}

// 从图片数据头部检测真实格式
function detectImageFormatFromData(buffer) {
  try {
    if (!buffer || buffer.length < 4) return '';
    return IMAGE_SIGNATURES.find((signature) => bufferMatchesSignature(buffer, signature.parts))?.ext || '';
  } catch (_) {
    return '';
  }
}

function getDownloadWindowState(win) {
  let state = downloadWindowStates.get(win);
  if (!state) {
    state = { originalTitle: '' };
    downloadWindowStates.set(win, state);
  }
  if (!state.originalTitle && typeof win.getTitle === 'function') state.originalTitle = win.getTitle() || '';
  return state;
}

function renderActiveDownloadProgress(win, state, percent, statusText) {
  const clamped = Math.max(0, Math.min(1, percent / 100));
  try { win.setProgressBar(clamped); } catch (_) {}
  const suffix = statusText ? ` · ${statusText}` : '';
  const rounded = Math.max(0, Math.min(100, Math.round(percent)));
  try { win.setTitle(`${state.originalTitle || 'AI-FREE'} - 下载中 ${rounded}%${suffix}`); } catch (_) {}
}

function clearWindowDownloadProgress(win, state) {
  try { win.setProgressBar(-1); } catch (_) {}
  if (state.originalTitle) {
    try { win.setTitle(state.originalTitle); } catch (_) {}
  }
}

// 处理：withExt的具体业务逻辑。
function withExt(name, ext) {
  const n = safeFilename(name);
  if (!ext) return n;
  if (hasExt(n)) return n; // 已有人为输入扩展名则尊重
  return `${n}.${ext}`;
}

// 规范化扩展名：将通用/错误的扩展名映射为合理值（例如 .image -> png）
function normalizeExt(ext) {
  try {
    if (!ext) return '';
    let e = String(ext || '').toLowerCase();
    e = e.replace(/^\./, '');
    if (!e) return '';
    if (e === 'image') return 'png'; // 某些右键保存会出现 .image，直接当 png 处理
    if (e === 'jpeg') return 'jpg';
    // 防止把长 mime 前缀误当作扩展名
    if (e.startsWith('image/')) return 'png';
    return e;
  } catch (_) { return ext; }
}

// 处理：dialogFiltersByExt的具体业务逻辑。
function dialogFiltersByExt(ext) {
  if (!ext) return [ { name: '所有文件', extensions: ['*'] } ];
  const typeMap = {
    mp4: 'MP4 视频', webm: 'WebM 视频', ogv: 'Ogg 视频', mov: 'QuickTime 视频', mkv: 'Matroska 视频',
    mp3: 'MP3 音频', ogg: 'Ogg 音频', wav: 'WAV 音频', aac: 'AAC 音频',
    jpg: 'JPEG 图片', jpeg: 'JPEG 图片', png: 'PNG 图片', webp: 'WebP 图片', gif: 'GIF 图片',
    bmp: 'BMP 图片', svg: 'SVG 图片', tiff: 'TIFF 图片',
  };
  const name = typeMap[ext] || `${ext.toUpperCase()} 文件`;
  return [ { name, extensions: [ext] }, { name: '所有文件', extensions: ['*'] } ];
}

// 获取/读取/解析：resolveDownloadWindow的具体业务逻辑。
function resolveDownloadWindow(wc) {
  try {
    const win = BrowserWindow.fromWebContents(wc);
    if (!win || win.isDestroyed()) return null;
    return win;
  } catch (_) {
    return null;
  }
}

// 设置/更新/持久化：setDownloadWindowProgress的具体业务逻辑。
function setDownloadWindowProgress(wc, percent, statusText = '') {
  const win = resolveDownloadWindow(wc);
  if (!win) return;

  try {
    const state = getDownloadWindowState(win);
    if (typeof percent === 'number' && Number.isFinite(percent) && percent >= 0) {
      renderActiveDownloadProgress(win, state, percent, statusText);
    } else {
      clearWindowDownloadProgress(win, state);
    }
  } catch (_) {}
}

function trackDownloadProgress(item, webContents) {
  if (!item || typeof item.on !== 'function') return;
  item.on('updated', () => {
    try {
      const received = typeof item.getReceivedBytes === 'function' ? item.getReceivedBytes() : 0;
      const total = typeof item.getTotalBytes === 'function' ? item.getTotalBytes() : 0;
      setDownloadWindowProgress(webContents, total > 0 ? Math.min(99.5, (received / total) * 100) : null, '正在下载');
    } catch (_) {}
  });
  item.once('done', () => clearDownloadWindowProgress(webContents));
}

function getDownloadItemUrls(item) {
  try {
    const mainUrl = typeof item.getURL === 'function' ? item.getURL() : '';
    const chain = typeof item.getURLChain === 'function' ? item.getURLChain() : [];
    return [mainUrl, ...(Array.isArray(chain) ? chain : [])].filter(Boolean);
  } catch (_) {
    return [];
  }
}

function applyPendingDownloadPath(item, urls) {
  const url = urls.find((candidate) => pendingDownloadPaths.has(candidate));
  if (!url) return false;
  try { item.setSavePath(pendingDownloadPaths.get(url)); } catch (_) {}
  urls.forEach((candidate) => pendingDownloadPaths.delete(candidate));
  return true;
}

function inferDownloadExtension(item) {
  const mainUrl = typeof item.getURL === 'function' ? item.getURL() : '';
  const mime = typeof item.getMimeType === 'function' ? item.getMimeType() || '' : '';
  const rawName = typeof item.getFilename === 'function' ? item.getFilename() || 'download' : 'download';
  let ext = normalizeExt(mimeToExt(mime) || extFromUrl(mainUrl) || extFromUrl(rawName));
  if (!ext && mime.startsWith('image/')) {
    ext = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'tiff']
      .find((candidate) => rawName.toLowerCase().includes(`.${candidate}`)) || 'png';
  }
  const fileName = isVideoMime(mime) ? crypto.randomBytes(8).toString('hex') : rawName;
  return { ext: normalizeExt(ext), fileName };
}

async function handleWillDownload(item, webContents) {
  trackDownloadProgress(item, webContents);
  const urls = getDownloadItemUrls(item);
  if (applyPendingDownloadPath(item, urls)) return;
  const { ext, fileName } = inferDownloadExtension(item);
  const save = await dialog.showSaveDialog({
    title: '保存文件',
    defaultPath: getDefaultSavePath(withExt(fileName, ext)),
    filters: dialogFiltersByExt(ext),
  });
  if (save.canceled) {
    item.cancel();
    return;
  }
  item.setSavePath(save.filePath);
  persistLastDir(path.dirname(save.filePath));
}

// 停止/关闭/清理：clearDownloadWindowProgress的具体业务逻辑。
function clearDownloadWindowProgress(wc) {
  setDownloadWindowProgress(wc, -1);
}

// 下载处理：每个 session 只注册一次 will-download
function attachDownloadHandler(session) {
  try {
    if (!session || downloadedSessions.has(session)) return;
    session.on('will-download', (_event, item, webContents) => {
      void handleWillDownload(item, webContents).catch(() => {
        try { item.cancel(); } catch (_) {}
      });
    });
    downloadedSessions.add(session);
  } catch (_) {}
}

function normalizeDownloadOptions(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : { suggestedName: value };
}

async function saveRemoteMedia(wc, url, options) {
  const ext = normalizeExt(options.extHint || extFromUrl(url) || mimeToExt(options.mimeHint));
  const defaultName = withExt(crypto.randomBytes(8).toString('hex'), ext);
  const save = await dialog.showSaveDialog({ title: '保存文件', defaultPath: getDefaultSavePath(defaultName), filters: dialogFiltersByExt(ext) });
  if (save.canceled) return clearDownloadWindowProgress(wc);
  persistLastDir(path.dirname(save.filePath));
  pendingDownloadPaths.set(url, save.filePath);
  setDownloadWindowProgress(wc, 0, '正在准备下载');
  wc.downloadURL(url);
}

async function readLocalMedia(wc, url) {
  setDownloadWindowProgress(wc, 0, '正在读取媒体');
  return wc.executeJavaScript(`(async () => {
    try {
      const r = await fetch(${JSON.stringify(url)});
      const b = await r.blob();
      return { ok: true, data: Array.from(new Uint8Array(await b.arrayBuffer())), mime: b.type || '' };
    } catch (e) { return { ok: false, error: String(e) }; }
  })()`, true);
}

async function saveLocalMedia(wc, url, options) {
  const response = await readLocalMedia(wc, url);
  if (!response || !response.ok) throw new Error(response?.error || 'fetch 失败');
  const buffer = Buffer.from(response.data);
  const ext = normalizeExt(options.extHint || mimeToExt(response.mime) || mimeToExt(options.mimeHint))
    || detectImageFormatFromData(buffer)
    || 'png';
  const defaultName = withExt(crypto.randomBytes(8).toString('hex'), ext);
  const save = await dialog.showSaveDialog({ title: '保存媒体', defaultPath: getDefaultSavePath(defaultName), filters: dialogFiltersByExt(ext) });
  if (save.canceled) return clearDownloadWindowProgress(wc);
  fs.writeFileSync(save.filePath, buffer);
  persistLastDir(path.dirname(save.filePath));
  clearDownloadWindowProgress(wc);
}

// 处理：downloadOrSaveMedia的具体业务逻辑。
async function downloadOrSaveMedia(wc, url, suggestedNameOrOptions) {
  try {
    if (!wc || wc.isDestroyed() || !url) return;
// 处理：opts的具体业务逻辑。
    const options = normalizeDownloadOptions(suggestedNameOrOptions);
    attachDownloadHandler(wc.session);
    if (/^https?:/i.test(url)) {
      return saveRemoteMedia(wc, url, options);
    }
    return saveLocalMedia(wc, url, options);
  } catch (e) {
    console.warn('保存媒体失败:', e?.message || e);
    clearDownloadWindowProgress(wc);
  }
}

module.exports = {
  initDownloadPrefs,
  extFromUrl,
  downloadOrSaveMedia,
};
