[CmdletBinding()]
param(
  [string]$DeploymentRoot = '',
  [ValidateRange(60, 1000)]
  [int]$MatchTickRateHz = 240
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$defaultRoot = Join-Path $PSScriptRoot '..\..'
$rootInput = if ([string]::IsNullOrWhiteSpace($DeploymentRoot)) {
  $defaultRoot
} else {
  $DeploymentRoot
}
$deploymentRoot = (Resolve-Path -LiteralPath $rootInput).Path
$releasesRoot = (Resolve-Path -LiteralPath (Join-Path $deploymentRoot 'releases')).Path
$currentFile = Join-Path $deploymentRoot 'current.txt'
$keyFile = Join-Path $deploymentRoot 'secrets\session-hmac.key'
$originsFile = Join-Path $deploymentRoot 'secrets\allowed-origins.txt'
$hostsFile = Join-Path $deploymentRoot 'secrets\allowed-hosts.txt'
$logsRoot = Join-Path $deploymentRoot 'logs'
$replayRoot = Join-Path $deploymentRoot 'data\replays'

foreach ($requiredFile in @($currentFile, $keyFile, $originsFile, $hostsFile)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Missing deployment file: $requiredFile"
  }
}

$releaseText = [IO.File]::ReadAllText($currentFile, [Text.Encoding]::UTF8).Trim()
$releasePath = (Resolve-Path -LiteralPath $releaseText).Path
$releasePrefix = $releasesRoot.TrimEnd('\') + '\'
if (-not $releasePath.StartsWith($releasePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'current.txt points outside the releases directory.'
}

$sessionKey = [IO.File]::ReadAllText($keyFile, [Text.Encoding]::UTF8).Trim()
if ($sessionKey -notmatch '^[0-9A-Fa-f]{64,}$' -and $sessionKey -notmatch '^[A-Za-z0-9_-]{43,}$') {
  throw 'Invalid session HMAC key file.'
}
$allowedOrigins = [IO.File]::ReadAllText($originsFile, [Text.Encoding]::UTF8).Trim()
if ([string]::IsNullOrWhiteSpace($allowedOrigins)) {
  throw 'Production WebSocket Origin allowlist is empty.'
}
$allowedHosts = [IO.File]::ReadAllText($hostsFile, [Text.Encoding]::UTF8).Trim()
if ([string]::IsNullOrWhiteSpace($allowedHosts)) {
  throw 'Production WebSocket Host allowlist is empty.'
}

$nodePath = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "Node.js executable not found: $nodePath"
}

$releaseId = Split-Path -Leaf $releasePath
function Test-ExpectedHealth {
  try {
    $health = Invoke-RestMethod `
      -Uri 'http://127.0.0.1:4180/api/health' `
      -Method Get `
      -TimeoutSec 2
    return (
      $health.ok -eq $true -and
      $health.buildId -eq $releaseId -and
      $health.protocolVersion -eq 4 -and
      $health.rotationSystemVersion -eq 'srs-plus-v1' -and
      $health.pieceSequenceVersion -eq 'shared-seven-bag-v1' -and
      $health.rulesetVersion -eq 'versus-srs-plus-tetrio-s2-v3' -and
      $health.matchTickRateHz -eq $MatchTickRateHz
    )
  } catch {
    return $false
  }
}

if (Test-ExpectedHealth) {
  exit 0
}

$listeners = @(
  Get-NetTCPConnection `
    -State Listen `
    -LocalPort 4180 `
    -ErrorAction SilentlyContinue
)
if ($listeners.Count -ne 0) {
  throw 'Port 4180 has a listener, but the expected service is not healthy.'
}

New-Item -ItemType Directory -Path $logsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $replayRoot -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutPath = Join-Path $logsRoot "$stamp.out.log"
$stderrPath = Join-Path $logsRoot "$stamp.err.log"
$launcherPath = Join-Path $logsRoot 'launcher.log'

$env:HOST = '0.0.0.0'
$env:PORT = '4180'
$env:NODE_ENV = 'production'
$env:BUILD_ID = $releaseId
$env:WS_ALLOWED_ORIGINS = $allowedOrigins
$env:WS_ALLOWED_HOSTS = $allowedHosts
$env:SESSION_HMAC_KEY = $sessionKey
$env:MATCH_TICK_RATE_HZ = $MatchTickRateHz.ToString(
  [Globalization.CultureInfo]::InvariantCulture
)
$env:MATCH_REPLAY_DIR = $replayRoot

$process = Start-Process `
  -FilePath $nodePath `
  -ArgumentList 'apps\server\src\main.ts' `
  -WorkingDirectory $releasePath `
  -RedirectStandardOutput $stdoutPath `
  -RedirectStandardError $stderrPath `
  -WindowStyle Hidden `
  -PassThru

$healthy = $false
for ($attempt = 1; $attempt -le 30; $attempt++) {
  Start-Sleep -Milliseconds 500
  if (Test-ExpectedHealth) {
    $healthy = $true
    break
  }
  $process.Refresh()
  if ($process.HasExited) {
    break
  }
}

if (-not $healthy) {
  $process.Refresh()
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id -Force
  }
  throw "Detached Node.js process failed health validation (PID $($process.Id))."
}

$record = [pscustomobject]@{
  at = (Get-Date).ToUniversalTime().ToString('o')
  event = 'server.detached'
  releaseId = $releaseId
  processId = $process.Id
}
$recordText = $record | ConvertTo-Json -Compress
[IO.File]::AppendAllText(
  $launcherPath,
  $recordText + [Environment]::NewLine,
  [Text.UTF8Encoding]::new($false)
)
exit 0
