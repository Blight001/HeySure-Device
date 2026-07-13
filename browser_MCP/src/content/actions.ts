// content/actions.ts — page-action handlers (click, type, scroll, …).
// Each function is invoked by content/index.ts in response to a chrome.runtime
// message from the background worker, and returns the JSON that browser.ts
// forwards back to the AI / popup.

import { findEl, resolveTarget, elCenter, isVisible, isHittable, occluderOf, textMatches, textOf, cssPath, clickLikeUser } from './dom'
import {
  fxToElement, fxClickAt, fxSleep, fxDragPath, fxScrollDrag, isFxEnabled, getFxPos,
  fxHoverOn, fxScreenshotBefore, fxScreenshotAfter, fxScreenshotClear,
} from './fx'
import { FrameContext, ownerWindow, toTopViewportPoint } from './iframe'
import { viewportContext, waitScrollSettle } from './viewport'

// Coordinates resolved for an element inside a same-origin iframe are local to
// that frame's viewport. Anything that lives in the *top* page's coordinate
// space — the CDP trusted click (resolveOnly), the fx cursor overlay — needs the
// translated point; synthetic events dispatched to the element itself keep the
// frame-local clientX/clientY a real user gesture would carry.
function topViewportPoint(x: number, y: number, frame?: FrameContext): { x: number; y: number } {
  return frame ? toTopViewportPoint(x, y, frame) : { x, y }
}

// ── Click ─────────────────────────────────────────────────────────────────
export async function doClick(msg: any) {
  // viaCoords = an explicit point. document.elementFromPoint already returns the
  // top-most element painted there, so coordinate clicks target exactly what the
  // user would hit — no occlusion guard needed (and none possible).
  const viaCoords = msg.x !== undefined && msg.y !== undefined &&
    (msg.ref === undefined || msg.ref === null || msg.ref === '')
  let { el, x, y, frame } = resolveTarget(msg)

  if (!el) {
    if (msg.ref !== undefined && msg.ref !== null && msg.ref !== '') {
      throw new Error(`Mark #${msg.ref} is stale or gone — call browser_observe again to refresh the page marks, then retry.`)
    }
    throw new Error(`Element not found: selector=${msg.selector || ''} text=${msg.text || ''} ref=${msg.ref ?? ''} coords=${msg.x},${msg.y}`)
  }

  if (!viaCoords) {
    // Use an instant (not smooth) scroll: smooth scrolling keeps the element
    // moving while waitScrollSettle polls, so the occlusion hit-test below can
    // sample a point the target no longer occupies and report a false "occluded".
    el.scrollIntoView({ block: 'center', behavior: 'auto' })
    await waitScrollSettle(450)
    // The center captured by resolveTarget was measured *before* the scroll, so
    // it now points at the wrong place. Recompute from the post-scroll rect so
    // the dispatched pointer/mouse events (clientX/clientY) land on the target.
    const c = elCenter(el)
    x = c.x; y = c.y

    // Always focus for clicks
    try { (el as HTMLElement).focus?.() } catch {}

    if (!isVisible(el)) {
      return {
        success: false,
        not_visible: true,
        message: '目标元素存在于 DOM 中，但当前不可见（display:none / 尺寸为 0 / 在视口外）。它可能是背景或未展开的内容，用户此刻看不到，因此无法点击。',
        target: { tag: el.tagName, text: textOf(el, 80), selector: cssPath(el) },
      }
    }

    // Occlusion guard: if a popup/overlay/ad is painted over the target, dispatching
    // to the background element is exactly the "click failed / click conflict" the
    // user reported. Surface a clear diagnostic instead so the AI closes the cover
    // first. Pass force:true to click through deliberately.
    if (msg.force !== true && !isHittable(el, frame)) {
      const cover = occluderOf(el, frame)
      return {
        success: false,
        occluded: true,
        message: '目标被另一个元素遮挡（很可能是弹窗/遮罩/广告）。请先关闭遮挡层，或改用 browser_observe 后按编号点击最顶层元素；确需穿透点击可传 force:true。',
        target: { tag: el.tagName, text: textOf(el, 80), selector: cssPath(el) },
        occludedBy: cover ? { tag: cover.tagName, text: textOf(cover, 80), selector: cssPath(cover) } : null,
      }
    }
  }

  // resolveOnly: the background wants to drive the click through the CDP debugger
  // (a *trusted* mouse event that sites can't reject the way they reject our
  // synthetic dispatch). We've already scrolled the target into view and passed
  // the visibility/occlusion guards above, so just hand back the final viewport
  // coordinates and let background dispatch the real click. No events fired here.
  if (msg.resolveOnly) {
    // CDP dispatches at top-page coordinates; translate frame-local centers so a
    // trusted click on an element inside a same-origin iframe lands on it
    // instead of on whatever sits at those coordinates in the main page.
    const p = topViewportPoint(x, y, frame)
    return {
      success: true,
      resolved: true,
      x: p.x, y: p.y,
      tag: el.tagName,
      text: textOf(el, 100),
      selector: cssPath(el),
    }
  }

  if (isFxEnabled()) {
    if (!viaCoords) await fxSleep(220)   // let the smooth scroll settle before aiming
    const p = topViewportPoint(x, y, frame)
    await fxToElement(el, frame ? p : undefined)  // glide the virtual cursor to the element
    await fxClickAt(p.x, p.y)
    await fxSleep(80)
  }
  // clickLikeUser now always ensures focus + full hover events
  clickLikeUser(el, { x, y })
  const ctx = viewportContext()
  return {
    success: true,
    tag: el.tagName,
    text: (el as HTMLElement).innerText?.slice(0, 100) || textOf(el, 100),
    position: { scrollY: ctx.scrollY, scrollPercent: ctx.scrollPercent, currentSection: ctx.currentSection },
  }
}

