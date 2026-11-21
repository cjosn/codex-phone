# publish-release.ps1 — 用 GitHub REST API 发布 Release（不需要 gh CLI，也不需要 git 仓库）
#
# 用法：
#   $env:GITHUB_TOKEN = 'ghp_xxx'      # 只需该仓库 Contents: Read and write
#   .\tooling\publish-release.ps1 -Repo jiajia-0613/codex-phone -Version 1.5.0
#
# 它会：
#   1. 校验仓库可访问（不存在且给了 -CreateRepo 则按默认私有/公开设置创建）
#   2. 创建 tag v<version> 的 Release
#   3. 上传 APK 与 latest.json 两个资产
#   4. 打印最终下载地址（App 的更新源就是这个 latest.json）
#
# 令牌只从环境变量读取，绝不写入磁盘或日志。

param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = '',
  [switch]$CreateRepo,
  [switch]$Public,
  [string]$ApkPath,
  [string]$ManifestPath,
  [switch]$SkipRuntime
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$apk = if ($ApkPath) { $ApkPath } else { Join-Path $dist "Codex-Pocket-$Version-arm64.apk" }
$manifest = if ($ManifestPath) { $ManifestPath } else { Join-Path $dist 'latest.json' }
$token = $env:GITHUB_TOKEN

if (-not $token) { throw '请先设置环境变量 GITHUB_TOKEN（Fine-grained token，Contents: Read and write）' }
if (-not (Test-Path $apk)) { throw "找不到 APK: $apk" }

$headers = @{
  Authorization          = "Bearer $token"
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = "Codex-Pocket-Release/$Version"
}

$api = 'https://api.github.com'
$parts = $Repo.Split('/')
if ($parts.Count -ne 2) { throw 'Repo 必须是 owner/name 形式' }
$owner = $parts[0]; $name = $parts[1]

function Invoke-GitHub([string]$method, [string]$url, $body) {
  $params = @{ Method = $method; Uri = $url; Headers = $headers; ErrorAction = 'Stop' }
  if ($null -ne $body) {
    $params.Body = ($body | ConvertTo-Json -Depth 6)
    $params.ContentType = 'application/json; charset=utf-8'
  }
  try { return Invoke-RestMethod @params }
  catch {
    $detail = ''
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message }
    throw "$method $url 失败：$($_.Exception.Message) $detail"
  }
}

# 1) 仓库是否存在
$repoInfo = $null
try { $repoInfo = Invoke-GitHub 'GET' "$api/repos/$owner/$name" $null }
catch {
  if (-not $CreateRepo) {
    throw "仓库 $Repo 不可访问（不存在或令牌无权）。确认仓库已创建，或加 -CreateRepo 让脚本创建。原始错误：$($_.Exception.Message)"
  }
}
if (-not $repoInfo) {
  $visibility = if ($Public) { 'public' } else { 'private' }
  Write-Host "创建仓库 $Repo（$visibility）…" -ForegroundColor Cyan
  $repoInfo = Invoke-GitHub 'POST' "$api/user/repos" @{ name = $name; private = (-not $Public); description = 'Codex Pocket · 本机 Codex 客户端' }
}
Write-Host "仓库: $($repoInfo.full_name)  visibility=$($repoInfo.visibility)" -ForegroundColor Green

# 空仓库不能直接建 Release（API: Repository is empty）。先放一个 README 建初始提交。
$hasCommit = $false
try { Invoke-GitHub 'GET' "$api/repos/$owner/$name/commits?per_page=1" $null | ForEach-Object { if ($_.sha) { $hasCommit = $true } } } catch { $hasCommit = $false }
if (-not $hasCommit) {
  Write-Host '仓库为空，创建初始 README 提交…' -ForegroundColor Cyan
  $readme = "# Codex Pocket`n`n本机运行的 Codex 客户端。安装包与更新清单见 [Releases](https://github.com/$Repo/releases)。`n"
  $payload = @{
    message = 'docs: initial commit'
    content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($readme))
  }
  Invoke-GitHub 'PUT' "$api/repos/$owner/$name/contents/README.md" $payload | Out-Null
  Start-Sleep -Seconds 2
}

