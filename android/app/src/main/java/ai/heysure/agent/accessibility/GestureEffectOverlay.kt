package ai.heysure.agent.accessibility

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.animation.LinearInterpolator
import kotlin.math.hypot
import kotlin.math.max

/**
 * Small non-interactive accessibility overlay used to make injected actions
 * visible to the person watching the device.
 */
class GestureEffectOverlay(private val context: Context) {
    private val main = Handler(Looper.getMainLooper())
    private val windowManager = context.getSystemService(WindowManager::class.java)
    private val view = EffectView(context)
    private var attached = false

    fun showTap(x: Float, y: Float) {
        main.post {
            ensureAttached()
            view.addTap(x, y)
        }
    }

    fun showDrag(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long) {
        main.post {
            ensureAttached()
            view.addDrag(x1, y1, x2, y2, durationMs)
        }
    }

    fun showHome() {
        main.post {
            ensureAttached()
            view.addHome()
        }
    }

    fun detach() {
        main.post {
            if (!attached) return@post
            runCatching { windowManager.removeView(view) }
            attached = false
        }
    }

    private fun ensureAttached() {
        if (attached) return
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            android.graphics.PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            title = "HeySure gesture effects"
            // Let the window extend into the status-bar / display-cutout band so it
            // can physically cover y=0. Even when the system still shrinks it, the
            // draw-time getLocationOnScreen() correction below keeps effects aligned.
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            }
        }
        attached = runCatching { windowManager.addView(view, params) }.isSuccess
    }

    private class EffectView(context: Context) : View(context) {
        private val effects = mutableListOf<Effect>()
        // Reused buffer for this view's real top-left position on the physical
        // screen. Gesture coordinates are physical-screen pixels (origin at the
        // true top of the display), but the window may be inset below the status
        // bar / cutout — so we subtract this offset before drawing.
        private val screenLoc = IntArray(2)
        private val accent = Color.rgb(99, 102, 241)
        private val cyan = Color.rgb(56, 189, 248)
        private val green = Color.rgb(34, 197, 94)

        private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.FILL
        }
        private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textAlign = Paint.Align.CENTER
            textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 32f, resources.displayMetrics)
            isFakeBoldText = true
        }

        init {
            importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
            setWillNotDraw(false)
        }

        fun addTap(x: Float, y: Float) {
            val effect = Effect.Tap(x, y)
            effects.add(effect)
            ValueAnimator.ofFloat(0f, 1f).apply {
                duration = 520L
                interpolator = DecelerateInterpolator()
                addUpdateListener {
                    effect.progress = it.animatedValue as Float
                    invalidate()
                    if (effect.progress >= 1f) effects.remove(effect)
                }
                start()
            }
        }

        fun addDrag(x1: Float, y1: Float, x2: Float, y2: Float, durationMs: Long) {
            val effect = Effect.Drag(x1, y1, x2, y2)
            effects.add(effect)
            ValueAnimator.ofFloat(0f, 1f).apply {
                duration = max(durationMs + 220L, 580L)
                interpolator = LinearInterpolator()
                addUpdateListener {
                    effect.progress = it.animatedValue as Float
                    invalidate()
                    if (effect.progress >= 1f) effects.remove(effect)
                }
                start()
            }
        }

        fun addHome() {
            val effect = Effect.Home()
            effects.add(effect)
            ValueAnimator.ofFloat(0f, 1f).apply {
                duration = 720L
                interpolator = DecelerateInterpolator()
                addUpdateListener {
                    effect.progress = it.animatedValue as Float
                    invalidate()
                    if (effect.progress >= 1f) effects.remove(effect)
                }
                start()
            }
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            // Map physical-screen coordinates → this view's local space. If the
            // window was inset (status bar / cutout), screenLoc[1] > 0 and this
            // shift pulls the effect back up onto the real touch point instead of
            // letting it drift downward.
            getLocationOnScreen(screenLoc)
            val offsetX = screenLoc[0].toFloat()
            val offsetY = screenLoc[1].toFloat()
            effects.toList().forEach { effect ->
                when (effect) {
                    is Effect.Tap -> {
                        canvas.save()
                        canvas.translate(-offsetX, -offsetY)
                        drawTap(canvas, effect)
                        canvas.restore()
                    }
                    is Effect.Drag -> {
                        canvas.save()
                        canvas.translate(-offsetX, -offsetY)
                        drawDrag(canvas, effect)
                        canvas.restore()
                    }
                    // Home is anchored to the view's own bounds (bottom panel +
                    // centered icon), so it stays in local space — no shift.
                    is Effect.Home -> drawHome(canvas, effect)
                }
            }
        }

        private fun drawTap(canvas: Canvas, effect: Effect.Tap) {
            val p = effect.progress
            val alpha = ((1f - p) * 210).toInt().coerceIn(0, 255)
            fillPaint.color = withAlpha(accent, (alpha * 0.18f).toInt())
            canvas.drawCircle(effect.x, effect.y, lerp(18f, 88f, p), fillPaint)

            strokePaint.color = withAlpha(accent, alpha)
            strokePaint.strokeWidth = lerp(7f, 2f, p)
            canvas.drawCircle(effect.x, effect.y, lerp(10f, 54f, p), strokePaint)

            fillPaint.color = withAlpha(Color.WHITE, ((1f - p) * 235).toInt())
            canvas.drawCircle(effect.x, effect.y, lerp(7f, 3f, p), fillPaint)
        }

        private fun drawDrag(canvas: Canvas, effect: Effect.Drag) {
            val p = effect.progress
            val headX = lerp(effect.x1, effect.x2, p.coerceIn(0f, 0.88f) / 0.88f)
            val headY = lerp(effect.y1, effect.y2, p.coerceIn(0f, 0.88f) / 0.88f)
            val fade = if (p < 0.78f) 1f else (1f - ((p - 0.78f) / 0.22f)).coerceIn(0f, 1f)
            val distance = hypot((effect.x2 - effect.x1).toDouble(), (effect.y2 - effect.y1).toDouble()).toFloat()

            strokePaint.color = withAlpha(cyan, (190 * fade).toInt())
            strokePaint.strokeWidth = 10f
            canvas.drawLine(effect.x1, effect.y1, headX, headY, strokePaint)

            strokePaint.color = withAlpha(Color.WHITE, (220 * fade).toInt())
            strokePaint.strokeWidth = 3f
            canvas.drawLine(effect.x1, effect.y1, headX, headY, strokePaint)

            fillPaint.color = withAlpha(cyan, (50 * fade).toInt())
            canvas.drawCircle(headX, headY, 38f + distance.coerceAtMost(400f) * 0.02f, fillPaint)
            fillPaint.color = withAlpha(Color.WHITE, (235 * fade).toInt())
            canvas.drawCircle(headX, headY, 11f, fillPaint)

            strokePaint.color = withAlpha(cyan, (160 * fade).toInt())
            strokePaint.strokeWidth = 5f
            canvas.drawCircle(effect.x1, effect.y1, 18f, strokePaint)
            canvas.drawCircle(effect.x2, effect.y2, 18f, strokePaint)
        }

        private fun drawHome(canvas: Canvas, effect: Effect.Home) {
            val p = effect.progress
            val fadeIn = (p / 0.18f).coerceIn(0f, 1f)
            val fadeOut = if (p < 0.72f) 1f else (1f - ((p - 0.72f) / 0.28f)).coerceIn(0f, 1f)
            val alphaScale = fadeIn * fadeOut
            val centerX = width / 2f
            val iconCenterY = lerp(height * 0.72f, height * 0.46f, p.coerceAtMost(0.62f) / 0.62f)

            fillPaint.color = withAlpha(green, (42 * alphaScale).toInt())
            canvas.drawRect(0f, lerp(height.toFloat(), height * 0.18f, p), width.toFloat(), height.toFloat(), fillPaint)

            val icon = RectF(centerX - 76f, iconCenterY - 76f, centerX + 76f, iconCenterY + 76f)
            fillPaint.color = withAlpha(green, (215 * alphaScale).toInt())
            canvas.drawRoundRect(icon, 34f, 34f, fillPaint)

            strokePaint.color = withAlpha(Color.WHITE, (245 * alphaScale).toInt())
            strokePaint.strokeWidth = 8f
            val roofY = iconCenterY - 25f
            canvas.drawLine(centerX - 36f, roofY + 18f, centerX, roofY - 18f, strokePaint)
            canvas.drawLine(centerX, roofY - 18f, centerX + 36f, roofY + 18f, strokePaint)
            canvas.drawLine(centerX - 24f, roofY + 18f, centerX - 24f, roofY + 50f, strokePaint)
            canvas.drawLine(centerX + 24f, roofY + 18f, centerX + 24f, roofY + 50f, strokePaint)
            canvas.drawLine(centerX - 24f, roofY + 50f, centerX + 24f, roofY + 50f, strokePaint)

            textPaint.alpha = (230 * alphaScale).toInt()
            canvas.drawText("回到桌面", centerX, icon.bottom + 56f, textPaint)
            textPaint.alpha = 255
        }

        private fun lerp(start: Float, end: Float, progress: Float): Float =
            start + (end - start) * progress.coerceIn(0f, 1f)

        private fun withAlpha(color: Int, alpha: Int): Int =
            Color.argb(alpha.coerceIn(0, 255), Color.red(color), Color.green(color), Color.blue(color))
    }

    private sealed class Effect(open var progress: Float) {
        data class Tap(val x: Float, val y: Float, override var progress: Float = 0f) : Effect(progress)
        data class Drag(
            val x1: Float,
            val y1: Float,
            val x2: Float,
            val y2: Float,
            override var progress: Float = 0f,
        ) : Effect(progress)
        data class Home(override var progress: Float = 0f) : Effect(progress)
    }
}
