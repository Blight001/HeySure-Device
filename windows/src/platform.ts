import * as os from 'os'
import type { PlatformProfile } from './platform-profile'

export const IS_WINDOWS = process.platform === 'win32'
export const IS_MAC = process.platform === 'darwin'
export const IS_LINUX = process.platform === 'linux'

// Platform-specific values consumed by shared modules. See platform-profile.ts.
export const platformProfile: PlatformProfile = {
  platform: 'windows',
  isCurrentPlatform: IS_WINDOWS,
  deviceIdPrefix: 'win-desktop-',
  agentName: 'Windows Agent',
  appIconFile: 'icon.ico',
}

export const WINDOWS_CAPABILITIES = [
  'shell.run',
  'keyboard.type', 'keyboard.press',
  'mouse.move', 'mouse.click', 'mouse.double_click', 'mouse.right_click', 'mouse.scroll', 'mouse.drag',
  'clipboard.get', 'clipboard.set',
  'window.list', 'window.focus', 'window.close',
  'speech.speak',
  'vision.capture', 'vision.capture_mouse',
  'hands.start', 'hands.stop', 'hands.snapshot', 'hands.events', 'hands.mouse',
]

export const OTHER_CAPABILITIES = [
  'shell.run',
]

export function getCapabilities(): string[] {
  return IS_WINDOWS ? WINDOWS_CAPABILITIES : OTHER_CAPABILITIES
}

export function getPlatformInfo() {
  return {
    platform: os.platform(),
    arch: os.arch(),
    release: os.release(),
    hostname: os.hostname(),
    cpus: os.cpus().length,
    totalMem: Math.round(os.totalmem() / 1024 / 1024 / 1024) + 'GB',
  }
}
