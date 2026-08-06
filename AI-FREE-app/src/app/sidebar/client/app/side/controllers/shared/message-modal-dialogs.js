function showConfirmDialog(message, onConfirm, onCancel, type = 'info', options = {}) {
  // 将确认对话加入队列，按确认优先级处理
  const priority = MESSAGE_PRIORITY.confirm || (MESSAGE_PRIORITY.info + 10);
  enqueueMessage({
    kind: 'confirm',
    type: type === 'info' ? 'confirm' : type,
    title: String(options.title || '').trim() || undefined,
    icon: String(options.icon || '').trim() || undefined,
    confirmText: String(options.confirmText || '').trim() || undefined,
    cancelText: String(options.cancelText || '').trim() || undefined,
    message,
    priority,
    onConfirm,
    onCancel
  });
}

// 侧边栏统一承载浏览器数据清理确认，避免使用系统原生弹窗。
function bindBrowserDataClearConfirmListener() {
  if (typeof window.aiFree?.browser?.onDataClearConfirmRequested !== 'function') return;
  if (window.__browserDataClearConfirmListenerBound) return;
  window.__browserDataClearConfirmListenerBound = true;

  window.aiFree.browser.onDataClearConfirmRequested((payload = {}) => {
    const requestId = String(payload?.requestId || '').trim();
    const browserTitle = String(payload?.title || '当前浏览器').trim() || '当前浏览器';
    if (!requestId) return;
    const respond = async (confirmed) => {
      try {
        const result = await window.aiFree.browser.resolveDataClearConfirm( {
          requestId,
          confirmed: confirmed === true,
        });
        if (confirmed !== true) return;
        if (!result?.ok) {
          showErrorMessage(result?.message || result?.error || '清空浏览器数据失败');
          return;
        }
        showSuccessMessage('浏览器数据已清空');
      } catch (error) {
        if (confirmed === true) showErrorMessage(error?.message || '清空浏览器数据失败');
      }
    };
    showConfirmDialog(
      `确认清空"${browserTitle}"的浏览器数据?\n\nCookie、缓存、浏览历史、本地存储和页面会话将被删除，浏览器会自动重新打开。窗口配置和已下载文件会保留。`,
      () => respond(true),
      () => respond(false),
      'warning',
      {
        title: '清空浏览器数据',
        confirmText: '确认清空',
        cancelText: '取消',
      },
    );
  });
}

// 启动/打开/显示：显示软件内置文本输入弹窗。
function showPromptDialog(message, initialValue, onConfirm, onCancel, options = {}) {
  enqueueMessage({
    kind: 'prompt',
    type: options.type || 'confirm',
    title: options.title || '请输入',
    message,
    initialValue,
    placeholder: options.placeholder || '',
    maxLength: options.maxLength || 80,
    required: options.required !== false,
    confirmText: options.confirmText || '保存',
    cancelText: options.cancelText || '取消',
    priority: MESSAGE_PRIORITY.confirm,
    onConfirm,
    onCancel,
  });
}

/**
 * 初始化弹窗事件绑定
 * 这个函数需要在 DOM 加载完成后调用
 * 由于弹窗是动态创建的，这个函数会在首次显示弹窗时自动调用
 */
function initMessageModal() {
  // 确保弹窗HTML已创建
  createModalHTML();

  const modal = messageModalGetEl('server-message-modal');
  const closeBtn = messageModalGetEl('close-message-modal');
  const acknowledgeBtn = messageModalGetEl('acknowledge-message');

  if (closeBtn) {
    closeBtn.addEventListener('click', hideServerMessageModal);
  }

  if (acknowledgeBtn) {
    acknowledgeBtn.addEventListener('click', hideServerMessageModal);
  }

  // 点击遮罩层关闭弹窗
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (modal.dataset.loading === '1') return;
      if (e.target === modal) {
        hideServerMessageModal();
      }
    });
  }

  // ESC键关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (modal && modal.dataset.loading === '1') return;
    if (e.key === 'Escape' && modal && modal.style.display !== 'none') {
      hideServerMessageModal();
    }
  });
}

// 标记弹窗是否已初始化
let isModalInitialized = false;
let lastServerMessageFingerprint = '';

