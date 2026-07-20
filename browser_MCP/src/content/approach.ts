// content/approach.ts — shared “enter page → glide → hover” prep for all
// interactive browser controls. Extracted so actions and popups can share it
// without a circular import.

import { dispatchPointerMove, hoverLikeUser } from './dom'
import {
  fxToElement, fxMoveTo, fxSleep, isFxEnabled, getFxPos, fxHoverOn, fxPrimeBrowser,
} from './fx'
import { FrameContext, ownerWindow, toTopViewportPoint } from './iframe'

function topViewportPoint(x: number, y: number, frame?: FrameContext): { x: number; y: number } {
  return frame ? toTopViewportPoint(x, y, frame) : { x, y }
}

/**
 * Before every interactive browser control: enter the page with the virtual
 * cursor, auto-glide toward the target, and fire real hover/mousemove events so
 * menus, tooltips and CSS :hover behave like a human operator.
 *
 * `x`/`y` are in the element's own viewport (frame-local when inside an iframe).
 * Visual FX uses top-page coordinates when a frame offset is present.
 */
export async function approachPointer(
  el: Element | null,
  x: number,
  y: number,
  frame?: FrameContext,
): Promise<void> {
  await fxPrimeBrowser()

  const win = el ? ownerWindow(el) : window
  const top = topViewportPoint(x, y, frame)
  let lastHit: Element | null = null
  const emitLocal = (lx: number, ly: number) => {
    lastHit = dispatchPointerMove(lx, ly, lastHit, win)
  }

  if (frame) {
    // Cross-frame: visual path uses top coords; DOM events stay frame-local.
    if (el) await fxToElement(el, top)
    else if (isFxEnabled()) await fxMoveTo(top.x, top.y)
    emitLocal(x, y)
  } else if (isFxEnabled()) {
    // Glide the hand cursor while emitting mousemove samples along the path.
    if (el) {
      await fxToElement(el, undefined, { onStep: (cx, cy) => emitLocal(cx, cy) })
    } else {
      await fxMoveTo(x, y, { onStep: (cx, cy) => emitLocal(cx, cy) })
    }
  } else {
    // FX off: still step synthetic moves so hover-gated UIs wake up.
    const from = getFxPos()
    const startX = from.x || win.innerWidth / 2
    const startY = from.y || win.innerHeight / 2
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      const t = i / steps
      const ease = 1 - Math.pow(1 - t, 3)
      emitLocal(startX + (x - startX) * ease, startY + (y - startY) * ease)
      await fxSleep(14)
    }
  }

  if (el) {
    hoverLikeUser(el, { x, y })
    if (isFxEnabled()) fxHoverOn(el)
  } else {
    emitLocal(x, y)
  }
  // Brief dwell so CSS transitions / JS hover menus can open before click.
  await fxSleep(isFxEnabled() ? 100 : 35)
  // Leave the hand cursor parked on the target; do not auto-hide after approach.
}
