# publish-release.ps1 — 先同步源码/文档，再用 GitHub REST API 发布 Release
# NOTE: keep this file saved as UTF-8 **with BOM**. Windows PowerShell 5.1 reads
# BOM-less .ps1 as ANSI, and the Chinese comments below then fail to parse.
#
# 用法：
#   $env:GITHUB_TOKEN = 'ghp_xxx'      # 只需该仓库 Contents: Read and write
#   .\tooling\publish-release.ps1 -Repo cjosn/codex-phone -Version 1.5.0
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
  [switch]$SkipRuntime,
  [switch]$VerifyOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$apk = if ($ApkPath) { $ApkPath } else { Join-Path $dist "Codex-Pocket-$Version-arm64.apk" }
$manifest = if ($ManifestPath) { $ManifestPath } else { Join-Path $dist 'latest.json' }
$token = if ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } else { $env:GH_TOKEN }
if (-not $token -and -not $VerifyOnly) {
  $token = (& node (Join-Path $PSScriptRoot 'source-control.mjs') credential --repo $Repo | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Git credential lookup failed.' }
}
if (-not $token -and -not $VerifyOnly) { throw '请设置 GITHUB_TOKEN / GH_TOKEN，或配置可非交互读取的 Git credential。' }
if (-not (Test-Path $apk)) { throw "找不到 APK: $apk" }

$headers = @{
  Accept                 = 'application/vnd.github+json'
  'X-GitHub-Api-Version' = '2022-11-28'
  'User-Agent'           = "Codex-Pocket-Release/$Version"
}
if ($token) { $headers.Authorization = "Bearer $token" }

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
  if ($VerifyOnly -or -not $CreateRepo) {
    throw "仓库 $Repo 不可访问（不存在或令牌无权）。确认仓库已创建，或加 -CreateRepo 让脚本创建。原始错误：$($_.Exception.Message)"
  }
}
if (-not $repoInfo) {
  $visibility = if ($Public) { 'public' } else { 'private' }
  Write-Host "创建仓库 $Repo（$visibility）…" -ForegroundColor Cyan
  $repoInfo = Invoke-GitHub 'POST' "$api/user/repos" @{ name = $name; private = (-not $Public); description = 'Codex Pocket · 本机 Codex 客户端' }
}
Write-Host "仓库: $($repoInfo.full_name)  visibility=$($repoInfo.visibility)" -ForegroundColor Green

# 2) 版本与资产（只读；VerifyOnly 不生成或覆盖本地清单）
$tag = "v$Version"
$apkName = Split-Path $apk -Leaf
$apkBytes = (Get-Item $apk).Length
$apkHash = (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower()

if (-not $VerifyOnly) {
  # 源码与文档必须先同步成功；禁止用 main 的浮动名称创建不对应源码的 tag。
  $sourceCommit = & (Join-Path $PSScriptRoot 'publish-source.ps1') -Repo $Repo -Version $Version
  if ("$sourceCommit" -notmatch '^[a-f0-9]{40}$') { throw '源码同步失败，停止创建 Release。' }
  $tagRefs = @(Invoke-GitHub 'GET' "$api/repos/$owner/$name/git/matching-refs/tags/$tag" $null)
  $existingTag = $tagRefs | Where-Object { $_.ref -eq "refs/tags/$tag" } | Select-Object -First 1
  if ($existingTag) {
    $tagObject = $existingTag.object
    while ($tagObject.type -eq 'tag') { $tagObject = (Invoke-GitHub 'GET' "$api/repos/$owner/$name/git/tags/$($tagObject.sha)" $null).object }
    if ($tagObject.type -ne 'commit' -or $tagObject.sha -ne $sourceCommit) { throw "已有 tag $tag 与本次源码提交不一致；请使用新版本号。" }
  }

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
    target_commitish = $sourceCommit
  }
}
# GitHub may reuse an existing tag. Confirm the resolved commit before assets.
$resolvedTag = Invoke-GitHub 'GET' "$api/repos/$owner/$name/commits/$tag" $null
if ($resolvedTag.sha -ne $sourceCommit) { throw 'Release tag does not resolve to the synchronized source commit.' }
}

if ($VerifyOnly) {
  Write-Host "仅自检：跳过创建与上传，检查已有 Release $tag" -ForegroundColor Cyan
  $release = Invoke-GitHub 'GET' "$api/repos/$owner/$name/releases/tags/$tag" $null
  if (-not $release.id) { throw "找不到 Release $tag" }
  $apkHash = if (Test-Path $apk) { (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower() } else { '' }
} else {

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
  $sizeMb = [math]::Round((Get-Item $file).Length / 1MB, 1)
  Write-Host "上传 $fileName ($sizeMb MB) …" -ForegroundColor Cyan
  # 299MB 用 Invoke-RestMethod 会在上传末尾断（实测 1.7.5），改走 curl：
  # 固定 http1.1、禁用 Expect: 100-continue，失败重试 3 次。
  # curl 往 stderr 写一行（哪怕是重试中的正常输出）时，PowerShell 的 Stop 会把脚本整段中断，
  # 重试就形同虚设（1.7.7 第一次发布就是这样死在第一次 attempt）。这里临时放开，只看退出码。
  $previousEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    for ($attempt = 1; $attempt -le 5; $attempt++) {
      $raw = & curl.exe -sS --http1.1 -H 'Expect:' --max-time 3600 -X POST `
        -H "Authorization: token $token" -H "Content-Type: $contentType" `
        --data-binary "@$file" $uploadUrl 2>&1 | Out-String
      $code = $LASTEXITCODE
      if ($code -eq 0 -and $raw -match '"id"\s*:\s*(\d+)') { return }
      $firstLine = ($raw -split "`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
      Write-Host "  第 $attempt 次失败 (curl=$code): $firstLine" -ForegroundColor Yellow
      Start-Sleep -Seconds (10 * $attempt)
    }
  } finally { $ErrorActionPreference = $previousEap }
  throw "上传 $fileName 五次都失败"
}

Upload-Asset $apk 'application/vnd.android.package-archive'
Upload-Asset $manifest 'application/json'
}

