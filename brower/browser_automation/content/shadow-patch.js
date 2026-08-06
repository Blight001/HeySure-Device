// content/shadow-patch.js — 在页面 MAIN world 的 document_start 运行。
//
// 封闭 shadow root（attachShadow({ mode: 'closed' })）对内容脚本观察器不可见：任何 JS 上下文里
// host.shadowRoot 都返回 null，observe 的 enumerateScanRoots 无法走进去。真实站点会用封闭 root 包裹
// 整块交互控件（如小红书 <xhs-publish-btn> 把发布/暂存按钮放进封闭 root），导致 browser_observe
// “看不到”发布按钮。
//
// 这里把所有 shadow root 强制为 open。一旦 host.shadowRoot 非 null，content/observe.js 的
// enumerateScanRoots(add(el.shadowRoot)) 就会自动扫描其内容，无需其他改动。必须运行在 MAIN world
// （页面自身 realm——从隔离的内容世界 patch Element.prototype 对页面创建的元素无效），且在
// document_start、页面定义/升级自定义元素之前。
//
// 移植自 device/extension/src/shadow-patch.ts。
(() => {
    const proto = Element.prototype;
    if (proto.__heysureShadowPatched) return;
    const native = proto.attachShadow;
    if (typeof native !== 'function') return;
    proto.attachShadow = function (init) {
        const opts = { ...(init || {}), mode: 'open' };
        return native.call(this, opts);
    };
    proto.__heysureShadowPatched = true;
})();
