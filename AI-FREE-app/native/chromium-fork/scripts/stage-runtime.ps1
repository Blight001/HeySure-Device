. (Join-Path $PSScriptRoot 'common.ps1')

$destination = Join-Path $script:RepoRoot 'resources\chromium'
$sourceExe = Join-Path $script:OutputRoot 'chrome.exe'
if (-not (Test-Path $sourceExe)) { throw "Built Chromium executable not found: $sourceExe" }

$repoFullPath = [IO.Path]::GetFullPath($script:RepoRoot).TrimEnd('\') + '\'
$destinationFullPath = [IO.Path]::GetFullPath($destination).TrimEnd('\') + '\'
if (-not $destinationFullPath.StartsWith($repoFullPath, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to stage outside the app2.1 repository: $destinationFullPath"
}

$runtimeFiles = @(
  'chrome.exe', 'chrome.dll', 'chrome_elf.dll', 'chrome_proxy.exe',
  'chrome_pwa_launcher.exe', 'chrome_wer.dll', 'notification_helper.exe',
  'elevated_tracing_service.exe', 'elevation_service.exe',
  'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll',
  'libEGL.dll', 'libGLESv2.dll', 'vk_swiftshader.dll',
  'vk_swiftshader_icd.json', 'vulkan-1.dll', 'eventlog_provider.dll',
  'icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin',
  'msvcp140.dll', 'msvcp140_atomic_wait.dll', 'vccorlib140.dll',
  'vcruntime140.dll', 'vcruntime140_1.dll'
)
$runtimeDirectories = @('locales', 'resources', 'swiftshader', 'WidevineCdm', 'MEIPreload')
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Get-ChildItem -LiteralPath $destination -Force | Where-Object Name -ne 'README.md' | Remove-Item -Recurse -Force

# Chromium sandboxed services run in an AppContainer and must be able to read
# the staged executable and resources. Copy-Item does not preserve the ACL that
# Chromium's build action applied to out/AI-Free, so establish an inheritable
# read/execute ACE on the distribution root before copying.
& icacls.exe $destination /grant '*S-1-15-2-2:(OI)(CI)(RX)' /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to set Chromium AppContainer ACL' }

foreach ($name in $runtimeFiles) {
  $source = Join-Path $script:OutputRoot $name
  if (Test-Path -LiteralPath $source -PathType Leaf) {
    Copy-Item -LiteralPath $source -Destination $destination -Force
  }
}
Get-ChildItem -LiteralPath $script:OutputRoot -File | Where-Object {
  $_.Extension -in @('.pak', '.manifest')
} | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
}
foreach ($name in $runtimeDirectories) {
  $source = Join-Path $script:OutputRoot $name
  if (Test-Path -LiteralPath $source -PathType Container) {
    Copy-Item -LiteralPath $source -Destination (Join-Path $destination $name) -Recurse -Force
  }
}
Get-ChildItem -LiteralPath $script:OutputRoot -Directory | Where-Object {
  $_.Name -match '^\d+\.\d+\.\d+\.\d+$'
} | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination $destination -Recurse -Force
}
Copy-Item -LiteralPath $sourceExe -Destination (Join-Path $destination 'ai-free-browser.exe') -Force

# Apply the same ACE recursively for files that retained explicit source ACLs.
& icacls.exe $destination /grant '*S-1-15-2-2:(OI)(CI)(RX)' /T /C | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to propagate Chromium AppContainer ACL' }

foreach ($required in @(
    'ai-free-browser.exe', 'chrome.dll', 'chrome_elf.dll', 'resources.pak',
    'icudtl.dat', 'v8_context_snapshot.bin', 'locales\zh-CN.pak',
    'resources')) {
  if (-not (Test-Path -LiteralPath (Join-Path $destination $required))) {
    throw "Staged runtime is incomplete (missing $required)"
  }
}

& node.exe (Join-Path $script:RepoRoot 'scripts\chromium-runtime-manifest.js') $destination
if ($LASTEXITCODE -ne 0) { throw 'Failed to generate Chromium runtime integrity manifest' }
Write-Host "Complete Chromium runtime staged at $destination"
