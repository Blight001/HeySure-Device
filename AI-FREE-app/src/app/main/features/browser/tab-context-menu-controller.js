'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const TAB_CONTEXT_MENU_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8" /><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.menu{display:flex;flex-direction:column;gap:4px;padding:6px;min-width:168px;box-sizing:border-box;background:rgba(17,20,28,.98);border:1px solid rgba(255,255,255,.10);border-radius:8px;box-shadow:0 14px 36px rgba(0,0,0,.34);backdrop-filter:blur(10px)}
button{appearance:none;border:0;background:transparent;color:#e6e8ee;font-size:12px;line-height:1.2;min-height:32px;padding:0 10px;border-radius:6px;text-align:left;cursor:pointer;white-space:nowrap;box-sizing:border-box}
button:hover{background:rgba(77,163,255,.18)}button:active{background:rgba(77,163,255,.28)}button.danger{color:#ffb4b4}button.danger:hover{background:rgba(255,82,82,.16)}button:disabled{cursor:default;opacity:.72}
.error{display:none;color:#ffb4b4;font-size:11px;line-height:1.3;max-height:28px;overflow:hidden;padding:2px 4px 0}.error.visible{display:block}
</style></head><body><div class="menu">
<button id="restart-btn" type="button">重启浏览器</button>
<button id="clear-btn" class="danger" type="button">清空浏览器数据</button>
<div id="error" class="error"></div></div>
<script>
const tabId=__TAB_ID__;const api=window.aiFree?.shell;
const restartBtn=document.getElementById('restart-btn');const clearBtn=document.getElementById('clear-btn');const errorEl=document.getElementById('error');
const restartText=restartBtn.textContent;const clearText=clearBtn.textContent;
const setLoading=(loading)=>{restartBtn.disabled=loading;clearBtn.disabled=loading;if(!loading){restartBtn.textContent=restartText;clearBtn.textContent=clearText;}};
const showError=(message)=>{errorEl.textContent=message||'操作失败';errorEl.classList.add('visible');};
const invoke=async(action)=>{const targetBtn=action==='restart'?restartBtn:clearBtn;const operation=action==='restart'?api?.restartBrowserRuntime:api?.clearBrowserRuntimeData;targetBtn.textContent=action==='restart'?'重启中...':'清理中...';setLoading(true);try{errorEl.classList.remove('visible');errorEl.textContent='';if(typeof operation!=='function')throw new Error('当前窗口不可用');const resp=await operation({profileId:tabId});if(!resp||resp.ok!==true)throw new Error((resp&&(resp.message||resp.error))||'操作失败');window.close();}catch(error){setLoading(false);showError(error&&(error.message||String(error)));}};
restartBtn.addEventListener('click',()=>invoke('restart'));clearBtn.addEventListener('click',()=>invoke('clear'));window.addEventListener('blur',()=>window.close());
</script></body></html>`;

function buildTabContextMenuHtml(tabId) {
  return TAB_CONTEXT_MENU_HTML.replace('__TAB_ID__', JSON.stringify(String(tabId || '')));
}

function resolveContextMenuBounds(parent, x, y) {
  const width = 168;
  const height = 92;
  const parentBounds = typeof parent.getBounds === 'function'
    ? parent.getBounds()
    : { x: 0, y: 0, width, height };
  const anchorX = parentBounds.x + Number(x || 0);
  const anchorY = parentBounds.y + Number(y || 0);
  const display = typeof screen.getDisplayNearestPoint === 'function'
    ? screen.getDisplayNearestPoint({ x: anchorX, y: anchorY })
    : screen.getPrimaryDisplay();
  const workArea = display?.workArea || { x: 0, y: 0, width: 1920, height: 1080 };
  const left = Math.min(Math.max(anchorX - 12, workArea.x + 8), workArea.x + workArea.width - width - 8);
  const top = Math.min(Math.max(anchorY + 8, workArea.y + 8), workArea.y + workArea.height - height - 8);
  return { x: Math.round(left), y: Math.round(top), width, height };
}

function createContextMenuWindow(parent, bounds) {
  return new BrowserWindow({
    ...bounds,
    frame: false,
    resizable: false,
    movable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    backgroundColor: '#11141c',
    transparent: true,
    parent,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      devTools: false,
      preload: path.join(__dirname, '../../preload.js'),
    },
  });
}

function createTabContextMenuController() {
  let popup = null;

  const closeTabContextMenuWindow = () => {
    if (popup && !popup.isDestroyed()) {
      try { popup.close(); } catch (_) {}
    }
    popup = null;
  };

  /** @param {Record<string, any>} [options] */
  const openTabContextMenuWindow = ({ tabId, x = 0, y = 0, parentWindow = null } = {}) => {
    try {
      closeTabContextMenuWindow();
      const parent = parentWindow && !parentWindow.isDestroyed() ? parentWindow : null;
      if (!parent) return false;
      popup = createContextMenuWindow(parent, resolveContextMenuBounds(parent, x, y));
      const current = popup;
      current.on('closed', () => { if (popup === current) popup = null; });
      current.on('blur', closeTabContextMenuWindow);
      current.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildTabContextMenuHtml(tabId))}`);
      current.once('ready-to-show', () => {
        try { if (!current.isDestroyed()) current.show(); } catch (_) {}
      });
      return true;
    } catch (error) {
      console.warn('[UI] 打开浏览器菜单窗口失败:', error?.message || error);
      closeTabContextMenuWindow();
      return false;
    }
  };

  return { closeTabContextMenuWindow, openTabContextMenuWindow };
}

module.exports = { createTabContextMenuController };
