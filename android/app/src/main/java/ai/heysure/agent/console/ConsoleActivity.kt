package ai.heysure.agent.console

import ai.heysure.agent.MainActivity
import ai.heysure.agent.BuildConfig
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
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.MotionEvent
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
import android.widget.PopupMenu
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
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.abs

/**
 * Full-screen Android host for the shared web digital-society console.
 *
 * The document keeps the configured HeySure server as its real origin, so all
 * existing relative REST, Socket.IO and WebRTC URLs work unchanged. The live
 * deployment is loaded on explicit navigation; the APK copy remains available
 * as an offline fallback.
 */
class ConsoleActivity : AppCompatActivity() {
    private lateinit var settings: Settings
    private lateinit var root: FrameLayout
    private lateinit var webView: WebView
    private lateinit var loading: ProgressBar
    private lateinit var loadingText: TextView
    private lateinit var agentButton: TextView
    private var loadedSessionKey = ""
    private var fileChooser: ValueCallback<Array<Uri>>? = null
    @Volatile private var useBundledFallback = false
    private var agentButtonDockedLeft = false
    private var requestedWorkflowRunId = ""

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* A denied notification permission leaves in-app confirmation available. */ }

    private val filePicker = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris ->
        fileChooser?.onReceiveValue(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
        fileChooser = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = Settings(this)
        requestedWorkflowRunId = workflowRunId(intent)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
        window.statusBarColor = Color.rgb(9, 9, 11)
        window.navigationBarColor = Color.rgb(9, 9, 11)

        // Cold start: restore cached session (or silent re-login) before deciding
        // whether the console or the native login form should be shown.
        if (settings.isLoggedIn) {
            createShell()
            AgentService.start(this)
            if (requestedWorkflowRunId.isNotBlank() || !restoreConsoleState(savedInstanceState)) {
                loadConsole(force = true)
            }
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

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val runId = workflowRunId(intent)
        if (runId.isBlank()) return
        requestedWorkflowRunId = runId
        if (::webView.isInitialized && settings.isLoggedIn) loadConsole(force = true)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        if (::webView.isInitialized) {
            webView.saveState(outState)
            outState.putBoolean(STATE_BUNDLED_FALLBACK, useBundledFallback)
        }
        super.onSaveInstanceState(outState)
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

        agentButton = TextView(this).apply {
            text = "设备"
            gravity = Gravity.CENTER
            setTextColor(ContextCompat.getColor(this@ConsoleActivity, R.color.text))
            textSize = 12f
            background = ContextCompat.getDrawable(this@ConsoleActivity, R.drawable.pill_bg)
            elevation = dp(6).toFloat()
            contentDescription = "展开设备入口"
            setOnClickListener { showAgentMenu() }
            installAgentButtonDrag(this)
        }
        root.addView(
            agentButton,
            FrameLayout.LayoutParams(
                dp(AGENT_BUTTON_COLLAPSED_SIZE_DP),
                dp(42),
                Gravity.START or Gravity.TOP,
            ),
        )
        root.post {
            agentButton.y = (root.height - agentButton.height - dp(82)).coerceAtLeast(0).toFloat()
            collapseAgentButton(dockLeft = false)
        }
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
            userAgentString = "$userAgentString HeySureAndroid/${BuildConfig.VERSION_NAME}"
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
        val baseUrl = consoleBaseUrl()
        val sessionKey = "$baseUrl\n${settings.authToken}\n$requestedWorkflowRunId"
        if (!force && sessionKey == loadedSessionKey) return
        loadedSessionKey = sessionKey
        useBundledFallback = false
        showLoading(true)
        val target = Uri.parse("${baseUrl.trimEnd('/')}/").buildUpon().apply {
            if (requestedWorkflowRunId.isNotBlank()) {
                appendQueryParameter(WORKFLOW_CONFIRMATION_QUERY, requestedWorkflowRunId)
            }
            if (force) appendQueryParameter("heysure_refresh", System.currentTimeMillis().toString())
        }.build()
        webView.loadUrl(target.toString())
    }

    /** Preserve the rendered page when Android recreates this Activity in the background. */
    private fun restoreConsoleState(savedState: Bundle?): Boolean {
        if (savedState == null || webView.restoreState(savedState) == null) return false
        useBundledFallback = savedState.getBoolean(STATE_BUNDLED_FALLBACK, false)
        loadedSessionKey = "${consoleBaseUrl()}\n${settings.authToken}\n$requestedWorkflowRunId"
        showLoading(false)
        return true
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun installAgentButtonDrag(button: View) {
        var downRawX = 0f
        var downRawY = 0f
        var startX = 0f
        var startY = 0f
        var dragged = false
        val dragThreshold = dp(6).toFloat()

        button.setOnTouchListener { view, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = event.rawX
                    downRawY = event.rawY
                    startX = view.x
                    startY = view.y
                    dragged = false
                    view.parent.requestDisallowInterceptTouchEvent(true)
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downRawX
                    val dy = event.rawY - downRawY
                    if (!dragged && (abs(dx) > dragThreshold || abs(dy) > dragThreshold)) {
                        dragged = true
                    }
                    if (dragged) {
                        view.x = (startX + dx).coerceIn(0f, (root.width - view.width).coerceAtLeast(0).toFloat())
                        view.y = (startY + dy).coerceIn(0f, (root.height - view.height).coerceAtLeast(0).toFloat())
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    view.parent.requestDisallowInterceptTouchEvent(false)
                    if (dragged) {
                        val dockLeft = view.x + view.width / 2f < root.width / 2f
                        collapseAgentButton(dockLeft)
                    } else {
                        view.performClick()
                    }
                    true
                }
                MotionEvent.ACTION_CANCEL -> {
                    view.parent.requestDisallowInterceptTouchEvent(false)
                    collapseAgentButton(view.x + view.width / 2f < root.width / 2f)
                    true
                }
                else -> false
            }
        }
    }

    private fun showAgentMenu() {
        // Bring the half-hidden bubble fully into view while its action menu is open.
        agentButton.x = if (agentButtonDockedLeft) {
            dp(8).toFloat()
        } else {
            (root.width - agentButton.width - dp(8)).coerceAtLeast(0).toFloat()
        }
        agentButton.contentDescription = "设备操作菜单"

        PopupMenu(this, agentButton).apply {
            menu.add(0, MENU_DEVICE_SETTINGS, 0, "设备设置")
            menu.add(0, MENU_REFRESH_PAGE, 1, "刷新页面")
            setOnMenuItemClickListener { item ->
                when (item.itemId) {
                    MENU_DEVICE_SETTINGS -> {
                        openAgentSettings(closeConsole = false)
                        true
                    }
                    MENU_REFRESH_PAGE -> {
                        loadConsole(force = true)
                        true
                    }
                    else -> false
                }
            }
            setOnDismissListener { collapseAgentButton() }
            show()
        }
    }

    private fun collapseAgentButton(dockLeft: Boolean = agentButtonDockedLeft) {
        agentButtonDockedLeft = dockLeft
        agentButton.text = "设备"
        agentButton.contentDescription = "展开设备入口"
        agentButton.layoutParams = (agentButton.layoutParams as FrameLayout.LayoutParams).apply {
            width = dp(AGENT_BUTTON_COLLAPSED_SIZE_DP)
        }
        agentButton.post {
            val hiddenPart = dp(AGENT_BUTTON_HIDDEN_EDGE_DP)
            agentButton.x = if (agentButtonDockedLeft) {
                -hiddenPart.toFloat()
            } else {
                (root.width - agentButton.width + hiddenPart).toFloat()
            }
            agentButton.y = agentButton.y.coerceIn(
                0f,
                (root.height - agentButton.height).coerceAtLeast(0).toFloat(),
            )
        }
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

            // Resolve the entry document from the server first. It references the
            // newest content-hashed assets. If that fails, serve the complete APK
            // copy so an old index is never mixed with a new deployment.
            if (assetPath == "web/index.html" && !useBundledFallback) {
                val liveBytes = fetchLiveIndex(uri)
                if (liveBytes != null) {
                    return htmlResponse(injectNativeSession(liveBytes), "no-store")
                }
                useBundledFallback = true
            }
            if (!useBundledFallback) return null
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
        val base = Uri.parse(consoleBaseUrl())
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

    private fun fetchLiveIndex(uri: Uri): ByteArray? {
        val target = uri.toString()
        return runCatching {
            (URL(target).openConnection() as HttpURLConnection).run {
                requestMethod = "GET"
                connectTimeout = WEB_UPDATE_CONNECT_TIMEOUT_MS
                readTimeout = WEB_UPDATE_READ_TIMEOUT_MS
                useCaches = false
                instanceFollowRedirects = true
                setRequestProperty("Accept", "text/html")
                setRequestProperty("Cache-Control", "no-cache")
                try {
                    if (responseCode !in 200..299) return@run null
                    val bytes = inputStream.use { it.readBytes() }
                    // A direct API-gateway URL (commonly :3000) returns JSON at
                    // `/`; never mistake that health response for the web app.
                    bytes.takeIf { looksLikeConsoleHtml(it) }
                } finally {
                    disconnect()
                }
            }
        }.getOrNull()
    }

    private fun looksLikeConsoleHtml(bytes: ByteArray): Boolean {
        val prefix = bytes.toString(Charsets.UTF_8)
        return prefix.contains("<div id=\"app\"") && prefix.contains("</html>")
    }

    /**
     * A saved direct Gateway URL uses :3000, while the standard Web reverse
     * proxy is :58150. Accept both login forms and transparently choose the Web
     * origin; custom/public proxy URLs remain unchanged.
     */
    private fun consoleBaseUrl(): String {
        val configured = ServerApi.normalizeBaseUrl(settings.serverUrl).trimEnd('/')
        return runCatching {
            val url = URL(configured)
            if (url.port == API_GATEWAY_PORT) {
                URL(url.protocol, url.host, DEFAULT_WEB_CONSOLE_PORT, url.file).toString().trimEnd('/')
            } else {
                configured
            }
        }.getOrDefault(configured)
    }

    private fun htmlResponse(bytes: ByteArray, cacheControl: String): WebResourceResponse =
        WebResourceResponse("text/html", "UTF-8", ByteArrayInputStream(bytes)).apply {
            responseHeaders = mapOf(
                "Cache-Control" to cacheControl,
                "X-Content-Type-Options" to "nosniff",
            )
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

    private fun workflowRunId(source: Intent?): String {
        val extra = source?.getStringExtra(EXTRA_WORKFLOW_RUN_ID).orEmpty().trim()
        val deepLink = source?.data
            ?.takeIf { it.scheme == "heysure" && it.host == "workflow-confirmation" }
            ?.lastPathSegment.orEmpty().trim()
        return (extra.ifBlank { deepLink }).takeIf { value ->
            value.length in 1..160 && value.all { it.isLetterOrDigit() || it == '_' || it == '-' }
        }.orEmpty()
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
        private const val WEB_UPDATE_CONNECT_TIMEOUT_MS = 5_000
        private const val WEB_UPDATE_READ_TIMEOUT_MS = 10_000
        private const val API_GATEWAY_PORT = 3_000
        private const val DEFAULT_WEB_CONSOLE_PORT = 58_150
        private const val AGENT_BUTTON_COLLAPSED_SIZE_DP = 42
        private const val AGENT_BUTTON_HIDDEN_EDGE_DP = 14
        private const val STATE_BUNDLED_FALLBACK = "heysure.web.bundled_fallback"
        private const val MENU_DEVICE_SETTINGS = 1
        private const val MENU_REFRESH_PAGE = 2
        private const val WORKFLOW_CONFIRMATION_QUERY = "workflow_confirmation"
        const val EXTRA_WORKFLOW_RUN_ID = "workflowRunId"

        fun open(context: Context) {
            context.startActivity(Intent(context, ConsoleActivity::class.java).apply {
                if (context !is Activity) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        }
    }
}
