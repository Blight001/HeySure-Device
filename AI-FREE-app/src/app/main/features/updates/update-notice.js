const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { appContext } = require('../../runtime/app-context');
const { BrowserWindow, shell, app: electronApp } = require('electron');
const extractZip = require('extract-zip');
const tar = require('tar');
const { compareVersions } = require('../../../shared/version-utils');
const { summarizeUpdatePayload } = require('../../utils/update-payload');

// 处理：firstNonEmpty的具体业务逻辑。
function firstNonEmpty(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

// 更新消息里有些字段只是“回执”或“状态通知”，不是可执行的更新包信息。
// 这里把它们单独列出来，避免后面的人把它们误当成真正的更新指令。
const UPDATE_RELATED_MESSAGE_TYPES = new Set([
  'app_update',
  'update',
  'software_update',
  'upgrade',
  'success',
]);

// 处理：isUpdateRelatedMessageType的具体业务逻辑。
function isUpdateRelatedMessageType(messageType = '') {
  const type = String(messageType || '').trim().toLowerCase();
  return UPDATE_RELATED_MESSAGE_TYPES.has(type);
}

// 统一构造更新通知载荷，避免主进程和渲染层各自拼字段导致语义不一致。
function createUpdateUiPayload(normalized = {}, {
  currentVersion = '',
  phase = '',
} = {}) {
  const targetVersion = String(normalized.version || '').trim();
  const content = normalized.content || `发现新版本 v${targetVersion}`;
  return {
    ...normalized,
    currentVersion: String(currentVersion || '').trim(),
    targetVersion,
    version: targetVersion,
    title: normalized.title || '发现新版本',
    content,
    message: content,
    force: normalized.force === true,
    phase,
  };
}

// 某些服务端消息只是更新结果回执，没有 version/downloadUrl。
// 这类消息不应该进入真正的更新流程。
function shouldIgnoreUpdateReceipt(normalized = {}, messageType = '') {
  return !normalized.version && isUpdateRelatedMessageType(messageType);
}

// 获取/读取/解析：getUrlPathExtension的具体业务逻辑。
function getUrlPathExtension(urlString = '') {
  try {
    const urlObj = new URL(String(urlString || '').trim());
    return path.extname(urlObj.pathname || '').toLowerCase();
  } catch (_) {
    return '';
  }
}

// 处理：looksLikeWebPageUrl的具体业务逻辑。
function looksLikeWebPageUrl(urlString = '') {
  const ext = getUrlPathExtension(urlString);
  return ![
    '.zip',
    '.tar',
    '.tgz',
    '.gz',
    '.exe',
    '.msi',
    '.dmg',
    '.pkg',
    '.7z',
    '.rar',
    '.bat',
    '.cmd',
    '.ps1',
  ].includes(ext);
}

// 获取/读取/解析：getSuggestedFileNameFromUrl的具体业务逻辑。
function getSuggestedFileNameFromUrl(urlString = '', fallback = '') {
  try {
    const urlObj = new URL(String(urlString || '').trim());
    const name = decodeURIComponent(path.basename(urlObj.pathname || ''));
    return name || fallback;
  } catch (_) {
    return fallback;
  }
}

// 处理：toDebugString的具体业务逻辑。
function toDebugString(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    try {
      return String(value);
    } catch (err) {
      return `[Unserializable: ${err?.message || 'unknown'}]`;
    }
  }
}

// 启动/打开/显示：openDownloadPageAndAutoClick的具体业务逻辑。
function createUpdatePayloadPicker(messageData) {
  const sources = [
    messageData,
    messageData.data,
    messageData.payload,
    messageData.announcement,
    messageData.update,
  ].filter((value) => value && typeof value === 'object');

  return (keys) => {
    for (const source of sources) {
      for (const key of keys) {
        const value = source?.[key];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
          return value;
        }
      }
    }
    return '';
  };
}

function extractUpdatePayload(messageData = {}) {
  const pick = createUpdatePayloadPicker(messageData);

  return {
    type: firstNonEmpty(pick(['type']), pick(['message_type', 'messageType'])),
    messageType: firstNonEmpty(pick(['message_type', 'messageType'])),
    version: firstNonEmpty(
      pick(['latest_version', 'latestVersion']),
      pick(['version']),
      pick(['new_version', 'newVersion']),
      pick(['target_version', 'targetVersion']),
      pick(['app_version', 'appVersion']),
      pick(['update_version', 'updateVersion']),
    ),
    downloadUrl: firstNonEmpty(
      pick(['download_url', 'downloadUrl']),
      pick(['package_url', 'packageUrl']),
      pick(['url']),
      pick(['link']),
      pick(['file_url', 'fileUrl']),
      pick(['update_link', 'updateLink']),
    ),
    openUrl: firstNonEmpty(
      pick(['open_url', 'openUrl']),
      pick(['subscription_url', 'subscriptionUrl']),
      pick(['landing_url', 'landingUrl']),
      pick(['page_url', 'pageUrl']),
      pick(['download_page_url', 'downloadPageUrl']),
      pick(['redirect_url', 'redirectUrl']),
    ),
    content: firstNonEmpty(
      pick(['announcement']),
      pick(['content']),
      pick(['message']),
      pick(['description']),
      pick(['detail']),
      pick(['notes']),
      pick(['update_message', 'updateMessage']),
      pick(['update_content', 'updateContent']),
    ),
    title: firstNonEmpty(
      pick(['title']),
      pick(['announcement_title', 'announcementTitle']),
      pick(['update_title', 'updateTitle']),
    ),
    fileName: firstNonEmpty(
      pick(['file_name', 'fileName']),
      pick(['archive_name', 'archiveName']),
      pick(['package_name', 'packageName']),
    ),
    packageType: firstNonEmpty(
      pick(['package_type', 'packageType']),
      pick(['file_type', 'fileType']),
    ).toLowerCase(),
    entryFile: firstNonEmpty(
      pick(['entry_file', 'entryFile']),
      pick(['launch_file', 'launchFile']),
      pick(['run_file', 'runFile']),
      pick(['start_file', 'startFile']),
    ),
    launchMode: firstNonEmpty(
      pick(['launch_mode', 'launchMode']),
      pick(['open_mode', 'openMode']),
      pick(['download_mode', 'downloadMode']),
    ).toLowerCase(),
    openInBrowser: pick(['open_in_browser', 'openInBrowser']) === true,
    force: pick(['force', 'mandatory', 'required']) === true,
    raw: messageData,
  };
}

// 处理：isUpdateNotice的具体业务逻辑。
function isUpdateNotice(messageData = {}) {
  const normalized = extractUpdatePayload(messageData);
  const type = String(normalized.type || '').toLowerCase();
  const messageType = String(normalized.messageType || '').toLowerCase();
  return (
    type === 'app_update'
    || type === 'update'
    || type === 'software_update'
    || type === 'upgrade'
    || messageType === 'update'
    || messageType === 'app_update'
    || messageType === 'software_update'
    || messageType === 'upgrade'
    || Boolean(normalized.version && (normalized.downloadUrl || normalized.openUrl))
  );
}

// 处理：safeMkdir的具体业务逻辑。

module.exports = {
  firstNonEmpty,
  isUpdateRelatedMessageType,
  createUpdateUiPayload,
  shouldIgnoreUpdateReceipt,
  getUrlPathExtension,
  looksLikeWebPageUrl,
  getSuggestedFileNameFromUrl,
  toDebugString,
  extractUpdatePayload,
  isUpdateNotice,
};
