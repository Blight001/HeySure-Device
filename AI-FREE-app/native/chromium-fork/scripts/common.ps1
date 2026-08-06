$ErrorActionPreference = 'Stop'

$script:ForkRoot = Split-Path -Parent $PSScriptRoot
$script:NativeRoot = Split-Path -Parent $script:ForkRoot
$script:RepoRoot = Split-Path -Parent $script:NativeRoot
$script:Lock = Get-Content -Raw -Encoding UTF8 (Join-Path $script:ForkRoot 'version-lock.json') | ConvertFrom-Json
$script:SourceRoot = [string]$script:Lock.chromium.sourceRoot
$script:DepotToolsRoot = [string]$script:Lock.depotTools.root
$script:OutputRoot = Join-Path $script:SourceRoot ([string]$script:Lock.build.output)

function Set-ChromiumBuildEnvironment {
  $env:PATH = "$script:DepotToolsRoot;$env:PATH"
  $env:DEPOT_TOOLS_WIN_TOOLCHAIN = '0'
  $env:DEPOT_TOOLS_UPDATE = '0'
  $visualStudioInstallPath = [string]$script:Lock.toolchain.visualStudioInstallPath
  if ($visualStudioInstallPath) {
    # The Build Tools instance is intentionally installed at a short path.
    # Chromium's detector only probes Microsoft's default directories unless
    # an override is provided.
    $env:GYP_MSVS_OVERRIDE_PATH = $visualStudioInstallPath
    $env:vs2026_install = $visualStudioInstallPath
  }
  $env:LC_ALL = 'C'
  $env:LANG = 'C'
  $env:PYTHONUTF8 = '1'
  $env:GIT_CONFIG_COUNT = '2'
  $env:GIT_CONFIG_KEY_0 = 'http.version'
  $env:GIT_CONFIG_VALUE_0 = 'HTTP/1.1'
  $env:GIT_CONFIG_KEY_1 = 'http.sslBackend'
  $env:GIT_CONFIG_VALUE_1 = 'openssl'

  if ($env:AI_FREE_CHROMIUM_PROXY) {
    $env:HTTP_PROXY = $env:AI_FREE_CHROMIUM_PROXY
    $env:HTTPS_PROXY = $env:AI_FREE_CHROMIUM_PROXY
    $env:ALL_PROXY = $env:AI_FREE_CHROMIUM_PROXY
  }

  $pythonDeps = Join-Path (Split-Path -Parent $script:SourceRoot) 'pydeps'
  if (Test-Path $pythonDeps) {
    $env:PYTHONPATH = (@($pythonDeps, $script:DepotToolsRoot, $env:PYTHONPATH) |
      Where-Object { $_ }) -join ';'
  }
}

function Initialize-DepotTools {
  $pythonRelDirFile = Join-Path $script:DepotToolsRoot 'python3_bin_reldir.txt'
  if (-not (Test-Path $pythonRelDirFile)) {
    $bootstrapScript = Join-Path $script:DepotToolsRoot 'bootstrap\win_tools.bat'
    & cmd.exe /d /c $bootstrapScript
    if ($LASTEXITCODE -ne 0) {
      throw "depot_tools bootstrap failed with exit code $LASTEXITCODE"
    }
  }

  # Run the manifest ensure once before gclient starts parallel vpython hooks.
  # Without this serialization, a fresh Windows checkout can launch many
  # competing CIPD clients for the same .cipd_bin directory.
  $cipdSetupScript = Join-Path $script:DepotToolsRoot 'cipd_bin_setup.bat'
  & cmd.exe /d /c $cipdSetupScript
  if ($LASTEXITCODE -ne 0) {
    throw "depot_tools CIPD setup failed with exit code $LASTEXITCODE"
  }
}

function Invoke-Gclient {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

  $gclientPy = Join-Path $script:DepotToolsRoot 'gclient.py'
  $python = 'python'
  $pythonRelDirFile = Join-Path $script:DepotToolsRoot 'python3_bin_reldir.txt'
  if (Test-Path $pythonRelDirFile) {
    $pythonRelDir = (Get-Content -Raw $pythonRelDirFile).Trim()
    $depotPython = Join-Path (Join-Path $script:DepotToolsRoot $pythonRelDir) 'python3.exe'
    if (Test-Path $depotPython) { $python = $depotPython }
  }
  & $python $gclientPy @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "gclient failed with exit code $LASTEXITCODE"
  }
}

function Assert-LockedCheckout {
  if (-not (Test-Path (Join-Path $script:SourceRoot '.git'))) {
    throw "Chromium checkout not found: $script:SourceRoot"
  }
  $actual = (& git.exe -C $script:SourceRoot rev-parse HEAD).Trim()
  if ($actual -ne [string]$script:Lock.chromium.commit) {
    throw "Chromium commit mismatch: expected $($script:Lock.chromium.commit), actual $actual"
  }
}
