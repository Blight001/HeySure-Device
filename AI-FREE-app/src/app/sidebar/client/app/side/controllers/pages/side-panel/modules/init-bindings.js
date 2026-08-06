let sidePanelBindingsInitialized = false;

// 创建/初始化：initSidePanelBindings的具体业务逻辑。
function initSidePanelBindings() {
  if (sidePanelBindingsInitialized) {
    return;
  }
  sidePanelBindingsInitialized = true;

  const browserSettingsPage = document.documentElement.classList.contains('browser-settings-page');
  if (browserSettingsPage) {
    initSidebarUiListeners();
    bindTutorialLink();
    bindClashMiniControls();
    bindRuntimeValueListeners();
    return;
  }

  initAnnouncementListener();
  initSidebarUiListeners();
  initSidebarAnimationListener();
  initSidebarInputRouting();
  bindLicenseValidationControls();
  bindServerAccountCookieListener();
  bindSidebarAccountAuth();
  bindTutorialLink();
  bindSecondaryEntryButtons();
}
