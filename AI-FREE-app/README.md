# AI-FREE

English | [简体中文](README_zh-CN.md)

AI-FREE is a multi-profile AI browser workspace for Windows. Electron provides the desktop shell, account and license flows, networking, and environment controls. All web content runs in the bundled **AI-FREE Chromium Fork**, embedded into the main window through a native Win32 host.

Current version: `2.6.4`

> This is no longer a conventional Electron webview application. Production mode requires `resources/chromium/ai-free-browser.exe` and an authenticated Runtime Bridge named-pipe handshake. It does not fall back to Electron web content or a system Chrome/Edge installation.

## Key Features

- **Multiple browser environments**: isolated profiles, tabs, browser history, session and cookie import, restart, data clearing, and environment removal.
- **Browser environment controls**: proxy, homepage, cookies, User Agent, locale, timezone, WebRTC, geolocation, resolution, Canvas, WebGL, WebGPU, AudioContext, hardware identity, and launch arguments.
- **Account and licensing**: sign-in, registration, license state, redemption codes, traffic and AI quota displays, remote announcements, and application updates.
- **Bundled proxy runtime**: Mihomo/Clash Mini integration with latency checks, automatic and manual node selection, system-proxy recovery, and proxied-traffic accounting.
- **Automatic extension injection**: configurable AI automation, watermark-removal, and translation extensions are loaded into Chromium environments.
- **AI browser control**: in-app conversations can select a connected browser and use local tools for observation, clicking, typing, navigation, waiting, cookie capture, and automation cards.
- **Background automation protection**: reduces timer, socket, and script throttling when the window is minimized, occluded, or unfocused.

## Runtime Architecture

```text
Electron main process
├─ Application shell / sidebar / tab orchestration
├─ Account, license, updates, and configuration
├─ Clash Mini and network state
├─ Browser Automation local bridge (127.0.0.1:18765)
└─ Browser Runtime Manager
   ├─ Starts one AI-FREE Chromium process per profile
   ├─ Authenticates and controls it over a named pipe
   └─ Embeds, resizes, and focuses its HWND through an N-API Win32 host

AI-FREE Chromium Fork
├─ Isolated browser process and profile data
├─ Automatically loaded Manifest V3 extensions
└─ All target pages and browser automation
```

Electron is the control plane; it no longer renders target sites. Browser data belongs to isolated Chromium profiles whose full lifecycle is managed by the main process.

## System and Development Requirements

Running from source requires:

- Windows 10/11 x64
- Node.js and npm; the current Node.js LTS release is recommended
- A complete `resources/chromium/` runtime with `ai-free-browser.exe`
- A compiled `native/browser-host/build/Release/browser_host.node`

Rebuilding the native host also requires Visual Studio 2022 Build Tools with Desktop development with C++ and a Windows 10/11 SDK. Packaged releases do not require Node.js or Visual Studio.

## Quick Start

From the `app2.1` directory:

```powershell
npm ci
npm start
```

On Windows, `v-start.bat` provides the same production-oriented launch. It forces remote server mode and verifies that the Electron binary was installed correctly.

### Launch Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Production Fork mode: bundled Chromium with mandatory named-pipe handshake |
| `npm run start:chromium` | Same as `npm start` |
| `npm run start:dev` | Starts the Electron development shell; browser pages still use bundled Chromium |
| `npm run start:electron` | Same as `start:dev` |
| `npm run start:prototype` | Chromium integration diagnostics with prototype handshake; never use for releases |
| `v-debug.bat` | Uses a local backend at `127.0.0.1:58111` with HTTP compatibility mode |

`start:dev` does not provide a hot-reload server. Restart the app after changing main-process or preload code; rebuild or reload the relevant browser environment after changing a bundled extension.

### Incomplete Electron Download

If the launcher reports that `node_modules/electron/dist` or `path.txt` is missing, run the following in PowerShell:

```powershell
Remove-Item -Recurse -Force node_modules\electron -ErrorAction SilentlyContinue
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
npm install
```

## Configuration

The root-level `platforms-config.json` is the entry point for packaging and default runtime settings.

| Field | Purpose |
| --- | --- |
| `accountService` | Primary and fallback account-service URLs plus request timeout |
| `packagedExtensions` | Extension directory names included in a build; names, duplicates, and paths are validated |
| `platforms` | Product name, App ID, and installer/window icons |
| `platformConfigs.<name>.targetUrl` | Default target page when the server does not provide an override |
| `platformConfigs.<name>.tutorialUrl` | Default tutorial URL |
| `platformConfigs.<name>.allowedPlatforms` | Platform labels accepted by license validation |
| `platformConfigs.<name>.systemProxyEnabled` | Whether the application may manage the Windows system proxy |
| `defaultPlatform` | Default platform configuration key |

License responses may dynamically provide target pages, tutorials, platform labels, resource links, TCP settings, and update information. Those runtime values can override local defaults.

Common development environment variables:

| Variable | Purpose |
| --- | --- |
| `AI_FREE_SERVER_MODE=remote|local` | Restricts allowed server-address types so production does not reuse a loopback backend |
| `SERVER_BASE` | Overrides the service base URL |
| `ACCOUNT_SERVICE_URL` | Overrides the account HTTP endpoint |
| `PLATFORM` | Selects a platform configuration |
| `FORCE_HTTP_COMPAT_MODE=1` | Disables the TCP channel and uses HTTP compatibility mode |
| `DEBUG=1` | Enables debug behavior and additional logging |

