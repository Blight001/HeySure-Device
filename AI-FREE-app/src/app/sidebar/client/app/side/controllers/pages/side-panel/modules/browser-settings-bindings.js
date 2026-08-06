(function initBrowserSettingsBindingsModule() {
  function bindElement(deps, id, eventName, handler) {
    const target = deps.el(id);
    if (target) target.addEventListener(eventName, handler);
  }

  function updateRandomTarget(deps, button) {
    if (button.dataset.randomTarget === 'device-name') {
      deps.setValue('device-name', `DESKTOP-${Math.random().toString(36).slice(2,9).toUpperCase()}`);
      return;
    }
    const address = Array.from({length:6},()=>Math.floor(Math.random()*256).toString(16).padStart(2,'0'))
      .join('-').toUpperCase();
    deps.setValue('mac-address', address);
  }

  function subscribeBrowserRefresh(deps, methodName) {
    const browser = window.aiFree && window.aiFree.browser;
    const subscribe = browser && browser[methodName];
    if (typeof subscribe === 'function') subscribe(deps.scheduleBrowserHistoryRefresh);
  }

  function bindFormEvents(deps) {
    document.querySelectorAll('.segmented').forEach((group) => group.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (button) deps.setSegment(group.dataset.field, button.dataset.value);
    }));
    ['timezone-by-ip','geolocation-by-ip']
      .forEach((id) => bindElement(deps, id, 'change', deps.syncConditionalFields));
    bindElement(deps, 'ai-free-settings-form', 'submit', deps.saveSettings);
    bindElement(deps, 'randomize-ai-free-settings', 'click', deps.randomIdentity);
    bindElement(deps, 'randomize-user-agent', 'click', deps.randomIdentity);
    bindElement(deps, 'reset-ai-free-settings', 'click', () => void deps.resetSettings());
    bindElement(deps, 'test-ai-free-proxy', 'click', () => void deps.testProxy());
    bindElement(deps, 'extract-ai-free-proxy', 'click', () => void deps.extractProxy());
    bindElement(deps, 'refresh-browser-history', 'click', () => void deps.refreshBrowserHistory({keepSelection:true}));
    bindElement(deps, 'open-default-browser-settings', 'click', () => void deps.openDefaultBrowserSettings());
    bindElement(deps, 'delete-browser-record', 'click', () => {
      const item = deps.getBrowserHistory().find((entry) => entry.id === deps.getSelectedHistoryId());
      if (item) void deps.deleteBrowserHistory(item, { closeDialogOnSuccess: true });
    });
  }

  function bindGlobalEvents(deps) {
    document.querySelectorAll('[data-browser-settings-close]')
      .forEach((element) => element.addEventListener('click', deps.closeBrowserSettingsDialog));
    document.querySelectorAll('[data-random-target]')
      .forEach((button) => button.addEventListener('click', () => updateRandomTarget(deps, button)));
    const panelTab = document.querySelector('[data-tab="ai-free-settings-panel"]');
    if (panelTab) panelTab.addEventListener('click', () => void deps.loadSettings());
    ['onTabsUpdated', 'onHistoryChanged', 'onAccountListUpdated']
      .forEach((methodName) => subscribeBrowserRefresh(deps, methodName));
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const dialog = deps.el('browser-settings-dialog');
      if (dialog && !dialog.hidden) deps.closeBrowserSettingsDialog();
    });
  }

  window.bindAiFreeBrowserSettingsEvents = (deps) => {
    bindFormEvents(deps);
    bindGlobalEvents(deps);
  };
}());
