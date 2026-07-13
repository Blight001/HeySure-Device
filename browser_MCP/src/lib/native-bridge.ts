// Windows native-input bridge client.
//
// The browser_MCP_win build keeps the extension as a read-only DOM sensor. Any
// state-changing pointer/keyboard gesture is posted to the loopback-only bridge
// hosted by device/windows. The ordinary browser_MCP build compiles this module
// too, but never calls it because its build flag is false.

export const WINDOWS_NATIVE_BRIDGE_URL = 'http://127.0.0.1:38473'

export interface NativeViewportMetrics {
  screenX: number
  screenY: number
  outerWidth: number
  outerHeight: number
  innerWidth: number
  innerHeight: number
  devicePixelRatio: number
  visualScale: number
  pageZoom: number
  screen: {
    left: number
    top: number
    width: number
    height: number
    availLeft: number
    availTop: number
    availWidth: number
    availHeight: number
  }
}

export interface NativePoint {
  x: number
  y: number
}

export interface NativeBrowserContext {
  tab: {
    id?: number
    windowId?: number
    title?: string
    url?: string
    active?: boolean
  }
  window?: {
    id?: number
    left?: number
    top?: number
    width?: number
    height?: number
    focused?: boolean
    state?: string
  }
  viewport?: NativeViewportMetrics
}

export interface NativeInputRequest extends NativeBrowserContext {
  version: 1
  action: 'click' | 'scroll' | 'type' | 'key' | 'drag' | 'navigate' | 'dismiss_dialog'
  point?: NativePoint
  toPoint?: NativePoint
  button?: 'left' | 'right' | 'middle'
  double?: boolean
  direction?: 'up' | 'down' | 'top' | 'bottom'
  amount?: number
  text?: string
  clearFirst?: boolean
  submit?: boolean
  key?: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  meta?: boolean
  repeat?: number
  newTab?: boolean
  target?: Record<string, any>
}

export function windowsNativeInputEnabled(): boolean {
  return __HEYSURE_WINDOWS_NATIVE_INPUT__
}

function bridgeError(status: number, data: any): Error {
  const message = data?.error || data?.message || `Windows native bridge returned HTTP ${status}`
  const error: any = new Error(message)
  error.code = data?.code || 'WINDOWS_NATIVE_BRIDGE_FAILED'
  error.details = data
  return error
}

export async function sendNativeInput(request: NativeInputRequest): Promise<any> {
  if (!windowsNativeInputEnabled()) {
    throw new Error('Windows native input is not enabled in this extension build')
  }

  let response: Response
  try {
    response = await fetch(`${WINDOWS_NATIVE_BRIDGE_URL}/v1/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch (err: any) {
    const error: any = new Error(`无法连接 Windows 原生输入桥 ${WINDOWS_NATIVE_BRIDGE_URL}：${err?.message || err}`)
    error.code = 'WINDOWS_NATIVE_BRIDGE_OFFLINE'
    throw error
  }

  const data = await response.json().catch(() => ({}))
  if (!response.ok || data?.success === false) throw bridgeError(response.status, data)
  return data
}
