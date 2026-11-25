package io.github.ccch1mneyyy.dsh_app.codex

import android.Manifest
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings

/** 分级授权档位。顺序即强弱；只有「实际生效档位」达标的能力才算有权限。 */
object DeviceTier {
    const val STANDARD = "standard"
    const val ACCESSIBILITY = "accessibility"
    const val DEBUGGER = "debugger"
    const val ADMIN = "admin"
    const val ROOT = "root"
    val ORDER = listOf(STANDARD, ACCESSIBILITY, DEBUGGER, ADMIN, ROOT)
    fun normalize(raw: String?): String = raw?.trim()?.lowercase()?.takeIf { it in ORDER } ?: STANDARD
    fun atLeast(tier: String, floor: String): Boolean = ORDER.indexOf(normalize(tier)) >= ORDER.indexOf(floor)
}

/**
 * 设备通道的错误：`code` 用契约词表（`docs/DEVICE-API-CONTRACT.md` §1），
 * `message` 必须可执行——工具会把这两样原样回给模型和用户。
 */
class DeviceError(val code: String, message: String, val status: Int = 501) : Exception(message)

fun permissionDenied(message: String) = DeviceError("device/permission-denied", message, 501)

fun invalidArgs(message: String) = DeviceError("args/invalid", message, 400)

fun shizukuUnavailable(message: String) = DeviceError("device/shizuku-unavailable", message, 501)

/**
 * 「手机能力」页背后的本机状态。
 *
 * 档位与免责声明同意是持久化的用户选择；权限状态每次现查，不做缓存——
 * 用户随时可能在系统设置里改，缓存只会让页面和工具都撒谎。
 */
class DeviceAccess(context: Context) {
    private val app = context.applicationContext
    private val prefs = app.getSharedPreferences("codex-device", Context.MODE_PRIVATE)

    var tier: String
        get() = DeviceTier.normalize(prefs.getString(KEY_TIER, DeviceTier.STANDARD))
        set(value) {
            prefs.edit().putString(KEY_TIER, DeviceTier.normalize(value)).apply()
        }

    /** 免责声明是否已同意（方案 §6：同意后才允许选更高档位）。 */
    var consent: Boolean
        get() = prefs.getBoolean(KEY_CONSENT, false)
        set(value) {
            prefs.edit().putBoolean(KEY_CONSENT, value).apply()
        }

    /** 「立即退回标准权限」：档位回到 standard；同意记录保留（它只是免责声明，不是权限）。 */
    fun resetToStandard() {
        tier = DeviceTier.STANDARD
    }

    fun accessibilityEnabled(): Boolean = CodexAccessibilityService.isEnabled(app)

