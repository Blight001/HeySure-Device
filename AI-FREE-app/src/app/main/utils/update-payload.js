function pickFirstPayloadValue(payload = {}, keys = []) {
  const sources = [
    payload,
    payload.data,
    payload.payload,
    payload.announcement,
    payload.update,
  ].filter((value) => value && typeof value === 'object');

  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return value;
      }
    }
  }
  return '';
}

function summarizeUpdatePayload(payload = {}) {
  return {
    type: payload?.type,
    message_type: payload?.message_type,
    messageType: payload?.messageType,
    version: pickFirstPayloadValue(payload, [
      'version',
      'latest_version',
      'latestVersion',
      'new_version',
      'newVersion',
      'target_version',
      'targetVersion',
      'app_version',
      'appVersion',
      'update_version',
      'updateVersion',
    ]),
    downloadUrl: pickFirstPayloadValue(payload, [
      'downloadUrl',
      'download_url',
      'package_url',
      'packageUrl',
      'url',
      'link',
      'file_url',
      'fileUrl',
      'update_link',
      'updateLink',
    ]),
    openUrl: pickFirstPayloadValue(payload, [
      'openUrl',
      'open_url',
      'subscription_url',
      'subscriptionUrl',
      'landing_url',
      'landingUrl',
      'page_url',
      'pageUrl',
      'download_page_url',
      'downloadPageUrl',
      'redirect_url',
      'redirectUrl',
    ]),
  };
}

module.exports = {
  summarizeUpdatePayload,
};