# 2) 版本与资产
$tag = "v$Version"
$apkName = Split-Path $apk -Leaf
$apkBytes = (Get-Item $apk).Length
$apkHash = (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower()

if (-not $Notes) {
  $Notes = @"
Codex Pocket $Version

- 模型池跟随渠道：选模型会同时切换 provider / 网关 / 模型
- 支持 OpenAI 兼容(chat)、OpenAI Responses、Anthropic、Gemini、Azure OpenAI、Ollama
- 思考链内联在回复上方；完成后折叠为「已完成 · Ns」，点开可回看
- 输入框内可切换权限：只读 / 工作区内修改 / 完全权限
- 自定义主题支持背景图片 + 配色
- 应用内检查更新（发布本版本后生效）
"@
}

# 3) 先写 latest.json（里面的 url 必须指向本次资产）
$manifestData = [ordered]@{
  version = $Version
  url     = "https://github.com/$Repo/releases/download/$tag/$apkName"
  sha256  = $apkHash
  sizeMb  = [math]::Round($apkBytes / 1MB, 1)
  notes   = $Notes
  builtAt = (Get-Date).ToString('s')
}
$manifestData | ConvertTo-Json -Depth 4 | ForEach-Object {
  # 不要 BOM：App 端 jsonDecode 不认 \uFEFF，带 BOM 会导致「检查更新」解析失败。
  [System.IO.File]::WriteAllText($manifest, $_, [System.Text.UTF8Encoding]::new($false))
}
Write-Host "清单: $manifest" -ForegroundColor Cyan

# 4) 创建 Release（已存在则复用）
$release = $null
try { $release = Invoke-GitHub 'GET' "$api/repos/$owner/$name/releases/tags/$tag" $null } catch { $release = $null }
if ($release) {
  Write-Host "Release $tag 已存在，复用 id=$($release.id)" -ForegroundColor Yellow
} else {
  Write-Host "创建 Release $tag …" -ForegroundColor Cyan
  $release = Invoke-GitHub 'POST' "$api/repos/$owner/$name/releases" @{
    tag_name         = $tag
    name             = "Codex Pocket $Version"
    body             = $Notes
    draft            = $false
    prerelease       = $false
    target_commitish = 'main'
  }
}

# 5) 上传资产（同名先删，保证可重复执行）
function Upload-Asset([string]$file, [string]$contentType) {
  $fileName = Split-Path $file -Leaf
  foreach ($asset in $release.assets) {
    if ($asset.name -eq $fileName) {
      Write-Host "删除旧资产 $fileName …" -ForegroundColor Yellow
      Invoke-GitHub 'DELETE' "$api/repos/$owner/$name/releases/assets/$($asset.id)" $null | Out-Null
    }
  }
  $uploadUrl = "https://uploads.github.com/repos/$owner/$name/releases/$($release.id)/assets?name=$([uri]::EscapeDataString($fileName))"
  Write-Host "上传 $fileName ($([math]::Round((Get-Item $file).Length / 1MB, 1)) MB) …" -ForegroundColor Cyan
  $bytes = [System.IO.File]::ReadAllBytes($file)
  Invoke-RestMethod -Method POST -Uri $uploadUrl -Headers $headers -ContentType $contentType -Body $bytes -TimeoutSec 3600 | Out-Null
}

Upload-Asset $apk 'application/vnd.android.package-archive'
Upload-Asset $manifest 'application/json'

# 6) 运行时资产（瘦包首次启动要用：先拉 runtime-arm64-v8a.json，再按里面的 url 下载 tar.xz）
#    之前脚本只发 APK + latest.json，瘦包首启拉清单直接 404 —— 这里补上，并且清单里的 url 用
#    api.github.com 的资产地址（手机端 github.com 常常不可达）。
$runtimeTar = Join-Path $dist 'runtime-arm64-v8a.tar.xz'
if ((Test-Path $runtimeTar) -and -not $SkipRuntime) {
  $runtimeManifest = Join-Path $dist 'runtime-arm64-v8a.json'
  $runtimeSha = (Get-FileHash $runtimeTar -Algorithm SHA256).Hash.ToLower()
  $runtimeSizeMb = [math]::Round((Get-Item $runtimeTar).Length / 1MB, 1)
  Upload-Asset $runtimeTar 'application/octet-stream'
  $fresh = Invoke-GitHub 'GET' "$api/repos/$owner/$name/releases/$($release.id)" $null
  $tarAsset = $fresh.assets | Where-Object { $_.name -eq 'runtime-arm64-v8a.tar.xz' } | Select-Object -First 1
  $runtimePayload = [ordered]@{
    version  = 'codex-app-server-0.170.0-arm64'
    url      = "https://api.github.com/repos/$Repo/releases/assets/$($tarAsset.id)"
    sha256   = $runtimeSha
    sizeMb   = $runtimeSizeMb
    notes    = 'Codex Pocket runtime (PRoot rootfs + node + codex 0.170). Download with Accept: application/octet-stream.'
  }
  [System.IO.File]::WriteAllText($runtimeManifest, ($runtimePayload | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
  Upload-Asset $runtimeManifest 'application/json'
  Write-Host "运行时资产已上传（tar id=$($tarAsset.id)，sha256=$runtimeSha）" -ForegroundColor Green
}

Write-Host ''
Write-Host "发布完成：" -ForegroundColor Green
Write-Host "  下载页: https://github.com/$Repo/releases/tag/$tag"
Write-Host "  清单  : https://github.com/$Repo/releases/download/$tag/latest.json"
if ((Test-Path $runtimeTar) -and -not $SkipRuntime) {
  Write-Host "  运行时: $api/repos/$Repo/releases/latest/download/runtime-arm64-v8a.json （注：实际地址是 release 资产）"
}
Write-Host "  SHA256: $apkHash"
