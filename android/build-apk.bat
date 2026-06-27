@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Build the Android agent APK.
rem Usage:
rem   build-apk.bat              builds debug APK
rem   build-apk.bat release      builds release APK
rem   build-apk.bat clean        cleans, then builds debug APK
rem   build-apk.bat release clean

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%" || exit /b 1

set "VARIANT=debug"
set "DO_CLEAN="
set "GRADLE_VERSION=8.7"

:parse_args
if "%~1"=="" goto parsed_args
if /I "%~1"=="debug" (
  set "VARIANT=debug"
  shift
  goto parse_args
)
if /I "%~1"=="release" (
  set "VARIANT=release"
  shift
  goto parse_args
)
if /I "%~1"=="clean" (
  set "DO_CLEAN=clean"
  shift
  goto parse_args
)
if /I "%~1"=="help" goto usage
if /I "%~1"=="/?" goto usage
echo Unknown argument: %~1
goto usage

:parsed_args
if /I "%VARIANT%"=="release" (
  set "BUILD_TASK=assembleRelease"
  set "APK_DIR=app\build\outputs\apk\release"
) else (
  set "BUILD_TASK=assembleDebug"
  set "APK_DIR=app\build\outputs\apk\debug"
)

call :select_java

set "JAVA_EXE="
if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" set "JAVA_EXE=%JAVA_HOME%\bin\java.exe"
if not defined JAVA_EXE (
  for /f "delims=" %%J in ('where java.exe 2^>nul') do if not defined JAVA_EXE set "JAVA_EXE=%%J"
)

if not defined JAVA_EXE (
  echo Java was not found.
  echo Install JDK 17 or set JAVA_HOME to a JDK folder, then run this again.
  exit /b 1
)

echo Using Java:
echo   %JAVA_EXE%

if not exist "local.properties" (
  if not defined ANDROID_HOME if not defined ANDROID_SDK_ROOT (
    echo Android SDK path was not found.
    echo Create local.properties with sdk.dir=YOUR_ANDROID_SDK_PATH or set ANDROID_HOME.
    exit /b 1
  )
)

call :select_compile_sdk

set "GRADLE_CMD="
if exist "gradlew.bat" (
  set "GRADLE_CMD=%SCRIPT_DIR%gradlew.bat"
)

if not defined GRADLE_CMD (
  for /f "delims=" %%G in ('where gradle.bat 2^>nul') do if not defined GRADLE_CMD set "GRADLE_CMD=%%G"
)
if not defined GRADLE_CMD (
  for /f "delims=" %%G in ('where gradle.exe 2^>nul') do if not defined GRADLE_CMD set "GRADLE_CMD=%%G"
)

if not defined GRADLE_CMD if exist "%SCRIPT_DIR%.gradle\bootstrap\gradle-%GRADLE_VERSION%\bin\gradle.bat" (
  set "GRADLE_CMD=%SCRIPT_DIR%.gradle\bootstrap\gradle-%GRADLE_VERSION%\bin\gradle.bat"
)

if not defined GRADLE_CMD (
  echo Gradle was not found. Downloading Gradle %GRADLE_VERSION% for this project...
  set "PS_EXE="
  if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
  if not defined PS_EXE if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" set "PS_EXE=%ProgramFiles%\PowerShell\7\pwsh.exe"
  if not defined PS_EXE (
    echo PowerShell was not found. Install Gradle %GRADLE_VERSION% or add Gradle to PATH.
    exit /b 1
  )

  "%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $version='%GRADLE_VERSION%'; $root=(Get-Location).Path; $dest=Join-Path $root '.gradle\bootstrap'; $zip=Join-Path $env:TEMP ('gradle-' + $version + '-bin.zip'); New-Item -ItemType Directory -Force -Path $dest | Out-Null; if (-not (Test-Path $zip)) { Invoke-WebRequest -Uri ('https://services.gradle.org/distributions/gradle-' + $version + '-bin.zip') -OutFile $zip; }; Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force;"
  if errorlevel 1 (
    echo Failed to download or extract Gradle.
    exit /b 1
  )

  if not exist "%SCRIPT_DIR%.gradle\bootstrap\gradle-%GRADLE_VERSION%\bin\gradle.bat" (
    echo Gradle bootstrap was extracted, but gradle.bat was not found.
    exit /b 1
  )
  set "GRADLE_CMD=%SCRIPT_DIR%.gradle\bootstrap\gradle-%GRADLE_VERSION%\bin\gradle.bat"
)

