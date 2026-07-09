// content/marks.ts — element-id store shared by observe (writer) and the click
// handlers (reader). Kept dependency-free so both dom.ts and observe.ts can
// import it without creating an import cycle.
//
// browser_observe assigns each top-most interactable element a 1-based id and
// records it here. A follow-up browser_click {ref:id} resolves that id back to
// the live element — the most reliable way to click "the thing the user sees".
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

let marks: MarkTarget[] = []

export function setMarks(items: MarkTarget[]): void {
  marks = items.slice()
}

function markAt(ref: any): MarkTarget | null {
  const i = Number(ref)
  if (!Number.isFinite(i) || i < 1 || i > marks.length) return null
  return marks[i - 1] || null
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