// ── Double click ────────────────────────────────────────────────────────────
export async function doDoubleClick(msg: any) {
  const { el, frame } = resolveTarget(msg)
  if (!el) throw new Error(`Element not found: selector=${msg.selector || ''} text=${msg.text || ''} coords=${msg.x},${msg.y}`)
  el.scrollIntoView({ block: 'center', behavior: 'auto' })
  // Always do hover visual (if enabled) + focus before double click
  try { (el as HTMLElement).focus?.() } catch {}
  if (isFxEnabled()) { await fxSleep(220); const c0 = elCenter(el); const p = topViewportPoint(c0.x, c0.y, frame); await fxToElement(el, frame ? p : undefined); await fxClickAt(p.x, p.y, 'double'); await fxSleep(80) }
  const win = ownerWindow(el)
  const c = elCenter(el)
  const base = { bubbles: true, cancelable: true, view: win, clientX: c.x, clientY: c.y }
  const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  el.dispatchEvent(new PointerEvent('pointerover', pointer))
  el.dispatchEvent(new PointerEvent('pointerenter', pointer))
  el.dispatchEvent(new MouseEvent('mouseover', base))
  el.dispatchEvent(new MouseEvent('mouseenter', base))
  const opts = { ...base } as MouseEventInit
  el.dispatchEvent(new MouseEvent('mousedown', opts))
  el.dispatchEvent(new MouseEvent('mouseup', opts))
  el.dispatchEvent(new MouseEvent('click', { ...opts, detail: 1 }))
  el.dispatchEvent(new MouseEvent('mousedown', opts))
  el.dispatchEvent(new MouseEvent('mouseup', opts))
  el.dispatchEvent(new MouseEvent('click', { ...opts, detail: 2 }))
  el.dispatchEvent(new MouseEvent('dblclick', { ...opts, detail: 2 }))
  return { success: true, tag: el.tagName, text: (el as HTMLElement).innerText?.slice(0, 100) }
}

// ── Right click (context menu) ────────────────────────────────────────────────
export async function doRightClick(msg: any) {
  const { el, frame } = resolveTarget(msg)
  if (!el) throw new Error(`Element not found: selector=${msg.selector || ''} text=${msg.text || ''} coords=${msg.x},${msg.y}`)
  el.scrollIntoView({ block: 'center', behavior: 'auto' })
  // Always do hover visual (if enabled) + focus before right click
  try { (el as HTMLElement).focus?.() } catch {}
  if (isFxEnabled()) { await fxSleep(220); const c0 = elCenter(el); const p = topViewportPoint(c0.x, c0.y, frame); await fxToElement(el, frame ? p : undefined); await fxClickAt(p.x, p.y, 'right'); await fxSleep(80) }
  const win = ownerWindow(el)
  const c = elCenter(el)
  const base = { bubbles: true, cancelable: true, view: win, clientX: c.x, clientY: c.y, button: 2, buttons: 2 }
  const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }
  el.dispatchEvent(new PointerEvent('pointerover', pointer))
  el.dispatchEvent(new PointerEvent('pointerenter', pointer))
  el.dispatchEvent(new MouseEvent('mouseover', base))
  el.dispatchEvent(new MouseEvent('mouseenter', base))
  const opts = { ...base } as MouseEventInit
  el.dispatchEvent(new MouseEvent('mousedown', opts))
  el.dispatchEvent(new MouseEvent('mouseup', opts))
  el.dispatchEvent(new MouseEvent('contextmenu', opts))
  return { success: true, tag: el.tagName, text: (el as HTMLElement).innerText?.slice(0, 100) }
}

// ── Drag and drop ─────────────────────────────────────────────────────────────
function dragDiagnostics(src: Element | null, dst: Element | null, msg: any) {
  const describe = (el: Element | null) => {
    if (!el) return null
    const html = el as HTMLElement
    const r = html.getBoundingClientRect()
    const style = getComputedStyle(html)
    return {
      selector: cssPath(el),
      tag: el.tagName,
      text: textOf(el, 120),
      draggable: html.draggable || html.getAttribute('draggable') === 'true',
      role: html.getAttribute('role') || '',
      visible: isVisible(el),
      cursor: style.cursor,
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    }
  }
  return {
    source: describe(src),
    target: describe(dst),
    requested: {
      selector: msg.selector, text: msg.text, x: msg.x, y: msg.y,
      toSelector: msg.toSelector, toText: msg.toText, toX: msg.toX, toY: msg.toY,
    },
  }
}

