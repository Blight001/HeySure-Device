// content/observe.js — 页面观察与交互底座（browser_observe / browser_action / browser_wait 的执行核心）。
//
// 移植自 device/extension/src/content/{observe,dom,iframe,viewport,marks}.ts，力求与桌面浏览器扩展
// 的 browser_observe 功能一致（纯 JS，无 CDP/debugger，点击/输入/按键均为合成事件）：
//   · 扫描主文档 + 同源（含嵌套）iframe 内部 + Shadow DOM（开放 root；封闭 root 由 content/shadow-patch.js
//     在 document_start 的 MAIN world 强制转开放后可扫描）。
//   · 识别可交互控件（含 cursor:pointer / 类名或 ID 以 btn/button/link 结尾的自定义控件）、
//     img/video/audio 媒体元素、可见文本、iframe 边界。
//   · 返回 items 单一混排列表（按位置排序、已去重），interactive 项带 tag/selector + name/placeholder/ariaLabel 等基本信息，
//     同时提供临时 id 供 browser_action ref 使用（id 在下一次 browser_observe 前有效）；推荐用 selector/text 构造持久化卡片步骤。
//   · 默认绘制描边标记：绿色=可点击、红色=被遮挡/禁用/不可点、紫色虚线=iframe 边界。
//
// 与 content/fx.js 同样常驻内容脚本，把 API 幂等挂到 window.__hsObserve 上，供 background 用一次性
// chrome.scripting.executeScript(...).func 调用；window 在同一文档生命周期内持久，因此 observe 生成的
// id → 元素映射能被后续 browser_action 复用（并带自愈：节点被重渲染后按 selector/text/坐标重新定位）。
// observe 现返回元素基本信息，便于 AI 分析表单并为自动化卡片（create/modify）提供稳定定位器，不再依赖仅 id。

