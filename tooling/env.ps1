# Workspace-local Codex Go toolchain. Dot-source this file before building.
$codexSdk = Join-Path $PSScriptRoot 'sdk'
$codexJdk = Get-ChildItem (Join-Path $codexSdk 'java') -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path (Join-Path $_.FullName 'bin/java.exe') } | Select-Object -First 1
if ($codexJdk) { $env:JAVA_HOME = $codexJdk.FullName }
$env:ANDROID_HOME = Join-Path $codexSdk 'android-sdk'
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:PUB_HOSTED_URL = 'https://pub.flutter-io.cn'
$env:FLUTTER_STORAGE_BASE_URL = 'https://storage.flutter-io.cn'
$env:PUB_CACHE = Join-Path $codexSdk 'pub-cache'
$env:GRADLE_USER_HOME = Join-Path $codexSdk 'gradle-cache'
$env:FLUTTER_SUPPRESS_ANALYTICS = 'true'
$env:DSH_TEST_FONT_DIR = Join-Path $codexSdk 'test-fonts'
$env:CI = 'true'
# Flutter persists its tool state under APPDATA; keep it inside this workspace.
$env:APPDATA = Join-Path $codexSdk 'user-state/roaming'
$env:LOCALAPPDATA = Join-Path $codexSdk 'user-state/local'
$env:XDG_CONFIG_HOME = Join-Path $codexSdk 'user-state/config'
$env:ANDROID_USER_HOME = Join-Path $codexSdk 'user-state/android'
$env:TEMP = Join-Path $codexSdk 'user-state/temp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:APPDATA,$env:LOCALAPPDATA,$env:XDG_CONFIG_HOME,$env:ANDROID_USER_HOME,$env:TEMP | Out-Null
$codexBins = @((Join-Path $codexSdk 'git/cmd'),(Join-Path $codexSdk 'git/mingw64/bin'),(Join-Path $codexSdk 'git/usr/bin'),(Join-Path $codexSdk 'flutter/bin'),(Join-Path $env:ANDROID_HOME 'cmdline-tools/latest/bin'),(Join-Path $env:ANDROID_HOME 'platform-tools'))
if ($codexJdk) { $codexBins += Join-Path $codexJdk.FullName 'bin' }
$env:PATH = ($codexBins -join ';') + ';' + $env:PATH
