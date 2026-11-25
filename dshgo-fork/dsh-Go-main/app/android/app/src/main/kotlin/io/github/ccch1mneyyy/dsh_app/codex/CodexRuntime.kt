package io.github.ccch1mneyyy.dsh_app.codex

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.system.Os
import android.system.OsConstants
import io.github.ccch1mneyyy.dsh_app.runtime.TarExtractor
import io.github.ccch1mneyyy.dsh_app.runtime.RuntimeProcessOwnership
import io.github.ccch1mneyyy.dsh_app.runtime.RuntimeProcessReader
import io.github.ccch1mneyyy.dsh_app.runtime.RuntimeProcessRecord
import org.json.JSONObject
import java.io.File
import java.net.ServerSocket
import java.security.DigestInputStream
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Installs immutable runtime assets and owns only this app's Codex process tree. */
class CodexRuntime private constructor(private val context: Context) {
    private val owner = File(context.filesDir, "codex-runtime")
    private val root = File(owner, "rootfs")
    private val marker = File(owner, "version")
    // 会话、渠道与工作区不属于可替换的引擎。它们放在 rootfs 外，升级/重装运行时都不动。
    private val guestHome = File(owner, "home")
    private val guestWorkspace = File(owner, "workspace")

    /** PRoot 里的 `CODEX_HOME`（guest `/root/.codex`）在宿主上的落点：设备通道的握手文件写这里。 */
    val codexHome: File get() = guestHome

    /** 把旧版本存在 rootfs 里的用户数据原子搬走；失败就明确停止，不能用空目录覆盖历史。 */
    private fun migratePersistentData() {
        owner.mkdirs()
        val pairs = listOf(
            File(root, "root/.codex") to guestHome,
            File(root, "root/workspace") to guestWorkspace,
        )
        CodexPersistentData.migrate(root, guestHome, guestWorkspace)
    }
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private val observers = CopyOnWriteArraySet<(Map<String, Any?>) -> Unit>()
    private val lines = ArrayDeque<String>()
    private val operation = AtomicBoolean(false)
    @Volatile private var phase = "notInstalled"
    @Volatile private var error: String? = null
    @Volatile private var process: Process? = null
    @Volatile private var baseUrl: String? = null
    @Volatile private var token: String? = null
    @Volatile private var requestedStop = false
    private val processReader = object : RuntimeProcessReader {
        override fun pids(): List<Int> = File("/proc").list()?.mapNotNull { it.toIntOrNull() }.orEmpty()
        override fun uid(pid: Int): Int? = try { Os.stat("/proc/$pid").st_uid } catch (cause: android.system.ErrnoException) {
            if (cause.errno == OsConstants.ENOENT) null else throw cause
        }
        override fun stat(pid: Int) = File("/proc/$pid/stat").readText()
        override fun command(pid: Int) = File("/proc/$pid/cmdline").readText()
        override fun environment(pid: Int) = File("/proc/$pid/environ").readText()
        override fun cwd(pid: Int) = Os.readlink("/proc/$pid/cwd")
    }
    private fun ownedProcesses(): List<RuntimeProcessRecord> {
        val snapshot = RuntimeProcessOwnership.scan(processReader, android.os.Process.myUid(), android.os.Process.myPid())
        return RuntimeProcessOwnership.owned(snapshot.records, setOf(root.canonicalPath), android.os.Process.myPid())
    }
    private fun signalOwned(record: RuntimeProcessRecord, signal: Int) {
        runCatching {
            if (processReader.uid(record.pid) == android.os.Process.myUid() &&
                RuntimeProcessOwnership.stat(processReader.stat(record.pid))?.second == record.started) Os.kill(record.pid, signal)
        }
    }
    private val manifest: JSONObject by lazy {
        runCatching {
            val value = context.assets.open("runtime/manifest.json").bufferedReader().use { JSONObject(it.readText()) }
            require(value.optJSONObject("codexGo")?.optString("engine") == "codex-app-server") { "This APK does not contain a Codex app-server runtime" }
            value
        }.getOrElse {
            // 瘦包（运行时外置）没有 assets/runtime：给一份空清单，靠下载安装。
            JSONObject().put("codexGo", JSONObject().put("engine", "codex-app-server"))
        }
    }

    fun addObserver(observer: (Map<String, Any?>) -> Unit) { observers.add(observer) }
    fun removeObserver(observer: (Map<String, Any?>) -> Unit) { observers.remove(observer) }