(() => {
    'use strict';
    if (window.__hsObserve && window.__hsObserve.__installed) {
        return;
    }

    // ── 常量 ────────────────────────────────────────────────────────────────
    const INTERACTIVE = [
        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
        '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
        '[role="switch"]', '[role="option"]', '[contenteditable=""]', '[contenteditable="true"]',
        '[onclick]', '[tabindex]:not([tabindex="-1"])', 'summary', 'label[for]',
        '[aria-expanded]', '[aria-haspopup]', '[aria-controls]', '[aria-pressed]', '[aria-selected]',
        '[draggable="true"]'
    ].join(',');

    const CONTROL = [
        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
        'summary', 'label[for]',
        '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
        '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
        '[role="switch"]', '[role="option"]', '[contenteditable=""]', '[contenteditable="true"]'
    ].join(',');

    const MEDIA_SELECTOR = 'img,video,audio';
    const TEXT_NODE_TAGS_TO_SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas']);

    const FX_PREFIX = '__hs_ba_fx__';                 // content/fx.js 的视觉叠加元素 class 前缀
    const MARK_LAYER_ID = '__hs_marks_layer';
    const MARK_STYLE_ID = '__hs_marks_style';
    const MARK_CHANGE_EVENTS = ['scroll', 'resize', 'hashchange', 'popstate', 'pagehide'];

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

    // ── 跨 realm 安全的类型判断（同源 iframe 内元素属于该 frame window 的 realm）────
    function isElement(el) {
        return !!el && typeof el === 'object' && el.nodeType === 1;
    }
    function isHTMLElement(el) {
        if (el instanceof HTMLElement) return true;
        if (!isElement(el)) return false;
        const win = el.ownerDocument && el.ownerDocument.defaultView;
        return !!win && typeof win.HTMLElement === 'function' && el instanceof win.HTMLElement;
    }
    function isFrameElement(el) {
        if (!isElement(el)) return false;
        return el.tagName === 'IFRAME' || el.tagName === 'FRAME';
    }
    function ownerWindow(el) {
        return (el.ownerDocument && el.ownerDocument.defaultView) || window;
    }
    function computedStyle(el) {
        try { return ownerWindow(el).getComputedStyle(el); } catch (_error) { return null; }
    }
    function isOwnOverlay(el) {
        try {
            return !!(el.closest && el.closest(`[class*="${FX_PREFIX}"],#${MARK_LAYER_ID},#${MARK_STYLE_ID}`));
        } catch (_error) { return false; }
    }

    // ── iframe：递归扫描、多级坐标换算、穿透命中测试 ───────────────────────────
    function clampX(x, win) { return Math.min(Math.max(x, 1), win.innerWidth - 1); }
    function clampY(y, win) { return Math.min(Math.max(y, 1), win.innerHeight - 1); }

    function isVisibleInOwnerViewport(el) {
        const s = computedStyle(el);
        if (!s || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        const win = ownerWindow(el);
        return r.width > 0 && r.height > 0 && r.bottom >= 0 && r.right >= 0
            && r.top <= win.innerHeight && r.left <= win.innerWidth;
    }

    function listIframeElementsIn(doc) {
        return Array.from(doc.querySelectorAll('iframe,frame'))
            .filter((el) => isFrameElement(el) && isVisibleInOwnerViewport(el));
    }

    function tryFrameContext(frameEl) {
        try {
            const doc = frameEl.contentDocument;
            if (!doc || !doc.documentElement) return null;
            return { frameEl, doc };
        } catch (_error) {
            return null;
        }
    }

    function scanRoot(doc) {
        return doc.body || doc.documentElement;
    }

    function buildFramePath(frame) {
        const path = [];
        let cur = frame;
        while (cur) { path.unshift(cur.frameSelector); cur = cur.parent; }
        return path;
    }

    function resolveFrameByPath(path) {
        if (!path || !path.length) return null;
        let doc = document;
        let parent;
        let resolved = null;
        for (const frameSelector of path) {
            const frameEl = doc.querySelector(frameSelector);
            if (!isFrameElement(frameEl)) return null;
            const base = tryFrameContext(frameEl);
            if (!base) return null;
            resolved = { ...base, frameSelector, parent };
            parent = resolved;
            doc = base.doc;
        }
        return resolved;
    }

    function resolveFrameBySelector(frameSelector, framePath) {
        const path = (framePath && framePath.length) ? framePath : (frameSelector ? [frameSelector] : []);
        return resolveFrameByPath(path);
    }

    function visitAccessibleFrames(onFrame, attachSelector, doc = document, parent) {
        for (const frameEl of listIframeElementsIn(doc)) {
            const base = tryFrameContext(frameEl);
            if (!base) continue;
            const ctx = { ...base, frameSelector: attachSelector(frameEl), parent };
            onFrame(ctx);
            visitAccessibleFrames(onFrame, attachSelector, base.doc, ctx);
        }
    }

    function getAccessibleFrames(attachSelector) {
        const out = [];
        visitAccessibleFrames((ctx) => out.push(ctx), attachSelector);
        return out;
    }

    // 把 frame 局部视口坐标累加各级 iframe 偏移，换算到顶层页面视口坐标。
    function toTopViewportPoint(localX, localY, frame) {
        let x = localX;
        let y = localY;
        let cur = frame;
        while (cur) {
            const fr = cur.frameEl.getBoundingClientRect();
            x += fr.left; y += fr.top;
            cur = cur.parent;
        }
        return { x: Math.round(x), y: Math.round(y) };
    }
    function toTopViewportRect(local, frame) {
        const topLeft = toTopViewportPoint(local.left, local.top, frame);
        return { x: topLeft.x, y: topLeft.y, w: Math.round(local.width), h: Math.round(local.height) };
    }
    function toTopViewportCenter(local, frame) {
        return toTopViewportPoint(local.left + local.width / 2, local.top + local.height / 2, frame);
    }
    function elementViewportRect(el, frame) { return toTopViewportRect(el.getBoundingClientRect(), frame); }
    function elementViewportCenter(el, frame) { return toTopViewportCenter(el.getBoundingClientRect(), frame); }

    function hitAtPoint(doc, win, x, y, topX, topY, frame) {
        const lx = clampX(x, win);
        const ly = clampY(y, win);
        let hit = doc.elementFromPoint(lx, ly);
        if (!hit) return null;
        // 穿透 shadow root：elementFromPoint 返回 shadow host，实际绘制的内层元素需再取一次。
        while (hit.shadowRoot) {
            const inner = hit.shadowRoot.elementFromPoint(lx, ly);
            if (!inner || inner === hit) break;
            hit = inner;
        }
        if (hit.tagName === 'IFRAME' || hit.tagName === 'FRAME') {
            const frameEl = hit;
            const base = tryFrameContext(frameEl);
            const fr = frameEl.getBoundingClientRect();
            const childX = lx - fr.left;
            const childY = ly - fr.top;
            if (!base) return { el: frameEl, frame, localX: lx, localY: ly };
            const childWin = base.doc.defaultView || win;
            const childCtx = { ...base, frameSelector: '', parent: frame };
            const deeper = hitAtPoint(base.doc, childWin, childX, childY, topX, topY, childCtx);
            if (deeper) return deeper;
            return { el: frameEl, frame: childCtx, localX: childX, localY: childY };
        }
        return { el: hit, frame, localX: lx, localY: ly };
    }
    function hitTargetAtViewport(x, y) {
        const vx = clampX(x, window);
        const vy = clampY(y, window);
        return hitAtPoint(document, window, vx, vy, vx, vy);
    }

    function isTopmostAtViewport(el, viewportX, viewportY) {
        const hit = hitTargetAtViewport(viewportX, viewportY);
        if (!hit) return false;
        const target = hit.el;
        if (target === el) return true;
        if (target.ownerDocument === el.ownerDocument) {
            return el.contains(target) || target.contains(el);
        }
        return false;
    }

    function isFrameChainVisible(frame) {
        let cur = frame;
        while (cur) { if (!isVisibleInOwnerViewport(cur.frameEl)) return false; cur = cur.parent; }
        return true;
    }
    function isCenterOnMainViewport(frame, el) {
        const center = elementViewportCenter(el, frame);
        return center.x >= 0 && center.y >= 0 && center.x <= window.innerWidth && center.y <= window.innerHeight;
    }

    function isHittableInViewport(el, frame) {
        if (!isVisibleInOwnerViewport(el)) return false;
        if (frame && !isFrameChainVisible(frame)) return false;
        const s = computedStyle(el);
        if (s && s.pointerEvents === 'none') return false;
        const local = el.getBoundingClientRect();
        const sampleLocal = [
            [local.left + local.width / 2, local.top + local.height / 2],
            [local.left + local.width / 2, local.top + Math.min(local.height * 0.2, 6)],
            [local.left + local.width * 0.2, local.top + local.height / 2],
            [local.left + local.width * 0.8, local.top + local.height / 2]
        ];
        const pts = frame
            ? sampleLocal.map(([lx, ly]) => { const p = toTopViewportPoint(lx, ly, frame); return [p.x, p.y]; })
            : sampleLocal;
        return pts.some(([px, py]) => isTopmostAtViewport(el, px, py));
    }

    function isLikelyInteractableInFrame(el, frame) {
        if (!isVisibleInOwnerViewport(el)) return false;
        if (!isFrameChainVisible(frame)) return false;
        const s = computedStyle(el);
        if (s && s.pointerEvents === 'none') return false;
        if (!isCenterOnMainViewport(frame, el)) return false;
        if (isHittableInViewport(el, frame)) return true;
        const center = elementViewportCenter(el, frame);
        const hit = hitTargetAtViewport(center.x, center.y);
        if (!hit) return false;
        if (hit.el.ownerDocument === el.ownerDocument) {
            return hit.el === el || el.contains(hit.el) || hit.el.contains(el);
        }
        return true;
    }

    function occluderAtViewport(el, frame) {
        const center = elementViewportCenter(el, frame);
        const hit = hitTargetAtViewport(center.x, center.y);
        if (!hit) return null;
        const cover = hit.el;
        if (cover === el) return null;
        if (cover.ownerDocument === el.ownerDocument && (el.contains(cover) || cover.contains(el))) return null;
        return cover;
    }

    // ── DOM 辅助 ─────────────────────────────────────────────────────────────
    function isVisible(el) {
        if (!el || !isHTMLElement(el)) return false;
        if (isOwnOverlay(el)) return false;
        const s = computedStyle(el);
        if (!s || s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        const win = ownerWindow(el);
        return r.width > 0 && r.height > 0 && r.bottom >= 0 && r.right >= 0
            && r.top <= win.innerHeight && r.left <= win.innerWidth;
    }

    function isHittable(el, frame) { return isHittableInViewport(el, frame); }

    function textOf(el, max = 200) {
        const parts = [
            el.innerText, el.getAttribute && el.getAttribute('aria-label'),
            el.getAttribute && el.getAttribute('title'), el.value, el.placeholder, el.textContent
        ];
        for (const part of parts) {
            const t = String(part || '').replace(/\s+/g, ' ').trim();
            if (t) return t.slice(0, max);
        }
        return '';
    }

    function elementArea(el) {
        const r = el.getBoundingClientRect();
        return Math.max(0, r.width) * Math.max(0, r.height);
    }

    function elCenter(el) {
        const win = ownerWindow(el);
        const r = el.getBoundingClientRect();
        return {
            x: Math.min(Math.max(r.left + r.width / 2, 1), win.innerWidth - 1),
            y: Math.min(Math.max(r.top + r.height / 2, 1), win.innerHeight - 1)
        };
    }

    // ── selector 构建（自愈式 ref 复查）───────────────────────────────────────
    function selectorResolvesTo(selector, el) {
        try {
            const hits = el.ownerDocument.querySelectorAll(selector);
            return hits.length === 1 && hits[0] === el;
        } catch (_error) { return false; }
    }
    function stableAttrSelector(el) {
        const tag = el.tagName.toLowerCase();
        const id = el.id;
        if (id && selectorResolvesTo(`#${CSS.escape(id)}`, el)) return `#${CSS.escape(id)}`;
        for (const attr of ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy', 'name', 'aria-label']) {
            const value = el.getAttribute(attr);
            if (!value) continue;
            const sel = `${tag}[${attr}="${CSS.escape(value)}"]`;
            if (selectorResolvesTo(sel, el)) return sel;
        }
        return '';
    }
    function cssPath(el) {
        if (!isElement(el)) return '';
        const attrSel = stableAttrSelector(el);
        if (attrSel) return attrSel;
        const segment = (node) => {
            const tag = node.tagName.toLowerCase();
            if (node.id) return `#${CSS.escape(node.id)}`;
            const cls = String(node.className || '').split(/\s+/).filter(Boolean).slice(0, 2)
                .map((c) => `.${CSS.escape(c)}`).join('');
            const parent = node.parentElement;
            const same = parent ? Array.from(parent.children).filter((c) => c.tagName === node.tagName) : [];
            const nth = same.length > 1 ? `:nth-of-type(${same.indexOf(node) + 1})` : '';
            return `${tag}${cls}${nth}`;
        };
        const parts = [];
        let cur = el;
        const root = el.ownerDocument.documentElement;
        while (cur && cur !== root && parts.length < 12) {
            parts.unshift(segment(cur));
            const path = parts.join(' > ');
            if (selectorResolvesTo(path, el)) return path;
            if (cur.id) break;
            cur = cur.parentElement;
        }
        return parts.length ? parts.join(' > ') : el.tagName.toLowerCase();
    }

    function clickableAncestor(el) {
        return el.closest('button,a,[role="button"],input[type="button"],input[type="submit"],[onclick],[tabindex]') || el;
    }
    function textMatches(el, text, exact = false) {
        const target = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!target) return false;
        const haystack = [
            el.innerText, el.textContent, el.getAttribute('aria-label'), el.getAttribute('title'),
            el.value, el.getAttribute('placeholder')
        ].map((v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
        return haystack.some((v) => (exact ? v === target : (v === target || v.includes(target))));
    }
    function findElInDocument(doc, selector, text, frame) {
        if (selector) {
            const matches = Array.from(doc.querySelectorAll(selector));
            return matches.find((el) => isHittable(el, frame)) || matches.find(isVisible) || matches[0] || null;
        }
        if (text) {
            const preferred = Array.from(doc.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"],[aria-label],[title]'));
            const byPreferred = (pred, exact) => preferred.find((el) => pred(el) && textMatches(el, text, exact));
            const byWalk = (pred, exact) => {
                const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
                while (walker.nextNode()) {
                    const el = walker.currentNode;
                    if (pred(el) && textMatches(el, text, exact)) return clickableAncestor(el);
                }
                return null;
            };
            for (const pred of [isHittable, isVisible]) {
                const hit = byPreferred(pred, true) || byPreferred(pred, false) || byWalk(pred, true) || byWalk(pred, false);
                if (hit) return hit;
            }
        }
        return null;
    }
    function findElInAccessibleFrames(selector, text) {
        let hit = null;
        visitAccessibleFrames((ctx) => { if (hit) return; hit = findElInDocument(ctx.doc, selector, text, ctx); }, (el) => cssPath(el));
        return hit;
    }
    function findEl(selector, text, frameSelector, framePath) {
        const frame = resolveFrameBySelector(frameSelector, framePath);
        if (frame) return findElInDocument(frame.doc, selector, text, frame);
        const top = findElInDocument(document, selector, text);
        if (top) return top;
        return findElInAccessibleFrames(selector, text);
    }

    // ── marks 存储（observe 写入，browser_action 读取，含自愈）─────────────────
    let marks = [];
    function setMarks(items) { marks = items.slice(); }
    function getMarkTarget(ref) {
        const i = Number(ref);
        if (!Number.isFinite(i) || i < 1 || i > marks.length) return null;
        return marks[i - 1] || null;
    }

    function resolveTarget(msg = {}) {
        const byEl = (el, frame) => { const c = elCenter(el); return { el, x: c.x, y: c.y, frame }; };
        const hasRef = msg.ref !== undefined && msg.ref !== null && msg.ref !== '';
        if (hasRef) {
            const mark = getMarkTarget(msg.ref);
            if (mark) {
                const frame = resolveFrameBySelector(mark.frameSelector, mark.framePath);
                if (mark.el && mark.el.isConnected) return byEl(mark.el, frame || undefined);
                const healed = findEl(mark.selector, mark.text, mark.frameSelector, mark.framePath);
                if (healed) return byEl(healed, frame || undefined);
            }
        }
        if (msg.selector || msg.text) {
            const el = findEl(msg.selector, msg.text, msg.frame, msg.frame_path);
            if (el) { const frame = resolveFrameBySelector(msg.frame, msg.frame_path); return byEl(el, frame || undefined); }
        }
        if (msg.x !== undefined && msg.y !== undefined) {
            const hit = hitTargetAtViewport(Number(msg.x), Number(msg.y));
            if (!hit) return { el: null, x: Number(msg.x), y: Number(msg.y) };
            return { el: hit.el, x: hit.localX, y: hit.localY, frame: hit.frame };
        }
        if (hasRef) {
            const mark = getMarkTarget(msg.ref);
            if (mark && mark.center) {
                const hit = hitTargetAtViewport(mark.center.x, mark.center.y);
                if (hit) return { el: hit.el, x: hit.localX, y: hit.localY, frame: hit.frame };
                return { el: null, x: mark.center.x, y: mark.center.y };
            }
        }
        return { el: null, x: 0, y: 0 };
    }

    // ── 视口位置上下文 ─────────────────────────────────────────────────────────
    function viewportContext() {
        const doc = document.documentElement;
        const scrollY = Math.round(window.scrollY);
        const scrollX = Math.round(window.scrollX);
        const innerH = window.innerHeight;
        const scrollHeight = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
        const maxScroll = Math.max(0, scrollHeight - innerH);
        const scrollPercent = maxScroll > 0 ? Math.round((scrollY / maxScroll) * 100) : 100;
        const atTop = scrollY <= 2;
        const atBottom = scrollY >= maxScroll - 2;
        let currentSection = '';
        for (const h of Array.from(document.querySelectorAll('h1,h2,h3,h4'))) {
            const r = h.getBoundingClientRect();
            const txt = (h.innerText || '').trim().slice(0, 120);
            if (!txt) continue;
            if (r.top <= 90) currentSection = txt;
        }
        return { scrollX, scrollY, scrollHeight, maxScroll, scrollPercent, atTop, atBottom, currentSection };
    }

    // ── 角色 / 类别判定 ────────────────────────────────────────────────────────
    function implicitRole(el) {
        const tag = el.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button' || tag === 'summary') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') {
            const t = el.type;
            if (t === 'checkbox' || t === 'radio' || t === 'button' || t === 'submit') return t;
            return 'textbox';
        }
        return '';
    }

    // 自定义控件（div/span + 框架 click 监听）常无 role/onclick/tabindex，甚至无 cursor:pointer，
    // 最后手段是读其自身 class/id：以 button/btn/link 结尾的 token 是强作者提示。要求在 token 边界末尾，
    // 从而 “edit-text-button-text”（以 -text 结尾）不误命中，而真正的 “edit-text-button” 命中。
    const NAME_ROLE_PATTERNS = [
        { re: /(^|[-_])(btn|button)$/i, category: 'button' },
        { re: /(^|[-_])link$/i, category: 'link' }
    ];
    function nameRole(el) {
        if (!isHTMLElement(el)) return '';
        const tokens = [...String(el.className || '').split(/\s+/), el.id || ''].filter(Boolean);
        for (const token of tokens) {
            for (const { re, category } of NAME_ROLE_PATTERNS) {
                if (re.test(token)) return category;
            }
        }
        return '';
    }

    function elementCategory(el) {
        const tag = el.tagName.toLowerCase();
        const role = String(el.getAttribute('role') || '').toLowerCase();
        if (tag === 'img' || role === 'img') return 'image';
        if (tag === 'video') return 'video';
        if (tag === 'audio') return 'audio';
        if (tag === 'textarea') return 'input';
        if (tag === 'select' || role === 'combobox' || role === 'listbox') return 'select';
        if (tag === 'input') {
            const type = String(el.type || 'text').toLowerCase();
            if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') return 'button';
            if (type === 'checkbox') return 'checkbox';
            if (type === 'radio') return 'radio';
            return 'input';
        }
        if (el.matches && el.matches('[contenteditable=""],[contenteditable="true"]')) return 'input';
        if (role === 'textbox' || role === 'searchbox') return 'input';
        if (role === 'button' || tag === 'button' || tag === 'summary') return 'button';
        if (role === 'link' || tag === 'a') return 'link';
        if (role === 'checkbox' || role === 'switch') return 'checkbox';
        if (role === 'radio') return 'radio';
        if (role === 'tab') return 'tab';
        if (role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio') return 'menuitem';
        if (role === 'option') return 'option';
        if (tag === 'label') return 'label';
        return nameRole(el) || 'other';
    }

    // ── filter / tag / keyword 解析 ────────────────────────────────────────────
    const FILTER_ALIASES = {
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
        all: 'all', any: 'all', '*': 'all'
    };
    function normalizeFilterToken(raw) { return FILTER_ALIASES[String(raw).trim().toLowerCase()] || ''; }
    function parseFilter(raw) {
        if (raw == null) return null;
        const parts = Array.isArray(raw) ? raw.map(String) : String(raw).split(/[,\s]+/);
        const out = new Set();
        for (const part of parts) {
            const token = normalizeFilterToken(part);
            if (token === 'all') return null;
            if (token) out.add(token);
        }
        return out.size ? out : null;
    }
    function interactiveCategoryAllowed(category, filter) {
        if (!filter) return true;
        return filter.has('interactive') || filter.has(category);
    }
    function mediaCategoryAllowed(category, filter) {
        if (!filter) return true;
        return filter.has('media') || filter.has(category);
    }
    function parseStringList(raw) {
        if (raw == null) return [];
        const parts = Array.isArray(raw) ? raw : String(raw).split(/[,\s]+/);
        return parts.map((p) => String(p || '').trim()).filter(Boolean);
    }
    function parseTagFilter(raw) {
        const tags = parseStringList(raw).map((t) => t.toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(Boolean);
        return tags.length ? new Set(tags) : null;
    }
    function parseKeyword(raw) { return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim().toLowerCase(); }

    function elementSearchText(el, fallback = '') {
        const parts = [
            fallback, textOf(el, 240),
            el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.getAttribute('alt') || '',
            el.getAttribute('placeholder') || '', el.getAttribute('name') || '', el.id || '',
            el.getAttribute('src') || '', el.getAttribute('href') || ''
        ];
        return parts.join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
    }
    function matchesElementFilters(el, tagFilter, keyword, fallbackText = '') {
        if (tagFilter && !tagFilter.has(el.tagName.toLowerCase())) return false;
        if (keyword && !elementSearchText(el, fallbackText).includes(keyword)) return false;
        return true;
    }

    function isDisabled(el) {
        return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true'
            || el.closest('[disabled],[aria-disabled="true"]') !== null;
    }
    function hasInteractiveSemantics(el) {
        if (!isHTMLElement(el) || isDisabled(el)) return false;
        if (el.matches(INTERACTIVE)) return true;
        if (nameRole(el)) return true;
        const s = computedStyle(el);
        return !!s && s.cursor === 'pointer';
    }
    function isInsideInteractive(el) {
        const stop = el.ownerDocument.body || el.ownerDocument.documentElement;
        let cur = el;
        while (cur && cur !== stop) {
            if (hasInteractiveSemantics(cur)) return true;
            cur = cur.parentElement;
        }
        return false;
    }
    function isStrongControl(el) {
        return el.matches('a[href],button,input:not([type="hidden"]),select,textarea,summary,label[for],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="switch"],[contenteditable=""],[contenteditable="true"]');
    }

    // ── 扫描根枚举（含 Shadow DOM）─────────────────────────────────────────────
    function enumerateScanRoots(root) {
        const doc = root.ownerDocument || document;
        const roots = [root];
        const seen = new Set([root]);
        const add = (node) => { if (!node || seen.has(node)) return; seen.add(node); roots.push(node); };
        const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
        while (walker.nextNode()) { add(walker.currentNode.shadowRoot); }
        return roots;
    }

    function collectCandidatesIn(root, frame) {
        const out = [];
        const seen = new Set();
        const add = (el) => {
            if (!isHTMLElement(el) || seen.has(el)) return;
            seen.add(el);
            if (hasInteractiveSemantics(el) && isVisible(el)) out.push({ el, frame });
        };
        for (const sr of enumerateScanRoots(root)) {
            sr.querySelectorAll(INTERACTIVE).forEach(add);
            const walker = (sr.ownerDocument || document).createTreeWalker(sr, NodeFilter.SHOW_ELEMENT);
            let scanned = 0;
            while (walker.nextNode() && scanned < 6000) { scanned += 1; add(walker.currentNode); }
        }
        return out;
    }

    function scanScopes(scopeFrame) {
        if (!scopeFrame) {
            return [{ doc: document }, ...getAccessibleFrames(cssPath).map((ctx) => ({ doc: ctx.doc, frame: ctx }))];
        }
        const scopes = [{ doc: scopeFrame.doc, frame: scopeFrame }];
        visitAccessibleFrames((ctx) => scopes.push({ doc: ctx.doc, frame: ctx }), cssPath, scopeFrame.doc, scopeFrame);
        return scopes;
    }

    function collectCandidates(scopes) {
        const accessibleFrames = new Set(scopes.map((s) => s.frame && s.frame.frameEl).filter(Boolean));
        const all = [];
        for (const scope of scopes) all.push(...collectCandidatesIn(scanRoot(scope.doc), scope.frame));
        return all.filter((item) => !(isFrameElement(item.el) && accessibleFrames.has(item.el)));
    }

    // ── 文本收集 ───────────────────────────────────────────────────────────────
    function textRole(el) {
        const explicit = el.getAttribute('role');
        if (explicit) return explicit;
        const tag = el.tagName.toLowerCase();
        if (/^h[1-6]$/.test(tag)) return 'heading';
        if (tag === 'label') return 'label';
        if (tag === 'li') return 'listitem';
        if (tag === 'th' || tag === 'td') return 'cell';
        if (tag === 'p') return 'paragraph';
        return 'text';
    }
    function rectInfo(r) { return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
    function centerInfo(r) { return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; }

    function isUsableTextRect(parent, r, frame) {
        if (r.width <= 0 || r.height <= 0) return false;
        const center = frame ? elementViewportCenter(parent, frame) : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        if (center.y < 0 || center.x < 0 || center.y > window.innerHeight || center.x > window.innerWidth) return false;
        if (frame) return isVisibleInOwnerViewport(parent) && isFrameChainVisible(frame) && isCenterOnMainViewport(frame, parent);
        return isTopmostAtViewport(parent, center.x, center.y);
    }

    function collectVisibleTextsIn(root, limit, frame) {
        const out = [];
        const seen = new Set();
        const doc = root.ownerDocument || document;
        const walkText = (sr) => {
            const walker = doc.createTreeWalker(sr, NodeFilter.SHOW_TEXT, {
                acceptNode(node) {
                    const text = String(node.textContent || '').replace(/\s+/g, ' ').trim();
                    if (!text) return NodeFilter.FILTER_REJECT;
                    const parent = node.parentElement;
                    if (!parent || TEXT_NODE_TAGS_TO_SKIP.has(parent.tagName.toLowerCase())) return NodeFilter.FILTER_REJECT;
                    if (!isVisible(parent) || isInsideInteractive(parent)) return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            let scanned = 0;
            while (walker.nextNode() && out.length < limit && scanned < 8000) {
                scanned += 1;
                const node = walker.currentNode;
                const parent = node.parentElement;
                if (!parent || !isVisible(parent)) continue;
                const text = String(node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240);
                if (!text) continue;
                const range = doc.createRange();
                range.selectNodeContents(node);
                const rects = Array.from(range.getClientRects());
                range.detach();
                const rect = rects.find((r) => isUsableTextRect(parent, r, frame));
                if (!rect) continue;
                const selector = cssPath(parent);
                const viewportRect = frame ? elementViewportRect(parent, frame) : rectInfo(rect);
                const viewportCenter = frame ? elementViewportCenter(parent, frame) : centerInfo(rect);
                const rectKey = `${Math.round(viewportRect.x / 4)}:${Math.round(viewportRect.y / 4)}:${Math.round(viewportRect.w / 4)}:${Math.round(viewportRect.h / 4)}`;
                const key = `${selector}|${text}|${rectKey}|${(frame && frame.frameSelector) || ''}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({
                    kind: 'text', role: textRole(parent), tag: parent.tagName.toLowerCase(), text, selector,
                    center: viewportCenter, rect: viewportRect,
                    ...(frame ? { inFrame: true, frameSelector: frame.frameSelector, framePath: buildFramePath(frame) } : {})
                });
            }
        };
        for (const sr of enumerateScanRoots(root)) { walkText(sr); if (out.length >= limit) break; }
        return out;
    }
    function collectVisibleTexts(limit, scopes) {
        const out = [];
        for (const scope of scopes) {
            for (const item of collectVisibleTextsIn(scanRoot(scope.doc), limit, scope.frame)) {
                out.push(item);
                if (out.length >= limit) return out;
            }
        }
        return out;
    }

    // ── 被遮挡/禁用控件（红色标记）─────────────────────────────────────────────
    function collectBlockedCandidates(all, hittableSet, scopes) {
        const out = [];
        const seen = new Set();
        const add = (el) => {
            if (!isHTMLElement(el) || seen.has(el) || hittableSet.has(el)) return;
            seen.add(el);
            if (isVisible(el) && (isDisabled(el) || el.matches(CONTROL) || el.matches(INTERACTIVE))) out.push(el);
        };
        all.forEach((item) => add(item.el));
        for (const scope of scopes) scanRoot(scope.doc).querySelectorAll(CONTROL).forEach(add);
        return out;
    }

    // ── iframe 边界条目 ────────────────────────────────────────────────────────
    function collectFrameItems(scopeFrame) {
        const items = [];
        const overlay = [];
        const visit = (doc, parentFrame) => {
            for (const el of listIframeElementsIn(doc)) {
                const base = tryFrameContext(el);
                const localR = el.getBoundingClientRect();
                const rect = parentFrame ? elementViewportRect(el, parentFrame) : rectInfo(localR);
                const center = parentFrame ? elementViewportCenter(el, parentFrame) : centerInfo(localR);
                const selector = cssPath(el);
                const ctx = base ? { ...base, frameSelector: selector, parent: parentFrame } : null;
                const src = el.src || el.getAttribute('src') || '';
                const name = el.name || el.getAttribute('name') || '';
                const title = (ctx && ctx.doc.title) || '';
                const label = title || name || src || 'iframe';
                items.push({
                    kind: 'frame', accessible: !!ctx, tag: 'iframe', role: 'document',
                    text: ctx ? `iframe (same-origin: ${label})`
                        : 'iframe (content not directly accessible from parent — cross-origin or isolated)',
                    name, title, src, selector, frameSelector: selector,
                    framePath: ctx ? buildFramePath(ctx) : (parentFrame ? [...buildFramePath(parentFrame), selector] : [selector]),
                    center, rect,
                    ...(parentFrame ? { parentFrameSelector: parentFrame.frameSelector } : {})
                });
                overlay.push({ el, frame: parentFrame });
                if (ctx) visit(ctx.doc, ctx);
            }
        };
        if (scopeFrame) visit(scopeFrame.doc, scopeFrame); else visit(document);
        return { items, overlay };
    }
    function accessibleFrameDocUrls() {
        const out = [];
        for (const ctx of getAccessibleFrames(cssPath)) {
            try {
                const href = ctx.doc.location && ctx.doc.location.href;
                if (href && href !== 'about:blank') out.push(href);
            } catch (_error) { /* frame detached mid-scan */ }
        }
        return out;
    }

    // ── 元素/媒体记录 ──────────────────────────────────────────────────────────
    function elementRecord(el, frame) {
        const r = el.getBoundingClientRect();
        return {
            el, frame, tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || implicitRole(el),
            type: el.type || undefined,
            text: textOf(el, 80), selector: cssPath(el),
            center: frame ? elementViewportCenter(el, frame) : centerInfo(r),
            rect: frame ? elementViewportRect(el, frame) : rectInfo(r),
            category: elementCategory(el)
        };
    }
    function interactiveItemFromRecord(rec, id) {
        const item = {
            kind: 'interactive', id, tag: rec.tag, role: rec.role, category: rec.category,
            text: rec.text, selector: rec.selector, center: rec.center, rect: rec.rect
        };
        if (rec.frame) { item.inFrame = true; item.frameSelector = rec.frame.frameSelector; item.framePath = buildFramePath(rec.frame); }
        if (rec.type) item.type = rec.type;
        if (rec.el.value != null) item.value = String(rec.el.value).slice(0, 60);

        // 新增基本元素信息：name/placeholder/ariaLabel 等，便于 AI 识别表单字段、构造稳定的 selector/text 用于卡片步骤（不再仅靠临时 id/ref）
        const el = rec.el;
        const get = (a) => (el.getAttribute ? el.getAttribute(a) : null);
        const nm = get('name'); if (nm) item.name = String(nm).slice(0, 60);
        const ph = get('placeholder'); if (ph) item.placeholder = String(ph).slice(0, 80);
        const al = get('aria-label') || get('aria-labelledby'); if (al) item.ariaLabel = String(al).slice(0, 80);
        const ti = get('title'); if (ti && String(ti).trim() && String(ti).trim() !== (item.text || '')) item.title = String(ti).slice(0, 60);
        if (el.disabled || get('aria-disabled') === 'true') item.disabled = true;
        if (el.readOnly) item.readOnly = true;
        if ((rec.tag === 'a' || rec.category === 'link') && el.href) item.href = String(el.href).slice(0, 200);
        if (rec.category === 'checkbox' || rec.category === 'radio') item.checked = !!el.checked;
        if (rec.tag === 'select') {
            try {
                const opts = Array.from(el.options || []).slice(0, 6).map(o => String(o.text || '').replace(/\s+/g, ' ').trim().slice(0, 30)).filter(Boolean);
                if (opts.length) item.optionsSample = opts;
                item.optionCount = (el.options && el.options.length) || 0;
            } catch (_) {}
        }
        return item;
    }
    function mediaRecord(el, frame) {
        const r = el.getBoundingClientRect();
        const category = elementCategory(el);
        const src = el.currentSrc || el.src || el.getAttribute('src') || '';
        const alt = el.getAttribute('alt') || el.getAttribute('aria-label') || el.getAttribute('title') || '';
        return {
            el, frame, kind: 'media', category, tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || (category === 'image' ? 'img' : category),
            text: (alt || textOf(el, 80) || src.split('/').pop() || category).slice(0, 120),
            selector: cssPath(el),
            center: frame ? elementViewportCenter(el, frame) : centerInfo(r),
            rect: frame ? elementViewportRect(el, frame) : rectInfo(r),
            ...(src ? { src: src.slice(0, 240) } : {})
        };
    }
    function mediaItemFromRecord(rec) {
        const item = { kind: 'media', category: rec.category, role: rec.role, text: rec.text, selector: rec.selector, center: rec.center, rect: rec.rect };
        if (rec.frame) { item.inFrame = true; item.frameSelector = rec.frame.frameSelector; item.framePath = buildFramePath(rec.frame); }
        if (rec.src) item.src = rec.src;
        return item;
    }
    function collectVisibleMediaIn(root, frame) {
        const out = [];
        const seen = new Set();
        const add = (el) => {
            if (!isHTMLElement(el) || seen.has(el)) return;
            seen.add(el);
            if (!isVisible(el) || isInsideInteractive(el)) return;
            const r = frame ? elementViewportRect(el, frame) : rectInfo(el.getBoundingClientRect());
            if (r.w <= 0 || r.h <= 0) return;
            const center = frame ? elementViewportCenter(el, frame) : centerInfo(el.getBoundingClientRect());
            if (center.y < 0 || center.x < 0 || center.y > window.innerHeight || center.x > window.innerWidth) return;
            out.push(mediaRecord(el, frame));
        };
        for (const sr of enumerateScanRoots(root)) sr.querySelectorAll(MEDIA_SELECTOR).forEach(add);
        return out;
    }
    function collectVisibleMedia(scopes) {
        const out = [];
        for (const scope of scopes) out.push(...collectVisibleMediaIn(scanRoot(scope.doc), scope.frame));
        return out;
    }

    function shouldDropNested(child, parent) {
        if (isStrongControl(child)) return false;
        if (isStrongControl(parent)) return true;
        const childText = textOf(child, 120);
        const parentText = textOf(parent, 120);
        const childArea = elementArea(child);
        const parentArea = elementArea(parent);
        if (childText && parentText && childText !== parentText) return false;
        if (parentArea > 0 && childArea / parentArea < 0.65) return false;
        return true;
    }

    // ── 标记叠加层（描边 + 变化后自动清除）────────────────────────────────────
    let markMutationObservers = [];
    let markAutoClearTimer = null;

    function isOwnMarkNode(node) {
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        return !!(el && el.closest && el.closest(`#${MARK_LAYER_ID},#${MARK_STYLE_ID}`));
    }
    function isPageMutation(records) {
        return records.some((record) => {
            if (isOwnMarkNode(record.target)) return false;
            return [...record.addedNodes, ...record.removedNodes].some((node) => !isOwnMarkNode(node))
                || record.type === 'characterData' || record.type === 'attributes';
        });
    }
    function stopMarksAutoClear() {
        if (markAutoClearTimer !== null) { window.clearTimeout(markAutoClearTimer); markAutoClearTimer = null; }
        markMutationObservers.forEach((observer) => observer.disconnect());
        markMutationObservers = [];
        MARK_CHANGE_EVENTS.forEach((event) => window.removeEventListener(event, clearMarksOverlay, true));
    }
    function clearMarksOverlay() {
        stopMarksAutoClear();
        const existing = document.getElementById(MARK_LAYER_ID);
        if (existing) existing.remove();
    }
    function watchDocumentForMarkChanges(doc) {
        const root = doc.documentElement || doc.body;
        if (!root) return;
        const observer = new MutationObserver((records) => { if (isPageMutation(records)) clearMarksOverlay(); });
        observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
        markMutationObservers.push(observer);
    }
    function startMarksAutoClear(marksList) {
        stopMarksAutoClear();
        markAutoClearTimer = window.setTimeout(() => {
            markAutoClearTimer = null;
            const docs = new Set([document]);
            marksList.forEach((mark) => { if (mark.frame && mark.frame.doc) docs.add(mark.frame.doc); });
            docs.forEach(watchDocumentForMarkChanges);
            MARK_CHANGE_EVENTS.forEach((event) => window.addEventListener(event, clearMarksOverlay, true));
        }, 150);
    }
    function ensureMarkStyles() {
        let style = document.getElementById(MARK_STYLE_ID);
        if (!style) {
            style = document.createElement('style');
            style.id = MARK_STYLE_ID;
            document.documentElement.appendChild(style);
        }
        style.textContent = `
            #${MARK_LAYER_ID} .hs-mark-box{position:fixed;box-sizing:border-box;pointer-events:none;
              border:2px solid var(--hs-mark-color);border-radius:4px;background:transparent;}
            #${MARK_LAYER_ID} .hs-mark-clickable{--hs-mark-color:rgba(34,197,94,.92);}
            #${MARK_LAYER_ID} .hs-mark-blocked{--hs-mark-color:rgba(239,68,68,.92);}
            #${MARK_LAYER_ID} .hs-mark-frame{--hs-mark-color:rgba(168,85,247,.88);border-style:dashed;}`;
    }
    function drawMarksOverlay(marksList) {
        clearMarksOverlay();
        ensureMarkStyles();
        const layer = document.createElement('div');
        layer.id = MARK_LAYER_ID;
        layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;z-index:2147483646;pointer-events:none;';
        marksList.forEach(({ el, status, frame }) => {
            const rect = frame ? elementViewportRect(el, frame) : rectInfo(el.getBoundingClientRect());
            const box = document.createElement('div');
            box.className = `hs-mark-box hs-mark-${status}`;
            box.style.left = `${rect.x}px`;
            box.style.top = `${rect.y}px`;
            box.style.width = `${Math.max(0, rect.w)}px`;
            box.style.height = `${Math.max(0, rect.h)}px`;
            layer.appendChild(box);
        });
        document.documentElement.appendChild(layer);
        startMarksAutoClear(marksList);
    }

    // ── 精简 item（保留 selector/tag + 基本属性以便卡片构造，仅省去较重的 rect）──────────────
    const ITEM_DROP_KEYS = new Set(['rect']);
    function slimItem(item) {
        const out = {};
        for (const k of Object.keys(item)) { if (ITEM_DROP_KEYS.has(k)) continue; out[k] = item[k]; }
        return out;
    }
    function itemCategory(item) {
        if (item && item.kind === 'text') return 'text';
        if (item && item.kind === 'frame') return 'frame';
        return String((item && item.category) || (item && item.kind) || 'other');
    }
    function countItemsByCategory(items) {
        const counts = {};
        for (const item of items) { const key = itemCategory(item); counts[key] = (counts[key] || 0) + 1; }
        return Object.fromEntries(Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0])));
    }
    function kindSortRank(kind) {
        if (kind === 'text') return 0;
        if (kind === 'media') return 1;
        if (kind === 'frame') return 2;
        return 3;
    }

    // ── browser_observe ───────────────────────────────────────────────────────
    function scan(msg = {}) {
        clearMarksOverlay();
        const limit = Math.min(Math.max(Number(msg.limit != null ? msg.limit : 120), 1), 200);
        const includeText = msg.include_text !== false;
        const textLimit = Math.min(Math.max(Number(msg.text_limit != null ? msg.text_limit : 200), 0), 500);
        const defaultMaxItems = includeText ? Math.min(500, limit + textLimit + 40) : limit;
        const maxItems = Math.min(Math.max(Number(msg.max_items != null ? msg.max_items : defaultMaxItems), 1), 500);
        const categoryFilter = parseFilter(msg.filter);
        const tagFilter = parseTagFilter(msg.tag != null ? msg.tag : msg.tags);
        const keyword = parseKeyword(msg.keyword != null ? msg.keyword : (msg.query != null ? msg.query : msg.text_filter));
        const wantText = !categoryFilter || categoryFilter.has('text');
        const wantFrame = !categoryFilter || categoryFilter.has('frame');

        // 可选 frame 作用域：整页 items 过多时只观察某个同源 iframe（及其后代）。
        const wantsScope = !!(msg.frame || msg.frame_selector || (Array.isArray(msg.frame_path) && msg.frame_path.length));
        const scopeFrame = wantsScope ? resolveFrameBySelector(msg.frame || msg.frame_selector, msg.frame_path) : null;
        if (wantsScope && !scopeFrame) {
            throw new Error(`Frame not found or not accessible: ${msg.frame || msg.frame_selector || (msg.frame_path || []).join(' > ')} — 用 browser_observe {filter:"frame"} 查看可用 iframe 的 frameSelector/framePath。`);
        }
        const scopes = scanScopes(scopeFrame);

        const all = collectCandidates(scopes);
        const iframeCandidates = all.filter((item) => item.frame);
        const isItemHittable = (item) => item.frame ? isLikelyInteractableInFrame(item.el, item.frame) : isHittable(item.el);
        const hittable = all.filter(isItemHittable);
        const iframeHittable = hittable.filter((item) => item.frame);
        const set = new Set(hittable.map((item) => item.el));
        const blockedForMarks = collectBlockedCandidates(all, set, scopes);
        const frameScan = collectFrameItems(scopeFrame);
        const frameItems = wantFrame
            ? frameScan.items.filter((frame) => (!tagFilter || tagFilter.has('iframe'))
                && (!keyword || [frame.text, frame.name, frame.title, frame.src].join(' ').toLowerCase().includes(keyword)))
            : [];
        const frameOverlay = wantFrame ? frameScan.overlay : [];
        const frameChildCounts = new Map();
        for (const item of all) {
            if (!item.frame) continue;
            const key = buildFramePath(item.frame).join('>');
            frameChildCounts.set(key, (frameChildCounts.get(key) || 0) + 1);
        }
        // 只去掉明显的重复包装：父元素也可交互且子元素基本是它的“外壳”时才丢弃。
        const pruned = hittable.filter((item) => {
            let p = item.el.parentElement;
            while (p) { if (set.has(p) && shouldDropNested(item.el, p)) return false; p = p.parentElement; }
            return true;
        });

        const interactiveRecords = pruned
            .map((item) => elementRecord(item.el, item.frame))
            .filter((rec) => interactiveCategoryAllowed(rec.category, categoryFilter))
            .filter((rec) => matchesElementFilters(rec.el, tagFilter, keyword, rec.text));
        interactiveRecords.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
        const slicedRecords = interactiveRecords.slice(0, limit);

        const mediaRecords = (!categoryFilter || categoryFilter.has('media') || categoryFilter.has('image') || categoryFilter.has('video') || categoryFilter.has('audio'))
            ? collectVisibleMedia(scopes)
                .filter((rec) => mediaCategoryAllowed(rec.category, categoryFilter))
                .filter((rec) => matchesElementFilters(rec.el, tagFilter, keyword, rec.text))
                .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x)
            : [];

        const overlayMarks = [];
        const markTargets = [];
        let nextId = 1;
        const elements = [];
        const interactiveItems = slicedRecords.map((rec) => {
            const id = nextId; nextId += 1;
            markTargets.push({
                el: rec.el, selector: rec.selector, text: rec.text, center: rec.center,
                frameSelector: rec.frame && rec.frame.frameSelector,
                framePath: rec.frame ? buildFramePath(rec.frame) : undefined
            });
            const item = interactiveItemFromRecord(rec, id);
            elements.push(item);
            overlayMarks.push({ el: rec.el, status: 'clickable', frame: rec.frame });
            return item;
        });

        const rawTexts = (includeText && wantText) ? collectVisibleTexts(textLimit, scopes)
            .filter((t) => (!tagFilter || tagFilter.has(String(t.tag || '').toLowerCase())) && (!keyword || String(t.text || '').toLowerCase().includes(keyword)))
            : [];
        const iframeTexts = rawTexts.filter((t) => t.inFrame);
        const iframeTextCount = iframeTexts.length;
        for (const frame of frameItems) {
            if (!frame.accessible) continue;
            const key = (frame.framePath || [frame.frameSelector]).join('>');
            frame.interactiveCount = frameChildCounts.get(key) || 0;
            const pathKey = (frame.framePath || []).join('>');
            const matchFrame = (t) => (t.framePath || []).join('>') === pathKey || t.frameSelector === frame.frameSelector;
            const samples = iframeTexts.filter(matchFrame).slice(0, 5).map((t) => ({ text: t.text, selector: t.selector, center: t.center }));
            if (samples.length) frame.textSamples = samples;
            frame.textCount = iframeTexts.filter(matchFrame).length;
            if (!frame.interactiveCount && !samples.length) {
                frame.scanNote = 'iframe 内未扫描到可交互控件或可见文本；可能为纯渲染预览、嵌套跨域 iframe，或内容尚未加载完成';
            } else if (!frame.interactiveCount) {
                frame.scanNote = 'iframe 内仅有可见文本，无可交互控件';
            }
        }
        const textItems = rawTexts.map((t) => ({
            kind: 'text', role: t.role, tag: t.tag, text: t.text, selector: t.selector, center: t.center, rect: t.rect,
            ...(t.inFrame ? { inFrame: true, frameSelector: t.frameSelector, framePath: t.framePath } : {})
        }));
        textItems.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);

        const mediaItems = mediaRecords.map(mediaItemFromRecord);
        const candidateItems = [...textItems, ...frameItems, ...mediaItems, ...interactiveRecords.map((rec, i) => interactiveItemFromRecord(rec, i + 1))]
            .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || kindSortRank(a.kind) - kindSortRank(b.kind));
        const categoryCounts = countItemsByCategory(candidateItems);
        const tooMany = interactiveRecords.length > limit || candidateItems.length > maxItems;

        const statsBase = {
            candidates: all.length, hittable: hittable.length, afterDedupe: pruned.length, blocked: blockedForMarks.length,
            limit, maxItems, textLimit, includeText,
            filter: categoryFilter ? Array.from(categoryFilter) : null,
            tag: tagFilter ? Array.from(tagFilter) : null, keyword: keyword || null,
            media: mediaRecords.length, frames: frameItems.length,
            accessibleFrames: frameItems.filter((f) => f.accessible).length,
            iframeCandidates: iframeCandidates.length, iframeHittable: iframeHittable.length
        };

        if (tooMany && msg.allow_truncate !== true) {
            setMarks([]);
            const ctx = viewportContext();
            return {
                success: true, source: 'browser_observe', url: location.href, title: document.title,
                count: 0, textCount: 0, itemCount: candidateItems.length, frameCount: frameItems.length,
                tooMany: true, overLimit: true, maxItems, categoryCounts, stats: statsBase, marked: false,
                scroll: { y: ctx.scrollY, percent: ctx.scrollPercent, atTop: ctx.atTop, atBottom: ctx.atBottom },
                currentSection: ctx.currentSection,
                ...(scopeFrame ? { scopedToFrame: buildFramePath(scopeFrame) } : {}),
                items: [],
                hint: `当前 observe 匹配到 ${candidateItems.length} 个条目（可交互 ${interactiveRecords.length} 个），超过 limit=${limit} 或 max_items=${maxItems}，为避免返回过多内容已不返回 items。请使用 filter（button/link/input/image/video/text/frame 等）、tag/tags、keyword，或提高 limit/max_items；也可传 frame（iframe 的 frameSelector）或 frame_path 只观察某个 iframe 内部；categoryCounts 给出了各类别数量。`
            };
        }

        const items = [...textItems, ...frameItems, ...mediaItems, ...interactiveItems]
            .sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || kindSortRank(a.kind) - kindSortRank(b.kind));

        setMarks(markTargets);

        const blockedChosen = blockedForMarks
            .filter((el) => interactiveCategoryAllowed(elementCategory(el), categoryFilter))
            .slice(0, limit);
        const marked = msg.mark !== false;
        if (marked) {
            drawMarksOverlay([
                ...frameOverlay.map(({ el, frame }) => ({ el, status: 'frame', frame })),
                ...overlayMarks,
                ...blockedChosen.map((el) => ({ el, status: 'blocked' }))
            ]);
        }

        const ctx = viewportContext();
        const filterHint = categoryFilter
            ? ` 已按 filter=[${Array.from(categoryFilter).join(',')}] 过滤：只返回这些类别。`
            : '';
        const queryHint = [
            tagFilter ? `tag=[${Array.from(tagFilter).join(',')}]` : '',
            keyword ? `keyword="${keyword}"` : ''
        ].filter(Boolean).join(' ');
        const markHint = marked ? ' 页面标记：紫色虚线=iframe 边界，绿色=可点击，红色=不可点击/被禁用/被遮挡。' : '';

        return {
            success: true, source: 'browser_observe', url: location.href, title: document.title,
            count: elements.length, textCount: textItems.length, itemCount: items.length,
            frameCount: frameItems.length, accessibleFrameCount: frameItems.filter((f) => f.accessible).length,
            accessibleFrameUrls: accessibleFrameDocUrls(),
            iframeCandidates: iframeCandidates.length, iframeHittable: iframeHittable.length, iframeTextCount,
            stats: statsBase,
            truncated: interactiveRecords.length > slicedRecords.length,
            textTruncated: includeText && rawTexts.length >= textLimit,
            tooMany: false, maxItems, categoryCounts, marked,
            scroll: { y: ctx.scrollY, percent: ctx.scrollPercent, atTop: ctx.atTop, atBottom: ctx.atBottom },
            currentSection: ctx.currentSection,
            ...(scopeFrame ? { scopedToFrame: buildFramePath(scopeFrame) } : {}),
            items: items.map(slimItem),
            hint: '返回 items 单一混排列表（按位置排序、已去重，用 kind 区分）：kind=text 可见文本（不可点击），' +
                'kind=media 图片/视频/音频（不可点击；category=image/video/audio），kind=frame 页面内 iframe 边界' +
                '（accessible=true 表示同源已扫描，子元素见 inFrame=true 的 interactive；accessible=false 为跨域），' +
                'kind=interactive 可点击元素（带临时 id 供 ref，同时返回 tag/selector/name/placeholder/ariaLabel/value/optionsSample 等基本信息）。' +
                ' 为便于自动化卡片创建/修改，推荐使用 selector 或 text+tag 构造持久步骤（卡片 runner 使用这些而非临时 ref）；ref:id 仅本次 observe 有效，用于 browser_action 快速操作。' +
                ' inFrame=true 表示元素在同源 iframe 内。勿使用 Playwright 语法（如 :has-text）；可用 text/selector/ref 定位。' +
                filterHint + (queryHint ? ` 已按 ${queryHint} 筛选。` : '') + markHint
        };
    }

    // ── browser_action：视觉动效挂钩 ──────────────────────────────────────────
    async function playFx(el, variant) {
        if (window.__hsFx && typeof window.__hsFx.clickEl === 'function') {
            try { await window.__hsFx.clickEl(el, variant); } catch (_error) { /* visual-only */ }
        }
    }

    // ── browser_action 成功回执：附可直接写入自动化卡片的 cardStep ─────────────
    // 探索（browser_action）→ 固化（manage_card write）不再需要人工翻译 selector：
    // 成功后带回与卡片规范同构的步骤对象，selector 用 cssPath（优先稳定属性选择器）。
    // 卡片 runner 只在主文档查找元素，iframe 内元素以 inFrame + note 提醒不可直接写入。
    function cardStepReceipt(el, frame, stepType, extra = {}) {
        try {
            const selector = cssPath(el);
            if (!selector) return {};
            const attr = (name) => String((el.getAttribute && el.getAttribute(name)) || '').trim();
            const label = textOf(el, 30) || attr('aria-label') || attr('placeholder') || attr('name') || el.tagName.toLowerCase();
            const prefix = stepType === 'click' ? '点击' : stepType === 'type' ? '输入' : '操作';
            const out = { cardStep: { name: `${prefix} ${label}`.trim().slice(0, 50), type: stepType, selector, ...extra } };
            if (frame) {
                out.cardStep.inFrame = true;
                out.cardStepNote = '元素在 iframe 内：卡片 runner 只查主文档，此 selector 直接写入卡片将找不到元素（可考虑 navigate 直达 iframe 的 src，或改用 external_script）。';
            }
            return out;
        } catch (_error) {
            return {};
        }
    }

    // ── browser_action：click / double_click / right_click ───────────────────
    function dispatchClickSequence(el, center, opts = {}) {
        const win = ownerWindow(el);
        const button = opts.button === 'right' ? 2 : opts.button === 'middle' ? 1 : 0;
        const buttons = opts.button === 'right' ? 2 : opts.button === 'middle' ? 4 : 1;
        const base = { bubbles: true, cancelable: true, view: win, clientX: center.x, clientY: center.y, button };
        const pointer = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true };
        el.dispatchEvent(new PointerEvent('pointerover', pointer));
        el.dispatchEvent(new MouseEvent('mouseover', base));
        el.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons }));
        el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons }));
        el.dispatchEvent(new PointerEvent('pointerup', { ...pointer, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
        if (opts.button === 'right') {
            el.dispatchEvent(new MouseEvent('contextmenu', base));
        } else {
            el.dispatchEvent(new MouseEvent('click', base));
            try { el.click(); } catch (_error) { /* some elements reject synthetic .click() */ }
        }
    }

    async function clickLikeUser(msg = {}, variant = 'left') {
        const resolved = resolveTarget(msg);
        const el = resolved.el;
        if (!el) return { success: false, error: '未找到目标元素（ref/selector/text/坐标均未命中）', code: 'TARGET_NOT_FOUND' };
        const frame = resolved.frame;

        const viaCoords = msg.x !== undefined && msg.y !== undefined
            && (msg.ref === undefined || msg.ref === null || msg.ref === '');

        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_error) { /* ignore */ }

        if (!viaCoords) {
            if (!isVisible(el)) {
                return { success: false, not_visible: true, code: 'NOT_VISIBLE',
                    error: '目标元素存在于 DOM 中，但当前不可见（display:none / 尺寸为 0 / 在视口外）。',
                    tag: el.tagName.toLowerCase(), text: textOf(el, 80) };
            }
            if (!msg.force && !isHittable(el, frame)) {
                const cover = occluderAtViewport(el, frame);
                return { success: false, occluded: true, code: 'OCCLUDED',
                    error: '目标元素当前被遮挡或不在可视区域内，可能需要先关闭遮挡层；确认要穿透点击请传 force:true',
                    occluderTag: cover ? String(cover.tagName || '').toLowerCase() : '' };
            }
        }

        const center = elCenter(el);
        await playFx(el, variant === 'right' ? 'right' : variant === 'double' ? 'double' : 'left');

        if (variant === 'double') {
            dispatchClickSequence(el, center, {});
            dispatchClickSequence(el, center, {});
            el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: ownerWindow(el), clientX: center.x, clientY: center.y }));
        } else if (variant === 'right') {
            dispatchClickSequence(el, center, { button: 'right' });
        } else {
            dispatchClickSequence(el, center, {});
        }

        const ctx = viewportContext();
        return {
            success: true, tag: el.tagName.toLowerCase(), text: textOf(el, 100), center,
            position: { scrollY: ctx.scrollY, scrollPercent: ctx.scrollPercent, currentSection: ctx.currentSection },
            ...(variant === 'left' ? cardStepReceipt(el, frame, 'click') : {})
        };
    }

    // ── browser_action：type ──────────────────────────────────────────────────
    function setNativeValue(el, value) {
        const win = ownerWindow(el);
        const tag = String(el && el.tagName || '').toLowerCase();
        let proto = null;
        if (tag === 'textarea') {
            proto = win.HTMLTextAreaElement.prototype;
        } else if (tag === 'input') {
            proto = win.HTMLInputElement.prototype;
        }
        if (proto) {
            const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
            if (descriptor && descriptor.set) descriptor.set.call(el, value);
            else el.value = value;
        } else if ('value' in el) {
            el.value = value;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        try { el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value || '') })); } catch (_) {}
    }

    function isTypeableElement(el) {
        if (!el) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (tag === 'textarea') return true;
        if (tag === 'input') {
            const t = String(el.type || 'text').toLowerCase();
            const blocked = ['hidden', 'submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'color', 'range'];
            return !blocked.includes(t);
        }
        if (el.isContentEditable === true) return true;
        const role = String(el.getAttribute && el.getAttribute('role') || '').toLowerCase();
        if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return true;
        return false;
    }

    async function typeInto(msg = {}) {
        const resolved = resolveTarget(msg);
        const el = resolved.el;
        if (!el) return { success: false, error: '未找到目标输入元素', code: 'TARGET_NOT_FOUND' };

        if (!isTypeableElement(el)) {
            const tag = String(el.tagName || '').toLowerCase();
            const role = String(el.getAttribute && el.getAttribute('role') || '').toLowerCase();
            return {
                success: false,
                error: `元素类型不支持 type（tag=<${tag}> role="${role || 'none'}"），仅支持 input/textarea/contenteditable/role=textbox 等`,
                code: 'UNSUPPORTED_ELEMENT_TYPE'
            };
        }

        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_error) { /* ignore */ }
        await playFx(el, 'left');
        try { el.focus(); } catch (_error) { /* ignore */ }

        const text = msg.text != null ? String(msg.text) : '';
        const clearFirst = msg.clear_first !== false;

        if (el.isContentEditable) {
            el.innerText = clearFirst ? text : `${el.innerText || ''}${text}`;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
        } else {
            setNativeValue(el, clearFirst ? text : `${el.value || ''}${text}`);
        }

        let submitted = false;
        if (msg.submit) {
            const form = el.closest ? el.closest('form') : null;
            if (form && typeof form.requestSubmit === 'function') {
                try { form.requestSubmit(); submitted = true; } catch (_error) {
                    try { form.submit(); submitted = true; } catch (_error2) { /* give up quietly */ }
                }
            } else {
                const win = ownerWindow(el);
                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, view: win }));
                el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true, view: win }));
            }
        }

        return {
            success: true, tag: el.tagName.toLowerCase(), submitted,
            ...cardStepReceipt(el, resolved.frame, 'type', { text })
        };
    }

    // ── browser_action：press_key ─────────────────────────────────────────────
    const SPECIAL_KEYS = {
        Enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
        Return: { key: 'Enter', code: 'Enter', keyCode: 13 },
        Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
        Esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
        Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
        Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
        Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
        Home: { key: 'Home', code: 'Home', keyCode: 36 },
        End: { key: 'End', code: 'End', keyCode: 35 },
        PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
        PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
        ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
        ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
        ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
        ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
        Space: { key: ' ', code: 'Space', keyCode: 32 },
        ' ': { key: ' ', code: 'Space', keyCode: 32 }
    };
    for (let i = 1; i <= 12; i += 1) SPECIAL_KEYS[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

    function keyInfo(raw) {
        const value = String(raw || '');
        if (SPECIAL_KEYS[value]) return SPECIAL_KEYS[value];
        if (/^[a-z]$/i.test(value)) {
            const upper = value.toUpperCase();
            return { key: value, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
        }
        if (/^[0-9]$/.test(value)) return { key: value, code: `Digit${value}`, keyCode: value.charCodeAt(0) };
        return { key: value, code: value, keyCode: 0 };
    }

    async function pressKey(msg = {}) {
        let target = document.activeElement;
        if (msg.selector) {
            const found = findEl(msg.selector);
            if (found) { try { found.focus(); } catch (_error) { /* ignore */ } target = found; }
        } else if (msg.ref !== undefined) {
            const resolved = resolveTarget(msg);
            if (resolved.el) { try { resolved.el.focus(); } catch (_error) { /* ignore */ } target = resolved.el; }
        }
        if (!target || target === document.documentElement) target = document.body;

        const info = keyInfo(msg.key);
        const win = ownerWindow(target);
        const base = {
            key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode,
            ctrlKey: !!msg.ctrl, shiftKey: !!msg.shift, altKey: !!msg.alt, metaKey: !!msg.meta,
            bubbles: true, cancelable: true, view: win
        };
        target.dispatchEvent(new KeyboardEvent('keydown', base));
        target.dispatchEvent(new KeyboardEvent('keypress', base));
        target.dispatchEvent(new KeyboardEvent('keyup', base));

        let submitted = false;
        if (info.key === 'Enter') {
            const form = target.closest ? target.closest('form') : null;
            if (form && typeof form.requestSubmit === 'function') {
                try { form.requestSubmit(); submitted = true; } catch (_error) { /* ignore */ }
            }
        }
        return { success: true, key: info.key, code: info.code, submitted, method: 'synthetic.KeyboardEvent' };
    }

    // ── browser_action：scroll ────────────────────────────────────────────────
    async function scrollPage(msg = {}) {
        const amount = Number(msg.amount) || 400;
        const direction = String(msg.direction || 'down');
        if (window.__hsFx && typeof window.__hsFx.scrollDrag === 'function') {
            try { await window.__hsFx.scrollDrag(direction, amount); } catch (_error) { /* visual-only */ }
        }
        const before = { x: window.scrollX, y: window.scrollY };
        if (msg.selector) {
            const el = findEl(msg.selector);
            if (el) { try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_error) { /* ignore */ } }
        } else if (direction === 'top') {
            window.scrollTo({ top: 0, left: window.scrollX });
        } else if (direction === 'bottom') {
            window.scrollTo({ top: document.documentElement.scrollHeight, left: window.scrollX });
        } else if (direction === 'up') {
            window.scrollBy(0, -amount);
        } else {
            window.scrollBy(0, amount);
        }
        const after = { x: window.scrollX, y: window.scrollY };
        const ctx = viewportContext();
        return {
            success: true, direction, amount, before, after,
            moved: Math.round(Math.hypot(after.x - before.x, after.y - before.y)),
            scroll: { y: ctx.scrollY, percent: ctx.scrollPercent, atTop: ctx.atTop, atBottom: ctx.atBottom },
            currentSection: ctx.currentSection
        };
    }

    // ── browser_wait ──────────────────────────────────────────────────────────
    async function waitFor(msg = {}) {
        const selector = String(msg.selector || '').trim();
        const ms = Number(msg.ms);
        if (selector) {
            const timeoutMs = Number.isFinite(ms) && ms > 0 ? ms : 10000;
            const deadline = Date.now() + timeoutMs;
            while (Date.now() <= deadline) {
                const el = document.querySelector(selector);
                if (el && isVisible(el)) {
                    return {
                        success: true, selector,
                        cardStep: { name: `等待 ${selector}`.slice(0, 50), type: 'wait', selector, timeout: timeoutMs }
                    };
                }
                await sleep(150);
            }
            return { success: false, error: `等待元素超时: ${selector}`, selector };
        }
        const waitMs = Number.isFinite(ms) && ms > 0 ? ms : 1000;
        await sleep(waitMs);
        return { success: true, waitedMs: waitMs };
    }

    window.__hsObserve = {
        __installed: true,
        scan,
        click: clickLikeUser,
        type: typeInto,
        pressKey,
        scroll: scrollPage,
        wait: waitFor
    };
})();
