. (Join-Path $PSScriptRoot 'common.ps1')
Set-ChromiumBuildEnvironment
# icacls emits text in the active Windows ANSI code page. Forcing Python's
# UTF-8 mode makes Chromium's set_appcontainer_acls action fail on localized
# Windows installations, so restore native subprocess decoding for builds.
$env:PYTHONUTF8 = '0'

$argsSource = Join-Path $script:ForkRoot 'args.gn'
$argsTarget = Join-Path $script:OutputRoot 'args.gn'
New-Item -ItemType Directory -Force -Path $script:OutputRoot | Out-Null
Copy-Item -LiteralPath $argsSource -Destination $argsTarget -Force
Push-Location $script:SourceRoot
try {
  & gn gen ([string]$script:Lock.build.output) --fail-on-unused-args
  if ($LASTEXITCODE -ne 0) { throw 'gn gen failed' }
  $pythonRelDir = (Get-Content -Raw (Join-Path $script:DepotToolsRoot 'python3_bin_reldir.txt')).Trim()
  $depotPython = Join-Path (Join-Path $script:DepotToolsRoot $pythonRelDir) 'python3.exe'
  $autoninjaScript = Join-Path $script:DepotToolsRoot 'autoninja.py'
  & $depotPython $autoninjaScript -C ([string]$script:Lock.build.output) -j 16 ([string]$script:Lock.build.target)
  if ($LASTEXITCODE -ne 0) { throw 'Chromium build failed' }
} finally { Pop-Location }
