// content/viewport.ts — page position context.
// viewportContext reports scrollY/percent/atTop/atBottom plus the current
// section heading and any headings now visible. Used by browser_page_info,
// and folded into click/scroll results so the AI knows where it landed.

import { fxSleep } from './fx'

export function viewportContext() {
  const doc = document.documentElement
  const scrollY = Math.round(window.scrollY)
  const scrollX = Math.round(window.scrollX)
  const innerH = window.innerHeight
  const innerW = window.innerWidth
  const scrollHeight = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0)
  const maxScroll = Math.max(0, scrollHeight - innerH)
  const scrollPercent = maxScroll > 0 ? Math.round((scrollY / maxScroll) * 100) : 100
  const atTop = scrollY <= 2
  const atBottom = scrollY >= maxScroll - 2

  const heads = Array.from(document.querySelectorAll('h1,h2,h3,h4')) as HTMLElement[]
  const visibleHeadings: Array<{ tag: string; text: string; top: number }> = []
  let currentSection = ''
  for (const h of heads) {
    const r = h.getBoundingClientRect()
    const txt = (h.innerText || '').trim().slice(0, 120)
    if (!txt) continue
    if (r.top <= 90) currentSection = txt           // last heading at/above the fold
    if (r.bottom > 0 && r.top < innerH && visibleHeadings.length < 10) {
      visibleHeadings.push({ tag: h.tagName, text: txt, top: Math.round(r.top) })
    }
  }

  return {
    url: location.href,
    title: document.title,
    scrollX, scrollY,
    innerWidth: innerW,
    innerHeight: innerH,
    scrollHeight,
    maxScroll,
    scrollPercent,
    atTop,
    atBottom,
    currentSection,
    visibleHeadings,
    counts: {
      links: document.querySelectorAll('a[href]').length,
      buttons: document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]').length,
      inputs: document.querySelectorAll('input, textarea, select').length,
    },
  }
}

export async function waitScrollSettle(timeout = 900): Promise<void> {
  const start = Date.now()
  let last = window.scrollY
  let stable = 0
  while (Date.now() - start < timeout) {
    await fxSleep(80)
    if (Math.abs(window.scrollY - last) < 1) { if (++stable >= 2) break }
    else stable = 0
    last = window.scrollY
  }
}

export function doPageInfo() {
  return { success: true, ...viewportContext() }
}
