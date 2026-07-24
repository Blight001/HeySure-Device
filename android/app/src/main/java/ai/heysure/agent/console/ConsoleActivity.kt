package ai.heysure.agent.console

import ai.heysure.agent.MainActivity
import ai.heysure.agent.R
import ai.heysure.agent.agent.AgentService
import ai.heysure.agent.agent.ServerApi
import ai.heysure.agent.agent.Settings
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayInputStream

/**
 * Full-screen Android host for the shared web digital-society console.
 *
 * The document keeps the configured HeySure server as its real origin, so all
 * existing relative REST, Socket.IO and WebRTC URLs work unchanged. Hashed
 * Vue/Phaser assets are answered from the APK before the network is touched.
 * This gives Android a warm, deterministic UI without maintaining a second set
 * of console components.
 */
class ConsoleActivity : AppCompatActivity() {
    private lateinit var settings: Settings
    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var loading: ProgressBar
    private lateinit var loadingText: TextView
    private var loadedSessionKey = ""
    private var fileChooser: ValueCallback<Array<Uri>>? = null

    private val filePicker = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        fileChooser?.onReceiveValue(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
        fileChooser = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = Settings(this)
        window.statusBarColor = Color.rgb(9, 9, 11)
        window.navigationBarColor = Color.rgb(9, 9, 11)

        // Cold start: restore cached session (or silent re-login) before deciding
        // whether the console or the native login form should be shown.
        if (settings.isLoggedIn) {
            createShell()
            AgentService.start(this)
            loadConsole(force = true)
            refreshSessionInBackground()
            return
        }
        if (settings.canSilentLogin) {
            // Show a minimal loading shell while credentials are re-exchanged.
            createShell()
            showLoading(true, "正在恢复登录…")
            lifecycleScope.launch {
                val ok = restoreSessionBlocking()
                if (!ok || !settings.isLoggedIn) {
                    openAgentSettings(closeConsole = true)
                    return@launch
                }
                AgentService.start(this@ConsoleActivity)
                loadConsole(force = true)
            }
            return
        }
        openAgentSettings(closeConsole = true)
    }

    override fun onResume() {
        super.onResume()
        if (!::webView.isInitialized) {
            // Still waiting on silent login, or we already handed off to MainActivity.
            return
        }
        if (!settings.isLoggedIn) {
            if (settings.canSilentLogin) {
                lifecycleScope.launch {
                    val ok = restoreSessionBlocking()
                    if (!ok || !settings.isLoggedIn) {
                        openAgentSettings(closeConsole = true)
                        return@launch
                    }
                    AgentService.start(this@ConsoleActivity)
                    loadConsole(force = true)
                    webView.onResume()
                }
                return
            }
            openAgentSettings(closeConsole = true)
            return
        }
        AgentService.start(this)
        loadConsole(force = false)
        webView.onResume()
    }

    /** Best-effort token refresh so the embedded web console keeps a live JWT. */
    private fun refreshSessionInBackground() {
        lifecycleScope.launch {
            val previousToken = settings.authToken
            val ok = restoreSessionBlocking()
            if (!ok || !settings.isLoggedIn) {
                if (!settings.isLoggedIn) openAgentSettings(closeConsole = true)
                return@launch
            }
            if (::webView.isInitialized && settings.authToken != previousToken) {
                // Token was refreshed — reload so injectNativeSession picks it up.
                loadConsole(force = true)
            }
        }
    }

    private suspend fun restoreSessionBlocking(): Boolean {
        val restored = withContext(Dispatchers.IO) {
            runCatching { ServerApi.restoreSession(settings) }.getOrNull()
        } ?: return false
        if (restored.accessToken != settings.authToken || !settings.isLoggedIn) {
            settings.applyLogin(
                serverUrl = settings.serverUrl,
                result = restored,
                account = settings.userAccount,
                password = settings.userPassword,
                remember = settings.rememberLogin || settings.canSilentLogin,
            )
        }
        return settings.isLoggedIn
    }

