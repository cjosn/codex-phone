# 探针 v3：
#  1) thread/fork 到新 provider 后，上游是否收到完整历史（fork 保上下文）；
#  2) 上游对某个 model 回 404「模型不存在或未启用」时，codex 到底发几次重试、错误长什么样。
param(
  [string]$Codex = "$PSScriptRoot\..\tooling\sdk\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe",
  [string]$Node = 'C:\Users\13721\DSH-Instances\Pure\home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe',
  [int]$Port = 38921
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..\tooling\sdk\user-state\local'
$temp = Join-Path $root ("model-probe3-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
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

# 让 model-bad 一律 404，模拟「目录里有、账号没开通」。
$fixture = Start-Redirected $Node ((Join-Path $PSScriptRoot 'fixture-upstream.mjs') + " $Port $logPath model-bad") $temp
Start-Sleep -Milliseconds 900
$proc = Start-Redirected (Resolve-Path $Codex).Path 'app-server' $temp

function Get-Upstream {
  if (-not (Test-Path $logPath)) { return @() }
  return @(Get-Content $logPath | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
}
$script:nextId = 0
$script:notifications = New-Object System.Collections.ArrayList
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
    if ($null -ne $message.method) { [void]$script:notifications.Add($message) ; continue }
    if ($null -ne $message.id -and [string]$message.id -eq [string]$id) {
      if ($message.error) { throw "RPC $method failed: $($message.error | ConvertTo-Json -Depth 10 -Compress)" }
      return $message.result
    }
  }
  throw "RPC $method timed out"
}

$results = [ordered]@{}
try {
  $init = Send-Request 'initialize' @{ clientInfo = @{ name = 'codex-go-probe3'; version = '0.1.0' }; capabilities = @{ experimentalApi = $true } }
  Write-Output "initialize: $($init.userAgent)"
  $proc.StandardInput.WriteLine((@{ method = 'initialized'; params = @{} } | ConvertTo-Json -Compress))

  # 1) pa 上的一回合，留下历史
  $threadId = (Send-Request 'thread/start' @{ cwd = $temp; model = 'model-a'; modelProvider = 'pa' }).thread.id
  $t1 = (Send-Request 'turn/start' @{ threadId = $threadId; input = @(@{ type = 'text'; text = 'history-question-one' }) }).turn.id
  Start-Sleep -Milliseconds 1500

  # 2) fork 到 pb，再跑一回合：看 input 里有没有第一回合的问答
  $fork = Send-Request 'thread/fork' @{ threadId = $threadId; modelProvider = 'pb'; model = 'model-f' }
  Write-Output ("fork => thread={0} provider={1} model={2}" -f $fork.thread.id, $fork.modelProvider, $fork.model)
  $t2 = (Send-Request 'turn/start' @{ threadId = $fork.thread.id; input = @(@{ type = 'text'; text = 'history-question-two' }) }).turn.id
  Start-Sleep -Milliseconds 1500

  $rows = Get-Upstream
  foreach ($row in $rows) {
    Write-Output ("  {0} model={1} inputCount={2} transcript={3}" -f $row.path, $row.model, $row.inputCount, ($row.transcript -join ' | '))
  }

  # 3) 404 模型：在 pb 上建 thread，用 model-bad 跑一回合，收集所有 error 通知
  $badThread = (Send-Request 'thread/start' @{ cwd = $temp; model = 'model-bad'; modelProvider = 'pb' }).thread.id
  $badTurn = (Send-Request 'turn/start' @{ threadId = $badThread; input = @(@{ type = 'text'; text = 'this model does not exist' }) }).turn.id
  Write-Output "bad turn started: $badTurn"
  $script:notifications.Clear() | Out-Null
  $deadline = (Get-Date).AddSeconds(75)
  $completed = $null
  while ((Get-Date) -lt $deadline) {
    try { $message = Read-Message 5000 } catch { continue }
    if ($null -ne $message.method) { [void]$script:notifications.Add($message) }
    if ($message.method -eq 'turn/completed' -and $message.params.turn.id -eq $badTurn) { $completed = $message.params.turn; break }
  }
  Write-Output '--- notifications during 404 model turn ---'
  foreach ($note in $script:notifications) {
    Write-Output ("  {0} {1}" -f $note.method, ($note.params | ConvertTo-Json -Depth 8 -Compress))
  }
  if ($completed) { Write-Output ("bad turn status={0}" -f $completed.status) } else { Write-Output 'bad turn never completed (still retrying?)' }
  Write-Output ("upstream requests to /pb for model-bad: {0}" -f (@($rows | Where-Object { $_.model -eq 'model-bad' }).Count))
} catch {
  Write-Output "PROBE ERROR: $($_.Exception.Message)"
  Write-Output "codex stderr: $($proc.StandardError.ReadToEnd())"
} finally {
  try { $proc.StandardInput.Close() } catch {}
  if (-not $proc.HasExited) { $proc.WaitForExit(4000) | Out-Null }
  if (-not $proc.HasExited) { $proc.Kill() }
  try { Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue } catch {}
  Write-Output ("--- 404 requests recorded: {0} ---" -f (@(Get-Upstream | Where-Object { $_.model -eq 'model-bad' }).Count))
  if (-not $env:PROBE_KEEP) { Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue }
}
