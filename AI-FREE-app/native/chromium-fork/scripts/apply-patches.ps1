. (Join-Path $PSScriptRoot 'common.ps1')
Set-ChromiumBuildEnvironment
Assert-LockedCheckout

if (& git.exe -C $script:SourceRoot status --porcelain --untracked-files=no) {
  throw 'Chromium tracked files must be clean before applying patches'
}
$series = Get-Content (Join-Path $script:ForkRoot 'patches\series') | Where-Object { $_ -and -not $_.StartsWith('#') }
foreach ($patchName in $series) {
  $patchPath = Join-Path $script:ForkRoot "patches\$patchName"
  if (-not (Test-Path $patchPath)) { throw "Patch missing: $patchPath" }
  # A blob-less Chromium partial clone cannot create a commit tree without
  # fetching every missing promisor blob. Apply each patch to the index first,
  # then materialize the final index once after the complete queue succeeds.
  # This also avoids CRLF worktree files conflicting with later overlapping
  # LF patch hunks on Windows. Git binary patches require LF syntax, so apply a
  # temporary normalized copy without rewriting the repository artifact.
  $temporaryPatch = Join-Path ([IO.Path]::GetTempPath()) (
    "ai-free-chromium-$PID-$([Guid]::NewGuid().ToString('N')).patch")
  try {
    $patchText = Get-Content -Raw -Encoding UTF8 $patchPath
    [IO.File]::WriteAllText(
      $temporaryPatch, $patchText.Replace("`r`n", "`n"),
      [Text.UTF8Encoding]::new($false))
    & git.exe -C $script:SourceRoot apply --cached $temporaryPatch
    if ($LASTEXITCODE -ne 0) { throw "Patch failed: $patchName" }
  } finally {
    Remove-Item -LiteralPath $temporaryPatch -Force -ErrorAction SilentlyContinue
  }
}

& git.exe -C $script:SourceRoot checkout-index --all --force
if ($LASTEXITCODE -ne 0) { throw 'Failed to materialize patched Chromium index' }

Write-Host "Applied $($series.Count) AI-FREE Chromium patches"
