'use strict';

const fs = require('fs');
const path = require('path');
const { resolveInside } = require('../../services/ai-sandbox-file-tools');

const FILE_REF_RE = /^file_[a-f0-9]{32}$/;
const MAX_FILE_BYTES = 250 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const SERVER_UPLOAD_ACTIONS = new Set(['download', 'download_element', 'upload_to_server']);

function attachmentUploadUrl(server) {
  const base = new URL(String(server || ''));
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('HeySure 文件地址仅支持 HTTP/HTTPS');
  return new URL('/api/chat/attachments/upload', base);
}

function resolveSandboxFile(sandboxDir, candidate) {
  const requested = path.resolve(String(candidate || ''));
  const scoped = resolveInside(sandboxDir, path.relative(sandboxDir, requested)).target;
  if (!fs.existsSync(scoped) || !fs.statSync(scoped).isFile()) throw new Error('AI 工作区下载文件不存在');
  const realPath = fs.realpathSync(scoped);
  resolveInside(sandboxDir, path.relative(sandboxDir, realPath));
  return realPath;
}

function responseError(payload, status) {
  const detail = payload?.detail;
  if (typeof detail === 'string') return detail;
  if (typeof detail?.message === 'string') return detail.message;
  return `上传到 HeySure 失败（HTTP ${status}）`;
}

function createHeySureFileUploader(options = {}) {
  const configuredDir = path.resolve(String(options.sandboxDir || 'AI-Workspace'));
  fs.mkdirSync(configuredDir, { recursive: true });
  const sandboxDir = fs.realpathSync(configuredDir);
  const fetchImpl = options.fetch || globalThis.fetch;
  return async ({ server, token, aiConfigId, localPath, sessionId = 'default' }) => {
    if (!fetchImpl || !token || !Number.isInteger(Number(aiConfigId)) || Number(aiConfigId) <= 0) {
      throw new Error('HeySure 文件上传上下文不完整');
    }
    const sourcePath = resolveSandboxFile(sandboxDir, localPath);
    const stat = await fs.promises.stat(sourcePath);
    if (stat.size <= 0) throw new Error('不能上传空文件');
    if (stat.size > MAX_FILE_BYTES) throw new Error('文件超过 HeySure 250 MB 工作区传输上限');
    const form = new FormData();
    const fileBlob = await fs.openAsBlob(sourcePath);
    form.append('file', fileBlob, path.basename(sourcePath));
    form.append('ai_config_id', String(Number(aiConfigId)));
    form.append('ai_kind', 'assistant');
    form.append('session_id', String(sessionId || 'default'));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      const response = await fetchImpl(attachmentUploadUrl(server), {
        method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
        redirect: 'error', signal: controller.signal,
      });
      let payload = {};
      try { payload = await response.json(); } catch (_) {}
      if (!response.ok) throw new Error(responseError(payload, response.status));
      if (!FILE_REF_RE.test(String(payload?.file_ref || ''))) throw new Error('HeySure 上传回执缺少有效 file_ref');
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  };
}

function isDownloadResult(context) {
  const action = String(context.args?.action || '').trim().toLowerCase();
  return context.sourceName === 'browser_file'
    && (SERVER_UPLOAD_ACTIONS.has(action) || context.result?.action === 'upload_to_server')
    && context.result
    && typeof context.result === 'object'
    && context.result.success !== false;
}

async function attachHeySureDownloadedFile(context) {
  const result = context.result;
  if (!isDownloadResult(context)) return result;
  if (context.args?.save_to_server === false) {
    return { ...result, uploaded_to_heysure: false, server_upload_skipped: true };
  }
  try {
    if (typeof context.upload !== 'function') throw new Error('HeySure 文件上传服务不可用');
    const uploaded = await context.upload({
      server: context.server, token: context.token,
      aiConfigId: Number(context.aiConfigId), sessionId: context.sessionId,
      localPath: result.absolute_path,
    });
    return {
      ...result,
      uploaded_to_heysure: true,
      file_ref: uploaded.file_ref,
      server_workspace_path: uploaded.workspace_path,
      server_mime_type: uploaded.mime_type,
      can_send_to_user: uploaded.can_send_to_user === true,
      next_action: String(uploaded.mime_type || '').startsWith('image/')
        ? '调用 workspace.file+manage(action=view_image, file_ref=上述 file_ref) 查看图片；可用 message.send+to 发送给用户。'
        : '可用 message.send+to 和上述 file_ref 将文件发送给用户。',
    };
  } catch (error) {
    return {
      ...result,
      uploaded_to_heysure: false,
      can_send_to_user: false,
      server_upload_error: String(error?.message || error || '上传失败'),
    };
  }
}

module.exports = {
  attachHeySureDownloadedFile,
  attachmentUploadUrl,
  createHeySureFileUploader,
  resolveSandboxFile,
};
