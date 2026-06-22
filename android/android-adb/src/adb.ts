// Thin wrappers over the `adb` CLI. Shelling out (instead of a native adbkit
// binding) keeps this dependency-light and works with whatever adb the host
// already has. All input/screencap commands work even while the phone screen is
// OFF or locked — that is the whole point of the ADB form (方案 B).

import { execFile } from 'child_process'

const ADB = process.env.ADB_PATH || 'adb'

export interface AdbTarget {
  serial: string
}

function baseArgs(target: AdbTarget): string[] {
  return target.serial ? ['-s', target.serial] : []
}

/** Run an adb command, capturing stdout as text. */
export function adbText(target: AdbTarget, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ADB, [...baseArgs(target), ...args], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.toString().trim() || err.message))
        resolve(stdout.toString())
      })
  })
}

/** Run an adb command, capturing stdout as raw bytes (e.g. screencap PNG). */
export function adbBinary(target: AdbTarget, args: string[], timeoutMs = 20_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(ADB, [...baseArgs(target), ...args], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr?.toString().trim() || err.message))
        resolve(stdout as Buffer)
      })
  })
}

export async function listDevices(): Promise<string[]> {
  const out = await adbText({ serial: '' }, ['devices'])
  return out.split('\n').slice(1)
    .map(line => line.trim())
    .filter(line => line.endsWith('\tdevice'))
    .map(line => line.split('\t')[0])
}

/** Resolve which device to drive: explicit serial, else the sole online one. */
export async function resolveSerial(preferred: string): Promise<string> {
  const devices = await listDevices()
  if (preferred) {
    if (!devices.includes(preferred)) {
      throw new Error(`指定的设备 ${preferred} 不在线（adb devices: ${devices.join(', ') || '空'}）`)
    }
    return preferred
  }
  if (devices.length === 0) throw new Error('没有在线的 adb 设备，请用 USB 或无线调试连接手机')
  if (devices.length > 1) throw new Error(`检测到多台设备（${devices.join(', ')}），请在 .env 用 ANDROID_SERIAL 指定一台`)
  return devices[0]
}

// --- input injection (works screen-off / locked) ---

export const tap = (t: AdbTarget, x: number, y: number) =>
  adbText(t, ['shell', 'input', 'tap', String(x), String(y)])

export const swipe = (t: AdbTarget, x1: number, y1: number, x2: number, y2: number, durationMs: number) =>
  adbText(t, ['shell', 'input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(durationMs)])

export const keyevent = (t: AdbTarget, code: number | string) =>
  adbText(t, ['shell', 'input', 'keyevent', String(code)])

/** `input text` cannot carry spaces/specials directly; encode them. */
export const inputText = (t: AdbTarget, text: string) =>
  adbText(t, ['shell', 'input', 'text', text.replace(/ /g, '%s').replace(/(["'`$&|;<>()])/g, '\\$1')])

/** Wake the screen (KEYCODE_WAKEUP=224). Lets tasks run from a dark screen. */
export const wake = (t: AdbTarget) => keyevent(t, 224)

/** Best-effort unlock: wake, then swipe up. Only clears a NON-secure keyguard
 *  (no PIN/pattern/password); a secure lock cannot be bypassed via adb. */
export async function wakeAndUnlock(t: AdbTarget): Promise<void> {
  await wake(t)
  await keyevent(t, 82) // KEYCODE_MENU nudges some lockscreens awake
  await swipe(t, 540, 1600, 540, 400, 200)
}

/** Capture one frame as a PNG buffer (works while locked; shows lockscreen if so). */
export const screencapPng = (t: AdbTarget) => adbBinary(t, ['exec-out', 'screencap', '-p'])

/** Record the screen on-device, then pull the mp4 to the host. */
export async function screenrecord(t: AdbTarget, durationSec: number, hostPath: string): Promise<void> {
  const remote = `/sdcard/heysure-rec-${Date.now()}.mp4`
  // screenrecord blocks for the duration; cap at adb's 180s ceiling.
  await adbText(t, ['shell', 'screenrecord', '--time-limit', String(durationSec), remote],
    (durationSec + 15) * 1000)
  await adbText(t, ['pull', remote, hostPath], 60_000)
  await adbText(t, ['shell', 'rm', '-f', remote]).catch(() => {})
}

/** Physical screen size in pixels, e.g. {width:1080,height:2400}. */
export async function screenSize(t: AdbTarget): Promise<{ width: number; height: number }> {
  const out = await adbText(t, ['shell', 'wm', 'size'])
  const m = out.match(/(\d+)x(\d+)/)
  if (!m) return { width: 0, height: 0 }
  return { width: Number(m[1]), height: Number(m[2]) }
}

export async function deviceModel(t: AdbTarget): Promise<string> {
  return (await adbText(t, ['shell', 'getprop', 'ro.product.model'])).trim() || 'Android'
}
