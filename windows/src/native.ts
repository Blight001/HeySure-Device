// native — the only place the frontend talks to the Rust shell. Every Electron
// main-process capability the prototype kept is one invoke() away; everything
// else (device protocol, dynamic MCP, runners) stays in TypeScript.

import { invoke } from '@tauri-apps/api/core'

export interface ProcessRunSpec {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  input?: string
  timeoutMs?: number
  maxOutputBytes?: number
}

export interface ProcessRunResult {
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  killed: boolean
  durationMs: number
}

export interface HostInfo {
  hostname: string
  platform: string
  arch: string
  cpus: number
  homeDir: string
  heysurePython: string | null
}

export interface AppPaths {
  resourceDir: string | null
  exeDir: string | null
  currentDir: string | null
}

export interface TempScript {
  dir: string
  path: string
}

export const native = {
  runProcess: (spec: ProcessRunSpec) => invoke<ProcessRunResult>('run_process', { spec }),
  pauseExecution: () => invoke<number>('pause_execution'),
  resumeExecution: () => invoke<void>('resume_execution'),
  killAllProcesses: () => invoke<number>('kill_all_processes'),
  executionState: () => invoke<{ paused: boolean; active: number }>('execution_state'),
  hostInfo: () => invoke<HostInfo>('host_info'),
  appPaths: () => invoke<AppPaths>('app_paths'),
  whichCommand: (name: string) => invoke<string | null>('which_command', { name }),
  fileExists: (path: string) => invoke<boolean>('file_exists', { path }),
  ensureDir: (path: string) => invoke<void>('ensure_dir', { path }),
  configPaths: () => invoke<{ configDir: string }>('config_paths'),
  loadJsonFile: (name: string) => invoke<any>('load_json_file', { name }),
  saveJsonFile: (name: string, value: any) => invoke<void>('save_json_file', { name, value }),
  writeTempScript: (contents: string, filename: string) =>
    invoke<TempScript>('write_temp_script', { contents, filename }),
  removeTempDir: (dir: string) => invoke<boolean>('remove_temp_dir', { dir }),
  // Remote control: inject one normalized pointer/keyboard event into the OS
  // (Rust enigo, robotjs equivalent). See src/remote-control.ts.
  rcInjectInput: (event: Record<string, any>) => invoke<void>('rc_inject_input', { event }),
  // Remote control: capture the primary screen as raw JPEG bytes (native xcap,
  // no getDisplayMedia / screen-share prompt). Returns an ArrayBuffer; a
  // zero-length buffer means capture was unavailable this tick. Raw bytes (vs a
  // base64 data URL) avoid ~33% IPC inflation and the slow string decode path.
  rcCaptureFrame: (quality: number) => invoke<ArrayBuffer>('rc_capture_frame', { quality }),
  setTrayStatus: (status: string, paused: boolean) => invoke<void>('set_tray_status', { status, paused }),
}
