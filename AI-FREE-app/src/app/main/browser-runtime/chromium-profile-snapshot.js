'use strict';

function profileText(value) { return String(value ?? '').trim(); }

function snapshotAppliedChromiumProfile(profile = {}, launchArgs = []) {
  const actualArgs = Array.isArray(launchArgs) ? launchArgs.map(profileText) : [];
  const extensionArg = actualArgs.find((item) => item.startsWith('--load-extension=')) ?? '';
  const loadedExtensions = extensionArg
    ? extensionArg.slice('--load-extension='.length).split(',').map((item) => item.trim()).filter(Boolean)
    : [];
  return {
    locale: profileText(profile.locale),
    acceptLanguage: profileText(profile.acceptLanguage),
    timezoneId: profileText(profile.timezoneId),
    userAgent: profileText(profile.userAgent),
    proxyServer: profileText(profile.proxyServer),
    proxyBypassList: profileText(profile.proxyBypassList),
    hardwareAcceleration: !actualArgs.includes('--disable-gpu'),
    extensionCount: loadedExtensions.length,
    browserSettings: profile.browserSettingsSnapshot && typeof profile.browserSettingsSnapshot === 'object'
      ? JSON.parse(JSON.stringify(profile.browserSettingsSnapshot))
      : null,
    browserEnvironment: profile.browserEnvironment && typeof profile.browserEnvironment === 'object'
      ? { ...profile.browserEnvironment }
      : null,
  };
}

module.exports = { snapshotAppliedChromiumProfile };
