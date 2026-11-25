# 探针 v2：切渠道后，老 thread 能不能被 thread/resume 或 thread/fork 的 modelProvider 改到新渠道？
param(
  [string]$Codex = "$PSScriptRoot\..\tooling\sdk\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe",
  [string]$Node = 'C:\Users\13721\DSH-Instances\Pure\home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe',
  [int]$Port = 38919
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..\tooling\sdk\user-state\local'
$temp = Join-Path $root ("model-probe2-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$codexHome = Join-Path $temp 'home'
$logPath = Join-Path $temp 'upstream.jsonl'
New-Item -ItemType Directory -Force -Path $codexHome, (Join-Path $temp 'local'), (Join-Path $temp 'temp') | Out-Null

$config = @"
model = "model-a"
model_provider = "pa"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.pa]
name = "Provider A"
base_url = "http://127.0.0.1:$Port/pa/v1"
wire_api = "responses"
env_key = "PROBE_KEY"

[model_providers.pb]
name = "Provider B"
base_url = "http://127.0.0.1:$Port/pb/v1"
wire_api = "responses"
env_key = "PROBE_KEY"
"@
Set-Content -Path (Join-Path $codexHome 'config.toml') -Value $config -Encoding UTF8

$env:CODEX_HOME = $codexHome
$env:LOCALAPPDATA = (Join-Path $temp 'local')
$env:TEMP = (Join-Path $temp 'temp')
$env:TMP = (Join-Path $temp 'temp')
$env:PROBE_KEY = 'probe-key-only'
$env:NO_COLOR = '1'
$env:RUST_LOG = 'off'

function Start-Redirected([string]$exe, [string]$arguments, [string]$workdir) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe
  $psi.Arguments = $arguments
  $psi.WorkingDirectory = $workdir
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  return [System.Diagnostics.Process]::Start($psi)
}

$fixture = Start-Redirected $Node ((Join-Path $PSScriptRoot 'fixture-upstream.mjs') + " $Port " + $logPath) $temp
Start-Sleep -Milliseconds 900
$proc = Start-Redirected (Resolve-Path $Codex).Path 'app-server' $temp

function Get-Upstream {
  if (-not (Test-Path $logPath)) { return @() }
  return @(Get-Content $logPath | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
}
$script:nextId = 0
function Read-Message([int]$timeoutMs = 30000) {
  $task = $proc.StandardOutput.ReadLineAsync()
  if (-not $task.Wait($timeoutMs)) { throw 'timeout waiting for codex output' }
  $line = $task.Result
  if ($null -eq $line) { throw "codex closed stdout: $($proc.StandardError.ReadToEnd())" }
  if (-not $line.Trim()) { return Read-Message $timeoutMs }
  return $line | ConvertFrom-Json
}
function Send-Request([string]$method, $params, [int]$timeoutMs = 60000) {
  $script:nextId++
  $id = $script:nextId
  $proc.StandardInput.WriteLine((@{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 20 -Compress))
  $proc.StandardInput.Flush()
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    $message = Read-Message ([int]([Math]::Max(1000, ($deadline - (Get-Date)).TotalMilliseconds)))
    if ($null -ne $message.id -and [string]$message.id -eq [string]$id) {
      if ($message.error) { throw "RPC $method failed: $($message.error | ConvertTo-Json -Depth 10 -Compress)" }
      return $message.result
    }
  }
  throw "RPC $method timed out"
}
function Wait-Turn([string]$threadId, [string]$turnId, [int]$timeoutMs = 60000) {
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    $message = Read-Message ([int]([Math]::Max(1000, ($deadline - (Get-Date)).TotalMilliseconds)))
    if ($message.method -eq 'turn/completed' -and $message.params.threadId -eq $threadId -and $message.params.turn.id -eq $turnId) { return $message.params.turn }
    if ($message.method -eq 'error' -and $message.params.threadId -eq $threadId -and $message.params.turnId -eq $turnId) { throw "turn error: $($message.params | ConvertTo-Json -Depth 10 -Compress)" }
  }
  throw "turn $turnId timed out"
}
function Invoke-Turn([string]$label, [string]$threadId, $extra = @{}) {
  $before = @(Get-Upstream).Count
  $params = @{ threadId = $threadId; input = @(@{ type = 'text'; text = $label }) }
  foreach ($key in $extra.Keys) { $params[$key] = $extra[$key] }
  $started = Send-Request 'turn/start' $params
  $turn = Wait-Turn $threadId $started.turn.id
  $after = @(Get-Upstream)
  $fresh = if ($after.Count -gt $before) { $after[$before..($after.Count - 1)] } else { @() }
  $summary = ($fresh | ForEach-Object { "{0} model={1}" -f $_.path, $_.model }) -join ' ; '
  Write-Output ("{0} => status={1} requests=[{2}]" -f $label, $turn.status, $summary)
  return ,$fresh
}

