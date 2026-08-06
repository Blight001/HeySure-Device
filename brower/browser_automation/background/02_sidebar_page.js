async function injectCardEditorSidebar(tabId, width = 820, options = {}) {
    const sidebarUrl = chrome.runtime.getURL('popup.html?layout=sidebar');
    const forceClose = !!options.forceClose;
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        args: [sidebarUrl, width, forceClose],
        func: async (iframeUrl, panelWidth, forceClose) => {
            const rootId = '__automation_card_sidebar_root__';
            const existing = document.getElementById(rootId);
            if (existing || forceClose) {
                if (existing) existing.remove();
                return { success: true, closed: true };
            }

            const host = document.createElement('div');
            host.id = rootId;
            host.style.position = 'fixed';
            host.style.top = '0';
            host.style.right = '0';
            host.style.width = `${Math.max(520, Number(panelWidth) || 820)}px`;
            host.style.height = '100vh';
            host.style.zIndex = '2147483647';
            host.style.pointerEvents = 'none';

            const shadow = host.attachShadow({ mode: 'open' });
            shadow.innerHTML = `
                <style>
                    :host {
                        all: initial;
                    }
                    .panel {
                        position: absolute;
                        inset: 0;
                        display: flex;
                        flex-direction: column;
                        background: rgba(243, 246, 252, 0.98);
                        border-left: 1px solid rgba(148, 163, 184, 0.34);
                        pointer-events: auto;
                    }
                    .frame {
                        width: 100%;
                        height: 100vh;
                        border: 0;
                        display: block;
                        background: transparent;
                    }
                    .resize {
                        position: absolute;
                        left: -6px;
                        top: 0;
                        width: 10px;
                        height: 100%;
                        cursor: ew-resize;
                        background: linear-gradient(90deg, transparent, rgba(148,163,184,0.08), transparent);
                    }
                </style>
                <div class="panel">
                    <div class="resize" title="拖动调整宽度"></div>
                    <iframe class="frame" src="${iframeUrl}" allow="clipboard-read; clipboard-write"></iframe>
                </div>
            `;

            const resizeHandle = shadow.querySelector('.resize');
            let startX = 0;
            let startWidth = 0;

            const notifySidebarState = async (payloadState = {}) => {
                try {
                    await chrome.runtime.sendMessage({
                        type: 'card-sidebar-state-update',
                        payload: {
                            open: payloadState.open === true,
                            width: Math.max(520, Number(payloadState.width || host.getBoundingClientRect().width) || 820)
                        }
                    });
                } catch (_error) {
                }
            };

            const closePanel = () => {
                void notifySidebarState({ open: false, width: host.getBoundingClientRect().width });
                host.remove();
            };

            // Allow the inner iframe (sidebar editor) to request close
            window.addEventListener('message', (ev) => {
                if (ev && ev.data && ev.data.type === 'close-card-sidebar') {
                    closePanel();
                }
            });

            resizeHandle?.addEventListener('mousedown', (event) => {
                event.preventDefault();
                startX = event.clientX;
                startWidth = host.getBoundingClientRect().width;
                const onMove = (moveEvent) => {
                    const delta = startX - moveEvent.clientX;
                    const nextWidth = Math.max(520, Math.min(window.innerWidth - 280, startWidth + delta));
                    host.style.width = `${nextWidth}px`;
                };
                const onUp = () => {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    void notifySidebarState({ open: true, width: host.getBoundingClientRect().width });
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            });

            document.body.appendChild(host);
            void notifySidebarState({ open: true, width: host.getBoundingClientRect().width });
            return { success: true, opened: true, width: host.getBoundingClientRect().width };
        }
    });

    const result = Array.isArray(results) ? results[0] : null;
    return result && result.result ? result.result : result;
}

