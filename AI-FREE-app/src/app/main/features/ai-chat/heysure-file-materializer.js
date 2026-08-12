'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveInside } = require('../../services/ai-sandbox-file-tools');
const { sanitizeFileName } = require('../../services/browser-download-service');

const FILE_REF_RE = /^file_[a-f0-9]{32}$/;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 250 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10 * 60 * 1000;
const INCOMING_TTL_MS = 24 * 60 * 60 * 1000;

function augmentHeySureBrowserFileTool(sourceName, tool) {
  if (sourceName !== 'browser_file') return tool;
  const schema = tool.input_schema || { type: 'object', properties: {} };
  return {
    ...tool,
    description: `${tool.description} HeySure 远程调用 upload 时也可传服务器工作区 file_ref/file_refs；download/download_element 默认将结果上传到成员工作区并返回 file_ref。`,
    input_schema: {
      ...schema,
      properties: {
        ...(schema.properties || {}),
        file_ref: { type: 'string', pattern: '^file_[a-f0-9]{32}$', description: 'HeySure 当前成员工作区的单个文件引用' },
        file_refs: {
          type: 'array', minItems: 1, maxItems: MAX_FILES, uniqueItems: true,
          items: { type: 'string', pattern: '^file_[a-f0-9]{32}$' },
          description: 'HeySure 当前成员工作区的多个文件引用',
        },
        save_to_server: { type: 'boolean', description: '下载后是否上传到 HeySure 成员工作区，默认 true' },
      },
    },
  };
}

function normalizeFileRefs(args = {}) {
  const singular = String(args.file_ref || '').trim();
  const plural = Array.isArray(args.file_refs) ? args.file_refs.map((item) => String(item || '').trim()) : [];
  if (!singular && !plural.length) return [];
  if (singular && plural.length) throw new Error('file_ref 与 file_refs 不能同时使用');
  if (args.path || (Array.isArray(args.paths) && args.paths.length)) {
    throw new Error('服务器 file_ref/file_refs 不能与设备本地 path/paths 混用');
  }
  const refs = singular ? [singular] : plural;
  if (refs.length > MAX_FILES || new Set(refs).size !== refs.length || refs.some((ref) => !FILE_REF_RE.test(ref))) {
    throw new Error('file_ref/file_refs 格式无效、重复或数量超过 5 个');
  }
  return refs;
}

function safeTaskSegment(value) {
  return String(value || 'task').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100) || 'task';
}

function responseFileName(response, fallback) {
  const encoded = String(response.headers.get('x-heysure-file-name') || '');
  try { return sanitizeFileName(decodeURIComponent(encoded), fallback); } catch (_) {
    return sanitizeFileName(encoded, fallback);
  }
}

async function writeBoundedResponse(response, targetPath) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_FILE_BYTES) throw new Error('服务器文件超过 250 MB 设备传输上限');
  const handle = await fs.promises.open(targetPath, 'wx');
  const digest = crypto.createHash('sha256');
  let total = 0;
  try {
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error('HeySure 文件响应缺少可读取的数据流');
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.length;
      if (total > MAX_FILE_BYTES) throw new Error('服务器文件超过 250 MB 设备传输上限');
      digest.update(chunk);
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
  return { total, digest: digest.digest('hex') };
}

function cleanupExpiredIncoming(incomingRoot, currentTaskDir, now = Date.now()) {
  if (!fs.existsSync(incomingRoot)) return;
  for (const entry of fs.readdirSync(incomingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(incomingRoot, entry.name);
    if (candidate === currentTaskDir) continue;
    try {
      if (now - fs.statSync(candidate).mtimeMs > INCOMING_TTL_MS) fs.rmSync(candidate, { recursive: true, force: true });
    } catch (_) {}
  }
}

function deviceLinkApiUrl(server) {
  const base = new URL(String(server || ''));
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('HeySure 文件地址仅支持 HTTP/HTTPS');
  return new URL('/api/devices/files/links', base);
}

async function requestTemporaryLinks({ fetchImpl, server, token, aiConfigId, refs, signal }) {
  const response = await fetchImpl(deviceLinkApiUrl(server), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ai_config_id: aiConfigId, file_refs: refs, ttl_seconds: 300 }),
    redirect: 'error',
    signal,
  });
  if (!response.ok) throw new Error(`创建 HeySure 临时文件链接失败（HTTP ${response.status}）`);
  const payload = await response.json();
  const links = Array.isArray(payload?.links) ? payload.links : [];
  if (links.length !== refs.length || links.some((item, index) => item?.file_ref !== refs[index])) {
    throw new Error('HeySure 临时文件链接回执不完整');
  }
  return links;
}

