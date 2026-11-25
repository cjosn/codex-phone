# Install the workspace Android build dependencies using Google's SDK Manager.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'env.ps1')

if (-not $env:JAVA_HOME -or -not (Test-Path (Join-Path $env:JAVA_HOME 'bin/java.exe'))) {
    throw 'The workspace JDK is not ready.'
}
$sdkmanager = Join-Path $env:ANDROID_HOME 'cmdline-tools/latest/bin/sdkmanager.bat'
if (-not (Test-Path $sdkmanager)) { throw "Missing SDK Manager at $sdkmanager" }

$flutterExtension = Join-Path $PSScriptRoot 'sdk/flutter/packages/flutter_tools/gradle/src/main/kotlin/FlutterExtension.kt'
$source = Get-Content -LiteralPath $flutterExtension -Raw
if ($source -notmatch 'val ndkVersion: String = "([\d.]+)"') { throw 'Flutter NDK version was not found.' }
$ndk = $Matches[1]
if ($source -notmatch 'val compileSdkVersion: Int = (\d+)') { throw 'Flutter compile SDK version was not found.' }
$platform = $Matches[1]

$packages = @('platform-tools', "platforms;android-$platform", 'build-tools;36.0.0', "ndk;$ndk", 'cmake;3.22.1')
$logDirectory = Join-Path $PSScriptRoot 'cache'
New-Item -ItemType Directory -Force $logDirectory | Out-Null
$log = Join-Path $logDirectory ("install-android-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$sdkRoot = "--sdk_root=$env:ANDROID_HOME"

"SDK Manager log: $log" | Write-Host
"Installing $($packages -join ', ')" | Set-Content -LiteralPath $log
# License acceptance is required by sdkmanager before installing packages.
@('y') * 100 | & $sdkmanager $sdkRoot --licenses *>> $log
if ($LASTEXITCODE -ne 0) { throw "License acceptance failed ($LASTEXITCODE); see $log" }

& $sdkmanager $sdkRoot --install @packages *>> $log
if ($LASTEXITCODE -ne 0) { throw "SDK installation failed ($LASTEXITCODE); see $log" }

foreach ($package in $packages) {
    $metadata = Join-Path $env:ANDROID_HOME ($package.Replace(';', '/') + '/package.xml')
    if (-not (Test-Path -LiteralPath $metadata -PathType Leaf)) { throw "Missing $package metadata; see $log" }
}
'SDK packages verified.' | Add-Content -LiteralPath $log
Write-Host 'Android SDK installation verified.'
