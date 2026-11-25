package io.github.ccch1mneyyy.dsh_app.codex

import android.app.Activity
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import java.io.File
import java.security.MessageDigest

/** Native lifecycle for the real Codex app-server bundle. No DSH service starts. */
class CodexRuntimePlugin :
    FlutterPlugin,
    MethodChannel.MethodCallHandler,
    EventChannel.StreamHandler,
    ActivityAware,
    PluginRegistry.ActivityResultListener {

    private lateinit var context: Context
    private lateinit var methods: MethodChannel
    private lateinit var events: EventChannel
    private var sink: EventChannel.EventSink? = null
    private val main = Handler(Looper.getMainLooper())
    private val observer: (Map<String, Any?>) -> Unit = { state -> main.post { sink?.success(state) } }

    private var activity: Activity? = null
    private var activityBinding: ActivityPluginBinding? = null
    private var pendingImage: MethodChannel.Result? = null

    /** 应用内更新：下载完成后校验 SHA-256 再调起系统安装器。 */
    private val pendingUpdates = mutableMapOf<Long, Pair<String, String>>() // downloadId -> (sha256, version)

    private val downloadReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
            val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
            val meta = pendingUpdates.remove(id) ?: return
            onUpdateDownloaded(id, meta.first, meta.second)
        }
    }

    private fun onUpdateDownloaded(id: Long, expectedSha: String, version: String) {
        val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val cursor = manager.query(DownloadManager.Query().setFilterById(id)) ?: return
        cursor.use {
            if (!it.moveToFirst()) return
            val statusIndex = it.getColumnIndex(DownloadManager.COLUMN_STATUS)
            val status = if (statusIndex >= 0) it.getInt(statusIndex) else -1
            if (status != DownloadManager.STATUS_SUCCESSFUL) {
                notify("更新下载失败，请稍后重试")
                return
            }
        }
        val uri = manager.getUriForDownloadedFile(id) ?: run {
            notify("下载完成但无法打开文件")
            return
        }
        // 校验哈希：只接受与发布清单一致的包，避免装到被替换的文件。
        val actual = try {
            context.contentResolver.openInputStream(uri)?.use { input ->
                val digest = MessageDigest.getInstance("SHA-256")
                val buffer = ByteArray(256 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    digest.update(buffer, 0, read)
                }
                digest.digest().joinToString("") { "%02x".format(it) }
            }
        } catch (cause: Exception) {
            null
        }
        if (actual == null || !actual.equals(expectedSha, ignoreCase = true)) {
            notify("更新包校验失败，已丢弃（可能是网络被篡改或下载不完整）")
            manager.remove(id)
            return
        }
        notify("更新已下载并通过校验，开始安装 v$version")
        val install = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        runCatching { context.startActivity(install) }
            .onFailure { notify("无法调起安装器，请允许本应用安装未知来源应用后重试") }
    }

    private fun notify(message: String) {
        main.post { Toast.makeText(context, message, Toast.LENGTH_LONG).show() }
    }

    private fun downloadUpdate(call: MethodCall, result: MethodChannel.Result) {
        val url = call.argument<String>("url")?.trim().orEmpty()
        val sha = call.argument<String>("sha256")?.trim().orEmpty()
        val version = call.argument<String>("version")?.trim().orEmpty()
        val uri = Uri.parse(url)
        if (uri.scheme != "https" || uri.host.isNullOrBlank()) {
            result.error("codex/bad-url", "Update URL must be absolute HTTPS", null)
            return
        }
        if (!Regex("^[0-9a-fA-F]{64}$").matches(sha)) {
            result.error("codex/bad-sha", "A 64-char SHA-256 is required before downloading", null)
            return
        }
        try {
            val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            val request = DownloadManager.Request(uri)
                .setTitle("Codex Pocket $version")
                .setDescription("正在下载更新")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .addRequestHeader("Accept", "application/octet-stream")
                .setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, "Codex-Pocket-$version.apk")
                .setMimeType("application/vnd.android.package-archive")
            val id = manager.enqueue(request)
            pendingUpdates[id] = sha to version
            notify("开始下载更新 v$version，完成后自动校验并安装")
            result.success(id)
        } catch (cause: Exception) {
            result.error("codex/download-failed", cause.message ?: "Could not start the download", null)
        }
    }

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        methods = MethodChannel(binding.binaryMessenger, "codex/runtime")
        events = EventChannel(binding.binaryMessenger, "codex/runtime/events")
        methods.setMethodCallHandler(this)
        events.setStreamHandler(this)
        CodexRuntime.get(context).addObserver(observer)
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.registerReceiver(downloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            context.registerReceiver(downloadReceiver, filter)
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        methods.setMethodCallHandler(null)
        events.setStreamHandler(null)
        CodexRuntime.get(context).removeObserver(observer)
        runCatching { context.unregisterReceiver(downloadReceiver) }
        sink = null
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
        activityBinding = binding
        binding.addActivityResultListener(this)
    }

    override fun onDetachedFromActivityForConfigChanges() = detachActivity()

    override fun onDetachedFromActivity() = detachActivity()

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)

    private fun detachActivity() {
        activityBinding?.removeActivityResultListener(this)
        activityBinding = null
        activity = null
        pendingImage?.error("codex/pick-cancelled", "Activity detached before an image was picked", null)
        pendingImage = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        val runtime = CodexRuntime.get(context)
        when (call.method) {
            "status", "logs" -> result.success(runtime.status())
            "connection" -> result.success(runtime.connection())
            "bridgeState" -> result.success(runtime.readBridgeFile())
            "openUrl" -> openUrl(call, result)
            "pickImage" -> pickImage(result)
            "downloadUpdate" -> downloadUpdate(call, result)
            "install", "start", "stop", "reset" -> {
                val intent = Intent(context, CodexRuntimeService::class.java).setAction(call.method)
                if (call.method == "stop") context.startService(intent)
                else context.startForegroundService(intent)
                result.success(runtime.status())
            }
            "downloadRuntime" -> {
                val url = call.argument<String>("url") ?: ""
                val sha = call.argument<String>("sha256") ?: ""
                val version = call.argument<String>("version") ?: "downloaded"
                if (url.isBlank() || sha.isBlank()) {
                    result.error("codex/bad-args", "url and sha256 are required", null)
                } else {
                    runtime.downloadAndInstall(url, sha, version) { ok ->
                        android.os.Handler(android.os.Looper.getMainLooper()).post { result.success(ok) }
                    }
                }
            }
            else -> result.notImplemented()
        }
    }

    private fun openUrl(call: MethodCall, result: MethodChannel.Result) {
        val uri = android.net.Uri.parse(call.argument<String>("url") ?: "")
        if (uri.scheme !in listOf("http", "https") || uri.host.isNullOrBlank()) {
            result.error("codex/invalid-url", "Use an absolute HTTP(S) URL", null)
            return
        }
        try {
            val browser = Intent(Intent.ACTION_VIEW, uri)
            // Do not let a proxy/default handler silently turn the OAuth link
            // into a different app's login page; the user chooses the browser.
            context.startActivity(Intent.createChooser(browser, "使用浏览器完成 ChatGPT 登录").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            result.success(true)
        } catch (_: Exception) {
            result.error("codex/browser-unavailable", "No browser could open this URL", null)
        }
    }

    /** 自定义主题：让用户从系统里挑一张图，复制进应用私有目录，返回绝对路径。 */
    private fun pickImage(result: MethodChannel.Result) {
        val host = activity
        if (host == null) {
            result.error("codex/no-activity", "Cannot pick an image without an attached activity", null)
            return
        }
        if (pendingImage != null) {
            result.error("codex/pick-busy", "Another image picker is already open", null)
            return
        }
        pendingImage = result
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            type = "image/*"
            addCategory(Intent.CATEGORY_OPENABLE)
        }
        runCatching { host.startActivityForResult(intent, REQUEST_PICK_IMAGE) }
            .onFailure {
                pendingImage = null
                result.error("codex/pick-failed", it.message ?: "Could not open the picker", null)
            }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST_PICK_IMAGE) return false
        val result = pendingImage ?: return true
        pendingImage = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) {
            result.success(null)
            return true
        }
        try {
            val dir = File(context.filesDir, "theme").apply { mkdirs() }
            val target = File(dir, "background-${System.currentTimeMillis()}.img")
            context.contentResolver.openInputStream(uri)?.use { input ->
                target.outputStream().use { output -> input.copyTo(output) }
            } ?: throw IllegalStateException("The picked image could not be opened")
            result.success(target.absolutePath)
        } catch (cause: Exception) {
            result.error("codex/pick-failed", cause.message ?: "Could not import the image", null)
        }
        return true
    }

    override fun onListen(arguments: Any?, eventSink: EventChannel.EventSink) {
        sink = eventSink
        eventSink.success(CodexRuntime.get(context).status())
    }

    override fun onCancel(arguments: Any?) {
        sink = null
    }

    private companion object {
        private const val REQUEST_PICK_IMAGE = 7301
    }
}
