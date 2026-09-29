param(
  [ValidatePattern('^tunnel_[A-Za-z0-9_-]+$')][string]$TunnelId,
  [switch]$Configure,
  [switch]$Run
)
$ErrorActionPreference = 'Stop'
$repoPath = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $repoPath 'runtime\web-server.mjs'
if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) { throw 'No se encuentra la entrada web de TFO.' }
$nodePath = (Get-Command node -ErrorAction Stop).Source
$tunnelCommand = Get-Command tunnel-client -ErrorAction SilentlyContinue
$profileName = 'tfo-private-web'
if (-not $Configure -and -not $Run) {
  [pscustomobject]@{
    Server = $serverPath
    Node = $nodePath
    TunnelClientAvailable = [bool]$tunnelCommand
    Profile = $profileName
    NetworkStarted = $false
    Next = 'Consulta docs/WEB_PRIVATE_SETUP.md. Este diagnóstico no configura ni abre conexiones.'
  } | ConvertTo-Json
  exit 0
}
if (-not $tunnelCommand) { throw 'Instala tunnel-client desde la documentación oficial indicada en WEB_PRIVATE_SETUP.md.' }
if (-not $env:CONTROL_PLANE_API_KEY) { throw 'Configura CONTROL_PLANE_API_KEY en tu entorno local. No pegues esa clave en el chat.' }
if ($Configure) {
  if (-not $TunnelId) { throw 'Indica el TunnelId creado en tu cuenta de OpenAI.' }
  # Only this bounded MCP entry point is reachable. Never substitute runtime/server.mjs.
  $mcpCommand = '"' + $nodePath + '" "' + $serverPath + '"'
  & $tunnelCommand.Source init --sample sample_mcp_stdio_local --profile $profileName --tunnel-id $TunnelId --mcp-command $mcpCommand
  if ($LASTEXITCODE -ne 0) { throw 'No se pudo crear el perfil de conexión privada.' }
  & $tunnelCommand.Source doctor --profile $profileName --explain
  if ($LASTEXITCODE -ne 0) { throw 'El diagnóstico del túnel no pasó; no se inicia.' }
}
if ($Run) {
  # User-invoked foreground command: closing this console stops the private connection.
  & $tunnelCommand.Source run --profile $profileName
  if ($LASTEXITCODE -ne 0) { throw 'La conexión privada se detuvo con un error.' }
}
