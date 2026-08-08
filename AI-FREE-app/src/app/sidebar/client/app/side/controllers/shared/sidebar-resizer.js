(async function initSidebarResizer() {
  const setSidebarWidth = window.aiFree?.ui?.setSidebarWidth;
  if (typeof setSidebarWidth !== 'function') return;

  let initialState;
  try {
    initialState = await setSidebarWidth({});
  } catch (_) {
    return;
  }
  if (initialState?.ok !== true) return;

  const handle = document.createElement('div');
  handle.className = 'sidebar-resize-handle';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-label', '调整侧边栏宽度');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-valuenow', String(initialState.width || window.innerWidth));
  handle.tabIndex = 0;
  handle.title = '拖拽调整侧边栏宽度';
  document.body.appendChild(handle);

  let pointerId = null;
  let startX = 0;
  let startWidth = 0;
  let pendingWidth = 0;
  let animationFrame = 0;

  async function applyWidth(width) {
    try {
      const result = await setSidebarWidth({ width });
      if (result?.ok === true) handle.setAttribute('aria-valuenow', String(result.width));
    } catch (_) {}
  }

  function flushWidth() {
    animationFrame = 0;
    const width = pendingWidth;
    pendingWidth = 0;
    if (width > 0) void applyWidth(width);
  }

  function scheduleWidth(width) {
    pendingWidth = width;
    if (!animationFrame) animationFrame = window.requestAnimationFrame(flushWidth);
  }

  function finishResize(event) {
    if (pointerId === null || (event?.pointerId !== undefined && event.pointerId !== pointerId)) return;
    const finishedPointerId = pointerId;
    pointerId = null;
    document.body.classList.remove('sidebar-resizing');
    if (animationFrame) window.cancelAnimationFrame(animationFrame);
    flushWidth();
    try { handle.releasePointerCapture(finishedPointerId); } catch (_) {}
  }

  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    pointerId = event.pointerId;
    startX = event.screenX;
    startWidth = window.innerWidth;
    document.body.classList.add('sidebar-resizing');
    handle.setPointerCapture(pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointerId) return;
    scheduleWidth(startWidth + startX - event.screenX);
  });
  handle.addEventListener('pointerup', finishResize);
  handle.addEventListener('pointercancel', finishResize);
  handle.addEventListener('lostpointercapture', finishResize);
  handle.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    void applyWidth(window.innerWidth + (event.key === 'ArrowLeft' ? 16 : -16));
  });
})();
