(function initLogoAssets() {
  'use strict';

  const SOURCE_LOGO_PATH = '../../assets/logo.ico';
  const PACKAGED_LOGO_PATH = '../../../../resource/logo.ico';

  function isPackagedSidebarUrl(url = window.location.href) {
    try {
      return decodeURIComponent(new URL(url).pathname)
        .split('/')
        .some((segment) => segment.toLowerCase() === 'app.asar');
    } catch (_) {
      return false;
    }
  }

  function resolveLogoUrl(url = window.location.href) {
    const relativePath = isPackagedSidebarUrl(url)
      ? PACKAGED_LOGO_PATH
      : SOURCE_LOGO_PATH;
    return new URL(relativePath, url).href;
  }

  function applyLogoSources(root = document) {
    const logoUrl = resolveLogoUrl();
    root.querySelectorAll?.('img[data-app-logo]').forEach((image) => {
      if (image.getAttribute('src') !== logoUrl) image.setAttribute('src', logoUrl);
    });
    return logoUrl;
  }

  window.aiFreeLogoAssets = Object.freeze({
    apply: applyLogoSources,
    resolve: resolveLogoUrl,
    url: resolveLogoUrl(),
  });

  applyLogoSources();
})();
