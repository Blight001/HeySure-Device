. (Join-Path $PSScriptRoot 'common.ps1')
Set-ChromiumBuildEnvironment
Initialize-DepotTools

if (-not (Test-Path (Join-Path $script:SourceRoot '.git'))) {
  throw "Run depot_tools fetch first; checkout not found: $script:SourceRoot"
}

& git.exe -C $script:SourceRoot cat-file -e "$($script:Lock.chromium.commit)^{commit}" 2>$null
if ($LASTEXITCODE -ne 0) {
  & git.exe -C $script:SourceRoot fetch origin "refs/tags/$($script:Lock.chromium.version):refs/tags/$($script:Lock.chromium.version)"
  if ($LASTEXITCODE -ne 0) { throw 'Unable to fetch locked Chromium tag' }
}
$actualCommit = (& git.exe -C $script:SourceRoot rev-parse HEAD).Trim()
if ($actualCommit -ne [string]$script:Lock.chromium.commit) {
  & git.exe -C $script:SourceRoot checkout --detach ([string]$script:Lock.chromium.commit)
  if ($LASTEXITCODE -ne 0) { throw 'Unable to checkout locked Chromium commit' }
} else {
  Write-Host "Chromium already at locked commit; skipping redundant checkout"
}
Push-Location (Split-Path -Parent $script:SourceRoot)
try {
  Invoke-Gclient sync -D --no-history --revision "src@$($script:Lock.chromium.commit)"
} finally {
  Pop-Location
}
Assert-LockedCheckout
