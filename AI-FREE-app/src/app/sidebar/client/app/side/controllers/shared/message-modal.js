/**
 * 消息弹窗模块
 * 提供统一的弹窗显示功能，支持服务器消息和自定义消息
 */

const MessageModalUtils = window.RendererControllerUtils || {};
const messageModalGetEl = MessageModalUtils.getEl || ((id) => document.getElementById(id));
const messageModalEscapeHtml = MessageModalUtils.escapeHtml || ((text) => {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
});
const MessageModalServerUtils = window.AiFreeServerMessageUtils || {};
const messageModalGetServerMessageText = MessageModalServerUtils.getServerMessageText || (() => '');
const messageModalGetServerMessageType = MessageModalServerUtils.getServerMessageType || (() => '');
const messageModalGetUpdateVersion = MessageModalServerUtils.getUpdateVersion || (() => '');
const messageModalIsShutdownAnnouncement = MessageModalServerUtils.isShutdownAnnouncement || (() => false);
const messageModalIsUpdateLikeMessage = MessageModalServerUtils.isUpdateLikeMessage || (() => false);

// 消息队列与处理（支持优先级）
const MESSAGE_PRIORITY = { error: 40, warning: 30, maintenance: 35, success: 20, info: 10, confirm: 50 };
let messageQueue = [];
let isDisplayingMessage = false;
let currentMessageItem = null;
let loadingModalVisible = false;
let pendingLoadingMessage = '';
let lastShownUpdateVersion = '';

const MESSAGE_TYPE_CONFIG = {
  info: { icon: 'ℹ️', title: '系统消息', className: 'modal-info', sound: { freq1: 800, freq2: 600 } },
  success: { icon: '✅', title: '操作成功', className: 'modal-success', sound: { freq1: 523, freq2: 659 } },
  warning: { icon: '⚠️', title: '警告提示', className: 'modal-warning', sound: { freq1: 440, freq2: 554 } },
  maintenance: { icon: '🔧', title: '系统维护', className: 'modal-maintenance', sound: { freq1: 330, freq2: 262 } },
  error: { icon: '❌', title: '错误提示', className: 'modal-error', sound: { freq1: 220, freq2: 165 } },
  update: { icon: '⬆️', title: '发现新版本', className: 'modal-info', sound: { freq1: 784, freq2: 988 } },
  confirm: { icon: '❓', title: '请确认', className: 'modal-info', sound: { freq1: 800, freq2: 600 } }
};

// 队列处理：enqueueMessage的具体业务逻辑。
function enqueueMessage(item) {
  // item: { type, message, priority, kind('info'|'confirm'), resolve callbacks... }
  item._seq = _seqCounter++;
  messageQueue.push(item);
  // 保持队列按优先级降序，然后按入队顺序
  messageQueue.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a._seq - b._seq;
  });
  processQueue();
}

let _seqCounter = 0;
// 处理/分发：processQueue的具体业务逻辑。
function processQueue() {
  if (loadingModalVisible) return;
  if (isDisplayingMessage) return;
  if (!messageQueue.length) {
    if (pendingLoadingMessage) {
      displayLoadingMessageItem(pendingLoadingMessage);
      pendingLoadingMessage = '';
    }
    return;
  }
  const item = messageQueue.shift();
  isDisplayingMessage = true;
  currentMessageItem = item;
  displayMessageItem(item);
}

// 处理：finishCurrentMessage的具体业务逻辑。
function finishCurrentMessage() {
  isDisplayingMessage = false;
  currentMessageItem = null;
  // next tick to allow DOM cleanup
  setTimeout(processQueue, 50);
}

function getMessageModalElements() {
  const modal = messageModalGetEl('server-message-modal');
  return {
    modal,
    content: messageModalGetEl('server-message-content'),
    title: messageModalGetEl('server-message-title'),
    icon: messageModalGetEl('server-message-icon'),
    actions: modal?.querySelector('.modal-actions')
  };
}

function hasMessageModalElements(elements) {
  return Boolean(elements.modal && elements.content && elements.title && elements.icon && elements.actions);
}

