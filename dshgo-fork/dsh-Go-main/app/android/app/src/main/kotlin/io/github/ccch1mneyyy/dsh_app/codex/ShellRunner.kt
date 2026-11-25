package io.github.ccch1mneyyy.dsh_app.codex

import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** One command only: arguments are never passed through a shell except the fixed, quoted su -c path. */
internal object ShellCommandPolicy {
    const val MAX_COMMAND_BYTES = 4_000
    const val MAX_ARGUMENTS = 80
    const val MAX_TIMEOUT_MS = 110_000L
    const val MIN_TIMEOUT_MS = 100L
    const val DEFAULT_TIMEOUT_MS = 20_000L
    const val MAX_STREAM_BYTES = 32 * 1024 // 64 KiB combined stdout + stderr.

    private val commandFamilies = setOf("pm", "am", "input", "settings", "getprop", "dumpsys", "cmd")
    private val safeToken = Regex("[A-Za-z0-9_./:@,+%=-]+")

    fun parse(command: String): List<String> {
        if (command.isBlank()) throw invalidArgs("command must be one nonempty command")
        if (command.toByteArray(Charsets.UTF_8).size > MAX_COMMAND_BYTES) {
            throw invalidArgs("command must be at most $MAX_COMMAND_BYTES UTF-8 bytes")
        }
        if (command.any { it.isWhitespace() && it !in listOf(' ', '\t') } ||
            command.any { it in "|;&><`$()\\\\\"'" }) {
            throw invalidArgs("shell operators, quoting, substitutions and control characters are not allowed; pass one command without a shell pipeline")
        }
        val argv = command.trim().split(Regex("[ \\t]+")).filter(String::isNotEmpty)
        if (argv.size > MAX_ARGUMENTS) throw invalidArgs("command may contain at most $MAX_ARGUMENTS arguments")
        if (argv.firstOrNull() !in commandFamilies) {
            throw invalidArgs("allowed command families: pm, am, input, settings, getprop, dumpsys, cmd")
        }
        val bad = argv.firstOrNull { !safeToken.matches(it) }
        if (bad != null) throw invalidArgs("unsupported character in argument ${bad.take(40)}")
        return argv
    }

    fun timeout(value: Long): Long {
        if (value !in MIN_TIMEOUT_MS..MAX_TIMEOUT_MS) {
            throw invalidArgs("timeoutMs must be between $MIN_TIMEOUT_MS and $MAX_TIMEOUT_MS")
        }
        return value
    }

    /** su accepts one command string; quote every parsed token even though the policy is restrictive. */
    fun suCommand(argv: List<String>): String = argv.joinToString(" ") { "'${it.replace("'", "'\\''")}'" }

    fun isRootIdentity(exitCode: Int?, stdout: String): Boolean =
        exitCode == 0 && Regex("(?:^|\\s)uid=0(?:\\(|\\s|$)").containsMatchIn(stdout)

    private fun invalidArgs(message: String) = DeviceError("args/invalid", message, 400)
}

internal data class ShellExecution(
    val exitCode: Int?,
    val stdout: String,
    val stderr: String,
    val timedOut: Boolean = false,
    val truncated: Boolean = false,
    val cancelled: Boolean = false,
    val backend: String? = null,
) {
    fun asMap(): Map<String, Any?> = linkedMapOf(
        "exitCode" to exitCode,
        "stdout" to stdout,
        "stderr" to stderr,
        "timedOut" to timedOut,
        "truncated" to truncated,
        "cancelled" to cancelled,
        "backend" to backend,
    )
}

internal fun interface ShellProcessStarter {
    fun start(argv: List<String>): Process
}

internal class ShellCancellation {
    private val cancelledFlag = AtomicBoolean(false)
    private val process = AtomicReference<Process?>(null)
    val cancelled: Boolean get() = cancelledFlag.get()

    fun cancel() {
        cancelledFlag.set(true)
        runCatching { process.get()?.destroyForcibly() }
    }

    internal fun attach(value: Process) {
        process.set(value)
        if (cancelled) runCatching { value.destroyForcibly() }
    }

    internal fun detach(value: Process) {
        process.compareAndSet(value, null)
    }
}

