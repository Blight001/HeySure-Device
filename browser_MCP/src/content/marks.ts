// content/marks.ts — element-id store shared by observe (writer) and the click
// handlers (reader). Kept dependency-free so both dom.ts and observe.ts can
// import it without creating an import cycle.
//
// browser_observe assigns each top-most interactable element a stable 1-based
// id and records it here. A follow-up browser_click {ref:id} resolves that id
// back to the live element — the most reliable way to click "the thing the
// user sees". IDs remain stable across filtered/automatic observe calls for the
// lifetime of this document, so observing a smaller subset cannot silently
// renumber (and invalidate) a previously returned ref.
//
// Self-healing: alongside the live element we keep a lightweight descriptor
// (selector + text + center point) captured at observe time. SPAs re-render
// between observe and click, which detaches the original node and used to make
// the ref "stale" — an immediate hard failure. Now, when the captured element is
// gone, getMarkTarget hands back the descriptor so the click handler can re-find
// the element by selector/text (or fall back to the recorded coordinates) instead
// of aborting. This is the main fix for "observe worked, the next click failed".

export interface MarkTarget {
  /** The element captured at observe time (may become detached on re-render). */
  el: Element | null
  /** A round-trip-verified selector for re-finding the element after a re-render. */
  selector: string
  /** Visible text/label, used as a secondary re-find key. */
  text: string
  /** Viewport-space center captured at observe time (last-resort coordinate). */
  center: { x: number; y: number }
  /** Innermost iframe selector in its owner document. */
  frameSelector?: string
  /** Outermost→innermost iframe selectors for nested frames. */
  framePath?: string[]
}

const MAX_MARK_HISTORY = 2000

let marks = new Map<number, MarkTarget>()
let elementRefs = new WeakMap<Element, number>()
const identityRefs = new Map<string, number>()
const refIdentities = new Map<number, string>()
const lastSeen = new Map<number, number>()
let nextRef = 1
let generation = 0

function markIdentity(item: MarkTarget): string {
  const frame = item.framePath?.length
    ? item.framePath.join('\u001f')
    : item.frameSelector || ''
  if (item.selector) return `${frame}\u001e${item.selector}`
  // cssPath should normally be present. Keep a useful fallback for unusual
  // SVG/custom elements where no selector can be produced.
  const x = Math.round(item.center.x / 12)
  const y = Math.round(item.center.y / 12)
  return `${frame}\u001e${item.text}\u001e${x}:${y}`
}

function allocateRef(): number {
  const ref = nextRef
  nextRef += 1
  return ref
}

function pruneHistory(active: Set<number>): void {
  if (marks.size <= MAX_MARK_HISTORY) return
  const stale = Array.from(marks.keys())
    .filter(ref => !active.has(ref))
    .sort((a, b) => (lastSeen.get(a) || 0) - (lastSeen.get(b) || 0))
  for (const ref of stale) {
    if (marks.size <= MAX_MARK_HISTORY) break
    marks.delete(ref)
    lastSeen.delete(ref)
    const identity = refIdentities.get(ref)
    refIdentities.delete(ref)
    if (identity && identityRefs.get(identity) === ref) identityRefs.delete(identity)
  }
}

/** Register the latest observe targets and return their stable refs in order. */
export function setMarks(items: MarkTarget[]): number[] {
  generation += 1
  const active = new Set<number>()
  const refs = items.map(item => {
    const identity = markIdentity(item)
    let ref = item.el ? elementRefs.get(item.el) : undefined
    if (ref !== undefined && !marks.has(ref)) ref = undefined
    if (ref === undefined) {
      const byIdentity = identityRefs.get(identity)
      if (byIdentity !== undefined && marks.has(byIdentity) && !active.has(byIdentity)) ref = byIdentity
    }
    if (ref === undefined || active.has(ref)) ref = allocateRef()

    marks.set(ref, item)
    lastSeen.set(ref, generation)
    active.add(ref)
    if (item.el) elementRefs.set(item.el, ref)
    identityRefs.set(identity, ref)
    refIdentities.set(ref, identity)
    return ref
  })
  pruneHistory(active)
  return refs
}

function markAt(ref: any): MarkTarget | null {
  const i = Number(ref)
  if (!Number.isInteger(i) || i < 1) return null
  return marks.get(i) || null
}

/**
 * Resolve an observe id to a target descriptor for self-healing. Returns the
 * live element when still attached, plus the captured selector/text/center so
 * callers can re-find it after the page re-rendered. Returns null only when the
 * id itself is out of range (never observed).
 */
export function getMarkTarget(ref: any): MarkTarget | null {
  return markAt(ref)
}
