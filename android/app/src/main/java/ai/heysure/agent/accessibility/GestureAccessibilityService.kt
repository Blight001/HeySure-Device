package ai.heysure.agent.accessibility

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Bundle
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/**
 * The only way (without root) to inject taps/swipes system-wide. Exposes a
 * static handle so the tool layer can reach the live service instance. The user
 * must enable it once under Settings > Accessibility.
 */
class GestureAccessibilityService : AccessibilityService() {
    private val effectOverlay by lazy { GestureEffectOverlay(this) }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        effectOverlay.detach()
        instance = null
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        effectOverlay.detach()
        if (instance === this) instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) { /* no-op: we only inject */ }
    override fun onInterrupt() { /* no-op */ }

    /**
     * Dispatch a single-stroke gesture from a Path; resumes with success.
     * Bounded by a timeout (gesture duration + buffer): if the platform never
     * fires the result callback, the task fails fast instead of hanging forever.
     */
    suspend fun dispatch(path: Path, startMs: Long, durationMs: Long): Boolean {
        val safeDuration = durationMs.coerceAtLeast(1)
        return withTimeoutOrNull(safeDuration + GESTURE_TIMEOUT_BUFFER_MS) {
            suspendCancellableCoroutine { cont ->
                val stroke = GestureDescription.StrokeDescription(path, startMs, safeDuration)
                val gesture = GestureDescription.Builder().addStroke(stroke).build()
                val ok = dispatchGesture(gesture, object : GestureResultCallback() {
                    override fun onCompleted(d: GestureDescription?) { if (cont.isActive) cont.resume(true) }
                    override fun onCancelled(d: GestureDescription?) { if (cont.isActive) cont.resume(false) }
                }, null)
                if (!ok && cont.isActive) cont.resume(false)
            }
        } ?: false
    }

    fun showTapEffect(x: Float, y: Float) {
        effectOverlay.showTap(x, y)
    }

    fun showDragEffect(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long) {
        effectOverlay.showDrag(x1, y1, x2, y2, durationMs)
    }

    fun showHomeEffect() {
        effectOverlay.showHome()
    }

    /** Type into the currently focused editable node (best-effort). */
    fun typeIntoFocused(text: String): Boolean {
        val node: AccessibilityNodeInfo =
            findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    companion object {
        private const val GESTURE_TIMEOUT_BUFFER_MS = 8_000L

        @Volatile
        var instance: GestureAccessibilityService? = null
            private set

        fun require(): GestureAccessibilityService =
            instance ?: throw IllegalStateException(
                "无障碍服务未开启：请在 系统设置 > 无障碍 中启用 HeySure 安卓端",
            )
    }
}
