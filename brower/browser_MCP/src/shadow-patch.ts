// shadow-patch.ts — runs in the page's MAIN world at document_start.
//
// Closed shadow roots (`attachShadow({ mode: 'closed' })`) are invisible to our
// content-script observer: from any JS context `host.shadowRoot` returns null,
// so enumerateScanRoots() can never walk into them. Real sites use closed roots
// for whole interactive widgets — e.g. Xiaohongshu's <xhs-publish-btn> wraps its
// 发布 / 暂存 buttons in a closed root, which is why browser_observe "can't see"
// the publish button.
//
// We force every shadow root open. Once `host.shadowRoot` is non-null the
// existing observer (content/observe.ts `add(el.shadowRoot)`) picks the contents
// up automatically, with no other code change. This must run in the MAIN world
// (the page's own realm — patching Element.prototype from the isolated content
// world has no effect on page-created elements) and at document_start, before
// the page defines/upgrades its custom elements.
;(() => {
  const proto = Element.prototype as any
  if (proto.__heysureShadowPatched) return
  const native = proto.attachShadow
  if (typeof native !== 'function') return

  proto.attachShadow = function (init?: ShadowRootInit) {
    const opts: ShadowRootInit = { ...(init || ({} as ShadowRootInit)), mode: 'open' }
    return native.call(this, opts)
  }
  proto.__heysureShadowPatched = true
})()

// browser_MCP_win safety guard — also runs in MAIN world before site scripts.
// Content settings cover standard Chrome permission prompts; these wrappers
// cover picker/device APIs that contentSettings does not expose and page-owned
// modal functions that would freeze the agent's content-script request.
;(() => {
  if (!__HEYSURE_WINDOWS_NATIVE_INPUT__) return
  const root = window as any
  if (root.__heysureDialogSafetyInstalled) return
  root.__heysureDialogSafetyInstalled = true

  const blocked = (feature: string) =>
    Promise.reject(new DOMException(`HeySure blocked ${feature} to keep browser automation interactive`, 'NotAllowedError'))
  const replace = (target: any, name: string, value: (...args: any[]) => any) => {
    if (!target || typeof target[name] !== 'function') return
    try {
      Object.defineProperty(target, name, { value, configurable: true, writable: true })
    } catch {
      try { target[name] = value } catch { /* browser-owned non-writable API */ }
    }
  }

  // Page-owned synchronous dialogs block the renderer and therefore block the
  // extension message that would otherwise close them. Cancel them safely.
  replace(root, 'alert', () => undefined)
  replace(root, 'confirm', () => false)
  replace(root, 'prompt', () => null)
  replace(root, 'print', () => undefined)

  // File/directory pickers and programmatic <input type=file>.click(). Explicit
  // browser_file_upload remains available because it assigns File objects
  // directly and never opens a native picker.
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    replace(root, name, () => blocked(name))
  }
  const inputProto = root.HTMLInputElement?.prototype
  if (inputProto && typeof inputProto.click === 'function' && !inputProto.__heysureFileClickGuard) {
    const nativeInputClick = inputProto.click
    inputProto.click = function (...args: any[]) {
      if (String(this?.type || '').toLowerCase() === 'file') return undefined
      return nativeInputClick.apply(this, args)
    }
    inputProto.__heysureFileClickGuard = true
  }

  // Device/picker APIs that can open browser chrome or operating-system UI.
  const guardedRequests: Array<[any, string, string]> = [
    [(navigator as any).usb, 'requestDevice', 'USB device picker'],
    [(navigator as any).bluetooth, 'requestDevice', 'Bluetooth device picker'],
    [(navigator as any).serial, 'requestPort', 'serial device picker'],
    [(navigator as any).hid, 'requestDevice', 'HID device picker'],
    [(navigator as any).mediaDevices, 'getUserMedia', 'camera/microphone permission'],
    [(navigator as any).mediaDevices, 'getDisplayMedia', 'screen sharing picker'],
    [(navigator as any).mediaDevices, 'selectAudioOutput', 'audio output picker'],
    [navigator as any, 'requestMIDIAccess', 'MIDI device permission'],
  ]
  for (const [target, name, feature] of guardedRequests) {
    replace(target, name, () => blocked(feature))
  }

  replace(root.Notification, 'requestPermission', () => Promise.resolve('denied'))
  replace(root.Element?.prototype, 'requestFullscreen', () => blocked('fullscreen'))
  replace(root.Element?.prototype, 'requestPointerLock', () => blocked('pointer lock'))
  replace((navigator as any).keyboard, 'lock', () => blocked('keyboard lock'))

  // Cancel WebAuthn/security-key prompts while leaving password credentials
  // alone. Some sites use navigator.credentials for ordinary login state.
  const credentials = (navigator as any).credentials
  for (const name of ['get', 'create']) {
    const native = credentials?.[name]
    if (typeof native !== 'function') continue
    replace(credentials, name, (options?: any) =>
      options?.publicKey ? blocked('WebAuthn/security key prompt') : native.call(credentials, options))
  }

  // Suppress "Leave site?" blockers. The capture listener is registered before
  // page code and stops later beforeunload handlers from setting returnValue.
  // Also make the legacy onbeforeunload property inert; this covers sites that
  // repeatedly replace the property handler after their application boots.
  try {
    Object.defineProperty(root, 'onbeforeunload', {
      configurable: false,
      enumerable: true,
      get: () => null,
      set: () => undefined,
    })
  } catch { /* the capture listener below remains the fallback */ }
  root.addEventListener('beforeunload', (event: BeforeUnloadEvent) => {
    event.stopImmediatePropagation()
    try { (event as any).returnValue = '' } catch {}
  }, true)
})()
