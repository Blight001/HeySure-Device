package ai.heysure.agent.remote

import android.content.Context
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.projection.MediaProjection
import android.os.Handler
import android.os.Looper
import android.view.Surface
import org.webrtc.CapturerObserver
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoFrame

/**
 * A [VideoCapturer] that mirrors the screen into WebRTC by drawing an
 * AUTO_MIRROR [VirtualDisplay] onto WebRTC's input surface.
 *
 * Unlike WebRTC's stock `ScreenCapturerAndroid`, this does **not** create its
 * own `MediaProjection` from the consent Intent — it reuses the one the app
 * already holds (granted once for AI screenshots). That avoids a second system
 * consent dialog and the single-use-token conflict, and lets the live mirror
 * coexist with the screenshot pipeline (multiple VirtualDisplays per
 * projection are allowed).
 */
class SharedProjectionCapturer(
    private val projection: MediaProjection,
    private val densityDpi: Int,
) : VideoCapturer {

    private val handler = Handler(Looper.getMainLooper())
    private var surfaceHelper: SurfaceTextureHelper? = null
    private var observer: CapturerObserver? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var surface: Surface? = null
    private var width = 0
    private var height = 0

    // The projection can be torn down by the system (e.g. user revokes); make
    // sure we stop drawing if that happens mid-session.
    private val projectionCallback = object : MediaProjection.Callback() {
        override fun onStop() {
            handler.post { releaseDisplay() }
        }
    }

    override fun initialize(
        helper: SurfaceTextureHelper,
        context: Context,
        capturerObserver: CapturerObserver,
    ) {
        this.surfaceHelper = helper
        this.observer = capturerObserver
    }

    override fun startCapture(width: Int, height: Int, framerate: Int) {
        val helper = surfaceHelper ?: return
        this.width = width
        this.height = height
        projection.registerCallback(projectionCallback, handler)
        helper.setTextureSize(width, height)
        val tex = helper.surfaceTexture.also { it.setDefaultBufferSize(width, height) }
        val target = Surface(tex)
        surface = target
        observer?.onCapturerStarted(true)
        helper.startListening { frame: VideoFrame -> observer?.onFrameCaptured(frame) }
        virtualDisplay = projection.createVirtualDisplay(
            "heysure-rc",
            width, height, densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            target, null, handler,
        )
    }

    /** Resize the mirror when the device rotates so the aspect ratio tracks the
     *  live screen instead of letterboxing. */
    fun resize(newWidth: Int, newHeight: Int) {
        val display = virtualDisplay ?: return
        val helper = surfaceHelper ?: return
        if (newWidth == width && newHeight == height) return
        width = newWidth
        height = newHeight
        helper.setTextureSize(newWidth, newHeight)
        helper.surfaceTexture.setDefaultBufferSize(newWidth, newHeight)
        display.resize(newWidth, newHeight, densityDpi)
    }

    override fun stopCapture() {
        releaseDisplay()
        surfaceHelper?.stopListening()
        observer?.onCapturerStopped()
    }

    private fun releaseDisplay() {
        runCatching { projection.unregisterCallback(projectionCallback) }
        virtualDisplay?.release()
        virtualDisplay = null
        surface?.release()
        surface = null
    }

    override fun changeCaptureFormat(width: Int, height: Int, framerate: Int) {
        resize(width, height)
    }

    override fun dispose() {
        stopCapture()
    }

    override fun isScreencast(): Boolean = true
}
