// content/observe.ts — the perception primitive behind browser_observe.
//
// Returns both visible page text and elements a real user could interact with
// on the current screen. Interactive elements get a 1-based id so the AI can
// click them precisely with browser_click {ref:id}; plain visible text is kept
// separate so reading the page is not confused with clicking controls.
//
// Every interactive control is returned individually (no same-type collapsing),
// so each gets its own id. Use the filter param to narrow by category when a page
// has too many controls.
//
// When mark!==false it also paints static status-colored outlines on the page
// (border only, no fill animation) so a follow-up browser_screenshot shows
// clickable controls in green and blocked controls in red. The overlay is
// attached to <html> (not <body>), pointer-events:none, so it never pollutes
// browser_get_content / browser_dom_snapshot (which read from <body>) and never
// intercepts clicks or future hit-tests.

import { isHittable, isVisible, cssPath, textOf, elementArea } from './dom'
import {
  FrameContext, buildFramePath, elementViewportCenter, elementViewportRect,
  getAccessibleFrames, isCenterOnMainViewport, isFrameChainVisible, isLikelyInteractableInFrame,
  isTopmostAtViewport, isVisibleInOwnerViewport, listIframeElementsIn, scanRoot, tryFrameContext,
} from './iframe'
import { setMarks } from './marks'
import { viewportContext } from './viewport'

const INTERACTIVE = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
  '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
  '[role="switch"]', '[role="option"]', '[contenteditable=""]', '[contenteditable="true"]',
  '[onclick]', '[tabindex]:not([tabindex="-1"])', 'summary', 'label[for]',
  '[aria-expanded]', '[aria-haspopup]', '[aria-controls]', '[aria-pressed]', '[aria-selected]',
  '[draggable="true"]',
].join(',')

const MARK_LAYER_ID = '__hs_marks_layer'
const MARK_STYLE_ID = '__hs_marks_style'
const TEXT_NODE_TAGS_TO_SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas'])
const CONTROL = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
  'summary', 'label[for]',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
  '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
  '[role="switch"]', '[role="option"]', '[contenteditable=""]', '[contenteditable="true"]',
].join(',')

function implicitRole(el: Element): string {
  const tag = el.tagName.toLowerCase()
  if (tag === 'a') return 'link'
  if (tag === 'button' || tag === 'summary') return 'button'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'input') {
    const t = (el as HTMLInputElement).type
    if (t === 'checkbox' || t === 'radio' || t === 'button' || t === 'submit') return t
    return 'textbox'
  }
  return ''
}

// Custom widgets built from a plain <div>/<span> plus a framework click handler
// (Vue @click, React onClick) expose no role / onclick / tabindex, and often not
// even cursor:pointer, so every structural check misses them. As a last-resort
// signal we read the element's own class/id: a token that *ends in* button / btn
// / link is a strong author hint that this node is that control. The keyword must
// sit at a token boundary end so an inner label like "edit-text-button-text"
// (ends in -text) is NOT matched while the real control "edit-text-button" is.
const NAME_ROLE_PATTERNS: Array<{ re: RegExp; category: string }> = [
  { re: /(^|[-_])(btn|button)$/i, category: 'button' },
  { re: /(^|[-_])link$/i, category: 'link' },
]

function nameRole(el: Element): string {
  if (!(el instanceof HTMLElement)) return ''
  const tokens = [...String(el.className || '').split(/\s+/), el.id || ''].filter(Boolean)
  for (const token of tokens) {
    for (const { re, category } of NAME_ROLE_PATTERNS) {
      if (re.test(token)) return category
    }
  }
  return ''
}