export async function doDrag(msg: any) {
  const src = resolveTarget({ selector: msg.selector, text: msg.text, x: msg.x, y: msg.y })
  const dst = resolveTarget({ selector: msg.toSelector, text: msg.toText, x: msg.toX, y: msg.toY })
  if (!src.el && (msg.x === undefined)) {
    const diag = dragDiagnostics(src.el, dst.el, msg)
    throw new Error(`Drag source not found. diagnostics=${JSON.stringify(diag)}`)
  }
  if (!dst.el && (msg.toX === undefined)) {
    const diag = dragDiagnostics(src.el, dst.el, msg)
    throw new Error(`Drag target not found. diagnostics=${JSON.stringify(diag)}`)
  }
  if (src.el) src.el.scrollIntoView({ block: 'center', behavior: 'auto' })
  if (isFxEnabled()) await fxSleep(200)
  const s = src.el ? elCenter(src.el) : { x: src.x, y: src.y }
  const d = dst.el ? elCenter(dst.el) : { x: dst.x, y: dst.y }
  const before = src.el ? (src.el as HTMLElement).getBoundingClientRect() : null
  if (isFxEnabled()) await fxDragPath(s.x, s.y, d.x, d.y)

  const dt = (() => { try { return new DataTransfer() } catch { return null } })()
  const mk = (type: string, x: number, y: number, target: Element | null) => {
    if (!target) return
    const init: any = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }
    if (dt) init.dataTransfer = dt
    const ev = (type.startsWith('drag') || type === 'drop')
      ? new DragEvent(type, init)
      : new MouseEvent(type, init)
    target.dispatchEvent(ev)
  }
  // Pointer/mouse sequence (for libraries using mouse events)
  mk('pointerdown', s.x, s.y, src.el)
  mk('mousedown', s.x, s.y, src.el)
  // HTML5 native drag-and-drop sequence
  mk('dragstart', s.x, s.y, src.el)
  mk('drag', s.x, s.y, src.el)
  mk('mousemove', d.x, d.y, dst.el || src.el)
  mk('dragenter', d.x, d.y, dst.el)
  mk('dragover', d.x, d.y, dst.el)
  mk('drop', d.x, d.y, dst.el)
  mk('dragend', d.x, d.y, src.el)
  mk('pointerup', d.x, d.y, dst.el || src.el)
  mk('mouseup', d.x, d.y, dst.el || src.el)
  await fxSleep(80)
  const after = src.el ? (src.el as HTMLElement).getBoundingClientRect() : null
  const moved = before && after
    ? Math.abs(before.left - after.left) > 1 || Math.abs(before.top - after.top) > 1
    : false
  return {
    success: true,
    moved,
    warning: moved ? '' : 'Drag events were dispatched, but the source element did not visibly move. The page may require native browser/OS drag support or a framework-specific gesture.',
    from: { x: Math.round(s.x), y: Math.round(s.y) },
    to: { x: Math.round(d.x), y: Math.round(d.y) },
    diagnostics: dragDiagnostics(src.el, dst.el, msg),
  }
}

// ── Press key ─────────────────────────────────────────────────────────────────
export function doPressKey(msg: any) {
  const key = String(msg.key || '')
  if (!key) throw new Error('key is required')
  let el: Element | null = msg.selector ? findEl(msg.selector) : null
  if (!el) el = (document.activeElement && document.activeElement !== document.body) ? document.activeElement : document.body
  ;(el as HTMLElement).focus?.()
  const init: KeyboardEventInit = {
    key,
    code: /^[a-zA-Z]$/.test(key) ? `Key${key.toUpperCase()}` : key,
    bubbles: true,
    cancelable: true,
    ctrlKey: !!msg.ctrl,
    shiftKey: !!msg.shift,
    altKey: !!msg.alt,
    metaKey: !!msg.meta,
  }
  // type {submit:true}: prefer the form's native submission API and do not also
  // dispatch Enter to page listeners, which could submit the same form twice.
  if (msg.submit_form && key === 'Enter') {
    const form = (el as HTMLElement).closest?.('form') as HTMLFormElement | null
    if (form) {
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit()
        return { success: true, key, target: (el as HTMLElement).tagName, submit_method: 'form.requestSubmit' }
      }
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      return { success: true, key, target: (el as HTMLElement).tagName, submit_method: 'form.submitEvent' }
    }
  }
  el!.dispatchEvent(new KeyboardEvent('keydown', init))
  el!.dispatchEvent(new KeyboardEvent('keypress', init))
  el!.dispatchEvent(new KeyboardEvent('keyup', init))
  return { success: true, key, target: (el as HTMLElement).tagName, submit_method: 'content.KeyboardEvent' }
}

export function focusTarget(msg: any) {
  const selector = String(msg.selector || '')
  if (!selector) return { success: true, focused: false, reason: 'selector is empty' }
  const el = findEl(selector) as HTMLElement | null
  if (!el) throw new Error(`Element not found: ${selector}`)
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' })
  el.focus?.()
  return { success: true, focused: document.activeElement === el, target: el.tagName }
}

// ── Type ──────────────────────────────────────────────────────────────────
export async function doType(msg: any) {
  const selector   = msg.selector || 'input:focus, textarea:focus, [contenteditable]:focus'
  const text       = String(msg.text ?? '')
  const clearFirst = msg.clearFirst !== false

  // A ref (observe id) is the most reliable target and is what cross-origin-frame
  // typing relies on: the background routes the message into the owning frame and
  // resolveTarget re-finds the input there (self-healing via selector/text).
  const hasRef = msg.ref !== undefined && msg.ref !== null && msg.ref !== ''
  let el = hasRef ? resolveTarget(msg).el as HTMLInputElement | null : null
  if (!el) el = selector ? findEl(selector) as HTMLInputElement | null : null
  if (!el) el = document.activeElement as HTMLInputElement | null

  if (!el) throw new Error('No input element found — try providing a selector')

  if (isFxEnabled()) { await fxToElement(el); const p = getFxPos(); await fxClickAt(p.x, p.y) }
  el.focus()

  if (el.isContentEditable) {
    if (clearFirst) el.textContent = ''
    el.textContent += text
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    if (clearFirst) {
      el.value = ''
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    el.value += text
    el.dispatchEvent(new Event('input',  { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }

  if (msg.submit) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))

  return { success: true, text, length: text.length }
}

// ── Get content ───────────────────────────────────────────────────────────
export function getContent(msg: any) {
  const root = (msg.selector ? document.querySelector(String(msg.selector)) : document.body) as HTMLElement | null
  if (!root) throw new Error(`Element not found: ${msg.selector}`)

  const maxChars = Math.min(Math.max(Number(msg.max_chars ?? 8000), 200), 50000)
  const text = (root as HTMLElement).innerText?.slice(0, maxChars) || ''
  const links = Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))
    .slice(0, 50)
    .map(a => ({
      tag: 'A',
      selector: cssPath(a),
      text: textOf(a, 100),
      href: (a as HTMLAnchorElement).href,
      attributes: { href: (a as HTMLAnchorElement).href },
    }))
  const result: any = {
    success: true,
    source: 'browser_get_content',
    selector: msg.selector || 'body',
    url:   location.href,
    title: document.title,
    text,
    content: { text, html: msg.includeHtml ? (root as HTMLElement).innerHTML?.slice(0, 100000) : undefined },
    links,
    items: links,
    meta: {
      description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
      keywords:    document.querySelector('meta[name="keywords"]')?.getAttribute('content') || '',
    },
  }
  if (msg.includeHtml) result.html = (root as HTMLElement).innerHTML?.slice(0, 100000)
  return result
}