# 6) 运行时资产（瘦包首启要用：先拉 runtime-arm64-v8a.json，再按里面的 url 下载 tar.xz）
#    286MB 用 Invoke-RestMethod 直传会在中途断开（实测 1.7.1 就是这样漏掉运行时的），
#    所以交给 upload-runtime-curl.ps1：它会先找 sha256 相同的既有资产复用，找不到才用 curl 分块重试。
$runtimeTar = Join-Path $dist 'runtime-arm64-v8a.tar.xz'
if (-not $VerifyOnly -and (Test-Path $runtimeTar) -and -not $SkipRuntime) {
  $previousToken = $env:GITHUB_TOKEN
  try {
    $env:GITHUB_TOKEN = $token
    & (Join-Path $PSScriptRoot 'upload-runtime-curl.ps1') -Tag $tag -Repo $Repo
    if ($LASTEXITCODE -ne 0) { throw '运行时资产上传失败' }
  } finally { $env:GITHUB_TOKEN = $previousToken }
} elseif ($SkipRuntime) {
  Write-Host '注意：本次跳过了运行时资产（-SkipRuntime）。瘦包首启会拉不到清单。' -ForegroundColor Yellow
}

# 7) 发布后自检：任何一条不过就报错退出，避免再发出「缺资产的 latest」。
Write-Host ''
Write-Host '发布自检：' -ForegroundColor Cyan
$failures = @()
# 资产下载走 Accept: octet-stream；PowerShell 会把 JSON 当二进制，不会自动反序列化，
# 所以这里显式解码 UTF-8 再 ConvertFrom-Json（1.7.6 的自检就是被这个坑误报过）。
function GetAssetJson([int64]$assetId) {
  $url = "$api/repos/$owner/$name/releases/assets/$assetId"
  $assetHeaders = @{} + $headers
  $assetHeaders.Accept = 'application/octet-stream'
  $resp = Invoke-WebRequest -Uri $url -Headers $assetHeaders -UseBasicParsing
  $raw = if ($resp.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }
  return $raw | ConvertFrom-Json
}
function Check([string]$label, [scriptblock]$test) {
  try {
    if (& $test) { Write-Host "  OK   $label" -ForegroundColor Green }
    else { Write-Host "  FAIL $label" -ForegroundColor Red; $script:failures += $label }
  } catch {
    Write-Host "  FAIL $label ($($_.Exception.Message))" -ForegroundColor Red
    $script:failures += $label
  }
}

$latest = Invoke-GitHub 'GET' "$api/repos/$owner/$name/releases/latest" $null
Check 'latest 指向本次版本' { $latest.tag_name -eq $tag }
Check 'latest 有 arm64 APK' { @($latest.assets | Where-Object { $_.name -like '*arm64*.apk' }).Count -ge 1 }
Check 'latest 有 latest.json' { @($latest.assets | Where-Object { $_.name -eq 'latest.json' }).Count -eq 1 }
Check 'APK digest 与本地一致' {
  $remote = ($latest.assets | Where-Object { $_.name -like '*arm64*.apk' } | Select-Object -First 1).digest
  $remote -eq "sha256:$apkHash"
}
Check '更新清单的 sha256 与 APK 一致' {
  $asset = $latest.assets | Where-Object { $_.name -eq 'latest.json' } | Select-Object -First 1
  $body = GetAssetJson $asset.id
  $body.version -eq $Version -and $body.sha256 -eq $apkHash
}
if ((Test-Path $runtimeTar) -and -not $SkipRuntime) {
  Check '运行时清单存在' { @($latest.assets | Where-Object { $_.name -eq 'runtime-arm64-v8a.json' }).Count -eq 1 }
  Check '运行时清单里的 tar 资产可下载且 sha256 一致' {
    $asset = $latest.assets | Where-Object { $_.name -eq 'runtime-arm64-v8a.json' } | Select-Object -First 1
    $m = GetAssetJson $asset.id
    $runtimeSha = (Get-FileHash $runtimeTar -Algorithm SHA256).Hash.ToLower()
    if ($m.sha256 -ne $runtimeSha) { return $false }
    # 按资产 id 取前 1KB：手机端就是这么下的（Accept: application/octet-stream）。
    # GitHub 资产会 302 跳到签名地址，必须 -L 跟随（Dart 的 http 默认会跟随）。
    $probeArgs = @('-sSL', '-o', 'NUL', '-w', '%{http_code}', '-r', '0-1023', '-H', 'Accept: application/octet-stream')
    if ($token) { $probeArgs += @('-H', "Authorization: Bearer $token") }
    $probe = & curl.exe @probeArgs $m.url 2>&1
    "$probe".Trim() -in @('200', '206')
  }
}

Write-Host ''
Write-Host '发布完成：' -ForegroundColor Green
Write-Host "  下载页: https://github.com/$Repo/releases/tag/$tag"
Write-Host "  清单  : https://github.com/$Repo/releases/download/$tag/latest.json"
Write-Host "  SHA256: $apkHash"
if ($failures.Count -gt 0) {
  Write-Host "自检有 $($failures.Count) 项未通过：$($failures -join '; ')" -ForegroundColor Red
  throw '发布自检失败'
}
Write-Host '自检全部通过。' -ForegroundColor Green
