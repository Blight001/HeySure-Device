'use strict';

const fs = require('fs');
const path = require('path');
const { normalizePermissionOrigins } = require('./chromium-permission-origins');

function pushArg(args, condition, value) {
  if (condition) args.push(value);
}

function configuredExtensionPaths(profile) {
  const source = Array.isArray(profile.extensionPaths) ? profile.extensionPaths : [];
  return source.map((item) => path.resolve(String(item || ''))).filter((item) => fs.existsSync(item));
}

function buildChromiumProfileArgs(options, profile, bounds) {
  const args = [];
  pushArg(args, options.hostHwnd, `--hs-embed-parent-hwnd=${options.hostHwnd}`);
  pushArg(args, profile.proxyServer, `--proxy-server=${profile.proxyServer}`);
  pushArg(args, profile.proxyBypassList, `--proxy-bypass-list=${profile.proxyBypassList}`);
  pushArg(args, profile.locale, `--lang=${profile.locale}`);
  pushArg(args, profile.timezoneId, `--hs-timezone-id=${profile.timezoneId}`);
  pushArg(args, profile.userAgent, `--user-agent=${profile.userAgent}`);
  const width = Number(bounds.width);
  const height = Number(bounds.height);
  pushArg(args, width > 0 && height > 0, `--window-size=${Math.round(width)},${Math.round(height)}`);
  const extensions = configuredExtensionPaths(profile);
  pushArg(args, extensions.length > 0, `--load-extension=${extensions.join(',')}`);
  pushArg(args, profile.remoteDebuggingPipe === true, '--remote-debugging-pipe');
  pushArg(args, profile.restoreLastSession === true, '--restore-last-session');
  pushArg(args, profile.hideToolbar === true, '--hs-hide-toolbar');
  const origins = normalizePermissionOrigins(profile.autoGrantPermissionOrigins);
  pushArg(args, origins.length > 0, '--auto-grant-permissions');
  pushArg(args, origins.length > 0, `--auto-grant-permissions-origins=${origins.join(',')}`);
  return args;
}

module.exports = { buildChromiumProfileArgs };
