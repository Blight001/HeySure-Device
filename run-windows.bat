@echo off
setlocal

cd /d "%~dp0windows"

set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
rem Optional mouse calibration in screenshot pixels.
rem Mouse calibration is available in app Settings.
rem You can still override with HEYSURE_MOUSE_X_OFFSET / HEYSURE_MOUSE_Y_OFFSET before launch.
rem If clicks are consistently too far left/right, use HEYSURE_MOUSE_X_OFFSET.

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

echo Starting HeySure Agent Windows desktop app...
call npm run dev
