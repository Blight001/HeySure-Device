(() => {
  const params = new URLSearchParams(location.search);
  const explicitMode = params.get('dev');
  if (explicitMode === '1' || explicitMode === '0') {
    try { sessionStorage.setItem('ai-free.sidebar.dev-mode', explicitMode); } catch (_) {}
  }
  let enabled = explicitMode === '1';
  if (explicitMode !== '0' && explicitMode !== '1') {
    try { enabled = sessionStorage.getItem('ai-free.sidebar.dev-mode') === '1'; } catch (_) {}
  }
  document.documentElement.classList.toggle('development-mode', enabled);
  document.querySelectorAll('[data-dev-only]').forEach((element) => {
    element.hidden = !enabled;
  });
})();
