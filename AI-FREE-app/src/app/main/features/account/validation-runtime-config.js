'use strict';

const { firstNonNull, firstText } = require('../../../shared/safe-values');

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => firstText(item).trim()).filter(Boolean);
}

function normalizeWoolPlatform(item) {
  const source = item && typeof item === 'object' ? item : {};
  const rawSubUrls = firstNonNull(source.subUrls, source.sub_urls, []);
  const subUrls = Array.isArray(rawSubUrls)
    ? rawSubUrls.map((url) => firstText(url).trim()).filter(Boolean)
    : [];
  const targetUrl = firstText(firstNonNull(source.targetUrl, source.target_url)).trim() || subUrls[0] || '';
  return {
    name: firstText(firstNonNull(source.name, source.platform, source.platform_name)).trim(),
    platform: firstText(firstNonNull(source.platform, source.name, source.platform_name)).trim(),
    targetUrl,
    subUrls,
    launchOnly: source.launchOnly === true || source.launch_only === true,
    permissionGranted: source.permissionGranted === true || source.permission_granted === true,
    quota: source.quota && typeof source.quota === 'object' ? { ...source.quota } : null,
  };
}

function normalizeWoolPlatforms(value) {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeWoolPlatform).filter((item) => item.name && item.targetUrl);
}

function normalizeValidationRuntimeConfig(source = {}) {
  const sourceRecord = /** @type {Record<string, any>} */ (source);
  const input = sourceRecord && typeof sourceRecord === 'object'
    ? { ...(sourceRecord.result && typeof sourceRecord.result === 'object' ? sourceRecord.result : {}), ...sourceRecord }
    : {};
  const allowedRaw = firstNonNull(input.allowedPlatforms, input.allowed_platforms, []);
  const allowed = normalizeStringList(allowedRaw);
  const platformName = firstText(firstNonNull(input.platformName, input.platform_name, allowed[0])).trim();
  const allowedPlatforms = allowed.length ? allowed : (platformName ? [platformName] : []);
  const woolPlatforms = normalizeWoolPlatforms(firstNonNull(input.woolPlatforms, input.wool_platforms, []));
  const serverBase = firstText(...[
    input.address_HTTP, input.addressHttp, input.address_http, input.client_address,
    input.clientAddress, input.serverBase, input.server_base, input.address,
  ].map((value) => firstText(value).trim()));
  return {
    platformName,
    platform_name: platformName,
    allowedPlatforms,
    allowed_platforms: allowedPlatforms,
    woolPlatforms,
    wool_platforms: woolPlatforms,
    targetUrl: firstText(firstNonNull(input.targetUrl, input.target_url)).trim(),
    tutorialUrl: firstText(firstNonNull(input.tutorialUrl, input.tutorial_url)).trim(),
    serverBase,
    server_base: serverBase,
    address_HTTP: serverBase,
    addressHttp: serverBase,
  };
}

module.exports = { normalizeValidationRuntimeConfig };
