let sidePanelRuntimeInitialized = false;

// 创建/初始化：initSidePanelRuntime的具体业务逻辑。
function initSidePanelRuntime() {
  if (sidePanelRuntimeInitialized) {
    return;
  }
  sidePanelRuntimeInitialized = true;

  if (!document.documentElement.classList.contains('browser-settings-page')) return;

  loadInitialConnectionState();
  loadInitialRuntimeValues();
  syncLatencyButtonState();
}