// Coarse, human-meaningful bucket for an interactive element so callers can
// filter by "只看按钮 / 只看输入框 / 只看下拉" without knowing tag/role/type
// internals. Mirrors implicitRole but collapses synonyms (input[type=submit] →
// button, role=switch → checkbox, …) into a small stable vocabulary.
function elementCategory(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const role = (el.getAttribute('role') || '').toLowerCase()
  if (tag === 'textarea') return 'input'
  if (tag === 'select' || role === 'combobox' || role === 'listbox') return 'select'
  if (tag === 'input') {
    const t = ((el as HTMLInputElement).type || 'text').toLowerCase()
    if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button'
    if (t === 'checkbox') return 'checkbox'
    if (t === 'radio') return 'radio'
    return 'input'
  }
  if (el.matches('[contenteditable=""],[contenteditable="true"]')) return 'input'
  if (role === 'textbox' || role === 'searchbox') return 'input'
  if (role === 'button' || tag === 'button' || tag === 'summary') return 'button'
  if (role === 'link' || tag === 'a') return 'link'
  if (role === 'checkbox' || role === 'switch') return 'checkbox'
  if (role === 'radio') return 'radio'
  if (role === 'tab') return 'tab'
  if (role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio') return 'menuitem'
  if (role === 'option') return 'option'
  if (tag === 'label') return 'label'
  return nameRole(el) || 'other'
}

// Normalize one user-supplied filter token to a canonical category, or '' to
// ignore. Returns the sentinel 'all' to mean "no filtering" so a caller can
// reset. Accepts common plurals/synonyms so the AI doesn't have to guess.
const FILTER_ALIASES: Record<string, string> = {
  button: 'button', buttons: 'button', btn: 'button',
  link: 'link', links: 'link', anchor: 'link', a: 'link',
  input: 'input', inputs: 'input', textbox: 'input', textfield: 'input', textarea: 'input', editable: 'input',
  select: 'select', selects: 'select', dropdown: 'select', combobox: 'select', combo: 'select',
  checkbox: 'checkbox', checkboxes: 'checkbox', check: 'checkbox', toggle: 'checkbox', switch: 'checkbox',
  radio: 'radio', radios: 'radio',
  tab: 'tab', tabs: 'tab',
  menuitem: 'menuitem', menu: 'menuitem', menuitems: 'menuitem',
  option: 'option', options: 'option',
  label: 'label', labels: 'label',
  text: 'text', texts: 'text', 'text-element': 'text',
  frame: 'frame', frames: 'frame', iframe: 'frame', iframes: 'frame',
  interactive: 'interactive', interactives: 'interactive', clickable: 'interactive', control: 'interactive', controls: 'interactive',
  all: 'all', any: 'all', '*': 'all',
}

function normalizeFilterToken(raw: string): string {
  return FILTER_ALIASES[raw.trim().toLowerCase()] ?? ''
}

// Parse msg.filter (array or comma/space-separated string) into a Set of
// canonical categories, or null when there is no effective filter (empty, all
// unknown tokens, or an explicit 'all').
function parseFilter(raw: any): Set<string> | null {
  if (raw == null) return null
  const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split(/[,\s]+/)
  const out = new Set<string>()
  for (const part of parts) {
    const token = normalizeFilterToken(part)
    if (token === 'all') return null
    if (token) out.add(token)
  }
  return out.size ? out : null
}

function interactiveCategoryAllowed(category: string, filter: Set<string> | null): boolean {
  if (!filter) return true
  return filter.has('interactive') || filter.has(category)
}

function isDisabled(el: Element): boolean {
  const html = el as HTMLElement
  return html.hasAttribute('disabled') ||
    html.getAttribute('aria-disabled') === 'true' ||
    html.closest('[disabled],[aria-disabled="true"]') !== null
}

function hasInteractiveSemantics(el: Element): boolean {
  if (!(el instanceof HTMLElement) || isDisabled(el)) return false
  if (el.matches(INTERACTIVE)) return true
  if (nameRole(el)) return true
  const s = getComputedStyle(el)
  return s.cursor === 'pointer'
}

function isInsideInteractive(el: Element): boolean {
  const stop = el.ownerDocument.body || el.ownerDocument.documentElement
  let cur: Element | null = el
  while (cur && cur !== stop) {
    if (hasInteractiveSemantics(cur)) return true
    cur = cur.parentElement
  }
  return false
}

interface TaggedElement {
  el: HTMLElement
  frame?: FrameContext
}

function enumerateScanRoots(root: ParentNode): ParentNode[] {
  const doc = root.ownerDocument || document
  const roots: ParentNode[] = [root]
  const seen = new Set<ParentNode>([root])
  const add = (node: ParentNode | null | undefined) => {
    if (!node || seen.has(node)) return
    seen.add(node)
    roots.push(node)
  }
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
  while (walker.nextNode()) {
    const el = walker.currentNode as HTMLElement
    add(el.shadowRoot)
  }
  return roots
}

function collectCandidatesIn(root: ParentNode, frame?: FrameContext): TaggedElement[] {
  const out: TaggedElement[] = []
  const seen = new Set<Element>()
  const add = (el: Element | null) => {
    if (!(el instanceof HTMLElement) || seen.has(el)) return
    seen.add(el)
    if (hasInteractiveSemantics(el) && isVisible(el)) out.push({ el, frame })
  }

  for (const scanRoot of enumerateScanRoots(root)) {
    scanRoot.querySelectorAll(INTERACTIVE).forEach(add)
    const walker = (scanRoot.ownerDocument || document).createTreeWalker(scanRoot, NodeFilter.SHOW_ELEMENT)
    let scanned = 0
    while (walker.nextNode() && scanned < 6000) {
      scanned += 1
      add(walker.currentNode as Element)
    }
  }

  return out
}

function accessibleFrameSet(): Set<HTMLIFrameElement> {
  return new Set(getAccessibleFrames(cssPath).map(f => f.frameEl))
}

function collectCandidates(): TaggedElement[] {
  const accessibleFrames = accessibleFrameSet()
  const all = collectCandidatesIn(scanRoot(document))
  for (const ctx of getAccessibleFrames(cssPath)) {
    all.push(...collectCandidatesIn(scanRoot(ctx.doc), ctx))
  }
  return all.filter(item => !(item.frame === undefined && item.el instanceof HTMLIFrameElement && accessibleFrames.has(item.el)))
}

function isStrongControl(el: Element): boolean {
  return el.matches('a[href],button,input:not([type="hidden"]),select,textarea,summary,label[for],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="switch"],[contenteditable=""],[contenteditable="true"]')
}

function textRole(el: Element): string {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
  if (/^h[1-6]$/.test(tag)) return 'heading'
  if (tag === 'label') return 'label'
  if (tag === 'li') return 'listitem'
  if (tag === 'th' || tag === 'td') return 'cell'
  if (tag === 'p') return 'paragraph'
  return 'text'
}

function rectInfo(r: DOMRect) {
  return {
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.width),
    h: Math.round(r.height),
  }
}

