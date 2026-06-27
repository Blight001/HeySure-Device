package ai.heysure.agent

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import ai.heysure.agent.agent.AgentService
import ai.heysure.agent.agent.CaptureQuality
import ai.heysure.agent.agent.DeviceStatus
import ai.heysure.agent.agent.ServerApi
import ai.heysure.agent.agent.Settings
import ai.heysure.agent.accessibility.GestureAccessibilityService
import ai.heysure.agent.databinding.ActivityMainBinding
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Outline
import android.graphics.drawable.ColorDrawable
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings as AndroidSettings
import android.view.MotionEvent
import android.view.View
import android.view.ViewOutlineProvider
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.AppCompatButton
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.google.android.material.switchmaterial.SwitchMaterial
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.net.URL

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private lateinit var settings: Settings
    private var dialogLogText: TextView? = null
    private val logLines = ArrayDeque<String>()
    private var permissionDialog: AlertDialog? = null
    private var accessibilityStep: StepViews? = null
    private var captureStep: StepViews? = null
    private val permissionPoller = Handler(Looper.getMainLooper())
    private val permissionPoll = object : Runnable {
        override fun run() {
            refreshPermissionDialog()
            if (permissionDialog?.isShowing == true) {
                permissionPoller.postDelayed(this, 800)
            }
        }
    }

    private val captureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode != RESULT_OK || result.data == null) {
            toast("已取消截屏授权")
            return@registerForActivityResult
        }
        AgentService.start(this)
        val intent = Intent(this, AgentService::class.java).apply {
            action = AgentService.ACTION_GRANT_CAPTURE
            putExtra(AgentService.EXTRA_RESULT_CODE, result.resultCode)
            putExtra(AgentService.EXTRA_RESULT_DATA, result.data)
        }
        startService(intent)
        toast("截屏/录屏已授权")
        refreshPermissionDialog()
    }

    private val notifPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { /* notification is best-effort */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        settings = Settings(this)

        binding.serverUrlInput.setText(settings.serverUrl)
        binding.accountInput.setText(settings.userAccount)
        binding.passwordInput.setText(if (settings.rememberLogin) settings.userPassword else "")
        binding.rememberLoginSwitch.isChecked = settings.rememberLogin
        binding.loginButton.setOnClickListener { doLogin() }
        binding.logoutButton.setOnClickListener { doLogout() }
        binding.userChip.setOnClickListener { showAccountDialog() }
        binding.settingsButton.visibility = View.GONE
        binding.backFromSettingsButton.setOnClickListener { showMainPanel() }
        binding.backFromAccountButton.setOnClickListener { showMainPanel() }
        binding.accessibilityButton.setOnClickListener {
            startActivity(Intent(AndroidSettings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        binding.captureButton.setOnClickListener { requestCapture() }
        binding.batteryButton.setOnClickListener { requestBatteryExemption() }
        binding.stopButton.setOnClickListener {
            startService(Intent(this, AgentService::class.java).apply { action = AgentService.ACTION_STOP })
            renderStatus(DeviceStatus.DISCONNECTED, null)
        }
        binding.rememberLoginSwitch.setOnCheckedChangeListener { _, checked ->
            settings.rememberLogin = checked
            if (!checked) {
                settings.userPassword = ""
                binding.passwordInput.setText("")
            }
        }

        binding.keepAwakeSwitch.isChecked = settings.keepScreenAwake
        binding.keepAwakeSwitch.setOnCheckedChangeListener { _, checked ->
            settings.keepScreenAwake = checked
            // The service owns the WakeLock; make sure it is up, then apply.
            AgentService.start(this)
            AgentService.instance?.applyKeepAwake(checked)
            if (checked) toast("已开启保持常亮（较耗电）")
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            notifPermLauncher.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }

        bindTapFeedback(binding.userChip)
        bindTapFeedback(binding.loginButton)
        bindTapFeedback(binding.logoutButton)
        makeAvatarCircular()
        renderMcpInfo()
        updateSessionUi()
        if (settings.isLoggedIn) {
            AgentService.start(this)
            binding.root.postDelayed({ maybeShowPermissionDialog() }, 300)
        }
    }

    override fun onResume() {
        super.onResume()
        attachAgentServiceListeners()
        binding.batteryButton.isEnabled = !isIgnoringBatteryOptimizations()
        if (settings.isLoggedIn) maybeShowPermissionDialog()
    }

    private fun doLogin() {
        val serverUrl = binding.serverUrlInput.text.toString()
        val account = binding.accountInput.text.toString()
        val password = binding.passwordInput.text.toString()
        val remember = binding.rememberLoginSwitch.isChecked
        if (serverUrl.isBlank() || account.isBlank() || password.isBlank()) {
            showLoginError("请填写服务器地址、账号和密码")
            return
        }
        binding.loginButton.isEnabled = false
        showLoginError(null)
        appendLog("登录中…")
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching { ServerApi.login(serverUrl, account, password) }
            }
            binding.loginButton.isEnabled = true
            result.onSuccess { res ->
                settings.serverUrl = ServerApi.normalizeBaseUrl(serverUrl)
                settings.agentSocketUrl = res.agentSocketUrl
                settings.authToken = res.accessToken
                settings.userId = res.userId
                settings.userName = res.userName
                settings.userAvatar = res.userAvatar
                settings.userAccount = account
                settings.rememberLogin = remember
                settings.userPassword = if (remember) password else ""
                appendLog("登录成功：${res.userName}")
                updateSessionUi()
                AgentService.start(this@MainActivity)
                binding.root.postDelayed({
                    attachAgentServiceListeners()
                    AgentService.instance?.reconnect()
                    maybeShowPermissionDialog()
                }, 300)
            }.onFailure { e ->
                appendLog("登录失败：${e.message}")
                showLoginError(e.message ?: "登录失败")
                toast(e.message ?: "登录失败")
            }
        }
    }

    private fun attachAgentServiceListeners() {
        AgentService.instance?.let { svc ->
            svc.statusListener = { status, reason -> runOnUiThread { renderStatus(status, reason) } }
            svc.logListener = { msg -> runOnUiThread { appendLog(msg) } }
            renderStatus(svc.lastStatus, null)
        }
    }

    private fun doLogout() {
        permissionDialog?.dismiss()
        permissionDialog = null
        settings.clearSession()
        startService(Intent(this, AgentService::class.java).apply { action = AgentService.ACTION_STOP })
        renderStatus(DeviceStatus.DISCONNECTED, null)
        appendLog("已退出登录")
        updateSessionUi()
    }

    private fun requestCapture() {
        val mpm = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        captureLauncher.launch(mpm.createScreenCaptureIntent())
    }

    private fun isIgnoringBatteryOptimizations(): Boolean {
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(packageName)
    }

    private fun requestBatteryExemption() {
        if (isIgnoringBatteryOptimizations()) {
            toast("已在电池白名单中")
            return
        }
        // Open the system battery-optimization list and let the user whitelist us
        // manually. We deliberately avoid ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS
        // (and its restricted permission) to keep the permission profile clean.
        toast("请在列表中找到「HeySure 安卓端」并设为「不优化 / 无限制」")
        try {
            startActivity(Intent(AndroidSettings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (e: Exception) {
            startActivity(Intent(AndroidSettings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.parse("package:$packageName")))
        }
    }

    private fun canWriteSystemSettings(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || AndroidSettings.System.canWrite(this)

    private fun requestWriteSettings() {
        toast("请在系统页面允许「修改系统设置」后返回，再开启远程控制模式")
        // Deep-link straight to our app's toggle; fall back to the generic list if unsupported.
        try {
            startActivity(Intent(AndroidSettings.ACTION_MANAGE_WRITE_SETTINGS,
                Uri.parse("package:$packageName")))
        } catch (e: Exception) {
            startActivity(Intent(AndroidSettings.ACTION_MANAGE_WRITE_SETTINGS))
        }
    }

    private fun isAccessibilityReady(): Boolean =
        GestureAccessibilityService.instance != null

    private fun isCaptureReady(): Boolean =
        AgentService.instance?.screenCapture?.isReady == true

    private fun hasRequiredPermissions(): Boolean =
        isAccessibilityReady() && isCaptureReady()

    private fun maybeShowPermissionDialog() {
        if (!settings.isLoggedIn) return
        AgentService.start(this)
        if (hasRequiredPermissions()) {
            permissionDialog?.dismiss()
            permissionDialog = null
            return
        }
        if (permissionDialog?.isShowing == true) {
            refreshPermissionDialog()
            return
        }
        showPermissionDialog()
    }

    private fun showPermissionDialog() {
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }
        accessibilityStep = permissionStep(
            number = "01",
            title = "开启无障碍服务",
            description = "允许 HeySure 执行点击、滑动、返回等触控操作。",
        ) {
            startActivity(Intent(AndroidSettings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        captureStep = permissionStep(
            number = "02",
            title = "授权截屏/录屏",
            description = "允许 AI 获取屏幕画面，用于判断界面状态。",
        ) { requestCapture() }
        body.addView(accessibilityStep!!.container)
        body.addView(captureStep!!.container)
        body.addView(hintText("授权完成后步骤会变绿并自动关闭，无需手动重进 App。").apply {
            setPadding(0, dp(8), 0, 0)
        })

        permissionDialog = AlertDialog.Builder(this)
            .setView(dialogShell(
                title = "完成权限授权",
                subtitle = "按顺序完成下面两个步骤，全部通过后才能稳定执行 Android MCP 工具。",
                body = body,
            ))
            .create()
            .apply {
                setCancelable(false)
                setCanceledOnTouchOutside(false)
                setOnShowListener {
                    prepareDialogWindow(this)
                    refreshPermissionDialog()
                    permissionPoller.removeCallbacks(permissionPoll)
                    permissionPoller.postDelayed(permissionPoll, 800)
                }
                setOnDismissListener {
                    accessibilityStep = null
                    captureStep = null
                    permissionPoller.removeCallbacks(permissionPoll)
                    if (permissionDialog === this) permissionDialog = null
                }
            }
        permissionDialog?.show()
    }

    private fun refreshPermissionDialog() {
        if (permissionDialog == null) return
        applyStepState(accessibilityStep, isAccessibilityReady(), "已开启无障碍服务", "尚未开启")
        applyStepState(captureStep, isCaptureReady(), "已授权截屏 / 录屏", "尚未授权")
        if (hasRequiredPermissions()) {
            // Let the user see both steps flip to green before the dialog closes.
            permissionPoller.removeCallbacks(permissionPoll)
            binding.root.postDelayed({
                permissionDialog?.dismiss()
                permissionDialog = null
            }, 560)
        }
    }

    /** Recolor a permission step to reflect its done/pending state (green = 已完成). */
    private fun applyStepState(
        step: StepViews?,
        ready: Boolean,
        doneText: String,
        pendingText: String,
    ) {
        step ?: return
        val justCompleted = ready && !step.done
        step.done = ready
        if (ready) {
            step.container.background = ContextCompat.getDrawable(this, R.drawable.step_bg_done)
            step.badge.background = ContextCompat.getDrawable(this, R.drawable.badge_step_done)
            step.badge.text = "✓"
            step.status.text = doneText
            step.status.setTextColor(ContextCompat.getColor(this, R.color.status_green))
            step.button.background = ContextCompat.getDrawable(this, R.drawable.btn_secondary)
            step.button.text = "已完成"
            step.button.setTextColor(ContextCompat.getColor(this, R.color.status_green))
            step.button.isEnabled = false
            step.button.alpha = 1f
            if (justCompleted) pop(step.badge)
        } else {
            step.container.background = ContextCompat.getDrawable(this, R.drawable.step_bg)
            step.badge.background = ContextCompat.getDrawable(this, R.drawable.badge_step)
            step.badge.text = step.number
            step.status.text = pendingText
            step.status.setTextColor(ContextCompat.getColor(this, R.color.pending))
            step.button.background = ContextCompat.getDrawable(this, R.drawable.btn_primary)
            step.button.text = "授权"
            step.button.setTextColor(Color.WHITE)
            step.button.isEnabled = true
            step.button.alpha = 1f
        }
    }

    private fun renderStatus(status: DeviceStatus, reason: String?) {
        val (label, colorRes) = when (status) {
            DeviceStatus.REGISTERED -> R.string.status_registered to R.color.status_green
            DeviceStatus.CONNECTED -> R.string.status_connected to R.color.status_yellow
            DeviceStatus.CONNECTING -> R.string.status_connecting to R.color.status_yellow
            DeviceStatus.ERROR -> R.string.status_error to R.color.status_red
            DeviceStatus.DISCONNECTED -> R.string.status_disconnected to R.color.status_red
        }
        binding.statusText.text = getString(label) + (reason?.let { "（$it）" } ?: "")
        binding.statusDot.backgroundTintList =
            ColorStateList.valueOf(ContextCompat.getColor(this, colorRes))
        renderConnectionInfo()
    }

    private fun appendLog(msg: String) {
        val ts = android.text.format.DateFormat.format("HH:mm:ss", System.currentTimeMillis())
        logLines.addFirst("[$ts] $msg")
        while (logLines.size > MAX_LOG_LINES) logLines.removeLast()
        val text = logLines.joinToString("\n")
        binding.logText.text = text
        dialogLogText?.text = text
    }

    private fun updateSessionUi() {
        val loggedIn = settings.isLoggedIn
        binding.userChip.visibility = if (loggedIn) View.VISIBLE else View.GONE
        binding.settingsButton.visibility = View.GONE
        binding.headerSubtitle.visibility = if (loggedIn) View.VISIBLE else View.GONE
        if (loggedIn) {
            updateUserChip()
            renderConnectionInfo()
            renderAccountInfo()
            showMainPanel()
        } else {
            binding.loginPanel.visibility = View.VISIBLE
            binding.mainPanel.visibility = View.GONE
            binding.settingsPanel.visibility = View.GONE
            binding.accountPanel.visibility = View.GONE
            binding.accountInput.setText(settings.userAccount)
            binding.passwordInput.setText(if (settings.rememberLogin) settings.userPassword else "")
            binding.rememberLoginSwitch.isChecked = settings.rememberLogin
            showLoginError(null)
        }
    }

    private fun showMainPanel() {
        binding.loginPanel.visibility = View.GONE
        binding.mainPanel.visibility = View.VISIBLE
        binding.settingsPanel.visibility = View.GONE
        binding.accountPanel.visibility = View.GONE
        renderMcpInfo()
        renderConnectionInfo()
        staggerReveal(binding.mainPanel)
    }

    private fun showSettingsPanel() {
        showSettingsDialog()
    }

    private fun showAccountPanel() {
        showAccountDialog()
    }

    private fun showLoginError(msg: String?) {
        binding.loginErrorText.text = msg.orEmpty()
        binding.loginErrorText.visibility = if (msg.isNullOrBlank()) View.GONE else View.VISIBLE
    }

    private fun updateUserChip() {
        val name = settings.userName.ifBlank { "已登录" }
        binding.headerUserName.text = name
        binding.userAvatarText.text = name.take(1).uppercase()
        binding.userAvatarImage.visibility = View.GONE
        binding.userAvatarText.visibility = View.VISIBLE
        val avatarUrl = resolveAvatarUrl(settings.userAvatar)
        if (avatarUrl.isBlank()) return
        lifecycleScope.launch {
            val bitmap = withContext(Dispatchers.IO) {
                runCatching {
                    val conn = URL(avatarUrl).openConnection().apply {
                        connectTimeout = 8_000
                        readTimeout = 8_000
                    }
                    conn.getInputStream().use(android.graphics.BitmapFactory::decodeStream)
                }.getOrNull()
            }
            if (bitmap != null && settings.isLoggedIn) {
                binding.userAvatarImage.setImageBitmap(bitmap)
                binding.userAvatarImage.visibility = View.VISIBLE
                binding.userAvatarText.visibility = View.GONE
                pulse(binding.userAvatarImage)
            }
        }
    }

    private fun renderAccountInfo() {
        val host = runCatching { URL(settings.serverUrl).host }.getOrNull().orEmpty()
            .ifBlank { settings.serverUrl.ifBlank { "—" } }
        binding.accountInfoText.text = listOf(
            "名称：${settings.userName.ifBlank { "—" }}",
            "账号：${settings.userAccount.ifBlank { "—" }}",
            "服务器：$host",
            "设备 ID：${settings.deviceId}",
        ).joinToString("\n")
    }

    private fun showAccountDialog() {
        renderAccountInfo()
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@MainActivity).apply {
                text = binding.accountInfoText.text
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text))
                textSize = 13f
                setLineSpacing(dp(3).toFloat(), 1f)
                background = ContextCompat.getDrawable(this@MainActivity, R.drawable.pill_bg)
                setPadding(dp(12), dp(10), dp(12), dp(10))
            })
        }
        lateinit var dialog: AlertDialog
        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(dialogButton("设置", primary = true) {
                dialog.dismiss()
                showSettingsDialog()
            })
            addView(dialogButton(getString(R.string.logout), danger = true) {
                dialog.dismiss()
                doLogout()
            })
            addView(dialogButton(getString(R.string.back)) { dialog.dismiss() })
        }

        dialog = AlertDialog.Builder(this)
            .setView(dialogShell(
                title = getString(R.string.card_account_info),
                subtitle = "当前登录的软件端账号与本机设备信息。",
                body = body,
                actions = actions,
            ))
            .create()
        dialog.setOnShowListener { prepareDialogWindow(dialog) }
        dialog.show()
    }

    private fun showSettingsDialog() {
        val body = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
        }

        body.addView(sectionTitle(getString(R.string.card_permissions)))
        body.addView(dialogButton(getString(R.string.enable_accessibility)) {
            startActivity(Intent(AndroidSettings.ACTION_ACCESSIBILITY_SETTINGS))
        })
        body.addView(dialogButton(getString(R.string.grant_capture)) { requestCapture() })
        body.addView(hintText(getString(R.string.hint_permissions)))

        body.addView(sectionTitle(getString(R.string.card_capture_quality)))
        body.addView(captureQualityPicker())
        body.addView(hintText(getString(R.string.hint_capture_quality)))

        body.addView(sectionTitle(getString(R.string.card_power)))
        body.addView(SwitchMaterial(this).apply {
            text = getString(R.string.keep_awake)
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text))
            textSize = 13f
            isChecked = settings.keepScreenAwake
            setOnCheckedChangeListener { _, checked ->
                settings.keepScreenAwake = checked
                AgentService.start(this@MainActivity)
                AgentService.instance?.applyKeepAwake(checked)
                if (checked) toast("已开启保持常亮（较耗电）")
            }
        })
        body.addView(SwitchMaterial(this).apply {
            text = getString(R.string.remote_control_mode)
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text))
            textSize = 13f
            isChecked = settings.remoteControlMode
            setOnCheckedChangeListener { btn, checked ->
                // Brightness control needs WRITE_SETTINGS; guide the user there first and
                // revert the switch so they can flip it once the grant is back.
                if (checked && !canWriteSystemSettings()) {
                    btn.isChecked = false
                    requestWriteSettings()
                    return@setOnCheckedChangeListener
                }
                AgentService.start(this@MainActivity)
                AgentService.instance?.applyRemoteControlMode(checked)
                if (checked) toast("已开启远程控制模式：屏幕常亮 + 最低亮度")
            }
        })
        body.addView(hintText(getString(R.string.hint_remote_control)))
        body.addView(dialogButton(getString(R.string.battery_exempt)) { requestBatteryExemption() })
        body.addView(dialogButton(getString(R.string.stop)) {
            startService(Intent(this, AgentService::class.java).apply { action = AgentService.ACTION_STOP })
            renderStatus(DeviceStatus.DISCONNECTED, null)
        })
        body.addView(hintText(getString(R.string.hint_power)))

        body.addView(sectionTitle(getString(R.string.card_log)))
        dialogLogText = TextView(this).apply {
            text = binding.logText.text
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.muted))
            textSize = 11f
            typeface = android.graphics.Typeface.MONOSPACE
            background = ContextCompat.getDrawable(this@MainActivity, R.drawable.pill_bg)
            setPadding(dp(10), dp(8), dp(10), dp(8))
        }
        body.addView(dialogLogText)

        lateinit var dialog: AlertDialog
        val actions = dialogActions(
            dialogButton(getString(R.string.back), primary = true) { dialog.dismiss() },
        )
        dialog = AlertDialog.Builder(this)
            .setView(dialogShell(
                title = "设置",
                subtitle = "权限、后台常亮和调试信息都在这里管理。",
                body = body,
                actions = actions,
            ))
            .create()
            .apply {
                setOnDismissListener { dialogLogText = null }
                setOnShowListener { prepareDialogWindow(this) }
            }
        dialog.show()
    }

    private fun renderConnectionInfo() {
        binding.connectionInfoText.text = listOf(
            "服务器：${settings.serverUrl.ifBlank { "—" }}",
            "设备：${settings.deviceId}",
            "AI 分配：由网页端「作坊」栏目管理",
        ).joinToString("\n")
    }

    private fun renderMcpInfo() {
        val tools = ANDROID_MCP_TOOLS
        val groups = tools.groupBy { it.group }
        binding.mcpCountText.text = "${tools.size} 个 · ${groups.size} 类"
        binding.mcpListContainer.removeAllViews()
        groups.forEach { (group, groupTools) ->
            binding.mcpListContainer.addView(mcpGroupTitle(group, groupTools.size))
            groupTools.forEach { tool ->
                binding.mcpListContainer.addView(mcpToolRow(tool))
            }
        }
    }

    private fun resolveAvatarUrl(raw: String): String {
        val avatar = raw.trim()
        if (avatar.isBlank()) return ""
        val base = settings.serverUrl.trimEnd('/')
        val preset = Regex("avatars([1-5])(?:[-.][^/]*)?\\.png", RegexOption.IGNORE_CASE)
            .find(avatar)
        if (preset != null) return if (base.isBlank()) "" else "$base/avatars/avatars${preset.groupValues[1]}.png"
        if (avatar.startsWith("http://") || avatar.startsWith("https://")) return avatar
        if (base.isBlank()) return avatar
        return if (avatar.startsWith("/")) "$base$avatar" else "$base/$avatar"
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun dialogShell(
        title: String,
        subtitle: String,
        body: LinearLayout,
        actions: LinearLayout? = null,
    ) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = ContextCompat.getDrawable(this@MainActivity, R.drawable.card_bg)
        setPadding(dp(18), dp(16), dp(18), dp(16))

        addView(TextView(this@MainActivity).apply {
            text = title
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text))
            textSize = 17f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        })
        if (subtitle.isNotBlank()) {
            addView(TextView(this@MainActivity).apply {
                text = subtitle
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.muted))
                textSize = 11f
                setLineSpacing(dp(2).toFloat(), 1f)
                setPadding(0, dp(4), 0, dp(10))
            })
        } else {
            setPadding(dp(18), dp(16), dp(18), dp(12))
        }
        addView(body)
        actions?.let {
            it.setPadding(0, dp(12), 0, 0)
            addView(it)
        }
    }

    private fun dialogActions(vararg buttons: AppCompatButton) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        buttons.forEachIndexed { index, button ->
            addView(button, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                if (index > 0) leftMargin = dp(8)
            })
        }
    }

    private fun prepareDialogWindow(dialog: AlertDialog) {
        dialog.window?.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        dialog.window?.setDimAmount(0.62f)
        dialog.window?.setLayout((resources.displayMetrics.widthPixels * 0.9f).toInt(), android.view.WindowManager.LayoutParams.WRAP_CONTENT)
        animateDialog(dialog)
    }

    private fun sectionTitle(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(ContextCompat.getColor(this@MainActivity, R.color.muted))
        textSize = 11f
        typeface = android.graphics.Typeface.DEFAULT_BOLD
        setPadding(0, dp(12), 0, dp(6))
    }

    private fun hintText(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(ContextCompat.getColor(this@MainActivity, R.color.muted))
        textSize = 11f
        setLineSpacing(dp(2).toFloat(), 1f)
        setPadding(0, dp(4), 0, dp(4))
    }

    private fun dialogButton(
        text: String,
        primary: Boolean = false,
        danger: Boolean = false,
        onClick: () -> Unit,
    ) = AppCompatButton(this).apply {
        this.text = text
        isAllCaps = false
        background = ContextCompat.getDrawable(
            this@MainActivity,
            if (primary) R.drawable.btn_primary else R.drawable.btn_secondary,
        )
        setTextColor(
            when {
                primary -> Color.WHITE
                danger -> ContextCompat.getColor(this@MainActivity, R.color.status_red)
                else -> ContextCompat.getColor(this@MainActivity, R.color.text)
            },
        )
        setSingleLine(true)
        minWidth = dp(72)
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(8) }
        bindTapFeedback(this)
        setOnClickListener { onClick() }
    }

    private fun captureQualityPicker() = RadioGroup(this).apply {
        orientation = RadioGroup.VERTICAL
        background = ContextCompat.getDrawable(this@MainActivity, R.drawable.pill_bg)
        setPadding(dp(10), dp(8), dp(10), dp(8))

        val ids = mutableMapOf<Int, CaptureQuality>()
        CaptureQuality.entries.forEach { quality ->
            val radio = RadioButton(this@MainActivity).apply {
                id = View.generateViewId()
                text = "${quality.label}画质 · ${quality.description}"
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text))
                textSize = 12f
                minHeight = dp(38)
                buttonTintList = ColorStateList.valueOf(ContextCompat.getColor(this@MainActivity, R.color.heysure_primary))
                isChecked = settings.captureQuality == quality
            }
            ids[radio.id] = quality
            addView(radio)
        }
        setOnCheckedChangeListener { _, checkedId ->
            val selected = ids[checkedId] ?: return@setOnCheckedChangeListener
            if (settings.captureQuality == selected) return@setOnCheckedChangeListener
            settings.captureQuality = selected
            toast("已切换为${selected.label}画质")
        }
    }

    private fun permissionStep(
        number: String,
        title: String,
        description: String,
        onAuthorize: () -> Unit,
    ): StepViews {
        val badge = TextView(this).apply {
            text = number
            setTextColor(Color.WHITE)
            textSize = 14f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            gravity = android.view.Gravity.CENTER
            background = ContextCompat.getDrawable(this@MainActivity, R.drawable.badge_step)
            layoutParams = LinearLayout.LayoutParams(dp(36), dp(36)).apply {
                rightMargin = dp(12)
            }
        }
        val status = TextView(this).apply {
            textSize = 11f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.pending))
            setPadding(0, dp(4), 0, 0)
        }
        val button = dialogButton("授权", primary = true, onClick = onAuthorize).apply {
            layoutParams = LinearLayout.LayoutParams(dp(78), dp(44)).apply {
                leftMargin = dp(10)
            }
        }
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            background = ContextCompat.getDrawable(this@MainActivity, R.drawable.step_bg)
            setPadding(dp(12), dp(12), dp(10), dp(12))
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            ).apply { bottomMargin = dp(10) }

            addView(badge)
            addView(LinearLayout(this@MainActivity).apply {
                orientation = LinearLayout.VERTICAL
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                addView(TextView(this@MainActivity).apply {
                    text = title
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text))
                    textSize = 14f
                    typeface = android.graphics.Typeface.DEFAULT_BOLD
                })
                addView(TextView(this@MainActivity).apply {
                    text = description
                    setTextColor(ContextCompat.getColor(this@MainActivity, R.color.muted))
                    textSize = 11f
                    setLineSpacing(dp(2).toFloat(), 1f)
                    setPadding(0, dp(3), 0, 0)
                })
                addView(status)
            })
            addView(button)
        }
        return StepViews(container, badge, status, button, number)
    }

    private fun mcpGroupTitle(group: String, count: Int) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = android.view.Gravity.CENTER_VERTICAL
        setPadding(0, dp(12), 0, dp(6))
        addView(TextView(this@MainActivity).apply {
            text = group
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text))
            textSize = 13f
            typeface = android.graphics.Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
        addView(TextView(this@MainActivity).apply {
            text = "$count 个"
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.muted))
            textSize = 11f
        })
    }

    private fun mcpToolRow(tool: AndroidMcpTool) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        background = ContextCompat.getDrawable(this@MainActivity, R.drawable.row_bg)
        setPadding(dp(13), dp(11), dp(13), dp(11))
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { bottomMargin = dp(8) }

        addView(LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = android.view.Gravity.CENTER_VERTICAL
            addView(TextView(this@MainActivity).apply {
                text = tool.title
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.text))
                textSize = 13f
                typeface = android.graphics.Typeface.DEFAULT_BOLD
                layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
            })
            addView(TextView(this@MainActivity).apply {
                text = tool.name
                setTextColor(ContextCompat.getColor(this@MainActivity, R.color.muted))
                textSize = 10f
                typeface = android.graphics.Typeface.MONOSPACE
            })
        })
        addView(TextView(this@MainActivity).apply {
            text = tool.description
            setTextColor(ContextCompat.getColor(this@MainActivity, R.color.muted))
            textSize = 11f
            setPadding(0, dp(4), 0, 0)
        })
    }

    private fun makeAvatarCircular() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return
        val circularOutline = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                outline.setOval(0, 0, view.width, view.height)
            }
        }
        binding.userAvatarImage.outlineProvider = circularOutline
        binding.userAvatarImage.clipToOutline = true
        binding.userAvatarText.outlineProvider = circularOutline
        binding.userAvatarText.clipToOutline = true
    }

    private fun bindTapFeedback(view: View) {
        view.setOnTouchListener { v, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> v.animate()
                    .scaleX(0.97f)
                    .scaleY(0.97f)
                    .alpha(0.9f)
                    .setDuration(90)
                    .setInterpolator(DecelerateInterpolator())
                    .start()
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> v.animate()
                    .scaleX(1f)
                    .scaleY(1f)
                    .alpha(1f)
                    .setDuration(240)
                    .setInterpolator(OvershootInterpolator(1.6f))
                    .start()
            }
            false
        }
    }

    /** Fade + slide each child of a vertical container up in sequence. */
    private fun staggerReveal(container: LinearLayout, perChildDelay: Long = 70L) {
        for (i in 0 until container.childCount) {
            val child = container.getChildAt(i)
            child.alpha = 0f
            child.translationY = dp(12).toFloat()
            child.animate()
                .alpha(1f)
                .translationY(0f)
                .setStartDelay(i * perChildDelay)
                .setDuration(300)
                .setInterpolator(DecelerateInterpolator(1.6f))
                .start()
        }
    }

    private fun animateDialog(dialog: AlertDialog) {
        val decor = dialog.window?.decorView ?: return
        decor.alpha = 0f
        decor.translationY = dp(18).toFloat()
        AnimatorSet().apply {
            playTogether(
                ObjectAnimator.ofFloat(decor, View.ALPHA, 0f, 1f),
                ObjectAnimator.ofFloat(decor, View.TRANSLATION_Y, dp(18).toFloat(), 0f),
            )
            duration = 180
            interpolator = DecelerateInterpolator(1.5f)
            start()
        }
    }

    /** A springy scale-up, used when a status badge flips to "done". */
    private fun pop(view: View) {
        AnimatorSet().apply {
            playTogether(
                ObjectAnimator.ofFloat(view, View.SCALE_X, 0.5f, 1.18f, 1f),
                ObjectAnimator.ofFloat(view, View.SCALE_Y, 0.5f, 1.18f, 1f),
            )
            duration = 360
            interpolator = DecelerateInterpolator()
            start()
        }
    }

    private fun pulse(view: View) {
        AnimatorSet().apply {
            playTogether(
                ObjectAnimator.ofFloat(view, View.SCALE_X, 0.88f, 1f),
                ObjectAnimator.ofFloat(view, View.SCALE_Y, 0.88f, 1f),
                ObjectAnimator.ofFloat(view, View.ALPHA, 0.65f, 1f),
            )
            duration = 240
            interpolator = OvershootInterpolator(1.8f)
            start()
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private data class AndroidMcpTool(
        val group: String,
        val title: String,
        val name: String,
        val description: String,
    )

    /** References to a single authorization step so it can be recolored on refresh. */
    private class StepViews(
        val container: LinearLayout,
        val badge: TextView,
        val status: TextView,
        val button: AppCompatButton,
        val number: String,
        var done: Boolean = false,
    )

    private companion object {
        const val MAX_LOG_LINES = 120

        val ANDROID_MCP_TOOLS = listOf(
            AndroidMcpTool("触控操作", "点击", "touch.tap", "在指定屏幕坐标执行一次点击，用于按钮、列表项和输入框聚焦。"),
            AndroidMcpTool("触控操作", "长按", "touch.long_press", "在指定坐标保持按压，可用于唤出菜单、拖动起点或长按选择。"),
            AndroidMcpTool("触控操作", "滑动", "touch.swipe", "从起点滑动到终点，用于滚动列表、翻页、拖拽和手势导航。"),
            AndroidMcpTool("系统导航", "返回", "touch.back", "执行 Android 系统返回键，退出当前页面或关闭弹层。"),
            AndroidMcpTool("系统导航", "主页", "touch.home", "回到手机桌面，适合从任意应用恢复到起始状态。"),
            AndroidMcpTool("系统导航", "最近任务", "touch.recents", "打开最近任务列表，用于切换应用或查看后台窗口。"),
            AndroidMcpTool("输入工具", "文本输入", "input.text", "向当前获得焦点的输入框写入指定文本。"),
            AndroidMcpTool("屏幕感知", "屏幕截图", "screen.capture", "截取当前手机屏幕并返回图片，供 AI 判断界面状态。"),
            AndroidMcpTool("屏幕感知", "屏幕录制", "screen.record", "录制一段无音频屏幕视频，适合观察动态过程和加载变化。"),
        )
    }
}