echo Building Android %VARIANT% APK...
call "%GRADLE_CMD%" --no-daemon %COMPILE_SDK_ARG% %DO_CLEAN% ":app:%BUILD_TASK%"
if errorlevel 1 exit /b 1

set "APK_PATH="
for /f "delims=" %%A in ('dir /b /s "%APK_DIR%\*.apk" 2^>nul') do set "APK_PATH=%%A"

if not defined APK_PATH (
  echo Build finished, but no APK was found under %APK_DIR%.
  exit /b 1
)

set "OUT_APK=%SCRIPT_DIR%HeySureAgent-%VARIANT%.apk"
copy /Y "%APK_PATH%" "%OUT_APK%" >nul
if errorlevel 1 exit /b 1

echo.
echo APK built successfully:
echo   %OUT_APK%
echo.
echo Original Gradle output:
echo   %APK_PATH%
if /I "%VARIANT%"=="release" (
  echo.
  echo Note: release APK may be unsigned unless a signingConfig is added.
)
exit /b 0

:usage
echo Usage:
echo   build-apk.bat [debug^|release] [clean]
exit /b 2

:select_java
set "SELECTED_JAVA_HOME="

if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\java.exe" (
  set "SELECTED_JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
)

if not defined SELECTED_JAVA_HOME if exist "%ProgramFiles%\Java\jdk-17\bin\java.exe" set "SELECTED_JAVA_HOME=%ProgramFiles%\Java\jdk-17"
if not defined SELECTED_JAVA_HOME if exist "%ProgramFiles%\Java\jdk-21\bin\java.exe" set "SELECTED_JAVA_HOME=%ProgramFiles%\Java\jdk-21"

for /f "delims=" %%J in ('dir /b /ad "%ProgramFiles%\Java\jdk-21*" 2^>nul') do if not defined SELECTED_JAVA_HOME set "SELECTED_JAVA_HOME=%ProgramFiles%\Java\%%J"
for /f "delims=" %%J in ('dir /b /ad "%ProgramFiles%\Java\jdk-17*" 2^>nul') do if not defined SELECTED_JAVA_HOME set "SELECTED_JAVA_HOME=%ProgramFiles%\Java\%%J"
for /f "delims=" %%J in ('dir /b /ad "%ProgramFiles%\Java\jdk-*" 2^>nul') do if not defined SELECTED_JAVA_HOME set "SELECTED_JAVA_HOME=%ProgramFiles%\Java\%%J"

if defined SELECTED_JAVA_HOME (
  set "JAVA_HOME=%SELECTED_JAVA_HOME%"
  set "PATH=%JAVA_HOME%\bin;%PATH%"
  exit /b 0
)

if defined JAVA_HOME if exist "%JAVA_HOME%\bin\java.exe" set "PATH=%JAVA_HOME%\bin;%PATH%"
exit /b 0

:select_compile_sdk
set "COMPILE_SDK_ARG="
if defined ANDROID_COMPILE_SDK (
  set "COMPILE_SDK_ARG=-Pandroid.compileSdk=%ANDROID_COMPILE_SDK%"
  exit /b 0
)

set "SDK_DIR="
if exist "local.properties" (
  for /f "tokens=1,* delims==" %%A in ('findstr /b /c:"sdk.dir=" local.properties 2^>nul') do set "SDK_DIR=%%B"
)
if not defined SDK_DIR if defined ANDROID_HOME set "SDK_DIR=%ANDROID_HOME%"
if not defined SDK_DIR if defined ANDROID_SDK_ROOT set "SDK_DIR=%ANDROID_SDK_ROOT%"
if not defined SDK_DIR exit /b 0

set "SDK_DIR=%SDK_DIR:\:=:%"
if exist "%SDK_DIR%\platforms\android-34\android.jar" exit /b 0

for %%S in (36 35 34 33) do (
  if not defined COMPILE_SDK_ARG if exist "%SDK_DIR%\platforms\android-%%S\android.jar" (
    set "COMPILE_SDK_ARG=-Pandroid.compileSdk=%%S"
    echo Android SDK platform 34 is missing or incomplete. Using compileSdk %%S.
  )
)
exit /b 0
