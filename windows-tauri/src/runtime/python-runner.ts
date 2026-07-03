// python-runner — port of device/shared/src/runtime/python-runner.ts.
//
// Contract for the supplied ``code`` (unchanged):
//   - a dict ``args`` is pre-populated from the call arguments;
//   - assign the tool's output to a variable ``result`` (any JSON value);
//   - anything printed is captured as stdout.
//
// Interpreter resolution mirrors device/windows:
//   $HEYSURE_PYTHON → bundled portable Python → dev venv → python on PATH.

import { native } from '../native'
import { runProcess, type ProcessRunResult } from './process'
import { PYTHON_TIMEOUT_MS } from '../constants'

const RESULT_SENTINEL = '__HEYSURE_RESULT__='

export interface PythonRunOptions {
  code: string
  args?: Record<string, any>
  cwd?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  maxOutputBytes?: number
  pythonPath?: string
}

export interface PythonRunResult extends ProcessRunResult {
  available: boolean
  /** Parsed value of the script's ``result`` variable, when present. */
  result: any
}

let cachedPython: string | null | undefined

function joinPath(...parts: Array<string | null | undefined>): string {
  const clean = parts.filter(Boolean).map(part => String(part).replace(/[\\/]+$/g, ''))
  return clean.join('\\')
}

async function firstExisting(paths: string[]): Promise<string | null> {
  for (const path of paths) {
    if (await native.fileExists(path)) return path
  }
  return null
}

export async function resolvePython(): Promise<string | null> {
  if (cachedPython !== undefined) return cachedPython
  const info = await native.hostInfo()
  if (info.heysurePython && (await native.fileExists(info.heysurePython))) {
    cachedPython = info.heysurePython
    return cachedPython
  }

  const paths = await native.appPaths()
  const bundled = await firstExisting([
    joinPath(paths.resourceDir, 'bundled', 'python', 'python.exe'),
    joinPath(paths.exeDir, 'bundled', 'python', 'python.exe'),
    joinPath(paths.currentDir, 'bundled', 'python', 'python.exe'),
  ])
  if (bundled) {
    cachedPython = bundled
    return cachedPython
  }

  const devVenv = await firstExisting([
    joinPath(paths.currentDir, 'device_runtime', 'python', '.venv', 'Scripts', 'python.exe'),
    joinPath(paths.exeDir, 'device_runtime', 'python', '.venv', 'Scripts', 'python.exe'),
    joinPath(paths.resourceDir, 'device_runtime', 'python', '.venv', 'Scripts', 'python.exe'),
  ])
  if (devVenv) {
    cachedPython = devVenv
    return cachedPython
  }

  for (const name of ['python', 'python3', 'py']) {
    const found = await native.whichCommand(name)
    if (found) {
      cachedPython = found
      return cachedPython
    }
  }
  cachedPython = null
  return cachedPython
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
  const python = options.pythonPath || (await resolvePython())
  if (!python) {
    return {
      available: false, result: null, exitCode: 127, signal: null, stdout: '',
      stderr: 'Python 不可用（未找到解释器）。请安装 Python 并加入 PATH，或设置 HEYSURE_PYTHON 环境变量指向解释器。',
      timedOut: false, truncated: false, killed: false, durationMs: 0,
    }
  }

  const script = await native.writeTempScript(buildScript(options.code), 'tool.py')
  try {
    const result = await runProcess(python, [script.path], {
      cwd: options.cwd,
      env: { ...options.env, HEYSURE_TOOL_ARGS: JSON.stringify(options.args || {}) },
      timeoutMs: options.timeoutMs ?? PYTHON_TIMEOUT_MS,
      maxOutputBytes: options.maxOutputBytes,
    })
    const split = splitResult(result.stdout)
    return { available: true, result: split.result, ...result, stdout: split.stdout }
  } finally {
    void native.removeTempDir(script.dir).catch(() => {})
  }
}
