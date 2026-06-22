// content/fx.ts — page visual feedback for AI-driven browser actions.
// hand.png raster cursor, click ripples, scroll/drag trails, screenshot shutter FX.

export const FX = '__hs_mouse_fx__'

const HAND_HOTSPOT = { x: 1, y: 1 }
const HAND_SIZE = 32
const HAND_URL = () => chrome.runtime.getURL('cursors/hand.png')

function handImg(className: string, ghost = false) {
  const opacity = ghost ? 'opacity:.22;' : ''
  return `<img class="${className}" src="${HAND_URL()}" width="${HAND_SIZE}" height="${HAND_SIZE}" alt="" draggable="false" style="${opacity}"/>`
}

let fxEnabled = true
let fxCursor: HTMLElement | null = null
let fxTrail: HTMLElement | null = null
let fxX = 0
let fxY = 0
let fxHideTimer: ReturnType<typeof setTimeout> | null = null
let moveAnim: number | null = null
let screenshotOverlay: HTMLElement | null = null
let screenshotFlash: HTMLElement | null = null
let overflowLockDepth = 0
let savedOverflow = { html: '', body: '' }

export const fxSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
export const isFxEnabled = () => fxEnabled

try {
  chrome.storage?.local?.get('mouseFx').then((r: any) => {
    if (r && typeof r.mouseFx === 'boolean') fxEnabled = r.mouseFx
  }).catch(() => {})
  chrome.storage?.onChanged?.addListener((changes: any, area: string) => {
    if (area === 'local' && changes.mouseFx) fxEnabled = changes.mouseFx.newValue !== false
  })
} catch { /* storage may be unavailable */ }