/** Direct argv execution; both pipes are drained concurrently and capped independently. */
internal class ShellCommandExecutor(
    private val starter: ShellProcessStarter = ShellProcessStarter { argv ->
        ProcessBuilder(argv).apply {
            // Keep Shizuku's BOOTCLASSPATH/CLASSPATH intact: pm/am/cmd are Java
            // entry points, while getprop is native. Only normalize the basics.
            environment()["PATH"] = "/system/bin:/system/xbin:/vendor/bin"
            environment()["HOME"] = "/data/local/tmp"
            environment()["TMPDIR"] = "/data/local/tmp"
            environment()["LANG"] = "C.UTF-8"
        }.start()
    },
) {
    fun execute(
        argv: List<String>,
        timeoutMs: Long,
        cancellation: ShellCancellation? = null,
        onStarted: (Process) -> Unit = {},
    ): ShellExecution {
        val timeout = ShellCommandPolicy.timeout(timeoutMs)
        val process = starter.start(argv)
        Log.d("CodexShell", "process started family=${argv.firstOrNull()}")
        cancellation?.attach(process)
        onStarted(process)
        val stdout = BoundedCapture(ShellCommandPolicy.MAX_STREAM_BYTES)
        val stderr = BoundedCapture(ShellCommandPolicy.MAX_STREAM_BYTES)
        val outThread = pump(process.inputStream, stdout, "codex-shell-stdout")
        val errThread = pump(process.errorStream, stderr, "codex-shell-stderr")
        var timedOut = false
        var finished = false
        try {
            finished = process.waitFor(timeout, TimeUnit.MILLISECONDS)
            Log.d("CodexShell", "wait finished=$finished")
            timedOut = !finished
            if (!finished || cancellation?.cancelled == true) {
                runCatching { process.destroy() }
                if (!runCatching { process.waitFor(200, TimeUnit.MILLISECONDS) }.getOrDefault(false)) {
                    runCatching { process.destroyForcibly() }
                    runCatching { process.waitFor(500, TimeUnit.MILLISECONDS) }
                }
            }
        } catch (interrupted: InterruptedException) {
            cancellation?.cancel()
            runCatching { process.destroyForcibly() }
            Thread.currentThread().interrupt()
            timedOut = true
        } finally {
            if (!finished || cancellation?.cancelled == true) {
                runCatching { process.inputStream.close() }
                runCatching { process.errorStream.close() }
            }
            outThread.join(700)
            errThread.join(700)
            Log.d("CodexShell", "output pumps joined")
            cancellation?.detach(process)
        }
        val cancelled = cancellation?.cancelled == true
        return ShellExecution(
            exitCode = if (finished && !cancelled) runCatching { process.exitValue() }.getOrNull() else null,
            stdout = stdout.text(),
            stderr = stderr.text(),
            timedOut = timedOut,
            truncated = stdout.truncated || stderr.truncated,
            cancelled = cancelled,
        )
    }

    private fun pump(input: InputStream, capture: BoundedCapture, name: String): Thread =
        Thread({ runCatching { input.use(capture::readFrom) } }, name).apply {
            isDaemon = true
            start()
        }
}

internal class BoundedCapture(private val limit: Int) {
    private val bytes = ByteArrayOutputStream(limit)
    @Volatile var truncated: Boolean = false
        private set

    fun readFrom(input: InputStream) {
        val chunk = ByteArray(8 * 1024)
        while (true) {
            val count = input.read(chunk)
            if (count < 0) return
            synchronized(bytes) {
                val remaining = limit - bytes.size()
                if (remaining > 0) bytes.write(chunk, 0, minOf(remaining, count))
                if (count > remaining) truncated = true
            }
        }
    }

    fun text(): String = synchronized(bytes) { String(bytes.toByteArray(), StandardCharsets.UTF_8) }
}

/** Background-only capability probes. A failed/hung su probe is never counted as root. */
internal object ShellCapabilityProbe {
    private val executor = Executors.newSingleThreadExecutor { task ->
        Thread(task, "codex-shell-probe").apply { isDaemon = true }
    }
    @Volatile private var root = false
    @Volatile private var shizuku = false
    @Volatile private var lastProbeAt = 0L
    @Volatile private var probing = false
    private val callbacks = mutableListOf<() -> Unit>()

    fun refresh(context: Context, force: Boolean = false, onComplete: (() -> Unit)? = null) {
        val now = System.currentTimeMillis()
        synchronized(this) {
            if (probing) {
                onComplete?.let(callbacks::add)
                return
            }
            if (!force && now - lastProbeAt < PROBE_INTERVAL_MS) {
                onComplete?.let { executor.execute(it) }
                return
            }
            probing = true
            lastProbeAt = now
            onComplete?.let(callbacks::add)
        }
        executor.execute {
            try {
                root = probeRoot()
                shizuku = CodexShellShizuku.isAuthorized()
            } finally {
                val done = synchronized(this) {
                    probing = false
                    callbacks.toList().also { callbacks.clear() }
                }
                done.forEach { runCatching(it) }
            }
        }
    }

    fun rootAvailable(context: Context): Boolean {
        refresh(context)
        return root
    }

