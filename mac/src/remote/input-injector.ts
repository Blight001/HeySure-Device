// Main-process input injection for desktop remote control. Translates the
// normalized pointer / keyboard events that arrive over the WebRTC control
// DataChannel into real OS input via robotjs.
//
// Coordinates are normalized to [0,1] of the screen so the browser never needs
// the device's pixel size; we scale by robotjs's own screen size, which is the
// same coordinate space the screenshot pipeline uses (see capture-bridge.ts),
// so a click lands where the operator aimed regardless of DPI scaling.

import { clipboard } from 'electron'
import { getRobot } from '../tools/shared/robot'
import { sendActivityLog } from '../services/activity-log'

// Log the input path once so a silent failure (robotjs not rebuilt for Electron,
// or input never arriving) is visible in the desktop app's activity log.
let robotWarned = false
let injectedOnce = false

type MouseButton = 'left' | 'right' | 'middle'

export interface RcInputEvent {
  type: 'move' | 'down' | 'up' | 'click' | 'scroll' | 'key' | 'text'
  x?: number
  y?: number
  button?: MouseButton
  double?: boolean
  dx?: number
  dy?: number
  // keyboard
  key?: string
  action?: 'down' | 'up' | 'tap'
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
  meta?: boolean
  text?: string
}

const VALID_BUTTONS: MouseButton[] = ['left', 'right', 'middle']

function button(value: unknown): MouseButton {
  return VALID_BUTTONS.includes(value as MouseButton) ? (value as MouseButton) : 'left'
}

/** Map a browser ``KeyboardEvent.key`` to a robotjs key name. Printable single
 *  characters pass through lower-cased; named keys are translated. */
function robotKey(key: string): string | null {
  if (!key) return null
  if (key.length === 1) return key.toLowerCase()
  const map: Record<string, string> = {
    Enter: 'enter', Tab: 'tab', Backspace: 'backspace', Delete: 'delete',
    Escape: 'escape', ' ': 'space', Spacebar: 'space',
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Home: 'home', End: 'end', PageUp: 'pageup', PageDown: 'pagedown',
    Control: 'control', Alt: 'alt', Shift: 'shift', Meta: 'command',
    CapsLock: 'caps_lock', Insert: 'insert',
    F1: 'f1', F2: 'f2', F3: 'f3', F4: 'f4', F5: 'f5', F6: 'f6',
    F7: 'f7', F8: 'f8', F9: 'f9', F10: 'f10', F11: 'f11', F12: 'f12',
  }
  return map[key] || null
}

function modifiers(event: RcInputEvent): string[] {
  const mods: string[] = []
  if (event.ctrl) mods.push('control')
  if (event.alt) mods.push('alt')
  if (event.shift) mods.push('shift')
  if (event.meta) mods.push('command')
  return mods
}

/** Apply one input event. Never throws into the caller — a bad event must not
 *  tear down the control session. */
export function injectInput(event: RcInputEvent): void {
  let robot: any
  try {
    robot = getRobot()
  } catch (err: any) {
    if (!robotWarned) {
      robotWarned = true
      sendActivityLog(
        'remote-control', 'error',
        'robotjs 不可用，远程控制无法注入鼠标/键盘：请在 device/windows 执行 npm run rebuild 后重启',
        { error: String(err?.message || err) },
      )
    }
    return
  }
  if (!injectedOnce) {
    injectedOnce = true
    sendActivityLog('remote-control', 'success', '已收到远程控制输入，开始注入鼠标/键盘')
  }
  try {
    robot.setMouseDelay?.(0)
    const screen = robot.getScreenSize()
    const px = (n?: number) => Math.round(Math.max(0, Math.min(1, Number(n) || 0)) * screen.width)
    const py = (n?: number) => Math.round(Math.max(0, Math.min(1, Number(n) || 0)) * screen.height)

    switch (event.type) {
      case 'move':
        robot.moveMouse(px(event.x), py(event.y))
        break
      case 'down':
        robot.moveMouse(px(event.x), py(event.y))
        robot.mouseToggle('down', button(event.button))
        break
      case 'up':
        robot.moveMouse(px(event.x), py(event.y))
        robot.mouseToggle('up', button(event.button))
        break
      case 'click':
        robot.moveMouse(px(event.x), py(event.y))
        robot.mouseClick(button(event.button), !!event.double)
        break
      case 'scroll':
        // Browser wheel deltas are pixels (positive = down); robotjs takes
        // discrete steps, so scale down and invert Y to match natural scroll.
        robot.scrollMouse(
          Math.round((Number(event.dx) || 0) / -40),
          Math.round((Number(event.dy) || 0) / -40),
        )
        break
      case 'key': {
        const key = robotKey(String(event.key || ''))
        if (!key) break
        const mods = modifiers(event)
        if (event.action === 'down') robot.keyToggle(key, 'down', mods)
        else if (event.action === 'up') robot.keyToggle(key, 'up', mods)
        else robot.keyTap(key, mods)
        break
      }
      case 'text':
        // Only IME-composed text (e.g. 中文) reaches here — plain ASCII is typed
        // natively via key down/up. robotjs.typeString is unreliable for CJK, so
        // paste through the clipboard instead and restore the prior contents.
        if (event.text) {
          const previous = clipboard.readText()
          clipboard.writeText(String(event.text))
          robot.keyTap('v', 'control')
          setTimeout(() => {
            try { clipboard.writeText(previous) } catch { /* ignore */ }
          }, 250)
        }
        break
    }
  } catch {
    // robotjs unavailable or a transient injection failure — drop this event.
  }
}
