package io.github.ccch1mneyyy.dsh_app.codex

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Phase B 的无障碍通道：读屏 / 点击 / 滑动 / 输入 / 全局按键 / 截图。
 *
 * 只由 [DeviceApiServer] 在后台线程调用；没有连接时 [connected] 返回 null，
 * 上层据此回 `device/permission-denied`，绝不假装成功。
 */
class CodexAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() {
        instance = this
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit

    override fun onInterrupt() = Unit

    override fun onDestroy() {
        if (instance === this) instance = null
        super.onDestroy()
    }

    /** 读屏：宽搜一遍节点树，输出契约 §2 `/ui/dump` 的 `nodes` 结构。 */
    fun dump(includeInvisible: Boolean, maxNodes: Int): JSONObject {
        val root = rootInActiveWindow
            ?: throw permissionDenied("No active window to read. Unlock the phone and keep the target screen in front")
        val cap = maxNodes.coerceIn(1, MAX_NODES)
        val nodes = JSONArray()
        var truncated = false
        val queue = ArrayDeque<Pair<AccessibilityNodeInfo, Int>>()
        queue.addLast(root to 0)
        while (queue.isNotEmpty()) {
            val (node, depth) = queue.removeFirst()
            if (nodes.length() >= cap) {
                truncated = true
                break
            }
            if (includeInvisible || node.isVisibleToUser) {
                val bounds = Rect()
                node.getBoundsInScreen(bounds)
                val box = JSONArray()
                box.put(bounds.left)
                box.put(bounds.top)
                box.put(bounds.right)
                box.put(bounds.bottom)
                nodes.put(
                    JSONObject().apply {
                        put("index", nodes.length())
                        put("className", node.className?.toString() ?: JSONObject.NULL)
                        // Flutter / Compose 的文案放在 contentDescription 里，text 是空的；
                        // 这里把 label 统一成「text 优先、否则 desc」，模型只读一个字段就能判断。
                        put("text", node.text?.toString() ?: node.contentDescription?.toString() ?: JSONObject.NULL)
                        put("desc", node.contentDescription?.toString() ?: JSONObject.NULL)
                        put("resourceId", node.viewIdResourceName ?: JSONObject.NULL)
                        put("bounds", box)
                        put("clickable", node.isClickable)
                        put("enabled", node.isEnabled)
                        put("focused", node.isFocused)
                        // 密码框标记：格式化层据此只显示「密码框」，绝不把内容念给模型。
                        put("password", node.isPassword)
                        put("depth", depth)
                    },
                )
            }
            for (index in 0 until node.childCount) {
                node.getChild(index)?.let { queue.addLast(it to depth + 1) }
            }
        }
        val metrics = resources.displayMetrics
        val screens = JSONArray().put(
            JSONObject().put("width", metrics.widthPixels).put("height", metrics.heightPixels),
        )
        return JSONObject().put("nodes", nodes).put("screens", screens).put("truncated", truncated)
    }

    /** 坐标点击。手势被系统拒绝时抛错，让调用方回 `device/timeout` 而不是 ok。 */
    fun tap(x: Int, y: Int) {
        val path = Path().apply {
            moveTo(x.toFloat(), y.toFloat())
            lineTo(x.toFloat(), y.toFloat())
        }
        if (!dispatch(path, TAP_DURATION_MS)) {
            throw DeviceError("device/timeout", "The system rejected the tap gesture; retry after the screen settles")
        }
    }

    /** 按文本点击：内部先读一遍树，再点最近的可点祖先。 */
    fun tapText(value: String): JSONObject {
        val node = findLabel(value)
            ?: throw invalidArgs("No node with text \"$value\" on screen; call /ui/dump first and use its text")
        val target = clickableAncestor(node)
            ?: throw DeviceError(
                "device/unsupported",
                "Found \"$value\" but it and its ancestors are not clickable; tap by coordinates from /ui/dump bounds",
            )
        val bounds = Rect()
        target.getBoundsInScreen(bounds)
        val x = bounds.centerX()
        val y = bounds.centerY()
        tap(x, y)
        return JSONObject().put("ok", true)
            .put("target", JSONObject().put("x", x).put("y", y).put("matchedText", value))
    }