function centerInfo(r: DOMRect) {
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
  }
}

function isUsableTextRect(parent: HTMLElement, r: DOMRect, frame?: FrameContext): boolean {
  if (r.width <= 0 || r.height <= 0) return false
  const center = frame ? elementViewportCenter(parent, frame) : {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2,
  }
  if (center.y < 0 || center.x < 0 || center.y > window.innerHeight || center.x > window.innerWidth) return false
  if (frame) {
    return isVisibleInOwnerViewport(parent) && isFrameChainVisible(frame) && isCenterOnMainViewport(frame, parent)
  }
  return isTopmostAtViewport(parent, center.x, center.y)
}

function collectVisibleTextsIn(root: ParentNode, limit: number, frame?: FrameContext): any[] {
  const out: any[] = []
  const seen = new Set<string>()
  const doc = root.ownerDocument || document

  const walkText = (scanRoot: ParentNode) => {
  const walker = doc.createTreeWalker(scanRoot, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = String(node.textContent || '').replace(/\s+/g, ' ').trim()
      if (!text) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (!parent || TEXT_NODE_TAGS_TO_SKIP.has(parent.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT
      if (!isVisible(parent) || isInsideInteractive(parent)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })

  let scanned = 0
  while (walker.nextNode() && out.length < limit && scanned < 8000) {
    scanned += 1
    const node = walker.currentNode as Text
    const parent = node.parentElement
    if (!parent || !isVisible(parent)) continue
    const text = String(node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240)
    if (!text) continue

    const range = doc.createRange()
    range.selectNodeContents(node)
    const rects = Array.from(range.getClientRects())
    range.detach()
    const rect = rects.find(r => isUsableTextRect(parent, r, frame))
    if (!rect) continue

    const selector = cssPath(parent)
    const viewportRect = frame ? elementViewportRect(parent, frame) : rectInfo(rect)
    const viewportCenter = frame ? elementViewportCenter(parent, frame) : centerInfo(rect)
    const rectKey = `${Math.round(viewportRect.x / 4)}:${Math.round(viewportRect.y / 4)}:${Math.round(viewportRect.w / 4)}:${Math.round(viewportRect.h / 4)}`
    const key = `${selector}|${text}|${rectKey}|${frame?.frameSelector || ''}`
    if (seen.has(key)) continue
    seen.add(key)

    const role = textRole(parent)
    const tag = parent.tagName.toLowerCase()
    out.push({
      kind: 'text',
      role,
      tag,
      text,
      selector,
      center: viewportCenter,
      rect: viewportRect,
      ...(frame ? { inFrame: true, frameSelector: frame.frameSelector, framePath: buildFramePath(frame) } : {}),
    })
  }
  }

  for (const scanRoot of enumerateScanRoots(root)) {
    walkText(scanRoot)
    if (out.length >= limit) break
  }
  return out
}

function collectVisibleTexts(limit: number): any[] {
  const out: any[] = []
  for (const chunk of [
    collectVisibleTextsIn(scanRoot(document), limit),
    ...getAccessibleFrames(cssPath).map(ctx => collectVisibleTextsIn(scanRoot(ctx.doc), limit, ctx)),
  ]) {
    for (const item of chunk) {
      out.push(item)
      if (out.length >= limit) return out
    }
  }
  return out
}

function collectBlockedCandidates(all: TaggedElement[], hittableSet: Set<HTMLElement>): HTMLElement[] {
  const out: HTMLElement[] = []
  const seen = new Set<Element>()
  const add = (el: Element | null) => {
    if (!(el instanceof HTMLElement) || seen.has(el) || hittableSet.has(el)) return
    seen.add(el)
    if (isVisible(el) && (isDisabled(el) || el.matches(CONTROL) || el.matches(INTERACTIVE))) out.push(el)
  }

  all.forEach(item => add(item.el))
  document.querySelectorAll(CONTROL).forEach(add)
  for (const ctx of getAccessibleFrames(cssPath)) {
    scanRoot(ctx.doc).querySelectorAll(CONTROL).forEach(add)
  }
  return out
}

function collectFrameItems(): { items: any[]; overlay: Array<{ el: HTMLIFrameElement; frame?: FrameContext }> } {
  const items: any[] = []
  const overlay: Array<{ el: HTMLIFrameElement; frame?: FrameContext }> = []

  const visit = (doc: Document, parentFrame?: FrameContext) => {
    for (const el of listIframeElementsIn(doc)) {
      const base = tryFrameContext(el)
      const localR = el.getBoundingClientRect()
      const rect = parentFrame ? elementViewportRect(el, parentFrame) : rectInfo(localR)
      const center = parentFrame ? elementViewportCenter(el, parentFrame) : centerInfo(localR)
      const selector = cssPath(el)
      const ctx = base ? { ...base, frameSelector: selector, parent: parentFrame } as FrameContext : null
      const src = el.src || el.getAttribute('src') || ''
      const name = el.name || el.getAttribute('name') || ''
      const title = ctx?.doc.title || ''
      const label = title || name || src || 'iframe'

      items.push({
        kind: 'frame',
        accessible: !!ctx,
        tag: 'iframe',
        role: 'document',
        text: ctx
          ? `iframe (same-origin: ${label})`
          : 'iframe (cross-origin, content not accessible)',
        name,
        title,
        src,
        selector,
        frameSelector: selector,
        framePath: ctx ? buildFramePath(ctx) : (parentFrame ? [...buildFramePath(parentFrame), selector] : [selector]),
        center,
        rect,
        ...(parentFrame ? { parentFrameSelector: parentFrame.frameSelector } : {}),
      })
      overlay.push({ el, frame: parentFrame })

      if (ctx) visit(ctx.doc, ctx)
    }
  }

  visit(document)
  return { items, overlay }
}

type MarkStatus = 'clickable' | 'blocked' | 'frame'

interface ElementRecord {
  el: HTMLElement
  frame?: FrameContext
  tag: string
  role: string
  type?: string
  text: string
  selector: string
  center: { x: number; y: number }
  rect: { x: number; y: number; w: number; h: number }
  category: string
}

function elementRecord(el: HTMLElement, frame?: FrameContext): ElementRecord {
  const r = el.getBoundingClientRect()
  const tag = el.tagName.toLowerCase()
  const role = el.getAttribute('role') || implicitRole(el)
  const type = (el as HTMLInputElement).type || undefined
  return {
    el,
    frame,
    tag,
    role,
    type,
    text: textOf(el, 80),
    selector: cssPath(el),
    center: frame ? elementViewportCenter(el, frame) : centerInfo(r),
    rect: frame ? elementViewportRect(el, frame) : rectInfo(r),
    category: elementCategory(el),
  }
}

function interactiveItemFromRecord(rec: ElementRecord, id: number) {
  const item: any = {
    kind: 'interactive',
    id,
    tag: rec.tag,
    role: rec.role,
    category: rec.category,
    text: rec.text,
    selector: rec.selector,
    center: rec.center,
    rect: rec.rect,
  }
  if (rec.frame) {
    item.inFrame = true
    item.frameSelector = rec.frame.frameSelector
    item.framePath = buildFramePath(rec.frame)
  }
  if (rec.type) item.type = rec.type
  if ((rec.el as HTMLInputElement).value) item.value = String((rec.el as HTMLInputElement).value).slice(0, 60)
  return item
}

function shouldDropNested(child: HTMLElement, parent: HTMLElement): boolean {
  if (isStrongControl(child)) return false
  if (isStrongControl(parent)) return true

  const childText = textOf(child, 120)
  const parentText = textOf(parent, 120)
  const childArea = elementArea(child)
  const parentArea = elementArea(parent)

  if (childText && parentText && childText !== parentText) return false
  if (parentArea > 0 && childArea / parentArea < 0.65) return false
  return true
}

export function clearMarksOverlay(): void {
  document.getElementById(MARK_LAYER_ID)?.remove()
}

function ensureMarkStyles() {
  let style = document.getElementById(MARK_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = MARK_STYLE_ID
    document.documentElement.appendChild(style)
  }
  style.textContent = `
    #${MARK_LAYER_ID} .hs-mark-box{
      position:fixed;box-sizing:border-box;pointer-events:none;
      border:2px solid var(--hs-mark-color);border-radius:4px;
      background:transparent;}
    #${MARK_LAYER_ID} .hs-mark-clickable{--hs-mark-color:rgba(34,197,94,.92);}
    #${MARK_LAYER_ID} .hs-mark-blocked{--hs-mark-color:rgba(239,68,68,.92);}
    #${MARK_LAYER_ID} .hs-mark-frame{--hs-mark-color:rgba(168,85,247,.88);border-style:dashed;}`
}

function drawMarksOverlay(marks: Array<{ el: Element; status: MarkStatus; frame?: FrameContext }>): void {
  clearMarksOverlay()
  ensureMarkStyles()
  const layer = document.createElement('div')
  layer.id = MARK_LAYER_ID
  layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;z-index:2147483646;pointer-events:none;'
  marks.forEach(({ el, status, frame }) => {
    const rect = frame
      ? elementViewportRect(el as HTMLElement, frame)
      : rectInfo((el as HTMLElement).getBoundingClientRect())
    const box = document.createElement('div')
    box.className = `hs-mark-box hs-mark-${status}`
    box.style.left = `${rect.x}px`
    box.style.top = `${rect.y}px`
    box.style.width = `${Math.max(0, rect.w)}px`
    box.style.height = `${Math.max(0, rect.h)}px`
    layer.appendChild(box)
  })
  document.documentElement.appendChild(layer)
}

export function doObserve(msg: any) {
  clearMarksOverlay()  // never include our own previous overlay in the next scan
  const limit = Math.min(Math.max(Number(msg.limit ?? 120), 1), 200)
  const includeText = msg.include_text !== false
  const textLimit = Math.min(Math.max(Number(msg.text_limit ?? 200), 0), 500)
  const categoryFilter = parseFilter(msg.filter)
  const wantText = !categoryFilter || categoryFilter.has('text')
  const wantFrame = !categoryFilter || categoryFilter.has('frame')

  const all = collectCandidates()
  const iframeCandidates = all.filter(item => item.frame)
  const isItemHittable = (item: TaggedElement) => item.frame
    ? isLikelyInteractableInFrame(item.el, item.frame)
    : isHittable(item.el)
  const hittable = all.filter(isItemHittable)
  const iframeHittable = hittable.filter(item => item.frame)
  const set = new Set<HTMLElement>(hittable.map(item => item.el))
  const blockedForMarks = collectBlockedCandidates(all, set)
  const frameScan = collectFrameItems()
  const frameItems = wantFrame ? frameScan.items : []
  const frameOverlay = wantFrame ? frameScan.overlay : []
  const frameChildCounts = new Map<string, number>()
  for (const item of all) {
    if (!item.frame) continue
    const key = buildFramePath(item.frame).join('>')
    frameChildCounts.set(key, (frameChildCounts.get(key) || 0) + 1)
  }
  // Remove only obvious duplicate wrappers. The old rule dropped every nested
  // interactive child when its parent was also interactive, which hides common
  // UI like cards that contain their own buttons/menus.
  const pruned = hittable.filter(item => {
    let p = item.el.parentElement
    while (p) {
      if (set.has(p) && shouldDropNested(item.el, p)) return false
      p = p.parentElement
    }
    return true
  })

  const interactiveRecords = pruned
    .map(item => elementRecord(item.el, item.frame))
    .filter(rec => interactiveCategoryAllowed(rec.category, categoryFilter))
  interactiveRecords.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
  const slicedRecords = interactiveRecords.slice(0, limit)

  const overlayMarks: Array<{ el: Element; status: MarkStatus; frame?: FrameContext }> = []
  const markTargets: Array<{ el: HTMLElement; selector: string; text: string; center: { x: number; y: number }; frameSelector?: string; framePath?: string[] }> = []
  let nextId = 1
  const elements: any[] = []
  const interactiveItems = slicedRecords.map(rec => {
    const id = nextId
    nextId += 1
    markTargets.push({
      el: rec.el,
      selector: rec.selector,
      text: rec.text,
      center: rec.center,
      frameSelector: rec.frame?.frameSelector,
      framePath: rec.frame ? buildFramePath(rec.frame) : undefined,
    })
    const item = interactiveItemFromRecord(rec, id)
    elements.push(item)
    overlayMarks.push({ el: rec.el, status: 'clickable', frame: rec.frame })
    return item
  })

  const rawTexts = (includeText && wantText) ? collectVisibleTexts(textLimit) : []
  const iframeTextCount = rawTexts.filter((t: any) => t.inFrame).length
  const iframeTexts = rawTexts.filter((t: any) => t.inFrame)
  for (const frame of frameItems) {
    if (!frame.accessible) continue
    const key = (frame.framePath || [frame.frameSelector]).join('>')
    frame.interactiveCount = frameChildCounts.get(key) || 0
    const pathKey = (frame.framePath || []).join('>')
    const samples = iframeTexts
      .filter((t: any) => (t.framePath || []).join('>') === pathKey || t.frameSelector === frame.frameSelector)
      .slice(0, 5)
      .map((t: any) => ({ text: t.text, selector: t.selector, center: t.center }))
    if (samples.length) frame.textSamples = samples
    frame.textCount = iframeTexts
      .filter((t: any) => (t.framePath || []).join('>') === pathKey || t.frameSelector === frame.frameSelector)
      .length
    if (!frame.interactiveCount && !samples.length) {
      frame.scanNote = 'iframe 内未扫描到可交互控件或可见文本；可能为纯渲染预览、嵌套跨域 iframe，或内容尚未加载完成'
    } else if (!frame.interactiveCount) {
      frame.scanNote = 'iframe 内仅有可见文本，无可交互控件；发布/投稿按钮通常在主页面 items 中（inFrame=false）'
    }
  }
  const textItems: any[] = rawTexts.map((t: any) => ({
    kind: 'text',
    role: t.role,
    tag: t.tag,
    text: t.text,
    selector: t.selector,
    center: t.center,
    rect: t.rect,
    ...(t.inFrame ? { inFrame: true, frameSelector: t.frameSelector, framePath: t.framePath } : {}),
  }))

  textItems.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)

  const items = [...textItems, ...frameItems, ...interactiveItems]
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || kindSortRank(a.kind) - kindSortRank(b.kind))

  const texts = textItems

  setMarks(markTargets)

  const blockedChosen = blockedForMarks
    .filter(el => interactiveCategoryAllowed(elementCategory(el), categoryFilter))
    .slice(0, limit)
  const marked = msg.mark !== false
  if (marked) {
    drawMarksOverlay([
      ...frameOverlay.map(({ el, frame }) => ({ el, status: 'frame' as const, frame })),
      ...overlayMarks,
      ...blockedChosen.map(el => ({ el, status: 'blocked' as const })),
    ])
  }

  const ctx = viewportContext()
  const filterHint = categoryFilter
    ? ` 已按 filter=[${Array.from(categoryFilter).join(',')}] 过滤：只返回这些类别（interactive 项的 category 字段标明类别：button/link/input/select/checkbox/radio/tab/menuitem/option/label/other；text=普通文本，frame=iframe 边界）。`
    : ''
  const markHint = marked
    ? ' 页面标记：紫色虚线=iframe 边界，绿色=可点击，红色=不可点击/被禁用/被遮挡。'
    : ''

  return {
    success: true,
    source: 'browser_observe',
    url: location.href,
    title: document.title,
    count: elements.length,
    textCount: texts.length,
    itemCount: items.length,
    frameCount: frameItems.length,
    accessibleFrameCount: frameItems.filter(f => f.accessible).length,
    iframeCandidates: iframeCandidates.length,
    iframeHittable: iframeHittable.length,
    iframeTextCount,
    stats: {
      candidates: all.length,
      hittable: hittable.length,
      afterDedupe: pruned.length,
      blocked: blockedForMarks.length,
      limit,
      textLimit,
      includeText,
      filter: categoryFilter ? Array.from(categoryFilter) : null,
      frames: frameItems.length,
      accessibleFrames: frameItems.filter(f => f.accessible).length,
      iframeCandidates: iframeCandidates.length,
      iframeHittable: iframeHittable.length,
    },
    truncated: interactiveRecords.length > slicedRecords.length,
    textTruncated: includeText && rawTexts.length >= textLimit,
    marked,
    scroll: { y: ctx.scrollY, percent: ctx.scrollPercent, atTop: ctx.atTop, atBottom: ctx.atBottom },
    currentSection: ctx.currentSection,
    items,
    frames: frameItems,
    texts,
    elements,
    hint: '返回 items：kind=text 可见文本，kind=frame 页面内 iframe 边界（accessible=true 表示同源已扫描，子元素见 inFrame=true 的 interactive；accessible=false 为跨域不可用坐标点击），kind=interactive 可点击元素（每个都带独立 id）。' +
      ' frames 数组与 items 中 kind=frame 条目一致；interactive 可用 browser_click {ref:id} 点击；inFrame=true 表示元素在同源 iframe 内，frameSelector 指向所属 iframe。' +
      ' 勿使用 Playwright 语法（如 :has-text）；用 text 参数或 observe 返回的 ref/selector。' +
      filterHint + markHint,
  }
}

function kindSortRank(kind: string): number {
  if (kind === 'text') return 0
  if (kind === 'frame') return 1
  return 2
}
