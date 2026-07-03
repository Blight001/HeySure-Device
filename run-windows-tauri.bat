@echo off
setlocal EnableExtensions

rem One-click launcher for the Windows Tauri desktop prototype.
cd /d "%~dp0windows-tauri"

if exist "%USERPROFILE%\.cargo\bin" set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

set "VSDEVCMD=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\Common7\Tools\VsDevCmd.bat"
if exist "%VSDEVCMD%" (
  call "%VSDEVCMD%" -arch=x64 -host_arch=x64 >nul
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [error] npm was not found. Please install Node.js first.
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [error] cargo was not found. Please install Rust first.
  echo         Tauri requires the Rust toolchain to run the desktop shell.
  pause
  exit /b 1
)

where link >nul 2>nul
if errorlevel 1 (
  echo [error] MSVC linker link.exe was not found.
  echo         Please install Visual Studio Build Tools with the C++ desktop workload.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [setup] Installing frontend dependencies...
  call npm install
  if errorlevel 1 goto fail
)

echo [run] Starting HeySure Device Tauri prototype...
call npm run tauri:dev
if errorlevel 1 goto fail

exit /b 0

:fail
echo.
echo [failed] Tauri application failed to start.
pause
exit /b 1
