// 负责“打开即梦网页”按钮的事件绑定与调用主进程逻辑
// 环境：Electron 渲染进程（需在 preload 暴露 window.aiFree.content.openDreamPage）

(() => {
  const DreamOpenerUtils = window.RendererControllerUtils || {};
  const getEl = DreamOpenerUtils.getEl || ((id) => document.getElementById(id));
  const withBusyButton = DreamOpenerUtils.withBusyButton || ((btn, fn, options = {}) => {
    if (!btn || btn.dataset.busy === '1') return null;
    const companions = Array.isArray(options.companions) ? options.companions.filter(Boolean) : [];
    const originalText = btn.textContent;
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.textContent = options.loadingText || btn.dataset.loadingText || '处理中...';
    companions.forEach((el) => {
      el.dataset.prevDisabled = el.disabled ? '1' : '0';
      el.disabled = true;
    });
    return Promise.resolve()
      .then(fn)
      .catch((err) => {
// 处理：msg的具体业务逻辑。
        const msg = (err && err.message) ? err.message : String(err);
        if (window.MessageModal) {
          window.MessageModal.showErrorMessage('操作失败：' + msg);
        } else {
          console.error(msg);
        }
        throw err;
      })
      .finally(() => {
        btn.dataset.busy = '0';
        btn.disabled = false;
        btn.textContent = originalText;
        options.onRestore?.(btn);
        companions.forEach((el) => {
          const prev = el.dataset.prevDisabled === '1';
          el.disabled = prev;
          delete el.dataset.prevDisabled;
        });
      });
  });

  async function readDreamLaunchCredentials() {
    const keyInput = getEl('session-token');
    const deviceInput = getEl('device-id');
    const local = {
      key: String((keyInput && keyInput.value) || '').trim(),
      deviceId: String((deviceInput && deviceInput.value) || '').trim(),
    };
    if (local.key) return local;
    const result = await window.aiFree?.license?.getUserCredentials?.().catch(() => null);
    return {
      key: String(result?.credentials?.key || '').trim(),
      deviceId: String(result?.credentials?.deviceId || '').trim(),
    };
  }

  function resolveDreamLaunchTarget(clickedButton, container) {
    const platform = String(clickedButton.dataset.platform || '').trim();
    const buttonCount = container.querySelectorAll('.open-wool-platform-btn').length;
    const legacyTargetUrl = buttonCount === 1 ? String(window.DREAM_URL || '').trim() : '';
    let subUrls = [];
    try {
      const parsed = JSON.parse(clickedButton.dataset.subUrls || '[]');
      if (Array.isArray(parsed)) subUrls = parsed.map((url) => String(url || '').trim()).filter(Boolean);
    } catch (_) {}
    return {
      platform,
      targetUrl: String(clickedButton.dataset.targetUrl || legacyTargetUrl).trim(),
      subUrls,
      launchOnly: clickedButton.dataset.launchOnly === 'true',
    };
  }

  function logDreamOpenResult(result) {
    const data = result || {};
    console.log('[前端] 网页打开请求成功:', JSON.stringify({
      tabId: data.tabId,
      tabIds: data.tabIds || [],
      openedUrls: data.openedUrls || [],
      openedWindowCount: data.openedWindowCount || 0,
      subTabsResult: data.subTabsResult || null,
    }));
  }

  async function openDreamPlatform(clickedButton, container) {
    const { key, deviceId } = await readDreamLaunchCredentials();
    if (!key) throw new Error('请先登录账号');
    const contentApi = window.aiFree && window.aiFree.content;
    if (!contentApi || typeof contentApi.openDreamPage !== 'function') {
      throw new Error('Electron 桥接未就绪（缺少 openDreamPage），请在 preload/main 中实现后再试');
    }
    const { platform, targetUrl, subUrls, launchOnly } = resolveDreamLaunchTarget(clickedButton, container);
    if (!platform || !targetUrl) throw new Error('羊毛平台配置不完整，请联系管理员');
    console.log(`[前端] 用户点击"一键启动 ${platform}"按钮`);
    console.log('[前端] 平台启动网址:', JSON.stringify({ targetUrl, subUrls, launchOnly }));
    console.log('[前端] 发送账号授权请求，设备ID:', deviceId);
    const result = await contentApi.openDreamPage({ key, deviceId, platform, targetUrl, subUrls, launchOnly });
    if (!result || result.ok !== true) {
      const message = result && (result.message || result.error) || '打开失败';
      console.error('[前端] 打开网页失败:', message);
      throw new Error(message);
    }
    logDreamOpenResult(result);
  }

// 监听/绑定：attachOpenDreamPage的具体业务逻辑。
  function attachOpenDreamPage() {
    const container = getEl('wool-platform-buttons');
    if (!container || container.dataset.bound === '1') return;

    container.addEventListener('click', async (e) => {
      const clickedButton = e.target && e.target.closest ? e.target.closest('.open-wool-platform-btn') : null;
      if (!clickedButton || !container.contains(clickedButton) || clickedButton.disabled) return;
      if (await window.redirectToSidebarAccountLogin?.()) return;
      const task = withBusyButton(clickedButton, () => openDreamPlatform(clickedButton, container), {
        companions: [
          document.getElementById('VPN-switch'),
        ],
        onError: (err) => {
// 处理：msg的具体业务逻辑。
          const msg = (err && err.message) ? err.message : String(err);
          if (window.MessageModal) {
            window.MessageModal.showErrorMessage('操作失败：' + msg);
          } else {
            console.error(msg);
          }
        },
        onRestore: (button) => {
          if (typeof applyWoolPlatformButtonLabel === 'function') {
            applyWoolPlatformButtonLabel(button);
          }
        },
      }).catch(() => {});
      if (task && typeof task.catch === 'function') {
        task.catch(() => {});
      }
    }, false);
    container.dataset.bound = '1';
  }

  // 由于本脚本在 body 尾部引入，DOM 已可用；这里直接绑定，另加一层兜底
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachOpenDreamPage);
  } else {
    attachOpenDreamPage();
  }
})();
