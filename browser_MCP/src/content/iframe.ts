// content/iframe.ts — helpers for observing and interacting with iframe content.
// Supports nested same-origin iframes: recursive scan, multi-level coordinate
// translation, and recursive hit-testing through iframe boundaries.

export interface FrameContext {
  frameEl: HTMLIFrameElement
  frameSelector: string
  doc: Document
  parent?: FrameContext
}

export interface ViewportRect {
  x: number
  y: number
  w: number
  h: number
}

export interface ViewportPoint {
  x: number
  y: number
}

function clampX(x: number, win: Window) { return Math.min(Math.max(x, 1), win.innerWidth - 1) }
function clampY(y: number, win: Window) { return Math.min(Math.max(y, 1), win.innerHeight - 1) }

// ── Cross-realm-safe type checks ────────────────────────────────────────────
// Elements inside a same-origin iframe belong to that frame window's realm, so
// a bare `instanceof HTMLElement` (the *top* window's constructor) is always
// false for them. Those bare checks silently filtered out every element found
// inside same-origin iframes — the scan reached the frame document but reported
// zero candidates/texts. Always use these helpers on nodes that may come from a
// frame document.

export function isElement(el: unknown): el is Element {
  return !!el && typeof el === 'object' && (el as Node).nodeType === 1
}

export function isHTMLElement(el: unknown): el is HTMLElement {
  if (el instanceof HTMLElement) return true  // fast path: same realm
  if (!isElement(el)) return false
  const win: any = el.ownerDocument?.defaultView
  return !!win && typeof win.HTMLElement === 'function' && el instanceof win.HTMLElement
}

export function isFrameElement(el: unknown): el is HTMLIFrameElement {
  if (!isElement(el)) return false
  const tag = el.tagName
  return tag === 'IFRAME' || tag === 'FRAME'
}

export function isVisibleInOwnerViewport(el: HTMLElement): boolean {
  const s = getComputedStyle(el)
  if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false
  const r = el.getBoundingClientRect()
  const win = el.ownerDocument?.defaultView || window
  return r.width > 0 && r.height > 0 && r.bottom >= 0 && r.right >= 0
    && r.top <= win.innerHeight && r.left <= win.innerWidth
}

export function listIframeElementsIn(doc: Document): HTMLIFrameElement[] {
  return Array.from(doc.querySelectorAll('iframe,frame'))
    .filter((el): el is HTMLIFrameElement => isFrameElement(el) && isVisibleInOwnerViewport(el))
}

export function listIframeElements(): HTMLIFrameElement[] {
  return listIframeElementsIn(document)
}

export function tryFrameContext(frameEl: HTMLIFrameElement): { frameEl: HTMLIFrameElement; doc: Document } | null {
  try {
    const doc = frameEl.contentDocument
    if (!doc?.documentElement) return null
    return { frameEl, doc }
  } catch {
    return null
  }
}

export function scanRoot(doc: Document): ParentNode {
  return doc.body || doc.documentElement
}

export function buildFramePath(frame?: FrameContext): string[] {
  const path: string[] = []
  let cur = frame
  while (cur) {
    path.unshift(cur.frameSelector)
    cur = cur.parent
  }
  return path
}

export function resolveFrameByPath(path: string[]): FrameContext | null {
  if (!path.length) return null
  let doc = document
  let parent: FrameContext | undefined
  let resolved: FrameContext | null = null

  for (const frameSelector of path) {
    const frameEl = doc.querySelector(frameSelector)
    if (!isFrameElement(frameEl)) return null
    const base = tryFrameContext(frameEl)
    if (!base) return null
    resolved = { ...base, frameSelector, parent }
    parent = resolved
    doc = base.doc
  }

  return resolved
}