    @Volatile private var aliveProbeAt = 0L
    @Volatile private var aliveProbeValue = false

    /** 扫 /proc 找有没有属于本运行时的 bridge 进程；3 秒缓存，避免每次 status() 都全表扫。 */
    private fun bridgeAlive(): Boolean {
        if (process?.isAlive == true) return true
        val now = System.currentTimeMillis()
        if (now - aliveProbeAt < 3_000) return aliveProbeValue
        val found = ownedProcesses().any { record -> record.argv.any { it.contains("codex-go/bridge") } }
        aliveProbeAt = now; aliveProbeValue = found
        return found
    }

    /** App 进程比 bridge 晚启动、或被系统杀掉过：只恢复仍由本应用持有的活动 bridge。 */
    @Synchronized fun restoreBridgeState() {
        if (process != null || phase in setOf("starting", "stopping", "error")) return
        val file = File(owner, "bridge.json")
        if (!file.isFile) return
        runCatching {
            val json = JSONObject(file.readText())
            baseUrl = json.optString("baseUrl").takeIf { it.isNotBlank() }
            token = json.optString("token").takeIf { it.isNotBlank() }
            if (baseUrl != null && token != null) {
                phase = CodexRuntimeState.restoredPhase(root.isDirectory && File(root, "opt/codex/bin/codex").isFile, bridgeAlive())
            }
        }
    }

    /** 直接读落盘的 bridge 地址/令牌。Service 与 UI 可能在不同进程，内存不共享。 */
    @Synchronized fun readBridgeFile(): Map<String, Any?> {
        val file = File(owner, "bridge.json")
        if (!file.isFile) return mapOf("baseUrl" to null, "token" to null)
        return runCatching {
            val json = JSONObject(file.readText())
            mapOf(
                "baseUrl" to json.optString("baseUrl").takeIf { it.isNotBlank() },
                "token" to json.optString("token").takeIf { it.isNotBlank() },
            )
        }.getOrElse { mapOf("baseUrl" to null, "token" to null) }
    }

    private fun persistBridgeState(url: String, value: String) {
        owner.mkdirs()
        val payload = JSONObject().put("baseUrl", url).put("token", value).toString()
        val target = File(owner, "bridge.json")
        val staging = File(owner, "bridge.json.tmp")
        staging.writeText(payload)
        java.nio.file.Files.move(
            staging.toPath(), target.toPath(),
            java.nio.file.StandardCopyOption.ATOMIC_MOVE,
            java.nio.file.StandardCopyOption.REPLACE_EXISTING,
        )
    }

    @Synchronized fun connection(): Map<String, Any?> {
        restoreBridgeState()
        return mapOf(
            "phase" to if (phase == "notInstalled" && marker.isFile && root.isDirectory) "installed" else phase,
            "baseUrl" to baseUrl,
            "token" to token,
            "engine" to "codex",
        )
    }

    @Synchronized fun status(): Map<String, Any?> {
        restoreBridgeState()
        val version = runCatching { manifest.getString("runtimeVersion") }.getOrNull()
        val installed = root.isDirectory && File(root, "opt/codex/bin/codex").isFile
        val installedVersion = runCatching { marker.readText().trim() }.getOrNull()
        return mapOf("phase" to if (phase == "notInstalled" && installed) "installed" else phase,
            "installed" to installed, "bundledVersion" to version, "installedVersion" to installedVersion,
            "token" to token, "error" to error, "logs" to lines.toList(), "engine" to "codex-app-server")
    }
    private var lastPublished: Map<String, Any?>? = null
    @Synchronized private fun publish() {
        val state = CodexRuntimeState.eventSnapshot(status())
        if (state == lastPublished) return
        lastPublished = state
        main.post { observers.forEach { it(state) } }
    }
    @Synchronized private fun log(raw: String) {
        val safe = raw.replace(Regex("([?&]token=)[^\\s&]+"), "$1[redacted]")
            .replace(Regex("(?i)(bearer\\s+)[A-Za-z0-9._~+/=-]+"), "$1[redacted]")
        lines.addLast(safe.take(4096)); while (lines.size > 400) lines.removeFirst()
    }
    private fun fail(cause: Throwable) { error = cause.message ?: cause.javaClass.simpleName; phase = "error"; log("Codex runtime: $error"); publish() }