function createPromptInput(content, item) {
  content.replaceChildren();
  const promptMessage = document.createElement('div');
  promptMessage.className = 'modal-prompt-message';
  promptMessage.textContent = item.message || '';
  const promptInput = document.createElement('input');
  promptInput.className = 'modal-prompt-input';
  promptInput.type = 'text';
  promptInput.value = String(item.initialValue || '');
  promptInput.placeholder = String(item.placeholder || '');
  promptInput.maxLength = Math.max(1, Number(item.maxLength) || 80);
  promptInput.autocomplete = 'off';
  content.append(promptMessage, promptInput);
  return promptInput;
}

function renderMessageContent(elements, item, config) {
  elements.content.textContent = item.message || '';
  elements.title.textContent = item.title || config.title;
  elements.icon.textContent = item.icon || config.icon;
  if (item.kind === 'prompt') return createPromptInput(elements.content, item);
  return null;
}

function applyMessageModalStyle(modal, config) {
  const modalContent = modal.querySelector('.modal-content');
  if (modalContent) modalContent.className = `modal-content ${config.className}`;
  modal.classList.remove('modal-update-toast');
  modalContent?.classList.remove('modal-update-toast-content');
}

function renderUpdateActions(actions, item) {
  actions.innerHTML = `
    <button id="update-now-btn" class="btn-blue">确认下载</button>
    <button id="update-later-btn" class="btn-gray" style="margin-left: 10px;">稍后再说</button>
  `;
  messageModalGetEl('update-now-btn')?.addEventListener('click', () => startAppUpdate(item.payload || {}));
  messageModalGetEl('update-later-btn')?.addEventListener('click', hideServerMessageModal);
}

function startAppUpdate(payload) {
  try {
    if (typeof window.aiFree?.updates?.start !== 'function') {
      console.warn('[消息弹窗] start-app-update 不可用');
      hideServerMessageModal();
      return;
    }
    hideServerMessageModal();
    window.aiFree.updates.start(payload).catch(logAppUpdateFailure);
  } catch (error) {
    logAppUpdateFailure(error);
  }
}

function logAppUpdateFailure(error) {
  console.warn('[消息弹窗] 启动更新失败:', error?.message || error);
}

function renderConfirmActions(actions, item) {
  actions.innerHTML = `
    <button id="confirm-dialog-btn" class="btn-blue">${messageModalEscapeHtml(item.confirmText || '确定')}</button>
    <button id="cancel-dialog-btn" class="btn-gray" style="margin-left: 10px;">${messageModalEscapeHtml(item.cancelText || '取消')}</button>
  `;
  const confirmBtn = messageModalGetEl('confirm-dialog-btn');
  const cancelBtn = messageModalGetEl('cancel-dialog-btn');
  confirmBtn?.addEventListener('click', () => confirmMessageItem(item, confirmBtn, cancelBtn));
  cancelBtn?.addEventListener('click', () => cancelMessageItem(item));
}

async function confirmMessageItem(item, confirmBtn, cancelBtn) {
  if (confirmBtn.disabled) return;
  confirmBtn.disabled = true;
  if (cancelBtn) cancelBtn.disabled = true;
  try {
    if (item.onConfirm) await item.onConfirm();
  } catch (error) {
    console.error('Confirm callback error:', error);
  }
  hideServerMessageModal();
}

function cancelMessageItem(item) {
  try {
    if (item.onCancel) item.onCancel();
  } catch (_) {}
  hideServerMessageModal();
}

function renderPromptActions(actions, item, promptInput) {
  actions.innerHTML = `
    <button id="prompt-dialog-confirm-btn" class="btn-blue">${messageModalEscapeHtml(item.confirmText || '保存')}</button>
    <button id="prompt-dialog-cancel-btn" class="btn-gray" style="margin-left: 10px;">${messageModalEscapeHtml(item.cancelText || '取消')}</button>
  `;
  const confirmBtn = messageModalGetEl('prompt-dialog-confirm-btn');
  const submitPrompt = () => submitPromptItem(item, promptInput, confirmBtn);
  confirmBtn?.addEventListener('click', () => void submitPrompt());
  messageModalGetEl('prompt-dialog-cancel-btn')?.addEventListener('click', () => cancelMessageItem(item));
  bindPromptInput(promptInput, submitPrompt);
  focusPromptInput(promptInput);
}

