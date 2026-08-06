(() => {
  function setVisible(tabs = []) {
    const home = document.getElementById('browser-empty-state');
    if (!home) return;
    const activeTab = Array.isArray(tabs) ? tabs.find((tab) => tab?.isActive) : null;
    const status = String(activeTab?.runtimeStatus || '').trim().toLowerCase();
    home.hidden = status === 'ready' || status === 'hidden';
  }

  function bind() {}

  window.AppShellHome = Object.freeze({ bind, setVisible });
})();