    fun install(done: (Boolean) -> Unit) {
        if (!operation.compareAndSet(false, true)) { done(false); return }
        worker.execute {
            var ok = false
            try {
                require(process?.isAlive != true) { "Stop Codex before installing a runtime" }
                if (status()["installed"] == true) { phase = "installed"; error = null; ok = true }
                else {
                    // Never replace an existing user's Codex home implicitly.
                    require(!root.exists()) { "A different runtime is installed; back it up before upgrading" }
                    phase = "installing"; error = null; publish()
                    owner.mkdirs()
                    val stage = File(owner, "staging")
                    require(!stage.exists() || stage.deleteRecursively()) { "Could not clear incomplete staging" }
                    stage.mkdirs()
                    val asset = manifest.getString("rootfs")
                    val digest = MessageDigest.getInstance("SHA-256")
                    val raw = context.assets.open("runtime/$asset")
                    val input = DigestInputStream(raw, digest)
                    TarExtractor(stage) { }.extract(input, asset)
                    val actual = digest.digest().joinToString("") { "%02x".format(it) }
                    require(actual == manifest.getString("rootfsSha256")) { "Runtime SHA-256 mismatch" }
                    require(File(stage, "opt/codex/bin/codex").isFile) { "Codex executable is missing" }
                    require(stage.renameTo(root)) { "Could not activate runtime" }
                    marker.writeText(manifest.getString("runtimeVersion"))
                    phase = "installed"; error = null; log("Codex runtime installed and SHA-256 verified"); ok = true
                }
            } catch (cause: Throwable) { fail(cause) }
            finally { operation.set(false); publish(); main.post { done(ok) } }
        }
    }

    /** 运行时外置：从已下载的归档安装（瘦包首次启动走这条路）。 */
    fun installFromFile(archive: File, sha256: String, version: String, done: (Boolean) -> Unit) {
        if (!operation.compareAndSet(false, true)) { done(false); return }
        worker.execute {
            var ok = false
            try {
                require(process?.isAlive != true) { "Stop Codex before installing a runtime" }
                if (status()["installed"] == true) { phase = "installed"; error = null; ok = true }
                else {
                    require(!root.exists()) { "A different runtime is installed; back it up before upgrading" }
                    require(archive.isFile) { "Runtime archive is missing" }
                    phase = "installing"; error = null; publish()
                    owner.mkdirs()
                    val stage = File(owner, "staging")
                    require(!stage.exists() || stage.deleteRecursively()) { "Could not clear incomplete staging" }
                    stage.mkdirs()
                    val digest = MessageDigest.getInstance("SHA-256")
                    archive.inputStream().use { raw ->
                        TarExtractor(stage) { }.extract(DigestInputStream(raw, digest), archive.name)
                    }
                    val actual = digest.digest().joinToString("") { "%02x".format(it) }
                    require(actual == sha256) { "Runtime SHA-256 mismatch" }
                    require(File(stage, "opt/codex/bin/codex").isFile) { "Codex executable is missing" }
                    require(stage.renameTo(root)) { "Could not activate runtime" }
                    marker.writeText(version)
                    phase = "installed"; error = null; log("Downloaded runtime installed and SHA-256 verified"); ok = true
                }
            } catch (cause: Throwable) { fail(cause) }
            finally { operation.set(false); publish(); main.post { done(ok) } }
        }
    }

    /** 从远端下载运行时归档（带进度日志），校验后安装。瘦包首次启动走这里。 */
    fun downloadAndInstall(archiveUrl: String, sha256: String, version: String, done: (Boolean) -> Unit) {
        if (!operation.compareAndSet(false, true)) { done(false); return }
        worker.execute {
            var ok = false
            try {
                require(process?.isAlive != true) { "Stop Codex before installing a runtime" }
                if (status()["installed"] == true) { phase = "installed"; error = null; ok = true }
                else {
                    require(!root.exists()) { "A different runtime is installed; back it up before upgrading" }
                    phase = "installing"; error = null; publish()
                    owner.mkdirs()
                    val target = File(owner, "runtime-download.tar.xz")
                    log("Downloading runtime: $archiveUrl")
                    val conn = (java.net.URL(archiveUrl).openConnection() as java.net.HttpURLConnection).apply {
                        instanceFollowRedirects = true
                        connectTimeout = 30_000
                        readTimeout = 60_000
                        setRequestProperty("Accept", "application/octet-stream")
                    }
                    try {
                        require(conn.responseCode in 200..299) { "HTTP ${conn.responseCode}" }
                        val total = conn.contentLengthLong
                        var copied = 0L
                        var lastPct = -1
                        conn.inputStream.use { input ->
                            target.outputStream().use { output ->
                                val buf = ByteArray(256 * 1024)
                                while (true) {
                                    val n = input.read(buf)
                                    if (n <= 0) break
                                    output.write(buf, 0, n)
                                    copied += n
                                    if (total > 0) {
                                        val pct = (copied * 100 / total).toInt()
                                        if (pct >= lastPct + 5) { lastPct = pct; log("Downloading runtime: $pct% (${copied / 1048576} MB)") }
                                    }
                                }
                            }
                        }
                    } finally { conn.disconnect() }
                    log("Download complete: ${target.length() / 1048576} MB")
                    operation.set(false)
                    installFromFile(target, sha256, version) { installed ->
                        if (installed) target.delete()
                        done(installed)
                    }
                    ok = true
                }
            } catch (cause: Throwable) { fail(cause) }
            finally { if (ok) { operation.set(false) } else { operation.set(false); publish(); main.post { done(false) } } }
        }
    }