    fun swipe(fromX: Int, fromY: Int, toX: Int, toY: Int, durationMs: Int) {
        val path = Path().apply {
            moveTo(fromX.toFloat(), fromY.toFloat())
            lineTo(toX.toFloat(), toY.toFloat())
        }
        if (!dispatch(path, durationMs.coerceIn(50, 5000).toLong())) {
            throw DeviceError("device/timeout", "The system rejected the swipe gesture; retry after the screen settles")
        }
    }

    /** 输入：优先 `ACTION_SET_TEXT`，不行落回复制 + `ACTION_PASTE`。 */
    fun typeText(text: String, submit: Boolean): JSONObject {
        val node = focusedEditable()
            ?: throw permissionDenied("No focused text field. Tap the input box first, then send the text again")
        var mode = "setText"
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        var written = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
        if (!written) {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("codex", text))
            written = node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
            mode = "paste"
        }
        if (!written) {
            throw DeviceError("device/unsupported", "This field rejected text input; tap the field and retry")
        }
        val submitted = submit && imeEnter(node)
        return JSONObject().put("ok", true).put("mode", mode).put("submitted", submitted)
    }

    /** 全局按键。enter / del 作用在当前焦点输入框上。 */
    fun key(name: String) {
        when (name.lowercase()) {
            "back" -> requireAction(performGlobalAction(GLOBAL_ACTION_BACK), "back")
            "home" -> requireAction(performGlobalAction(GLOBAL_ACTION_HOME), "home")
            "recents" -> requireAction(performGlobalAction(GLOBAL_ACTION_RECENTS), "recents")
            "enter" -> {
                val node = focusedEditable() ?: throw permissionDenied("No focused text field to submit")
                if (!imeEnter(node)) {
                    throw DeviceError("device/unsupported", "The focused field does not accept an IME enter action")
                }
            }
            "del" -> deleteLastCharacter()
            else -> throw invalidArgs("Unsupported key \"$name\"; use back, home, recents, enter or del")
        }
    }

    /**
     * 截图。API 30+ 走 `takeScreenshot`；FLAG_SECURE 页面拿不到内容，
     * 或者系统拒绝时一律 `device/screenshot-blocked`。
     */
    fun screenshot(maxWidth: Int): JSONObject {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            throw DeviceError("device/unsupported", "Screenshots need Android 11 (API 30) or newer")
        }
        val latch = CountDownLatch(1)
        val bitmap = arrayOfNulls<Bitmap>(1)
        val failure = arrayOfNulls<Int>(1)
        val executor = Executor { command -> MAIN.post(command) }
        takeScreenshot(Display.DEFAULT_DISPLAY, executor, object : TakeScreenshotCallback {
            override fun onSuccess(result: ScreenshotResult) {
                bitmap[0] = runCatching {
                    Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                        ?.copy(Bitmap.Config.ARGB_8888, false)
                }.getOrNull()
                result.hardwareBuffer.close()
                latch.countDown()
            }

            override fun onFailure(errorCode: Int) {
                failure[0] = errorCode
                latch.countDown()
            }
        })
        if (!latch.await(SCREENSHOT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
            throw DeviceError("device/timeout", "The screenshot did not come back in time; retry")
        }
        val source = bitmap[0]
            ?: throw DeviceError(
                "device/screenshot-blocked",
                "The system refused this screenshot (error ${failure[0]}); the screen may be protected with FLAG_SECURE",
            )
        val scaled = if (maxWidth > 0 && source.width > maxWidth) {
            val height = (source.height.toFloat() * maxWidth / source.width).toInt().coerceAtLeast(1)
            Bitmap.createScaledBitmap(source, maxWidth, height, true)
        } else {
            source
        }
        val output = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.PNG, 100, output)
        val bytes = output.toByteArray()
        return JSONObject()
            .put("png_base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            .put("width", scaled.width)
            .put("height", scaled.height)
            .put("bytes", bytes.size)
    }

    private fun deleteLastCharacter() {
        val node = focusedEditable() ?: throw permissionDenied("No focused text field to edit")
        val current = node.text?.toString().orEmpty()
        if (current.isEmpty()) return
        val trimmed = current.substring(0, current.offsetByCodePoints(current.length, -1))
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, trimmed)
        }
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            throw DeviceError("device/unsupported", "The focused field rejected text editing")
        }
    }

    private fun requireAction(performed: Boolean, action: String) {
        if (!performed) throw DeviceError("device/unsupported", "The system rejected the $action action")
    }

    private fun imeEnter(node: AccessibilityNodeInfo): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        // 本仓库编译用的 android.jar 里没有 AccessibilityNodeInfo.ACTION_IME_ENTER 这个 int 常量，
        // 但同一个动作在 AccessibilityAction 上存在：取它的 id，语义完全一致。
        return node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
    }

    private fun dispatch(path: Path, durationMs: Long): Boolean {
        val latch = CountDownLatch(1)
        val completed = AtomicBoolean(false)
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs.coerceAtLeast(1)))
            .build()
        val accepted = dispatchGesture(
            gesture,
            object : GestureResultCallback() {
                override fun onCompleted(description: GestureDescription?) {
                    completed.set(true)
                    latch.countDown()
                }

                override fun onCancelled(description: GestureDescription?) = latch.countDown()
            },
            MAIN,
        )
        if (!accepted) return false
        return latch.await(GESTURE_TIMEOUT_MS, TimeUnit.MILLISECONDS) && completed.get()
    }

    private fun findLabel(value: String): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: throw permissionDenied("No active window to read")
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.addLast(root)
        var partial: AccessibilityNodeInfo? = null
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            val label = node.text?.toString() ?: node.contentDescription?.toString()
            if (!label.isNullOrEmpty()) {
                if (label == value) return node
                if (partial == null && label.contains(value, ignoreCase = true)) partial = node
            }
            for (index in 0 until node.childCount) node.getChild(index)?.let { queue.addLast(it) }
        }
        return partial
    }

    private fun clickableAncestor(start: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var node: AccessibilityNodeInfo? = start
        var depth = 0
        while (node != null && depth < MAX_ANCESTOR_DEPTH) {
            if (node.isClickable && node.isEnabled) return node
            node = node.parent
            depth++
        }
        return null
    }

    private fun focusedEditable(): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: throw permissionDenied("No active window to edit")
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.addLast(root)
        while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            if (node.isFocused && (node.isEditable || node.className?.toString()?.contains("EditText") == true)) {
                return node
            }
            for (index in 0 until node.childCount) node.getChild(index)?.let { queue.addLast(it) }
        }
        return null
    }

    companion object {
        private const val MAX_NODES = 1500
        private const val MAX_ANCESTOR_DEPTH = 8
        private const val TAP_DURATION_MS = 40L
        private const val GESTURE_TIMEOUT_MS = 5_000L
        private const val SCREENSHOT_TIMEOUT_MS = 10_000L
        private val MAIN = Handler(Looper.getMainLooper())

        @Volatile
        private var instance: CodexAccessibilityService? = null

        /** 已连接的服务实例；没连上就是 null（工具据此回 permission-denied）。 */
        fun connected(): CodexAccessibilityService? = instance

        /** 系统设置里是否勾选了本 App 的无障碍服务（不看 instance，进程刚起来时也能判断）。 */
        fun isEnabled(context: Context): Boolean {
            val component = ComponentName(context, CodexAccessibilityService::class.java)
            val enabled = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
            )
            val listed = enabled?.split(':')?.any {
                it.equals(component.flattenToString(), ignoreCase = true) ||
                    it.equals(component.flattenToShortString(), ignoreCase = true)
            } == true
            return listed || instance != null
        }
    }
}