function fxEnsureStyles() {
  let style = document.getElementById(FX + '_style') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = FX + '_style'
    document.documentElement.appendChild(style)
  }
  style.textContent = `
    .${FX}-cur,.${FX}-trail,.${FX}-ring,.${FX}-spark,.${FX}-trail-line,.${FX}-scroll-hint,
    .${FX}-shot-frame,.${FX}-shot-flash,.${FX}-shot-scan,.${FX}-hover-glow{position:fixed;left:0;top:0;pointer-events:none;}
    .${FX}-cur{z-index:2147483647;opacity:0;will-change:transform;}
    .${FX}-cur.show{opacity:1;}
    .${FX}-cur.noanim{transition:none!important;}
    .${FX}-cur-in{
      display:block;transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px) scale(1);
      transform-origin:0 0;transition:transform .12s cubic-bezier(.34,1.4,.64,1);}
    .${FX}-cur-in.pulse{animation:${FX}-press .28s cubic-bezier(.34,1.4,.64,1);}
    .${FX}-cur-in.hold{transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px) scale(.84);}
    @keyframes ${FX}-press{
      0%{transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px) scale(1);}
      38%{transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px) scale(.76);}
      62%{transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px) scale(.76);}
      100%{transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px) scale(1);}}
    .${FX}-cur-pointer,.${FX}-trail-pointer{
      display:block;width:${HAND_SIZE}px;height:${HAND_SIZE}px;user-select:none;-webkit-user-drag:none;
      background:transparent;}
    .${FX}-cur-in{background:transparent;}
    .${FX}-cur-pointer{filter:drop-shadow(0 1px 2px rgba(15,23,42,.28));}
    .${FX}-trail{z-index:2147483646;opacity:0;will-change:transform;}
    .${FX}-trail.show{opacity:1;}
    .${FX}-trail-in{display:block;transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px);filter:blur(.4px);}
    .${FX}-ring,.${FX}-spark{z-index:2147483645;}
    .${FX}-ring{
      width:12px;height:12px;border-radius:50%;
      border:2px solid rgba(129,140,248,.85);
      transform:translate(-50%,-50%) scale(.35);
      opacity:.95;animation:${FX}-ring .72s cubic-bezier(.22,1,.36,1) forwards;}
    .${FX}-ring.alt{border-color:rgba(251,191,36,.9);box-shadow:0 0 10px rgba(251,191,36,.35);}
    @keyframes ${FX}-ring{70%{opacity:.45;}100%{transform:translate(-50%,-50%) scale(3.8);opacity:0;}}
    .${FX}-spark{
      width:5px;height:5px;border-radius:50%;
      background:rgba(165,180,252,.9);
      transform:translate(-50%,-50%) scale(1);
      animation:${FX}-spark .55s ease-out forwards;}
    @keyframes ${FX}-spark{100%{transform:translate(-50%,-50%) scale(2.4);opacity:0;}}
    .${FX}-trail-line{
      height:2px;border-radius:2px;transform-origin:0 50%;opacity:0;z-index:2147483645;
      background:linear-gradient(90deg,rgba(99,102,241,0),rgba(129,140,248,.75),rgba(99,102,241,0));
      animation:${FX}-trail-line .75s ease-out forwards;}
    @keyframes ${FX}-trail-line{0%{opacity:.75;}100%{opacity:0;}}
    .${FX}-scroll-hint{
      width:3px;border-radius:3px;transform:translateX(-50%);opacity:0;z-index:2147483645;
      background:linear-gradient(180deg,rgba(99,102,241,0),rgba(129,140,248,.7),rgba(99,102,241,0));
      animation:${FX}-scroll-hint .62s ease-out forwards;}
    @keyframes ${FX}-scroll-hint{0%{opacity:.7;}100%{opacity:0;}}
    .${FX}-shot-wrap{position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483644;pointer-events:none;overflow:hidden;}
    .${FX}-shot-dim{position:fixed;background:rgba(2,6,23,.54);}
    .${FX}-shot-frame{z-index:1;box-sizing:border-box;border:2px solid rgba(56,189,248,.95);
      border-radius:6px;box-shadow:inset 0 0 28px rgba(56,189,248,.2);
      animation:${FX}-shot-frame .5s ease-out;}
    .${FX}-shot-frame::before,.${FX}-shot-frame::after{
      content:'';position:absolute;width:14px;height:14px;border:2px solid rgba(56,189,248,.95);}
    .${FX}-shot-frame::before{left:-2px;top:-2px;border-right:none;border-bottom:none;border-radius:4px 0 0 0;}
    .${FX}-shot-frame::after{right:-2px;bottom:-2px;border-left:none;border-top:none;border-radius:0 0 4px 0;}
    @keyframes ${FX}-shot-frame{from{opacity:0;transform:scale(.985);}to{opacity:1;transform:scale(1);}}
    .${FX}-shot-badge{
      position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:2;
      padding:5px 14px;border-radius:999px;font:600 11px/1.4 system-ui,sans-serif;
      color:#e0f2fe;background:rgba(14,116,144,.88);border:1px solid rgba(56,189,248,.6);
      box-shadow:0 4px 18px rgba(2,6,23,.4);letter-spacing:.3px;
      animation:${FX}-shot-badge .45s ease-out;}
    @keyframes ${FX}-shot-badge{from{opacity:0;transform:translateX(-50%) translateY(-6px);}to{opacity:1;transform:translateX(-50%) translateY(0);}}
    .${FX}-shot-scan{
      position:absolute;height:2px;width:100%;left:0;top:0;z-index:2;
      background:linear-gradient(90deg,transparent,rgba(56,189,248,.95),transparent);
      box-shadow:0 0 14px rgba(56,189,248,.65);
      animation:${FX}-shot-scan 1.1s ease-in-out infinite;}
    @keyframes ${FX}-shot-scan{0%{top:0;opacity:.25;}50%{opacity:1;}100%{top:calc(100% - 2px);opacity:.25;}}
    .${FX}-shot-flash{
      inset:0;width:100vw;height:100vh;z-index:2147483645;
      background:radial-gradient(circle at 50% 42%,rgba(255,255,255,.95) 0%,rgba(255,255,255,.55) 38%,rgba(186,230,253,.2) 100%);
      opacity:0;animation:${FX}-shot-flash .9s ease-out forwards;}
    .${FX}-shot-ring{
      position:fixed;inset:12px;border:3px solid rgba(56,189,248,.9);border-radius:10px;z-index:2147483644;
      opacity:0;animation:${FX}-shot-ring .9s ease-out forwards;}
    @keyframes ${FX}-shot-flash{0%{opacity:0;}14%{opacity:.9;}100%{opacity:0;}}
    @keyframes ${FX}-shot-ring{0%{opacity:0;transform:scale(1.03);}18%{opacity:1;}100%{opacity:0;transform:scale(1);}}
    .${FX}-hover-glow{z-index:2147483644;border-radius:6px;
      box-shadow:0 0 0 2px rgba(129,140,248,.55),0 0 20px rgba(99,102,241,.35);
      animation:${FX}-hover-glow .35s ease-out;}
    @keyframes ${FX}-hover-glow{from{opacity:0;transform:scale(.98);}to{opacity:1;transform:scale(1);}}`
}

