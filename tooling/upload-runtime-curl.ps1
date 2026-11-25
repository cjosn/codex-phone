# tooling/upload-runtime-curl.ps1 — 把运行时 tar + 清单传到指定 Release（复用已有资产，抗断线）。
#
# 背景（都是实测踩出来的）：
#   * 运行时 tar 有 286MB，Python http.client 会在中途抛 ssl.SSLEOFError；
#   * curl 直传在部分网络下也会被 reset（HTTP/2 与 Expect: 100-continue 更明显）；
#   * 而运行时在两版 App 之间**经常根本不变**——所以先在所有 Release 里找 sha256 相同的
#     既有资产，找到就直接复用它的 asset id，一个字节都不用再传。
#
# 用法：
#   $env:GITHUB_TOKEN='ghp_...'
#   .\tooling\upload-runtime-curl.ps1 -Tag v1.7.6
param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$Repo = 'cjosn/codex-phone'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$tar = Join-Path $dist 'runtime-arm64-v8a.tar.xz'
$manifest = Join-Path $dist 'runtime-arm64-v8a.json'
$token = $env:GITHUB_TOKEN
if (-not $token) { throw '请先设置环境变量 GITHUB_TOKEN' }
if (-not (Test-Path $tar)) { throw "找不到运行时 tar: $tar" }

$headers = @{ Authorization = "token $token"; 'User-Agent' = 'codex-pocket-runtime'; Accept = 'application/vnd.github+json' }
$api = 'https://api.github.com'

$sha = (Get-FileHash $tar -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item $tar).Length
Write-Host "local tar sha256=$sha sizeMb=$([math]::Round($size / 1MB, 1))"

$release = (Invoke-RestMethod -Uri "$api/repos/$Repo/releases/tags/$Tag" -Headers $headers)
if (-not $release.id) { throw "找不到 Release $Tag" }
Write-Host "target release $Tag id=$($release.id)"

# 1) 任何 Release 里有相同 sha256 的运行时，直接复用（不传 286MB）。
$reuseId = $null
foreach ($item in (Invoke-RestMethod -Uri "$api/repos/$Repo/releases?per_page=30" -Headers $headers)) {
  foreach ($asset in $item.assets) {
    if ($asset.name -ne 'runtime-arm64-v8a.tar.xz') { continue }
    if ($asset.digest -eq "sha256:$sha") { $reuseId = $asset.id; Write-Host "reuse runtime asset $($asset.id) from $($item.tag_name)"; break }
  }
  if ($reuseId) { break }
}

# 2) 目标 Release 里同名的旧资产先删掉，避免 422。
foreach ($asset in $release.assets) {
  if ($asset.name -eq 'runtime-arm64-v8a.tar.xz' -or $asset.name -eq 'runtime-arm64-v8a.json') {
    if ($reuseId -and $asset.id -eq $reuseId) { continue }
    Invoke-RestMethod -Method Delete -Uri "$api/repos/$Repo/releases/assets/$($asset.id)" -Headers $headers | Out-Null
    Write-Host "deleted old asset $($asset.name)"
  }
}

$tarAssetId = $reuseId
if (-not $tarAssetId) {
  Write-Host "no reusable runtime found; uploading $([math]::Round($size / 1MB, 1)) MB ..."
  $tarUrl = "https://uploads.github.com/repos/$Repo/releases/$($release.id)/assets?name=runtime-arm64-v8a.tar.xz"
  # curl 的 stderr 会被 PowerShell 当成错误；用 2>&1 收进变量，只看退出码。
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    Write-Host "attempt $attempt ..."
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $raw = & curl.exe -sS --http1.1 -H 'Expect:' --max-time 3600 `
        -X POST -H "Authorization: token $token" -H 'Content-Type: application/octet-stream' `
        --data-binary "@$tar" $tarUrl 2>&1 | Out-String
      $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $previousEap }
    $text = ($raw | Out-String)
    if ($code -eq 0 -and $text -match '"id"\s*:\s*(\d+)') { $tarAssetId = [int64]$Matches[1]; break }
    $firstLine = ($text -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
    Write-Host "attempt $attempt failed (curl=$code): $firstLine"
    Start-Sleep -Seconds 15
  }
  if (-not $tarAssetId) { throw '运行时上传三次都失败；检查网络或改用 tooling/upload-runtime-assets.py' }
}
Write-Host "runtime tar asset id=$tarAssetId"

# 3) 清单指向这个资产 id（跨 Release 复用也成立：资产 URL 是全局的）。
$payload = [ordered]@{
  version = 'codex-app-server-0.170.0-arm64'
  url     = "https://api.github.com/repos/$Repo/releases/assets/$tarAssetId"
  sha256  = $sha
  sizeMb  = [math]::Round($size / 1MB, 1)
  notes   = 'Codex Pocket runtime (PRoot rootfs + node + codex 0.170). Download with Accept: application/octet-stream.'
}
[System.IO.File]::WriteAllText($manifest, ($payload | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))

$manifestUrl = "https://uploads.github.com/repos/$Repo/releases/$($release.id)/assets?name=runtime-arm64-v8a.json"
$raw = & curl.exe -sS --http1.1 -H 'Expect:' -X POST -H "Authorization: token $token" `
  -H 'Content-Type: application/json' --data-binary "@$manifest" $manifestUrl 2>&1
$code = $LASTEXITCODE
$text = ($raw | Out-String)
if ($code -ne 0 -or $text -notmatch '"id"\s*:\s*(\d+)') { throw "manifest upload failed (curl=$code): $text" }
Write-Host "manifest asset id=$($Matches[1])"
Write-Host "runtime ok for $Tag (tar asset $tarAssetId)"
