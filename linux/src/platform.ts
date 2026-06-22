import * as os from 'os'
import type { PlatformProfile } from './platform-profile'

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'
export const IS_LINUX = process.platform === 'linux'

// Platform-specific values consumed by shared modules. See platform-profile.ts.
export const platformProfile: PlatformProfile = {
  platform: 'linux',
  isCurrentPlatform: IS_LINUX,
  deviceIdPrefix: 'linux-desktop-',
  agentName: 'Linux Agent',
  appIconFile: 'desktop.png',
}

// Capabilities advertised by the Linux desktop agent. Desktop control tools
// (keyboard / mouse / screen) rely on an X11 session plus robotjs; window /
// process / speech tools shell out to standard Linux utilities (wmctrl,
// xdotool, ps, espeak-ng / spd-say). The full list is reported to the server
// via device:register so the AI knows what this device can do.
export const LINUX_CAPABILITIES = [
  'fs.list', 'fs.read', 'fs.write',
  'shell.run', 'git.diff',
  'keyboard.type', 'keyboard.press',
  'mouse.move', 'mouse.click', 'mouse.double_click', 'mouse.right_click', 'mouse.scroll', 'mouse.drag',
  'screen.capture', 'screen.capture_region', 'screen.info',
  'clipboard.get', 'clipboard.set',
  'window.list', 'window.focus', 'window.close',
  'process.list', 'process.kill',
  'speech.speak',
  'vision.capture', 'vision.capture_mouse',
  'hands.start', 'hands.stop', 'hands.snapshot', 'hands.events', 'hands.mouse',
  'ear.start', 'ear.stop', 'ear.latest',
]

export const OTHER_CAPABILITIES = [
  'fs.list', 'fs.read', 'fs.write',
  'shell.run', 'git.diff',
]

export function getCapabilities(): string[] {
  return IS_LINUX ? LINUX_CAPABILITIES : OTHER_CAPABILITIES
}

export function getPlatformInfo() {
  return {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    hostname: os.hostname(),
    cpus: os.cpus().length,
    totalMem: Math.round(os.totalmem() / 1024 / 1024 / 1024) + 'GB',
    sessionType: process.env.XDG_SESSION_TYPE || process.env.DESKTOP_SESSION || '',
    display: process.env.DISPLAY || process.env.WAYLAND_DISPLAY || '',
  }
}
