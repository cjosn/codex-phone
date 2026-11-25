# 探针 v4：上游对模型回 404「模型不存在」时，codex 0.170 发几条重试、错误文本长什么样。
# PowerShell 只负责收发 JSON-RPC 并把原始行落盘，分析交给 Node（PS 5.1 解析长 JSON 不可靠）。
param(
  [string]$Codex = "$PSScriptRoot\..\tooling\sdk\codex\vendor\x86_64-pc-windows-msvc\bin\codex.exe",
  [string]$Node = 'C:\Users\13721\DSH-Instances\Pure\home\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe',
  [int]$Port = 38923,
  [int]$WaitSeconds = 130
)

$ErrorActionPreference = 'Stop'
$runRoot = Join-Path $PSScriptRoot '..\tooling\sdk\user-state\local\probe4-run'
if (Test-Path $runRoot) { Remove-Item -Recurse -Force $runRoot }
$codexHome = Join-Path $runRoot 'home'
$upstreamLog = Join-Path $runRoot 'upstream.jsonl'
$messagesLog = Join-Path $runRoot 'codex-messages.jsonl'
New-Item -ItemType Directory -Force -Path $codexHome, (Join-Path $runRoot 'local'), (Join-Path $runRoot 'temp') | Out-Null

$config = @"
model = "model-bad"
model_provider = "pa"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[model_providers.pa]
name = "Provider A"
base_url = "http://127.0.0.1:$Port/pa/v1"
wire_api = "responses"
env_key = "PROBE_KEY"
"@
Set-Content -Path (Join-Path $codexHome 'config.toml') -Value $config -Encoding UTF8

$env:CODEX_HOME = $codexHome
$env:LOCALAPPDATA = (Join-Path $runRoot 'local')
$env:TEMP = (Join-Path $runRoot 'temp')
$env:TMP = (Join-Path $runRoot 'temp')
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

$fixture = Start-Redirected $Node ((Join-Path $PSScriptRoot 'fixture-upstream.mjs') + " $Port $upstreamLog model-bad") $runRoot
Start-Sleep -Milliseconds 900
$proc = Start-Redirected (Resolve-Path $Codex).Path 'app-server' $runRoot

$script:nextId = 0
$script:clock = Get-Date
function Log-Raw([string]$line) {
  $elapsed = [int]((Get-Date) - $script:clock).TotalMilliseconds
  $quoted = '"' + ((($line -replace '\\', '\\\\') -replace '"', '\"') -replace "`t", '\t') + '"'
  Add-Content -Path $messagesLog -Value ('{"t":' + $elapsed + ',"raw":' + $quoted + '}') -Encoding UTF8
}
$script:pendingRead = $null
function Read-Raw([int]$timeoutMs = 30000) {
  # ReadLineAsync 不能重入：超时后保留同一个任务，下一次调用接着等它。
  if ($null -eq $script:pendingRead) { $script:pendingRead = $proc.StandardOutput.ReadLineAsync() }
  if (-not $script:pendingRead.Wait($timeoutMs)) { return $null }
  $line = $script:pendingRead.Result
  $script:pendingRead = $null
  return $line
}
function Send-Request([string]$method, [string]$paramsJson, [int]$timeoutMs = 60000) {
  $script:nextId++
  $id = $script:nextId
  $proc.StandardInput.WriteLine('{"id":' + $id + ',"method":"' + $method + '","params":' + $paramsJson + '}')
  $proc.StandardInput.Flush()
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    $line = Read-Raw 2000
    if ($null -eq $line) { continue }
    if (-not $line.Trim()) { continue }
    Log-Raw $line
    if ($line -match ('"id":\s*' + $id + '\D')) { return $line }
  }
  throw ('RPC timeout: ' + $method)
}

try {
  [void](Send-Request 'initialize' '{"clientInfo":{"name":"codex-go-probe4","version":"0.1.0"},"capabilities":{"experimentalApi":true}}')
  $proc.StandardInput.WriteLine('{"method":"initialized","params":{}}')

  $cwdJson = ConvertTo-Json $runRoot -Compress
  $startLine = Send-Request 'thread/start' ('{"cwd":' + $cwdJson + ',"model":"model-bad","modelProvider":"pa"}')
  $threadId = ([regex]::Match($startLine, '"id":"([^"]+)"')).Groups[1].Value
  Write-Output ('thread: ' + $threadId)

  $turnLine = Send-Request 'turn/start' ('{"threadId":"' + $threadId + '","input":[{"type":"text","text":"this model does not exist"}]}')
  $turnId = ([regex]::Match($turnLine, '"id":"([^"]+)"')).Groups[1].Value
  Write-Output ('turn: ' + $turnId)

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $finished = $false
  while ((Get-Date) -lt $deadline) {
    $line = Read-Raw 3000
    if ($null -eq $line) { continue }
    if (-not $line.Trim()) { continue }
    Log-Raw $line
    if ($line -match '"method":"turn/completed"' -and $line.Contains($turnId)) { $finished = $true; break }
  }
  if ($finished) { Write-Output 'turn completed' } else { Write-Output ('turn not completed within ' + $WaitSeconds + 's') }
} catch {
  Write-Output ('PROBE ERROR: ' + $_.Exception.Message)
} finally {
  try { $proc.StandardInput.Close() } catch {}
  if (-not $proc.HasExited) { $proc.WaitForExit(4000) | Out-Null }
  if (-not $proc.HasExited) { $proc.Kill() }
  try { Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue } catch {}
  Write-Output ('logs: ' + $runRoot)
}
