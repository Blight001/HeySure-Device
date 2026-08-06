'use strict';

const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const asar = require('@electron/asar');

const REQUIRED_CLASH_ASSETS = [
  'geoip.metadb',
  'geosite.dat',
  'country.mmdb',
  'providers/cn_ip.mrs',
  'providers/cn_domain.mrs',
  'providers/private_domain.mrs',
  'providers/geolocation-!cn.mrs',
];
const REQUIRED_WATCHDOG_FILES = [
  'entry.js',
  'launcher.js',
  'payload.js',
  'pending-store.js',
  'shared.js',
  'transport.js',
  'worker.js',
];

function verifyChromiumIntegrityManifest(chromiumDir) {
  const manifestPath = path.join(chromiumDir, 'runtime-manifest.json');
  assertFile(manifestPath, 64);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== 'object') {
    throw new Error(`Chromium 哈希清单格式无效: ${manifestPath}`);
  }
  for (const [relativePath, expected] of Object.entries(manifest.files)) {
    const filePath = path.join(chromiumDir, relativePath);
    assertFile(filePath, 1);
    const stat = fs.statSync(filePath);
    const actualHash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    if (stat.size !== Number(expected.size)
      || actualHash.toUpperCase() !== String(expected.sha256).toUpperCase()) {
      throw new Error(`Chromium 关键文件与哈希清单不一致: ${relativePath}`);
    }
  }
}

function assertFile(filePath, minimumSize = 1) {
  let size = 0;
  try { size = fs.statSync(filePath).size; } catch (_) {}
  if (size < minimumSize) {
    throw new Error(`打包资源缺失或不可用: ${filePath}（${size} bytes）`);
  }
  return size;
}

function assertPeX64(filePath) {
  assertFile(filePath, 128);
  const buffer = fs.readFileSync(filePath);
  if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    throw new Error(`不是有效的 Windows PE 文件: ${filePath}`);
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length
    || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0'
    || buffer.readUInt16LE(peOffset + 4) !== 0x8664) {
    throw new Error(`不是有效的 Windows x64 PE 文件: ${filePath}`);
  }
}

function assertStaticVCRuntime(filePath) {
  const image = fs.readFileSync(filePath).toString('latin1').toLowerCase();
  const dynamicDependencies = [
    'msvcp140.dll',
    'vcruntime140.dll',
    'vcruntime140_1.dll',
  ].filter((dll) => image.includes(dll));
  if (dynamicDependencies.length > 0) {
    throw new Error(
      `Native Browser Host 仍依赖未随程序安装的 VC++ 运行库: ${dynamicDependencies.join(', ')}; `
      + '请用 /MT 重新执行 npm run build:native-host',
    );
  }
}

function getFileMap(rootDir) {
  const result = new Map();
  const visit = (currentDir) => {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) {
        result.set(path.relative(rootDir, fullPath).replace(/\\/g, '/'), fs.statSync(fullPath).size);
      }
    }
  };
  visit(rootDir);
  return result;
}

function assertDirectoryMirror(sourceDir, targetDir, label) {
  const source = getFileMap(sourceDir);
  const target = getFileMap(targetDir);
  const mismatched = [];
  for (const [relativePath, size] of source) {
    if (target.get(relativePath) !== size) mismatched.push(relativePath);
  }
  if (source.size !== target.size || mismatched.length > 0) {
    throw new Error(
      `${label} 目录不完整: source=${source.size}, target=${target.size}, `
      + `mismatched=${mismatched.slice(0, 8).join(', ') || '(count mismatch)'}`,
    );
  }
  return source.size;
}

function configuredPackagedExtensions(projectDir) {
  const configPath = path.join(projectDir, 'platforms-config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(config.packagedExtensions)) {
    throw new Error('platforms-config.json 未配置 packagedExtensions');
  }
  return config.packagedExtensions;
}

function verifyExcludedPackagedExtensions(projectDir, unpackedRoot, selected) {
  const extensionsRoot = path.join(projectDir, 'src', 'assets', 'extensions');
  const selectedNames = new Set(selected);
  const available = fs.readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  for (const name of available) {
    if (name === 'clash-mini' || selectedNames.has(name)) continue;
    const packagedManifest = path.join(unpackedRoot, 'assets', 'extensions', name, 'manifest.json');
    if (fs.existsSync(packagedManifest)) throw new Error(`未选中的浏览器扩展仍被打包: ${name}`);
  }
}

function verifyUnpackedRuntimeFiles(projectDir, resourcesDir, extractDir) {
  const unpackedRoot = path.join(resourcesDir, 'app.asar.unpacked', 'src');
  const packagedExtensions = configuredPackagedExtensions(projectDir);
  for (const name of packagedExtensions) {
    const relative = path.join('assets', 'extensions', name, 'manifest.json');
    assertFile(path.join(projectDir, 'src', relative), 20);
    assertFile(path.join(unpackedRoot, relative), 20);
    assertFile(path.join(extractDir, 'src', relative), 20);
  }
  verifyExcludedPackagedExtensions(projectDir, unpackedRoot, packagedExtensions);
  for (const name of REQUIRED_WATCHDOG_FILES) {
    const watchdogRelative = path.join('app', 'main', 'runtime', 'crash-watchdog', name);
    assertFile(path.join(unpackedRoot, watchdogRelative), 128);
    assertFile(path.join(extractDir, 'src', watchdogRelative), 128);
  }
}

