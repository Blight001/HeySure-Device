. (Join-Path $PSScriptRoot 'common.ps1')
Set-ChromiumBuildEnvironment

for ($attempt = 1; $attempt -le 40; $attempt++) {
  Write-Host "Chromium partial-clone checkout attempt $attempt/40"
  & git.exe -C $script:SourceRoot restore --source=HEAD :/
  if ($LASTEXITCODE -eq 0) {
    $missing = & git.exe -C $script:SourceRoot status --short --untracked-files=no
    if (-not $missing) {
      Write-Host 'Chromium working tree restored successfully'
      exit 0
    }
  }
  Start-Sleep -Seconds ([math]::Min(30, 5 + $attempt))
}
throw 'Chromium working tree restore exhausted 40 retry attempts'