    override fun onPause() {
        if (::webView.isInitialized) webView.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        fileChooser?.onReceiveValue(null)
        fileChooser = null
        if (::webView.isInitialized) {
            webView.stopLoading()
            webView.removeJavascriptInterface(JS_BRIDGE_NAME)
            webView.webChromeClient = null
            webView.webViewClient = WebViewClient()
            webView.destroy()
        }
        super.onDestroy()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack() else super.onBackPressed()
    }

    @SuppressLint("SetJavaScriptEnabled", "ClickableViewAccessibility")
    private fun createShell() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(9, 9, 11)) }
        webView = WebView(this).apply {
            setBackgroundColor(Color.TRANSPARENT)
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            isVerticalScrollBarEnabled = false
            isHorizontalScrollBarEnabled = false
            overScrollMode = View.OVER_SCROLL_NEVER
        }
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )

        loading = ProgressBar(this)
        root.addView(
            loading,
            FrameLayout.LayoutParams(dp(38), dp(38), Gravity.CENTER),
        )
        loadingText = TextView(this).apply {
            text = "正在载入数字社会"
            setTextColor(Color.rgb(161, 161, 170))
            textSize = 12f
        }
        root.addView(
            loadingText,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER,
            ).apply { topMargin = dp(74) },
        )

        val agentButton = TextView(this).apply {
            text = "设备"
            gravity = Gravity.CENTER
            setTextColor(ContextCompat.getColor(this@ConsoleActivity, R.color.text))
            textSize = 12f
            background = ContextCompat.getDrawable(this@ConsoleActivity, R.drawable.pill_bg)
            elevation = dp(6).toFloat()
            setPadding(dp(15), 0, dp(15), 0)
            contentDescription = "打开 Android Agent 设置"
            setOnClickListener { openAgentSettings(closeConsole = false) }
        }
        root.addView(
            agentButton,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                dp(42),
                Gravity.END or Gravity.BOTTOM,
            ).apply {
                marginEnd = dp(14)
                bottomMargin = dp(82)
            },
        )
        setContentView(root)

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            mediaPlaybackRequiresUserGesture = false
            loadsImagesAutomatically = true
            blockNetworkImage = false
            allowFileAccess = false
            allowContentAccess = true
            builtInZoomControls = false
            displayZoomControls = false
            setSupportZoom(false)
            offscreenPreRaster = true
            userAgentString = "$userAgentString HeySureAndroid/2.0"
        }
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(webView, true)
        }
        webView.addJavascriptInterface(AndroidBridge(), JS_BRIDGE_NAME)
        webView.webViewClient = ConsoleWebViewClient()
        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                loading.progress = newProgress
            }

            override fun onShowFileChooser(
                webView: WebView?,
                filePathCallback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?,
            ): Boolean {
                fileChooser?.onReceiveValue(null)
                fileChooser = filePathCallback
                val types = fileChooserParams?.acceptTypes
                    ?.filter { it.isNotBlank() }
                    ?.toTypedArray()
                    ?.takeIf { it.isNotEmpty() }
                    ?: arrayOf("*/*")
                filePicker.launch(types)
                return true
            }
        }
    }

    private fun loadConsole(force: Boolean) {
        val baseUrl = ServerApi.normalizeBaseUrl(settings.serverUrl)
        val sessionKey = "$baseUrl\n${settings.authToken}"
        if (!force && sessionKey == loadedSessionKey) return
        loadedSessionKey = sessionKey
        showLoading(true)
        webView.loadUrl("${baseUrl.trimEnd('/')}/")
    }

    private fun openAgentSettings(closeConsole: Boolean) {
        startActivity(Intent(this, MainActivity::class.java))
        if (closeConsole) finish()
    }

    private fun showLoading(show: Boolean, message: String = "正在载入数字社会") {
        loading.visibility = if (show) View.VISIBLE else View.GONE
        loadingText.text = message
        loadingText.visibility = if (show) View.VISIBLE else View.GONE
    }

    private inner class ConsoleWebViewClient : WebViewClient() {
        override fun shouldInterceptRequest(
            view: WebView?,
            request: WebResourceRequest?,
        ): WebResourceResponse? {
            val uri = request?.url ?: return null
            if (!isConsoleOrigin(uri)) return null
            val assetPath = bundledAssetPath(uri.path.orEmpty()) ?: return null
            return runCatching { bundledResponse(assetPath) }.getOrNull()
        }

        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
            val uri = request?.url ?: return false
            if (isConsoleOrigin(uri)) return false
            if (uri.scheme == "http" || uri.scheme == "https") {
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, uri)) }
                return true
            }
            return false
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            showLoading(false)
        }

        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            view?.destroy()
            recreate()
            return true
        }
    }

    private fun isConsoleOrigin(uri: Uri): Boolean {
        val base = Uri.parse(ServerApi.normalizeBaseUrl(settings.serverUrl))
        return uri.scheme.equals(base.scheme, ignoreCase = true) &&
            uri.host.equals(base.host, ignoreCase = true) &&
            uri.port == base.port
    }

    private fun bundledAssetPath(requestPath: String): String? {
        val clean = Uri.decode(requestPath).replace('\\', '/').trimStart('/')
        if (clean.split('/').any { it == ".." }) return null
        return when {
            clean.isEmpty() || clean == "index.html" -> "web/index.html"
            clean == "game" || clean == "game/" || clean == "game/index.html" -> "web/game/index.html"
            clean.startsWith("assets/") || clean.startsWith("game/") -> "web/$clean"
            else -> null
        }
    }

    private fun bundledResponse(assetPath: String): WebResourceResponse {
        val raw = assets.open(assetPath).use { it.readBytes() }
        val bytes = if (assetPath == "web/index.html") injectNativeSession(raw) else raw
        val extension = assetPath.substringAfterLast('.', "")
        val mime = when (extension.lowercase()) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json" -> "application/json"
            "svg" -> "image/svg+xml"
            "woff" -> "font/woff"
            "woff2" -> "font/woff2"
            "mp3" -> "audio/mpeg"
            "ogg" -> "audio/ogg"
            "mp4" -> "video/mp4"
            else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
                ?: "application/octet-stream"
        }
        return WebResourceResponse(mime, if (mime.startsWith("text/") || mime.contains("json")) "UTF-8" else null, ByteArrayInputStream(bytes)).apply {
            responseHeaders = mapOf(
                "Cache-Control" to if (assetPath == "web/index.html") "no-cache" else "public, max-age=31536000, immutable",
                "X-Content-Type-Options" to "nosniff",
            )
        }
    }

    private fun injectNativeSession(htmlBytes: ByteArray): ByteArray {
        val html = htmlBytes.toString(Charsets.UTF_8)
        val bootstrap = """
            <script>
              window.__HEYSURE_ANDROID__ = Object.freeze({
                deviceId: ${JSONObject.quote(settings.deviceId)},
                nativeShell: true
              });
              try { localStorage.setItem('token', ${JSONObject.quote(settings.authToken)}); } catch (_) {}
              document.documentElement.classList.add('heysure-android-shell');
            </script>
        """.trimIndent()
        return html.replace("</head>", "$bootstrap\n</head>").toByteArray(Charsets.UTF_8)
    }

    private inner class AndroidBridge {
        @JavascriptInterface
        fun openDeviceSettings() = runOnUiThread { openAgentSettings(closeConsole = false) }

        @JavascriptInterface
        fun getDeviceId(): String = settings.deviceId

        @JavascriptInterface
        fun reloadConsole() = runOnUiThread { loadConsole(force = true) }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val JS_BRIDGE_NAME = "HeySureAndroid"

        fun open(context: Context) {
            context.startActivity(Intent(context, ConsoleActivity::class.java).apply {
                if (context !is Activity) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        }
    }
}