function fxEnsure(): HTMLElement | null {
  if (!fxEnabled || !document.body) return null
  fxEnsureStyles()
  if (fxCursor && document.documentElement.contains(fxCursor)) return fxCursor

  const cur = document.createElement('div')
  cur.className = `${FX}-cur noanim`
  cur.innerHTML = `<span class="${FX}-cur-in">${handImg(`${FX}-cur-pointer`)}</span>`
  document.body.appendChild(cur)
  fxCursor = cur

  if (!fxTrail || !document.documentElement.contains(fxTrail)) {
    const trail = document.createElement('div')
    trail.className = `${FX}-trail`
    trail.innerHTML = `<span class="${FX}-trail-in">${handImg(`${FX}-trail-pointer`, true)}</span>`
    document.body.appendChild(trail)
    fxTrail = trail
  }

  if (!fxX && !fxY) { fxX = window.innerWidth / 2; fxY = window.innerHeight / 2 }
  fxPlace(fxX, fxY, false)
  if (fxTrail) {
    fxTrail.style.transform = `translate(${fxX}px, ${fxY}px)`
    fxTrail.classList.remove('show')
  }
  return cur
}

function fxPlace(x: number, y: number, animate: boolean) {
  const cur = fxCursor
  if (!cur) return
  fxX = x; fxY = y
  cur.classList.toggle('noanim', !animate)
  cur.style.transform = `translate(${x}px, ${y}px)`
}

function fxScheduleHide() {
  if (fxHideTimer) clearTimeout(fxHideTimer)
  fxHideTimer = setTimeout(() => {
    fxCursor?.classList.remove('show')
    fxTrail?.classList.remove('show')
  }, 1800)
}

function fxShowCursor() {
  fxCursor?.classList.add('show')
  fxTrail?.classList.add('show')
}

function fxSpawn(cls: string, x: number, y: number, life = 700, extra?: (el: HTMLElement) => void) {
  if (!document.body) return
  const el = document.createElement('div')
  el.className = `${FX}-${cls}`
  el.style.left = `${x}px`
  el.style.top = `${y}px`
  extra?.(el)
  document.body.appendChild(el)
  setTimeout(() => el.remove(), life)
}

function easeOutCubic(t: number) { return 1 - Math.pow(1 - t, 3) }

function fxCursorInner(): HTMLElement | null {
  return fxCursor?.querySelector(`.${FX}-cur-in`) as HTMLElement | null
}

async function fxPressPulse() {
  const inner = fxCursorInner()
  if (!inner) return
  inner.classList.remove('hold')
  void inner.offsetWidth
  inner.classList.add('pulse')
  await fxSleep(280)
  inner.classList.remove('pulse')
}

async function fxPressHold() {
  const inner = fxCursorInner()
  if (!inner) return
  inner.classList.remove('pulse')
  inner.classList.add('hold')
  await fxSleep(90)
}

async function fxPressRelease() {
  const inner = fxCursorInner()
  if (!inner) return
  inner.classList.remove('hold')
  await fxSleep(130)
}

function fxClickRipples(x: number, y: number, variant: 'left' | 'right' = 'left') {
  const ringClass = variant === 'right' ? 'ring alt' : 'ring'
  for (const d of [0, 55, 110]) setTimeout(() => fxSpawn(ringClass, x, y, 760), d)
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI * 2 * i) / 6
    const r = 10 + Math.random() * 6
    setTimeout(() => fxSpawn('spark', x + Math.cos(ang) * r, y + Math.sin(ang) * r, 560), 20)
  }
}