    fun shizukuAvailable(context: Context): Boolean {
        refresh(context)
        return shizuku
    }

    fun rootAvailableNow(): Boolean {
        val available = probeRoot()
        root = available
        return available
    }

    fun shizukuAvailableNow(): Boolean {
        val available = CodexShellShizuku.isAuthorized()
        shizuku = available
        return available
    }

    private fun probeRoot(): Boolean = runCatching {
        val result = ShellCommandExecutor().execute(listOf("su", "-c", "id"), ROOT_PROBE_TIMEOUT_MS)
        ShellCommandPolicy.isRootIdentity(result.exitCode, result.stdout)
    }.getOrDefault(false)

    private const val ROOT_PROBE_TIMEOUT_MS = 2_500L
    private const val PROBE_INTERVAL_MS = 10_000L
}

/** Owns in-flight shell requests so closing the HTTP channel cancels every child process. */
internal object ShellRunner {
    private val active = ConcurrentHashMap.newKeySet<ShellCancellation>()

    fun refreshAvailability(context: Context, force: Boolean = false) = ShellCapabilityProbe.refresh(context, force)

    fun rootAvailable(context: Context): Boolean = ShellCapabilityProbe.rootAvailable(context)

    fun shizukuAvailable(context: Context): Boolean = ShellCapabilityProbe.shizukuAvailable(context)

    fun execute(
        context: Context,
        command: String,
        timeoutMs: Long,
        tier: String,
        channelOpen: () -> Boolean,
    ): ShellExecution {
        val argv = ShellCommandPolicy.parse(command)
        val timeout = ShellCommandPolicy.timeout(timeoutMs)
        if (!channelOpen()) throw channelClosed()

        val backend = when {
            tier == DeviceTier.ROOT && ShellCapabilityProbe.rootAvailableNow() -> "root"
            tier == DeviceTier.ROOT && ShellCapabilityProbe.shizukuAvailableNow() -> "shizuku"
            tier == DeviceTier.DEBUGGER && ShellCapabilityProbe.shizukuAvailableNow() -> "shizuku"
            else -> null
        } ?: throw shizukuUnavailable(
            "Shell needs root or an installed, running and authorized Shizuku service. Start or authorize Shizuku, or enable root access in your root manager, then retry.",
        )
        if (!channelOpen()) throw channelClosed()

        val cancellation = ShellCancellation()
        active.add(cancellation)
        try {
            val result = when (backend) {
                "root" -> ShellCommandExecutor().execute(
                    listOf("su", "-c", ShellCommandPolicy.suCommand(argv)), timeout, cancellation,
                )
                else -> CodexShellShizuku.execute(context.applicationContext, argv, timeout, cancellation)
            }.copy(backend = backend)
            if (cancellation.cancelled || !channelOpen()) throw channelClosed()
            return result
        } finally {
            active.remove(cancellation)
        }
    }

    fun cancelActive() {
        active.forEach(ShellCancellation::cancel)
        CodexShellShizuku.cancelActive()
    }

    private fun channelClosed() = DeviceError(
        "device/unavailable",
        "The device channel was closed while the shell request was running; the command was cancelled.",
        501,
    )
}

/** Shizuku status helpers kept separate so installed-only never becomes a granted tier. */
internal object CodexShellShizuku {
    private const val SHIZUKU_PACKAGE = "moe.shizuku.privileged.api"
    private const val PERMISSION_REQUEST_CODE = 4811

    fun installed(context: Context): Boolean = runCatching {
        context.packageManager.getPackageInfo(SHIZUKU_PACKAGE, 0)
        true
    }.getOrDefault(false)

    fun isAuthorized(): Boolean = runCatching {
        rikka.shizuku.Shizuku.pingBinder() &&
            rikka.shizuku.Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED
    }.getOrDefault(false)

    fun requestPermission(): Boolean = runCatching {
        if (!rikka.shizuku.Shizuku.pingBinder()) return false
        if (isAuthorized()) return true
        rikka.shizuku.Shizuku.requestPermission(PERMISSION_REQUEST_CODE)
        true
    }.getOrDefault(false)

    fun execute(
        context: Context,
        argv: List<String>,
        timeoutMs: Long,
        cancellation: ShellCancellation,
    ): ShellExecution = CodexShellShizukuBinding.execute(context, argv, timeoutMs, cancellation)

    fun cancelActive() = CodexShellShizukuBinding.cancelActive()
}

/** Binds only after actual Shizuku authorization; the bounded wait is always on an HTTP worker. */
private object CodexShellShizukuBinding {
    private val guard = Any()
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    @Volatile private var activeBinder: android.os.IBinder? = null
    @Volatile private var activeBinding: Pair<rikka.shizuku.Shizuku.UserServiceArgs, android.content.ServiceConnection>? = null

