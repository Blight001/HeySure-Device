(function initControlPanel() {
  const root = document.documentElement;
  const themeToggleBtn = document.getElementById('theme-toggle-btn');
  const themeStorageKey = 'ai-free.control-panel.theme';

  function getSavedTheme() {
    try {
      const value = localStorage.getItem(themeStorageKey);
      return value === 'light' || value === 'gold' ? value : 'dark';
    } catch (_) {
      return 'dark';
    }
  }

  function syncAppTheme(theme) {
    try {
      if (typeof window.aiFree?.ui?.emitAppThemeChanged === 'function') {
        window.aiFree.ui.emitAppThemeChanged( theme);
      }
    } catch (_) {}
  }

  function applyTheme(theme, options = {}) {
    const nextTheme = theme === 'light' || theme === 'gold' ? theme : 'dark';
    const isLight = nextTheme === 'light';

    if (root) {
      root.classList.toggle('theme-light', isLight);
      root.classList.toggle('theme-gold', nextTheme === 'gold');
      root.dataset.theme = nextTheme;
    }

    if (themeToggleBtn) {
      themeToggleBtn.title = isLight ? '切换到深色模式' : '切换到白色模式';
      themeToggleBtn.setAttribute('aria-label', isLight ? '切换到深色模式' : '切换到白色模式');
      themeToggleBtn.setAttribute('aria-pressed', String(isLight));
    }

    try {
      localStorage.setItem(themeStorageKey, nextTheme);
    } catch (_) {}

    if (options.broadcast !== false) {
      syncAppTheme(nextTheme);
    }
  }

  function toggleTheme() {
    const currentTheme = root?.dataset?.theme || getSavedTheme();
    applyTheme(currentTheme === 'light' ? 'dark' : 'light');
  }

  function bindEvents() {
    if (themeToggleBtn) {
      themeToggleBtn.addEventListener('click', toggleTheme);
    }

    if (typeof window.aiFree?.ui?.onAppThemeChanged === 'function') {
      window.aiFree.ui.onAppThemeChanged((theme) => {
        applyTheme(theme, { broadcast: false });
      });
    }
  }

  applyTheme(getSavedTheme());
  bindEvents();
})();
