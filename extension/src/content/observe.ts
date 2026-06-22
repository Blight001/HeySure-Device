// content/observe.ts — the perception primitive behind browser_observe.
//
// Returns both visible page text and elements a real user could interact with
// on the current screen. Interactive elements get a 1-based id so the AI can
// click them precisely with browser_click {ref:id}; plain visible text is kept
// separate so reading the page is not confused with clicking controls.
//
// When mark!==false it also paints static status-colored outlines on the page
// (border only, no fill animation) so a follow-up browser_screenshot shows
// clickable controls in green, same-type batches in light blue, and blocked
// controls in red. Large same-type batches collapse into kind=group summaries;
// pass expand_group to unfold one batch. The overlay is
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

function isDisabled(el: Element): boolean {
  const html = el as HTMLElement
  return html.hasAttribute('disabled') ||
    html.getAttribute('aria-disabled') === 'true' ||
    html.closest('[disabled],[aria-disabled="true"]') !== null
}

function hasInteractiveSemantics(el: Element): boolean {
  if (!(el instanceof HTMLElement) || isDisabled(el)) return false
  if (el.matches(INTERACTIVE)) return true
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
      groupKey: buildTextGroupKey(role, tag),
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

type MarkStatus = 'clickable' | 'blocked' | 'grouped' | 'frame'

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
  groupKey: string
}

interface TextRecord {
  role: string
  tag: string
  text: string
  selector: string
  center: { x: number; y: number }
  rect: { x: number; y: number; w: number; h: number }
  groupKey: string
  inFrame?: boolean
  frameSelector?: string
  framePath?: string[]
}

function buildInteractiveGroupKey(tag: string, role: string, type?: string): string {
  return `${tag}|${role}|${type || ''}`
}

function buildTextGroupKey(role: string, tag: string): string {
  return `text|${role}|${tag}`
}

function unionRects(rects: Array<{ x: number; y: number; w: number; h: number }>) {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 }
  const left = Math.min(...rects.map(r => r.x))
  const top = Math.min(...rects.map(r => r.y))
  const right = Math.max(...rects.map(r => r.x + r.w))
  const bottom = Math.max(...rects.map(r => r.y + r.h))
  return { x: left, y: top, w: Math.max(0, right - left), h: Math.max(0, bottom - top) }
}

function rectToCenter(rect: { x: number; y: number; w: number; h: number }) {
  return { x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2) }
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
    groupKey: buildInteractiveGroupKey(tag, role, type),
  }
}

