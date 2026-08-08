'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const RUN_COMMAND_TOOL_NAME = 'run_command';
const LEGACY_TOOL_NAME = 'sandbox_files';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 120000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const TOOL_SCHEMA = {
  name: RUN_COMMAND_TOOL_NAME,
  destructive: true,
  description: '在 AI-Workspace 工作目录中执行命令行。支持 cmd、PowerShell 或系统 shell；返回退出码和有界输出。工作目录受限于 AI-Workspace，但不是虚拟机级系统隔离。',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['command'],
    properties: {
      command: { type: 'string', minLength: 1, maxLength: 20000, description: '要执行的命令行。' },
      shell: { type: 'string', enum: ['default', 'cmd', 'powershell'], description: '命令解释器，默认使用当前平台 shell。' },
      directory: { type: 'string', description: 'AI-Workspace 内的相对工作目录，默认根目录。' },
      timeout_ms: { type: 'number', minimum: 1000, maximum: MAX_TIMEOUT_MS, description: '超时毫秒数，默认 30000。' },
    },
  },
};

function resolveInside(rootDir, relativeDirectory = '') {
  const root = path.resolve(rootDir);
  const target = path.resolve(root, String(relativeDirectory || '.'));
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('工作目录超出 AI 工作区');
  return { root, target, relative };
}

function commandProcess(command, shell) {
  const selected = String(shell || 'default').trim().toLowerCase();
  if (selected === 'powershell') {
    return { executable: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] };
  }
  if (process.platform === 'win32' || selected === 'cmd') {
    return { executable: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { executable: process.env.SHELL || '/bin/sh', args: ['-c', command] };
}

function commandEnvironment(root) {
  const allowed = ['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP'];
  const env = Object.fromEntries(allowed.filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
  return { ...env, HOME: root, USERPROFILE: root, AI_WORKSPACE: root };
}

function appendOutput(state, chunk) {
  const remaining = Math.max(0, MAX_OUTPUT_BYTES - state.bytes);
  const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (remaining) state.chunks.push(source.subarray(0, remaining));
  state.bytes += source.length;
  if (source.length > remaining) state.truncated = true;
}

function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  child.kill('SIGKILL');
}

function resolveWorkingDirectory(root, directory) {
  const working = resolveInside(root, directory);
  if (!fs.existsSync(working.target) || !fs.statSync(working.target).isDirectory()) throw new Error('AI 工作区工作目录不存在');
  const realTarget = fs.realpathSync(working.target);
  resolveInside(root, path.relative(root, realTarget));
  return { ...working, target: realTarget };
}

function executeCommand(root, input) {
  const command = String(input.command || '').trim();
  if (!command) throw new Error('run_command 缺少 command');
  const working = resolveWorkingDirectory(root, input.directory);
  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS));
  const processSpec = commandProcess(command, input.shell);
  return new Promise((resolve, reject) => {
    const stdout = { chunks: [], bytes: 0, truncated: false };
    const stderr = { chunks: [], bytes: 0, truncated: false };
    const child = spawn(processSpec.executable, processSpec.args, {
      cwd: working.target, env: commandEnvironment(root), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; stopProcessTree(child); }, timeoutMs);
    child.stdout.on('data', (chunk) => appendOutput(stdout, chunk));
    child.stderr.on('data', (chunk) => appendOutput(stderr, chunk));
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        success: code === 0 && !timedOut, command, directory: working.relative || '.',
        exit_code: Number.isInteger(code) ? code : null, signal: signal || null, timed_out: timedOut,
        stdout: Buffer.concat(stdout.chunks).toString('utf8'), stderr: Buffer.concat(stderr.chunks).toString('utf8'),
        stdout_truncated: stdout.truncated, stderr_truncated: stderr.truncated,
      });
    });
  });
}

function createAiSandboxFileTools(options = {}) {
  const configuredDir = path.resolve(String(options.sandboxDir || 'AI-Workspace'));
  fs.mkdirSync(configuredDir, { recursive: true });
  const sandboxDir = fs.realpathSync(configuredDir);
  return {
    tools: [TOOL_SCHEMA],
    has: (name) => [RUN_COMMAND_TOOL_NAME, LEGACY_TOOL_NAME].includes(String(name || '')),
    execute: async (name, args = {}) => {
      if (![RUN_COMMAND_TOOL_NAME, LEGACY_TOOL_NAME].includes(String(name || ''))) throw new Error(`未知的命令工具: ${name}`);
      return executeCommand(sandboxDir, args && typeof args === 'object' ? args : {});
    },
  };
}

module.exports = { createAiSandboxFileTools, executeCommand, resolveInside, RUN_COMMAND_TOOL_NAME };
