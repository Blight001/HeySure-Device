@echo off
setlocal EnableExtensions

cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo [error] npm was not found. Please install Node.js first.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [setup] Installing extension dependencies...
  call npm install
  if errorlevel 1 goto fail
)

echo [build] Building browser extension...
call npm run build
if errorlevel 1 goto fail

if not exist "dist\manifest.json" (
  echo [error] dist\manifest.json was not generated.
  goto fail
)

echo.
echo [done] Extension dist is ready:
echo %CD%\dist
echo.
echo In Chrome or Edge, choose "Load unpacked" and select the dist folder above.
pause
exit /b 0

:fail
echo.
echo [failed] Browser extension build failed.
pause
exit /b 1
