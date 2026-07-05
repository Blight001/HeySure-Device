// content/observe.js — 页面观察与交互底座（browser_observe / browser_action / browser_wait /
// browser_drag 的执行核心），简化移植自 device/extension/src/content/{observe,dom}.ts：
// 只扫描/操作当前文档（不含跨域 iframe），点击/输入/按键都用合成事件（非 CDP trusted 事件）。
// 与 content/fx.js 同样的模式：常驻内容脚本，把 API 幂等挂到 window.__hsObserve 上，
// 供 background 用一次性 chrome.scripting.executeScript(...).func 调用；window 在同一
// 文档生命周期内持久，因此 browser_observe 生成的 id → 元素映射能被后续 browser_action 复用。

(() => {
    'use strict';
    if (window.__hsObserve && window.__hsObserve.__installed) {
        return;
    }

    const INTERACTIVE = [
        'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
        '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
        '[role="tab"]', '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
        '[role="switch"]', '[role="option"]', '[contenteditable=""]', '[contenteditable="true"]',
        '[onclick]', '[tabindex]:not([tabindex="-1"])', 'summary', 'label[for]'
    ].join(',');

    const TEXT_SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'canvas', 'iframe']);
    const MARK_LAYER_ID = '__hs_observe_marks_layer__';

    const marks = new Map();

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

    function toList(raw) {
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') return raw.split(',');
        if (raw === null || raw === undefined) return [];
        return [raw];
    }

    function clampNum(value, fallback, min, max) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, Math.round(n)));
    }

    function isVisible(el) {
        if (!el || el.nodeType !== 1) return false;
        let style;
        try { style = window.getComputedStyle(el); } catch (_error) { return false; }
        if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0
            && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
    }

    function centerOf(el) {
        const rect = el.getBoundingClientRect();
        const x = Math.min(Math.max(rect.left + rect.width / 2, 1), window.innerWidth - 1);
        const y = Math.min(Math.max(rect.top + rect.height / 2, 1), window.innerHeight - 1);
        return { x, y };
    }

    function isTopmostAt(el, x, y) {
        let hit = null;
        try { hit = document.elementFromPoint(x, y); } catch (_error) { return true; }
        if (!hit) return false;
        return hit === el || el.contains(hit) || hit.contains(el);
    }

    function isHittable(el) {
        if (!isVisible(el)) return false;
        const rect = el.getBoundingClientRect();
        const points = [
            [rect.left + rect.width / 2, rect.top + rect.height / 2],
            [rect.left + 2, rect.top + 2],
            [rect.right - 2, rect.top + 2],
            [rect.left + 2, rect.bottom - 2],
            [rect.right - 2, rect.bottom - 2]
        ];
        return points.some(([x, y]) => {
            if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
            return isTopmostAt(el, x, y);
        });
    }

    function textOf(el, max = 200) {
        const parts = [el.innerText, el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('title'), el.value, el.placeholder, el.textContent];
        for (const part of parts) {
            const t = String(part || '').replace(/\s+/g, ' ').trim();
            if (t) return t.slice(0, max);
        }
        return '';
    }

    function elementCategory(el) {
        const tag = el.tagName.toLowerCase();
        const role = String(el.getAttribute('role') || '').toLowerCase();
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
        return 'other';
    }

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
        text: 'text', texts: 'text',
        interactive: 'interactive', all: 'all'
    };

    function normalizeFilterList(raw) {
        const list = toList(raw).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
        const mapped = list.map((v) => FILTER_ALIASES[v] || v).filter((v) => v && v !== 'all' && v !== 'interactive' && v !== 'text');
        return Array.from(new Set(mapped));
    }

    function normalizeTagList(tag, tags) {
        const merged = toList(tag).concat(toList(tags)).map((v) => String(v || '').trim().toLowerCase()).filter(Boolean);
        return Array.from(new Set(merged));
    }

    // ── Selector building (self-healing ref lookup) ─────────────────────────
    function selectorResolvesTo(selector, el) {
        try {
            const hits = document.querySelectorAll(selector);
            return hits.length === 1 && hits[0] === el;
        } catch (_error) {
            return false;
        }
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
        if (!el || el.nodeType !== 1) return '';
        const attrSel = stableAttrSelector(el);
        if (attrSel) return attrSel;

        const segment = (node) => {
            const tag = node.tagName.toLowerCase();
            if (node.id) return `#${CSS.escape(node.id)}`;
            const cls = String(node.className || '').split(/\s+/).filter(Boolean).slice(0, 2)
                .map((c) => `.${CSS.escape(c)}`).join('');
            const parent = node.parentElement;
            const siblings = parent ? Array.from(parent.children).filter((c) => c.tagName === node.tagName) : [];
            const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : '';
            return `${tag}${cls}${nth}`;
        };

        const parts = [];
        let cur = el;
        const root = document.documentElement;
        let depth = 0;
        while (cur && cur !== root && depth < 12) {
            parts.unshift(segment(cur));
            const path = parts.join(' > ');
            if (selectorResolvesTo(path, el)) return path;
            if (cur.id) break;
            cur = cur.parentElement;
            depth += 1;
        }
        return parts.length ? parts.join(' > ') : el.tagName.toLowerCase();
    }

    function findEl(selector, text) {
        if (selector) {
            try {
                const matches = Array.from(document.querySelectorAll(selector));
                return matches.find(isHittable) || matches.find(isVisible) || matches[0] || null;
            } catch (_error) {
                return null;
            }
        }
        if (text) {
            const needle = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
            if (!needle) return null;
            const preferred = Array.from(document.querySelectorAll('button, a, [role="button"], input, textarea, select, [aria-label], [title], label'));
            const matches = (el, exact) => {
                const t = textOf(el).toLowerCase();
                return exact ? t === needle : t.includes(needle);
            };
            return preferred.find((el) => matches(el, true) && isHittable(el))
                || preferred.find((el) => matches(el, false) && isHittable(el))
                || preferred.find((el) => matches(el, true) && isVisible(el))
                || preferred.find((el) => matches(el, false) && isVisible(el))
                || null;
        }
        return null;
    }

    function normalizeRefKey(ref) {
        const n = Number(ref);
        return Number.isFinite(n) ? n : ref;
    }

    function resolveTarget(msg = {}) {
        const hasRef = msg.ref !== undefined && msg.ref !== null && String(msg.ref).trim() !== '';
        if (hasRef) {
            const mark = marks.get(normalizeRefKey(msg.ref));
            if (mark) {
                if (mark.el && mark.el.isConnected) return { el: mark.el, ...centerOf(mark.el) };
                const healed = findEl(mark.selector, mark.text);
                if (healed) return { el: healed, ...centerOf(healed) };
                return { el: null, x: mark.center.x, y: mark.center.y };
            }
        }
        if (msg.selector || msg.text) {
            const el = findEl(msg.selector, msg.text);
            if (el) return { el, ...centerOf(el) };
        }
        if (msg.x !== undefined && msg.y !== undefined) {
            const x = Number(msg.x);
            const y = Number(msg.y);
            let hit = null;
            try { hit = document.elementFromPoint(x, y); } catch (_error) { /* ignore */ }
            return { el: hit, x, y };
        }
        return { el: null, x: 0, y: 0 };
    }

    // ── Mark overlay (visual boxes for browser_screenshot pairing) ──────────
    function clearMarkOverlay() {
        const existing = document.getElementById(MARK_LAYER_ID);
        if (existing) existing.remove();
    }

    function drawMarkOverlay(items) {
        clearMarkOverlay();
        if (!document.documentElement) return;
        const layer = document.createElement('div');
        layer.id = MARK_LAYER_ID;
        layer.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none;';
        for (const item of items) {
            const mark = marks.get(item.id);
            const el = mark && mark.el;
            if (!el || !el.isConnected) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            const color = item.hittable ? 'rgba(34,197,94,0.9)' : 'rgba(239,68,68,0.85)';
            const box = document.createElement('div');
            box.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;` +
                `height:${rect.height}px;border:1.5px solid ${color};border-radius:3px;box-sizing:border-box;`;
            layer.appendChild(box);
        }
        document.documentElement.appendChild(layer);
    }

    // ── browser_observe ──────────────────────────────────────────────────────
    function collectVisibleText(limit) {
        const results = [];
        const seenText = new Set();
        const all = document.body ? document.body.querySelectorAll('*') : [];
        for (const el of all) {
            if (results.length >= limit) break;
            const tag = el.tagName.toLowerCase();
            if (TEXT_SKIP_TAGS.has(tag)) continue;
            if (!isVisible(el)) continue;
            let direct = '';
            for (const child of el.childNodes) {
                if (child.nodeType === 3) direct += child.textContent;
            }
            direct = direct.replace(/\s+/g, ' ').trim();
            if (!direct || seenText.has(direct)) continue;
            seenText.add(direct);
            results.push({ kind: 'text', text: direct.slice(0, 300), tag, center: centerOf(el) });
        }
        return results;
    }

    function countCategories(interactiveItems, textItems) {
        const counts = {};
        for (const item of interactiveItems) counts[item.category] = (counts[item.category] || 0) + 1;
        if (textItems.length) counts.text = textItems.length;
        return counts;
    }

    function scan(opts = {}) {
        const limit = clampNum(opts.limit, 120, 1, 200);
        const includeText = opts.include_text !== false;
        const textLimit = clampNum(opts.text_limit, 200, 1, 500);
        const maxItems = clampNum(opts.max_items, limit + (includeText ? textLimit : 0) + 40, 1, 500);
        const filters = normalizeFilterList(opts.filter);
        const tags = normalizeTagList(opts.tag, opts.tags);
        const keyword = String(opts.keyword || opts.query || opts.text_filter || '').trim().toLowerCase();

        marks.clear();
        clearMarkOverlay();

        const nodes = Array.from(document.querySelectorAll(INTERACTIVE));
        const seen = new Set();
        const interactiveItems = [];
        let nextId = 1;

        for (const el of nodes) {
            if (seen.has(el)) continue;
            seen.add(el);
            if (!isVisible(el)) continue;

            const category = elementCategory(el);
            if (filters.length && !filters.includes(category)) continue;
            if (tags.length && !tags.includes(el.tagName.toLowerCase())) continue;

            const text = textOf(el);
            if (keyword) {
                const haystack = [text, el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('name'), el.id, el.getAttribute('href')]
                    .map((v) => String(v || '').toLowerCase());
                if (!haystack.some((h) => h.includes(keyword))) continue;
            }

            const hittable = isHittable(el);
            const center = centerOf(el);
            const id = nextId;
            nextId += 1;
            marks.set(id, { el, selector: cssPath(el), text, center });
            interactiveItems.push({
                kind: 'interactive',
                id,
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || '',
                category,
                text,
                center,
                hittable,
                disabled: !!el.disabled
            });
        }

        const textItems = includeText ? collectVisibleText(textLimit) : [];
        const overLimit = opts.allow_truncate !== true
            && (interactiveItems.length > limit || (interactiveItems.length + textItems.length) > maxItems);

        if (overLimit) {
            return {
                success: true,
                source: 'browser_observe',
                url: location.href,
                title: document.title,
                tooMany: true,
                overLimit: true,
                itemCount: interactiveItems.length + textItems.length,
                count: 0,
                textCount: 0,
                categoryCounts: countCategories(interactiveItems, textItems),
                items: [],
                marked: false,
                hint: `匹配到可交互元素 ${interactiveItems.length} 个，超过 limit=${limit} 或 max_items=${maxItems}，` +
                    '为避免返回过多内容已不返回 items。请用 filter/tag/keyword 缩小范围，或提高 limit/max_items。'
            };
        }

        const marked = opts.mark !== false;
        if (marked) drawMarkOverlay(interactiveItems);

        return {
            success: true,
            source: 'browser_observe',
            url: location.href,
            title: document.title,
            scroll: { x: window.scrollX, y: window.scrollY },
            itemCount: interactiveItems.length + textItems.length,
            count: interactiveItems.length,
            textCount: textItems.length,
            categoryCounts: countCategories(interactiveItems, textItems),
            items: interactiveItems.concat(textItems),
            marked,
            hint: '仅扫描主文档（不含跨域 iframe，也不识别 img/video/audio 媒体元素）；点击/输入请用 items 中 ' +
                'kind=interactive 条目的 id 作为 browser_action 的 ref 参数，id 在下一次 browser_observe 前有效。'
        };
    }

    // ── browser_action: click / double_click / right_click ──────────────────
    function dispatchClickSequence(el, center, opts = {}) {
        const button = opts.button === 'right' ? 2 : opts.button === 'middle' ? 1 : 0;
        const buttons = opts.button === 'right' ? 2 : opts.button === 'middle' ? 4 : 1;
        const base = { bubbles: true, cancelable: true, view: window, clientX: center.x, clientY: center.y, button };
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

    async function playFx(el, variant) {
        if (window.__hsFx && typeof window.__hsFx.clickEl === 'function') {
            try { await window.__hsFx.clickEl(el, variant); } catch (_error) { /* visual-only */ }
        }
    }

    async function clickLikeUser(msg = {}, variant = 'left') {
        const resolved = resolveTarget(msg);
        const el = resolved.el;
        if (!el) return { success: false, error: '未找到目标元素（ref/selector/text/坐标均未命中）', code: 'TARGET_NOT_FOUND' };

        const center = centerOf(el);
        if (!msg.force && !isHittable(el)) {
            let occluder = null;
            try { occluder = document.elementFromPoint(center.x, center.y); } catch (_error) { /* ignore */ }
            return {
                success: false,
                occluded: true,
                code: 'OCCLUDED',
                error: '目标元素当前被遮挡或不在可视区域内，可能需要滚动或先关闭遮挡层；确认要穿透点击请传 force:true',
                occluderTag: occluder ? String(occluder.tagName || '').toLowerCase() : ''
            };
        }

        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_error) { /* ignore */ }
        await playFx(el, variant === 'right' ? 'right' : variant === 'double' ? 'double' : 'left');

        if (variant === 'double') {
            dispatchClickSequence(el, center, {});
            dispatchClickSequence(el, center, {});
            el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, clientX: center.x, clientY: center.y }));
        } else if (variant === 'right') {
            dispatchClickSequence(el, center, { button: 'right' });
        } else {
            dispatchClickSequence(el, center, {});
        }

        return { success: true, tag: el.tagName.toLowerCase(), text: textOf(el), center };
    }

    // ── browser_action: type ─────────────────────────────────────────────────
    function setNativeValue(element, value) {
        const proto = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) {
            descriptor.set.call(element, value);
        } else {
            element.value = value;
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    }

    async function typeInto(msg = {}) {
        const resolved = resolveTarget(msg);
        const el = resolved.el;
        if (!el) return { success: false, error: '未找到目标输入元素', code: 'TARGET_NOT_FOUND' };

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
                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
                el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
            }
        }

        return { success: true, tag: el.tagName.toLowerCase(), submitted };
    }

    // ── browser_action: press_key ────────────────────────────────────────────
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
        const base = {
            key: info.key, code: info.code, keyCode: info.keyCode, which: info.keyCode,
            ctrlKey: !!msg.ctrl, shiftKey: !!msg.shift, altKey: !!msg.alt, metaKey: !!msg.meta,
            bubbles: true, cancelable: true
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

    // ── browser_action: scroll ────────────────────────────────────────────────
    async function scrollPage(msg = {}) {
        const amount = Number(msg.amount) || 400;
        const direction = String(msg.direction || 'down');
        await (async () => {
            if (window.__hsFx && typeof window.__hsFx.scrollDrag === 'function') {
                try { await window.__hsFx.scrollDrag(direction, amount); } catch (_error) { /* visual-only */ }
            }
        })();

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

        return {
            success: true,
            direction,
            amount,
            before,
            after,
            moved: Math.round(Math.hypot(after.x - before.x, after.y - before.y))
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
                if (el && isVisible(el)) return { success: true, selector };
                await sleep(150);
            }
            return { success: false, error: `等待元素超时: ${selector}`, selector };
        }
        const waitMs = Number.isFinite(ms) && ms > 0 ? ms : 1000;
        await sleep(waitMs);
        return { success: true, waitedMs: waitMs };
    }

    // ── browser_drag ──────────────────────────────────────────────────────────
    async function dragLikeUser(msg = {}) {
        const src = resolveTarget({ selector: msg.selector, text: msg.text, x: msg.x, y: msg.y });
        if (!src.el && !(msg.x !== undefined && msg.y !== undefined)) {
            return { success: false, error: '未找到拖拽源元素', code: 'SOURCE_NOT_FOUND' };
        }
        const dst = resolveTarget({ selector: msg.to_selector, text: msg.to_text, x: msg.to_x, y: msg.to_y });
        if (!dst.el && !(msg.to_x !== undefined && msg.to_y !== undefined)) {
            return { success: false, error: '未找到拖拽目标元素', code: 'TARGET_NOT_FOUND' };
        }

        const srcEl = src.el;
        const startRect = srcEl ? srcEl.getBoundingClientRect() : null;
        const from = { x: src.x, y: src.y };
        const to = { x: dst.x, y: dst.y };
        let dataTransfer = null;
        try { dataTransfer = new DataTransfer(); } catch (_error) { /* unsupported in this context */ }

        const dispatchMouseAt = (el, type, point, extra = {}) => {
            if (!el) return;
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: point.x, clientY: point.y, ...extra }));
        };
        const dispatchPointerAt = (el, type, point) => {
            if (!el) return;
            el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window, clientX: point.x, clientY: point.y, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        };
        const dispatchDragAt = (el, type, point) => {
            if (!el || !dataTransfer) return;
            try {
                el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, view: window, clientX: point.x, clientY: point.y, dataTransfer }));
            } catch (_error) { /* DragEvent construction can fail on some pages */ }
        };

        dispatchPointerAt(srcEl, 'pointerdown', from);
        dispatchMouseAt(srcEl, 'mousedown', from, { buttons: 1 });
        dispatchDragAt(srcEl, 'dragstart', from);

        const steps = 8;
        for (let i = 1; i <= steps; i += 1) {
            const point = { x: from.x + (to.x - from.x) * (i / steps), y: from.y + (to.y - from.y) * (i / steps) };
            dispatchPointerAt(srcEl, 'pointermove', point);
            dispatchMouseAt(srcEl, 'mousemove', point, { buttons: 1 });
            let overEl = null;
            try { overEl = document.elementFromPoint(point.x, point.y); } catch (_error) { /* ignore */ }
            dispatchDragAt(overEl || dst.el, 'dragenter', point);
            dispatchDragAt(overEl || dst.el, 'dragover', point);
            await sleep(16);
        }

        let dstEl = dst.el;
        if (!dstEl) { try { dstEl = document.elementFromPoint(to.x, to.y); } catch (_error) { /* ignore */ } }
        dispatchDragAt(dstEl, 'drop', to);
        dispatchDragAt(srcEl, 'dragend', to);
        dispatchPointerAt(srcEl, 'pointerup', to);
        dispatchMouseAt(dstEl || srcEl, 'mouseup', to, { buttons: 0 });

        const endRect = srcEl ? srcEl.getBoundingClientRect() : null;
        const moved = !!(startRect && endRect) && (Math.abs(startRect.left - endRect.left) > 2 || Math.abs(startRect.top - endRect.top) > 2);

        return {
            success: true,
            from,
            to,
            moved,
            note: '合成事件拖拽：已派发 pointer/mouse 与 HTML5 dragstart/dragover/drop 序列；依赖操作系统级拖拽' +
                '（如原生文件拖拽）的页面可能无法响应。'
        };
    }

    window.__hsObserve = {
        __installed: true,
        scan,
        click: clickLikeUser,
        type: typeInto,
        pressKey,
        scroll: scrollPage,
        wait: waitFor,
        drag: dragLikeUser
    };
})();
