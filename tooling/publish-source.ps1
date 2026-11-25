# publish-source.ps1 — keep UTF-8 with BOM for Windows PowerShell 5.1.
# Returns the exact remote source commit on stdout. Diagnostics contain no keys.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$Version = '',
  [string]$Branch = 'main',
  [ValidateSet('auto', 'git', 'api')][string]$Transport = 'auto',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tool = Join-Path $PSScriptRoot 'source-control.mjs'
function Invoke-SourceNode([string[]]$SourceArguments) {
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & node $tool @SourceArguments
    $exitCode = $LASTEXITCODE
  } finally { $ErrorActionPreference = $previousEap }
  if ($exitCode -ne 0) { throw 'Source operation failed; release creation blocked.' }
  return $output
}
if ($DryRun) {
  Invoke-SourceNode -SourceArguments @('scan', '--root', $root)
  return
}
$message = if ($Version) { "chore: synchronize source for v$Version" } else { 'chore: synchronize source and documentation' }
$result = Invoke-SourceNode -SourceArguments @('sync', '--root', $root, '--repo', $Repo, '--branch', $Branch, '--transport', $Transport, '--message', $message)
$sync = ($result -join "`n") | ConvertFrom-Json
if ($sync.sha -notmatch '^[a-f0-9]{40}$') { throw 'Source synchronization returned an invalid commit.' }
Write-Host "Source synchronized: $($sync.sha) ($($sync.transport), $($sync.files) files)" -ForegroundColor Green
return [string]$sync.sha
