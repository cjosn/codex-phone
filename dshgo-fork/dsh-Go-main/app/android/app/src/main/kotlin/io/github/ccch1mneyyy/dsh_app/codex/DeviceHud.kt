package io.github.ccch1mneyyy.dsh_app.codex

import android.content.Context
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 屏幕操作时的顶部悬浮提示：`Codex · 正在读取屏幕` / `Codex · 正在操作屏幕`。
 *
 * 为什么要有：设备通道一旦开启，模型能在用户不看屏幕的时候读屏、点击。用户需要**看得见**这件事
 * 正在发生，而不是只能在日志里事后发现。
 *
 * 状态约定（谁置位、谁清除）：
 * - 置位：[show] 由 `DeviceApiServer` 在每个 `/ui/...` 请求上调用；
 * - 清除：最后一次调用后 [HOLD_MS] 毫秒自动移除；进程结束自然消失；
 * - 清不掉会怎样：无悬浮窗权限时 [show] 直接返回（不崩、不排队），能力本身不受影响。
 *
 * 没有悬浮窗权限时不做任何事——权限在「手机能力」页让用户自己开，这里不弹系统框。
 */
object DeviceHud {
    private const val HOLD_MS = 1_600L
    private const val TAG_VIEW = "codex-device-hud"

    private val main = Handler(Looper.getMainLooper())
    private var view: View? = null
    private var hideTask: Runnable? = null

    fun show(context: Context, label: String) {
        val app = context.applicationContext
        if (!Settings.canDrawOverlays(app)) return
        main.post {
            val manager = app.getSystemService(Context.WINDOW_SERVICE) as? WindowManager ?: return@post
            val existing = view
            if (existing != null) {
                (existing.findViewWithTag<TextView>(TAG_VIEW))?.text = label
            } else {
                val created = build(app, label)
                val params = WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                        WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    android.graphics.PixelFormat.TRANSLUCENT,
                ).apply {
                    gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
                    y = 96
                }
                // 加不上（例如被系统拒绝）就当没这回事，不能影响读屏/点击本身。
                if (runCatching { manager.addView(created, params) }.isFailure) return@post
                view = created
            }
            scheduleHide()
        }
    }

    private fun scheduleHide() {
        hideTask?.let { main.removeCallbacks(it) }
        val task = Runnable { hide() }
        hideTask = task
        main.postDelayed(task, HOLD_MS)
    }

    private fun hide() {
        val current = view ?: return
        view = null
        hideTask = null
        runCatching {
            (current.context.getSystemService(Context.WINDOW_SERVICE) as? WindowManager)?.removeView(current)
        }
    }

    private fun build(context: Context, label: String): View {
        val pill = GradientDrawable().apply {
            cornerRadius = 999f
            setColor(Color.parseColor("#E61A1A18"))
            setStroke(1, Color.parseColor("#33FFFFFF"))
        }
        val dot = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.parseColor("#4ADE80"))
        }
        val dots = View(context).apply {
            layoutParams = LinearLayout.LayoutParams(dp(context, 6), dp(context, 6))
                .also { it.marginEnd = dp(context, 7) }
            background = dot
        }
        val labelView = TextView(context).apply {
            tag = TAG_VIEW
            this.text = label
            setTextColor(Color.WHITE)
            textSize = 12f
        }
        val brand = TextView(context).apply {
            this.text = "Codex"
            setTextColor(Color.parseColor("#F2F2ED"))
            textSize = 12f
            setPadding(0, 0, dp(context, 8), 0)
        }
        return LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = pill
            setPadding(dp(context, 12), dp(context, 7), dp(context, 14), dp(context, 7))
            addView(dots)
            addView(brand)
            addView(labelView)
        }
    }

    private fun dp(context: Context, value: Int): Int =
        (value * context.resources.displayMetrics.density).toInt()
}
