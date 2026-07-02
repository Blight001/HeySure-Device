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
  getAccessibleFrames, isCenterOnMainViewport, isFrameChainVisible, isFrameElement,
  isHTMLElement, isLikelyInteractableInFrame,
  isTopmostAtViewport, isVisibleInOwnerViewport, listIframeElementsIn,
  resolveFrameBySelector, scanRoot, tryFrameContext, visitAccessibleFrames,
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
const MARK_CHANGE_EVENTS = ['scroll', 'resize', 'hashchange', 'popstate', 'pagehide'] as const
const TEXT_NODE_TAGS_TO_SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas'])
const MEDIA_SELECTOR = 'img,video,audio'
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
  if (!isHTMLElement(el)) return ''
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
  if (tag === 'img' || role === 'img') return 'image'
  if (tag === 'video') return 'video'
  if (tag === 'audio') return 'audio'
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
  image: 'image', images: 'image', img: 'image', imgs: 'image', picture: 'image', pictures: 'image',
  video: 'video', videos: 'video',
  audio: 'audio', audios: 'audio',
  media: 'media',
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

function mediaCategoryAllowed(category: string, filter: Set<string> | null): boolean {
  if (!filter) return true
  return filter.has('media') || filter.has(category)
}

function parseStringList(raw: any): string[] {
  if (raw == null) return []
  const parts = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/)
  return parts.map((p: any) => String(p || '').trim()).filter(Boolean)
}

function parseTagFilter(raw: any): Set<string> | null {
  const tags = parseStringList(raw)
    .map(t => t.toLowerCase().replace(/[^a-z0-9-]/g, ''))
    .filter(Boolean)
  return tags.length ? new Set(tags) : null
}