export function visitAccessibleFrames(
  onFrame: (ctx: FrameContext) => void,
  attachSelector: (frameEl: HTMLIFrameElement) => string,
  doc: Document = document,
  parent?: FrameContext,
): void {
  for (const frameEl of listIframeElementsIn(doc)) {
    const base = tryFrameContext(frameEl)
    if (!base) continue
    const ctx: FrameContext = {
      ...base,
      frameSelector: attachSelector(frameEl),
      parent,
    }
    onFrame(ctx)
    visitAccessibleFrames(onFrame, attachSelector, base.doc, ctx)
  }
}

export function getAccessibleFrames(attachSelector: (frameEl: HTMLIFrameElement) => string): FrameContext[] {
  const out: FrameContext[] = []
  visitAccessibleFrames(ctx => out.push(ctx), attachSelector)
  return out
}

// Translate a point in a frame's local viewport space to the top page's
// viewport space by accumulating every ancestor iframe's offset. CDP input
// dispatch and the fx cursor overlay both live in top-page coordinates, while
// getBoundingClientRect / elementFromPoint inside a frame are frame-local.
export function toTopViewportPoint(localX: number, localY: number, frame?: FrameContext): ViewportPoint {
  let x = localX
  let y = localY
  let cur = frame
  while (cur) {
    const fr = cur.frameEl.getBoundingClientRect()
    x += fr.left
    y += fr.top
    cur = cur.parent
  }
  return { x: Math.round(x), y: Math.round(y) }
}

export function toTopViewportRect(local: DOMRect, frame?: FrameContext): ViewportRect {
  const topLeft = toTopViewportPoint(local.left, local.top, frame)
  return {
    x: topLeft.x,
    y: topLeft.y,
    w: Math.round(local.width),
    h: Math.round(local.height),
  }
}

export function toTopViewportCenter(local: DOMRect, frame?: FrameContext): ViewportPoint {
  return toTopViewportPoint(local.left + local.width / 2, local.top + local.height / 2, frame)
}

export function ownerWindow(el: Element): Window {
  return el.ownerDocument?.defaultView || window
}

export function elementViewportRect(el: HTMLElement, frame?: FrameContext): ViewportRect {
  return toTopViewportRect(el.getBoundingClientRect(), frame)
}

export function elementViewportCenter(el: HTMLElement, frame?: FrameContext): ViewportPoint {
  return toTopViewportCenter(el.getBoundingClientRect(), frame)
}

export interface ViewportHit {
  el: Element
  frame?: FrameContext
  viewportX: number
  viewportY: number
  localX: number
  localY: number
}

function hitAtPoint(
  doc: Document,
  win: Window,
  x: number,
  y: number,
  topViewportX: number,
  topViewportY: number,
  frame?: FrameContext,
): ViewportHit | null {
  const lx = clampX(x, win)
  const ly = clampY(y, win)
  let hit = doc.elementFromPoint(lx, ly)
  if (!hit) return null

  // Pierce shadow roots: elementFromPoint() returns the shadow *host*, not the
  // inner element actually painted at the point (shadow-DOM retargeting). Without
  // this, controls inside a shadow root (e.g. Xiaohongshu's <xhs-publish-btn>)
  // fail the hittable test and get wrongly flagged blocked/red. shadow-patch.ts
  // forces closed roots open, so shadowRoot is readable here.
  while (hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(lx, ly)
    if (!inner || inner === hit) break
    hit = inner
  }

  if (hit.tagName === 'IFRAME' || hit.tagName === 'FRAME') {
    const frameEl = hit as HTMLIFrameElement
    const base = tryFrameContext(frameEl)
    const fr = frameEl.getBoundingClientRect()
    const childX = lx - fr.left
    const childY = ly - fr.top
    if (!base) {
      return { el: frameEl, frame, viewportX: topViewportX, viewportY: topViewportY, localX: lx, localY: ly }
    }
    const childWin = base.doc.defaultView || win
    const childCtx: FrameContext = {
      ...base,
      frameSelector: '',
      parent: frame,
    }
    const deeper = hitAtPoint(base.doc, childWin, childX, childY, topViewportX, topViewportY, childCtx)
    if (deeper) return deeper
    return { el: frameEl, frame: childCtx, viewportX: topViewportX, viewportY: topViewportY, localX: childX, localY: childY }
  }

  return { el: hit, frame, viewportX: topViewportX, viewportY: topViewportY, localX: lx, localY: ly }
}