async function openCardEditorSidebar(payload = {}) {
    const tab = await getActiveTab();
    if (!tab || !Number.isFinite(Number(tab.id || 0))) {
        throw new Error('未找到可用的当前标签页');
    }

    const tabId = Number(tab.id);
    const width = Math.max(520, Number(payload.width || 820));
    const forceClose = !!payload.forceClose;
    const result = await injectCardEditorSidebar(tabId, width, { forceClose });
    if (result?.opened === true) {
        await saveCardSidebarState({ tabId, width, open: true });
    } else if (result?.closed === true) {
        await saveCardSidebarState({ tabId, width, open: false });
    }
    return result;
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 0);

    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    if (currentTab && currentTab.status === 'complete') {
        return currentTab;
    }

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(onUpdated);
            reject(new Error('页面加载超时'));
        }, Math.max(1000, deadline - Date.now()));

        const onUpdated = (updatedTabId, changeInfo, tab) => {
            if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
                return;
            }

            clearTimeout(timer);
            chrome.tabs.onUpdated.removeListener(onUpdated);
            resolve(tab);
        };

        chrome.tabs.onUpdated.addListener(onUpdated);
    });
}

async function executePageAction(tabId, action) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        args: [action],
        func: async (payload) => {
            const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
            const normalize = (value = '') => String(value || '').trim();

            const isVisible = (element) => {
                if (!element) {
                    return false;
                }

                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
            };

            const resolveText = (value = '') => normalize(value);

            // 卡片步骤与 MCP browser_action 使用相同的默认深层定位：自动扫描
            // 当前文档和任意层级开放的 ShadowRoot，不要求卡片声明特殊模式。
            const enumerateOpenRoots = (root = document) => {
                const roots = [];
                const queue = [root];
                const seen = new Set();
                while (queue.length) {
                    const current = queue.shift();
                    if (!current || seen.has(current)) continue;
                    seen.add(current);
                    roots.push(current);
                    const enqueue = (element) => {
                        if (element?.shadowRoot && !seen.has(element.shadowRoot)) queue.push(element.shadowRoot);
                    };
                    if (current.nodeType === Node.ELEMENT_NODE) enqueue(current);
                    const ownerDoc = current.nodeType === Node.DOCUMENT_NODE ? current : (current.ownerDocument || document);
                    const walker = ownerDoc.createTreeWalker(current, NodeFilter.SHOW_ELEMENT);
                    while (walker.nextNode()) enqueue(walker.currentNode);
                }
                return roots;
            };

            const queryAllDeep = (root, selector) => enumerateOpenRoots(root)
                .flatMap((scanRoot) => Array.from(scanRoot.querySelectorAll(selector)));

            const parseHasText = (selector = '') => {
                const match = selector.match(/^(.*?):has-text\((['"])(.*?)\2\)\s*$/i);
                if (!match) {
                    return null;
                }

                return {
                    css: normalize(match[1]),
                    text: match[3]
                };
            };

            const parseAttributeSelector = (selector = '') => {
                const normalized = normalize(selector);
                const attrMatch = normalized.match(/^(id|class|name|placeholder|aria-label|aria)=(.*)$/i);
                if (!attrMatch) {
                    return null;
                }

                return {
                    attr: attrMatch[1].toLowerCase(),
                    value: normalize(attrMatch[2])
                };
            };

            const getCandidates = (selector = '') => {
                const normalized = normalize(selector);
                if (!normalized) {
                    return [];
                }

                if (normalized.includes('>>')) {
                    const parts = normalized.split('>>').map((part) => normalize(part)).filter(Boolean);
                    if (parts.length > 0) {
                        return [parts[parts.length - 1]];
                    }
                }

                if (/^text=/i.test(normalized) || /^text:/i.test(normalized)) {
                    return [{ kind: 'text', value: normalized.replace(/^text[:=]/i, '') }];
                }

                if (/^(id|class|name|placeholder|aria-label|aria)=/i.test(normalized)) {
                    const attr = parseAttributeSelector(normalized);
                    if (attr) {
                        return [{ kind: 'attr', ...attr }];
                    }
                }

                const hasText = parseHasText(normalized);
                if (hasText) {
                    return [{ kind: 'hasText', css: hasText.css, text: hasText.text }];
                }

                if (/^[.#\[]/.test(normalized) || normalized.includes(' ') || normalized.includes('>') || normalized.includes(':')) {
                    return [{ kind: 'css', value: normalized }];
                }

                return [
                    { kind: 'css', value: normalized },
                    { kind: 'text', value: normalized }
                ];
            };

            const collectDocumentText = (root = document, visited = new Set(), depth = 0) => {
                if (!root || visited.has(root) || depth > 6) {
                    return '';
                }

                visited.add(root);

                const parts = [];
                const pushPart = (value = '') => {
                    const text = normalize(value);
                    if (text) {
                        parts.push(text);
                    }
                };

                try {
                    const body = root.body || root.documentElement || null;
                    if (body) {
                        pushPart(body.innerText || body.textContent || '');
                    }
                } catch (_error) {
                }

                try {
                    const frames = root.querySelectorAll ? queryAllDeep(root, 'iframe') : [];
                    frames.forEach((frame) => {
                        try {
                            const frameDocument = frame.contentDocument || frame.contentWindow?.document || null;
                            if (frameDocument) {
                                const frameText = collectDocumentText(frameDocument, visited, depth + 1);
                                pushPart(frameText);
                            }
                        } catch (_frameError) {
                        }
                    });
                } catch (_error) {
                }

                return parts.join('\n');
            };

            const queryElements = (selector = '') => {
                const candidates = getCandidates(selector);
                const matched = [];
                const pushUnique = (element) => {
                    if (element && !matched.includes(element)) {
                        matched.push(element);
                    }
                };

                for (const candidate of candidates) {
                    try {
                        if (candidate.kind === 'css') {
                            queryAllDeep(document, candidate.value).forEach(pushUnique);
                            continue;
                        }

                        if (candidate.kind === 'text') {
                            const needle = resolveText(candidate.value).toLowerCase();
                            if (!needle) {
                                continue;
                            }

                            queryAllDeep(document, 'button, a, input, textarea, select, label, span, div, li, p, option, [role="button"], [contenteditable="true"]').forEach((element) => {
                                const text = `${element.innerText || element.textContent || element.value || ''}`.trim().toLowerCase();
                                const placeholder = `${element.getAttribute('placeholder') || ''}`.trim().toLowerCase();
                                const ariaLabel = `${element.getAttribute('aria-label') || ''}`.trim().toLowerCase();
                                if (text.includes(needle) || placeholder.includes(needle) || ariaLabel.includes(needle)) {
                                    pushUnique(element);
                                }
                            });
                            continue;
                        }

                        if (candidate.kind === 'attr') {
                            const attr = candidate.attr;
                            const needle = resolveText(candidate.value).toLowerCase();
                            queryAllDeep(document, 'input, textarea, button, select, [role="button"], [contenteditable="true"], *').forEach((element) => {
                                const value = `${element.getAttribute(attr) || ''}`.trim().toLowerCase();
                                if (value.includes(needle)) {
                                    pushUnique(element);
                                }
                            });
                            continue;
                        }

                        if (candidate.kind === 'hasText') {
                            const css = candidate.css || '*';
                            const needle = resolveText(candidate.text).toLowerCase();
                            queryAllDeep(document, css).forEach((element) => {
                                const text = `${element.innerText || element.textContent || ''}`.trim().toLowerCase();
                                if (text.includes(needle)) {
                                    pushUnique(element);
                                }
                            });
                        }
                    } catch (_error) {
                    }
                }

                return matched;
            };

            const pickElement = (selector = '', nth = 0) => {
                const elements = queryElements(selector).filter(isVisible);
                if (elements.length === 0) {
                    return null;
                }

                const index = Number.isFinite(Number(nth)) && Number(nth) >= 0 ? Number(nth) : 0;
                return elements[Math.min(index, elements.length - 1)] || null;
            };

            const waitForElement = async (selector, timeoutMs = 5000, intervalMs = 200, shouldBeVisible = true) => {
                const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
                while (Date.now() <= deadline) {
                    const element = pickElement(selector, payload.nth || 0);
                    if (shouldBeVisible) {
                        if (element) {
                            return element;
                        }
                    } else if (!element) {
                        return true;
                    }
                    await sleep(intervalMs);
                }

                return null;
            };

            const setNativeValue = (element, value) => {
                const tag = String(element && element.tagName || '').toLowerCase();
                let proto = null;
                if (tag === 'textarea') {
                    proto = HTMLTextAreaElement.prototype;
                } else if (tag === 'input') {
                    proto = HTMLInputElement.prototype;
                }
                if (proto) {
                    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
                    if (descriptor && descriptor.set) {
                        descriptor.set.call(element, value);
                    } else {
                        element.value = value;
                    }
                } else {
                    // Fallback (e.g. contenteditable handled separately)
                    if ('value' in element) element.value = value;
                }
                element.dispatchEvent(new Event('input', { bubbles: true }));
                element.dispatchEvent(new Event('change', { bubbles: true }));
                try {
                    // Modern InputEvent helps some frameworks
                    element.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value || '') }));
                } catch (_) {}
            };

            const isTypeableElement = (el) => {
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
            };

            const actionType = normalize(payload.type || '');
            const selector = normalize(payload.selector || '');
            const timeoutMs = Number.isFinite(Number(payload.timeoutMs)) ? Number(payload.timeoutMs) : 5000;
            const intervalMs = Number.isFinite(Number(payload.intervalMs)) ? Number(payload.intervalMs) : 200;
            const text = normalize(payload.text || '');
            const waitForText = normalize(payload.waitForText || '');
            const waitForElementHidden = normalize(payload.waitForElementHidden || '');
            const waitForTextHidden = normalize(payload.waitForTextHidden || '');

            if (actionType === 'click') {
                const element = await waitForElement(selector, timeoutMs, intervalMs, true);
                if (!element) {
                    return { success: false, error: `未找到可点击元素: ${selector}`, code: 'ELEMENT_NOT_FOUND' };
                }

                try {
                    element.scrollIntoView({ block: 'center', inline: 'center' });
                } catch (_error) {
                }

                // Hover + focus before click for consistency with MCP browser_action
                try { element.focus?.(); } catch (_error) {}
                try {
                    if (window.__hsFx && typeof window.__hsFx.clickEl === 'function') {
                        await window.__hsFx.clickEl(element, 'left');
                    }
                } catch (_error) {
                }

                try {
                    const base = { bubbles: true, cancelable: true, view: window };
                    element.dispatchEvent(new MouseEvent('mouseover', base));
                    element.dispatchEvent(new MouseEvent('mouseenter', base));
                    element.dispatchEvent(new MouseEvent('mousedown', base));
                    element.dispatchEvent(new MouseEvent('mouseup', base));
                } catch (_error) {
                }

                try {
                    element.click();
                } catch (_error) {
                    return { success: false, error: `点击失败: ${selector}`, code: 'CLICK_FAILED' };
                }

                return { success: true };
            }

            if (actionType === 'type') {
                const element = await waitForElement(selector, timeoutMs, intervalMs, true);
                if (!element) {
                    return { success: false, error: `未找到可输入元素: ${selector}`, code: 'ELEMENT_NOT_FOUND' };
                }

                // P0 fix: pre-validate element type to fail fast with actionable error (no retry on failure)
                if (!isTypeableElement(element)) {
                    const tag = String(element.tagName || '').toLowerCase();
                    const role = String(element.getAttribute && element.getAttribute('role') || '').toLowerCase();
                    return {
                        success: false,
                        error: `元素类型不支持 type 输入（tag=<${tag}> role="${role || 'none'}"），Card Runner 的 type 仅支持 <input type=text/search/email 等>、<textarea>、contenteditable 元素、role=textbox/searchbox。建议：更换 selector 到实际输入框，或改用 external_script 降级。`,
                        code: 'UNSUPPORTED_ELEMENT_TYPE'
                    };
                }

                try {
                    element.scrollIntoView({ block: 'center', inline: 'center' });
                } catch (_error) {
                }

                try {
                    element.focus();
                } catch (_error) {
                }

                try {
                    if (window.__hsFx && typeof window.__hsFx.typeEl === 'function') {
                        await window.__hsFx.typeEl(element);
                    }
                } catch (_error) {
                }

                if (payload.clickBeforeType === true) {
                    try {
                        element.focus?.();
                        const b = { bubbles: true, cancelable: true, view: window };
                        element.dispatchEvent(new MouseEvent('mouseover', b));
                        element.dispatchEvent(new MouseEvent('mouseenter', b));
                        element.click();
                    } catch (_error) {
                    }
                }

                const shouldClear = payload.clearFirst === true;
                if (shouldClear) {
                    setNativeValue(element, '');
                }

                if (element.isContentEditable) {
                    element.innerText = text;
                    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
                } else {
                    setNativeValue(element, text);
                }

                return { success: true };
            }

            if (actionType === 'wait') {
                if (selector) {
                    const hidden = payload.hidden === true;
                    const result = await waitForElement(selector, timeoutMs, intervalMs, !hidden);
                    if (hidden) {
                        return { success: true };
                    }
                    if (!result) {
                        return { success: false, error: `等待元素超时: ${selector}`, code: 'WAIT_TIMEOUT' };
                    }
                    return { success: true };
                }

                if (waitForText) {
                    const deadline = Date.now() + Math.max(0, timeoutMs);
                    while (Date.now() <= deadline) {
                        const visible = queryElements(`text=${waitForText}`).some(isVisible);
                        if (visible) {
                            return { success: true };
                        }
                        await sleep(intervalMs);
                    }
                    return { success: false, error: `等待文本超时: ${waitForText}`, code: 'WAIT_TIMEOUT' };
                }

                if (waitForElementHidden) {
                    const deadline = Date.now() + Math.max(0, timeoutMs);
                    while (Date.now() <= deadline) {
                        const visible = queryElements(waitForElementHidden).some(isVisible);
                        if (!visible) {
                            return { success: true };
                        }
                        await sleep(intervalMs);
                    }
                    return { success: false, error: `等待元素消失超时: ${waitForElementHidden}`, code: 'WAIT_TIMEOUT' };
                }

                if (waitForTextHidden) {
                    const deadline = Date.now() + Math.max(0, timeoutMs);
                    while (Date.now() <= deadline) {
                        const visible = queryElements(`text=${waitForTextHidden}`).some(isVisible);
                        if (!visible) {
                            return { success: true };
                        }
                        await sleep(intervalMs);
                    }
                    return { success: false, error: `等待文本消失超时: ${waitForTextHidden}`, code: 'WAIT_TIMEOUT' };
                }

                await sleep(timeoutMs);
                return { success: true };
            }

            if (actionType === 'get_credits') {
                const element = selector ? pickElement(selector, payload.nth || 0) : null;
                let value = '';
                if (element) {
                    const tagName = String(element?.tagName || '').toLowerCase();
                    if (tagName === 'iframe') {
                        try {
                            const frameDocument = element.contentDocument || element.contentWindow?.document || null;
                            value = collectDocumentText(frameDocument || null);
                        } catch (_frameError) {
                            value = '';
                        }
                    }

                    if (!value) {
                        value = `${element.innerText || element.textContent || element.value || ''}`.trim();
                        if (!value && (tagName === 'body' || tagName === 'html' || selector === '*' || selector === 'document')) {
                            value = collectDocumentText(document);
                        }
                    }
                }

                if (!value && (!selector || selector === 'body' || selector === 'html')) {
                    value = collectDocumentText(document);
                }

                return {
                    success: true,
                    value: value || String(payload.defaultValue || payload.default || '0').trim() || '0'
                };
            }

            if (actionType === 'external_script') {
                const script = String(payload.script || '').trim();
                if (!script) {
                    return { success: true };
                }

                try {
                    const result = await (new Function(`return (async () => { ${script} })();`))();
                    return { success: true, result };
                } catch (error) {
                    return { success: false, error: error && error.message ? error.message : '脚本执行失败', code: 'SCRIPT_ERROR' };
                }
            }

            if (actionType === 'read_state') {
                return {
                    success: true,
                    url: String(location.href || ''),
                    title: String(document.title || '')
                };
            }

            return { success: false, error: `不支持的动作: ${actionType}`, code: 'UNSUPPORTED_ACTION' };
        }
    });

    const result = Array.isArray(results) ? results[0] : null;
    return result && result.result ? result.result : result;
}

