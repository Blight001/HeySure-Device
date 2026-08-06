function createAiBrowserParticleLayer(seedValue) {
  const layer = document.createElement('span');
  layer.className = 'ai-browser-particle-layer';
  layer.setAttribute('aria-hidden', 'true');

  let seed = 2166136261;
  for (const char of String(seedValue || 'browser')) {
    seed ^= char.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }
  const random = () => {
    seed += 0x6D2B79F5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  for (let index = 0; index < 10; index += 1) {
    const particle = document.createElement('i');
    const isAiText = (index + 1) % 3 === 0;
    const size = isAiText
      ? 8 + Math.floor(random() * 4)
      : 3 + Math.floor(random() * 4);
    const duration = 2.5 + (random() * 4.2);
    const maxTop = Math.max(3, 26 - size);
    if (isAiText) {
      particle.className = 'ai-text-particle';
      particle.textContent = 'AI';
      particle.style.setProperty('--particle-font-size', `${size}px`);
    }
    particle.style.setProperty('--particle-size', `${size}px`);
    particle.style.setProperty('--particle-top', `${2 + Math.floor(random() * maxTop)}px`);
    particle.style.setProperty('--particle-duration', `${duration.toFixed(2)}s`);
    particle.style.setProperty('--particle-delay', `${(-random() * duration).toFixed(2)}s`);
    particle.style.setProperty('--particle-opacity', (0.28 + (random() * 0.46)).toFixed(2));
    particle.style.setProperty('--particle-drift-mid', `${Math.round((random() - 0.5) * 9)}px`);
    particle.style.setProperty('--particle-drift-end', `${Math.round((random() - 0.5) * 7)}px`);
    particle.style.setProperty('--particle-radius', random() > 0.72 ? '2px' : '0px');
    layer.appendChild(particle);
  }
  return layer;
}

// 创建/初始化：createTabElement的具体业务逻辑。
async function restartTabRuntime(tabElement, runtimeBadge) {
  if (typeof ShellApi.restartBrowserRuntime !== 'function' || runtimeBadge.disabled) return;
  runtimeBadge.disabled = true;
  runtimeBadge.textContent = '…';
  try {
    const result = await ShellApi.restartBrowserRuntime({ profileId: tabElement.dataset.id });
    if (!result?.ok) throw new Error(result?.message || '重启失败');
  } catch (error) {
    showControllerError('重启 AI-FREE 环境失败', error);
    runtimeBadge.disabled = false;
    runtimeBadge.textContent = '重启';
  }
}

function createRuntimeRecoveryButton(tabElement) {
  const runtimeBadge = document.createElement('button');
  runtimeBadge.type = 'button';
  runtimeBadge.className = 'tab-runtime-badge crashed';
  runtimeBadge.textContent = '重启';
  runtimeBadge.title = 'AI-FREE 浏览器已退出，点击重新启动';
  runtimeBadge.addEventListener('click', (event) => {
    event.stopPropagation();
    void restartTabRuntime(tabElement, runtimeBadge);
  });
  return runtimeBadge;
}

function initializeTabElement(tab) {
  const element = document.createElement('div');
  element.className = 'tab';
  if (tab.isActive) element.classList.add('active');
  element.dataset.id = tab.id;
  element.draggable = true;
  element.title = buildTabTooltip(tab);
  element.dataset.runtimeType = String(tab?.runtimeType || 'chromium');
  element.dataset.runtimeStatus = String(tab?.runtimeStatus || 'ready');
  element.dataset.browserHistoryId = String(tab?.browserHistoryId || '');
  element.classList.toggle('ai-browser-connected', isAiConnectedBrowserProfile(tab.id));
  element.classList.toggle('network-magic', tab?.networkMagicEnabled === true);
  return element;
}

function appendTabContent(tabElement, tab) {
  tabElement.appendChild(createAiBrowserParticleLayer(tab.id));
  const titleSpan = document.createElement('span');
  titleSpan.className = 'tab-title';
  titleSpan.textContent = tab.title;
  titleSpan.title = buildTabTooltip(tab);
  tabElement.appendChild(titleSpan);
  if (tab?.runtimeType === 'chromium' && tab?.runtimeStatus === 'crashed') {
    tabElement.appendChild(createRuntimeRecoveryButton(tabElement));
  }
  const closeBtn = document.createElement('span');
  closeBtn.className = 'tab-close';
  closeBtn.textContent = 'x';
  closeBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    ShellApi.closeTab(tab.id);
  });
  closeBtn.addEventListener('auxclick', (event) => event.stopPropagation());
  tabElement.appendChild(closeBtn);
}

