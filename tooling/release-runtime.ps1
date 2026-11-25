# 发布「运行时」到 GitHub Release
#
# 运行时（rootfs + node + codex 二进制，286 MB）单独发一次，App 首次启动下载并缓存。
# 之后只有 codex 版本变化时才需要重新发它；日常改代码只发 12.5 MB 的 APK。
#
# 用法：
#   .\tooling\release-runtime.ps1 -Version 0.6.5            # 生成清单 + 打印发布步骤
#   .\tooling\release-runtime.ps1 -Version 0.6.5 -Publish   # 用 gh 直接上传到同一个 Release
#
# 产物：dist\runtime-arm64-v8a.json
#   { "version": "...", "url": "...", "sha256": "...", "sizeMb": 286 }

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Repo = 'cjosn/codex-phone',
  [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$archive = Join-Path $root 'dshgo-fork\dsh-Go-main\runtime\out\arm64-v8a\assets\runtime\rootfs-arm64-v8a.tar.xz'
if (-not (Test-Path $archive)) { throw "找不到运行时归档：$archive" }

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null

$name = 'runtime-arm64-v8a.tar.xz'
$target = Join-Path $dist $name
Copy-Item $archive $target -Force

Write-Host "计算 sha256（286 MB，稍等）..." -ForegroundColor Cyan
$hash = (Get-FileHash $target -Algorithm SHA256).Hash.ToLower()
$sizeMb = [math]::Round((Get-Item $target).Length / 1MB, 1)

$manifest = [ordered]@{
  version = $Version
  url     = "https://github.com/$Repo/releases/download/v$Version/$name"
  sha256  = $hash
  sizeMb  = $sizeMb
  builtAt = (Get-Date).ToString('s')
}
$manifestPath = Join-Path $dist 'runtime-arm64-v8a.json'
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

Write-Host ""
Write-Host "归档  : $target ($sizeMb MB)" -ForegroundColor Green
Write-Host "SHA256: $hash"
Write-Host "清单  : $manifestPath"
Write-Host ""

if ($Publish) {
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if (-not $gh) {
    Write-Host "未安装 gh：winget install GitHub.cli 然后 gh auth login" -ForegroundColor Yellow
  }
  else {
    gh release upload "v$Version" $target $manifestPath --repo $Repo --clobber
    if ($LASTEXITCODE -eq 0) { Write-Host "已上传到 v$Version" -ForegroundColor Green }
  }
}
else {
  Write-Host "下一步：gh release upload v$Version <归档> <清单> --repo $Repo" -ForegroundColor Cyan
}
