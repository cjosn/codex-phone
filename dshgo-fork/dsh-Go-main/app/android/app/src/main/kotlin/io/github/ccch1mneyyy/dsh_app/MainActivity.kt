package io.github.ccch1mneyyy.dsh_app

import android.content.Context
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.FlutterEngineCache
import io.flutter.embedding.engine.dart.DartExecutor
import io.github.ccch1mneyyy.dsh_app.codex.CodexAttachmentsPlugin
import io.github.ccch1mneyyy.dsh_app.codex.CodexDevicePlugin
import io.github.ccch1mneyyy.dsh_app.codex.CodexRuntimePlugin

/** Independent Codex app. Only the reusable Flutter/Android runtime is mounted. */
class MainActivity : FlutterActivity() {
    override fun provideFlutterEngine(context: Context): FlutterEngine {
        val cache = FlutterEngineCache.getInstance()
        cache.get(ENGINE_ID)?.let { return it }
        return FlutterEngine(applicationContext).also { engine ->
            engine.plugins.add(CodexRuntimePlugin())
            engine.plugins.add(CodexDevicePlugin())
            engine.plugins.add(CodexAttachmentsPlugin())
            engine.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint.createDefault())
            cache.put(ENGINE_ID, engine)
        }
    }
    override fun shouldDestroyEngineWithHost(): Boolean = false
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
            window.isStatusBarContrastEnforced = false
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) window.setDecorFitsSystemWindows(false)
    }
    override fun popSystemNavigator(): Boolean = moveTaskToBack(true)
    companion object { private const val ENGINE_ID = "codex-pocket" }
}