function getServerMessageFingerprint(messageData, messageType, messageText) {
  const announcementId = messageData && messageData.announcement_id != null ? messageData.announcement_id : '-';
  return {
    announcementId,
    fingerprint: JSON.stringify([
      String(announcementId), String(messageData.type || ''), String(messageType || ''), String(messageText || '').trim(),
    ]),
  };
}

function forwardAccountCookieMessage(messageData) {
  if (messageData.type !== 'account_cookie_auto_process' || !messageData.data || !messageData.data.autoProcess) return false;
  console.log('[消息弹窗] 检测到账号cookie自动处理消息，转发到侧边栏处理');
  if (window.MessageModal) window.MessageModal.showInfoMessage(messageData.message || '正在自动处理服务器推送的账号...');
  const uiApi = window.aiFree && window.aiFree.ui;
  if (uiApi && typeof uiApi.emitServerAccountCookieReceived === 'function') {
    console.log('[消息弹窗] 正在发送账号 Cookie 数据到侧边栏');
    uiApi.emitServerAccountCookieReceived(messageData.data);
  } else console.error('[消息弹窗] 账号 Cookie 转发能力不可用');
  return true;
}

function handleServerModalMessage(messageData) {
  const messageType = messageModalGetServerMessageType(messageData);
  const messageText = messageModalGetServerMessageText(messageData);
  const identity = getServerMessageFingerprint(messageData, messageType, messageText);
  if (identity.fingerprint === lastServerMessageFingerprint) {
    console.log(`[公告] 跳过连续重复消息: #${identity.announcementId}`);
    return;
  }
  lastServerMessageFingerprint = identity.fingerprint;
  const logText = String(messageText || '').replace(/\s+/g, ' ').slice(0, 160);
  console.log(`[公告] #${identity.announcementId} ${messageType || 'normal'}: ${logText}`);
  if (forwardAccountCookieMessage(messageData) || messageModalIsUpdateLikeMessage(messageData)) return;
  if (messageData.type === 'app-update-notice') return showUpdateMessage(messageData);
  const shutdown = messageModalIsShutdownAnnouncement(messageData)
    || (messageData.type === 'announcement' && (messageType === 'shutdown' || messageText.includes('软件暂时无法使用') || messageText.includes('停用')));
  if (shutdown) {
    console.log('[消息弹窗] 检测到停用公告，跳过弹窗显示');
    return;
  }
  showServerMessage(messageData);
}

/**
 * 确保弹窗已初始化
 * 这个函数会在显示弹窗前自动调用
 */
function ensureModalInitialized() {
  if (!isModalInitialized) {
    initMessageModal();
    isModalInitialized = true;
  }
}

/**
 * 监听服务器消息
 * 这个函数需要在 window.aiFree 可用时调用
 */
function initServerMessageListener() {
  bindBrowserDataClearConfirmListener();
  if (window.__messageModalServerListenerBound) {
    return;
  }

  if (typeof window.aiFree?.updates?.onNotice === 'function') {
    window.__messageModalServerListenerBound = true;
    window.aiFree.updates.onNotice((messageData) => {
      showUpdateMessage(messageData);
    });
    window.aiFree.ui.onServerMessage(handleServerModalMessage);
  }
}

// 便捷方法：显示不同类型的消息
function showInfoMessage(message) {
  showMessage(message, 'info');
}

// 启动/打开/显示：showSuccessMessage的具体业务逻辑。
function showSuccessMessage(message) {
  showMessage(message, 'success');
}

// 启动/打开/显示：showWarningMessage的具体业务逻辑。
function showWarningMessage(message) {
  showMessage(message, 'warning');
}

// 启动/打开/显示：showErrorMessage的具体业务逻辑。
function showErrorMessage(message) {
  showMessage(message, 'error');
}

// 导出模块接口
window.MessageModal = {
  showServerMessage,
  hideServerMessageModal,
  showMessage,
  showUpdateMessage,
  showInfoMessage,
  showSuccessMessage,
  showWarningMessage,
  showErrorMessage,
  showLoadingMessage,
  hideLoadingMessage,
  showConfirmDialog,
  bindBrowserDataClearConfirmListener,
  showPromptDialog,
  initMessageModal,
  initServerMessageListener,
  createModalHTML,
  ensureModalInitialized
};
