// Platform-specific values consumed by otherwise-shared modules.
//
// Shared code (registry, ai-config, device-runtime, main-window, tray …) must
// not hardcode platform-specific constants. Each desktop shell provides its
// own ``platformProfile`` from its (forked) ``src/platform.ts``; shared code
// reads from this contract instead of branching on the OS.
export interface PlatformProfile {
  // Stable platform key, matches ToolDefinition.platform values.
  platform: 'windows' | 'linux' | 'mac'
  // True when the process is actually running on this profile's platform.
  isCurrentPlatform: boolean
  // Prefix used when minting the device id, e.g. "win-desktop-".
  deviceIdPrefix: string
  // Human label reported to the server / shown in logs, e.g. "Windows Agent".
  agentName: string
  // Application icon file under assets/, e.g. "icon.ico" / "desktop.png".
  appIconFile: string
}
