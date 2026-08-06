'use strict';

/* eslint-disable max-lines-per-function -- popup HTML and lifecycle wiring stay co-located */

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { serializeBrowserHistory } = require('./browser-history-service');

function getPopupMainWindow(ui) {
  return ui && typeof ui.getMainWindow === 'function' ? ui.getMainWindow() : null;
}

function getPopupPayloadHistory(payload) {
  if (!payload || !Array.isArray(payload.history)) return [];
  return payload.history.filter((item) => item && item.id);
}

function createBrowserHistoryPopupController({ ui }) {
  let browserHistoryGestureWindow = null;
  let browserHistoryGestureSelectedId = '';
  const closeBrowserHistoryGestureWindow = () => {
    const popup = browserHistoryGestureWindow;
    browserHistoryGestureWindow = null;
    browserHistoryGestureSelectedId = '';
    if (!popup || popup.isDestroyed()) return;
    try { popup.close(); } catch (_) {}
  };

  const buildBrowserHistoryGestureHtml = (history = [], theme = 'dark') => {
    const safeHistoryJson = JSON.stringify(Array.isArray(history) ? history : []).replace(/</g, '\\u003c');
    const lightTheme = String(theme || '').trim() === 'light';
    return `<!DOCTYPE html>
<html class="${lightTheme ? 'light' : 'dark'}">
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .panel { width: 100%; height: 100%; padding: 7px; border: 1px solid rgba(90,164,255,.42); border-radius: 10px; background: rgba(17,22,32,.98); color: #e6e8ee; box-shadow: 0 18px 46px rgba(0,0,0,.48), inset 0 0 0 1px rgba(255,255,255,.04); }
    .light .panel { border-color: rgba(47,127,230,.28); background: rgba(255,255,255,.98); color: #1f3044; box-shadow: 0 18px 42px rgba(45,79,122,.20), inset 0 0 0 1px rgba(255,255,255,.72); }
    .title { height: 27px; padding: 3px 8px 8px; color: #9aa3b2; font-size: 11px; line-height: 16px; }
    .light .title, .light .url, .light .state { color: #6a7c91; }
    .item { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 3px 10px; width: 100%; height: 48px; padding: 7px 9px; border: 1px solid transparent; border-radius: 7px; background: transparent; color: inherit; text-align: left; }
    .item + .item { margin-top: 3px; }
    .item.selected { border-color: rgba(77,163,255,.56); background: rgba(77,163,255,.22); box-shadow: 0 5px 16px rgba(25,102,196,.16); }
    .light .item.selected { border-color: rgba(47,127,230,.38); background: rgba(47,127,230,.12); }
    .name, .url { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .name { align-self: end; font-size: 13px; font-weight: 600; }
    .url { grid-column: 1 / -1; color: #9aa3b2; font-size: 10px; }
    .state { align-self: end; color: #9aa3b2; font-size: 10px; }
    .state.open { color: #43bd70; }
    .message { padding: 20px 12px; color: #9aa3b2; font-size: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="panel">
    <div class="title">拖到浏览器上，松开即可打开</div>
    <div id="items"></div>
  </div>
  <script>
    const history = ${safeHistoryJson};
    const items = document.getElementById('items');
    if (!history.length) {
      const message = document.createElement('div');
      message.className = 'message';
      message.textContent = '暂无可打开的浏览器历史';
      items.appendChild(message);
    } else {
      for (const record of history) {
        const item = document.createElement('div');
        item.className = 'item';
        item.dataset.historyId = String(record.id || '');
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = String(record.name || '新建窗口');
        const state = document.createElement('span');
        state.className = 'state' + (record.isOpen ? ' open' : '');
        state.textContent = record.isActive ? '当前' : (record.isOpen ? '已打开' : '历史');
        const url = document.createElement('span');
        url.className = 'url';
        url.textContent = String(record.url || 'chrome://newtab/');
        item.append(name, state, url);
        items.appendChild(item);
      }
    }
    window.aiFree?.browser?.onHistoryGestureSelection?.((historyId) => {
      document.querySelectorAll('.item').forEach((item) => item.classList.toggle('selected', item.dataset.historyId === String(historyId || '')));
    });
  </script>
</body>
</html>`;
  };

  const showBrowserHistoryGestureWindow = (payload = {}) => {
    closeBrowserHistoryGestureWindow();
    const mainWindow = getPopupMainWindow(ui);
    if (!mainWindow || (typeof mainWindow.isDestroyed === 'function' && mainWindow.isDestroyed())) {
      return { ok: false, error: '主窗口不可用' };
    }

    const contentBounds = mainWindow.getContentBounds();
    const anchor = payload && payload.anchor && typeof payload.anchor === 'object' ? payload.anchor : {};
    const sourceHistory = getPopupPayloadHistory(payload);
    const popupWidth = Math.max(220, Math.min(320, contentBounds.width - 16));
    const anchorLeft = Number.isFinite(Number(anchor.left)) ? Number(anchor.left) : 8;
    const anchorRight = Number.isFinite(Number(anchor.right)) ? Number(anchor.right) : anchorLeft + 30;
    const anchorBottom = Number.isFinite(Number(anchor.bottom)) ? Number(anchor.bottom) : 35;
    const anchorCenterX = (anchorLeft + anchorRight) / 2;
    const desiredX = contentBounds.x + anchorCenterX - popupWidth / 2;
    const desiredY = contentBounds.y + anchorBottom + 6;
    const display = screen.getDisplayNearestPoint({ x: desiredX, y: desiredY });
    const maxBottom = Math.min(contentBounds.y + contentBounds.height - 8, display.workArea.y + display.workArea.height - 8);
    const availableHeight = Math.max(86, maxBottom - desiredY);
    const maxRows = Math.max(1, Math.floor((availableHeight - 48) / 51));
    const visibleHistory = sourceHistory.slice(0, maxRows);
    const popupHeight = visibleHistory.length
      ? Math.min(availableHeight, 48 + visibleHistory.length * 48 + Math.max(0, visibleHistory.length - 1) * 3)
      : Math.min(availableHeight, 92);
    const workAreaLeft = display.workArea.x + 8;
    const workAreaRight = display.workArea.x + display.workArea.width - 8;
    const x = Math.max(workAreaLeft, Math.min(desiredX, workAreaRight - popupWidth));
    const y = desiredY;
    const layout = {
      x: x - contentBounds.x,
      y: y - contentBounds.y,
      width: popupWidth,
      height: popupHeight,
      rows: visibleHistory.map((item, index) => ({
        id: String(item.id || ''),
        top: 34 + index * 51,
        bottom: 34 + index * 51 + 48,
      })),
    };

    const popup = new BrowserWindow({
      parent: mainWindow,
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(popupWidth),
      height: Math.round(popupHeight),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      maximizable: false,
      minimizable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        devTools: false,
        preload: path.join(__dirname, '../../preload.js'),
      },
    });
    browserHistoryGestureWindow = popup;
    popup.setIgnoreMouseEvents(true);
    popup.on('closed', () => {
      if (browserHistoryGestureWindow === popup) browserHistoryGestureWindow = null;
    });
    popup.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildBrowserHistoryGestureHtml(visibleHistory, payload?.theme))}`);
    popup.once('ready-to-show', () => {
      if (browserHistoryGestureWindow !== popup || popup.isDestroyed()) return;
      try {
        popup.showInactive();
        popup.webContents.send('browser-history-gesture-selection', browserHistoryGestureSelectedId);
      } catch (_) {}
    });
    return { ok: true, layout };
  };


  function updateSelection(payload = {}) {
    browserHistoryGestureSelectedId = String(payload?.historyId || '').trim();
    const popup = browserHistoryGestureWindow;
    if (!popup || popup.isDestroyed() || popup.webContents?.isDestroyed?.()) return;
    try { popup.webContents.send('browser-history-gesture-selection', browserHistoryGestureSelectedId); } catch (_) {}
  }

  return {
    close: closeBrowserHistoryGestureWindow,
    show: showBrowserHistoryGestureWindow,
    updateSelection,
  };
}

module.exports = { createBrowserHistoryPopupController };