export function hitTargetAtViewport(x: number, y: number): ViewportHit | null {
  const vx = clampX(x, window)
  const vy = clampY(y, window)
  return hitAtPoint(document, window, vx, vy, vx, vy)
}

export function isTopmostAtViewport(el: Element, viewportX: number, viewportY: number): boolean {
  const hit = hitTargetAtViewport(viewportX, viewportY)
  if (!hit) return false
  const target = hit.el
  if (target === el) return true
  const doc = el.ownerDocument
  if (target.ownerDocument === doc) {
    return el.contains(target) || target.contains(el)
  }
  return false
}

export function isFrameChainVisible(frame?: FrameContext): boolean {
  let cur = frame
  while (cur) {
    if (!isVisibleInOwnerViewport(cur.frameEl)) return false
    cur = cur.parent
  }
  return true
}

export function isCenterOnMainViewport(frame: FrameContext, el: HTMLElement): boolean {
  const center = elementViewportCenter(el, frame)
  return center.x >= 0 && center.y >= 0
    && center.x <= window.innerWidth && center.y <= window.innerHeight
}

/** Relaxed interactable check for iframe content when strict top-most hit-test is flaky. */
export function isLikelyInteractableInFrame(el: HTMLElement, frame: FrameContext): boolean {
  if (!isVisibleInOwnerViewport(el)) return false
  if (!isFrameChainVisible(frame)) return false
  if (getComputedStyle(el).pointerEvents === 'none') return false
  if (!isCenterOnMainViewport(frame, el)) return false
  if (isHittableInViewport(el, frame)) return true
  const center = elementViewportCenter(el, frame)
  const hit = hitTargetAtViewport(center.x, center.y)
  if (!hit) return false
  if (hit.el.ownerDocument === el.ownerDocument) {
    return hit.el === el || el.contains(hit.el) || hit.el.contains(el)
  }
  return true
}

export function isHittableInViewport(el: HTMLElement, frame?: FrameContext): boolean {
  if (!isVisibleInOwnerViewport(el)) return false
  if (frame && !isFrameChainVisible(frame)) return false
  if (getComputedStyle(el).pointerEvents === 'none') return false

  const local = el.getBoundingClientRect()
  const sampleLocal: Array<[number, number]> = [
    [local.left + local.width / 2, local.top + local.height / 2],
    [local.left + local.width / 2, local.top + Math.min(local.height * 0.2, 6)],
    [local.left + local.width * 0.2, local.top + local.height / 2],
    [local.left + local.width * 0.8, local.top + local.height / 2],
  ]

  const pts = frame
    ? sampleLocal.map(([lx, ly]) => {
      const p = toTopViewportPoint(lx, ly, frame)
      return [p.x, p.y] as [number, number]
    })
    : sampleLocal

  return pts.some(([px, py]) => isTopmostAtViewport(el, px, py))
}

export function occluderAtViewport(el: HTMLElement, frame?: FrameContext): Element | null {
  const center = elementViewportCenter(el, frame)
  const hit = hitTargetAtViewport(center.x, center.y)
  if (!hit) return null
  const cover = hit.el
  if (cover === el) return null
  if (cover.ownerDocument === el.ownerDocument && (el.contains(cover) || cover.contains(el))) return null
  return cover
}

export function resolveFrameBySelector(frameSelector?: string, framePath?: string[]): FrameContext | null {
  const path = framePath?.length ? framePath : (frameSelector ? [frameSelector] : [])
  return resolveFrameByPath(path)
}