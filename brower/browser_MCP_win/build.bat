@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules call npm install
call npm run build
if errorlevel 1 exit /b %errorlevel%
echo.
echo Build complete. Load this directory in Chrome: %CD%\dist