// ── Scroll ────────────────────────────────────────────────────────────────
function canScroll(el: HTMLElement, direction: string) {
  const max = el.scrollHeight - el.clientHeight
  if (max <= 2) return false
  if (direction === 'up') return el.scrollTop > 2
  if (direction === 'down') return el.scrollTop < max - 2
  return true
}

function scrollableElement(direction: string): HTMLElement | null {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>('*'))
    .filter(el => {
      const style = getComputedStyle(el)
      const overflowY = style.overflowY
      if (!/(auto|scroll|overlay)/.test(overflowY)) return false
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false
      return canScroll(el, direction)
    })
    .sort((a, b) => {
      const ar = a.getBoundingClientRect()
      const br = b.getBoundingClientRect()
      return (br.width * br.height) - (ar.width * ar.height)
    })
  return candidates[0] || null
}

function elementLabel(el: Element | null) {
  if (!el) return 'window'
  const html = el as HTMLElement
  if (html.id) return `#${html.id}`
  const cls = typeof html.className === 'string' ? html.className.trim().split(/\s+/)[0] : ''
  return cls ? `${html.tagName.toLowerCase()}.${cls}` : html.tagName.toLowerCase()
}

export async function doScroll(msg: any) {
  const amount = Number(msg.amount || 400)
  const beforeY = Math.round(window.scrollY)
  let target: HTMLElement | null = null
  let beforeElementY = 0

  if (msg.selector) {
    const el = findEl(msg.selector)
    if (!el) throw new Error(`Element not found: ${msg.selector}`)
    // Instant (not smooth) scrolling: smooth scroll is rAF-driven and never
    // advances in a hidden/background tab, leaving the page where it was. 'auto'
    // jumps immediately so the scroll lands regardless of tab visibility.
    el.scrollIntoView({ block: 'center', behavior: 'auto' })
  } else {
    switch (msg.direction) {
      case 'up':     window.scrollBy({ top: -amount, behavior: 'auto' }); break
      case 'down':   window.scrollBy({ top: amount,  behavior: 'auto' }); break
      case 'top':    window.scrollTo({ top: 0,                  behavior: 'auto' }); break
      case 'bottom': window.scrollTo({ top: document.body.scrollHeight, behavior: 'auto' }); break
      default: throw new Error(`Unknown scroll direction: ${msg.direction}`)
    }
  }
  void fxScrollDrag(msg.direction, amount)   // visual "grab & pull" feedback (parallel with scroll)
  await waitScrollSettle()

  let ctx = viewportContext()
  let pageScrolledBy = ctx.scrollY - beforeY
  let elementScrolledBy = 0

  if (!msg.selector && pageScrolledBy === 0 && !ctx.atTop && !ctx.atBottom) {
    const delta = msg.direction === 'up' ? -amount : amount
    target = scrollableElement(msg.direction)
    if (target) {
      beforeElementY = target.scrollTop
      target.scrollBy({ top: delta, behavior: 'auto' })
      elementScrolledBy = Math.round(target.scrollTop - beforeElementY)
      await waitScrollSettle(250)
      ctx = viewportContext()
      pageScrolledBy = ctx.scrollY - beforeY
    }
  }

  const scrolledBy = pageScrolledBy || elementScrolledBy
  return {
    success: true,
    direction: msg.direction,
    requestedAmount: amount,
    scrolledBy,                          // actual pixels moved (0 = nothing happened)
    pageScrolledBy,
    elementScrolledBy,
    scrollTarget: msg.selector ? msg.selector : elementLabel(target),
    reachedEdge: ctx.atTop ? 'top' : (ctx.atBottom ? 'bottom' : null),
    ...ctx,
  }
}

// ── Wait ──────────────────────────────────────────────────────────────────
export async function doWait(msg: any) {
  if (msg.ms) {
    await new Promise(r => setTimeout(r, Math.min(Number(msg.ms), 10000)))
    return { success: true, waited_ms: msg.ms }
  }
  if (msg.selector) {
    const start = Date.now()
    await new Promise<void>((resolve, reject) => {
      // rAF is paused in background tabs, so the old requestAnimationFrame poll
      // never fired when the page wasn't the foreground tab and every wait timed
      // out. MutationObserver keeps firing in hidden tabs, so we react to DOM
      // changes and keep a slow setTimeout poll as a backstop for matches that
      // don't surface as observed mutations (e.g. layout-driven :visible checks).
      let observer: MutationObserver | null = null
      let pollTimer: ReturnType<typeof setTimeout> | null = null
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`Element "${msg.selector}" not found after 10s`)) }, 10000)
      function cleanup() {
        clearTimeout(timeout)
        if (pollTimer) clearTimeout(pollTimer)
        if (observer) observer.disconnect()
      }
      function check(): boolean {
        if (findEl(msg.selector)) { cleanup(); resolve(); return true }
        return false
      }
      function poll() { if (!check()) pollTimer = setTimeout(poll, 250) }
      if (check()) return
      observer = new MutationObserver(() => { check() })
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })
      poll()
    })
    return { success: true, selector: msg.selector, waited_ms: Date.now() - start }
  }
  return { success: true, waited_ms: 0 }
}

