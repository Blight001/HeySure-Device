function createModalHTML() {
  // 检查是否已经存在弹窗
  if (document.getElementById('server-message-modal')) {
    return;
  }

  // 创建弹窗HTML结构
  const modalHTML = `
    <div id="server-message-modal" class="modal-overlay" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <div class="modal-header-content">
            <div class="modal-icon" id="server-message-icon">ℹ️</div>
            <h3 id="server-message-title">系统消息</h3>
          </div>
          <button id="close-message-modal" class="modal-close-btn">&times;</button>
        </div>
        <div class="modal-body">
          <div id="server-message-content"></div>
          <div class="modal-actions">
            <button id="acknowledge-message" class="btn-blue">我知道了</button>
          </div>
        </div>
      </div>
    </div>
  `;

  // 将弹窗插入到body末尾
  document.body.insertAdjacentHTML('beforeend', modalHTML);
}

/**
 * 显示服务器消息弹窗
 * @param {Object} messageData - 消息数据对象
 * @param {string} messageData.message - 消息内容
 * @param {string} messageData.type - 消息类型：'info'(默认), 'success', 'warning', 'error', 'announcement'
 * @param {string} messageData.message_type - 公告消息的类型（当type为'announcement'时使用）
 */
function showServerMessage(messageData) {
  // 处理不同类型的服务器消息
  let type = messageData.type || 'info';
  let message = messageData.message || '收到服务器消息';
  const messageType = messageModalGetServerMessageType(messageData);
  const messageText = messageModalGetServerMessageText(messageData) || message;

  if (messageModalIsUpdateLikeMessage(messageData)) {
    return;
  }

  // 如果是公告消息，使用 message_type 作为显示类型
  if (type === 'announcement') {
    if (messageType === 'update' || messageType === 'upgrade') {
      return;
    }
    if (messageModalIsShutdownAnnouncement(messageData) || messageType === 'shutdown' || messageText.includes('软件暂时无法使用') || messageText.includes('停用')) {
      return;
    }
    // 服务器公告类型映射到前端显示类型
    const announcementTypeMap = {
      'normal': 'info',
      'warning': 'warning',
      'error': 'error',
      'maintenance': 'maintenance', // maintenance使用专用样式
      'success': 'success'
    };

    type = announcementTypeMap[messageType] || 'info';
  }

  const priority = MESSAGE_PRIORITY[type] || MESSAGE_PRIORITY.info;
  enqueueMessage({
    kind: 'info',
    type,
    title: messageData.title || undefined,
    message,
    priority
  });
}

/**
 * 隐藏消息弹窗
 */
function hideServerMessageModal() {
  const modal = messageModalGetEl('server-message-modal');
  if (modal) {
    modal.style.display = 'none';
    const modalContent = modal.querySelector('.modal-content');
    if (modalContent) {
      modalContent.classList.remove('modal-update-toast-content');
    }
    // 当手动隐藏弹窗时，结束当前消息并继续下一个
    finishCurrentMessage();
  }
}

/**
 * 显示自定义消息弹窗
 * @param {string} message - 要显示的消息内容
 * @param {string} type - 消息类型：'info'(默认), 'success', 'warning', 'error'
 */
function showMessage(message, type = 'info') {
  showServerMessage({ message: message, type: type });
}

// 启动/打开/显示：showUpdateMessage的具体业务逻辑。
function showUpdateMessage(messageData = {}) {
  const payload = messageData && typeof messageData === 'object' ? messageData : {};
  const versionKey = messageModalGetUpdateVersion(payload);
  if (versionKey && versionKey === lastShownUpdateVersion) {
    return;
  }
  if (versionKey) {
    lastShownUpdateVersion = versionKey;
  }
  enqueueMessage({
    kind: 'update',
    type: 'update',
    title: payload.title || '发现新版本',
    message: payload.content || payload.message || `发现新版本 v${versionKey}`.trim(),
    priority: MESSAGE_PRIORITY.confirm + 5,
    payload,
  });
}

// 启动/打开/显示：showLoadingMessage的具体业务逻辑。
function showLoadingMessage(message = '处理中，请稍等...') {
  pendingLoadingMessage = String(message || '处理中，请稍等...');
  processQueue();
}

// 停止/关闭/清理：hideLoadingMessage的具体业务逻辑。
function hideLoadingMessage() {
  const modal = messageModalGetEl('server-message-modal');
  const closeBtn = messageModalGetEl('close-message-modal');
  const actions = messageModalGetEl('server-message-modal')?.querySelector('.modal-actions');
  if (!modal) return;

  if (modal.dataset.loading === '1') {
    modal.style.display = 'none';
    modal.dataset.loading = '0';
    if (closeBtn) closeBtn.style.display = '';
    if (actions) {
      actions.innerHTML = '<button id="acknowledge-message" class="btn-blue">我知道了</button>';
      const ack = messageModalGetEl('acknowledge-message');
      if (ack) {
        ack.addEventListener('click', () => {
          hideServerMessageModal();
        });
      }
    }
  }

  loadingModalVisible = false;
  pendingLoadingMessage = '';
  setTimeout(processQueue, 50);
}

/**
 * 显示确认对话框
 * @param {string} message - 要显示的消息内容
 * @param {Function} onConfirm - 用户点击确认时的回调函数
 * @param {Function} onCancel - 用户点击取消时的回调函数
 * @param {string} type - 消息类型：'info'(默认), 'success', 'warning', 'error'
 * @param {Object} options - 可选标题、图标和按钮文字
 */
