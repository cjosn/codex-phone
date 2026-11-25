# Codex Pocket 发版脚本
#
# 用法：
#   .\tooling\release.ps1 -Version 0.7.0                  # 构建 + 算 sha256 + 生成 latest.json
#   .\tooling\release.ps1 -Version 0.7.0 -Publish         # 额外用 gh 创建 GitHub Release（需先 gh auth login）
#   .\tooling\release.ps1 -Version 0.7.0 -Lean            # 只出「瘦包」（不含运行时，用于测体积，不能装）
#
# 产物：
#   dist\Codex-Pocket-<version>-arm64.apk
#   dist\latest.json          ← App 里 kUpdateManifestUrl 指向这个文件

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Repo = 'cjosn/codex-phone',            # owner/repo，-Publish 时必填（或从 git remote 推断）
  [switch]$Lean,
  [switch]$Publish,
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$dist = Join-Path $root 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$apkName = "Codex-Pocket-$Version-arm64.apk"
$apkPath = Join-Path $dist $apkName

if (-not $SkipBuild) {
  Set-ExecutionPolicy -Scope Process Bypass -Force
  . (Join-Path $root 'tooling\env.ps1')

  # 桥先同步进运行时资产，否则 APK 里是旧桥
  powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'tooling\sync-bridge.ps1') | Out-Null

  $app = Join-Path $root 'dshgo-fork\dsh-Go-main\app'
  Push-Location $app
  try {
    $args = @('build', 'apk', '--release', '--flavor', 'arm64',
              '--target-platform', 'android-arm64',
              '--build-name', $Version,
              "--dart-define=APP_VERSION=$Version")
    if ($Lean) { $args += @('-PcodexLeanApk=true') }
    Write-Host "构建中: flutter $($args -join ' ')" -ForegroundColor Cyan
    & flutter @args | Select-Object -Last 3
    if ($LASTEXITCODE -ne 0) { throw "flutter build 失败" }

    $built = Join-Path $app 'build\app\outputs\flutter-apk\app-arm64-release.apk'
    Copy-Item $built $apkPath -Force
  }
  finally { Pop-Location }
}

if (-not (Test-Path $apkPath)) { throw "找不到 $apkPath" }

$hash = (Get-FileHash $apkPath -Algorithm SHA256).Hash.ToLower()
$sizeMb = [math]::Round((Get-Item $apkPath).Length / 1MB, 1)

# 版本比较用不了「0.6.5-lean」这种后缀，清单里只写数字版本
$cleanVersion = ($Version -split '-')[0]
$manifest = [ordered]@{
  version = $cleanVersion
  url     = "https://github.com/$Repo/releases/download/v$cleanVersion/Codex-Pocket-$cleanVersion-arm64.apk"
  sha256  = $hash
  sizeMb  = $sizeMb
  notes   = ''
  builtAt = (Get-Date).ToString('s')
}
$manifestPath = Join-Path $dist 'latest.json'
$manifest | ConvertTo-Json -Depth 4 | Set-Content -Path $manifestPath -Encoding UTF8

Write-Host ""
Write-Host "APK    : $apkPath ($sizeMb MB)" -ForegroundColor Green
Write-Host "SHA256 : $hash"
Write-Host "清单   : $manifestPath"
Write-Host ""

if ($Publish) {
  $gh = Get-Command gh -ErrorAction SilentlyContinue
  if (-not $gh) {
    Write-Host "未安装 gh，无法自动发布。装法：winget install GitHub.cli" -ForegroundColor Yellow
    Write-Host "手动发布：到 GitHub → Releases → New release，tag 用 v$cleanVersion，上传 $apkName 和 latest.json" -ForegroundColor Yellow
    exit 0
  }
  if ([string]::IsNullOrWhiteSpace($Repo)) {
    $remote = (git remote get-url origin 2>$null)
    if ($remote -match 'github\.com[:/](?<r>[^/]+/[^/.]+)') { $Repo = $Matches['r'] }
    if ([string]::IsNullOrWhiteSpace($Repo)) { throw "请用 -Repo owner/repo 指定仓库" }
  }
  gh release create "v$cleanVersion" $apkPath (Join-Path $dist 'latest.json') `
     --repo $Repo --title "Codex Pocket $cleanVersion" --notes "见提交记录" --latest
  Write-Host "已发布到 https://github.com/$Repo/releases" -ForegroundColor Green
}
else {
  Write-Host "下一步：装 gh 后加 -Publish，或手动上传到 GitHub Releases" -ForegroundColor Cyan
}
