param([string]$CodexCommand = 'codex')
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$marketplace = Join-Path $repoRoot '.agents/plugins/marketplace.json'
$plugin = Join-Path $repoRoot 'plugins/tfo'
$codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$cacheRoot = [IO.Path]::GetFullPath((Join-Path $codexDir 'plugins/cache/tfo-local/tfo'))
$backupRoot = Join-Path $repoRoot ('.tfo/rollback/install-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))
$dataRoot = if ($env:TFO_DATA_DIR) { [IO.Path]::GetFullPath($env:TFO_DATA_DIR) } else { Join-Path $(if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { $env:USERPROFILE }) 'TFO/data' }
$saved = @()
if (-not (Test-Path -LiteralPath $marketplace -PathType Leaf)) { throw 'TFO marketplace is missing' }
if (-not (Test-Path -LiteralPath (Join-Path $plugin '.codex-plugin/plugin.json') -PathType Leaf)) { throw 'TFO manifest is missing' }
$manifest = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $plugin '.codex-plugin/plugin.json') -Raw | ConvertFrom-Json
if ($manifest.name -ne 'tfo' -or $manifest.version -notmatch '^1\.0\.0-rc\.3(?:\+.*)?$') { throw 'Unexpected TFO package identity' }
foreach ($entry in @(Get-ChildItem -LiteralPath $cacheRoot -Directory -ErrorAction SilentlyContinue)) {
  $resolved = [IO.Path]::GetFullPath($entry.FullName)
  if (-not $resolved.StartsWith($cacheRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected TFO cache path' }
  if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a linked TFO cache directory' }
  if (@(Get-ChildItem -LiteralPath $resolved -Force).Count -eq 0) { continue } # An empty superseded cache has no runnable package to preserve.
  $installed = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $resolved '.codex-plugin/plugin.json') -Raw | ConvertFrom-Json
  if ($installed.name -ne 'tfo' -or $installed.version -ne $entry.Name) { throw 'Unexpected installed TFO package identity' }
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  $snapshot = Join-Path $backupRoot $entry.Name
  Copy-Item -LiteralPath $resolved -Destination $snapshot -Recurse
  $saved += [pscustomobject]@{ Original = $resolved; Snapshot = $snapshot }
}
if (Test-Path -LiteralPath $dataRoot -PathType Container) {
  $dataInfo = Get-Item -LiteralPath $dataRoot
  if ($dataInfo.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Refusing a linked TFO data directory' }
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  Copy-Item -LiteralPath $dataRoot -Destination (Join-Path $backupRoot 'data') -Recurse
}
& node (Join-Path $repoRoot 'scripts/build-plugin.mjs')
if ($LASTEXITCODE -ne 0) { throw 'TFO bundle build failed' }
$registered = (& $CodexCommand plugin marketplace list --json | Out-String | ConvertFrom-Json).marketplaces | Where-Object name -eq 'tfo-local'
if ($LASTEXITCODE -ne 0) { throw 'TFO marketplace lookup failed' }
$previousSource = $null
$sourceChanged = $false
$newSourceAdded = $false
if ($registered -and [IO.Path]::GetFullPath($registered.root) -ne $repoRoot) {
  $previousCatalog = Join-Path $registered.root '.agents/plugins/marketplace.json'
  $previous = Get-Content -Encoding UTF8 -LiteralPath $previousCatalog -Raw | ConvertFrom-Json
  if ($previous.name -ne 'tfo-local' -or @($previous.plugins).Count -ne 1 -or $previous.plugins[0].name -ne 'tfo') {
    throw 'Refusing to replace a marketplace containing other plugins'
  }
  $previousSource = $registered.root
  New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
  $registered | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupRoot 'previous-marketplace.json') -Encoding UTF8
}
try {
  if ($previousSource) {
    & $CodexCommand plugin marketplace remove tfo-local
    if ($LASTEXITCODE -ne 0) { throw 'TFO previous marketplace removal failed' }
    $sourceChanged = $true
  }
  & $CodexCommand plugin marketplace add $repoRoot
  if ($LASTEXITCODE -ne 0) { throw 'TFO marketplace registration failed' }
  $newSourceAdded = $true
  & $CodexCommand plugin add tfo@tfo-local
  if ($LASTEXITCODE -ne 0) { throw 'TFO plugin installation failed' }
} catch {
  if ($sourceChanged) {
    if ($newSourceAdded) { & $CodexCommand plugin marketplace remove tfo-local }
    & $CodexCommand plugin marketplace add $previousSource
    if ($LASTEXITCODE -eq 0) { & $CodexCommand plugin add tfo@tfo-local }
  }
  throw
} finally {
  foreach ($item in $saved) {
    if (-not (Test-Path -LiteralPath $item.Original)) { Copy-Item -LiteralPath $item.Snapshot -Destination $item.Original -Recurse }
  }
}
Write-Output "TFO installed from the local tfo-local marketplace. Previous TFO snapshots: $backupRoot"
