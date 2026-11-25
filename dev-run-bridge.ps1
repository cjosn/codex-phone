# dev-run-bridge.ps1 — 在电脑上跑 Codex bridge，手机浏览器直接用（不依赖 APK / proot）
#
# 为什么要这个：Flutter App 要经过 proot 里起 node+codex 再握手，链路长；
# 而 bridge 本身在电脑上验证是通的（/healthz /thread/list /config /models /account 全 200），
# 手机浏览器打开就是同一套 WebUI。先用这条路把功能跑起来，再回头修 App。
#
#   .\dev-run-bridge.ps1                 # 默认端口 8787，绑定 0.0.0.0，自动生成 token
#   .\dev-run-bridge.ps1 -Port 9000 -Token mytoken
#   .\dev-run-bridge.ps1 -LocalOnly      # 只绑 127.0.0.1（自己电脑的浏览器用）

param(
  [int]$Port = 8787,
  [string]$Token = '',
  [switch]$LocalOnly,
  [string]$Cwd = ''
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot                            # codex-go（本脚本就在它根目录）
if (-not $Token) { $Token = -join ((48..57) + (97..122) | Get-Random -Count 16 | ForEach-Object { [char]$_ }) }
if (-not $Cwd) { $Cwd = (Get-Location).Path }

# 1) 官方 codex 二进制
$codex = Get-ChildItem (Join-Path $root 'tooling/sdk/codex') -Recurse -Filter 'codex.exe' -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -match 'windows' } | Select-Object -First 1
if (-not $codex) { throw "找不到 codex.exe（期望在 $root\tooling\sdk\codex\**\windows**\bin\codex.exe）" }

# 2) CODEX_HOME 放到工作区：默认 ~/.codex 在本机不可写，codex 会刷一堆 os error 5
$env:CODEX_HOME = Join-Path $root 'bridge-home'
$env:TEMP = Join-Path $env:CODEX_HOME 'tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:CODEX_HOME, $env:TEMP | Out-Null

# 3) node：优先 PATH，否则用 DSH 自带的
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  $node = Get-ChildItem 'C:\Users\13721\DSH-Instances' -Recurse -Filter 'node.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $node) { throw '找不到 node.exe' }

$host_ = if ($LocalOnly) { '127.0.0.1' } else { '0.0.0.0' }
$lanIp = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
  Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host ''
Write-Host '  Codex bridge' -ForegroundColor Cyan
Write-Host "  codex    $($codex.FullName)"
Write-Host "  codex    $(& $codex.FullName --version 2>$null | Select-Object -First 1)"
Write-Host "  host     $host_`:$Port"
Write-Host "  token    $Token"
Write-Host ''
Write-Host '  电脑浏览器：' -NoNewline; Write-Host "http://127.0.0.1:$Port/?token=$Token" -ForegroundColor Green
if (-not $LocalOnly -and $lanIp) {
  Write-Host '  手机浏览器：' -NoNewline; Write-Host "http://${lanIp}:$Port/?token=$Token" -ForegroundColor Green
  Write-Host '             （同一 WiFi；只在这台电脑和手机可信的网络里这么开）'
}
Write-Host ''

& $node (Join-Path $root 'bridge/server.mjs') `
  --mode app-server --codex $codex.FullName `
  --port $Port --token $Token --host $host_ --cwd $Cwd