    /**
     * 桥原本只存在于 rootfs tarball 里，改一行就要重压 1.1 GB。现在桥同时作为 APK 资产
     * 打包（assets 下的 runtime-bridge 目录），启动前覆盖到已解压的 rootfs 上；资产缺失时
     * 仍用 tarball 里的那份，行为不变。
     */
    private fun overlayBridge() {
        val names = runCatching {
            context.assets.list("runtime/bridge")?.filter { it.endsWith(".mjs") } ?: emptyList()
        }.getOrDefault(emptyList())
        if (names.isEmpty()) return
        val target = File(root, "opt/codex-go/bridge").apply { mkdirs() }
        names.forEach { name ->
            runCatching {
                context.assets.open("runtime/bridge/$name").use { input ->
                    File(target, name).outputStream().use { output -> input.copyTo(output) }
                }
            }
        }
        // 工具包目录（toolpacks/<pack>/index.mjs、toolpacks/_shared.mjs…）也来自资产；
        // MCP 宿主按自身所在目录查找。这里要递归：根目录下既有目录也有共享模块文件。
        runCatching { copyAssetTree("runtime/bridge/toolpacks", File(target, "toolpacks")) }
        // 内置插件（plugins/<name>/plugin.json + toolpacks/ + skills/）同样随 APK 下发。
        runCatching { copyAssetTree("runtime/bridge/plugins", File(target, "plugins")) }
    }

    /** 递归复制 assets 子树；目录与文件混排时按 list() 结果区分。 */
    private fun copyAssetTree(assetDir: String, target: File) {
        val children = context.assets.list(assetDir) ?: return
        if (children.isEmpty()) return
        target.mkdirs()
        for (child in children) {
            val path = "$assetDir/$child"
            val nested = context.assets.list(path)?.toList() ?: emptyList()
            if (nested.isNotEmpty()) {
                copyAssetTree(path, File(target, child))
            } else {
                runCatching {
                    context.assets.open(path).use { input ->
                        File(target, child).outputStream().use { output -> input.copyTo(output) }
                    }
                }
            }
        }
    }

