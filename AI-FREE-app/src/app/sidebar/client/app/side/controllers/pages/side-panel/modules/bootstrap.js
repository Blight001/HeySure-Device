// 侧边栏入口编排

let sidePanelInteractionsInitialized = false;

// 创建/初始化：initSidePanelInteractions的具体业务逻辑。
function initSidePanelInteractions() {
  if (sidePanelInteractionsInitialized) {
    return;
  }
  sidePanelInteractionsInitialized = true;
  initSidePanelCore();
  initSidePanelBindings();
  initSidePanelRuntime();
}

document.addEventListener('DOMContentLoaded', initSidePanelInteractions);
