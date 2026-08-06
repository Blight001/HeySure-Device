const { Menu, BrowserWindow, globalShortcut, clipboard } = require('electron');
const { extFromUrl } = require('./download');

// 全局快捷键管理器
const shortcutManager = {
  // 当前注册的快捷键列表
  registeredShortcuts: new Set(),

  // 注册快捷键
  register(wc, dependencies = {}) {
    if (!wc || wc.isDestroyed()) return;

    const { refreshPage } = dependencies;

    // 避免重复注册
    this.unregister();

    try {
      // F5 - 刷新页面
      if (refreshPage) {
        globalShortcut.register('F5', () => {
          try {
            refreshPage();
          } catch (e) {
            console.warn('[Shortcut] F5 refresh failed:', e?.message || e);
          }
        });
        this.registeredShortcuts.add('F5');
      }

      // Ctrl+R - 刷新页面（备用）
      if (refreshPage) {
        globalShortcut.register('CommandOrControl+R', () => {
          try {
            refreshPage();
          } catch (e) {
            console.warn('[Shortcut] Ctrl+R refresh failed:', e?.message || e);
          }
        });
        this.registeredShortcuts.add('CommandOrControl+R');
      }

      // 编辑快捷键 - 通过DOM事件处理，不使用全局快捷键
      // 因为全局注册Ctrl+C/X/V会干扰正常的编辑行为

      // 可选：在开发环境下输出日志
      // process.env.NODE_ENV === 'development' && console.debug('[Shortcut] 已注册全局快捷键');
    } catch (e) {
      console.warn('[Shortcut] 注册快捷键失败:', e?.message || e);
    }
  },

  // 注销所有快捷键
  unregister() {
    try {
      for (const shortcut of this.registeredShortcuts) {
        globalShortcut.unregister(shortcut);
      }
      this.registeredShortcuts.clear();
      // 可选：在开发环境下输出日志
      // process.env.NODE_ENV === 'development' && console.debug('[Shortcut] 已注销全局快捷键');
    } catch (e) {
      console.warn('[Shortcut] 注销快捷键失败:', e?.message || e);
    }
  }
};

// 清除页面的注入记录，允许重新注入（用于页面刷新等场景）
function clearInjectionRecord() {}

async function isRendererContextMenuPoint(wc, params, selector) {
  if (!selector || !wc || wc.isDestroyed?.()) return false;
  const x = Number(params?.x);
  const y = Number(params?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const script = `(() => {
    const target = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
    return Boolean(target && target.closest(${JSON.stringify(selector)}));
  })()`;
  try {
    return await wc.executeJavaScript(script, true) === true;
  } catch (_) {
    return false;
  }
}

// 右键菜单功能 - 使用传统原生菜单
function attachContextMenu(wc, dependencies = {}) {
  const { addTab, downloadOrSaveMedia, tabs, activeTabId, refreshPage } = dependencies;

  try {
    if (!wc || wc.isDestroyed()) return;

    // 当webContents获得焦点时注册快捷键
    wc.on('focus', () => {
      shortcutManager.register(wc, dependencies);
    });

    // 当webContents失去焦点时注销快捷键
    wc.on('blur', () => {
      shortcutManager.unregister();
    });

    // 当webContents销毁时清理快捷键
    wc.on('destroyed', () => {
      shortcutManager.unregister();
    });

    // 监听右键菜单事件 - 使用最传统的原生菜单
    wc.on('context-menu', async (_event, params) => {
      const rendererOwnsMenu = await isRendererContextMenuPoint(
        wc,
        params,
        dependencies.rendererContextMenuSelector,
      );
      if (!rendererOwnsMenu) fallbackToNativeMenu(wc, params, dependencies);
    });
  } catch (_) {}
}



async function copyContextImage(wc, params) {
  try {
    if (wc && !wc.isDestroyed()) wc.copyImageAt(params.x, params.y);
  } catch (_) {
    try {
      if (wc && !wc.isDestroyed()) {
        const dataUrl = await wc.executeJavaScript(`(function(){
                  try {
                    const el = document.elementFromPoint(${params.x}, ${params.y});
                    const img = el && (el.closest && el.closest('img')) || (el && el.tagName && el.tagName.toLowerCase()==='img' && el);
                    if (!img) return false;
                    const c = document.createElement('canvas');
                    const w = img.naturalWidth || img.width || 0;
                    const h = img.naturalHeight || img.height || 0;
                    if (!w || !h) return false;
                    c.width = w; c.height = h;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);
                    return c.toDataURL('image/png') || '';
                  } catch(e){ return false; }
                })()`, true);
        if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
          const { nativeImage } = require('electron');
          const image = nativeImage.createFromDataURL(dataUrl);
          if (!image.isEmpty()) clipboard.writeImage(image);
        }
      }
    } catch (_) {}
  }
}

async function saveContextImage(wc, params, srcURL, downloadOrSaveMedia) {
  try {
    let url = srcURL;
    if (!url) {
      url = await wc.executeJavaScript(`(function(){ try { const el = document.elementFromPoint(${params.x}, ${params.y}); const m = el && (el.closest && el.closest('img, picture')) || (el && el.tagName && el.tagName.toLowerCase()==='img' && el); if (!m) return ''; const s = (m.currentSrc || m.src || (m.querySelector && (m.querySelector('source') && m.querySelector('source').src)) || ''); return s || ''; } catch(e){ return ''; } })()`, true);
    }
    if (url && downloadOrSaveMedia) await downloadOrSaveMedia(wc, url);
  } catch (_) {}
}

