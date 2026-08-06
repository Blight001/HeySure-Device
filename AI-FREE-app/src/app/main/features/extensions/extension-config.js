'use strict';

const STORE_FIELD = 'extensionManager';
const BUILTIN_TRANSLATE_ID = 'builtin-transform';
const BUILTIN_REMOVE_WATERMARK_ID = 'builtin-remove-watermark';
const COMPAT_CACHE_DIR_NAME = 'extension-runtime-compat';
// Chromium reserves extension files/directories beginning with "_". Keep the
// software-generated shim name ordinary so the original plugin remains untouched.
const COMPAT_SHIM_FILE = 'electron-extension-compat.js';
const COMPAT_SHIM_MARKER = '__AI_FREE_ELECTRON_EXTENSION_COMPAT__';
const COMPAT_CACHE_SCHEMA = 5;
const EXTENSION_REFRESH_INTERVAL_MS = 10000;
const EXTENSION_REFRESH_DEBOUNCE_MS = 300;
const ELECTRON_UNRECOGNIZED_EXTENSION_PERMISSIONS = new Set([
  'notifications',
  'contextMenus',
  'debugger',
  'cookies',
  'downloads',
  'webNavigation',
]);

function sanitizeManifestPermissionsForElectron(sourceManifest) {
  const manifest = sourceManifest && typeof sourceManifest === 'object'
    ? { ...sourceManifest }
    : {};
  const removedPermissions = [];

  for (const field of ['permissions', 'optional_permissions']) {
    if (!Array.isArray(manifest[field])) continue;
    manifest[field] = manifest[field].filter((permission) => {
      const normalized = String(permission || '').trim();
      if (!ELECTRON_UNRECOGNIZED_EXTENSION_PERMISSIONS.has(normalized)) return true;
      removedPermissions.push(normalized);
      return false;
    });
  }

  return { manifest, removedPermissions: Array.from(new Set(removedPermissions)) };
}

module.exports = {
  BUILTIN_REMOVE_WATERMARK_ID,
  BUILTIN_TRANSLATE_ID,
  COMPAT_CACHE_DIR_NAME,
  COMPAT_CACHE_SCHEMA,
  COMPAT_SHIM_FILE,
  COMPAT_SHIM_MARKER,
  EXTENSION_REFRESH_DEBOUNCE_MS,
  EXTENSION_REFRESH_INTERVAL_MS,
  STORE_FIELD,
  sanitizeManifestPermissionsForElectron,
};
