# 真实 codex 0.170 探针：同一 thread 换 model / 换 provider 时，上游到底收到什么。
# 为什么用 PowerShell 驱动：本机沙箱禁止子进程用管道 stdio（node spawn EPERM），
# PowerShell 自己的 .NET 重定向可用，所以 JSON-RPC 由这里收发。
param(
  [string]$Codex = "$PSScriptRoot\..\tooling\sdk\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe",
  [string]$Node = 'C:\Users\13721\DSH-Instances\Pure\home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe',
  [int]$Port = 38917
)

$ErrorActionPreference = 'Stop'
$root = Join-Path $PSScriptRoot '..\tooling\sdk\user-state\local'
$temp = Join-Path $root ("model-probe-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
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

# 子进程继承本 PowerShell 的环境；每次调用都是新进程，不需要还原。
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

function Get-Upstream {
  if (-not (Test-Path $logPath)) { return @() }
  return @(Get-Content $logPath | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json })
}

$proc = Start-Redirected (Resolve-Path $Codex).Path 'app-server' $temp

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
  $payload = @{ id = $id; method = $method; params = $params } | ConvertTo-Json -Depth 20 -Compress
  $proc.StandardInput.WriteLine($payload)
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
    if ($message.method -eq 'turn/completed' -and $message.params.threadId -eq $threadId -and $message.params.turn.id -eq $turnId) {
      return $message.params.turn
    }
    if ($message.method -eq 'error' -and $message.params.threadId -eq $threadId -and $message.params.turnId -eq $turnId) {
      throw "turn error: $($message.params | ConvertTo-Json -Depth 10 -Compress)"
    }
  }
  throw "turn $turnId timed out"
}

function Invoke-Turn([string]$label, [string]$threadId, $extra = @{}) {
  $before = @(Get-Upstream).Count
  $params = @{ threadId = $threadId; input = @(@{ type = 'text'; text = $label }) }
  foreach ($key in $extra.Keys) { $params[$key] = $extra[$key] }
  $started = Send-Request 'turn/start' $params
  $turnId = $started.turn.id
  $turn = Wait-Turn $threadId $turnId
  $after = @(Get-Upstream)
  $fresh = if ($after.Count -gt $before) { $after[$before..($after.Count - 1)] } else { @() }
  $summary = ($fresh | ForEach-Object { "{0} model={1}" -f $_.path, $_.model }) -join ' ; '
  Write-Output ("{0} => status={1} requests=[{2}]" -f $label, $turn.status, $summary)
  return ,$fresh
}

$results = [ordered]@{}
try {
  $init = Send-Request 'initialize' @{ clientInfo = @{ name = 'codex-go-probe'; version = '0.1.0' }; capabilities = @{ experimentalApi = $true } }
  Write-Output "initialize: $($init.userAgent)"
  $proc.StandardInput.WriteLine((@{ method = 'initialized'; params = @{} } | ConvertTo-Json -Compress))

  # 1) 建 thread：pa + model-a
  $threadStart = Send-Request 'thread/start' @{ cwd = $temp; model = 'model-a'; modelProvider = 'pa' }
  $threadId = $threadStart.thread.id
  Write-Output "thread: $threadId"
  $results['1-start-a'] = Invoke-Turn '1-start-a' $threadId

  # 2) 同一 thread，turn/start 显式换 model（同 provider）
  $results['2-turn-model-b'] = Invoke-Turn '2-turn-model-b' $threadId @{ model = 'model-b' }

  # 3) 再跑一回合不带 model：thread 记的是 model-b 还是 model-a？
  $results['3-no-model-after-override'] = Invoke-Turn '3-no-model-after-override' $threadId

  # 4) 模拟切渠道 = applyChannelConfig 的 batchWrite
  Send-Request 'config/batchWrite' @{
    edits = @(
      @{ keyPath = 'model_provider'; value = 'pb'; mergeStrategy = 'replace' },
      @{ keyPath = 'model'; value = 'model-c'; mergeStrategy = 'replace' }
    )
    reloadUserConfig = $true
  } | Out-Null
  $results['4-after-provider-switch-no-model'] = Invoke-Turn '4-after-provider-switch-no-model' $threadId
  $results['5-after-provider-switch-model-c'] = Invoke-Turn '5-after-provider-switch-model-c' $threadId @{ model = 'model-c' }

  # 6) 修复候选：thread/resume 带 model + modelProvider，再跑
  Send-Request 'config/batchWrite' @{
    edits = @(
      @{ keyPath = 'model_provider'; value = 'pa'; mergeStrategy = 'replace' },
      @{ keyPath = 'model'; value = 'model-a'; mergeStrategy = 'replace' }
    )
    reloadUserConfig = $true
  } | Out-Null
  $resumed = Send-Request 'thread/resume' @{ threadId = $threadId; model = 'model-d'; modelProvider = 'pa' }
  Write-Output ("thread/resume(model-d, pa) => model={0} provider={1}" -f $resumed.model, $resumed.modelProvider)
  $results['6-turn-after-resume'] = Invoke-Turn '6-turn-after-resume' $threadId

  # 7) 新开 thread 用 pb：确认 provider 切换本身是有效的（对照组）
  $thread2 = (Send-Request 'thread/start' @{ cwd = $temp; model = 'model-b'; modelProvider = 'pb' }).thread.id
  $results['7-new-thread-pb'] = Invoke-Turn '7-new-thread-pb' $thread2
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
    $line = ($results[$key] | ForEach-Object { "{0} model={1}" -f $_.path, $_.model }) -join ' ; '
    $lines += ("{0}: {1}" -f $key, $line)
    Write-Output $lines[-1]
  }
  Set-Content -Path (Join-Path $root 'model-probe-last.txt') -Value $lines -Encoding UTF8
  if (-not $env:PROBE_KEEP) { Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue }
}