// ── Await settle (auto-observe support) ─────────────────────────────────────
// After an interaction (click/drag/key/type) the background calls this to learn
// whether the page actually changed and to wait until it stops changing, so it
// can decide whether to attach a fresh browser_observe snapshot to the action
// result. Designed to return *fast* when nothing changes (no extra latency on
// inert clicks) and to ride out spinners/animations up to a hard cap otherwise.
export function doAwaitSettle(msg: any): Promise<any> {
  const timeout    = Math.min(Math.max(Number(msg.timeout ?? 3000), 200), 8000)
  const quietFor   = Math.min(Math.max(Number(msg.quiet ?? 350), 80), 2000)
  // If nothing has mutated within idleWindow, conclude "no change" and bail —
  // this bounds the cost of an action that doesn't alter the page.
  const idleWindow = Math.min(Math.max(Number(msg.idle_window ?? 600), 150), timeout)
  const startUrl   = location.href
  const startTitle = document.title

  return new Promise(resolve => {
    let mutations = 0
    let lastMutationAt = 0
    let done = false
    const start = Date.now()

    // Our own marks/cursor overlays mutate the DOM; never count them as a page change.
    const isOurs = (node: Node | null): boolean => {
      let el: Element | null = node instanceof Element ? node : node?.parentElement ?? null
      while (el) {
        const id = (el as HTMLElement).id
        if (typeof id === 'string' && (id.startsWith('__hs_marks') || id.startsWith('__hs_mouse_fx'))) return true
        el = el.parentElement
      }
      return false
    }

    const observer = new MutationObserver(records => {
      for (const r of records) {
        if (isOurs(r.target)) continue
        let real = r.type === 'attributes'
        r.addedNodes.forEach(n => { if (!isOurs(n)) real = true })
        r.removedNodes.forEach(n => { if (!isOurs(n)) real = true })
        if (real) { mutations++; lastMutationAt = Date.now() }
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })

    // A full-page navigation tears the document down; flag it so the result is
    // honest about "the page is leaving" (the background then waits for load).
    const onHide = () => finish(true)
    window.addEventListener('pagehide', onHide, { once: true })

    let timer: ReturnType<typeof setTimeout> | null = null
    const poll = () => {
      const now = Date.now()
      if (location.href !== startUrl) return finish(false)                          // SPA route change → changed
      if (mutations > 0 && now - lastMutationAt >= quietFor) return finish(false)    // mutated then went quiet → settled
      if (mutations === 0 && now - start >= idleWindow) return finish(false)         // nothing happened → bail fast
      if (now - start >= timeout) return finish(false)                              // hard cap (e.g. endless spinner)
      timer = setTimeout(poll, 80)
    }

    function finish(navigating: boolean) {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      observer.disconnect()
      window.removeEventListener('pagehide', onHide)
      resolve({
        success: true,
        changed: navigating || mutations > 0 || location.href !== startUrl || document.title !== startTitle,
        navigating,
        mutations,
        urlChanged: location.href !== startUrl,
        settleMs: Date.now() - start,
      })
    }

    timer = setTimeout(poll, 100)  // small head start so the click's own handlers can fire first
  })
}

// ── Evaluate ──────────────────────────────────────────────────────────────
export function doEvaluate(msg: any) {
  const code = String(msg.code || '')
  if (!code) throw new Error('code is required')
  // eslint-disable-next-line no-eval
  const result = (0, eval)(code)
  return { success: true, result: typeof result === 'function' ? '[Function]' : result }
}

// ── Extract ───────────────────────────────────────────────────────────────
export function doExtract(msg: any) {
  const { selector, attributes, limit = 50 } = msg
  if (!selector) throw new Error('selector is required')
  const els = Array.from(document.querySelectorAll(selector)).slice(0, limit)
  const items = els.map(el => {
    const collected: Record<string, string> = {}
    const attrs: string[] = attributes || ['href', 'src', 'id', 'class', 'value', 'data-id', 'name']
    for (const attr of attrs) {
      const v = el.getAttribute(attr)
      if (v !== null) collected[attr] = v
    }
    const item: any = {
      tag: el.tagName,
      selector: cssPath(el),
      text: textOf(el, 500),
      attributes: collected,
    }
    for (const [k, v] of Object.entries(collected)) item[k] = v
    return item
  })
  return {
    success: true,
    source: 'browser_extract',
    url: location.href,
    title: document.title,
    selector,
    count: items.length,
    items,
  }
}

// ── DOM snapshot / frames / performance ───────────────────────────────────
function attrMap(el: Element, names: string[]) {
  const out: Record<string, string> = {}
  for (const name of names) {
    const v = el.getAttribute(name)
    if (v !== null) out[name] = v
  }
  return out
}

function snapshotNode(el: Element, depth: number, maxDepth: number, state: { count: number; maxNodes: number }): any {
  state.count++
  const html = el as HTMLElement
  const children = depth >= maxDepth || state.count >= state.maxNodes
    ? []
    : Array.from(el.children)
      .filter(child => isVisible(child) || ['SCRIPT', 'STYLE', 'META', 'LINK'].includes(child.tagName) === false)
      .slice(0, Math.max(0, state.maxNodes - state.count))
      .map(child => snapshotNode(child, depth + 1, maxDepth, state))
      .filter(Boolean)
  return {
    tag: el.tagName.toLowerCase(),
    selector: cssPath(el),
    text: textOf(el, 160),
    visible: isVisible(el),
    role: html.getAttribute('role') || '',
    attrs: attrMap(el, ['id', 'class', 'name', 'type', 'href', 'src', 'alt', 'title', 'aria-label', 'placeholder']),
    children,
  }
}

export function domSnapshot(msg: any) {
  const root = (msg.selector ? document.querySelector(String(msg.selector)) : document.body) as HTMLElement | null
  if (!root) throw new Error(`Element not found: ${msg.selector}`)
  const maxDepth = Math.min(Math.max(Number(msg.max_depth ?? 4), 0), 8)
  const maxNodes = Math.min(Math.max(Number(msg.max_nodes ?? 120), 1), 1000)
  const state = { count: 0, maxNodes }
  const tree = snapshotNode(root, 0, maxDepth, state)
  return {
    success: true,
    source: 'browser_dom_snapshot',
    url: location.href,
    title: document.title,
    selector: msg.selector || 'body',
    maxDepth,
    maxNodes,
    truncated: state.count >= maxNodes,
    tree,
  }
}

export function iframeList() {
  const frames = Array.from(document.querySelectorAll('iframe,frame')).map(frame => {
    const el = frame as HTMLIFrameElement
    const r = el.getBoundingClientRect()
    let accessible = false
    let title = ''
    try {
      accessible = !!el.contentDocument
      title = el.contentDocument?.title || ''
    } catch { accessible = false }
    return {
      selector: cssPath(el),
      src: el.src || el.getAttribute('src') || '',
      name: el.name || el.getAttribute('name') || '',
      title,
      accessible,
      visible: isVisible(el),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    }
  })
  return { success: true, url: location.href, count: frames.length, frames }
}

export function performanceInfo() {
  const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const byType: Record<string, number> = {}
  for (const r of resources) byType[r.initiatorType || 'other'] = (byType[r.initiatorType || 'other'] || 0) + 1
  return {
    success: true,
    url: location.href,
    title: document.title,
    navigation: nav ? {
      type: nav.type,
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd - nav.startTime),
      loadMs: Math.round(nav.loadEventEnd - nav.startTime),
      transferSize: nav.transferSize,
      encodedBodySize: nav.encodedBodySize,
      decodedBodySize: nav.decodedBodySize,
    } : null,
    resources: {
      count: resources.length,
      byType,
      slowest: resources
        .slice()
        .sort((a, b) => b.duration - a.duration)
        .slice(0, 20)
        .map(r => ({
          name: r.name,
          type: r.initiatorType,
          durationMs: Math.round(r.duration),
          transferSize: r.transferSize,
          encodedBodySize: r.encodedBodySize,
        })),
    },
  }
}

