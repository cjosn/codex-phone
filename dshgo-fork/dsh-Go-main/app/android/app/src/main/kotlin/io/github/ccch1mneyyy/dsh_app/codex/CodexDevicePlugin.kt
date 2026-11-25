package io.github.ccch1mneyyy.dsh_app.codex

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * 「设置 → 手机能力」与首次启动授权向导的原生侧：通道开关、档位、免责声明同意、权限跳转。
 * 真正的 HTTP 端点在 [DeviceApiServer]，无障碍操作在 [CodexAccessibilityService]。
 *
 * 跳系统页**必须**带 `package:` URI：不带的话「显示在其他应用上层」「所有文件访问」
 * 打开的是整张应用列表，用户找不到本 App（用户报的「系统页面里找不到这个应用」
 * 一半是这个原因，另一半是 Manifest 里没声明权限——见 AndroidManifest.xml）。
 *
 * 每个权限项回 `{target, status, canOpen, opened}`：
 * - `status` 是**当下**的真实状态（每次现查，不缓存）；
 * - `canOpen=false` 表示这版系统没有这个入口/拿不到 Activity；
 * - `opened=false` 表示跳转没成功。Flutter 侧据此明说「本机不支持，去系统设置手动找」，
 *   而不是弹个「已授权」骗用户。
 */
