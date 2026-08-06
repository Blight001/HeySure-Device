// 侧栏页签切换（渲染进程 DOM-only）
// 将原 side.html 中的内联脚本抽离

document.addEventListener('DOMContentLoaded', () => {
  const tabs = document.querySelectorAll('.tab-button');
  const panels = document.querySelectorAll('.panel');
  const dedicatedBrowserSettingsPage = document.documentElement.classList.contains('browser-settings-page');
  let woolPlatformRefreshInFlight = null;

  const refreshWoolPlatformsFromServer = async () => {
    if (woolPlatformRefreshInFlight) return woolPlatformRefreshInFlight;
    woolPlatformRefreshInFlight = (async () => {
      try {
        const response = await window.aiFree?.content.refreshWoolPlatforms?.();
        if (response?.ok && typeof renderWoolPlatformButtons === 'function') {
          renderWoolPlatformButtons(
            Array.isArray(response.woolPlatforms) ? response.woolPlatforms : [],
          );
        } else if (response?.authenticated === false && typeof renderWoolPlatformButtons === 'function') {
          renderWoolPlatformButtons([]);
        } else if (response?.message) {
          console.warn('[侧边栏] 刷新羊毛平台失败:', response.message);
        }
        return response;
      } catch (error) {
        console.warn('[侧边栏] 刷新羊毛平台失败:', error?.message || error);
        return null;
      } finally {
        woolPlatformRefreshInFlight = null;
      }
    })();
    return woolPlatformRefreshInFlight;
  };

  if (dedicatedBrowserSettingsPage) {
    document.getElementById('ai-free-settings-panel')?.classList.add('active');
    const createButton = document.getElementById('browser-settings-create-browser');
    createButton?.addEventListener('click', async () => {
      if (createButton.disabled) return;
      createButton.disabled = true;
      try {
        const result = await window.aiFree?.shell?.createIndependentBrowser?.({ name: '新建窗口' });
        if (!result?.ok) throw new Error(result?.error || '新建浏览器失败');
      } catch (error) {
        window.MessageModal?.showErrorMessage?.(error?.message || String(error));
        createButton.disabled = false;
      }
    });
    void refreshWoolPlatformsFromServer();
    return;
  }

  if (!tabs.length || !panels.length) return;

  const activateTab = (tab) => {
    if (!tab || tab.getAttribute('aria-disabled') === 'true') return false;
    const panelId = tab.getAttribute('data-tab');
    const panel = document.getElementById(panelId);
    if (!panel) return false;
    tabs.forEach((item) => item.classList.remove('active'));
    panels.forEach((item) => item.classList.remove('active'));
    tab.classList.add('active');
    panel.classList.add('active');
    // 每次进入（包括重复点击）浏览器配置栏目都向服务器重新取一次用户的平台权限，
    // 不依赖进入前所在栏目，避免管理端授权变化后仍显示旧缓存。
    if (panelId === 'ai-free-settings-panel') {
      void refreshWoolPlatformsFromServer();
    }
    return true;
  };

  tabs.forEach((tab) => tab.addEventListener('click', () => activateTab(tab)));
  window.activateSidebarPanel = (panelId) => activateTab(
    document.querySelector(`.tab-button[data-tab="${String(panelId || '')}"]`),
  );
});

