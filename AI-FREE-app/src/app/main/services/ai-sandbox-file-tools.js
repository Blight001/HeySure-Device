'use strict';

const fs = require('fs');
const path = require('path');

const SANDBOX_FILES_TOOL_NAME = 'sandbox_files';
const MAX_RESULTS = 200;
const TOOL_SCHEMA = {
  name: SANDBOX_FILES_TOOL_NAME,
  description: '读取软件安装目录中的 AI-Workspace。用于查找待上传资产和确认浏览器下载结果；只列出元数据，不读取文件内容。',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['info', 'list'], description: 'info 返回工作区路径；list 列出目录内容。默认 list。' },
      directory: { type: 'string', description: '工作区内的相对子目录，默认根目录。' },
      recursive: { type: 'boolean', description: '是否递归列出，默认 true。' },
    },
  },
};

function resolveInside(rootDir, relativeDirectory = '') {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, String(relativeDirectory || '.'));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('目录超出 AI 工作区');
  return { root, target, relative };
}

function walkDirectory(root, current, recursive, results) {
  const entries = fs.readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  for (const entry of entries) {
    if (results.length >= MAX_RESULTS) return;
    const absolutePath = path.join(current, entry.name);
    const item = {
      name: entry.name,
      relative_path: path.relative(root, absolutePath),
      absolute_path: absolutePath,
      type: entry.isDirectory() ? 'directory' : 'file',
    };
    if (entry.isFile()) {
      const stat = fs.statSync(absolutePath);
      item.size = stat.size;
      item.modified_at = stat.mtime.toISOString();
    }
    results.push(item);
    if (recursive && entry.isDirectory()) walkDirectory(root, absolutePath, recursive, results);
  }
}

function createAiSandboxFileTools(options = {}) {
  const sandboxDir = path.resolve(String(options.sandboxDir || 'AI-Workspace'));
  return {
    tools: [TOOL_SCHEMA],
    has: (name) => String(name || '') === SANDBOX_FILES_TOOL_NAME,
    execute: async (name, args = {}) => {
      if (String(name || '') !== SANDBOX_FILES_TOOL_NAME) throw new Error(`未知的沙盒文件工具: ${name}`);
      fs.mkdirSync(sandboxDir, { recursive: true });
      const action = String(args.action || 'list').trim().toLowerCase();
      if (action === 'info') return { success: true, workspace_path: sandboxDir, download_path: sandboxDir };
      if (action !== 'list') throw new Error(`未知的沙盒文件操作: ${action}`);
      const resolved = resolveInside(sandboxDir, args.directory);
      const items = [];
      walkDirectory(resolved.root, resolved.target, args.recursive !== false, items);
      return {
        success: true,
        workspace_path: sandboxDir,
        directory: resolved.relative || '.',
        items,
        truncated: items.length >= MAX_RESULTS,
      };
    },
  };
}

module.exports = { createAiSandboxFileTools, resolveInside, SANDBOX_FILES_TOOL_NAME };