function parseKeyword(raw: any): string {
  return String(raw ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
}

function elementSearchText(el: Element, fallback = ''): string {
  const html = el as HTMLElement
  const parts = [
    fallback,
    textOf(el, 240),
    html.getAttribute('aria-label') || '',
    html.getAttribute('title') || '',
    html.getAttribute('alt') || '',
    html.getAttribute('placeholder') || '',
    html.getAttribute('name') || '',
    html.id || '',
    html.getAttribute('src') || '',
    html.getAttribute('href') || '',
  ]
  return parts.join(' ').replace(/\s+/g, ' ').trim().toLowerCase()
}

function matchesElementFilters(el: Element, tagFilter: Set<string> | null, keyword: string, fallbackText = ''): boolean {
  if (tagFilter && !tagFilter.has(el.tagName.toLowerCase())) return false
  if (keyword && !elementSearchText(el, fallbackText).includes(keyword)) return false
  return true
}

function isDisabled(el: Element): boolean {
  const html = el as HTMLElement
  return html.hasAttribute('disabled') ||
    html.getAttribute('aria-disabled') === 'true' ||
    html.closest('[disabled],[aria-disabled="true"]') !== null
}

function hasInteractiveSemantics(el: Element): boolean {
  if (!isHTMLElement(el) || isDisabled(el)) return false
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
    if (!isHTMLElement(el) || seen.has(el)) return
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

interface ScanScope { doc: Document; frame?: FrameContext }

// The documents one observe pass scans: the whole page (top document plus every
// reachable same-origin frame), or — when the caller passes frame / frame_path —
// just that frame and its own reachable descendants. Scoping lets the AI drill
// into one element-heavy iframe (an embedded editor, say) without paying for the
// rest of the page, which is what keeps the result under the server-side
// tool-result truncation.
function scanScopes(scopeFrame?: FrameContext | null): ScanScope[] {
  if (!scopeFrame) {
    return [
      { doc: document },
      ...getAccessibleFrames(cssPath).map(ctx => ({ doc: ctx.doc, frame: ctx })),
    ]
  }
  const scopes: ScanScope[] = [{ doc: scopeFrame.doc, frame: scopeFrame }]
  visitAccessibleFrames(ctx => scopes.push({ doc: ctx.doc, frame: ctx }), cssPath, scopeFrame.doc, scopeFrame)
  return scopes
}

function collectCandidates(scopes: ScanScope[]): TaggedElement[] {
  const accessibleFrames = new Set(scopes.map(s => s.frame?.frameEl).filter(Boolean))
  const all: TaggedElement[] = []
  for (const scope of scopes) {
    all.push(...collectCandidatesIn(scanRoot(scope.doc), scope.frame))
  }
  // An <iframe> element whose content is being scanned should not itself count
  // as an interactive candidate — its children already represent it.
  return all.filter(item => !(isFrameElement(item.el) && accessibleFrames.has(item.el)))
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

function collectVisibleTexts(limit: number, scopes: ScanScope[]): any[] {
  const out: any[] = []
  for (const scope of scopes) {
    for (const item of collectVisibleTextsIn(scanRoot(scope.doc), limit, scope.frame)) {
      out.push(item)
      if (out.length >= limit) return out
    }
  }
  return out
}

function collectBlockedCandidates(all: TaggedElement[], hittableSet: Set<HTMLElement>, scopes: ScanScope[]): HTMLElement[] {
  const out: HTMLElement[] = []
  const seen = new Set<Element>()
  const add = (el: Element | null) => {
    if (!isHTMLElement(el) || seen.has(el) || hittableSet.has(el)) return
    seen.add(el)
    if (isVisible(el) && (isDisabled(el) || el.matches(CONTROL) || el.matches(INTERACTIVE))) out.push(el)
  }

  all.forEach(item => add(item.el))
  for (const scope of scopes) {
    scanRoot(scope.doc).querySelectorAll(CONTROL).forEach(add)
  }
  return out
}

function collectFrameItems(scopeFrame?: FrameContext | null): { items: any[]; overlay: Array<{ el: HTMLIFrameElement; frame?: FrameContext }> } {
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
          : 'iframe (content not directly accessible from parent — cross-origin or isolated; 其内容若可注入会以 crossOrigin=true 的 items 合并返回)',
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

  if (scopeFrame) visit(scopeFrame.doc, scopeFrame)
  else visit(document)
  return { items, overlay }
}

// Real document URLs of every frame the same-origin recursion actually reached.
// The background compares this list against chrome.webNavigation's frame list to
// find frames that *look* same-origin by URL but are not reachable through
// contentDocument (document.domain mismatch — e.g. bilibili sets it on some pages
// but not others — or sandboxed frames), and gives those their own per-frame
// observe pass instead of silently losing their content.
export function accessibleFrameDocUrls(): string[] {
  const out: string[] = []
  for (const ctx of getAccessibleFrames(cssPath)) {
    try {
      const href = ctx.doc.location?.href
      if (href && href !== 'about:blank') out.push(href)
    } catch { /* frame detached mid-scan */ }
  }
  return out
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

interface MediaRecord {
  el: HTMLElement
  frame?: FrameContext
  kind: 'media'
  category: string
  tag: string
  role: string
  text: string
  selector: string
  center: { x: number; y: number }
  rect: { x: number; y: number; w: number; h: number }
  src?: string
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

function mediaRecord(el: HTMLElement, frame?: FrameContext): MediaRecord {
  const r = el.getBoundingClientRect()
  const tag = el.tagName.toLowerCase()
  const category = elementCategory(el)
  const src = (el as HTMLMediaElement).currentSrc || (el as HTMLImageElement).src || el.getAttribute('src') || ''
  const alt = el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || ''
  return {
    el,
    frame,
    kind: 'media',
    category,
    tag,
    role: el.getAttribute('role') || (category === 'image' ? 'img' : category),
    text: (alt || textOf(el, 80) || src.split('/').pop() || category).slice(0, 120),
    selector: cssPath(el),
    center: frame ? elementViewportCenter(el, frame) : centerInfo(r),
    rect: frame ? elementViewportRect(el, frame) : rectInfo(r),
    ...(src ? { src: src.slice(0, 240) } : {}),
  }
}

function mediaItemFromRecord(rec: MediaRecord) {
  const item: any = {
    kind: 'media',
    category: rec.category,
    role: rec.role,
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
  if (rec.src) item.src = rec.src
  return item
}

function collectVisibleMediaIn(root: ParentNode, frame?: FrameContext): MediaRecord[] {
  const out: MediaRecord[] = []
  const seen = new Set<Element>()
  const add = (el: Element | null) => {
    if (!isHTMLElement(el) || seen.has(el)) return
    seen.add(el)
    if (!isVisible(el) || isInsideInteractive(el)) return
    const r = frame ? elementViewportRect(el, frame) : rectInfo(el.getBoundingClientRect())
    if (r.w <= 0 || r.h <= 0) return
    const center = frame ? elementViewportCenter(el, frame) : centerInfo(el.getBoundingClientRect())
    if (center.y < 0 || center.x < 0 || center.y > window.innerHeight || center.x > window.innerWidth) return
    out.push(mediaRecord(el, frame))
  }
  for (const scanRoot of enumerateScanRoots(root)) {
    scanRoot.querySelectorAll(MEDIA_SELECTOR).forEach(add)
  }
  return out
}

function collectVisibleMedia(scopes: ScanScope[]): MediaRecord[] {
  const out: MediaRecord[] = []
  for (const scope of scopes) {
    out.push(...collectVisibleMediaIn(scanRoot(scope.doc), scope.frame))
  }
  return out
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

let markMutationObservers: MutationObserver[] = []
let markAutoClearTimer: number | null = null

function isOwnMarkNode(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE
    ? node as Element
    : node.parentElement
  return !!el?.closest?.(`#${MARK_LAYER_ID},#${MARK_STYLE_ID}`)
}

function isPageMutation(records: MutationRecord[]): boolean {
  return records.some(record => {
    if (isOwnMarkNode(record.target)) return false
    return [...record.addedNodes, ...record.removedNodes].some(node => !isOwnMarkNode(node)) ||
      record.type === 'characterData' ||
      record.type === 'attributes'
  })
}

function stopMarksAutoClear(): void {
  if (markAutoClearTimer !== null) {
    window.clearTimeout(markAutoClearTimer)
    markAutoClearTimer = null
  }
  markMutationObservers.forEach(observer => observer.disconnect())
  markMutationObservers = []
  MARK_CHANGE_EVENTS.forEach(event => window.removeEventListener(event, clearMarksOverlay, true))
}

export function clearMarksOverlay(): void {
  stopMarksAutoClear()
  document.getElementById(MARK_LAYER_ID)?.remove()
}

function watchDocumentForMarkChanges(doc: Document): void {
  const root = doc.documentElement || doc.body
  if (!root) return
  const observer = new MutationObserver(records => {
    if (isPageMutation(records)) clearMarksOverlay()
  })
  observer.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  })
  markMutationObservers.push(observer)
}

function startMarksAutoClear(marks: Array<{ frame?: FrameContext }>): void {
  stopMarksAutoClear()
  markAutoClearTimer = window.setTimeout(() => {
    markAutoClearTimer = null
    const docs = new Set<Document>([document])
    marks.forEach(mark => {
      if (mark.frame?.doc) docs.add(mark.frame.doc)
    })
    docs.forEach(watchDocumentForMarkChanges)
    MARK_CHANGE_EVENTS.forEach(event => window.addEventListener(event, clearMarksOverlay, true))
  }, 150)
}

// Project one item down to just what the AI needs to understand + act on it.
// The model clicks by ref:id (interactive items), so the long CSS-path selector
// and the full rect are pure overhead — dropping them (plus the low-value tag,
// kept implicitly in role/category) keeps the payload dense so far more of the
// page survives the server-side 12000-char tool-result truncation. center is
// retained for screenshot correlation / coordinate fallback.
const ITEM_DROP_KEYS = new Set(['selector', 'rect', 'tag'])
function slimItem(item: any): any {
  const out: any = {}
  for (const k of Object.keys(item)) {
    if (ITEM_DROP_KEYS.has(k)) continue
    out[k] = item[k]
  }
  return out
}

function itemCategory(item: any): string {
  if (item?.kind === 'text') return 'text'
  if (item?.kind === 'frame') return 'frame'
  return String(item?.category || item?.kind || 'other')
}

function countItemsByCategory(items: any[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const key = itemCategory(item)
    counts[key] = (counts[key] || 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0])))
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
  startMarksAutoClear(marks)
}

export function doObserve(msg: any) {
  clearMarksOverlay()  // never include our own previous overlay in the next scan
  const limit = Math.min(Math.max(Number(msg.limit ?? 120), 1), 200)
  const includeText = msg.include_text !== false
  const textLimit = Math.min(Math.max(Number(msg.text_limit ?? 200), 0), 500)
  const defaultMaxItems = includeText ? Math.min(500, limit + textLimit + 40) : limit
  const maxItems = Math.min(Math.max(Number(msg.max_items ?? defaultMaxItems), 1), 500)
  const categoryFilter = parseFilter(msg.filter)
  const tagFilter = parseTagFilter(msg.tag ?? msg.tags)
  const keyword = parseKeyword(msg.keyword ?? msg.query ?? msg.text_filter)
  const wantText = !categoryFilter || categoryFilter.has('text')
  const wantFrame = !categoryFilter || categoryFilter.has('frame')

  // Optional frame scoping: observe only one same-origin iframe (and its
  // descendants). This is the escape hatch when the full-page result is too
  // large — the editor iframe alone fits comfortably where page+iframe doesn't.
  const wantsScope = !!(msg.frame || msg.frame_selector || (Array.isArray(msg.frame_path) && msg.frame_path.length))
  const scopeFrame = wantsScope ? resolveFrameBySelector(msg.frame ?? msg.frame_selector, msg.frame_path) : null
  if (wantsScope && !scopeFrame) {
    throw new Error(`Frame not found or not accessible: ${msg.frame || msg.frame_selector || (msg.frame_path || []).join(' > ')} — 用 browser_observe {filter:"frame"} 查看可用 iframe 的 frameSelector/framePath。`)
  }
  const scopes = scanScopes(scopeFrame)

  const all = collectCandidates(scopes)
  const iframeCandidates = all.filter(item => item.frame)
  const isItemHittable = (item: TaggedElement) => item.frame
    ? isLikelyInteractableInFrame(item.el, item.frame)
    : isHittable(item.el)
  const hittable = all.filter(isItemHittable)
  const iframeHittable = hittable.filter(item => item.frame)
  const set = new Set<HTMLElement>(hittable.map(item => item.el))
  const blockedForMarks = collectBlockedCandidates(all, set, scopes)
  const frameScan = collectFrameItems(scopeFrame)
  const frameItems = wantFrame
    ? frameScan.items.filter(frame =>
      (!tagFilter || tagFilter.has('iframe')) &&
      (!keyword || [frame.text, frame.name, frame.title, frame.src].join(' ').toLowerCase().includes(keyword)))
    : []
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
    .filter(rec => matchesElementFilters(rec.el, tagFilter, keyword, rec.text))
  interactiveRecords.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
  const slicedRecords = interactiveRecords.slice(0, limit)

  const mediaRecords = (!categoryFilter || categoryFilter.has('media') || categoryFilter.has('image') || categoryFilter.has('video') || categoryFilter.has('audio'))
    ? collectVisibleMedia(scopes)
      .filter(rec => mediaCategoryAllowed(rec.category, categoryFilter))
      .filter(rec => matchesElementFilters(rec.el, tagFilter, keyword, rec.text))
      .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
    : []

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

  const rawTexts = (includeText && wantText) ? collectVisibleTexts(textLimit, scopes)
    .filter((t: any) => (!tagFilter || tagFilter.has(String(t.tag || '').toLowerCase())) && (!keyword || String(t.text || '').toLowerCase().includes(keyword)))
    : []
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

  const mediaItems = mediaRecords.map(mediaItemFromRecord)
  const candidateItems = [...textItems, ...frameItems, ...mediaItems, ...interactiveRecords.map((rec, i) => interactiveItemFromRecord(rec, i + 1))]
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || kindSortRank(a.kind) - kindSortRank(b.kind))
  const categoryCounts = countItemsByCategory(candidateItems)
  const tooMany = interactiveRecords.length > limit || candidateItems.length > maxItems

  if (tooMany && msg.allow_truncate !== true) {
    setMarks([])
    const ctx = viewportContext()
    return {
      success: true,
      source: 'browser_observe',
      url: location.href,
      title: document.title,
      count: 0,
      textCount: 0,
      itemCount: candidateItems.length,
      frameCount: frameItems.length,
      tooMany: true,
      overLimit: true,
      maxItems,
      categoryCounts,
      stats: {
        candidates: all.length,
        hittable: hittable.length,
        afterDedupe: pruned.length,
        blocked: blockedForMarks.length,
        limit,
        maxItems,
        textLimit,
        includeText,
        filter: categoryFilter ? Array.from(categoryFilter) : null,
        tag: tagFilter ? Array.from(tagFilter) : null,
        keyword: keyword || null,
        media: mediaRecords.length,
        frames: frameItems.length,
        accessibleFrames: frameItems.filter(f => f.accessible).length,
        iframeCandidates: iframeCandidates.length,
        iframeHittable: iframeHittable.length,
      },
      marked: false,
      scroll: { y: ctx.scrollY, percent: ctx.scrollPercent, atTop: ctx.atTop, atBottom: ctx.atBottom },
      currentSection: ctx.currentSection,
      ...(scopeFrame ? { scopedToFrame: buildFramePath(scopeFrame) } : {}),
      items: [],
      hint: `当前 observe 匹配到 ${candidateItems.length} 个条目（可交互 ${interactiveRecords.length} 个），超过 limit=${limit} 或 max_items=${maxItems}，为避免返回过多内容已不返回 items。请使用 filter（button/link/input/image/video/text/frame 等）、tag/tags、keyword，或提高 limit/max_items；也可传 frame（iframe 的 frameSelector）或 frame_path 只观察某个 iframe 内部；categoryCounts 给出了各类别数量。`,
    }
  }

  const items = [...textItems, ...frameItems, ...mediaItems, ...interactiveItems]
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
    ? ` 已按 filter=[${Array.from(categoryFilter).join(',')}] 过滤：只返回这些类别（interactive 项的 category 字段标明类别：button/link/input/select/checkbox/radio/tab/menuitem/option/label/other；media 项 category=image/video/audio；text=普通文本，frame=iframe 边界）。`
    : ''
  const queryHint = [
    tagFilter ? `tag=[${Array.from(tagFilter).join(',')}]` : '',
    keyword ? `keyword="${keyword}"` : '',
  ].filter(Boolean).join(' ')
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
    accessibleFrameUrls: accessibleFrameDocUrls(),
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
      tag: tagFilter ? Array.from(tagFilter) : null,
      keyword: keyword || null,
      media: mediaRecords.length,
      frames: frameItems.length,
      accessibleFrames: frameItems.filter(f => f.accessible).length,
      iframeCandidates: iframeCandidates.length,
      iframeHittable: iframeHittable.length,
    },
    truncated: interactiveRecords.length > slicedRecords.length,
    textTruncated: includeText && rawTexts.length >= textLimit,
    tooMany: false,
    maxItems,
    categoryCounts,
    marked,
    scroll: { y: ctx.scrollY, percent: ctx.scrollPercent, atTop: ctx.atTop, atBottom: ctx.atBottom },
    currentSection: ctx.currentSection,
    ...(scopeFrame ? { scopedToFrame: buildFramePath(scopeFrame) } : {}),
    items: items.map(slimItem),
    hint: '返回 items 单一混排列表（按位置排序，已去重——不再单独返回 texts/elements/frames，全部内容都在 items 里，用 kind 区分）：' +
      'kind=text 可见文本（不可点击），kind=media 图片/视频/音频（不可点击；category=image/video/audio），kind=frame 页面内 iframe 边界（accessible=true 表示同源已扫描，子元素见 inFrame=true 的 interactive；accessible=false 为跨域不可用坐标点击），kind=interactive 可点击元素（每个带独立 id，用 browser_action {action:"click", ref:id} 点击）。' +
      ' 为节省上下文每条已省略 selector/rect/tag，仅保留 role/category/text/center；inFrame=true 表示元素在同源 iframe 内，frameSelector 指向所属 iframe。' +
      ' 勿使用 Playwright 语法（如 :has-text）；用 text 参数或 observe 返回的 ref 定位。' +
      filterHint + (queryHint ? ` 已按 ${queryHint} 筛选。` : '') + markHint,
  }
}

function kindSortRank(kind: string): number {
  if (kind === 'text') return 0
  if (kind === 'media') return 1
  if (kind === 'frame') return 2
  return 3
}