    fun start(exited: () -> Unit) {
        if (!operation.compareAndSet(false, true)) return
        worker.execute {
            try {
                if (process?.isAlive == true) return@execute
                require(status()["installed"] == true) { "Install the Codex runtime first" }
                error = null; requestedStop = false; phase = "starting"; baseUrl = null; token = null; publish()
                val port = runCatching {
                    ServerSocket(37311, 1, java.net.InetAddress.getByName("127.0.0.1")).use { it.localPort }
                }.getOrElse { ServerSocket(0).use { it.localPort } }
                val temp = File(context.cacheDir, "codex-proot-tmp").apply { mkdirs() }
                migratePersistentData()
                File(root, "tmp").mkdirs()
                // Android has no glibc resolver file. Use a bounded explicit guest default.
                File(root, "etc/resolv.conf").writeText("nameserver 223.5.5.5\nnameserver 1.1.1.1\noptions timeout:2 attempts:2\n")
                val nativeDir = context.applicationInfo.nativeLibraryDir
                val proot = File(nativeDir, "libproot.so")
                require(proot.isFile) { "PRoot binary is missing" }
                overlayBridge()
                fun expand(value: String) = value.replace("{PORT}", "$port").replace("{NATIVE_LIB_DIR}", nativeDir)
                    .replace("{ROOTFS}", root.canonicalPath).replace("{CACHE_DIR}", context.cacheDir.canonicalPath)
                val command = mutableListOf(proot.path, "--kill-on-exit", "--link2symlink", "-0", "-r", root.canonicalPath,
                    "-b", "/dev", "-b", "/proc", "-b", "/sys",
                    "-b", "${guestHome.canonicalPath}:/root/.codex",
                    "-b", "${guestWorkspace.canonicalPath}:/root/workspace",
                    "-w", "/root/workspace", "/usr/bin/env", "-i")
                val guest = mutableMapOf("HOME" to "/root", "USER" to "root", "LANG" to "C.UTF-8", "TERM" to "xterm-256color",
                    "PATH" to "/opt/node/bin:/usr/local/bin:/usr/bin:/bin", "TMPDIR" to "/tmp", "CODEX_HOME" to "/root/.codex",
                    "NODE_OPTIONS" to "--dns-result-order=ipv4first", "UV_USE_IO_URING" to "0", "NARB_DISABLE_NATIVE_CACHE" to "1")
                val launch = manifest.getJSONObject("launch")
                launch.optJSONObject("guestEnv")?.let { obj -> obj.keys().forEach { key -> guest[key] = expand(obj.getString(key)) } }
                guest.forEach { (key, value) -> command += "$key=$value" }
                val argv = launch.getJSONArray("argv")
                for (index in 0 until argv.length()) command += expand(argv.getString(index))
                require(command.any { it.contains("codex-go/bridge/server.mjs") }) { "Runtime launch does not target Codex bridge" }
                // 同一安装跨 App/Service 进程和重启复用令牌；缺失或损坏时才轮换。
                val savedToken = (readBridgeFile()["token"] as? String)
                    ?.takeIf(CodexRuntimeState::isPersistedTokenUsable)
                val generatedToken = savedToken ?: java.util.Base64.getUrlEncoder().withoutPadding()
                    .encodeToString(java.security.SecureRandom().generateSeed(32))
                command += listOf("--token", generatedToken)
                token = generatedToken
                baseUrl = "http://127.0.0.1:$port"
                persistBridgeState("http://127.0.0.1:$port", generatedToken)
                val builder = ProcessBuilder(command).directory(root)
                builder.environment().apply {
                    put("PROOT_LOADER", "$nativeDir/libproot-loader.so"); put("PROOT_TMP_DIR", temp.canonicalPath)
                    put("PROOT_L2S_DIR", File(root, "root/.l2s").apply { mkdirs() }.canonicalPath)
                    put("LD_LIBRARY_PATH", nativeDir)
                    launch.optJSONObject("env")?.let { obj -> obj.keys().forEach { key -> put(key, expand(obj.getString(key))) } }
                }
                builder.environment()["PROOT_TMP_DIR"]?.let { File(it).mkdirs() }
                val running = builder.start(); process = running
                fun pump(stream: java.io.InputStream) = Thread {
                    try {
                        stream.bufferedReader().useLines { source -> source.forEach { line ->
                        val match = Regex("^codex-go: (http://127\\.0\\.0\\.1:[0-9]+/?)\\?token=([A-Za-z0-9_-]+)").find(line)
                        if (match != null) {
                            val address = match.groupValues[1].trimEnd('/')
                            val launchToken = match.groupValues[2]
                            Thread {
                                repeat(100) {
                                    if (requestedStop || process !== running || !running.isAlive) return@Thread
                                    val healthy = runCatching {
                                        val connection = java.net.URL("$address/healthz").openConnection() as java.net.HttpURLConnection
                                        try {
                                            connection.connectTimeout = 1500; connection.readTimeout = 1500
                                            connection.setRequestProperty("Authorization", "Bearer $launchToken")
                                            if (connection.responseCode != 200) false else {
                                                val health = connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }
                                                health.optBoolean("ok") && health.optString("engine") == "codex"
                                            }
                                        } finally { connection.disconnect() }
                                    }.getOrDefault(false)
                                    if (healthy) {
                                        if (!requestedStop && process === running) {
                                            baseUrl = address; token = launchToken; phase = "running"
                                            try {
                                                persistBridgeState(address, launchToken)
                                            } catch (cause: Exception) {
                                                fail(cause)
                                                return@Thread
                                            }
                                            publish()
                                        }
                                        return@Thread
                                    }
                                    Thread.sleep(200)
                                }
                                if (process === running && !requestedStop) fail(IllegalStateException("Codex bridge health check timed out"))
                            }.apply { isDaemon = true; start() }
                        }
                        log(line)
                    } }
                    } catch (cause: java.io.IOException) {
                        if (CodexRuntimeState.shouldReportLogStreamFailure(requestedStop, process === running, running.isAlive)) {
                            log("Codex runtime log stream failed: ${cause.message ?: cause.javaClass.simpleName}")
                        }
                    }
                }.apply { isDaemon = true; start() }
                pump(running.inputStream); pump(running.errorStream)
                Thread {
                    val exit = running.waitFor()
                    if (process === running) {
                        process = null; baseUrl = null; token = null; aliveProbeAt = 0
                        if (requestedStop) { phase = "installed"; error = null } else { phase = "error"; error = "Codex process exited ($exit)" }
                        publish(); main.post(exited)
                    }
                }.apply { isDaemon = true; start() }
            } catch (cause: Throwable) { fail(cause); main.post(exited) }
            finally { operation.set(false) }
        }
    }

    /**
     * 重置运行时：删掉 rootfs 与版本标记，**保留** ${owner}/home（会话/渠道/密钥）和 workspace。
     *
     * 为什么需要：旧版本把 `~/.codex` 放在 rootfs 里，升级会残留「A different runtime is installed」，
     * 而现在用户数据已经在 rootfs 之外，重置只需要清引擎，重装即可，历史一条都不会丢。
     */
    fun reset(done: (Boolean) -> Unit) {
        if (!operation.compareAndSet(false, true)) { done(false); return }
        worker.execute {
            var ok = false
            try {
                require(process?.isAlive != true) { "Stop Codex before resetting the runtime" }
                phase = "resetting"; error = null; publish()
                // 先确认用户数据在 rootfs 外面，确认不了就不删（宁可不重置，也不能丢历史）。
                migratePersistentData()
                require(guestHome.isDirectory) { "Refusing to reset: the persistent Codex home is missing" }
                val staging = File(owner, "staging")
                if (staging.exists()) require(staging.deleteRecursively()) { "Could not clear staging" }
                if (root.exists()) require(root.deleteRecursively()) { "Could not remove the old runtime" }
                if (marker.exists()) require(marker.delete()) { "Could not remove the runtime marker" }
                baseUrl = null; token = null
                phase = "notInstalled"; ok = true
                log("Codex runtime reset; ${guestHome.path} and ${guestWorkspace.path} were kept")
            } catch (cause: Throwable) { fail(cause) }
            finally { operation.set(false); publish(); main.post { done(ok) } }
        }
    }

    fun stop(done: () -> Unit) {
        worker.execute {
            requestedStop = true
            val running = process
            if (running != null) {
                phase = "stopping"; publish()
                // Termux PRoot ignores SIGTERM; SIGQUIT with --kill-on-exit
                // reaps its own tracees, without killing unrelated app processes.
                val owned = ownedProcesses()
                val proots = owned.filter { it.proot }
                proots.forEach { signalOwned(it, OsConstants.SIGQUIT) }
                if (proots.isEmpty()) running.destroy()
                if (!running.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) {
                    owned.asReversed().forEach { signalOwned(it, OsConstants.SIGKILL) }
                    running.destroyForcibly()
                }
                ownedProcesses().asReversed().forEach { signalOwned(it, OsConstants.SIGKILL) }
                process = null
            }
            baseUrl = null; token = null; aliveProbeAt = 0
            phase = if (marker.isFile) "installed" else "notInstalled"
            publish(); main.post(done)
        }
    }
    companion object {
        @Volatile private var instance: CodexRuntime? = null
        fun get(context: Context): CodexRuntime = instance ?: synchronized(this) {
            instance ?: CodexRuntime(context.applicationContext).also { instance = it }
        }
    }
}

internal object CodexPersistentData {
    fun migrate(root: File, home: File, workspace: File) {
        val pairs = listOf(File(root, "root/.codex") to home, File(root, "root/workspace") to workspace)
        for ((legacy, persistent) in pairs) {
            if (persistent.exists()) continue
            if (legacy.isDirectory) {
                if (!legacy.renameTo(persistent)) {
                    throw IllegalStateException("Could not preserve existing Codex data at ${legacy.path}; runtime was not started")
                }
            } else if (!persistent.mkdirs() && !persistent.isDirectory) {
                throw IllegalStateException("Could not create persistent Codex data directory ${persistent.path}")
            }
        }
    }
}