    fun execute(
        context: Context,
        argv: List<String>,
        timeoutMs: Long,
        cancellation: ShellCancellation,
    ): ShellExecution = synchronized(guard) {
        if (android.os.Looper.myLooper() == main.looper) {
            throw shizukuUnavailable("Shizuku shell binding must run off the UI thread; retry from the device tool.")
        }
        if (cancellation.cancelled) throw shizukuUnavailable("The device channel was closed before Shizuku execution started.")
        val args = rikka.shizuku.Shizuku.UserServiceArgs(
            android.content.ComponentName(context, CodexShellShizukuService::class.java),
        ).tag("codex.codex-shell").processNameSuffix("codex_shell")
            .version(context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode.toInt())
            .daemon(false)
        val binderRef = AtomicReference<android.os.IBinder?>(null)
        val latch = CountDownLatch(1)
        val connection = object : android.content.ServiceConnection {
            override fun onServiceConnected(name: android.content.ComponentName?, binder: android.os.IBinder?) {
                binderRef.set(binder)
                latch.countDown()
            }
            override fun onServiceDisconnected(name: android.content.ComponentName?) {
                activeBinder = null
                latch.countDown()
            }
        }
        if (!main.post {
                if (!cancellation.cancelled && CodexShellShizuku.isAuthorized()) {
                    runCatching { rikka.shizuku.Shizuku.bindUserService(args, connection) }
                        .onFailure { latch.countDown() }
                } else latch.countDown()
            }) {
            throw shizukuUnavailable("Cannot dispatch Shizuku binding on the main thread.")
        }
        try {
            if (!latch.await(SERVICE_BIND_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                throw shizukuUnavailable("Shizuku did not connect within ${SERVICE_BIND_TIMEOUT_MS} ms; start it and retry.")
            }
            if (cancellation.cancelled) throw shizukuUnavailable("The device channel was closed before Shizuku execution started.")
            val binder = binderRef.get()?.takeIf { it.isBinderAlive }
                ?: throw shizukuUnavailable("Shizuku is unavailable or not authorized. Start and authorize it, then retry.")
            activeBinder = binder
            activeBinding = args to connection
            val result = transact(binder, argv, timeoutMs)
            Log.d("CodexShell", "binder transaction returned")
            if (cancellation.cancelled) throw shizukuUnavailable("The device channel was closed while the Shizuku command was running.")
            result
        } finally {
            if (activeBinder === binderRef.get()) activeBinder = null
            if (activeBinding?.second === connection) activeBinding = null
            main.post { runCatching { rikka.shizuku.Shizuku.unbindUserService(args, connection, true) } }
        }
    }

    fun cancelActive() {
        val binder = activeBinder ?: return
        runCatching {
            val data = android.os.Parcel.obtain()
            try {
                data.writeInterfaceToken(CodexShellShizukuService.DESCRIPTOR)
                binder.transact(CodexShellShizukuService.TRANSACTION_CANCEL, data, null, android.os.IBinder.FLAG_ONEWAY)
            } finally { data.recycle() }
        }
    }

    private fun transact(binder: android.os.IBinder, argv: List<String>, timeoutMs: Long): ShellExecution {
        val data = android.os.Parcel.obtain()
        val reply = android.os.Parcel.obtain()
        try {
            data.writeInterfaceToken(CodexShellShizukuService.DESCRIPTOR)
            val request = android.os.Bundle().apply {
                putString("command", argv.joinToString(" "))
                putLong("timeoutMs", timeoutMs)
            }
            data.writeBundle(request)
            if (!binder.transact(CodexShellShizukuService.TRANSACTION_EXECUTE, data, reply, 0)) {
                throw shizukuUnavailable("The Shizuku shell service rejected the request.")
            }
            reply.readException()
            val result = reply.readBundle(CodexShellShizukuService::class.java.classLoader)
                ?: throw shizukuUnavailable("Shizuku returned an empty shell result.")
            if (!result.getBoolean("ok", false)) {
                throw shizukuUnavailable(result.getString("message") ?: "Shizuku shell execution failed.")
            }
            return ShellExecution(
                exitCode = if (result.containsKey("exitCode")) result.getInt("exitCode") else null,
                stdout = result.getString("stdout").orEmpty(),
                stderr = result.getString("stderr").orEmpty(),
                timedOut = result.getBoolean("timedOut"),
                truncated = result.getBoolean("truncated"),
            )
        } finally {
            data.recycle()
            reply.recycle()
        }
    }

    private const val SERVICE_BIND_TIMEOUT_MS = 5_000L
}
