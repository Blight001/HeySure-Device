@echo off
setlocal EnableExtensions EnableDelayedExpansion
title AI-FREE Build

pushd "%~dp0" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Failed to enter the project directory.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [ERROR] npm was not found. Install Node.js first.
  popd >nul
  pause
  exit /b 1
)

echo ========================================
echo   AI-FREE Windows Installer Build
echo ========================================
echo [INFO] Packaged extension JavaScript will be obfuscated.
echo.

node -e "require.resolve('javascript-obfuscator')" >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Missing dependency: javascript-obfuscator
  echo         Run npm install first.
  popd >nul
  pause
  exit /b 1
)

rem Download proxy settings for Electron and electron-builder.
set "ELECTRON_GET_USE_PROXY=true"
set "GLOBAL_AGENT_HTTP_PROXY=http://127.0.0.1:7897"
set "GLOBAL_AGENT_HTTPS_PROXY=http://127.0.0.1:7897"
set "HTTP_PROXY=http://127.0.0.1:7897"
set "HTTPS_PROXY=http://127.0.0.1:7897"

call npm run build:win
set "EXIT_CODE=!ERRORLEVEL!"

echo.
if "!EXIT_CODE!"=="0" (
  echo [OK] Build completed. Installer output: appbuild
  node scripts/increment-package-version.js
  set "VERSION_EXIT_CODE=!ERRORLEVEL!"
  if not "!VERSION_EXIT_CODE!"=="0" (
    set "EXIT_CODE=!VERSION_EXIT_CODE!"
    echo [ERROR] Build succeeded, but package.json version bump failed.
  )
) else (
  echo [ERROR] Build failed with exit code: !EXIT_CODE!
)
popd >nul
pause
exit /b !EXIT_CODE!