export async function fxMoveTo(x: number, y: number) {
  const cur = fxEnsure()
  if (!cur) return
  fxShowCursor()

  const startX = fxX
  const startY = fxY
  const dx = x - startX
  const dy = y - startY
  const dist = Math.hypot(dx, dy)
  const duration = Math.min(Math.max(dist * 0.55, 180), 520)

  if (moveAnim) cancelAnimationFrame(moveAnim)
  await new Promise<void>(resolve => {
    const t0 = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration)
      const e = easeOutCubic(t)
      const cx = startX + dx * e
      const cy = startY + dy * e
      fxPlace(cx, cy, false)
      if (fxTrail) {
        const lag = 0.28
        const tx = startX + dx * Math.max(0, e - lag)
        const ty = startY + dy * Math.max(0, e - lag)
        fxTrail.style.transform = `translate(${tx}px, ${ty}px)`
      }
      if (t < 1) moveAnim = requestAnimationFrame(step)
      else { moveAnim = null; resolve() }
    }
    moveAnim = requestAnimationFrame(step)
  })
}

export async function fxClickAt(x: number, y: number, variant: 'left' | 'right' | 'double' = 'left') {
  fxEnsure()
  fxShowCursor()
  fxPlace(x, y, false)

  const rippleVariant = variant === 'right' ? 'right' : 'left'
  if (variant === 'double') {
    await fxPressPulse()
    fxClickRipples(x, y, rippleVariant)
    await fxSleep(100)
    await fxPressPulse()
    fxClickRipples(x, y, rippleVariant)
  } else {
    await fxPressPulse()
    fxClickRipples(x, y, rippleVariant)
  }
  fxScheduleHide()
}

export async function fxDragPath(sx: number, sy: number, ex: number, ey: number) {
  fxEnsure()
  fxShowCursor()
  fxPlace(sx, sy, false)
  if (fxTrail) fxTrail.style.transform = `translate(${sx}px, ${sy}px)`

  await fxPressHold()
  fxSpawn('ring', sx, sy, 640)

  const dx = ex - sx, dy = ey - sy
  const dist = Math.hypot(dx, dy)
  const ang = Math.atan2(dy, dx) * 180 / Math.PI
  fxSpawn('trail-line', sx, sy, 780, el => {
    el.style.width = `${dist}px`
    el.style.transform = `rotate(${ang}deg)`
  })

  await fxMoveTo(ex, ey)
  fxSpawn('ring', ex, ey, 640)
  await fxPressRelease()
  fxScheduleHide()
}

export async function fxToElement(el: Element) {
  if (!fxEnabled) return
  const r = (el as HTMLElement).getBoundingClientRect()
  const x = Math.min(Math.max(r.left + r.width / 2, 4), window.innerWidth - 4)
  const y = Math.min(Math.max(r.top + r.height / 2, 4), window.innerHeight - 4)
  await fxMoveTo(x, y)
}

export function fxHoverOn(el: Element) {
  if (!fxEnabled || !document.body) return
  fxEnsureStyles()
  const r = (el as HTMLElement).getBoundingClientRect()
  const glow = document.createElement('div')
  glow.className = `${FX}-hover-glow`
  glow.style.left = `${r.left - 4}px`
  glow.style.top = `${r.top - 4}px`
  glow.style.width = `${r.width + 8}px`
  glow.style.height = `${r.height + 8}px`
  document.body.appendChild(glow)
  setTimeout(() => glow.remove(), 900)
}

export async function fxScrollDrag(direction: string, amount: number) {
  fxEnsure()
  const cx = window.innerWidth / 2
  const cy = window.innerHeight / 2
  const len = Math.min(Math.max(amount || 0, 80), 220)
  let startY = cy, endY = cy
  if (direction === 'down')        { startY = cy + len / 2; endY = cy - len / 2 }
  else if (direction === 'up')     { startY = cy - len / 2; endY = cy + len / 2 }
  else if (direction === 'bottom') { startY = cy + 110;     endY = cy - 110 }
  else if (direction === 'top')    { startY = cy - 110;     endY = cy + 110 }

  fxShowCursor()
  fxPlace(cx, startY, false)
  if (fxTrail) fxTrail.style.transform = `translate(${cx}px, ${startY}px)`
  await fxPressHold()
  fxSpawn('scroll-hint', cx, Math.min(startY, endY), 620, el => {
    el.style.height = `${Math.abs(endY - startY)}px`
  })
  fxPlace(cx, endY, true)
  if (fxTrail) fxTrail.style.transform = `translate(${cx}px, ${endY}px)`
  await fxSleep(280)
  await fxPressRelease()
  fxScheduleHide()
}

