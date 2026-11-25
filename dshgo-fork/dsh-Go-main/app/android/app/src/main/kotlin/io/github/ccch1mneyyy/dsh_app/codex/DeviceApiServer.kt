package io.github.ccch1mneyyy.dsh_app.codex

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.Process
import android.os.StatFs
import io.github.ccch1mneyyy.dsh_app.BuildConfig
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.attribute.PosixFilePermissions
import java.security.SecureRandom
import java.util.Base64

/**
 * 本机设备通道（方案 §3）：只绑 `127.0.0.1`、随机端口、Bearer token，
 * 端点与错误码见 `docs/DEVICE-API-CONTRACT.md`。
 *
 * 生命周期：默认**不监听**。用户在「手机能力」页点开启才 [start]（写握手文件），
 * 点「立即退回标准权限」或关闭通道就 [stop]（停端口 + 删握手文件 + 档位回 standard）。
 */
class DeviceApiServer private constructor(private val context: Context) {
    private val access = DeviceAccess(context)
    private val audit = ArrayDeque<JSONObject>()

    @Volatile private var socket: ServerSocket? = null

    @Volatile private var token: String? = null

    @Volatile private var startedAt = 0L

    val isRunning: Boolean get() = socket != null

    @Synchronized
    fun start(): Map<String, Any?> {
        if (socket != null) return status()
        val listening = try {
            ServerSocket().apply {
                reuseAddress = true
                // 端口交给系统随机挑，只监听回环：PRoot 与 App 共享网络命名空间。
                bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 16)
            }
        } catch (cause: IOException) {
            throw DeviceError("device/unavailable", "Cannot listen on 127.0.0.1: ${cause.message}", 500)
        }
        token = newToken()
        startedAt = System.currentTimeMillis()
        socket = listening
        ShellRunner.refreshAvailability(context, force = true)
        writeHandshake()
        Thread({ acceptLoop(listening) }, "codex-device-api").apply { isDaemon = true }.start()
        return status()
    }

    /**
     * 关闭通道：端口立刻停止监听、握手文件删除。
     *
     * **不要在这里降级档位**。档位是用户授予的意图，而「关通道」只是停服务：
     * 旧实现在这里 `resetToStandard()`，于是任何一次 stop（包括重置运行时、切后台被停）
     * 都会把用户选好的 ACCESSIBILITY 永久降回 standard，之后即使无障碍授权一直有效，
     * 读屏/点击也全部 `device/permission-denied`——真机上表现为「明明开了无障碍却检测不到」。
     * 真正该由权限决定的是能力开关，`capabilities()` 已经按 `accessibilityEnabled()` 判过了。
     */
    @Synchronized
    fun stop(): Map<String, Any?> {
        socket = null
        ShellRunner.cancelActive()
        token = null
        startedAt = 0L
        deleteHandshake()
        return status()
    }

    @Synchronized
    fun setTier(raw: String): Map<String, Any?> {
        val tier = DeviceTier.normalize(raw)
        if (raw.isNotBlank() && tier != raw.trim().lowercase() && raw.trim().lowercase() !in DeviceTier.ORDER) {
            throw invalidArgs("Unknown tier \"$raw\"; use standard, accessibility, debugger, admin or root")
        }
        access.tier = tier
        writeHandshake()
        return status()
    }

    @Synchronized
    fun acceptConsent(): Map<String, Any?> {
        access.consent = true
        return status()
    }

    /**
     * App 进程重启后，上个进程写的握手文件指向的端口已经没人监听。
     * 谁置位：只有 [start]；谁清除：[stop] 和这里的启动清理。
     */
    @Synchronized
    fun pruneStaleHandshake() {
        if (!isRunning) deleteHandshake()
    }

    /** 设备通道 + 权限 + 档位的完整快照，Flutter「手机能力」页和原生都读这一份。 */
    @Synchronized
    fun status(): Map<String, Any?> {
        val open = isRunning
        return linkedMapOf(
            "enabled" to open,
            "baseUrl" to if (open) baseUrl() else null,
            "tier" to access.tier,
            "consent" to access.consent,
            "capabilities" to access.capabilities(open),
            "permissions" to access.permissions(),
            "tiers" to access.tiers(),
            "granted" to access.granted(),
            "denied" to access.denied(open),
            "audit" to auditSnapshot(),
            "handshake" to handshakeFile().absolutePath,
            "version" to BuildConfig.VERSION_NAME,
        )
    }

    @Synchronized
    fun auditSnapshot(): List<Map<String, Any?>> = audit.map { entry ->
        mapOf(
            "path" to entry.optString("path"),
            "reason" to entry.optString("reason"),
            "at" to entry.optLong("at"),
        )
    }

    // ---------------------------------------------------------------- HTTP

    private fun acceptLoop(listening: ServerSocket) {
        while (!listening.isClosed) {
            val client = try {
                listening.accept()
            } catch (_: IOException) {
                return
            }
            Thread({ serve(client) }, "codex-device-request").apply { isDaemon = true }.start()
        }
    }

    private fun serve(client: Socket) {
        client.use { connection ->
            val response = try {
                connection.soTimeout = SOCKET_TIMEOUT_MS
                val request = readRequest(BufferedInputStream(connection.getInputStream())) ?: return
                route(request)
            } catch (cause: DeviceError) {
                Response(cause.status, errorBody(cause.code, cause.message ?: cause.code))
            } catch (_: IOException) {
                // 本机回环、一次性连接：客户端断开不需要任何处理。
                return
            }
            try {
                writeResponse(connection, response)
            } catch (_: IOException) {
                // 对端已经走了；响应没人收也不需要补救。
            }
        }
    }

    private fun route(request: Request): Response = try {
        if (!tokenMatches(request)) {
            Response(
                401,
                errorBody(
                    "device/permission-denied",
                    "Bad or missing device token; read it from the handshake file ${handshakeFile().name}",
                ),
            )
        } else {
            dispatch(request)
        }
    } catch (cause: DeviceError) {
        Response(cause.status, errorBody(cause.code, cause.message ?: cause.code))
    } catch (cause: Exception) {
        Response(500, errorBody("device/unavailable", cause.message ?: "Device channel failed"))
    }

    private fun dispatch(request: Request): Response = when ("${request.method} ${request.path}") {
        "GET /capabilities" -> ok(capabilitiesJson())
        "GET /device/info" -> ok(deviceInfo())
        "GET /clipboard" -> ok(readClipboard())
        "POST /clipboard" -> ok(writeClipboard(jsonBody(request).optString("text")))
        "POST /ui/dump" -> {
            val body = jsonBody(request)
            DeviceHud.show(context, "正在读取屏幕")
            ok(
                accessibility().dump(
                    body.optBoolean("includeInvisible", false),
                    body.optInt("maxNodes", DEFAULT_MAX_NODES),
                ),
            )
        }
        "POST /ui/tap" -> {
            DeviceHud.show(context, "正在操作屏幕")
            ok(tap(jsonBody(request)))
        }
        "POST /ui/swipe" -> {
            DeviceHud.show(context, "正在操作屏幕")
            ok(swipe(jsonBody(request)))
        }
        "POST /ui/text" -> {
            DeviceHud.show(context, "正在操作屏幕")
            ok(text(jsonBody(request)))
        }
        "POST /ui/key" -> {
            DeviceHud.show(context, "正在操作屏幕")
            ok(key(jsonBody(request)))
        }
        "POST /ui/screenshot" -> {
            DeviceHud.show(context, "正在截取屏幕")
            ok(accessibility().screenshot(jsonBody(request).optInt("maxWidth", DEFAULT_SCREENSHOT_WIDTH)))
        }
        "GET /app/list" -> {
            requireAccessibility()
            ok(appList(request.query["includeSystem"] == "true"))
        }
        "POST /app/start" -> {
            requireAccessibility()
            val body = jsonBody(request)
            record(request.path, requireReason(body))
            ok(startApp(body.optString("package")))
        }
        "POST /app/stop" -> {
            requireAccessibility()
            record(request.path, requireReason(jsonBody(request)))
            throw shizukuUnavailable(
                "Stopping an app needs shell UID: install Shizuku and authorize Codex Pocket, or use adb over USB",
            )
        }
        "POST /shell/exec" -> {
            val body = jsonBody(request)
            val reason = requireReason(body)
            requireShell()
            val command = body.optString("command")
            val timeout = body.optLong("timeoutMs", ShellCommandPolicy.DEFAULT_TIMEOUT_MS)
            record(request.path, reason)
            DeviceHud.show(context, "正在执行命令")
            val result = ShellRunner.execute(context, command, timeout, access.tier) { isRunning }
            ok(JSONObject(result.asMap()))
        }
        "POST /notifications/recent" -> throw permissionDenied(
            "Notification access is not implemented in this build (Phase C); use the phone's own notification shade",
        )
        else -> Response(
            404,
            errorBody("device/unavailable", "No such endpoint: ${request.method} ${request.path}"),
        )
    }

    private fun tap(body: JSONObject): JSONObject {
        requireAccessibility()
        requireReason(body)
        val text = body.optString("text").trim()
        if (text.isNotEmpty()) {
            record("/ui/tap", body.optString("reason"))
            return accessibility().tapText(text)
        }
        val x = body.optInt("x", -1)
        val y = body.optInt("y", -1)
        if (x < 0 || y < 0) throw invalidArgs("Send either x/y coordinates or text to match")
        record("/ui/tap", body.optString("reason"))
        accessibility().tap(x, y)
        return JSONObject().put("ok", true).put("target", JSONObject().put("x", x).put("y", y))
    }

    private fun swipe(body: JSONObject): JSONObject {
        requireAccessibility()
        requireReason(body)
        val fromX = body.optInt("fromX", -1)
        val fromY = body.optInt("fromY", -1)
        val toX = body.optInt("toX", -1)
        val toY = body.optInt("toY", -1)
        if (fromX < 0 || fromY < 0 || toX < 0 || toY < 0) {
            throw invalidArgs("Send fromX, fromY, toX and toY")
        }
        record("/ui/swipe", body.optString("reason"))
        accessibility().swipe(fromX, fromY, toX, toY, body.optInt("durationMs", 300))
        return JSONObject().put("ok", true)
    }

    private fun text(body: JSONObject): JSONObject {
        requireAccessibility()
        requireReason(body)
        val value = body.optString("text")
        if (value.isEmpty()) throw invalidArgs("Send the text to type")
        record("/ui/text", body.optString("reason"))
        return accessibility().typeText(value, body.optBoolean("submit", false))
    }

    private fun key(body: JSONObject): JSONObject {
        requireAccessibility()
        requireReason(body)
        val name = body.optString("key").trim()
        if (name.isEmpty()) throw invalidArgs("Send key: back, home, recents, enter or del")
        record("/ui/key", body.optString("reason"))
        accessibility().key(name)
        return JSONObject().put("ok", true)
    }

    private fun accessibility(): CodexAccessibilityService {
        requireAccessibility()
        return CodexAccessibilityService.connected()
            ?: throw permissionDenied(
                "Accessibility is enabled but not connected yet; keep Codex Pocket open and retry",
            )
    }

    private fun requireShell() {
        if (!isRunning) throw permissionDenied("Open the device channel in Settings → Phone capabilities before running shell commands")
        if (!access.consent) throw permissionDenied("Accept the phone capability disclaimer before running shell commands")
        if (access.tier != DeviceTier.ROOT && access.tier != DeviceTier.DEBUGGER) {
            throw shizukuUnavailable("Select the ROOT tier or the DEBUGGER tier with an authorized Shizuku service before running shell commands")
        }
    }

    private fun requireAccessibility() {
        if (!access.accessibilityEnabled()) {
            throw permissionDenied("Turn on Codex Pocket in Settings → Accessibility")
        }
        if (!DeviceTier.atLeast(access.tier, DeviceTier.ACCESSIBILITY)) {
            throw permissionDenied(
                "Current tier is ${access.tier}; pick ACCESSIBILITY in Settings → Phone capabilities",
            )
        }
    }

    private fun requireReason(body: JSONObject): String {
        val reason = body.optString("reason").trim()
        if (reason.length < MIN_REASON_LENGTH) {
            throw invalidArgs(
                "This endpoint changes the phone; send \"reason\" (at least $MIN_REASON_LENGTH characters) explaining why",
            )
        }
        return reason
    }

    private fun record(path: String, reason: String) {
        synchronized(audit) {
            audit.addLast(JSONObject().put("path", path).put("reason", reason).put("at", System.currentTimeMillis()))
            while (audit.size > MAX_AUDIT) audit.removeFirst()
        }
    }

    // ------------------------------------------------------------ payloads

    private fun capabilitiesJson(): JSONObject = JSONObject().apply {
        put("tier", access.tier)
        put("tiers", JSONObject(access.tiers()))
        put("granted", JSONArray(access.granted()))
        put("denied", JSONArray(access.denied(isRunning).map { JSONObject(it) }))
        put("capabilities", JSONObject(access.capabilities(isRunning)))
        put("device", deviceBasics())
        put("permissions", JSONObject(access.permissions()))
    }

    private fun deviceBasics(): JSONObject = JSONObject().apply {
        put("model", Build.MODEL ?: "unknown")
        put("brand", Build.BRAND ?: "unknown")
        put("manufacturer", Build.MANUFACTURER ?: "unknown")
        put("sdk", Build.VERSION.SDK_INT)
        put("androidRelease", Build.VERSION.RELEASE ?: "unknown")
    }

    private fun deviceInfo(): JSONObject {
        val battery = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val network = networkState()
        val storage = StatFs(context.filesDir.absolutePath)
        return deviceBasics().apply {
            put(
                "battery",
                JSONObject()
                    .put("percent", battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
                    .put("charging", battery.isCharging),
            )
            put("network", JSONObject().put("type", network.first).put("connected", network.second))
            put(
                "storage",
                JSONObject().put("totalBytes", storage.totalBytes).put("freeBytes", storage.availableBytes),
            )
            put(
                "app",
                JSONObject()
                    .put("versionName", BuildConfig.VERSION_NAME)
                    .put("versionCode", BuildConfig.VERSION_CODE.toLong()),
            )
        }
    }

    private fun networkState(): Pair<String, Boolean> {
        val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val active = manager.activeNetwork ?: return "none" to false
        val capabilities = manager.getNetworkCapabilities(active) ?: return "none" to false
        val type = when {
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        return type to true
    }

    private fun readClipboard(): JSONObject {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = try {
            manager.primaryClip
        } catch (_: SecurityException) {
            null
        } ?: throw permissionDenied(
            "Android only lets the foreground app read the clipboard; open Codex Pocket and retry",
        )
        val text = if (clip.itemCount == 0) "" else clip.getItemAt(0).coerceToText(context)?.toString().orEmpty()
        return JSONObject().put("text", text)
    }

    private fun writeClipboard(text: String): JSONObject {
        val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        manager.setPrimaryClip(ClipData.newPlainText("codex", text))
        return JSONObject().put("text", text)
    }

    private fun appList(includeSystem: Boolean): JSONObject {
        val manager = context.packageManager
        val apps = JSONArray()
        manager.getInstalledApplications(0)
            .asSequence()
            .filter { includeSystem || (it.flags and ApplicationInfo.FLAG_SYSTEM) == 0 }
            .map { info ->
                JSONObject()
                    .put("packageName", info.packageName)
                    .put("label", manager.getApplicationLabel(info).toString())
                    .put("system", (info.flags and ApplicationInfo.FLAG_SYSTEM) != 0)
                    .put("enabled", info.enabled)
            }
            .sortedBy { it.optString("label") }
            .forEach { apps.put(it) }
        return JSONObject().put("apps", apps)
    }

    private fun startApp(rawPackage: String): JSONObject {
        val name = rawPackage.trim()
        if (name.isEmpty()) throw invalidArgs("Send the package name to start")
        val intent = context.packageManager.getLaunchIntentForPackage(name)
            ?: throw invalidArgs("No launchable activity for $name")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        // Android 10+ 可能拦截后台启动；被拦截时系统不抛错，所以只能如实回 accepted。
        val started = runCatching { context.startActivity(intent) }.isSuccess
        if (!started) {
            throw DeviceError("device/unsupported", "The system refused to start $name from the background")
        }
        return JSONObject().put("started", true)
    }

    // ---------------------------------------------------------- handshake

    /** `${CODEX_HOME}/codex-go-device.json`，CODEX_HOME 就是 rootfs 里的 `/root/.codex`。 */
    private fun handshakeFile(): File = File(CodexRuntime.get(context).codexHome, HANDSHAKE_NAME)

    private fun baseUrl(): String? = socket?.let { "http://127.0.0.1:${it.localPort}" }

    @Synchronized
    private fun writeHandshake() {
        val running = socket ?: return
        val value = token ?: return
        val directory = CodexRuntime.get(context).codexHome.apply { mkdirs() }
        val target = File(directory, HANDSHAKE_NAME)
        val staging = File(directory, "$HANDSHAKE_NAME.tmp")
        val payload = JSONObject().apply {
            put("baseUrl", "http://127.0.0.1:${running.localPort}")
            put("token", value)
            put("tier", access.tier)
            put("granted", JSONArray(access.granted()))
            put("version", BuildConfig.VERSION_NAME)
            put("pid", Process.myPid())
            put("startedAt", startedAt)
        }.toString()
        runCatching {
            staging.writeText(payload)
            setOwnerOnly(staging)
            Files.move(
                staging.toPath(),
                target.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
            setOwnerOnly(target)
        }
    }

    private fun setOwnerOnly(file: File) {
        runCatching {
            Files.setPosixFilePermissions(file.toPath(), PosixFilePermissions.fromString("rw-------"))
        }
    }

    private fun deleteHandshake() {
        runCatching { handshakeFile().delete() }
        runCatching { File(handshakeFile().parentFile, "$HANDSHAKE_NAME.tmp").delete() }
    }

    private fun newToken(): String = Base64.getUrlEncoder().withoutPadding()
        .encodeToString(ByteArray(32).also { SecureRandom().nextBytes(it) })

    private fun tokenMatches(request: Request): Boolean {
        val expected = token ?: return false
        val header = request.headers["authorization"] ?: return false
        if (!header.startsWith("Bearer ", ignoreCase = true)) return false
        return header.substring(7).trim() == expected
    }

    private fun jsonBody(request: Request): JSONObject {
        if (request.body.isBlank()) return JSONObject()
        return runCatching { JSONObject(request.body) }
            .getOrElse { throw invalidArgs("Body is not valid JSON") }
    }

    // --------------------------------------------------------------- wire

    private data class Request(
        val method: String,
        val path: String,
        val query: Map<String, String>,
        val headers: Map<String, String>,
        val body: String,
    )

    private data class Response(val status: Int, val body: JSONObject)

    private fun ok(body: JSONObject) = Response(200, body)

    private fun errorBody(code: String, message: String): JSONObject = JSONObject()
        .put("error", JSONObject().put("code", code).put("message", message))

    private fun readRequest(input: InputStream): Request? {
        val requestLine = readLine(input) ?: return null
        val parts = requestLine.split(' ')
        if (parts.size < 2) return null
        val headers = LinkedHashMap<String, String>()
        while (true) {
            val line = readLine(input) ?: break
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
        }
        val target = parts[1]
        val chunked = headers["transfer-encoding"]?.contains("chunked", ignoreCase = true) == true
        val body = if (chunked) {
            readChunked(input)
        } else {
            val length = headers["content-length"]?.toIntOrNull() ?: 0
            if (length > MAX_BODY_BYTES) throw invalidArgs("Request body is larger than $MAX_BODY_BYTES bytes")
            val bytes = ByteArray(length.coerceAtLeast(0))
            var read = 0
            while (read < bytes.size) {
                val count = input.read(bytes, read, bytes.size - read)
                if (count < 0) break
                read += count
            }
            String(bytes, 0, read, Charsets.UTF_8)
        }
        val path = target.substringBefore('?')
        val query = target.substringAfter('?', "")
            .split('&')
            .filter { it.contains('=') }
            .associate { URLDecoder.decode(it.substringBefore('='), "UTF-8") to URLDecoder.decode(it.substringAfter('='), "UTF-8") }
        return Request(parts[0].uppercase(), path, query, headers, body)
    }

    /** `Transfer-Encoding: chunked`：Node 的 http.request 用字符串 body 时可能这么发，得认。 */
    private fun readChunked(input: InputStream): String {
        val output = java.io.ByteArrayOutputStream()
        while (true) {
            val header = readLine(input) ?: break
            val size = header.substringBefore(';').trim().toIntOrNull(16)
                ?: throw invalidArgs("Malformed chunked body")
            if (size == 0) {
                readLine(input) // trailer
                break
            }
            if (output.size() + size > MAX_BODY_BYTES) {
                throw invalidArgs("Request body is larger than $MAX_BODY_BYTES bytes")
            }
            val chunk = ByteArray(size)
            var read = 0
            while (read < size) {
                val count = input.read(chunk, read, size - read)
                if (count < 0) break
                read += count
            }
            output.write(chunk, 0, read)
            readLine(input) // chunk 后面的 CRLF
        }
        return output.toString("UTF-8")
    }

    private fun readLine(input: InputStream): String? {
        val line = StringBuilder()
        while (true) {
            val byte = input.read()
            if (byte < 0) return if (line.isEmpty()) null else line.toString()
            if (byte == '\n'.code) return line.toString().trimEnd('\r')
            line.append(byte.toChar())
            if (line.length > MAX_HEADER_BYTES) return null
        }
    }

    private fun writeResponse(connection: Socket, response: Response) {
        val payload = response.body.toString().toByteArray(Charsets.UTF_8)
        val head = buildString {
            append("HTTP/1.1 ${response.status} ${statusText(response.status)}\r\n")
            append("Content-Type: application/json; charset=utf-8\r\n")
            append("Content-Length: ${payload.size}\r\n")
            append("Cache-Control: no-store\r\n")
            append("Connection: close\r\n\r\n")
        }.toByteArray(Charsets.US_ASCII)
        val output = connection.getOutputStream()
        output.write(head)
        output.write(payload)
        output.flush()
    }

    private fun statusText(status: Int): String = when (status) {
        200 -> "OK"
        400 -> "Bad Request"
        401 -> "Unauthorized"
        404 -> "Not Found"
        500 -> "Internal Server Error"
        else -> "Not Implemented"
    }

    companion object {
        private const val HANDSHAKE_NAME = "codex-go-device.json"
        private const val DEFAULT_MAX_NODES = 1500
        private const val DEFAULT_SCREENSHOT_WIDTH = 1080
        private const val MIN_REASON_LENGTH = 4
        private const val MAX_AUDIT = 50
        private const val MAX_BODY_BYTES = 8 * 1024 * 1024
        private const val MAX_HEADER_BYTES = 8 * 1024
        private const val SOCKET_TIMEOUT_MS = 20_000

        @Volatile
        private var instance: DeviceApiServer? = null

        fun get(context: Context): DeviceApiServer = instance ?: synchronized(this) {
            instance ?: DeviceApiServer(context.applicationContext).also { instance = it }
        }
    }
}
