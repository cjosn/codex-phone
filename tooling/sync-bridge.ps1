# sync-bridge.ps1 — 把 codex-go/bridge/*.mjs 同步进 APK 资产
#
# 为什么需要这一步：桥原本只存在 rootfs tarball 里，改一行就要重压 1.1 GB。
# CodexRuntime.kt 的 overlayBridge() 会在每次启动前用 APK 资产覆盖 rootfs 里的桥，
# 所以这里只需要把源码复制到 runtime/out/<abi>/assets/runtime/bridge/，重打包即可生效。
#
#   .\tooling\sync-bridge.ps1
#   .\tooling\sync-bridge.ps1 -Abi arm64-v8a,x86_64

param([string[]]$Abi = @('arm64-v8a'))

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot | Split-Path -Parent          # codex-go
$src = Join-Path $root 'bridge'
# Include every top-level bridge module; newly added MCP/toolkit modules must reach the APK.
$files = @(Get-ChildItem -LiteralPath $src -File -Filter '*.mjs' | ForEach-Object Name)
$missing = @('adapter.mjs', 'server.mjs', 'fake-codex.mjs') | Where-Object { $_ -notin $files }
if ($missing) { throw "bridge 源缺文件: $($missing -join ', ')" }

foreach ($abi in $Abi) {
  $assets = Join-Path $root "dshgo-fork/dsh-Go-main/runtime/out/$abi/assets"
  if (-not (Test-Path $assets)) { Write-Warning "跳过 $abi（没有 $assets）"; continue }
  $target = Join-Path $assets 'runtime/bridge'
  New-Item -ItemType Directory -Force $target | Out-Null
  foreach ($f in $files) {
    Copy-Item (Join-Path $src $f) (Join-Path $target $f) -Force
  }
  # 工具包（每个包一个目录，含 index.mjs）随桥一起进 APK：MCP 宿主按自身所在目录找 toolpacks/。
  $packSrc = Join-Path $src 'toolpacks'
  if (Test-Path $packSrc) {
    $packTarget = Join-Path $target 'toolpacks'
    if (Test-Path $packTarget) { Remove-Item $packTarget -Recurse -Force }
    Copy-Item $packSrc $packTarget -Recurse -Force
    $packs = Get-ChildItem $packTarget -Directory | ForEach-Object Name
    Write-Host "  $abi -> toolpacks : $($packs -join ', ')"
  } else {
    Write-Warning "没有 $packSrc，MCP 将只有宿主内置工具"
  }
  # 内置插件目录（plugins/<name>/plugin.json + toolpacks + skills），同样随桥进 APK。
  $pluginSrc = Join-Path $src 'plugins'
  if (Test-Path $pluginSrc) {
    $pluginTarget = Join-Path $target 'plugins'
    if (Test-Path $pluginTarget) { Remove-Item $pluginTarget -Recurse -Force }
    Copy-Item $pluginSrc $pluginTarget -Recurse -Force
    $plugins = Get-ChildItem $pluginTarget -Directory | ForEach-Object Name
    if ($plugins) { Write-Host "  $abi -> plugins : $($plugins -join ', ')" }
  }
  $hashes = Get-ChildItem $target -Filter *.mjs | ForEach-Object { "$($_.Name)=$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.Substring(0,12))" }
  Write-Host "  $abi -> runtime/bridge : $($hashes -join '  ')"
}
Write-Host 'sync ok. Build the APK next.'
