(function initBrowserSettingsFormModule() {
  function section(source, key) {
    const result = source && source[key];
    return result && typeof result === 'object' ? result : {};
  }

  function fillVersions(deps, runtimeInfo, settings) {
    const major = Number(String(runtimeInfo.chromiumVersion || '').split('.')[0]) || 147;
    const browserSelect = deps.el('browser-version');
    if (browserSelect && browserSelect.options.length <= 1) {
      Array.from(new Set([major + 2, major + 1, major, major - 1, major - 2, 147]
        .filter((item) => item > 80)))
        .sort((left, right) => right - left)
        .forEach((item) => browserSelect.add(new Option(String(item), String(item))));
    }
    const kernelSelect = deps.el('kernel-version');
    if (kernelSelect && runtimeInfo.chromiumVersion && kernelSelect.options.length <= 1) {
      kernelSelect.add(new Option(`当前内核 ${runtimeInfo.chromiumVersion}`, runtimeInfo.chromiumVersion));
    }
    deps.setValue('browser-version', settings.browserVersion || '');
    deps.setValue('kernel-version', settings.kernelVersion || 'auto');
  }

  function fillBrowserSettingsForm(deps, settings, runtimeInfo = {}) {
    const current = JSON.parse(JSON.stringify(settings || {}));
    deps.segmentPaths.forEach((path) => deps.setSegment(path, deps.readPath(current, path)));
    fillVersions(deps, runtimeInfo, current);
    const proxy = section(current, 'proxy');
    const homepage = section(current, 'homepage');
    const ua = section(current, 'ua');
    const secChUa = section(current, 'secChUa');
    const language = section(current, 'language');
    const timezone = section(current, 'timezone');
    const geolocation = section(current, 'geolocation');
    const resolution = section(current, 'resolution');
    const webgl = section(current, 'webglMetadata');
    const deviceName = section(current, 'deviceName');
    const macAddress = section(current, 'macAddress');
    const protection = section(current, 'portScanProtection');
    const launchArgs = section(current, 'launchArgs');
    deps.setValue('proxy-protocol', proxy.protocol); deps.setValue('proxy-host', proxy.host); deps.setValue('proxy-port', proxy.port);
    deps.setValue('proxy-username', proxy.username); deps.setValue('proxy-password', proxy.password); deps.setValue('proxy-api-url', proxy.apiUrl);
    deps.setValue('browser-cookies', current.cookies || '[]'); deps.setValue('homepage-url', homepage.url);
    deps.setValue('browser-user-agent', ua.value); deps.setValue('sec-ch-ua-brands', JSON.stringify(Array.isArray(secChUa.brands) ? secChUa.brands : [], null, 2));
    deps.setValue('browser-locale', language.value);
    deps.setChecked('timezone-by-ip', timezone.mode === 'ip'); deps.setValue('browser-timezone', timezone.value);
    deps.setChecked('geolocation-by-ip', geolocation.mode === 'ip'); deps.setValue('geo-longitude', geolocation.longitude); deps.setValue('geo-latitude', geolocation.latitude); deps.setValue('geo-accuracy', geolocation.accuracy);
    deps.setValue('resolution-width', resolution.width); deps.setValue('resolution-height', resolution.height);
    deps.setValue('browser-webgl-vendor', webgl.vendor); deps.setValue('browser-webgl-renderer', webgl.renderer);
    deps.setValue('browser-cpu', current.cpu); deps.setValue('browser-memory', current.memory); deps.setValue('device-name', deviceName.value); deps.setValue('mac-address', macAddress.value);
    deps.setChecked('do-not-track', current.doNotTrack); deps.setValue('port-scan-allow-list', (Array.isArray(protection.allowList) ? protection.allowList : []).join(',')); deps.setChecked('hardware-acceleration', current.hardwareAcceleration);
    deps.setValue('low-spec-mode', current.lowSpecMode || 'auto');
    deps.setValue('launch-args', launchArgs.value);
    deps.syncConditionalFields();
    return current;
  }

  window.fillAiFreeBrowserSettingsForm = fillBrowserSettingsForm;
}());
