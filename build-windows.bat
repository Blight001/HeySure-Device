@echo off
setlocal EnableExtensions

rem One-click packaging for the Windows desktop agent.
rem - installs dependencies if needed
rem - builds the TypeScript/Electron app
rem - packages the installer into release\
cd /d "%~dp0windows"

where npm >nul 2>nul
if errorlevel 1 (
  echo [error] npm was not found. Please install Node.js first.
  pause
  exit /b 1
)

if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"

if not exist "node_modules" (
  echo [setup] Installing dependencies...
  call npm install
  if errorlevel 1 goto fail
)

echo [build] Compiling application...
call npm run build
if errorlevel 1 goto fail

echo [package] Creating Windows installer...
echo [package] (will auto-prepare bundled Python runtime - first time downloads ~100MB+ and installs packages)
call npm run package
if errorlevel 1 goto fail

if not exist "release" (
  echo [error] release\ was not generated.
  goto fail
)

echo.
echo [done] Windows package is ready:
echo %CD%\release
echo.
echo The installer output is inside the release folder.
pause
exit /b 0

:fail
echo.
echo [failed] Windows application packaging failed.
pause
exit /b 1
