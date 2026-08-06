@echo off
setlocal EnableExtensions
chcp 65001 >nul
title AI-FREE Launcher

pushd "%~dp0" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Failed to enter repo root.
  pause
  exit /b 1
)

rem Production mode must not restore or accept a loopback backend saved by v-debug.bat.
set "AI_FREE_SERVER_MODE=remote"

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm not found. Please install Node.js first.
  popd >nul
  pause
  exit /b 1
)

if not exist "node_modules\electron\path.txt" (
  echo [ERROR] Electron 二进制未正确安装，请先在当前目录修复依赖：
  echo   Remove-Item -Recurse -Force node_modules\electron
  echo   $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  echo   npm install
  echo 安装完成后重新运行本脚本。
  popd >nul
  pause
  exit /b 1
)

echo ========================================
echo   AI-FREE Chromium Runtime Launcher  ^(npm start^)
echo ========================================
echo.

@call npm start
@set "EXIT_CODE=%ERRORLEVEL%"
@echo off

echo.
if "%EXIT_CODE%"=="0" (
  echo [OK] Launch complete.
) else (
  echo [ERROR] Launch failed, error code: %EXIT_CODE%
)
popd >nul
exit /b %EXIT_CODE%