    /**
     * 存储权限：Android 11+ 看「所有文件访问」；更老的系统看运行时存储权限
     * （WRITE 在 Manifest 里限到 maxSdk 28，所以 29 上要认 READ）。
     */
    fun storageGranted(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager()
        else app.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED ||
            app.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    fun overlayGranted(): Boolean = Settings.canDrawOverlays(app)

    fun batteryExempt(): Boolean =
        (app.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(app.packageName)

    fun locationGranted(): Boolean =
        app.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    /**
     * 通知是否开着（Android 13+ 还有 POST_NOTIFICATIONS 运行时权限，但最终都以这个为准：
     * 用户在系统里关掉通知渠道后，这里就是 false）。
     */
    fun notificationsEnabled(): Boolean = runCatching {
        app.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() ?: false
    }.getOrDefault(false)

    /** Shizuku 是否安装；安装本身不代表服务运行或已授权。 */
    fun shizukuInstalled(): Boolean = CodexShellShizuku.installed(app)

    /** 权限清单，值域与契约 `/capabilities.permissions` 一致。 */
    fun permissions(): Map<String, String> = linkedMapOf(
        "storage" to if (storageGranted()) "granted" else "denied",
        "overlay" to if (overlayGranted()) "granted" else "denied",
        "batteryOptimization" to if (batteryExempt()) "ignored" else "optimized",
        "location" to if (locationGranted()) "granted" else "not-granted",
        "notifications" to if (notificationsEnabled()) "enabled" else "disabled",
        "accessibility" to if (accessibilityEnabled()) "enabled" else "disabled",
        "shizuku" to when {
            ShellRunner.shizukuAvailable(app) -> "authorized"
            shizukuInstalled() -> "installed-not-authorized"
            else -> "not-installed"
        },
        "root" to if (ShellRunner.rootAvailable(app)) "available" else "unavailable",
        // 本版没有声明 DeviceAdminReceiver：不假装能授权。
        "admin" to "not-granted",
    )

    fun granted(): List<String> = buildList {
        if (accessibilityEnabled()) add("accessibility")
        if (storageGranted()) add("storage")
        if (overlayGranted()) add("overlay")
        if (batteryExempt()) add("battery")
        if (locationGranted()) add("location")
    }

    /** 可用性来自后台真实探测；安装包存在不能让 DEBUGGER 变为可用。 */
    fun tiers(): Map<String, Boolean> = linkedMapOf(
        DeviceTier.STANDARD to true,
        DeviceTier.ACCESSIBILITY to accessibilityEnabled(),
        DeviceTier.DEBUGGER to ShellRunner.shizukuAvailable(app),
        DeviceTier.ADMIN to false,
        DeviceTier.ROOT to ShellRunner.rootAvailable(app),
    )

    /**
     * 每项能力的**真实**可用性（工具先查 `/capabilities` 再断言）。
     * [channelOpen] = 设备通道在监听（用户在「手机能力」页点过开启）。
     */
    fun capabilities(channelOpen: Boolean): Map<String, Boolean> {
        val a11y = channelOpen && accessibilityEnabled() && DeviceTier.atLeast(tier, DeviceTier.ACCESSIBILITY)
        val screenshot = a11y && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
        val shellBackend = when (tier) {
            DeviceTier.ROOT -> ShellRunner.rootAvailable(app) || ShellRunner.shizukuAvailable(app)
            DeviceTier.DEBUGGER -> ShellRunner.shizukuAvailable(app)
            else -> false
        }
        return linkedMapOf(
            "ui_dump" to a11y,
            "ui_tap" to a11y,
            "ui_text" to a11y,
            "ui_key" to a11y,
            "ui_screenshot" to screenshot,
            "clipboard" to channelOpen,
            "device_info" to channelOpen,
            "app_list" to a11y,
            "shell" to (channelOpen && shellBackend),
            "notifications" to false,
            "background_tasks" to false,
        )
    }

    /** 未授权项 + 可执行提示；工具可以直接把 hint 转给用户。 */
    fun denied(channelOpen: Boolean): List<Map<String, String>> = buildList {
        if (!channelOpen) {
            add(
                mapOf(
                    "capability" to "device_channel",
                    "hint" to "Open Settings → Phone capabilities in Codex Pocket and turn the device channel on",
                ),
            )
        }
        if (channelOpen && DeviceTier.atLeast(tier, DeviceTier.ACCESSIBILITY) && !accessibilityEnabled()) {
            add(
                mapOf(
                    "capability" to "accessibility",
                    "hint" to "Turn on Codex Pocket in Settings → Accessibility",
                ),
            )
        }
        if (channelOpen && DeviceTier.atLeast(tier, DeviceTier.DEBUGGER) && !capabilities(channelOpen)["shell"]!!) {
            add(
                mapOf(
                    "capability" to "shell",
                    "hint" to "需要 root 或 Shizuku 可执行：启动并授权 root 管理器或 Shizuku，然后返回此页重试",
                ),
            )
        }
        if (DeviceTier.atLeast(tier, DeviceTier.DEBUGGER)) {
            add(
                mapOf(
                    "capability" to "admin",
                    "hint" to "Device Owner needs adb: dpm set-device-owner; this build does not ship it",
                ),
            )
        }
    }

    private companion object {
        const val KEY_TIER = "tier"
        const val KEY_CONSENT = "consent"
    }
}
