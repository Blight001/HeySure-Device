'use strict';

const path = require('path');
const { app, BrowserWindow } = require('electron');

async function main() {
  const projectDir = path.resolve(__dirname, '..', '..', '..');
  const appOutDir = path.resolve(
    process.env.PACKAGED_APP_DIR || path.join(projectDir, 'appbuild', 'win-unpacked'),
  );
  const sidebarPath = process.env.SIDEBAR_HTML_PATH
    ? path.resolve(process.env.SIDEBAR_HTML_PATH)
    : path.join(
      appOutDir,
      'resources',
      'app.asar',
      'src',
      'app',
      'sidebar',
      'ai-control.html',
    );
  const appShellPath = process.env.SIDEBAR_HTML_PATH
    ? path.join(projectDir, 'src', 'app', 'views', 'app-shell.html')
    : path.join(
      appOutDir,
      'resources',
      'app.asar',
      'src',
      'app',
      'views',
      'app-shell.html',
    );
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  await window.loadFile(sidebarPath);
  const logos = await window.webContents.executeJavaScript(`(() => {
    return Array.from(document.querySelectorAll('img[data-app-logo]')).map((image) => ({
      src: image.src,
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
    }));
  })()`);
  if (logos.length !== 1 || logos.some((logo) => (
    !logo.complete || logo.naturalWidth <= 0 || logo.naturalHeight <= 0
  ))) {
    throw new Error('AI 控制页 Logo 无法加载');
  }
  const accountPath = path.join(path.dirname(sidebarPath), 'account-center.html');
  await window.loadFile(accountPath);
  const accountPanel = await window.webContents.executeJavaScript(`(() => {
    const panel = document.getElementById('account-center-panel');
    const card = document.getElementById('sidebar-account-session');
    return {
      active: !!panel && panel.classList.contains('active'),
      sameColumn: document.getElementById('announcement-bar')?.parentElement === card,
      footerPinnedToBottom: document.querySelector('.personal-footer')?.parentElement === panel,
      woolResourceBelowRedeem: document.querySelector('.sidebar-quota-redeem')?.nextElementSibling
        === document.querySelector('.account-wool-resource'),
      dialogShellRemoved: !document.getElementById('account-center-dialog')
        && !document.querySelector('.account-center-dialog-panel'),
    };
  })()`);
  if (Object.values(accountPanel).some((value) => value !== true)) {
    throw new Error(`打包后的个人中心栏目结构异常: ${JSON.stringify(accountPanel)}`);
  }
  await window.loadFile(appShellPath);
  const shellControls = await window.webContents.executeJavaScript(`(() => {
    const gear = document.getElementById('add-tab-btn');
    const theme = document.getElementById('theme-toggle-btn');
    const updateWidget = document.getElementById('update-widget');
    const createButton = document.getElementById('new-browser-window-btn');
    return {
      avatarRemoved: !document.getElementById('account-center-btn'),
      controlsOrdered: updateWidget?.nextElementSibling === theme && theme?.nextElementSibling === gear,
      modernGearIcon: !!gear?.querySelector('svg.settings-icon') && !gear.textContent.includes('⚙'),
      modernCreateIcon: !!createButton?.querySelector('svg.new-window-icon') && createButton.textContent.trim() === '',
    };
  })()`);
  console.log(JSON.stringify({ sidebarPath, accountPath, logos, accountPanel, appShellPath, shellControls }));
  if (Object.values(shellControls).some((value) => value !== true)) {
    throw new Error('主窗口顶部控件顺序、图标或个人中心头像移除异常');
  }
  window.destroy();
}

app.whenReady()
  .then(main)
  .then(() => app.quit())
  .catch((error) => {
    console.error(error?.stack || error);
    app.exit(1);
  });
