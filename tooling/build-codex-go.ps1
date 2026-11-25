[CmdletBinding()]
param(
    [ValidateSet('arm64','x64')][string]$Flavor = 'arm64',
    [string]$Version = '0.1.0',
    [string]$Python = 'python',
    [switch]$SkipTests
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')
$project = Join-Path $PSScriptRoot '../dshgo-fork/dsh-Go-main/app'
$abi = if ($Flavor -eq 'arm64') { 'android-arm64' } else { 'android-x64' }
$runtimeAbi = if ($Flavor -eq 'arm64') { 'arm64-v8a' } else { 'x86_64' }
$manifest = Join-Path $project "../runtime/out/$runtimeAbi/assets/runtime/manifest.json"
if (-not (Test-Path -LiteralPath $manifest)) { throw "Build the matching $runtimeAbi runtime before building the APK." }
$runtimeMetadata = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if ($runtimeMetadata.codexGo.engine -ne 'codex-app-server' -or $runtimeMetadata.final -ne $true) {
    throw 'Build and verify a final real Codex app-server runtime first; a DSH or staging runtime cannot be packaged.'
}
function Invoke-Checked([scriptblock]$Command, [string]$Label) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}
Push-Location $project
try {
    Invoke-Checked { flutter pub get } 'Flutter dependency resolution'
    Invoke-Checked { dart analyze lib/main.dart lib/codex test/codex_pocket } 'Independent Codex source analysis'
    if (-not $SkipTests) {
        Invoke-Checked { flutter test --no-pub test/codex_pocket } 'Codex native tests'
    }
    Invoke-Checked { flutter build apk --no-pub --release --flavor $Flavor --target-platform $abi --build-name $Version "--dart-define=CODEX_GO_APP_VERSION=$Version" } 'Android source build'
    $apk = Join-Path $project "build/app/outputs/flutter-apk/app-$Flavor-release.apk"
    if (-not (Test-Path -LiteralPath $apk)) { throw 'Gradle completed without the expected APK.' }
    Get-Item $apk | Select-Object FullName,Length
    Get-FileHash -Algorithm SHA256 -LiteralPath $apk
} finally {
    Pop-Location
}