$results = [ordered]@{}
try {
  $init = Send-Request 'initialize' @{ clientInfo = @{ name = 'codex-go-probe2'; version = '0.1.0' }; capabilities = @{ experimentalApi = $true } }
  Write-Output "initialize: $($init.userAgent)"
  $proc.StandardInput.WriteLine((@{ method = 'initialized'; params = @{} } | ConvertTo-Json -Compress))

  $threadId = (Send-Request 'thread/start' @{ cwd = $temp; model = 'model-a'; modelProvider = 'pa' }).thread.id
  $results['A-baseline-pa'] = Invoke-Turn 'A-baseline-pa' $threadId

  # B：resume 时指定 modelProvider=pb（config 仍指向 pa）
  $resumedB = Send-Request 'thread/resume' @{ threadId = $threadId; modelProvider = 'pb'; model = 'model-e' }
  Write-Output ("B resume(modelProvider=pb, model=model-e) => provider={0} model={1}" -f $resumedB.modelProvider, $resumedB.model)
  $results['B-resume-provider-pb'] = Invoke-Turn 'B-resume-provider-pb' $threadId

  # C：再 resume 回 pa，确认能来回切
  $resumedC = Send-Request 'thread/resume' @{ threadId = $threadId; modelProvider = 'pa'; model = 'model-a' }
  Write-Output ("C resume(modelProvider=pa) => provider={0} model={1}" -f $resumedC.modelProvider, $resumedC.model)
  $results['C-resume-provider-pa'] = Invoke-Turn 'C-resume-provider-pa' $threadId

  # D：fork 到 pb
  $forked = Send-Request 'thread/fork' @{ threadId = $threadId; modelProvider = 'pb'; model = 'model-f' }
  $forkId = $forked.thread.id
  Write-Output ("D fork(modelProvider=pb) => thread={0} provider={1} model={2}" -f $forkId, $forked.modelProvider, $forked.model)
  $results['D-fork-pb'] = Invoke-Turn 'D-fork-pb' $forkId

  # E：resume 只给 provider 不给 model
  $resumedE = Send-Request 'thread/resume' @{ threadId = $threadId; modelProvider = 'pb' }
  Write-Output ("E resume(modelProvider=pb only) => provider={0} model={1}" -f $resumedE.modelProvider, $resumedE.model)
  $results['E-resume-provider-only'] = Invoke-Turn 'E-resume-provider-only' $threadId
} catch {
  Write-Output "PROBE ERROR: $($_.Exception.Message)"
  Write-Output "codex stderr: $($proc.StandardError.ReadToEnd())"
} finally {
  try { $proc.StandardInput.Close() } catch {}
  if (-not $proc.HasExited) { $proc.WaitForExit(4000) | Out-Null }
  if (-not $proc.HasExited) { $proc.Kill() }
  try { Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue } catch {}
  Write-Output '--- summary ---'
  $lines = @()
  foreach ($key in $results.Keys) {
    $lines += ("{0}: {1}" -f $key, (($results[$key] | ForEach-Object { "{0} model={1}" -f $_.path, $_.model }) -join ' ; '))
    Write-Output $lines[-1]
  }
  Set-Content -Path (Join-Path $root 'model-probe2-last.txt') -Value $lines -Encoding UTF8
  if (-not $env:PROBE_KEEP) { Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue }
}