function bindTabPointerEvents(tabElement, tab) {
  tabElement.addEventListener('click', () => ShellApi.switchTab(tab.id));
  tabElement.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    beginTabRename(tabElement);
  });
  tabElement.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void showTabContextMenu(tab, event);
  });
  tabElement.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    event.preventDefault();
    event.stopPropagation();
    ShellApi.closeTab(tab.id);
  });
}

function bindTabDragEvents(tabElement, tab) {
  tabElement.addEventListener('dragstart', (event) => startTabDrag(event, tabElement, tab.id));
  tabElement.addEventListener('dragend', finishTabDrag);
  tabElement.addEventListener('dragover', (event) => updateTabDragOver(event, tabElement, tab.id));
  tabElement.addEventListener('dragleave', () => leaveTabDrag(tabElement, tab.id));
  tabElement.addEventListener('drop', (event) => dropTab(event, tabElement, tab.id));
}

function startTabDrag(event, tabElement, tabId) {
  draggedTabId = tabId;
  tabElement.classList.add('dragging');
  try {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tabId);
  } catch (_) {}
}

function finishTabDrag() {
  draggedTabId = null;
  clearDragIndicators();
}

function updateTabDragOver(event, tabElement, tabId) {
  if (!draggedTabId || draggedTabId === tabId) return;
  event.preventDefault();
  try { event.dataTransfer.dropEffect = 'move'; } catch (_) {}
  const position = getDropPosition(event, tabElement);
  if (dragHoverTabId !== tabId || dragHoverPosition !== position) updateDragHoverState(tabElement, position);
}

function leaveTabDrag(tabElement, tabId) {
  if (dragHoverTabId !== tabId) return;
  tabElement.classList.remove('drop-before', 'drop-after');
  dragHoverTabId = null;
  dragHoverPosition = null;
}

function dropTab(event, tabElement, tabId) {
  event.preventDefault();
  const sourceTabId = draggedTabId || event.dataTransfer?.getData('text/plain');
  if (!sourceTabId || sourceTabId === tabId) return clearDragIndicators();
  const position = getDropPosition(event, tabElement);
  ShellApi.reorderTab({ tabId: sourceTabId, targetTabId: tabId, position });
  clearDragIndicators();
}

function createTabElement(tab) {
  const tabElement = initializeTabElement(tab);
  appendTabContent(tabElement, tab);
  bindTabPointerEvents(tabElement, tab);
  bindTabDragEvents(tabElement, tab);
  return tabElement;
}

// 同步/连接：syncTabElement的具体业务逻辑。
function syncTabElement(tabElement, tab) {
  const titleSpan = tabElement.querySelector('.tab-title');
  if (titleSpan) {
    if (titleSpan.textContent !== tab.title) {
      titleSpan.textContent = tab.title;
    }
    titleSpan.title = buildTabTooltip(tab);
  }
  tabElement.title = buildTabTooltip(tab);
  tabElement.dataset.browserHistoryId = String(tab?.browserHistoryId || '');
  tabElement.dataset.runtimeStatus = String(tab?.runtimeStatus || 'starting');
  tabElement.classList.toggle(
    'ai-browser-connected',
    isAiConnectedBrowserProfile(tab.id),
  );
  tabElement.classList.toggle('network-magic', tab?.networkMagicEnabled === true);
  const runtimeBadge = tabElement.querySelector('.tab-runtime-badge');
  const crashed = tab?.runtimeType === 'chromium' && tab?.runtimeStatus === 'crashed';
  if (runtimeBadge && !crashed) {
    runtimeBadge.remove();
  } else if (!runtimeBadge && crashed) {
    const recoveryButton = createRuntimeRecoveryButton(tabElement);
    tabElement.insertBefore(recoveryButton, tabElement.querySelector('.tab-close'));
  }
  tabElement.classList.toggle('active', !!tab.isActive);
}
