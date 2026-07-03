// python-runner — run a server-authored Python tool body under the guard.
//
// Contract for the supplied ``code`` (设备端MCP代码下放长期方案 §5.1):
//   - a dict ``args`` is pre-populated from the call arguments;
//   - assign the tool's output to a variable ``result`` (any JSON value);
//   - anything printed is captured as stdout.
// The runner appends a line that serializes ``result`` behind a sentinel, so it
// can be split back out of stdout reliably.
//
// Interpreter resolution order:
//   explicit pythonPath → $HEYSURE_PYTHON
//   → bundled portable Python (resources/bundled/python for packaged app, zero-config)
//   → venv from `npm run setup:python` (dev only)
//   → python on PATH (last resort, shows clear error if missing).

import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import { runProcess, type ProcessRunResult } from './process-guard'
import { PYTHON_TIMEOUT_MS } from '../constants'

const RESULT_SENTINEL = '__HEYSURE_RESULT__='

export interface PythonRunOptions {
  code: string
  args?: Record<string, any>
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  maxOutputBytes?: number
  /** Override the interpreter; otherwise resolvePython() decides. */
  pythonPath?: string
}

export interface PythonRunResult extends ProcessRunResult {
  available: boolean
  /** Parsed value of the script's ``result`` variable, when present. */
  result: any
}

let cachedPython: string | null | undefined

function venvCandidates(): string[] {
  // device_runtime/python/.venv created by scripts/setup-python.js (dev only).
  // Resolved against a few roots so it works in dev and when packaged.
  const roots = [
    path.resolve(__dirname, "..", "..", "device_runtime"),
    path.resolve(process.cwd(), "device_runtime"),
  ]
  const resourcesPath = (process as any).resourcesPath
  if (resourcesPath) roots.push(path.join(resourcesPath, "device_runtime"))
  const sub = process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]
  return roots.map((root) => path.join(root, "python", ".venv", ...sub))
}

function bundledCandidates(): string[] {
  // Bundled self-contained Python (embeddable + pip deps) produced by
  // scripts/prepare-bundled-python.js and shipped via electron-builder
  // extraResources for zero-config on target machines without Python.
  // Located at <app>/bundled/python/python.exe in packaged app.
  const roots: string[] = [
    path.resolve(__dirname, "..", "..", "bundled"),
    path.resolve(process.cwd(), "bundled"),
  ]
  const resourcesPath = (process as any).resourcesPath
  if (resourcesPath) {
    roots.push(path.join(resourcesPath, "bundled"))
    // When using asar + unpacked native bits sometimes land here
    roots.push(path.join(resourcesPath, "app.asar.unpacked", "bundled"))
  }
  return roots.map((root) => path.join(root, "python", "python.exe"))
}

function pathCandidates(): string[] {
  return process.platform === 'win32'
    ? ['python.exe', 'python3.exe', 'py.exe', 'python', 'python3']
    : ['python3', 'python']
}

/** Resolve the interpreter once; bare PATH names are returned as-is. */
export function resolvePython(): string | null {
  if (cachedPython !== undefined) return cachedPython
  const fromEnv = process.env.HEYSURE_PYTHON
  if (fromEnv && fs.existsSync(fromEnv)) { cachedPython = fromEnv; return cachedPython }

  // 1. Bundled portable Python (preferred for packaged / end-user installs)
  for (const candidate of bundledCandidates()) {
    if (fs.existsSync(candidate)) { cachedPython = candidate; return cachedPython }
  }

  // 2. Dev venv created by `npm run setup:python`
  for (const candidate of venvCandidates()) {
    if (fs.existsSync(candidate)) { cachedPython = candidate; return cachedPython }
  }

  // 3. Fall back to the first PATH name; spawn surfaces ENOENT if truly absent.
  cachedPython = pathCandidates()[0] || null
  return cachedPython
}

export function isPythonAvailable(): boolean {
  return resolvePython() != null
}

function buildScript(code: string): string {
  return [
    'import os, json',
    'args = json.loads(os.environ.get("HEYSURE_TOOL_ARGS") or "{}")',
    'result = None',
    '',
    code,
    '',
    `print(${JSON.stringify(RESULT_SENTINEL)} + json.dumps(result, default=str))`,
  ].join('\n')
}

function splitResult(stdout: string): { stdout: string; result: any } {
  const idx = stdout.lastIndexOf(RESULT_SENTINEL)
  if (idx < 0) return { stdout, result: null }
  const before = stdout.slice(0, idx).replace(/\n$/, '')
  const json = stdout.slice(idx + RESULT_SENTINEL.length).trim()
  try {
    return { stdout: before, result: JSON.parse(json) }
  } catch {
    return { stdout, result: null }
  }
}

export async function runPython(options: PythonRunOptions): Promise<PythonRunResult> {
  const python = options.pythonPath || resolvePython()
  if (!python) {
    return {
      available: false, result: null, exitCode: 127, signal: null, stdout: '',
      stderr: 'Python 不可用（未找到解释器）。打包版本应已内置 Python 运行时；开发环境请运行 `npm run setup:python`。可设置 HEYSURE_PYTHON 环境变量覆盖。',
      timedOut: false, truncated: false, killed: false, durationMs: 0,
    }
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heysure-py-'))
  const scriptPath = path.join(dir, 'tool.py')
  fs.writeFileSync(scriptPath, buildScript(options.code), 'utf8')

  try {
    const result = await runProcess(python, [scriptPath], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, HEYSURE_TOOL_ARGS: JSON.stringify(options.args || {}) },
      timeoutMs: options.timeoutMs ?? PYTHON_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes,
      windowsHide: true,
    })
    const split = splitResult(result.stdout)
    return { available: true, result: split.result, ...result, stdout: split.stdout }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
}