async function downloadFile({ fetchImpl, link, targetPath, signal }) {
  let parsed;
  try { parsed = new URL(String(link.url || '')); } catch (_) { throw new Error('HeySure 临时文件链接无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('HeySure 临时文件链接仅支持 HTTP/HTTPS');
  const response = await fetchImpl(parsed, { headers: { Accept: 'application/octet-stream' }, redirect: 'error', signal });
  const fileRef = String(link.file_ref || '');
  const linkHash = String(link.sha256 || '').toLowerCase();
  if (!response.ok) throw new Error(`从 HeySure 获取临时文件失败（HTTP ${response.status}）`);
  if (response.headers.get('x-heysure-file-ref') !== fileRef) throw new Error('HeySure 文件引用回执不一致');
  const expectedHash = String(response.headers.get('x-heysure-file-sha256') || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || expectedHash !== linkHash) throw new Error('HeySure 文件响应缺少有效 SHA-256');
  const fileName = responseFileName(response, `${fileRef}.bin`);
  const finalPath = path.join(path.dirname(targetPath), `${path.basename(targetPath)}-${fileName}`);
  const tempPath = `${finalPath}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.part`;
  try {
    const written = await writeBoundedResponse(response, tempPath);
    if (written.digest !== expectedHash) throw new Error('HeySure 文件 SHA-256 校验失败');
    await fs.promises.rm(finalPath, { force: true });
    await fs.promises.rename(tempPath, finalPath);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
  }
  return finalPath;
}

function createHeySureFileMaterializer(options = {}) {
  const configuredDir = path.resolve(String(options.sandboxDir || 'AI-Workspace'));
  fs.mkdirSync(configuredDir, { recursive: true });
  const sandboxDir = fs.realpathSync(configuredDir);
  const fetchImpl = options.fetch || globalThis.fetch;
  return async ({ server, token, aiConfigId, taskId, refs }) => {
    if (!fetchImpl || !token || !Number.isInteger(Number(aiConfigId)) || Number(aiConfigId) <= 0) {
      throw new Error('HeySure 文件下载上下文不完整');
    }
    const taskRelative = path.join('Incoming', safeTaskSegment(taskId));
    const taskDir = resolveInside(sandboxDir, taskRelative).target;
    const incomingRoot = resolveInside(sandboxDir, 'Incoming').target;
    fs.mkdirSync(taskDir, { recursive: true });
    cleanupExpiredIncoming(incomingRoot, taskDir);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const links = await requestTemporaryLinks({
        fetchImpl, server, token, aiConfigId: Number(aiConfigId), refs, signal: controller.signal,
      });
      const paths = [];
      for (let index = 0; index < links.length; index += 1) {
        paths.push(await downloadFile({
          fetchImpl, link: links[index], targetPath: path.join(taskDir, String(index + 1)),
          signal: controller.signal,
        }));
      }
      return paths;
    } catch (error) {
      await fs.promises.rm(taskDir, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
}

async function prepareHeySureBrowserFileArgs(context) {
  const args = context.args && typeof context.args === 'object' ? context.args : {};
  const refs = context.sourceName === 'browser_file' ? normalizeFileRefs(args) : [];
  if (!refs.length) return args;
  if (String(args.action || '').toLowerCase() !== 'upload') throw new Error('file_ref/file_refs 仅支持 browser_file action=upload');
  if (typeof context.materialize !== 'function') throw new Error('HeySure 文件物化服务不可用');
  const paths = await context.materialize({
    server: context.server, token: context.token, aiConfigId: Number(context.task.aiConfigId),
    taskId: context.task.taskId, refs,
  });
  const { file_ref: _single, file_refs: _multiple, ...localArgs } = args;
  return args.file_ref ? { ...localArgs, path: paths[0] } : { ...localArgs, paths };
}

module.exports = {
  augmentHeySureBrowserFileTool,
  createHeySureFileMaterializer,
  normalizeFileRefs,
  prepareHeySureBrowserFileArgs,
};
