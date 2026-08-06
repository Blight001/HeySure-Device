// content/popups.ts — popup / modal / dialog detection and close.
// Two entry points used by tools: browser_find_popups → doFindPopups and
// browser_close_popup → doClosePopup. The detection mixes role/class
// heuristics with positional heuristics (fixed/sticky, high z-index, covers
// the viewport center, has a close button candidate).

import { isVisible, textOf, cssPath, zIndexOf, elementArea, clickableAncestor, elCenter } from './dom'
import { fxClickAt, fxSleep, isFxEnabled } from './fx'
import { approachPointer } from './approach'

const POPUP_SELECTOR = [
  'dialog[open]',
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[aria-modal="true"]',
  '[class*="modal" i]',
  '[class*="dialog" i]',
  '[class*="popup" i]',
  '[class*="popover" i]',
  '[class*="drawer" i]',
  '[class*="toast" i]',
  '[class*="overlay" i]',
  '[class*="ant-modal" i]',
  '[class*="el-dialog" i]',
  '[class*="MuiDialog" i]',
  '[class*="van-popup" i]',
].join(',')

const CLOSE_SELECTOR = [
  'button[aria-label*="close" i]',
  'button[aria-label*="关闭" i]',
  '[role="button"][aria-label*="close" i]',
  '[role="button"][aria-label*="关闭" i]',
  'button[title*="close" i]',
  'button[title*="关闭" i]',
  '[data-dismiss]',
  '[data-bs-dismiss]',
  '[data-testid*="close" i]',
  '[class*="close" i]',
  '[class*="cancel" i]',
  '.ant-modal-close',
  '.el-dialog__headerbtn',
  '.MuiDialog-root button[aria-label]',
  '.btn-close',
].join(',')

const CLOSE_TEXTS = [
  '关闭', '关 闭', '取消', '稍后', '稍后再说', '我知道了', '知道了', '确定', '确认',
  '不再提示', '跳过', '关闭弹窗', 'Close', 'Cancel', 'OK', 'Ok', 'Got it', 'Dismiss',
  '×', 'x', 'X',
]

function isLikelyPopup(el: Element): boolean {
  if (!isVisible(el) || el === document.body || el === document.documentElement) return false
  const h = el as HTMLElement
  const tag = h.tagName.toLowerCase()
  const role = h.getAttribute('role')
  const cls = String(h.className || '').toLowerCase()
  const explicit = tag === 'dialog'
    || role === 'dialog'
    || role === 'alertdialog'
    || h.getAttribute('aria-modal') === 'true'
    || /(modal|dialog|popup|popover|drawer|toast|overlay|ant-modal|el-dialog|muidialog|van-popup)/i.test(cls)
  if (explicit) return true

  const s = getComputedStyle(h)
  if (!['fixed', 'sticky'].includes(s.position)) return false
  const z = zIndexOf(h)
  const r = h.getBoundingClientRect()
  const viewportArea = Math.max(1, window.innerWidth * window.innerHeight)
  const areaRatio = (r.width * r.height) / viewportArea
  const coversCenter = r.left <= window.innerWidth / 2 && r.right >= window.innerWidth / 2
    && r.top <= window.innerHeight / 2 && r.bottom >= window.innerHeight / 2
  const hasClose = findCloseCandidates(h, 1).length > 0
  return z >= 10 && (hasClose || coversCenter || areaRatio >= 0.12)
}

function findCloseCandidates(root: Element, limit = 12): Element[] {
  const candidates: Element[] = []
  const seen = new Set<Element>()
  const add = (el: Element | null) => {
    if (!el || seen.has(el) || !isVisible(el)) return
    const clickable = clickableAncestor(el)
    if (!isVisible(clickable) || seen.has(clickable)) return
    seen.add(clickable)
    candidates.push(clickable)
  }

  root.querySelectorAll(CLOSE_SELECTOR).forEach(add)
  const clickable = root.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"],[aria-label],[title]')
  clickable.forEach(el => {
    const txt = textOf(el, 80)
    const cls = String((el as HTMLElement).className || '').toLowerCase()
    const labelledClose = /(close|cancel|dismiss)/.test(cls) || /关闭|取消/.test(txt)
    if (labelledClose || CLOSE_TEXTS.some(t => txt.toLowerCase() === t.toLowerCase())) add(el)
  })

  return candidates
    .sort((a, b) => {
      const ta = textOf(a, 80)
      const tb = textOf(b, 80)
      const score = (t: string) => {
        if (/^(×|x)$/i.test(t)) return 0
        if (/关闭|close/i.test(t)) return 1
        if (/取消|cancel|dismiss|稍后|知道了|ok/i.test(t)) return 2
        return 3
      }
      return score(ta) - score(tb)
    })
    .slice(0, limit)
}

function collectPopupElements(): Element[] {
  const raw = new Set<Element>()
  document.querySelectorAll(POPUP_SELECTOR).forEach(el => raw.add(el))
  document.querySelectorAll('body *').forEach(el => {
    if (isLikelyPopup(el)) raw.add(el)
  })

  const popups = Array.from(raw)
    .filter(isLikelyPopup)
    .sort((a, b) => {
      const z = zIndexOf(b) - zIndexOf(a)
      if (z !== 0) return z
      return elementArea(a) - elementArea(b)
    })

  const out: Element[] = []
  for (const el of popups) {
    if (out.some(existing => existing === el || (existing.contains(el) && findCloseCandidates(existing, 1).length > 0))) continue
    out.push(el)
  }
  return out.slice(0, 10)
}