class CodexDevicePlugin : FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler {
    private lateinit var context: Context
    private lateinit var methods: MethodChannel
    private var activity: Activity? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, CHANNEL)
        methods.setMethodCallHandler(this)
        // 上个进程写的握手文件指向的端口已经没了，先清掉，免得工具连一个死端口。
        DeviceApiServer.get(context).pruneStaleHandshake()
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods.setMethodCallHandler(null)
    }

    // 定位 / 通知 / 旧版存储要走运行时权限对话框，必须有 Activity。
    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
    }

    override fun onDetachedFromActivityForConfigChanges() {
        activity = null
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        activity = binding.activity
    }

    override fun onDetachedFromActivity() {
        activity = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val device = DeviceApiServer.get(context)
        try {
            when (call.method) {
                "status" -> result.success(device.status())
                "enable" -> result.success(device.start())
                "disable" -> result.success(device.stop())
                "setTier" -> result.success(device.setTier(call.argument<String>("tier").orEmpty()))
                "acceptConsent" -> result.success(device.acceptConsent())
                "audit" -> result.success(device.auditSnapshot())
                "openSettings" -> result.success(openSettings(call.argument<String>("target").orEmpty()))
                "restoreAccessibility" -> {
                    // Shell execution blocks; keep the platform channel off the UI thread.
                    Thread({
                        val value = runCatching { device.restoreAccessibility() }
                            .getOrElse { mapOf("restored" to false, "reason" to (it.message ?: "failed")) }
                        android.os.Handler(android.os.Looper.getMainLooper()).post { result.success(value) }
                    }, "codex-a11y-restore-call").apply { isDaemon = true }.start()
                }
                else -> result.notImplemented()
            }
        } catch (cause: DeviceError) {
            result.error(cause.code, cause.message, null)
        } catch (cause: Exception) {
            result.error("device/unavailable", cause.message ?: "The device channel failed", null)
        }
    }

    private fun openSettings(target: String): Map<String, Any?> = when (target) {
        "overlay" -> systemPage(
            target = target,
            status = if (Settings.canDrawOverlays(context)) "granted" else "denied",
            primary = Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:${context.packageName}"),
            ),
            fallback = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION),
        )
        "battery" -> systemPage(
            target = target,
            status = if (batteryExempt()) "ignored" else "optimized",
            primary = Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:${context.packageName}"),
            ),
            fallback = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
        )
        // Android 11+ 才有「所有文件访问」这一页；更老的系统只能靠运行时存储权限。
        "storage" -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            systemPage(
                target = target,
                status = if (Environment.isExternalStorageManager()) "granted" else "denied",
                primary = Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:${context.packageName}"),
                ),
                fallback = Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION),
            )
        } else {
            runtimePermissions(
                target = target,
                status = if (storageGranted()) "granted" else "denied",
                // WRITE 只在 maxSdk 28 内声明；29 上只申请 READ。
                permissions = buildList {
                    add(Manifest.permission.READ_EXTERNAL_STORAGE)
                    if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P) {
                        add(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    }
                }.toTypedArray(),
                fallback = appDetails(),
            )
        }
        "location" -> runtimePermissions(
            target = target,
            status = if (locationGranted()) "granted" else "not-granted",
            permissions = arrayOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            ),
            fallback = appDetails(),
        )
        // Android 13+ 才有 POST_NOTIFICATIONS；更老的系统直接跳本 App 的通知设置页。
        "notifications" -> {
            val status = if (notificationsEnabled()) "enabled" else "disabled"
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                runtimePermissions(
                    target = target,
                    status = status,
                    permissions = arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    fallback = appNotificationSettings(),
                )
            } else {
                systemPage(target = target, status = status, primary = appNotificationSettings())
            }
        }
        "accessibility" -> systemPage(
            target = target,
            status = if (accessibilityEnabled()) "enabled" else "disabled",
            primary = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS),
        )
        "shizuku" -> when {
            CodexShellShizuku.isAuthorized() -> outcome(target, status = "authorized", canOpen = true, opened = true)
            CodexShellShizuku.requestPermission() -> {
                ShellRunner.refreshAvailability(context, force = true)
                outcome(target, status = "permission-requested", canOpen = true, opened = true)
            }
            else -> systemPage(
                target = target,
                status = if (shizukuInstalled()) "installed-not-authorized" else "not-installed",
                // 装了就直接开它的界面去启动服务；没装（或打不开）就去官网下载。
                primary = shizukuLaunchIntent() ?: Intent(Intent.ACTION_VIEW, Uri.parse("https://shizuku.rikka.app/")),
                fallback = Intent(Intent.ACTION_VIEW, Uri.parse("https://shizuku.rikka.app/")),
            )
        }
        "app" -> systemPage(target = target, status = "unknown", primary = appDetails())
        else -> outcome(target, status = "unknown", canOpen = false, opened = false)
    }

    /** 跳一个系统页；主 Intent 打不开就用回落页，两个都打不开才算失败。 */
    private fun systemPage(
        target: String,
        status: String,
        primary: Intent,
        fallback: Intent? = null,
    ): Map<String, Any?> {
        val opened = openIntent(primary) || (fallback != null && openIntent(fallback))
        return outcome(target, status = status, canOpen = true, opened = opened)
    }

    /**
     * 运行时权限（定位 / 通知 / 旧版存储）：弹系统对话框，`opened=true` 表示已经请求。
     * 没有 Activity（插件还没接上界面）时不假装成功：回 canOpen=false 并打开应用详情页，
     * 用户仍能手动去授权。
     */
    private fun runtimePermissions(
        target: String,
        status: String,
        permissions: Array<String>,
        fallback: Intent,
    ): Map<String, Any?> {
        val host = activity
        if (host == null) {
            return outcome(target, status = status, canOpen = false, opened = openIntent(fallback))
        }
        // 走框架 API 而不是 ActivityCompat：本模块 release 变体只编 codex/ 下这几个文件，
        // 不额外依赖 androidx.core（其余插件也都是 host.requestPermissions）。权限结果由页面
        // 回到前台时重新现查，不需要这里再转一道。
        host.requestPermissions(permissions, REQUEST_CODE)
        return outcome(target, status = status, canOpen = true, opened = true)
    }

    private fun openIntent(intent: Intent): Boolean {
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching {
            context.startActivity(intent)
            true
        }.getOrDefault(false)
    }

    private fun outcome(target: String, status: String, canOpen: Boolean, opened: Boolean): Map<String, Any?> =
        mapOf("target" to target, "status" to status, "canOpen" to canOpen, "opened" to opened)

    private fun appDetails(): Intent = Intent(
        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
        Uri.parse("package:${context.packageName}"),
    )

    private fun appNotificationSettings(): Intent =
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)

    private fun storageGranted(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager()
        // WRITE 在 Manifest 里限到 maxSdk 28，Android 10 上要认 READ。
        else context.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED ||
            context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED

    private fun locationGranted(): Boolean =
        context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun notificationsEnabled(): Boolean = runCatching {
        context.getSystemService(android.app.NotificationManager::class.java)?.areNotificationsEnabled() ?: false
    }.getOrDefault(false)

    private fun batteryExempt(): Boolean =
        (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .isIgnoringBatteryOptimizations(context.packageName)

    private fun accessibilityEnabled(): Boolean = CodexAccessibilityService.isEnabled(context)

    private fun shizukuInstalled(): Boolean = runCatching {
        context.packageManager.getPackageInfo(SHIZUKU_PACKAGE, 0)
        true
    }.getOrDefault(false)

    /** 装了 Shizuku 就打开它自己的界面，否则 null（调用方回落官网）。 */
    private fun shizukuLaunchIntent(): Intent? =
        if (shizukuInstalled()) context.packageManager.getLaunchIntentForPackage(SHIZUKU_PACKAGE) else null

    private companion object {
        const val CHANNEL = "codex/device"
        const val REQUEST_CODE = 4310
        const val SHIZUKU_PACKAGE = "moe.shizuku.privileged.api"
    }
}