async function collectTabCookieSnapshot(tabId) {
    const currentTab = await chrome.tabs.get(tabId).catch(() => null);
    const pageSnapshot = await readPageSnapshot(tabId).catch(() => null);
    const pageUrl = currentTab?.url || pageSnapshot?.url || '';
    const pageTitle = currentTab?.title || pageSnapshot?.title || '';
    const cookies = await readCookies(pageUrl);
    const localStorageData = pageSnapshot?.localStorage && typeof pageSnapshot.localStorage === 'object' ? pageSnapshot.localStorage : {};
    const sessionStorageData = pageSnapshot?.sessionStorage && typeof pageSnapshot.sessionStorage === 'object' ? pageSnapshot.sessionStorage : {};
    const browserStorage = [];

    if (Object.keys(localStorageData).length > 0 || Object.keys(sessionStorageData).length > 0) {
        browserStorage.push({
            url: pageSnapshot?.url || pageUrl || '',
            origin: pageSnapshot?.origin || '',
            localStorage: localStorageData,
            sessionStorage: sessionStorageData
        });
    }

    return {
        pageUrl,
        pageTitle,
        cookies,
        browserStorage
    };
}

async function clickTempEmailDetailBySelector(tabId, rowSelector = '') {
    const selector = String(rowSelector || '').trim();
    if (!selector) {
        return {
            success: false,
            error: '未配置验证码邮件点击选择器'
        };
    }

    const directClickResult = await executePageAction(tabId, {
        type: 'click',
        selector,
        timeoutMs: 5000,
        intervalMs: 250
    }).catch(() => null);

    if (directClickResult && directClickResult.success === true) {
        return directClickResult;
    }

    const result = await executePageAction(tabId, {
        type: 'external_script',
        script: `
            const selector = ${JSON.stringify(selector)};
            const isVisible = (element) => {
                if (!element) {
                    return false;
                }
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
            };
            const clickElement = (element) => {
                if (!element) {
                    return false;
                }
                try {
                    element.scrollIntoView({ block: 'center', inline: 'center' });
                } catch (_error) {
                }
                // Hover + focus for all injected clicks
                try { element.focus?.(); } catch (_error) {}
                try {
                    const b = { bubbles: true, cancelable: true, view: window };
                    element.dispatchEvent(new MouseEvent('mouseover', b));
                    element.dispatchEvent(new MouseEvent('mouseenter', b));
                    element.dispatchEvent(new MouseEvent('mousedown', b));
                    element.dispatchEvent(new MouseEvent('mouseup', b));
                    element.dispatchEvent(new MouseEvent('click', b));
                } catch (_error) {
                }
                try {
                    element.click();
                    return true;
                } catch (_error) {
                }
                return false;
            };
            const pickCandidates = (root) => {
                if (!root) {
                    return [];
                }
                const candidates = [root];
                try {
                    candidates.push(...Array.from(root.querySelectorAll('button, a, [role="button"], [onclick], [tabindex]:not([tabindex="-1"]), input[type="button"], input[type="submit"]')));
                } catch (_error) {
                }
                return candidates.filter((item, index, array) => item && array.indexOf(item) === index && isVisible(item));
            };
            const rows = Array.from(document.querySelectorAll(selector)).filter(isVisible);
            for (const row of rows) {
                const candidates = pickCandidates(row);
                for (const candidate of candidates) {
                    if (clickElement(candidate)) {
                        return {
                            success: true,
                            clicked: true
                        };
                    }
                }
            }
            return {
                success: false,
                error: '未找到可点击的验证码邮件'
            };
        `
    }).catch(() => null);

    if (result && result.success === true) {
        return result;
    }

    return result || {
        success: false,
        error: '未找到可点击的验证码邮件'
    };
}

const clickInboxRowsByCurrentTime = clickTempEmailDetailBySelector;

