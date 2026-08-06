(function initAiFreeServerMessageUtils(root, factory) {
  const api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.AiFreeServerMessageUtils = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createServerMessageUtils() {
  function getServerMessageType(messageData = {}) {
    const candidates = [
      messageData.message_type, messageData.messageType,
      messageData.data?.message_type, messageData.data?.messageType,
      messageData.announcement?.message_type, messageData.announcement?.messageType,
      messageData.payload?.message_type, messageData.payload?.messageType,
    ];
    return String(candidates.find((value) => value != null && value !== '') ?? '').toLowerCase();
  }

  function getServerMessageText(messageData = {}) {
    return String(
      messageData.message
      || messageData.content
      || messageData.data?.message
      || messageData.data?.content
      || messageData.announcement?.message
      || messageData.announcement?.content
      || ''
    );
  }

  function getUpdateVersion(messageData = {}) {
    const fields = ['version', 'latest_version', 'latestVersion', 'targetVersion',
      'target_version', 'update_version', 'updateVersion'];
    const sources = [messageData, messageData.raw].filter((value) => value && typeof value === 'object');
    for (const source of sources) {
      for (const field of fields) {
        const value = String(source[field] || '').trim();
        if (value) return value;
      }
    }
    return '';
  }

  function isUpdateLikeMessage(messageData = {}) {
    const type = String(messageData.type || '').toLowerCase();
    const messageType = getServerMessageType(messageData);
    const hasVersion = Boolean(getUpdateVersion(messageData));

    return (
      type === 'app_update'
      || type === 'update'
      || type === 'software_update'
      || type === 'upgrade'
      || messageType === 'app_update'
      || messageType === 'update'
      || messageType === 'software_update'
      || messageType === 'upgrade'
      || (messageType === 'success' && hasVersion)
    );
  }

  function isShutdownAnnouncement(messageData = {}) {
    const messageType = getServerMessageType(messageData);
    const messageText = getServerMessageText(messageData);
    return messageData.type === 'announcement'
      && (
        messageType === 'shutdown'
        || messageText.includes('软件暂时无法使用')
        || messageText.includes('停用')
      );
  }

  return {
    getServerMessageText,
    getServerMessageType,
    getUpdateVersion,
    isShutdownAnnouncement,
    isUpdateLikeMessage,
  };
});