function verifyAsarIntegrity(projectDir, appOutDir) {
  const resourcesDir = path.join(appOutDir, 'resources');
  const archivePath = path.join(resourcesDir, 'app.asar');
  assertFile(archivePath, 1024);

  const archiveEntries = new Set(
    asar.listPackage(archivePath, { isPack: false }).map((entry) => entry.replace(/^[/\\]+/, '').replace(/\\/g, '/')),
  );
  for (const duplicate of [
    'native/browser-host/build/Release/browser_host.node',
    'src/assets/logo.ico',
  ]) {
    if (archiveEntries.has(duplicate)) {
      throw new Error(`不应重复写入 app.asar 的外置资源: ${duplicate}`);
    }
  }

  const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-asar-verify-'));
  try {
    // extractAll 会同时读取 app.asar.unpacked；任何被标记为 unpacked 但实际
    // 缺失的文件都会在这里直接失败，禁止继续生成安装包。
    asar.extractAll(archivePath, extractDir);
    verifyUnpackedRuntimeFiles(projectDir, resourcesDir, extractDir);
    const sidebarRoot = path.join(extractDir, 'src', 'app', 'sidebar');
    const sidebarPath = path.join(sidebarRoot, 'ai-control.html');
    const accountPath = path.join(sidebarRoot, 'account-center.html');
    const appShellPath = path.join(extractDir, 'src', 'app', 'views', 'app-shell.html');
    const logoResolverPath = path.join(
      extractDir,
      'src',
      'app',
      'sidebar',
      'client',
      'scripts',
      'logo-assets.js',
    );
    assertFile(sidebarPath, 128);
    assertFile(accountPath, 128);
    assertFile(appShellPath, 128);
    assertFile(logoResolverPath, 128);
    const sidebar = fs.readFileSync(sidebarPath, 'utf8');
    const account = fs.readFileSync(accountPath, 'utf8');
    const appShell = fs.readFileSync(appShellPath, 'utf8');
    const logoResolver = fs.readFileSync(logoResolverPath, 'utf8');
    if ((sidebar.match(/<img[^>]*data-app-logo/g) || []).length !== 1
      || (account.match(/<img[^>]*data-app-logo/g) || []).length !== 1
      || !sidebar.includes('<script src="./client/scripts/logo-assets.js"></script>')
      || !logoResolver.includes("const PACKAGED_LOGO_PATH = '../../../../resource/logo.ico';")) {
      throw new Error('侧边栏 Logo 未通过运行时解析器指向打包后的外置资源');
    }
    if (appShell.includes('id="account-center-btn"')
      || !appShell.includes('../sidebar/client/scripts/logo-assets.js')
      || (appShell.match(/<img[^>]*data-app-logo/g) || []).length !== 1
      || !appShell.includes('id="ai-free-settings-panel"')
      || !appShell.includes('id="automation-workbench"')
      || !sidebar.includes('data-tab="account-center-panel"')
      || !account.includes('id="account-center-panel"')) {
      throw new Error('独立个人中心页面缺失，或主窗口头像入口仍然存在');
    }
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function verifyPackagedRuntime(options = {}) {
  const projectDir = path.resolve(options.projectDir || path.join(__dirname, '..', '..', '..'));
  const appOutDir = path.resolve(options.appOutDir || process.argv[2] || path.join(projectDir, 'appbuild', 'win-unpacked'));
  const resourcesDir = path.join(appOutDir, 'resources');

  const nativeHostPath = path.join(resourcesDir, 'native', 'browser-host', 'browser_host.node');
  assertPeX64(nativeHostPath);
  assertStaticVCRuntime(nativeHostPath);
  assertPeX64(path.join(resourcesDir, 'chromium', 'ai-free-browser.exe'));
  assertFile(path.join(resourcesDir, 'chromium', 'chrome.dll'), 100 * 1024 * 1024);
  verifyChromiumIntegrityManifest(path.join(resourcesDir, 'chromium'));

  const logoPath = path.join(resourcesDir, 'resource', 'logo.ico');
  assertFile(logoPath, 128);
  const logoHeader = fs.readFileSync(logoPath).subarray(0, 4);
  if (!logoHeader.equals(Buffer.from([0, 0, 1, 0]))) {
    throw new Error(`不是有效的 ICO 文件: ${logoPath}`);
  }

  for (const relativePath of REQUIRED_CLASH_ASSETS) {
    const minimumSize = /^(?:geoip\.metadb|geosite\.dat)$/.test(relativePath)
      ? 1024 * 1024
      : 1;
    assertFile(path.join(resourcesDir, 'clash-mini', 'core', relativePath), minimumSize);
  }

  const chromiumCount = assertDirectoryMirror(
    path.join(projectDir, 'resources', 'chromium'),
    path.join(resourcesDir, 'chromium'),
    'Chromium',
  );
  verifyAsarIntegrity(projectDir, appOutDir);
  console.log(`[packaged-runtime] 校验通过: Chromium ${chromiumCount} 个文件，ASAR/unpacked/Watchdog/Extensions/Native/Logo/Clash 资源完整`);
  return { ok: true, chromiumCount, appOutDir };
}

if (require.main === module) {
  try {
    verifyPackagedRuntime();
  } catch (error) {
    console.error(`[packaged-runtime] ${error?.stack || error}`);
    process.exit(1);
  }
}

module.exports = { assertStaticVCRuntime, verifyPackagedRuntime };
