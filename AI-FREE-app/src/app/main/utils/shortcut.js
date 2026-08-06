const fs = require('fs');
const path = require('path');
const { app, dialog, shell } = require('electron');
const { resolveAppIconPath } = require('./app-icon');

// 获取/读取/解析：getProductDisplayName的具体业务逻辑。
function getProductDisplayName() {
  try {
    // 优先使用 build.productName（打包时定义为中文名称），回退到 package.json.name 或 app.getName()
    let productName = null;
    try {
      const pkg = require(path.join(__dirname, '../../../../package.json'));
      if (pkg && pkg.build && pkg.build.productName) productName = pkg.build.productName;
      if (!productName && pkg && pkg.productName) productName = pkg.productName;
      if (!productName && pkg && pkg.name) productName = pkg.name;
    } catch (_) {}
    if (!productName) {
      try { productName = app.getName(); } catch (_) { productName = '应用'; }
    }
    return String(productName || '应用');
  } catch (_) { return '应用'; }
}

// 获取/读取/解析：getDesktopShortcutPath的具体业务逻辑。
function getDesktopShortcutPath() {
  try {
    const desktopDir = app.getPath('desktop');
    const name = getProductDisplayName();
    if (process.platform === 'win32') {
      return path.join(desktopDir, `${name}.lnk`);
    } else if (process.platform === 'linux') {
      return path.join(desktopDir, `${name}.desktop`);
    } else if (process.platform === 'darwin') {
      // Mac: 通常不在桌面上创建 .app 快捷方式，这里返回 null 表示不处理
      return null;
    }
    return null;
  } catch (_) { return null; }
}

// 创建/初始化：createLinuxDesktopFile的具体业务逻辑。
async function createLinuxDesktopFile(shortcutPath) {
  try {
    if (!shortcutPath) return false;
    const execPath = process.execPath || '';
    const iconPath = resolveAppIconPath();
    const content = [
      '[Desktop Entry]',
      `Name=${getProductDisplayName()}`,
      `Exec="${execPath}" %U`,
      'Type=Application',
      `Icon=${iconPath}`,
      'Terminal=false',
      'Categories=Utility;'
    ].join('\n');
    await fs.promises.writeFile(shortcutPath, content, { mode: 0o755 });
    try { fs.chmodSync(shortcutPath, 0o755); } catch (_) {}
    return true;
  } catch (e) {
    console.warn('[Shortcut] 创建 .desktop 文件失败:', e?.message || e);
    return false;
  }
}

// 校验/保护：checkDesktopShortcutAndPrompt的具体业务逻辑。
async function checkDesktopShortcutAndPrompt(parentWindow, sendToSide) {
  try {
    const productName = getProductDisplayName();
    const shortcutPath = getDesktopShortcutPath();
    if (!shortcutPath) return;
    // 如果已存在则不提示
    if (fs.existsSync(shortcutPath)) return;

    // 发送消息到渲染进程显示弹窗询问用户
    if (sendToSide) {
      sendToSide('desktop-shortcut-prompt', {
        productName,
        message: `桌面上未找到 "${productName}" 的快捷方式，是否创建？`
      });
    } else {
      console.warn('[Shortcut] sendToSide 函数不可用，无法显示快捷方式创建提示');
    }

  } catch (e) {
    console.warn('[Shortcut] 检查快捷方式异常:', e?.message || e);
  }
}

function createWindowsDesktopShortcut(shortcutPath) {
  try {
    const exe = process.execPath;
    const icon = resolveAppIconPath();
    const productName = getProductDisplayName();
    let args = '';
    try {
      if (!app.isPackaged) args = `"${app.getAppPath()}"`;
    } catch (_) {}
    /** @type {any} */
    const shortcutOptions = {
      target: exe,
      args,
      description: productName,
      icon: fs.existsSync(icon) ? icon : undefined,
      iconIndex: 0,
      workingDirectory: path.dirname(exe),
    };
    const ok = shell.writeShortcutLink(shortcutPath, 'create', shortcutOptions);
    if (!ok) throw new Error('writeShortcutLink 返回 false');
    console.log('[Shortcut] Windows 桌面快捷方式创建成功');
    return { ok: true };
  } catch (error) {
    console.warn('[Shortcut] 创建 Windows 快捷方式失败:', error?.message || error);
    return { ok: false, error: error.message };
  }
}

async function createLinuxDesktopShortcut(shortcutPath) {
  const ok = await createLinuxDesktopFile(shortcutPath);
  if (ok) {
    console.log('[Shortcut] Linux 桌面快捷方式创建成功');
    return { ok: true };
  }
  return { ok: false, error: '无法在桌面创建 .desktop 文件' };
}

// 实际创建桌面快捷方式的函数（供IPC调用）
async function createDesktopShortcut() {
  try {
    const shortcutPath = getDesktopShortcutPath();
    if (!shortcutPath) {
      return { ok: false, error: '不支持的平台' };
    }

    // 如果已存在则不创建
    if (fs.existsSync(shortcutPath)) {
      console.log('[Shortcut] 桌面快捷方式已存在，跳过创建');
      return { ok: true };
    }

    if (process.platform === 'win32') return createWindowsDesktopShortcut(shortcutPath);
    if (process.platform === 'linux') return createLinuxDesktopShortcut(shortcutPath);
    console.log('[Shortcut] macOS 平台跳过桌面快捷方式创建');
    return { ok: true };
  } catch (e) {
    console.warn('[Shortcut] 创建桌面快捷方式异常:', e?.message || e);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  checkDesktopShortcutAndPrompt,
  createDesktopShortcut
};
