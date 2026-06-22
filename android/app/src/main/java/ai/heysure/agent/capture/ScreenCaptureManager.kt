package ai.heysure.agent.capture

import ai.heysure.agent.agent.CaptureQuality
import ai.heysure.agent.agent.Settings
import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.Image
import android.media.ImageReader
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.coroutines.resume
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Owns the single MediaProjection grant and turns it into screenshots
 * (ImageReader) and screen recordings (MediaRecorder). The projection is
 * acquired once via the system consent dialog and kept alive by the foreground
 * service so individual tasks don't re-prompt.
 */
class ScreenCaptureManager(private val appContext: Context) {

    @Volatile
    private var projection: MediaProjection? = null
    private val settings = Settings(appContext)
    private val mainHandler = Handler(Looper.getMainLooper())

    val isReady: Boolean get() = projection != null

    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() { projection = null }
    }

    fun attach(mp: MediaProjection) {
        release()
        // Android 14 (API 34) requires a registered callback before any
        // createVirtualDisplay call, or it throws.
        mp.registerCallback(projectionCallback, mainHandler)
        projection = mp
    }

    fun release() {
        runCatching {
            projection?.unregisterCallback(projectionCallback)
            projection?.stop()
        }
        projection = null
    }

    private fun metrics(): DisplayMetrics {
        val wm = appContext.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val dm = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(dm)
        return dm
    }

    /** Capture one frame and return it as a compressed image data URL (key the server's
     *  screenshot pipeline recognises — see device_dispatch `_IMAGE_DATA_URL_KEYS`). */
    suspend fun captureDataUrl(): String {
        val mp = projection ?: throw IllegalStateException("未授权截屏：请先在 App 内点击\"授权截屏/录屏\"")
        val quality = settings.captureQuality
        val dm = metrics()
        val width = dm.widthPixels
        val height = dm.heightPixels
        val density = dm.densityDpi

        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        val display: VirtualDisplay = mp.createVirtualDisplay(
            "heysure-capture",
            width, height, density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface, null, mainHandler,
        ) ?: throw IllegalStateException("无法创建截屏虚拟显示")
        try {
            val image = awaitImage(reader)
            val bitmap = imageToBitmap(image, width)
            image.close()
            val cropped = if (bitmap.width != width) {
                Bitmap.createBitmap(bitmap, 0, 0, width, height)
            } else bitmap
            return "data:image/jpeg;base64," + encodeJpegUnderLimit(cropped, quality)
        } finally {
            display.release()
            reader.close()
        }
    }

    /** Record the screen for [durationMs] into an mp4 and return its file path.
     *  Video only — no microphone — to avoid the RECORD_AUDIO permission, which
     *  reads as spyware to anti-fraud / Play Protect scanners. */
    suspend fun recordToFile(durationMs: Long): File {
        val mp = projection ?: throw IllegalStateException("未授权录屏：请先在 App 内点击\"授权截屏/录屏\"")
        val quality = settings.captureQuality
        val dm = metrics()
        val width = even((dm.widthPixels * quality.videoScale).toInt())
        val height = even((dm.heightPixels * quality.videoScale).toInt())
        val bitrate = videoBitrateFor(quality, durationMs)

        val outFile = File(appContext.cacheDir, "heysure-record-${System.currentTimeMillis()}.mp4")
        val recorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(appContext)
        } else {
            @Suppress("DEPRECATION") MediaRecorder()
        }
        recorder.apply {
            setVideoSource(MediaRecorder.VideoSource.SURFACE)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setOutputFile(outFile.absolutePath)
            setVideoEncoder(MediaRecorder.VideoEncoder.H264)
            setVideoSize(width, height)
            setVideoEncodingBitRate(bitrate)
            setVideoFrameRate(30)
            prepare()
        }

        val display = mp.createVirtualDisplay(
            "heysure-record",
            width, height, dm.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            recorder.surface, null, mainHandler,
        ) ?: throw IllegalStateException("无法创建录屏虚拟显示")
        try {
            recorder.start()
            delay(durationMs.coerceIn(500, 120_000))
        } finally {
            runCatching { recorder.stop() }
            recorder.reset()
            recorder.release()
            display.release()
        }
        return outFile
    }

    private suspend fun awaitImage(reader: ImageReader): Image =
        suspendCancellableCoroutine { cont ->
            reader.setOnImageAvailableListener({ r ->
                val img = r.acquireLatestImage()
                if (img != null && cont.isActive) {
                    r.setOnImageAvailableListener(null, null)
                    cont.resume(img)
                }
            }, mainHandler)
        }

    private fun imageToBitmap(image: Image, width: Int): Bitmap {
        val plane = image.planes[0]
        val pixelStride = plane.pixelStride
        val rowStride = plane.rowStride
        val rowPadding = rowStride - pixelStride * width
        val bmpWidth = width + rowPadding / pixelStride
        val bitmap = Bitmap.createBitmap(bmpWidth, image.height, Bitmap.Config.ARGB_8888)
        bitmap.copyPixelsFromBuffer(plane.buffer)
        return bitmap
    }

    private fun encodeJpegUnderLimit(source: Bitmap, quality: CaptureQuality): String {
        var current = scaleToMaxSide(source, quality.imageMaxSide)
        var jpegQuality = quality.imageStartQuality
        var bytes = jpegBytes(current, jpegQuality)

        while (bytes.size > MAX_CAPTURE_BYTES && jpegQuality > MIN_JPEG_QUALITY) {
            jpegQuality -= 8
            bytes = jpegBytes(current, jpegQuality)
        }

        while (bytes.size > MAX_CAPTURE_BYTES && current.width > MIN_IMAGE_SIDE && current.height > MIN_IMAGE_SIDE) {
            val nextWidth = even((current.width * 0.86f).toInt()).coerceAtLeast(MIN_IMAGE_SIDE)
            val nextHeight = even((current.height * 0.86f).toInt()).coerceAtLeast(MIN_IMAGE_SIDE)
            current = Bitmap.createScaledBitmap(current, nextWidth, nextHeight, true)
            jpegQuality = minOf(jpegQuality, 68)
            bytes = jpegBytes(current, jpegQuality)
        }

        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }

    private fun jpegBytes(bitmap: Bitmap, quality: Int): ByteArray {
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(MIN_JPEG_QUALITY, 95), out)
        return out.toByteArray()
    }

    private fun scaleToMaxSide(source: Bitmap, maxSide: Int): Bitmap {
        val longest = maxOf(source.width, source.height)
        if (longest <= maxSide) return source
        val scale = maxSide.toFloat() / longest
        val width = even((source.width * scale).toInt()).coerceAtLeast(MIN_IMAGE_SIDE)
        val height = even((source.height * scale).toInt()).coerceAtLeast(MIN_IMAGE_SIDE)
        return Bitmap.createScaledBitmap(source, width, height, true)
    }

    private fun videoBitrateFor(quality: CaptureQuality, durationMs: Long): Int {
        val seconds = (durationMs.coerceIn(500, 120_000) / 1000.0).coerceAtLeast(0.5)
        val budgetBitrate = ((MAX_CAPTURE_BYTES * 8 * 0.62) / seconds).toInt()
        return minOf(quality.videoBitrate, budgetBitrate).coerceAtLeast(MIN_VIDEO_BITRATE)
    }

    private fun even(value: Int): Int = value.coerceAtLeast(2).let { if (it % 2 == 0) it else it - 1 }

    private companion object {
        const val MAX_CAPTURE_BYTES = 500 * 1024
        const val MIN_JPEG_QUALITY = 28
        const val MIN_IMAGE_SIDE = 160
        const val MIN_VIDEO_BITRATE = 24_000
    }
}
