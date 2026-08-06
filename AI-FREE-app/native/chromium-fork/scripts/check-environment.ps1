. (Join-Path $PSScriptRoot 'common.ps1')
Set-ChromiumBuildEnvironment

$drive = Get-PSDrive ([IO.Path]::GetPathRoot($script:SourceRoot).TrimEnd(':\'))
$freeGb = [math]::Round($drive.Free / 1GB, 2)
if ($freeGb -lt 100) { throw "Chromium build drive has only $freeGb GB free; at least 100 GB is required" }

$volume = Get-Volume -DriveLetter ([IO.Path]::GetPathRoot($script:SourceRoot).Substring(0, 1))
if ($volume.FileSystem -ne 'NTFS') { throw 'Chromium build drive must use NTFS' }

$vswhereCandidates = @(
  "$env:ProgramFiles\Microsoft Visual Studio\Installer\vswhere.exe",
  "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
)
$vswhere = $vswhereCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $vswhere) { throw 'Visual Studio 2026 Build Tools is not installed (vswhere.exe missing)' }
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json | ConvertFrom-Json
if (-not $vs -or [version]$vs.installationVersion -lt [version]'18.0') { throw 'Visual Studio Build Tools 2026 C++ workload is required' }

$sdkRc = 'C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\rc.exe'
if (-not (Test-Path $sdkRc)) { throw 'Windows 11 SDK 10.0.26100 is missing' }
$sdkVersion = (Get-Item $sdkRc).VersionInfo.FileVersionRaw
if ($sdkVersion -lt [version]'10.0.26100.7705') { throw "Windows SDK is too old: $sdkVersion" }
$debugger = 'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\dbgeng.dll'
if (-not (Test-Path $debugger)) {
  Write-Warning 'Windows SDK Debugging Tools are not installed; this build uses symbol_level=0 and does not emit large PDBs'
}

if (-not (Test-Path (Join-Path $script:DepotToolsRoot 'gclient.bat'))) { throw 'depot_tools is missing' }
$depotCommit = (& git.exe -C $script:DepotToolsRoot rev-parse HEAD).Trim()
if ($depotCommit -ne [string]$script:Lock.depotTools.commit) { throw "depot_tools commit mismatch: $depotCommit" }

$iconSource = Join-Path $script:RepoRoot ([string]$script:Lock.product.iconSource)
if (-not (Test-Path $iconSource)) { throw "AI-FREE icon source is missing: $iconSource" }
$iconSourceSha256 = (Get-FileHash -LiteralPath $iconSource -Algorithm SHA256).Hash
if ($iconSourceSha256 -ne [string]$script:Lock.product.iconSourceSha256) {
  throw "AI-FREE icon source hash mismatch: $iconSourceSha256"
}

[pscustomobject]@{
  SourceRoot = $script:SourceRoot
  FreeGB = $freeGb
  FileSystem = $volume.FileSystem
  VisualStudio = $vs.installationVersion
  WindowsSdk = $sdkVersion.ToString()
  DebuggingTools = if (Test-Path $debugger) { (Get-Item $debugger).VersionInfo.FileVersion } else { 'not installed (symbol_level=0)' }
  DepotTools = $depotCommit
  Chromium = $script:Lock.chromium.version
  IconSource = "$iconSource ($iconSourceSha256)"
} | Format-List