function interactiveItemFromRecord(rec: ElementRecord, id: number) {
  const item: any = {
    kind: 'interactive',
    id,
    tag: rec.tag,
    role: rec.role,
    text: rec.text,
    selector: rec.selector,
    center: rec.center,
    rect: rec.rect,
    groupKey: rec.groupKey,
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

function buildInteractiveGroupItem(members: ElementRecord[]) {
  const rect = unionRects(members.map(m => m.rect))
  const first = members[0]
  return {
    kind: 'group',
    groupKey: first.groupKey,
    tag: first.tag,
    role: first.role,
    ...(first.type ? { type: first.type } : {}),
    count: members.length,
    rect,
    center: rectToCenter(rect),
    samples: members.slice(0, 5).map(m => ({
      text: m.text,
      selector: m.selector,
      center: m.center,
      rect: m.rect,
    })),
  }
}

function buildTextGroupItem(members: TextRecord[]) {
  const rect = unionRects(members.map(m => m.rect))
  const first = members[0]
  return {
    kind: 'group',
    groupKey: first.groupKey,
    tag: first.tag,
    role: first.role,
    count: members.length,
    rect,
    center: rectToCenter(rect),
    samples: members.slice(0, 5).map(m => ({
      text: m.text,
      selector: m.selector,
      center: m.center,
      rect: m.rect,
    })),
  }
}

function partitionByKey<T extends { groupKey: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const bucket = map.get(row.groupKey)
    if (bucket) bucket.push(row)
    else map.set(row.groupKey, [row])
  }
  return map
}

function shouldCollapseBatch(
  key: string,
  count: number,
  opts: { groupSimilar: boolean; groupMin: number; groupKeyFilter: string | null; expandGroup: string | null },
): boolean {
  if (!opts.groupSimilar || count < opts.groupMin) return false
  if (opts.groupKeyFilter && key !== opts.groupKeyFilter) return false
  if (opts.expandGroup) return opts.expandGroup !== key
  return true
}

function shouldExpandBatch(key: string, opts: { expandGroup: string | null }): boolean {
  return !!opts.expandGroup && opts.expandGroup === key
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
    #${MARK_LAYER_ID} .hs-mark-grouped{--hs-mark-color:rgba(56,189,248,.9);}
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
  const groupSimilar = msg.group_similar !== false
  const groupMin = Math.min(Math.max(Number(msg.group_min ?? 3), 2), 50)
  const groupKeyFilter = String(msg.group_key || '').trim() || null
  const expandGroup = String(msg.expand_group || '').trim() || null
  const groupOpts = { groupSimilar, groupMin, groupKeyFilter, expandGroup }

  const all = collectCandidates()
  const iframeCandidates = all.filter(item => item.frame)
  const isItemHittable = (item: TaggedElement) => item.frame
    ? isLikelyInteractableInFrame(item.el, item.frame)
    : isHittable(item.el)
  const hittable = all.filter(isItemHittable)
  const iframeHittable = hittable.filter(item => item.frame)
  const set = new Set<HTMLElement>(hittable.map(item => item.el))
  const blockedForMarks = collectBlockedCandidates(all, set)
  const { items: frameItems, overlay: frameOverlay } = collectFrameItems()
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

  const interactiveRecords = pruned.map(item => elementRecord(item.el, item.frame))
  const interactiveBuckets = partitionByKey(interactiveRecords)
  const interactiveDrafts: Array<{ item: any; rec?: ElementRecord }> = []
  const overlayMarks: Array<{ el: Element; status: MarkStatus; frame?: FrameContext }> = []
  const collapsedMembers: ElementRecord[] = []

  for (const members of interactiveBuckets.values()) {
    const key = members[0].groupKey
    const collapse = shouldCollapseBatch(key, members.length, groupOpts)
    const expand = shouldExpandBatch(key, groupOpts)

    if (collapse) {
      interactiveDrafts.push({ item: buildInteractiveGroupItem(members) })
      collapsedMembers.push(...members)
      overlayMarks.push(...members.map(m => ({ el: m.el, status: 'grouped' as const, frame: m.frame })))
      continue
    }

    const markStatus: MarkStatus = expand ? 'grouped' : 'clickable'
    for (const rec of members) {
      interactiveDrafts.push({ item: interactiveItemFromRecord(rec, 0), rec })
      overlayMarks.push({ el: rec.el, status: markStatus, frame: rec.frame })
    }
  }

  interactiveDrafts.sort((a, b) => a.item.rect.y - b.item.rect.y || a.item.rect.x - b.item.rect.x)
  const slicedInteractive = interactiveDrafts.slice(0, limit)

  const markTargets: Array<{ el: HTMLElement; selector: string; text: string; center: { x: number; y: number }; frameSelector?: string; framePath?: string[] }> = []
  let nextId = 1
  const elements: any[] = []
  const interactiveItems = slicedInteractive.map(draft => {
    if (draft.item.kind !== 'interactive' || !draft.rec) return draft.item
    const item = { ...draft.item, id: nextId }
    nextId += 1
    elements.push(item)
    markTargets.push({
      el: draft.rec.el,
      selector: draft.rec.selector,
      text: draft.rec.text,
      center: draft.rec.center,
      frameSelector: draft.rec.frame?.frameSelector,
      framePath: draft.rec.frame ? buildFramePath(draft.rec.frame) : undefined,
    })
    return item
  })

  const rawTexts = includeText ? collectVisibleTexts(textLimit) : []
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
  const textRecords: TextRecord[] = rawTexts.map((t: any) => ({
    role: t.role,
    tag: t.tag,
    text: t.text,
    selector: t.selector,
    center: t.center,
    rect: t.rect,
    groupKey: t.groupKey,
    inFrame: t.inFrame,
    frameSelector: t.frameSelector,
    framePath: t.framePath,
  }))
  const textBuckets = partitionByKey(textRecords)
  const textItems: any[] = []

  for (const members of textBuckets.values()) {
    const key = members[0].groupKey
    if (shouldCollapseBatch(key, members.length, groupOpts)) {
      textItems.push(buildTextGroupItem(members))
      continue
    }
    for (const rec of members) {
      textItems.push({
        kind: 'text',
        role: rec.role,
        tag: rec.tag,
        text: rec.text,
        selector: rec.selector,
        center: rec.center,
        rect: rec.rect,
        groupKey: rec.groupKey,
        ...(rec.inFrame ? { inFrame: true, frameSelector: rec.frameSelector, framePath: rec.framePath } : {}),
      })
    }
  }

  textItems.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)

  const items = [...textItems, ...frameItems, ...interactiveItems]
    .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || kindSortRank(a.kind) - kindSortRank(b.kind))

  const texts = textItems

  const groupedCount = items.filter(item => item.kind === 'group').length
  const groupedMemberCount = collapsedMembers.length

  setMarks(markTargets)

  const blockedChosen = blockedForMarks.slice(0, limit)
  const marked = msg.mark !== false
  if (marked) {
    drawMarksOverlay([
      ...frameOverlay.map(({ el, frame }) => ({ el, status: 'frame' as const, frame })),
      ...overlayMarks,
      ...blockedChosen.map(el => ({ el, status: 'blocked' as const })),
    ])
  }

  const ctx = viewportContext()
  const groupingHint = groupSimilar
    ? ` 默认同类型≥${groupMin}个会折叠为 kind=group；传 expand_group:"<groupKey>" 可单独展开获取编号。`
    : ''
  const markHint = marked
    ? ' 页面标记：紫色虚线=iframe 边界，绿色=可点击，浅蓝=同类型批量/已展开批量，红色=不可点击/被禁用/被遮挡。'
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
    groupCount: groupedCount,
    groupedMemberCount,
    stats: {
      candidates: all.length,
      hittable: hittable.length,
      afterDedupe: pruned.length,
      blocked: blockedForMarks.length,
      limit,
      textLimit,
      includeText,
      groupSimilar,
      groupMin,
      groupKey: groupKeyFilter,
      expandGroup,
      groups: groupedCount,
      groupedMembers: groupedMemberCount,
      frames: frameItems.length,
      accessibleFrames: frameItems.filter(f => f.accessible).length,
      iframeCandidates: iframeCandidates.length,
      iframeHittable: iframeHittable.length,
    },
    truncated: interactiveDrafts.length > slicedInteractive.length,
    textTruncated: includeText && rawTexts.length >= textLimit,
    marked,
    scroll: { y: ctx.scrollY, percent: ctx.scrollPercent, atTop: ctx.atTop, atBottom: ctx.atBottom },
    currentSection: ctx.currentSection,
    items,
    frames: frameItems,
    texts,
    elements,
    hint: '返回 items：kind=text 可见文本，kind=frame 页面内 iframe 边界（accessible=true 表示同源已扫描，子元素见 inFrame=true 的 interactive；accessible=false 为跨域不可用坐标点击），kind=interactive 可点击元素（有 id），kind=group 同类型批量摘要（无 id）。' +
      ' frames 数组与 items 中 kind=frame 条目一致；interactive 可用 browser_click {ref:id} 点击；inFrame=true 表示元素在同源 iframe 内，frameSelector 指向所属 iframe。' +
      ' 勿使用 Playwright 语法（如 :has-text）；用 text 参数或 observe 返回的 ref/selector。' +
      groupingHint + markHint,
  }
}

function kindSortRank(kind: string): number {
  if (kind === 'text') return 0
  if (kind === 'frame') return 1
  if (kind === 'group') return 2
  return 3
}
