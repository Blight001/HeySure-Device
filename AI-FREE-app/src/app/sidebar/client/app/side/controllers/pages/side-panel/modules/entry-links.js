// 同步/连接：bindTutorialLink的具体业务逻辑。
function bindTutorialLink() {
  const tutorialLinks = [safeGetEl('tutorial-link'), safeGetEl('browser-settings-tutorial')].filter(Boolean);
  if (tutorialLinks.length === 0) return;
  const syncTutorialLink = (url) => {
    if (typeof setTutorialLinkHref === 'function') setTutorialLinkHref(url);
  };

// 获取/读取/解析：resolveTutorialUrl的具体业务逻辑。
  async function resolveTutorialUrl(tutorialLink) {
    try {
      const contentApi = window.aiFree && window.aiFree.content;
      if (contentApi && typeof contentApi.refreshTutorialUrl === 'function') {
        const refreshed = await contentApi.refreshTutorialUrl();
        const refreshedUrl = String(refreshed?.tutorialUrl || '').trim();
        if (refreshed?.ok === true && refreshedUrl) {
          syncTutorialLink(refreshedUrl);
          return refreshedUrl;
        }

        const latestUrl = await contentApi.getTutorialUrl();
        if (typeof latestUrl === 'string' && latestUrl.trim()) {
          syncTutorialLink(latestUrl);
          return String(latestUrl).trim();
        }
      }
    } catch (error) {
      console.error('[侧边栏] 获取教程链接失败:', error);
    }

    return String(tutorialLink.dataset.tutorialUrl || tutorialLink.getAttribute('href') || '').trim();
  }

  tutorialLinks.forEach((tutorialLink) => {
    if (tutorialLink.dataset.tutorialBound === '1') return;
    tutorialLink.dataset.tutorialBound = '1';
    tutorialLink.addEventListener('click', async (e) => {
      e.preventDefault();
      const currentHref = await resolveTutorialUrl(tutorialLink);

      if (currentHref) {
        window.aiFree.content.openTutorial(currentHref);
        return;
      }

      if (window.MessageModal && typeof window.MessageModal.showInfoMessage === 'function') {
        window.MessageModal.showInfoMessage('教程链接尚未同步，请稍后再试');
      }
    });
  });
}

// 同步/连接：bindSecondaryEntryButtons的具体业务逻辑。
function bindSecondaryEntryButtons() {
  const startBananaBtn = safeGetEl('start-banana-btn');
  if (startBananaBtn) {
    startBananaBtn.addEventListener('click', () => {
      window.MessageModal.showInfoMessage('「一键启动 BananaAI」 功能已经上线，如需请联系客服开通账号权限！');
    });
  }

}
