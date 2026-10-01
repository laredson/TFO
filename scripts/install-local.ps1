param([string]$CodexCommand = 'codex')
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$marketplace = Join-Path $repoRoot '.agents/plugins/marketplace.json'
$plugin = Join-Path $repoRoot 'plugins/tfo'
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$cacheRoot = [IO.Path]::GetFullPath((Join-Path $codexDir 'plugins/cache/tfo-local/tfo'))
$backupRoot = Join-Path $repoRoot ('.tfo/rollback/install-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))
$saved = @()
if (-not (Test-Path -LiteralPath $marketplace -PathType Leaf)) { throw 'TFO marketplace is missing' }
if (-not (Test-Path -LiteralPath (Join-Path $plugin '.codex-plugin/plugin.json') -PathType Leaf)) { throw 'TFO manifest is missing' }
$manifest = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $plugin '.codex-plugin/plugin.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne 'tfo' -or $manifest.version -notmatch '^1\.0\.0-rc\.2(?:\+.*)?$') { throw 'Unexpected TFO package identity' }
foreach ($entry in @(Get-ChildItem -LiteralPath $cacheRoot -Directory -ErrorAction SilentlyContinue)) {
  $resolved = [IO.Path]::GetFullPath($entry.FullName)
  if (-not $resolved.StartsWith($cacheRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected TFO cache path' }
  if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a linked TFO cache directory' }
  $installed = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $resolved '.codex-plugin/plugin.json') -Raw | ConvertFrom-Json
  if ($installed.name -ne 'tfo' -or $installed.version -ne $entry.Name) { throw 'Unexpected installed TFO package identity' }
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  $snapshot = Join-Path $backupRoot $entry.Name
  Copy-Item -LiteralPath $resolved -Destination $snapshot -Recurse
  $saved += [pscustomobject]@{ Original = $resolved; Snapshot = $snapshot }
}
& node (Join-Path $repoRoot 'scripts/build-plugin.mjs')
if ($LASTEXITCODE -ne 0) { throw 'TFO bundle build failed' }
try {
  & $CodexCommand plugin marketplace add $repoRoot
  if ($LASTEXITCODE -ne 0) { throw 'TFO marketplace registration failed' }
  & $CodexCommand plugin add tfo@tfo-local
  if ($LASTEXITCODE -ne 0) { throw 'TFO plugin installation failed' }
} finally {
  foreach ($item in $saved) {
    if (-not (Test-Path -LiteralPath $item.Original)) { Copy-Item -LiteralPath $item.Snapshot -Destination $item.Original -Recurse }
  }
}
Write-Output "TFO installed from the local tfo-local marketplace. Previous TFO snapshots: $backupRoot"
