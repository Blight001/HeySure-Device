// 渲染进程控制器共享工具
// 这里尽量保持无状态，供各页面脚本复用

(function initControllerUtils() {
  const existing = window.RendererControllerUtils || {};

  // 按 id 从指定根节点查找元素，方便页面脚本统一取 DOM。
  function getEl(id, root = document) {
    if (!root || typeof root.getElementById !== 'function') {
      return null;
    }
    return root.getElementById(id);
  }

  // 将任意值转成可比较的去空白字符串。
  function normalizeText(value) {
    return String(value ?? '').trim();
  }

  // 对文本做 HTML 转义，避免直接拼接造成 XSS。
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text ?? '');
    return div.innerHTML;
  }

  // 把日期值格式化成中文本地时间；无效日期则原样返回。
  function formatDateTimeCN(value) {
    const text = normalizeText(value);
    if (!text) return '';

    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
      return text;
    }

    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // 将剩余秒数换算成“剩余 X 天/小时/分钟”的展示文案。
  function formatRemainingValidity(secondsValue) {
    const seconds = Number(secondsValue);
    if (!Number.isFinite(seconds)) return '';

    const totalSeconds = Math.max(Math.round(seconds), 0);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (days > 0) {
      return hours > 0 ? `剩余 ${days} 天 ${hours} 小时` : `剩余 ${days} 天`;
    }
    if (hours > 0) {
      return minutes > 0 ? `剩余 ${hours} 小时 ${minutes} 分钟` : `剩余 ${hours} 小时`;
    }
    return `剩余 ${Math.max(minutes, 1)} 分钟`;
  }

  // 尝试把输入转为有限数字，失败时返回 null。
  function toFiniteNumber(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
  }

  // 优先用统一弹窗展示用户错误，没有弹窗时退回 console.warn。
  function showUserError(message, fallback = '操作失败') {
    const text = normalizeText(message) || fallback;
    if (window.MessageModal && typeof window.MessageModal.showErrorMessage === 'function') {
      window.MessageModal.showErrorMessage(text);
      return;
    }
    console.warn(text);
  }

  function resolveBusyButtonArguments(arg2, arg3, arg4) {
    const legacy = Array.isArray(arg2) || arg2 == null || typeof arg2 !== 'function';
    const fn = legacy ? arg3 : arg2;
    const candidateOptions = legacy ? arg4 : arg3;
    const options = candidateOptions && typeof candidateOptions === 'object' ? candidateOptions : {};
    const candidateCompanions = legacy ? arg2 : options.companions;
    const companions = Array.isArray(candidateCompanions) ? candidateCompanions.filter(Boolean) : [];
    return { fn, options, companions };
  }

  // 给按钮套上“忙碌中”状态，执行异步任务期间禁用关联按钮并自动恢复。
  function withBusyButton(btn, arg2, arg3, arg4) {
    if (!btn || btn.dataset.busy === '1') return null;

    const { fn, options, companions } = resolveBusyButtonArguments(arg2, arg3, arg4);
    const allButtons = [btn, ...companions];
    const originalText = btn.textContent;
    const loadingText = normalizeText(options.loadingText || btn.dataset.loadingText) || originalText;

    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.textContent = loadingText;

    allButtons.slice(1).forEach((el) => {
      el.dataset.prevDisabled = el.disabled ? '1' : '0';
      el.disabled = true;
    });

    const restore = () => {
      btn.dataset.busy = '0';
      btn.disabled = false;
      if (!options.preserveTextAfterResolve) {
        btn.textContent = originalText;
      }
      if (typeof options.onRestore === 'function') {
        options.onRestore(btn);
      }

      allButtons.slice(1).forEach((el) => {
        if (el.dataset.prevDisabled === '0') {
          el.disabled = false;
        }
        delete el.dataset.prevDisabled;
      });
    };

    const task = Promise.resolve().then(() => {
      if (typeof fn !== 'function') {
        throw new Error('缺少可执行任务');
      }
      return fn();
    });
    const handled = typeof options.onError === 'function'
      ? task.catch((error) => {
          options.onError(error);
          throw error;
        })
      : task;

    return handled.finally(restore);
  }

  window.RendererControllerUtils = Object.assign({}, existing, {
    escapeHtml,
    formatDateTimeCN,
    formatRemainingValidity,
    getEl,
    normalizeText,
    showUserError,
    toFiniteNumber,
    withBusyButton,
  });
}());