async function submitPromptItem(item, promptInput, confirmBtn) {
  const value = String(promptInput?.value || '').trim();
  if (item.required !== false && !value) {
    promptInput?.classList.add('is-invalid');
    promptInput?.focus();
    return;
  }
  if (confirmBtn) confirmBtn.disabled = true;
  try {
    if (item.onConfirm) await item.onConfirm(value);
    hideServerMessageModal();
  } catch (error) {
    console.error('Prompt callback error:', error);
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

function bindPromptInput(promptInput, submitPrompt) {
  promptInput?.addEventListener('input', () => promptInput.classList.remove('is-invalid'));
  promptInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    void submitPrompt();
  });
}

function focusPromptInput(promptInput) {
  const focus = () => requestAnimationFrame(() => {
    promptInput?.focus();
    promptInput?.select();
  });
  if (typeof window.aiFree?.ui?.focusSidebarInput === 'function') {
    void window.aiFree.ui.focusSidebarInput().finally(focus);
    return;
  }
  focus();
}

function renderAcknowledgeAction(actions) {
  actions.innerHTML = '<button id="acknowledge-message" class="btn-blue">我知道了</button>';
  messageModalGetEl('acknowledge-message')?.addEventListener('click', hideServerMessageModal);
}

function renderMessageActions(actions, item, promptInput) {
  if (item.kind === 'update') return renderUpdateActions(actions, item);
  if (item.kind === 'confirm') return renderConfirmActions(actions, item);
  if (item.kind === 'prompt') return renderPromptActions(actions, item, promptInput);
  return renderAcknowledgeAction(actions);
}

function playMessageSound(sound) {
  try {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.frequency.setValueAtTime(sound.freq1, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(sound.freq2, audioContext.currentTime + 0.1);
    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);
    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.3);
  } catch (error) {
    console.warn('无法播放提示音:', error.message);
  }
}

// 将队列项渲染到 DOM 的函数
function displayMessageItem(item) {
  createModalHTML();
  ensureModalInitialized();

  const elements = getMessageModalElements();
  if (!hasMessageModalElements(elements)) {
    console.error('消息弹窗元素未找到');
    finishCurrentMessage();
    return;
  }

  const config = MESSAGE_TYPE_CONFIG[item.type || 'info'] || MESSAGE_TYPE_CONFIG.info;
  const promptInput = renderMessageContent(elements, item, config);
  applyMessageModalStyle(elements.modal, config);
  renderMessageActions(elements.actions, item, promptInput);
  elements.modal.style.display = 'flex';
  playMessageSound(config.sound);
}

// 启动/打开/显示：displayLoadingMessageItem的具体业务逻辑。
function displayLoadingMessageItem(message) {
  createModalHTML();
  ensureModalInitialized();

  const modal = messageModalGetEl('server-message-modal');
  const content = messageModalGetEl('server-message-content');
  const title = messageModalGetEl('server-message-title');
  const icon = messageModalGetEl('server-message-icon');
  const closeBtn = messageModalGetEl('close-message-modal');
  const actions = messageModalGetEl('server-message-modal')?.querySelector('.modal-actions');
  const modalContent = modal?.querySelector('.modal-content');

  if (!modal || !content || !title || !icon || !actions || !modalContent) {
    return;
  }

  loadingModalVisible = true;
  isDisplayingMessage = false;
  currentMessageItem = null;

  content.textContent = message || '处理中，请稍等...';
  title.textContent = '系统消息';
  icon.textContent = '⏳';
  modalContent.className = 'modal-content modal-info';
  actions.innerHTML = '';
  if (closeBtn) closeBtn.style.display = 'none';
  modal.dataset.loading = '1';
  modal.style.display = 'flex';
}

/**
 * 创建弹窗HTML结构
 * 这个函数会动态创建弹窗的HTML元素并插入到body中
 */