`v-start.bat` pins server mode to `remote`. For local integration, use `v-debug.bat` and adjust its backend addresses to match your service.

## Bundled Extensions

The current `packagedExtensions` configuration is empty. AI automation is provided by the authenticated Chromium Runtime Bridge and is not packaged as a browser extension.
- `remove_watermark`: browser copy and media-processing helpers.
- `transform`: web page, input, image, PDF, and video-subtitle translation.

The build script excludes unselected extensions according to `packagedExtensions`; Clash Mini is a separate runtime resource and is always packaged. AI automation tools are published by the main process and dispatched directly to managed Chromium profiles.

## Building the Windows Installer

### 1. Stage the Chromium Runtime

`resources/chromium/` must contain the complete runtime and `ai-free-browser.exe`. Version locks, patches, and reproducible Fork build steps are documented in [native/chromium-fork/README.md](native/chromium-fork/README.md).

### 2. Build the Native Browser Host

```powershell
npm run build:native-host
npm --prefix native/browser-host test
```

### 3. Build and Verify the Installer

```powershell
npm run build:win
```

This command:

1. validates and filters packaged extensions;
2. creates `appbuild/win-unpacked/`;
3. copies the Chromium runtime separately to avoid transient Windows locks on large files;
4. verifies ASAR, native host, Chromium, Clash Mini, icon, and extension resources;
5. creates the x64 NSIS installer from the verified directory.

Outputs are written to `appbuild/`. You can also use `build.bat`, but it assumes a download proxy at `127.0.0.1:7897`; verify or edit that port first.

Other build commands:

```powershell
npm run build:portable
npm run check:packaged-runtime
```

`build:win` is the recommended release path. `check:packaged-runtime` rechecks an existing `appbuild/win-unpacked` directory.

## Tests and Checks

Run the repository-level Node tests with:

```powershell
node --test "test/*.test.js"
```

Frequently used focused checks:

```powershell
npm run check:browser-runtime
npm run check:browser-settings
npm run check:extension-compat
npm run check:extension-refresh
npm run check:chromium-handshake
npm run check:chromium-embedded-policy
```

Electron acceptance scripts that exercise real windows, input, or sessions may launch both the application and Chromium. Close any running AI-FREE instance before executing them.

## Repository Layout

```text
app2.1/
├─ docs/                         # HTTP/TCP, updater, and proxy-resource notes
├─ native/
│  ├─ browser-host/              # N-API Win32 Chromium window host
│  └─ chromium-fork/             # Chromium version lock, patches, and build scripts
├─ resources/
│  ├─ chromium/                  # Staged AI-FREE Chromium runtime
│  └─ clash-mini/core/           # Mihomo core and local Geo/rule assets
├─ scripts/                      # Launch, build, smoke-test, and acceptance helpers
├─ src/
│  ├─ app/
│  │  ├─ main/                   # Electron main process, IPC, services, and browser runtime
│  │  ├─ renderer/               # Top tab bar and application-shell renderer
│  │  ├─ sidebar/                # AI control, account, proxy, and browser-settings UI
│  │  ├─ shared/                 # Utilities shared across processes
│  │  └─ views/                  # Application-shell HTML
│  └─ assets/extensions/         # Extensions packaged and injected into Chromium
├─ test/                         # Node regression tests
├─ package.json                  # npm scripts and Electron Builder configuration
└─ platforms-config.json         # Platform, service, extension, and product configuration
```

### Key Entry Points

- `src/app/main/main.js`: Electron entry point.
- `src/app/main/bootstrap.js`: main-process composition and application lifecycle.
- `src/app/main/browser-runtime/`: Chromium launch, handshake, profiles, and window bridge.
- `src/app/main/services/tab-manager.js`: browser-environment and top-tab lifecycle.
- `src/app/main/services/extension-manager.js`: extension discovery, loading, and refresh.
- `src/app/main/services/browser-automation-bridge.js`: local AI automation bridge.
- `src/app/main/ipc/`: IPC between the sidebar and main process.
- `scripts/build-windows.js`: official Windows build, resource staging, and verification.

## Related Documentation

- [HTTP request protocol](docs/api/HTTP请求说明.md)
- [Automatic update messages](docs/api/自动更新消息说明.md)
- [Clash Mini Geo localization specification](docs/clash-mini-geo-localization-spec.md)
- [Chromium Fork build guide](native/chromium-fork/README.md)
- [Native browser host](native/browser-host/README.md)
- [AI automation and MCP tools](docs/mcp.md)

## Security and Data

- The local automation bridge listens only on `127.0.0.1`; do not expose it to a LAN or the public internet.
- Browser profiles, cookies, account records, and automation cards may contain sensitive data. Do not commit or casually share them.
- Inject browser-level Google sign-in/sync credentials through environment variables. Never store them in source code, patches, or configuration files.
- Use automation, proxy, and web-content processing features in accordance with applicable law and target-site terms.

## License

ISC
