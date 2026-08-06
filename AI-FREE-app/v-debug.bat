@echo off
setlocal EnableExtensions
chcp 65001 >nul
title AI-FREE HTTP Debug Launcher

pushd "%~dp0" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Failed to enter repo root.
  pause
  exit /b 1
)

rem Local debug target. Adjust to your own local service.
set "AI_FREE_SERVER_MODE=local"
set "SERVER_BASE=http://127.0.0.1:58111"
set "ACCOUNT_SERVICE_URL=http://127.0.0.1:58111/api/account"
set "PLATFORM=local"
set "DEBUG=1"
set "FORCE_HTTP_COMPAT_MODE=1"
set "SKIP_LICENSE_WINDOW="
set "FORCE_COLOR=1"

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] node not found. Please install Node.js first.
  popd >nul
  pause
  exit /b 1
)

@echo off

echo ========================================
echo   AI-FREE HTTP Debug Launcher
echo ========================================
echo Server base: %SERVER_BASE%
echo Mode: HTTP only
echo.

node scripts\run-electron.js .
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if "%EXIT_CODE%"=="0" (
  echo [OK] Launch complete.
) else (
  echo [ERROR] Launch failed, error code: %EXIT_CODE%
)
popd >nul
exit /b %EXIT_CODE%
