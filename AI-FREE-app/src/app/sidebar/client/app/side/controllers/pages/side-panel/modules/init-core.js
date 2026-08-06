let sidePanelCoreInitialized = false;

// 创建/初始化：initSidePanelCore的具体业务逻辑。
function initSidePanelCore() {
  if (sidePanelCoreInitialized) {
    return;
  }
  sidePanelCoreInitialized = true;

  if (window.MessageModal && typeof window.MessageModal.initServerMessageListener === 'function') {
    window.MessageModal.initServerMessageListener();
  }

  const isDevMode = !!(
    window.env
    && (
      String(window.env.APP_DEV_CONSOLE) === '1'
      || /^(dev|development)$/i.test(String(window.env.NODE_ENV || ''))
    )
  );

  if (!isDevMode) {
    document.querySelectorAll('.debug-only').forEach((button) => {
      button.style.display = 'none';
    });
  }
}
