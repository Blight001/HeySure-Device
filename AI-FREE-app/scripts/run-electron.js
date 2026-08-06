const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function createElectronEnv(baseEnv = process.env) {
  const nextEnv = { ...baseEnv };
  delete nextEnv.ELECTRON_RUN_AS_NODE;
  nextEnv.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
  return nextEnv;
}

function checkElectronInstalled(electronDir) {
  const pathFile = path.join(electronDir, 'path.txt');
  const distDir = path.join(electronDir, 'dist');

  if (!fs.existsSync(pathFile)) {
    return false;
  }
  // Optional: also verify dist exists
  if (!fs.existsSync(distDir)) {
    return false;
  }
  return true;
}

function printInstallGuide() {
  console.error('');
  console.error('========================================');
  console.error('  Electron 安装不完整（缺少二进制文件）');
  console.error('========================================');
  console.error('');
  console.error('[原因] node_modules/electron 目录下没有 dist/ 和 path.txt');
  console.error('       通常是 npm install 时 Electron 二进制下载失败导致。');
  console.error('');
  console.error('[推荐修复步骤]（Windows）：');
  console.error('');
  console.error('PowerShell（推荐）：');
  console.error('  cd app2.1');
  console.error('  Remove-Item -Recurse -Force node_modules\\electron -ErrorAction SilentlyContinue');
  console.error('  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"');
  console.error('  npm install');
  console.error('');
  console.error('CMD：');
  console.error('  cd app2.1');
  console.error('  rd /s /q node_modules\\electron');
  console.error('  set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/');
  console.error('  npm install');
  console.error('');
  console.error('安装完成后，重新运行 v-start.bat 或 npm start');
  console.error('');
  console.error('提示：中国大陆用户使用 npmmirror 镜像可大幅提高下载成功率。');
  console.error('');
}

function main() {
  let cliPath = '';
  try {
    cliPath = require.resolve('electron/cli.js');
  } catch (error) {
    console.error('[electron-runner] 无法解析 electron/cli.js:', error?.message || error);
    process.exit(1);
    return;
  }

  const electronDir = path.dirname(cliPath);
  if (!checkElectronInstalled(electronDir)) {
    console.error('[electron-runner] 检测到 Electron 未正确安装。');
    printInstallGuide();
    process.exit(1);
    return;
  }

  const args = process.argv.slice(2);
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: process.cwd(),
    env: createElectronEnv(),
    stdio: 'inherit',
    windowsHide: true,
  });

  child.on('error', (error) => {
    console.error('[electron-runner] 启动 Electron 失败:', error?.message || error);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main();
