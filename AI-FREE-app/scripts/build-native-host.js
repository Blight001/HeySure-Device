'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const nativeRoot = path.join(root, 'native', 'browser-host');
const electronVersion = String(require(path.join(root, 'node_modules', 'electron', 'package.json')).version || '').trim();
const outputDir = path.join(nativeRoot, 'build', 'Release');
const outputFile = path.join(outputDir, 'browser_host.node');
const dpiTestFile = path.join(outputDir, 'dpi_scaling_test.exe');

function quote(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function findVsRoot() {
  const vswhereCandidates = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Visual Studio', 'Installer', 'vswhere.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Visual Studio', 'Installer', 'vswhere.exe'),
  ];
  for (const vswhere of vswhereCandidates) {
    if (!vswhere || !fs.existsSync(vswhere)) continue;
    const detected = spawnSync(vswhere, [
      '-latest', '-products', '*',
      '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property', 'installationPath',
    ], { encoding: 'utf8' });
    const detectedRoot = String(detected.stdout || '').trim();
    if (detected.status === 0 && fs.existsSync(path.join(detectedRoot, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'))) {
      return detectedRoot;
    }
  }
  const roots = [
    process.env.VSINSTALLDIR,
    'C:\\Program',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools',
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional',
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise',
  ].filter(Boolean);
  return roots.find((candidate) => fs.existsSync(path.join(candidate, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'))) || '';
}

function findElectronSdk() {
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'node-gyp', 'Cache', electronVersion);
  const includeDir = path.join(base, 'include', 'node');
  const nodeLib = path.join(base, 'x64', 'node.lib');
  if (fs.existsSync(path.join(includeDir, 'node_api.h')) && fs.existsSync(nodeLib)) {
    return { includeDir, nodeLib };
  }
  return null;
}

function runNodeGyp() {
  const nodeGyp = path.join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js');
  const result = spawnSync(process.execPath, [
    nodeGyp,
    'rebuild',
    `--target=${electronVersion}`,
    '--dist-url=https://electronjs.org/headers',
  ], { cwd: nativeRoot, stdio: 'inherit' });
  return result.status === 0 && fs.existsSync(outputFile);
}

function runManualMsvcBuild() {
  const vsRoot = findVsRoot();
  const sdk = findElectronSdk();
  if (!vsRoot || !sdk) {
    throw new Error(!vsRoot
      ? '未找到可用的 Visual Studio 2022 C++ Build Tools'
      : `未找到 Electron ${electronVersion} 的 node_api.h/node.lib 缓存`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const vcvars = path.join(vsRoot, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  const sources = [
    'src/addon.cc',
    'src/browser_host_window.cc',
    'src/child_window_manager.cc',
    'src/dpi_manager.cc',
    'src/focus_manager.cc',
    'src/process_monitor.cc',
    'src/win_delay_load_hook.cc',
  ].map((item) => path.join(nativeRoot, item));

  const envResult = spawnSync('cmd.exe', [
    '/d', '/s', '/c', `"call "${vcvars}" >nul && set"`,
  ], {
    cwd: nativeRoot,
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  });
  if (envResult.status !== 0) throw new Error('无法初始化 MSVC x64 编译环境');
  const msvcEnv = { ...process.env };
  for (const line of String(envResult.stdout || '').split(/\r?\n/)) {
    const separator = line.indexOf('=');
    if (separator > 0) msvcEnv[line.slice(0, separator)] = line.slice(separator + 1);
  }

  const compileArgs = [
    // 原生宿主会被安装到可能没有 VC++ Redistributable 的 Win10 机器。
    // 它不在 DLL 边界传递 C++ 对象，因此静态 CRT 既安全，也能避免
    // require(.node) 因 VCRUNTIME140_1.dll 缺失而报 ERROR_MOD_NOT_FOUND。
    '/nologo', '/LD', '/O2', '/EHsc', '/std:c++17', '/MT', '/utf-8',
    '/DNAPI_VERSION=9', '/DUNICODE', '/D_UNICODE', '/DWIN32_LEAN_AND_MEAN', '/DNOMINMAX',
    `/I${sdk.includeDir}`,
    ...sources,
    '/link', `/OUT:${outputFile}`, '/DELAYLOAD:node.exe', sdk.nodeLib,
    'delayimp.lib', 'user32.lib', 'gdi32.lib', 'dwmapi.lib',
  ];
  const testResult = spawnSync('cl.exe', [
    '/nologo', '/O2', '/EHsc', '/std:c++17', '/MT', '/utf-8',
    '/DUNICODE', '/D_UNICODE', '/DWIN32_LEAN_AND_MEAN', '/DNOMINMAX',
    path.join(nativeRoot, 'test', 'dpi_scaling_test.cc'),
    '/link', `/OUT:${dpiTestFile}`, 'user32.lib',
  ], { cwd: nativeRoot, env: msvcEnv, stdio: 'inherit' });
  if (testResult.status !== 0 || !fs.existsSync(dpiTestFile)) {
    throw new Error(`DPI 换算测试构建失败，退出码 ${testResult.status}`);
  }

  const result = spawnSync('cl.exe', compileArgs, {
    cwd: nativeRoot,
    env: msvcEnv,
    stdio: 'inherit',
  });
  if (result.status !== 0 || !fs.existsSync(outputFile)) {
    throw new Error(`MSVC 手动构建失败，退出码 ${result.status}`);
  }
}

function buildNativeHost() {
  console.log(`[native-host] Electron target: ${electronVersion}`);
  if (findVsRoot() && findElectronSdk()) {
    runManualMsvcBuild();
  } else if (!runNodeGyp()) {
    throw new Error('Native Host 构建失败：未找到可用的 node-gyp 或 MSVC/Electron SDK 组合');
  }
  console.log(`[native-host] 构建完成: ${outputFile}`);
}

if (require.main === module) {
  buildNativeHost();
}

module.exports = { buildNativeHost };