function fxOverlayRoot(): HTMLElement {
  const id = FX + '_overlay'
  let root = document.getElementById(id) as HTMLElement | null
  if (!root) {
    root = document.createElement('div')
    root.id = id
    root.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483640;pointer-events:none;overflow:hidden;'
    document.documentElement.appendChild(root)
  }
  return root
}

function lockViewportScroll() {
  if (overflowLockDepth++ > 0) return
  savedOverflow.html = document.documentElement.style.overflow
  savedOverflow.body = document.body?.style.overflow || ''
  document.documentElement.style.overflow = 'hidden'
  if (document.body) document.body.style.overflow = 'hidden'
}

function unlockViewportScroll() {
  if (overflowLockDepth === 0) return
  if (--overflowLockDepth > 0) return
  document.documentElement.style.overflow = savedOverflow.html
  if (document.body) document.body.style.overflow = savedOverflow.body
}

function clearScreenshotFx() {
  screenshotOverlay?.remove()
  screenshotOverlay = null
  screenshotFlash?.remove()
  screenshotFlash = null
  document.querySelectorAll(`.${FX}-shot-ring`).forEach(el => el.remove())
  unlockViewportScroll()
}

type ShotRect = { x: number; y: number; width: number; height: number }

function appendDimPanel(wrap: HTMLElement, left: number, top: number, width: number, height: number) {
  if (width <= 0 || height <= 0) return
  const dim = document.createElement('div')
  dim.className = `${FX}-shot-dim`
  dim.style.left = `${left}px`
  dim.style.top = `${top}px`
  dim.style.width = `${width}px`
  dim.style.height = `${height}px`
  wrap.appendChild(dim)
}

function drawScreenshotFrame(rect: ShotRect) {
  clearScreenshotFx()
  lockViewportScroll()
  fxEnsureStyles()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const x = Math.max(0, rect.x)
  const y = Math.max(0, rect.y)
  const w = Math.max(0, rect.width)
  const h = Math.max(0, rect.height)

  const wrap = document.createElement('div')
  wrap.className = `${FX}-shot-wrap`
  appendDimPanel(wrap, 0, 0, vw, y)
  appendDimPanel(wrap, 0, y, x, h)
  appendDimPanel(wrap, x + w, y, vw - x - w, h)
  appendDimPanel(wrap, 0, y + h, vw, vh - y - h)

  const frame = document.createElement('div')
  frame.className = `${FX}-shot-frame`
  frame.style.left = `${x}px`
  frame.style.top = `${y}px`
  frame.style.width = `${w}px`
  frame.style.height = `${h}px`
  const scan = document.createElement('div')
  scan.className = `${FX}-shot-scan`
  frame.appendChild(scan)
  wrap.appendChild(frame)

  const badge = document.createElement('div')
  badge.className = `${FX}-shot-badge`
  badge.textContent = '截图中…'
  wrap.appendChild(badge)

  fxOverlayRoot().appendChild(wrap)
  screenshotOverlay = wrap
}

export async function fxScreenshotBefore(rect?: ShotRect | null) {
  if (!fxEnabled) return
  const frameRect = rect && rect.width > 0 && rect.height > 0
    ? rect
    : { x: 10, y: 10, width: window.innerWidth - 20, height: window.innerHeight - 20 }
  drawScreenshotFrame(frameRect)
  await fxSleep(580)
  clearScreenshotFx()
}

export async function fxScreenshotAfter() {
  if (!fxEnabled) return
  fxEnsureStyles()
  clearScreenshotFx()
  const root = fxOverlayRoot()
  const ring = document.createElement('div')
  ring.className = `${FX}-shot-ring`
  const flash = document.createElement('div')
  flash.className = `${FX}-shot-flash`
  root.appendChild(ring)
  root.appendChild(flash)
  screenshotFlash = flash
  setTimeout(() => {
    ring.remove()
    flash.remove()
    if (screenshotFlash === flash) screenshotFlash = null
  }, 950)
  await fxSleep(760)
}

export function fxScreenshotClear() {
  clearScreenshotFx()
}

export const getFxPos = () => ({ x: fxX, y: fxY })