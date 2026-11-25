import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.Properties

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val keyProps = Properties().apply {
    rootProject.file("key.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}

// Debug builds use the release key only when it is all there; they are never the build
// that should stop over a half-filled key.properties.
// A password may be nothing but spaces; a path or an alias may not.
val hasWholeReleaseKey = listOf("storeFile", "keyAlias").all { !keyProps.getProperty(it).isNullOrBlank() } &&
    listOf("storePassword", "keyPassword").all { !keyProps.getProperty(it).isNullOrEmpty() } &&
    file(keyProps.getProperty("storeFile")).exists()

// Per-ABI runtime bundles produced by runtime/build-runtime.sh.
val runtimeOut = rootProject.file("../../runtime/out")
// libtawcroot.so for the opt-in tawcroot launch method (runtime/tawcroot/build.py; missing = unavailable).
val tawcrootOut = rootProject.file("../../runtime/out-tawcroot")

// versionCode is the build minute, same encoding as tooling/build_number.py:
// (year - 2026) * 10^8 + MMDDhhmm at UTC+8. tooling/build-apk.sh passes it as
// --build-number; this covers builds that skip the script (flutter run, the
// IDE), where pubspec's `+1` placeholder would be a downgrade and make
// `flutter run` uninstall the installed app, data included.
fun buildMinuteVersionCode(): Int {
    val t = OffsetDateTime.now(ZoneOffset.ofHours(8))
    return (t.year - 2026) * 100_000_000 + t.monthValue * 1_000_000 + t.dayOfMonth * 10_000 + t.hour * 100 + t.minute
}

val appId = providers.gradleProperty("dshAppId").orElse("io.github.codexgo.app").get()
val appName = providers.gradleProperty("dshAppName").orElse("Codex Go").get()

android {
    buildFeatures { buildConfig = true; resValues = true }
    namespace = "io.github.ccch1mneyyy.dsh_app"
    compileSdk = flutter.compileSdkVersion
    // The device tests under src/androidTest are AndroidTestCase tests; these platform libraries
    // carry that API (no longer in android.jar). Device-test classpath only.
    useLibrary("android.test.base")
    useLibrary("android.test.runner")
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = appId
        resValue("string", "app_name", appName)
        resValue("string", "app_identity", appId)
        resValue("string", "action_new_chat", "$appId.action.NEW_CHAT")
        resValue("string", "action_voice_input", "$appId.action.VOICE_INPUT")
        buildConfigField("String", "APP_IDENTITY", "\"$appId\"")
        buildConfigField("String", "APP_NAME", "\"$appName\"")
        // java.nio.file (symlinks while unpacking the rootfs) needs API 26.
        minSdk = 26
        // Target 28 like Termux, so the API 29+ exec restriction on app-private
        // files does not apply to binaries inside the rootfs.
        targetSdk = 28
        versionCode = flutter.versionCode.takeIf { it > 1 } ?: buildMinuteVersionCode()
        versionName = flutter.versionName
    }

    flavorDimensions += "abi"
    productFlavors {
        create("arm64") {
            dimension = "abi"
            ndk { abiFilters += "arm64-v8a" }
        }
        create("x64") {
            dimension = "abi"
            ndk { abiFilters += "x86_64" }
        }
    }

    sourceSets {
        getByName("main") {
            // PRoot JNI comes from the selected runtime; old speech/model assets
            // and optional DSH direct-engine binaries are not part of Codex.
            assets.setSrcDirs(emptyList<String>())
        }
        getByName("arm64") {
            if (providers.gradleProperty("codexLeanApk").orNull != "true") {
                assets.srcDir(File(runtimeOut, "arm64-v8a/assets"))
            }
            jniLibs.srcDir(File(runtimeOut, "arm64-v8a/jniLibs"))
        }
        getByName("x64") {
            assets.srcDir(File(runtimeOut, "x86_64/assets"))
            jniLibs.srcDir(File(runtimeOut, "x86_64/jniLibs"))
        }
    }

    packaging {
        // proot and friends ship as lib*.so; they must be extracted to
        // nativeLibraryDir so they can be executed.
        jniLibs {
            useLegacyPackaging = true
            // sherpa_onnx_android_* 1.13.4 and ORT Android 1.27.0 each ship an ORT 1.27.0
            // (sherpa's own build): either serves both, with the same exports.
            pickFirsts += "**/libonnxruntime.so"
            // Keep the Termux binaries byte-identical to runtime/out (their hashes are in the manifest).
            keepDebugSymbols += listOf("**/libproot.so", "**/libproot-loader.so", "**/libtalloc.so", "**/libandroid-shmem.so", "**/libtawcroot.so")
        }
    }

    lint {
        // targetSdk 28 is deliberate (see docs/architecture.md); not a Play build.
        disable += "ExpiredTargetSdkVersion"
    }

    androidResources {
        noCompress += listOf("gz", "xz", "zst", "tar")
    }

    signingConfigs {
        if (!keyProps.isEmpty) {
            create("release") {
                storeFile = keyProps.getProperty("storeFile")?.let { file(it) }
                storePassword = keyProps.getProperty("storePassword")
                keyAlias = keyProps.getProperty("keyAlias")
                keyPassword = keyProps.getProperty("keyPassword")
                // All three schemes: AGP drops v1 for minSdk 24+, but some installers and
                // security scanners on Chinese ROMs still read the JAR signature.
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        debug {
            // tooling/dev-run.sh installs debug over the release build on a phone, data
            // kept: Android only allows that with the same key.
            if (hasWholeReleaseKey) signingConfig = signingConfigs.getByName("release")
        }
        release {
            // Use the release key when configured; local builds without key.properties fall back to debug.
            signingConfig = signingConfigs.getByName(if (keyProps.isEmpty) "debug" else "release")
            // Ours on top of Flutter's: phone control's privileged process and
            // its TLS libraries are reached by class name (see the file).
            proguardFiles("proguard-rules.pro")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

// Filter variant compiler inputs too: AGP supplies Kotlin through Java providers.
val codexNativeFiles = setOf(
    "MainActivity.kt", "codex/CodexRuntime.kt", "codex/CodexRuntimeState.kt", "codex/CodexRuntimePlugin.kt",
    "codex/CodexRuntimeService.kt", "runtime/TarExtractor.kt", "runtime/RuntimeProcessOwnership.kt",
    // 手机能力：设备通道 + 无障碍 + Flutter 侧插件（Phase A + B）
    "codex/DeviceAccess.kt", "codex/DeviceApiServer.kt", "codex/CodexAccessibilityService.kt",
    "codex/CodexDevicePlugin.kt", "codex/DeviceHud.kt", "codex/CodexAttachmentsPlugin.kt",
    "codex/ShellRunner.kt", "codex/CodexShellShizukuService.kt"
).map { file("src/main/kotlin/io/github/ccch1mneyyy/dsh_app/$it").canonicalFile }.toSet()
tasks.withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    exclude {
        it.file.extension == "kt" && if (name.contains("Test", ignoreCase = true)) {
            !it.file.invariantSeparatorsPath.contains("/codex/")
        } else {
            it.file.canonicalFile !in codexNativeFiles
        }
    }
}

dependencies {
    implementation("org.tukaani:xz:1.10")
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
