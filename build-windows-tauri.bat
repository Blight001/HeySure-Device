@echo off
setlocal EnableExtensions

rem One-click packaging for the Windows Tauri desktop prototype.
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
  echo         Tauri requires the Rust toolchain to build installers.
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

set "BUNDLE_DIR=%CD%\src-tauri\target\release\bundle"
set "NSIS_DIR=%BUNDLE_DIR%\nsis"

rem Keep the installer icon in sync with the app logo assets\desktop.png.
rem tauri icon regenerates src-tauri\icons\icon.ico from the software logo.
if exist "assets\desktop.png" (
  echo [icon] Syncing installer icon from app logo assets\desktop.png ...
  call npx tauri icon "assets\desktop.png" >nul 2>&1
  if errorlevel 1 (
    echo   [warn] icon sync failed; keeping existing icon.ico
  ) else (
    if exist "src-tauri\icons\android" rmdir /s /q "src-tauri\icons\android" >nul 2>&1
    if exist "src-tauri\icons\ios" rmdir /s /q "src-tauri\icons\ios" >nul 2>&1
    if exist "src-tauri\icons\icon.ico" copy /y "src-tauri\icons\icon.ico" "assets\icon.ico" >nul 2>&1
    echo   - Installer icon updated from app logo
  )
)

rem Clean any previous installers so only the current product build remains
rem (avoids leftover "HeySure Device (Tauri)_..." from earlier product names).
if exist "%NSIS_DIR%" (
  del /f /q "%NSIS_DIR%\*setup.exe" >nul 2>&1
)

echo [build] Creating Windows Tauri installer...
call npm run tauri:build
if errorlevel 1 goto fail

if not exist "%NSIS_DIR%" (
  echo [error] NSIS bundle output was not generated.
  goto fail
)

echo.
echo [success] Installer built successfully.
echo.

echo [clean] Removing unnecessary intermediate files...

rem 1. Remove raw release executable and debug symbols (already inside the installer)
if exist "src-tauri\target\release\heysure-device-tauri.exe" (
  del /f /q "src-tauri\target\release\heysure-device-tauri.exe" >nul 2>&1
  echo   - Removed raw exe
)
if exist "src-tauri\target\release\heysure_device_tauri.pdb" (
  del /f /q "src-tauri\target\release\heysure_device_tauri.pdb" >nul 2>&1
  echo   - Removed .pdb debug symbols
)

rem 2. Remove temporary NSIS script/build files
if exist "src-tauri\target\release\nsis" (
  rmdir /s /q "src-tauri\target\release\nsis" >nul 2>&1
  echo   - Removed temp nsis scripts
)

rem 3. Remove the large bundled\ folder (Python runtime is already embedded in the installer)
if exist "bundled" (
  rmdir /s /q "bundled" >nul 2>&1
  echo   - Removed bundled\ ^(embedded into installer^)
)

rem 4. Clean copied bundled inside target (if any)
if exist "src-tauri\target\release\_up_\bundled" (
  rmdir /s /q "src-tauri\target\release\_up_\bundled" >nul 2>&1
)
if exist "src-tauri\target\debug\_up_\bundled" (
  rmdir /s /q "src-tauri\target\debug\_up_\bundled" >nul 2>&1
)

echo [clean] Done.

echo.
echo [done] Windows Tauri installer is ready:
for %%F in ("%NSIS_DIR%\*setup.exe") do (
  echo   %%~fF   ^(%%~zF bytes^)
)
echo.
pause
exit /b 0

:fail
echo.
echo [failed] Windows Tauri packaging failed.
pause
exit /b 1
