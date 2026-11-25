package io.github.ccch1mneyyy.dsh_app.codex

import android.content.Context
import android.os.Binder
import android.os.Bundle
import android.os.IBinder
import android.os.Parcel
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

/** Shizuku instantiates this UserService Binder directly; it is not an Android Service. */
class CodexShellShizukuService(context: Context) : Binder() {
    private val allowedCallerUid = context.applicationInfo.uid
    private val busy = AtomicBoolean(false)
    private val cancelled = AtomicBoolean(false)
    private val process = AtomicReference<Process?>(null)

    override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean = when (code) {
        TRANSACTION_EXECUTE -> {
            data.enforceInterface(DESCRIPTOR)
            enforceCaller()
            val request = data.readBundle(javaClass.classLoader) ?: Bundle()
            val response = execute(request)
            reply?.writeNoException()
            reply?.writeBundle(response)
            true
        }
        TRANSACTION_CANCEL -> {
            data.enforceInterface(DESCRIPTOR)
            enforceCaller()
            cancelled.set(true)
            runCatching { process.get()?.destroyForcibly() }
            true
        }
        else -> super.onTransact(code, data, reply, flags)
    }

    private fun enforceCaller() {
        val caller = Binder.getCallingUid()
        if (caller != allowedCallerUid) throw SecurityException("device/permission-denied")
    }

    private fun execute(request: Bundle): Bundle {
        if (!busy.compareAndSet(false, true)) return failure("A Shizuku shell command is already running.")
        cancelled.set(false)
        return try {
            val command = request.getString("command").orEmpty()
            val argv = ShellCommandPolicy.parse(command)
            val timeoutMs = ShellCommandPolicy.timeout(request.getLong("timeoutMs", -1))
            val result = ShellCommandExecutor().execute(argv, timeoutMs, onStarted = { child ->
                process.set(child)
                if (cancelled.get()) runCatching { child.destroyForcibly() }
            })
            Bundle().apply {
                putBoolean("ok", true)
                if (result.exitCode != null) putInt("exitCode", result.exitCode)
                putString("stdout", result.stdout)
                putString("stderr", result.stderr)
                putBoolean("timedOut", result.timedOut)
                putBoolean("truncated", result.truncated)
                putBoolean("cancelled", cancelled.get())
            }
        } catch (error: Exception) {
            failure(error.message ?: "Shizuku shell execution failed.")
        } finally {
            process.set(null)
            busy.set(false)
        }
    }

    private fun failure(message: String) = Bundle().apply {
        putBoolean("ok", false)
        putString("message", message)
    }

    companion object {
        const val DESCRIPTOR = "io.github.ccch1mneyyy.dsh_app.codex.ICodexShell"
        const val TRANSACTION_EXECUTE = IBinder.FIRST_CALL_TRANSACTION
        const val TRANSACTION_CANCEL = IBinder.FIRST_CALL_TRANSACTION + 1
    }
}
