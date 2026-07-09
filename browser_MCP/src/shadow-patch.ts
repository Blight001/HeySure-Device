// shadow-patch.ts — runs in the page's MAIN world at document_start.
//
// Closed shadow roots (`attachShadow({ mode: 'closed' })`) are invisible to our
// content-script observer: from any JS context `host.shadowRoot` returns null,
// so enumerateScanRoots() can never walk into them. Real sites use closed roots
// for whole interactive widgets — e.g. Xiaohongshu's <xhs-publish-btn> wraps its
// 发布 / 暂存 buttons in a closed root, which is why browser_observe "can't see"
// the publish button.
//
// We force every shadow root open. Once `host.shadowRoot` is non-null the
// existing observer (content/observe.ts `add(el.shadowRoot)`) picks the contents
// up automatically, with no other code change. This must run in the MAIN world
// (the page's own realm — patching Element.prototype from the isolated content
// world has no effect on page-created elements) and at document_start, before
// the page defines/upgrades its custom elements.
;(() => {
  const proto = Element.prototype as any
  if (proto.__heysureShadowPatched) return
  const native = proto.attachShadow
  if (typeof native !== 'function') return

  proto.attachShadow = function (init?: ShadowRootInit) {
    const opts: ShadowRootInit = { ...(init || ({} as ShadowRootInit)), mode: 'open' }
    return native.call(this, opts)
  }
  proto.__heysureShadowPatched = true
})()
