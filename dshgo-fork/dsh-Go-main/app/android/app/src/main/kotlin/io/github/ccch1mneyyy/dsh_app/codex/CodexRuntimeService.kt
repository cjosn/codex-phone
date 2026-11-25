package io.github.ccch1mneyyy.dsh_app.codex

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import io.github.ccch1mneyyy.dsh_app.MainActivity

/** Foreground execution and bounded wake lock, reused Android building blocks. */
class CodexRuntimeService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Codex runtime", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, CodexRuntimeService::class.java).setAction("stop"), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        startForeground(7031, Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Codex Go")
            .setContentText("Codex app-server · 本机运行")
            .setContentIntent(open).setOngoing(true)
            .addAction(Notification.Action.Builder(null, "停止", stop).build()).build())
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:codex-runtime").apply {
                setReferenceCounted(false)
                acquire(6 * 60 * 60 * 1000L)
            }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val runtime = CodexRuntime.get(applicationContext)
        when (intent?.action) {
            "install" -> runtime.install { stopSelf(startId) }
            "reset" -> runtime.reset { stopSelf(startId) }
            "stop" -> runtime.stop { stopSelf(startId) }
            "start" -> runtime.start { stopSelf(startId) }
            else -> stopSelf()
        }
        // User starts it explicitly. Reopening reconnects to persisted Codex threads.
        return START_NOT_STICKY
    }
    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null
    companion object { private const val CHANNEL = "codex-runtime" }
}
