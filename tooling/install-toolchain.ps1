# install-toolchain.ps1 — 在本机装 dsh-go/codex-go 的 Android 构建工具链（Windows 原生，不需要 WSL）
#
# 对齐官方 tooling/setup-toolchain.sh 的版本选择（Flutter 3.47.x stable / Temurin JDK 17 /
# compileSdk 36），但全部走 Windows 包 + 国内镜像：
#   JDK     清华 Adoptium 镜像
#   Flutter storage.flutter-io.cn（官方脚本用的同一面镜子）
#   SDK     dl.google.com（本机实测 200）
#
# 用法：
#   .\install-toolchain.ps1              # 装到 %USERPROFILE%\dev
#   .\install-toolchain.ps1 -Check       # 只体检
#   .\install-toolchain.ps1 -Root D:\dev # 换安装位置
#
# 幂等：已经装好的步骤直接跳过。装完 source 一下 env.ps1（或重启终端）。

[CmdletBinding()]
param(
  [string]$Root = "$env:USERPROFILE\dev",
  [switch]$Check,
  [string]$FlutterVersion = "3.47.7",
  [string]$CmdlineToolsBuild = "13114758"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # 让 Invoke-WebRequest 快很多

$JdkDir     = Join-Path $Root "jdk-17"
$FlutterDir = Join-Path $Root "flutter"
$SdkDir     = Join-Path $Root "android-sdk"
$Dl         = Join-Path $Root ".downloads"

function Log([string]$m) { Write-Host ("[toolchain {0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m) }
function Have([string]$p) { Test-Path -LiteralPath $p }

function Get-Http([string]$url, [string]$dest) {
  if (Have $dest) { Log "已下载：$(Split-Path $dest -Leaf)"; return }
  New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
  $tmp = "$dest.part"
  Log "下载 $url"
  # 大文件走 HttpClient，避免 Invoke-WebRequest 的内存占用
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $client  = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromMinutes(60)
  $resp = $client.GetAsync($url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
  if (-not $resp.IsSuccessStatusCode) { throw "HTTP $([int]$resp.StatusCode) $url" }
  $total = $resp.Content.Headers.ContentLength
  $in = $resp.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
  $out = [System.IO.File]::Create($tmp)
  try {
    $buf = New-Object byte[] (1MB)
    $done = 0L; $last = 0
    while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
      $out.Write($buf, 0, $n); $done += $n
      $pct = if ($total) { [int]($done * 100 / $total) } else { 0 }
      if ($pct -ge $last + 5) { Write-Host ("  {0}% ({1:N0} MB)" -f $pct, ($done / 1MB)); $last = $pct }
    }
  } finally { $out.Dispose(); $in.Dispose(); $client.Dispose() }
  Move-Item -LiteralPath $tmp -Destination $dest -Force
}

# ---------------------------------------------------------------- 体检
function Report {
  Log "安装根目录：$Root"
  Log ("JDK     " + $(if (Have (Join-Path $JdkDir "bin\java.exe")) { "OK  $JdkDir" } else { "缺失" }))
  Log ("Flutter " + $(if (Have (Join-Path $FlutterDir "bin\flutter.bat")) { "OK  $FlutterDir" } else { "缺失" }))
  Log ("SDK     " + $(if (Have (Join-Path $SdkDir "cmdline-tools\latest\bin\sdkmanager.bat")) { "OK  $SdkDir" } else { "缺失" }))
  $plat = Join-Path $SdkDir "platforms\android-36"
  Log ("platform 36 " + $(if (Have $plat) { "OK" } else { "缺失" }))
  Log ("NDK     " + $(if (Have (Join-Path $SdkDir "ndk")) { "OK" } else { "缺失" }))
  $envFile = Join-Path $PSScriptRoot "env.ps1"
  Log ("env.ps1 " + $(if (Have $envFile) { "已生成" } else { "未生成（装完会生成）" }))
}

if ($Check) { Report; return }

New-Item -ItemType Directory -Force -Path $Root, $Dl | Out-Null

# ---------------------------------------------------------------- JDK 17
if (Have (Join-Path $JdkDir "bin\java.exe")) {
  Log "JDK 已在"
} else {
  $base = "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/17/jdk/x64/windows/"
  Log "查询 JDK 列表：$base"
  $html = (Invoke-WebRequest -Uri $base -UseBasicParsing).Content
  $name = ([regex]::Matches($html, 'OpenJDK17U-jdk_x64_windows_hotspot_[0-9._]+\.zip') |
           ForEach-Object { $_.Value } | Sort-Object -Unique | Sort-Object | Select-Object -Last 1)
  if (-not $name) { throw "镜像里找不到 JDK 17 的 zip（页面结构可能变了）" }
  $zip = Join-Path $Dl $name
  Get-Http ($base + $name) $zip
  $tmpDir = Join-Path $Root ".jdk-tmp"
  if (Have $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $tmpDir -Force
  $inner = (Get-ChildItem $tmpDir -Directory | Select-Object -First 1).FullName
  if (Have $JdkDir) { Remove-Item $JdkDir -Recurse -Force }
  Move-Item $inner $JdkDir
  Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
  & (Join-Path $JdkDir "bin\java.exe") -version
}

$env:JAVA_HOME = $JdkDir

# ---------------------------------------------------------------- Flutter
if (Have (Join-Path $FlutterDir "bin\flutter.bat")) {
  Log "Flutter 已在"
} else {
  $name = "flutter_windows_${FlutterVersion}-stable.zip"
  $url = "https://storage.flutter-io.cn/flutter_infra_release/releases/stable/windows/$name"
  $zip = Join-Path $Dl $name
  Get-Http $url $zip
  # 官方脚本里给的是 linux 包的 sha256，Windows 包不同 —— 这里以「能跑起来」为准：
  # 解压后跑 flutter --version 验证，不做假哈希校验。
  $tmpDir = Join-Path $Root ".flutter-tmp"
  if (Have $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $tmpDir -Force
  $inner = (Get-ChildItem $tmpDir -Directory | Select-Object -First 1).FullName
  if (Have $FlutterDir) { Remove-Item $FlutterDir -Recurse -Force }
  Move-Item $inner $FlutterDir
  Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
}

$env:PUB_HOSTED_URL = "https://pub.flutter-io.cn"
$env:FLUTTER_STORAGE_BASE_URL = "https://storage.flutter-io.cn"

# ---------------------------------------------------------------- Android cmdline-tools
if (-not (Have (Join-Path $SdkDir "cmdline-tools\latest\bin\sdkmanager.bat"))) {
  $name = "commandlinetools-win-${CmdlineToolsBuild}_latest.zip"
  $zip = Join-Path $Dl $name
  Get-Http "https://dl.google.com/android/repository/$name" $zip
  $tmpDir = Join-Path $Dl "cmdline-tools-extract"
  if (Have $tmpDir) { Remove-Item $tmpDir -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $tmpDir -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $SdkDir "cmdline-tools") | Out-Null
  $latest = Join-Path $SdkDir "cmdline-tools\latest"
  if (Have $latest) { Remove-Item $latest -Recurse -Force }
  Move-Item (Join-Path $tmpDir "cmdline-tools") $latest
  Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Log "cmdline-tools 已在"
}

$env:ANDROID_HOME = $SdkDir
$env:ANDROID_SDK_ROOT = $SdkDir
$sdkManager = Join-Path $SdkDir "cmdline-tools\latest\bin\sdkmanager.bat"
$env:PATH = "$JdkDir\bin;$FlutterDir\bin;$SdkDir\cmdline-tools\latest\bin;$SdkDir\platform-tools;$env:PATH"

# ---------------------------------------------------------------- SDK 组件
Log "接受 SDK 许可"
$yes = ("y`n" * 40)
$yes | & $sdkManager --sdk_root="$SdkDir" --licenses 2>&1 | Select-Object -Last 3

Log "安装 platform-tools / platforms;android-36 / build-tools;36.0.0 / ndk / cmake"
& $sdkManager --sdk_root="$SdkDir" `
  "platform-tools" "platforms;android-36" "build-tools;36.0.0" "ndk;27.0.12077973" "cmake;3.22.1" 2>&1 |
  Select-Object -Last 8

Log "flutter config"
& (Join-Path $FlutterDir "bin\flutter.bat") config --no-analytics --android-sdk "$SdkDir" --jdk-dir "$JdkDir"
& (Join-Path $FlutterDir "bin\flutter.bat") precache --android
& (Join-Path $FlutterDir "bin\flutter.bat") doctor -v

# ---------------------------------------------------------------- env.ps1
$envFile = Join-Path $PSScriptRoot "env.ps1"
@"
# source 这个文件把 codex-go 的 Android 工具链放进当前会话
`$env:JAVA_HOME = "$JdkDir"
`$env:ANDROID_HOME = "$SdkDir"
`$env:ANDROID_SDK_ROOT = "$SdkDir"
`$env:PUB_HOSTED_URL = "https://pub.flutter-io.cn"
`$env:FLUTTER_STORAGE_BASE_URL = "https://storage.flutter-io.cn"
`$env:PATH = "$JdkDir\bin;$FlutterDir\bin;$SdkDir\cmdline-tools\latest\bin;$SdkDir\platform-tools;`$env:PATH"
"@ | Set-Content -Encoding UTF8 $envFile

Report
Log "完成。用法：. `"$envFile`"   然后 cd 到 app/ 跑 flutter build apk --release --flavor arm64"
