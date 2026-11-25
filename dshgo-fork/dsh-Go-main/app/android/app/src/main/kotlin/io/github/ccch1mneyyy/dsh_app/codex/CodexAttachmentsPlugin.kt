package io.github.ccch1mneyyy.dsh_app.codex

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.PluginRegistry
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** User initiated SAF/clipboard attachments; reads bounded bytes off the UI thread. */
class CodexAttachmentsPlugin : FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler,
    PluginRegistry.ActivityResultListener {
    private lateinit var context: Context
    private lateinit var channel: MethodChannel
    private lateinit var worker: ExecutorService
    private val main = Handler(Looper.getMainLooper())
    private var binding: ActivityPluginBinding? = null
    private var pending: Pending? = null
    private class Pending(val result: MethodChannel.Result, val images: Boolean)

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        worker = Executors.newSingleThreadExecutor()
        channel = MethodChannel(binding.binaryMessenger, "codex/attachments")
        channel.setMethodCallHandler(this)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        cancelPending()
        channel.setMethodCallHandler(null)
        this.binding?.removeActivityResultListener(this)
        this.binding = null
        worker.shutdownNow()
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        this.binding = binding
        binding.addActivityResultListener(this)
    }

    override fun onDetachedFromActivityForConfigChanges() {
        // Keep the pending selection across rotation; reattach its result listener.
        binding?.removeActivityResultListener(this)
        binding = null
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = onAttachedToActivity(binding)

    override fun onDetachedFromActivity() {
        binding?.removeActivityResultListener(this)
        binding = null
        cancelPending()
    }

    private fun cancelPending() {
        val request = pending ?: return
        pending = null
        request.result.success(outcome(cancelled = true))
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        if (call.method !in setOf("pickImages", "pickFiles", "readClipboardImage")) {
            result.notImplemented()
            return
        }
        if (pending != null) {
            result.error("attachments/busy", "另一个附件选择仍在进行，请先完成或取消。", null)
            return
        }
        val activity = binding?.activity
        if (activity == null) {
            result.error("attachments/no-activity", "请返回对话页面后再选择附件。", null)
            return
        }
        val request = Pending(result, call.method != "pickFiles")
        pending = request
        if (call.method == "readClipboardImage") {
            // Clipboard APIs are invoked only by this explicit Flutter action.
            try {
                val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                val clip = clipboard.primaryClip
                val uris = buildList {
                    if (clip != null) for (index in 0 until clip.itemCount) {
                        val uri = clip.getItemAt(index).uri ?: continue
                        if (uri.scheme == "content" && context.contentResolver.getType(uri) in IMAGE_MIMES) {
                            add(uri)
                            break
                        }
                    }
                }
                if (uris.isEmpty()) finish(request, outcome(warnings = listOf("剪贴板中没有可读取的图片。")))
                else readUris(request, uris)
            } catch (_: SecurityException) {
                finish(request, outcome(warnings = listOf("无法读取剪贴板图片，请重新复制或从相册选择。")))
            } catch (_: Exception) {
                finish(request, outcome(warnings = listOf("剪贴板图片暂不可用，请从相册选择。")))
            }
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = if (request.images) "image/*" else "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            putExtra(Intent.EXTRA_MIME_TYPES, if (request.images) IMAGE_MIMES.toTypedArray()
                else arrayOf("text/plain", "text/markdown", "text/x-markdown", "application/octet-stream"))
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        try {
            activity.startActivityForResult(intent, REQUEST_CODE)
        } catch (_: Exception) {
            pending = null
            result.error("attachments/picker-unavailable", "系统文件选择器不可用，请稍后重试。", null)
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
        if (requestCode != REQUEST_CODE) return false
        val request = pending ?: return true
        if (resultCode != Activity.RESULT_OK || data == null) {
            finish(request, outcome(cancelled = true))
            return true
        }
        val uris = buildList {
            data.clipData?.let { clip ->
                // Read every provider-selected item; cumulative text bytes are checked below.
                for (index in 0 until clip.itemCount) {
                    clip.getItemAt(index).uri?.let { add(it) }
                }
            }
            if (isEmpty()) data.data?.let { add(it) }
        }.distinct()
        if (uris.isEmpty()) finish(request, outcome(cancelled = true))
        else readUris(request, uris)
        return true
    }

    private fun readUris(request: Pending, uris: List<Uri>) {
        worker.execute {
            val items = mutableListOf<Map<String, Any>>()
            val warnings = mutableListOf<String>()
            var remaining = TOTAL_FILE_BYTES
            for (uri in uris) {
                if (Thread.currentThread().isInterrupted) return@execute
                try {
                    val item = readOne(uri, request.images)
                    val size = (item["bytes"] as ByteArray).size
                    if (!request.images && size > remaining) {
                        warnings.add("文本附件合计最多 64 MiB，已忽略「${item["name"]}」。")
                        continue
                    }
                    items.add(item)
                    if (!request.images) remaining -= size
                } catch (cause: Exception) {
                    warnings.add(cause.message ?: "附件读取失败，请重新选择。")
                }
            }
            main.post { finish(request, outcome(items, warnings)) }
        }
    }

    private fun readOne(uri: Uri, image: Boolean): Map<String, Any> {
        require(uri.scheme == "content") { "仅接受系统选择器提供的附件。" }
        val resolver = context.contentResolver
        val sourceMime = resolver.getType(uri)?.lowercase()
        var name: String? = null
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) name = cursor.getString(0)
        }
        val mime: String
        if (image) {
            require(sourceMime in IMAGE_MIMES) { "仅支持 PNG、JPEG、WebP、GIF 图片。" }
            mime = sourceMime!!
            if (name == null) name = "image.${if (mime == "image/jpeg") "jpg" else mime.substringAfter('/')}"
            val ext = name!!.substringAfterLast('.', "").lowercase()
            require(ext.isEmpty() || ext in setOf("png", "jpg", "jpeg", "webp", "gif")) { "图片文件扩展名不受支持。" }
        } else {
            require(name != null && Regex("(?i).+\\.(md|txt)$").matches(name!!)) { "仅支持 .md 和 .txt 文件。" }
            require(sourceMime == null || sourceMime in TEXT_MIMES || sourceMime == "application/octet-stream") { "文本附件 MIME 类型不受支持。" }
            mime = if (name!!.endsWith(".md", true)) "text/markdown" else "text/plain"
        }
        val safeName = name!!
        require(safeName.toByteArray(Charsets.UTF_8).size <= 255 && !Regex("[\\x00-\\x1f\\x7f/\\\\]").containsMatchIn(safeName)) { "附件名称无效。" }
        val bound = if (image) IMAGE_BYTES else FILE_BYTES
        // One extra byte distinguishes exact-limit files from oversize files.
        val bytes = resolver.openInputStream(uri)?.use { stream ->
            val output = ByteArrayOutputStream(minOf(bound + 1, 8192))
            val chunk = ByteArray(8192)
            while (output.size() <= bound) {
                if (Thread.currentThread().isInterrupted) throw InterruptedException()
                val read = stream.read(chunk, 0, minOf(chunk.size, bound + 1 - output.size()))
                if (read < 0) break
                require(read > 0) { "附件读取未返回数据，请重新选择。" }
                output.write(chunk, 0, read)
            }
            output.toByteArray()
        } ?: throw IllegalArgumentException("无法打开附件，请重新选择。")
        if (image) {
            require(bytes.isNotEmpty() && bytes.size <= IMAGE_BYTES) { "图片每张最多 20 MiB。" }
            require(matchesImage(bytes, mime)) { "图片内容与类型不符。" }
            return mapOf("name" to safeName, "mime" to mime, "bytes" to bytes, "truncated" to false)
        }
        require(bytes.size <= FILE_BYTES) { "文本附件每个最多 20 MiB。" }
        val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        require(!text.contains('\u0000')) { "附件不是 UTF-8 文本。" }
        return mapOf("name" to safeName, "mime" to mime, "bytes" to bytes, "truncated" to false)
    }

    private fun matchesImage(bytes: ByteArray, mime: String): Boolean {
        fun starts(magic: ByteArray) = bytes.size >= magic.size && bytes.copyOfRange(0, magic.size).contentEquals(magic)
        return when (mime) {
            "image/png" -> starts(byteArrayOf(137.toByte(), 80, 78, 71, 13, 10, 26, 10))
            "image/jpeg" -> starts(byteArrayOf(255.toByte(), 216.toByte(), 255.toByte()))
            "image/gif" -> starts("GIF87a".toByteArray()) || starts("GIF89a".toByteArray())
            "image/webp" -> starts("RIFF".toByteArray()) && bytes.size >= 12 && String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP"
            else -> false
        }
    }

    private fun finish(request: Pending, value: Map<String, Any>) {
        if (pending !== request) return
        pending = null
        request.result.success(value)
    }

    private fun outcome(items: List<Map<String, Any>> = emptyList(), warnings: List<String> = emptyList(), cancelled: Boolean = false): Map<String, Any> =
        mapOf("attachments" to items, "warnings" to warnings, "cancelled" to cancelled)

    companion object {
        private const val REQUEST_CODE = 46277
        private const val IMAGE_BYTES = 20 * 1024 * 1024
        private const val FILE_BYTES = 20 * 1024 * 1024
        private const val TOTAL_FILE_BYTES = 64 * 1024 * 1024
        private val IMAGE_MIMES = setOf("image/png", "image/jpeg", "image/webp", "image/gif")
        private val TEXT_MIMES = setOf("text/plain", "text/markdown", "text/x-markdown")
    }
}