async function saveContextAudioVideo(wc, params, srcURL, mediaType, downloadOrSaveMedia) {
  try {
    const info = await wc.executeJavaScript(`(function(){
              try {
                const el = document.elementFromPoint(${params.x}, ${params.y});
                const m = el && (el.closest && el.closest('${mediaType}')) || (el && el.tagName && el.tagName.toLowerCase()==='${mediaType}' && el);
                if (!m) return { src: '', type: '' };
                const src = m.currentSrc || m.src || (m.querySelector && (m.querySelector('source') && m.querySelector('source').src)) || '';
                let type = '';
                try {
                  const sources = m.querySelectorAll ? Array.from(m.querySelectorAll('source')) : [];
                  for (const s of sources) { if (!src || s.src === src) { type = s.type || ''; break; } }
                } catch(_) {}
                return { src: src || '', type: type || '' };
              } catch(e){ return { src: '', type: ''}; }
            })()`, true);
    const finalUrl = info?.src || srcURL || '';
    if (!finalUrl || !downloadOrSaveMedia) return;
    const extHint = extFromUrl(finalUrl) || (mediaType === 'video' ? 'mp4' : '');
    await downloadOrSaveMedia(wc, finalUrl, { mimeHint: info?.type || '', extHint });
  } catch (_) {}
}

function pushContextLinkItems(template, linkURL, addTab) {
  if (!linkURL) return;
  template.push({
    label: '🔗 在新标签页打开链接', accelerator: 'CmdOrCtrl+Click',
    click: () => { try { addTab?.(linkURL); } catch (_) {} },
  }, { type: 'separator' });
}

function pushContextMediaItems(template, wc, params, srcURL, mediaType, downloadOrSaveMedia) {
  if (mediaType === 'image') {
    template.push(
      { label: '📋 复制图片', click: () => copyContextImage(wc, params) },
      { label: '💾 保存图片...', accelerator: 'CmdOrCtrl+S', click: () => saveContextImage(wc, params, srcURL, downloadOrSaveMedia) },
      { type: 'separator' },
    );
    return;
  }
  if (['video', 'audio'].includes(mediaType)) {
    template.push({
      label: mediaType === 'video' ? '🎬 下载视频...' : '🎵 下载音频...',
      accelerator: 'CmdOrCtrl+S',
      click: () => saveContextAudioVideo(wc, params, srcURL, mediaType, downloadOrSaveMedia),
    }, { type: 'separator' });
    return;
  }
  if (srcURL) {
    template.push({
      label: '💾 保存资源...', accelerator: 'CmdOrCtrl+S',
      click: async () => { try { await downloadOrSaveMedia?.(wc, srcURL); } catch (_) {} },
    }, { type: 'separator' });
  }
}

function pushEditRole(template, enabled, role, label, accelerator) {
  if (enabled) template.push({ role, label, accelerator });
}

function pushContextEditItems(template, params) {
  const editFlags = params.editFlags || {};
  if (!params.isEditable) {
    const hasSelection = Boolean(params.selectionText?.trim());
    pushEditRole(template, hasSelection && editFlags.canCopy, 'copy', '复制', 'CmdOrCtrl+C');
    return;
  }
  pushEditRole(template, editFlags.canUndo, 'undo', '撤销', 'CmdOrCtrl+Z');
  pushEditRole(template, editFlags.canRedo, 'redo', '重做', 'CmdOrCtrl+Y');
  if (template.at(-1)?.type !== 'separator') template.push({ type: 'separator' });
  pushEditRole(template, editFlags.canCut, 'cut', '剪切', 'CmdOrCtrl+X');
  pushEditRole(template, editFlags.canCopy, 'copy', '复制', 'CmdOrCtrl+C');
  pushEditRole(template, editFlags.canPaste, 'paste', '粘贴', 'CmdOrCtrl+V');
}

function httpContextUrl(value) {
  return value?.startsWith('http') ? value : '';
}

function fallbackToNativeMenu(wc, params, dependencies) {
  try {
    const template = [];
    const linkURL = httpContextUrl(params.linkURL);
    const srcURL = httpContextUrl(params.srcURL);
    pushContextLinkItems(template, linkURL, dependencies.addTab);
    pushContextMediaItems(template, wc, params, srcURL, params.mediaType || '', dependencies.downloadOrSaveMedia);
    template.push({
      label: '🔄 刷新页面', accelerator: 'F5',
      click: () => { try { dependencies.refreshPage?.(); } catch (_) {} },
    }, { type: 'separator' });
    pushContextEditItems(template, params);

    const menu = Menu.buildFromTemplate(template);
    if (menu) menu.popup({ window: BrowserWindow.fromWebContents(wc) });
  } catch (e) {
    console.warn('回退到原生菜单失败:', e?.message || e);
  }
}

module.exports = {
  attachContextMenu,
  clearInjectionRecord,
  isRendererContextMenuPoint,
  shortcutManager
};