function popupInfo(el: Element, index: number) {
  const r = (el as HTMLElement).getBoundingClientRect()
  const closes = findCloseCandidates(el, 6)
  return {
    index,
    selector: cssPath(el),
    tag: el.tagName,
    role: el.getAttribute('role') || '',
    ariaModal: el.getAttribute('aria-modal') || '',
    zIndex: zIndexOf(el),
    rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    text: textOf(el, 260),
    closeCandidates: closes.map(c => ({ selector: cssPath(c), text: textOf(c, 80), tag: c.tagName })),
  }
}

export function doFindPopups(msg: any) {
  const limit = Math.max(1, Math.min(Number(msg.limit || 10), 20))
  const popups = collectPopupElements().slice(0, limit).map(popupInfo)
  return { success: true, count: popups.length, popups }
}

export async function doClosePopup(msg: any) {
  const strategy = String(msg.strategy || 'auto')
  const before = collectPopupElements()
  let target: Element | null = null
  if (msg.selector) target = document.querySelector(String(msg.selector))
  if (!target && msg.text) {
    const needle = String(msg.text)
    target = before.find(el => textOf(el, 1000).includes(needle)) || null
  }
  if (!target) target = before[Math.max(0, Number(msg.index || 0))] || null
  if (!target) return { success: false, closed: false, reason: 'no_popup_found', beforeCount: 0, afterCount: 0 }

  const beforeSelector = cssPath(target)
  const tryCloseButton = async () => {
    const candidates = findCloseCandidates(target!, 8)
    const btn = candidates[0]
    if (!btn) return false
    try { (btn as HTMLElement).focus?.() } catch {}
    const c = elCenter(btn)
    await approachPointer(btn, c.x, c.y)
    if (isFxEnabled()) { await fxClickAt(c.x, c.y); await fxSleep(60) }
    // clickLikeUser with hover
    const base = { bubbles: true, cancelable: true, view: window, clientX: c.x, clientY: c.y }
    const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true }
    btn.dispatchEvent(new PointerEvent('pointerover', pointer))
    btn.dispatchEvent(new PointerEvent('pointerenter', pointer))
    btn.dispatchEvent(new MouseEvent('mouseover', base))
    btn.dispatchEvent(new MouseEvent('mouseenter', base))
    const opts = { ...base } as MouseEventInit
    btn.dispatchEvent(new PointerEvent('pointerdown', opts))
    btn.dispatchEvent(new MouseEvent('mousedown', opts))
    btn.dispatchEvent(new PointerEvent('pointerup', opts))
    btn.dispatchEvent(new MouseEvent('mouseup', opts))
    btn.dispatchEvent(new MouseEvent('click', opts))
    ;(btn as HTMLElement).click?.()
    return true
  }
  const pressEscape = () => {
    const init: KeyboardEventInit = { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', init))
    document.dispatchEvent(new KeyboardEvent('keydown', init))
    document.dispatchEvent(new KeyboardEvent('keyup', init))
  }
  const clickBackdrop = () => {
    const r = (target as HTMLElement).getBoundingClientRect()
    const points = [
      { x: Math.max(2, r.left + 8), y: Math.max(2, r.top + 8) },
      { x: Math.min(window.innerWidth - 2, r.right - 8), y: Math.max(2, r.top + 8) },
      { x: window.innerWidth / 2, y: Math.min(window.innerHeight - 2, r.bottom - 8) },
    ]
    const pt = points.find(p => {
      const hit = document.elementFromPoint(p.x, p.y)
      return hit === target || (!!hit && target!.contains(hit))
    }) || points[0]
    const hit = document.elementFromPoint(pt.x, pt.y) || target!
    hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window, clientX: pt.x, clientY: pt.y }))
    hit.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window, clientX: pt.x, clientY: pt.y }))
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: pt.x, clientY: pt.y }))
  }
  const targetGone = () => !document.documentElement.contains(target!) || !isVisible(target)

  let method = ''
  if (strategy === 'close_button' || strategy === 'auto') {
    if (await tryCloseButton()) method = 'close_button'
    else if (strategy === 'close_button') throw new Error('No close button found in popup')
  }
  if (!method && (strategy === 'escape' || strategy === 'auto')) {
    pressEscape()
    method = 'escape'
  }
  await fxSleep(260)
  if (!targetGone() && (strategy === 'backdrop' || strategy === 'auto')) {
    clickBackdrop()
    method = method ? `${method}+backdrop` : 'backdrop'
    await fxSleep(260)
  }
  if (!targetGone() && msg.force_remove === true) {
    ;(target as HTMLElement).remove()
    method = method ? `${method}+force_remove` : 'force_remove'
    await fxSleep(60)
  }

  const after = collectPopupElements()
  return {
    success: targetGone() || after.length < before.length,
    closed: targetGone() || after.length < before.length,
    reason: targetGone() || after.length < before.length ? '' : 'popup_still_visible',
    method: method || 'none',
    selector: beforeSelector,
    beforeCount: before.length,
    afterCount: after.length,
    remainingPopups: after.map(popupInfo),
  }
}