export async function screenshotTargetInfo(msg: any) {
  const margin = Math.max(0, Number(msg.margin ?? msg.padding ?? 0))
  let el: Element | null = null

  if (msg.selector || msg.text) {
    el = findEl(msg.selector, msg.text)
    if (!el) throw new Error(`Element not found: selector=${msg.selector || ''} text=${msg.text || ''}`)
    if (msg.scroll_into_view !== false) {
      el.scrollIntoView({ block: msg.block || 'center', inline: msg.inline || 'center', behavior: 'auto' })
      await waitScrollSettle(250)
    }
  } else if (msg.x !== undefined && msg.y !== undefined) {
    const space = String(msg.coordinate_space || 'viewport')
    const vx = space === 'page' ? Number(msg.x) - window.scrollX : Number(msg.x)
    const vy = space === 'page' ? Number(msg.y) - window.scrollY : Number(msg.y)
    el = document.elementFromPoint(vx, vy)
  }

  if (!el) throw new Error('selector, text, or x/y is required for screenshot target info')

  const rect = (el as HTMLElement).getBoundingClientRect()
  const viewportRect = {
    x: Math.max(0, rect.left - margin),
    y: Math.max(0, rect.top - margin),
    width: Math.min(window.innerWidth, rect.right + margin) - Math.max(0, rect.left - margin),
    height: Math.min(window.innerHeight, rect.bottom + margin) - Math.max(0, rect.top - margin),
  }
  const pageRect = {
    x: Math.max(0, rect.left + window.scrollX - margin),
    y: Math.max(0, rect.top + window.scrollY - margin),
    width: Math.min(document.documentElement.scrollWidth, rect.right + window.scrollX + margin) - Math.max(0, rect.left + window.scrollX - margin),
    height: Math.min(document.documentElement.scrollHeight, rect.bottom + window.scrollY + margin) - Math.max(0, rect.top + window.scrollY - margin),
  }

  return {
    success: true,
    selector: cssPath(el),
    tag: el.tagName,
    text: textOf(el, 160),
    visible: isVisible(el),
    devicePixelRatio: window.devicePixelRatio,
    scroll: { x: window.scrollX, y: window.scrollY },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    page: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    rect: { viewport: viewportRect, page: pageRect },
  }
}

export function fileUpload(msg: any) {
  const input = document.querySelector(String(msg.selector || 'input[type="file"]')) as HTMLInputElement | null
  if (!input || input.type !== 'file') throw new Error(`File input not found: ${msg.selector || 'input[type="file"]'}`)
  const files = Array.isArray(msg.files) ? msg.files : []
  if (!files.length) throw new Error('files is required. Use [{name, content, type?, encoding?}]. Local filesystem paths cannot be read by a content script.')
  const dt = new DataTransfer()
  for (const f of files) {
    const name = String(f.name || 'upload.txt')
    const type = String(f.type || 'application/octet-stream')
    const raw = String(f.content || '')
    const data = f.encoding === 'base64'
      ? Uint8Array.from(atob(raw), c => c.charCodeAt(0))
      : raw
    dt.items.add(new File([data], name, { type }))
  }
  input.files = dt.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
  return { success: true, selector: cssPath(input), count: input.files?.length || 0, files: Array.from(input.files || []).map(f => ({ name: f.name, size: f.size, type: f.type })) }
}

// ── Find text ─────────────────────────────────────────────────────────────
export function findText(msg: any) {
  const target = String(msg.text || '')
  if (!target) throw new Error('text is required')
  const exact   = !!msg.exact
  const walker  = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
  const found: any[] = []

  while (walker.nextNode() && found.length < 20) {
    const el = walker.currentNode as HTMLElement
    const inner = el.innerText?.trim() || ''
    const match = exact ? inner === target : inner.includes(target)
    if (match && inner.length > 0 && inner.length < 500) {
      found.push({
        tag:      el.tagName,
        text:     inner.slice(0, 200),
        selector: el.id ? `#${el.id}` : el.className ? `.${el.className.trim().split(' ')[0]}` : el.tagName.toLowerCase(),
      })
    }
  }
  return { success: true, query: target, count: found.length, elements: found }
}

// ── Fill form ─────────────────────────────────────────────────────────────
type FillField = {
  selector?: string
  name?: string
  label?: string
  placeholder?: string
  text?: string
  value?: any
  action?: 'type' | 'set' | 'select' | 'check' | 'uncheck' | 'click'
}

function cssEscape(value: string) {
  const esc = (window as any).CSS?.escape
  return esc ? esc(value) : value.replace(/["\\]/g, '\\$&')
}

function normalizeFields(raw: any): FillField[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([key, value]) => (
      /^[.#[]|^[a-z]+[.#[:\s>+~]/i.test(key)
        ? { selector: key, value }
        : { name: key, value }
    ))
  }
  return []
}

function fieldByLabel(text: string): HTMLElement | null {
  const target = text.trim().toLowerCase()
  const labels = Array.from(document.querySelectorAll('label')) as HTMLLabelElement[]
  for (const label of labels) {
    const labelText = (label.innerText || label.textContent || '').trim().toLowerCase()
    if (!labelText || !labelText.includes(target)) continue
    if (label.htmlFor) {
      const byFor = document.getElementById(label.htmlFor)
      if (byFor) return byFor as HTMLElement
    }
    const nested = label.querySelector('input, textarea, select, [contenteditable="true"]')
    if (nested) return nested as HTMLElement
  }
  return null
}

function resolveField(field: FillField): HTMLElement | null {
  if (field.selector) {
    const bySelector = document.querySelector(field.selector)
    if (bySelector) return bySelector as HTMLElement
  }
  if (field.name) {
    const name = cssEscape(String(field.name))
    const byName = document.querySelector(`[name="${name}"], #${name}`)
    if (byName) return byName as HTMLElement
  }
  if (field.placeholder) {
    const target = String(field.placeholder).toLowerCase()
    const byPlaceholder = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input[placeholder], textarea[placeholder]'))
      .find(el => (el.placeholder || '').toLowerCase().includes(target))
    if (byPlaceholder) return byPlaceholder
  }
  if (field.label || field.text) return fieldByLabel(String(field.label || field.text))
  return null
}

function setNativeValue(el: HTMLElement, field: FillField) {
  const value = field.value
  const action = field.action || 'set'

  el.focus?.()

  if (action === 'click') {
    el.click()
    return
  }

  // Tag-name checks instead of instanceof: elements inside a same-origin iframe
  // are instances of that frame window's constructors, so instanceof against the
  // top window's HTMLSelectElement/HTMLInputElement is always false for them.
  const tag = el.tagName
  if (tag === 'SELECT') {
    const sel = el as HTMLSelectElement
    const wanted = String(value ?? '')
    const opt = Array.from(sel.options).find(o => o.value === wanted || o.text.trim() === wanted)
    if (!opt) throw new Error(`Option not found: ${wanted}`)
    sel.value = opt.value
  } else if (tag === 'INPUT' && ((el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio')) {
    const box = el as HTMLInputElement
    if (action === 'uncheck') box.checked = false
    else if (action === 'check') box.checked = true
    else box.checked = Boolean(value)
  } else if (tag === 'INPUT' || tag === 'TEXTAREA') {
    (el as HTMLInputElement).value = String(value ?? '')
  } else if (el.isContentEditable) {
    el.textContent = String(value ?? '')
  } else {
    throw new Error(`Unsupported form element: ${el.tagName}`)
  }

  el.dispatchEvent(new Event('input',  { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

export function fillForm(msg: any) {
  const fields = normalizeFields(msg.fields)
  const filled: any[] = []
  const errors: string[] = []

  if (!fields.length) {
    return {
      success: false,
      filled,
      errors: ['fields must be an array like [{ selector, value }] or an object map like { "input[name=email]": "a@b.com" }'],
    }
  }

  for (const field of fields) {
    try {
      const el = resolveField(field)
      if (!el) { errors.push(`Not found: ${field.selector || field.name || field.label || field.placeholder || field.text || '[unknown]'}`); continue }
      setNativeValue(el, field)
      filled.push({
        target: field.selector || field.name || field.label || field.placeholder || field.text || elementLabel(el),
        resolved: elementLabel(el),
        tag: el.tagName,
        type: (el as HTMLInputElement).type || undefined,
        action: field.action || 'set',
      })
    } catch (err: any) {
      errors.push(`${field.selector || field.name || field.label || field.placeholder || field.text || '[unknown]'}: ${err.message || String(err)}`)
    }
  }

  if (msg.submitSelector) {
    const btn = document.querySelector(msg.submitSelector) as HTMLElement | null
    if (btn) btn.click()
    else errors.push(`Submit not found: ${msg.submitSelector}`)
  }

  return { success: errors.length === 0, filled, errors }
}

// ── Select dropdown ────────────────────────────────────────────────────────
function findCustomOption(value: string, root?: Element | null): HTMLElement | null {
  const query = [
    '[role="option"]',
    '[role="menuitem"]',
    '[role="menuitemradio"]',
    '[role="listitem"]',
    '[data-value]',
    'li',
    'button',
    'a',
    'div',
    'span',
  ].join(',')
  const scope = root || document
  const candidates = Array.from(scope.querySelectorAll(query)) as HTMLElement[]
  return candidates.find(el => {
    if (!isVisible(el)) return false
    const dataValue = el.getAttribute('data-value') || el.getAttribute('value') || ''
    return dataValue === value || textMatches(el, value, true)
  }) || candidates.find(el => isVisible(el) && textMatches(el, value, false)) || null
}

export async function doSelect(msg: any) {
  const el = document.querySelector(msg.selector) as HTMLElement | null
  if (!el) throw new Error(`Select target not found: ${msg.selector}`)

  if (msg.value === undefined || msg.value === null || String(msg.value) === '') throw new Error('value is required')
  const value = String(msg.value)
  if (el.tagName === 'SELECT') {
    const sel = el as unknown as HTMLSelectElement
    const opt = Array.from(sel.options).find(o => o.value === value || o.text.trim() === value)
    if (!opt) throw new Error(`Option "${value}" not found in ${msg.selector}`)
    sel.value = opt.value
    sel.dispatchEvent(new Event('input', { bubbles: true }))
    sel.dispatchEvent(new Event('change', { bubbles: true }))
    return { success: true, selector: msg.selector, selected: opt.text, value: opt.value, mode: 'native' }
  }

  el.scrollIntoView({ block: 'center', behavior: 'auto' })
  if (isFxEnabled()) { await fxSleep(160); await fxToElement(el) }
  clickLikeUser(el)
  await fxSleep(250)

  const expanded = el.getAttribute('aria-controls')
  const popup = expanded ? document.getElementById(expanded) : null
  const option = findCustomOption(value, popup) || findCustomOption(value)
  if (!option) {
    throw new Error(`Custom dropdown option "${value}" not found after opening ${msg.selector}`)
  }
  if (isFxEnabled()) await fxToElement(option)
  clickLikeUser(option)
  return {
    success: true,
    selector: msg.selector,
    selected: textOf(option, 120) || value,
    value,
    mode: 'custom',
    optionSelector: cssPath(option),
  }
}

// ── Storage ────────────────────────────────────────────────────────────────
export function storageGet(msg: any) {
  const store = msg.storageType === 'session' ? sessionStorage : localStorage
  const value = store.getItem(msg.key)
  return { success: true, key: msg.key, value, found: value !== null }
}

export function storageSet(msg: any) {
  const store = msg.storageType === 'session' ? sessionStorage : localStorage
  if (!msg.key) throw new Error('key is required')
  store.setItem(String(msg.key), String(msg.value ?? ''))
  return { success: true, key: String(msg.key), type: msg.storageType === 'session' ? 'session' : 'local' }
}

export function storageRemove(msg: any) {
  const store = msg.storageType === 'session' ? sessionStorage : localStorage
  if (!msg.key) throw new Error('key is required')
  store.removeItem(String(msg.key))
  return { success: true, key: String(msg.key), type: msg.storageType === 'session' ? 'session' : 'local' }
}

export function storageList(msg: any) {
  const store = msg.storageType === 'session' ? sessionStorage : localStorage
  const prefix = String(msg.prefix || '')
  const keys = Array.from({ length: store.length }, (_, i) => store.key(i)).filter(Boolean) as string[]
  const filtered = prefix ? keys.filter(k => k.startsWith(prefix)) : keys
  const limit = Math.min(Number(msg.limit || 100), 500)
  return {
    success: true,
    type: msg.storageType === 'session' ? 'session' : 'local',
    count: filtered.length,
    keys: filtered.slice(0, limit),
    items: msg.include_values ? filtered.slice(0, limit).map(key => ({ key, value: store.getItem(key) })) : undefined,
  }
}

// ── Hover ─────────────────────────────────────────────────────────────────
export async function doHover(msg: any) {
  // Support the same targeting as clicks: ref / selector / text / coords
  const resolved = resolveTarget(msg)
  const el = resolved.el
  if (!el) {
    const sel = msg.selector || msg.text || msg.ref || 'unknown'
    throw new Error(`Element not found for hover: ${sel}`)
  }
  if (isFxEnabled()) {
    const c = elCenter(el)
    const p = topViewportPoint(c.x, c.y, resolved.frame)
    await fxToElement(el, p)
    fxHoverOn(el)
  }
  const win = ownerWindow(el)
  const c = elCenter(el)
  const base = { bubbles: true, cancelable: true, view: win, clientX: c.x, clientY: c.y }
  el.dispatchEvent(new MouseEvent('mouseover', base))
  el.dispatchEvent(new MouseEvent('mouseenter', base))
  el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }))
  return { success: true, selector: cssPath(el), tag: el.tagName }
}

export async function doScreenshotFx(msg: any) {
  if (msg.phase === 'clear') {
    fxScreenshotClear()
    return { success: true, phase: 'clear' }
  }
  if (msg.phase === 'before') {
    let rect = msg.rect as { x: number; y: number; width: number; height: number } | undefined
    if (!rect && (msg.selector || msg.text)) {
      const el = findEl(msg.selector, msg.text)
      if (el) {
        const margin = Math.max(0, Number(msg.margin ?? msg.padding ?? 8))
        const r = (el as HTMLElement).getBoundingClientRect()
        rect = {
          x: Math.max(0, r.left - margin),
          y: Math.max(0, r.top - margin),
          width: Math.min(window.innerWidth, r.right + margin) - Math.max(0, r.left - margin),
          height: Math.min(window.innerHeight, r.bottom + margin) - Math.max(0, r.top - margin),
        }
      }
    }
    await fxScreenshotBefore(rect)
    return { success: true, phase: 'before', rect: rect || null }
  }
  if (msg.phase === 'after') {
    await fxScreenshotAfter()
    return { success: true, phase: 'after' }
  }
  return { success: true, phase: 'noop' }
}
