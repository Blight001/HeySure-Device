const shared = globalThis.CookieCaptureShared || {};
const { sanitizeFilePart, buildPresetFileName, copyTextToClipboard, setStatus, showActionToast, escapeHtml } = shared;

const ACCOUNT_KEY = shared.STORAGE_KEYS.ACCOUNT_KEY;
const PASSWORD_KEY = shared.STORAGE_KEYS.PASSWORD_KEY;
const COOKIE_NOTE_KEY = shared.STORAGE_KEYS.COOKIE_NOTE_KEY;
const COOKIE_CARD_KEY = shared.STORAGE_KEYS.COOKIE_CARD_KEY;
const COOKIE_CREDENTIAL_CACHE_LIST_KEY = shared.STORAGE_KEYS.COOKIE_CREDENTIAL_CACHE_LIST_KEY;
const COOKIE_CREDENTIAL_SELECTED_DATE_KEY = shared.STORAGE_KEYS.COOKIE_CREDENTIAL_SELECTED_DATE_KEY;
const COOKIE_CREDENTIAL_SEARCH_KEY = shared.STORAGE_KEYS.COOKIE_CREDENTIAL_SEARCH_KEY;
const COOKIE_CREDENTIAL_CACHE_MAX_ITEMS = 50;

const accountInput = document.getElementById('account');
const passwordInput = document.getElementById('password');
const cookieNoteInput = document.getElementById('cookie-note');
const cookieCardKeyInput = document.getElementById('cookie-card-key');
const cookieCredentialEditPanelNode = document.getElementById('cookie-credential-edit-panel');
const cookieCredentialEditPanelSubtitleNode = document.getElementById('cookie-credential-edit-panel-subtitle');
const editCookieAccountInput = document.getElementById('edit-account');
const editCookiePasswordInput = document.getElementById('edit-password');
const editCookieNoteInput = document.getElementById('edit-note');
const editCookieCardKeyInput = document.getElementById('edit-card-key');
const cookieCredentialDateFilterNode = document.getElementById('cookie-credential-date-filter');
const cookieCredentialSearchNode = document.getElementById('cookie-credential-search');
const cookieCredentialCountNode = document.getElementById('cookie-credential-count');
const cookieCredentialListNode = document.getElementById('cookie-credential-list');
const captureButton = document.getElementById('capture');
const clearCurrentPageCacheButton = document.getElementById('clear-current-page-cache');
const cookieManagerPanelNode = document.getElementById('cookie-manager-panel');
const cookieManagerSubtitleNode = document.getElementById('cookie-manager-subtitle');
const cookieManagerCountNode = document.getElementById('cookie-manager-count');
const cookieManagerListNode = document.getElementById('cookie-manager-list');

let editingCookieCredentialId = '';
let cookieCredentialSelectedDate = '';
let cookieCredentialSearchQuery = '';

function formatCookieCredentialTime(value = '') {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }

    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
        return text;
    }

    return date.toLocaleString('zh-CN', { hour12: false });
}

function padCookieCredentialDatePart(value = 0) {
    return String(value || 0).padStart(2, '0');
}

function getTodayCookieCredentialDateKey(date = new Date()) {
    const safeDate = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    return [
        safeDate.getFullYear(),
        padCookieCredentialDatePart(safeDate.getMonth() + 1),
        padCookieCredentialDatePart(safeDate.getDate())
    ].join('-');
}

function getCookieCredentialDateKey(value = '') {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }

    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    return getTodayCookieCredentialDateKey(date);
}

function getCookieCredentialDateFromKey(dateKey = '') {
    const text = String(dateKey || '').trim();
    if (!text || text === 'all') {
        return null;
    }

    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
        return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
        return null;
    }

    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : date;
}

function getCookieCredentialYesterdayKey() {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return getTodayCookieCredentialDateKey(date);
}

function formatCookieCredentialDateLabel(dateKey = '') {
    const normalized = String(dateKey || '').trim();
    if (!normalized || normalized === 'all') {
        return '全部日期';
    }

    const date = getCookieCredentialDateFromKey(normalized);
    if (!date) {
        return normalized;
    }

    const todayKey = getTodayCookieCredentialDateKey();
    const yesterdayKey = getCookieCredentialYesterdayKey();
    if (normalized === todayKey) {
        return `今天 · ${normalized}`;
    }
    if (normalized === yesterdayKey) {
        return `昨天 · ${normalized}`;
    }

    const weekdayNames = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    return `${normalized} ${weekdayNames[date.getDay()] || ''}`.trim();
}

function formatCookieCredentialTimeLabel(value = '') {
    const text = String(value || '').trim();
    if (!text) {
        return '';
    }

    const date = new Date(text);
    if (Number.isNaN(date.getTime())) {
        return text;
    }

    return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function buildCookieCredentialSearchText(item = {}) {
    const parts = [
        String(item.account || '').trim(),
        String(item.password || '').trim(),
        String(item.note || '').trim(),
        String(item.cardKey || '').trim(),
        String(item.savedAt || '').trim(),
        formatCookieCredentialDateLabel(String(item.dateKey || '').trim()),
        formatCookieCredentialTimeLabel(item.savedAt)
    ].filter(Boolean);
    return parts.join(' ').toLowerCase();
}

function normalizeCookieCredentialSearchQuery(value = '') {
    return String(value || '').trim();
}

function cookieCredentialItemMatchesQuery(item = {}, query = '') {
    const normalizedQuery = normalizeCookieCredentialSearchQuery(query).toLowerCase();
    if (!normalizedQuery) {
        return true;
    }

    const keywords = normalizedQuery.split(/\s+/).filter(Boolean);
    if (keywords.length === 0) {
        return true;
    }

    const searchText = buildCookieCredentialSearchText(item);
    return keywords.every((keyword) => searchText.includes(keyword));
}

function buildCookieCredentialCacheId(record = {}) {
    const baseName = sanitizeFilePart(String(record.note || record.cardKey || record.account || 'cookie-record'));
    const timePart = new Date().toISOString().replace(/[:.]/g, '-');
    const randomPart = Math.random().toString(36).slice(2, 8);
    return `${baseName || 'cookie-record'}_${timePart}_${randomPart}`;
}

function normalizeCookieCredentialCacheEntry(entry = {}, index = 0) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const savedAt = String(source.savedAt || source.createdAt || new Date().toISOString()).trim();
    const dateKey = String(source.dateKey || getCookieCredentialDateKey(savedAt) || '').trim() || getTodayCookieCredentialDateKey();
    return {
        id: String(source.id || source.cacheId || '').trim() || buildCookieCredentialCacheId(source),
        account: String(source.account || source.username || '').trim(),
        password: String(source.password || '').trim(),
        note: String(source.note || source.remark || '').trim(),
        cardKey: String(source.cardKey || source.card_key || source.key || '').trim(),
        savedAt,
        dateKey,
        selected: source.selected === true,
        index
    };
}

function buildCookieCredentialListLabel(item = {}) {
    const noteText = String(item.note || '').trim() || '未备注';
    const accountText = String(item.account || '').trim() || '未填写QQ号';
    const cardKeyText = String(item.cardKey || '').trim() || '未填写卡密';

    return {
        title: noteText,
        meta: `QQ号：${accountText}\n卡密：${cardKeyText}`
    };
}

function buildCookieCredentialClipboardText(item = {}) {
    const savedAtText = formatCookieCredentialTimeLabel(item.savedAt) || '';
    const savedDateLabel = formatCookieCredentialDateLabel(item.dateKey || getCookieCredentialDateKey(item.savedAt));
    const lines = [
        `日期：${savedDateLabel || '未记录'}`,
        `时间：${savedAtText || '未记录'}`,
        `备注：${String(item.note || '').trim() || '未填写'}`,
        `卡密：${String(item.cardKey || '').trim() || '未填写'}`,
        `账号：${String(item.account || '').trim() || '未填写'}`,
        `密码：${String(item.password || '').trim() || '未填写'}`
    ];
    return lines.join('\n');
}

function buildCookieCredentialAccountPasswordText(item = {}) {
    return [
        String(item.account || '').trim() || '未填写',
        String(item.password || '').trim() || '未填写'
    ].join('   ');
}

function buildCookieCredentialGroupAccountPasswordText(items = []) {
    const lines = Array.isArray(items)
        ? items.map((item) => buildCookieCredentialAccountPasswordText(item)).filter(Boolean)
        : [];
    return lines.join('\n');
}

function focusCookieCredentialEditPanel() {
    if (!cookieCredentialEditPanelNode || !cookieCredentialEditPanelNode.classList.contains('is-visible')) {
        return;
    }

    window.requestAnimationFrame(() => {
        const target = editCookieAccountInput || cookieCredentialEditPanelNode;
        if (target && typeof target.focus === 'function') {
            target.focus();
        }
        if (editCookieAccountInput && typeof editCookieAccountInput.select === 'function' && String(editCookieAccountInput.value || '').trim()) {
            editCookieAccountInput.select();
        }
    });
}

async function closeCookieCredentialEditPanel(message = '') {
    clearCookieCredentialEditTarget();
    await refreshCookieCredentialCacheUi().catch(() => {});
    if (message) {
        showActionToast(message, 'info');
    }
}

function syncCookieCredentialEditUi() {
    const isEditing = Boolean(editingCookieCredentialId);
    if (cookieCredentialEditPanelNode) {
        cookieCredentialEditPanelNode.classList.toggle('is-visible', isEditing);
    }
    if (cookieCredentialEditPanelSubtitleNode) {
        cookieCredentialEditPanelSubtitleNode.textContent = isEditing
            ? '正在编辑已保存记录，修改内容后点击保存修改'
            : '请选择一条记录开始编辑';
    }
    if (isEditing) {
        focusCookieCredentialEditPanel();
    }
}

function setCookieCredentialEditTarget(item = null) {
    if (!item) {
        editingCookieCredentialId = '';
        if (editCookieAccountInput) editCookieAccountInput.value = '';
        if (editCookiePasswordInput) editCookiePasswordInput.value = '';
        if (editCookieNoteInput) editCookieNoteInput.value = '';
        if (editCookieCardKeyInput) editCookieCardKeyInput.value = '';
        syncCookieCredentialEditUi();
        return;
    }

    editingCookieCredentialId = String(item.id || '').trim();
    if (editCookieAccountInput) editCookieAccountInput.value = String(item.account || '').trim();
    if (editCookiePasswordInput) editCookiePasswordInput.value = String(item.password || '').trim();
    if (editCookieNoteInput) editCookieNoteInput.value = String(item.note || '').trim();
    if (editCookieCardKeyInput) editCookieCardKeyInput.value = String(item.cardKey || '').trim();
    syncCookieCredentialEditUi();
}

function clearCookieCredentialEditTarget() {
    if (!editingCookieCredentialId) {
        return;
    }
    editingCookieCredentialId = '';
    if (editCookieAccountInput) editCookieAccountInput.value = '';
    if (editCookiePasswordInput) editCookiePasswordInput.value = '';
    if (editCookieNoteInput) editCookieNoteInput.value = '';
    if (editCookieCardKeyInput) editCookieCardKeyInput.value = '';
    syncCookieCredentialEditUi();
}

async function loadCookieCredentialCacheState() {
    const stored = await chrome.storage.local.get([COOKIE_CREDENTIAL_CACHE_LIST_KEY]).catch(() => ({}));
    const list = Array.isArray(stored[COOKIE_CREDENTIAL_CACHE_LIST_KEY]) ? stored[COOKIE_CREDENTIAL_CACHE_LIST_KEY] : [];
    const items = list.map((item, index) => normalizeCookieCredentialCacheEntry(item, index));
    items.sort((left, right) => {
        const leftTime = new Date(left.savedAt || '').getTime();
        const rightTime = new Date(right.savedAt || '').getTime();
        if (Number.isNaN(leftTime) && Number.isNaN(rightTime)) {
            return 0;
        }
        if (Number.isNaN(leftTime)) {
            return 1;
        }
        if (Number.isNaN(rightTime)) {
            return -1;
        }
        return rightTime - leftTime;
    });
    return { items };
}

async function saveCookieCredentialCacheState(items = []) {
    const normalizedItems = Array.isArray(items)
        ? items.map((item, index) => normalizeCookieCredentialCacheEntry(item, index))
        : [];
    const storedItems = normalizedItems.slice(0, COOKIE_CREDENTIAL_CACHE_MAX_ITEMS);
    await chrome.storage.local.set({
        [COOKIE_CREDENTIAL_CACHE_LIST_KEY]: storedItems
    });
    return { items: storedItems };
}

async function loadCookieCredentialFilterState() {
    const stored = await chrome.storage.local.get([COOKIE_CREDENTIAL_SELECTED_DATE_KEY, COOKIE_CREDENTIAL_SEARCH_KEY]).catch(() => ({}));
    const selectedDate = String(stored[COOKIE_CREDENTIAL_SELECTED_DATE_KEY] || '').trim();
    const searchQuery = normalizeCookieCredentialSearchQuery(stored[COOKIE_CREDENTIAL_SEARCH_KEY] || '');
    cookieCredentialSelectedDate = selectedDate || getTodayCookieCredentialDateKey();
    cookieCredentialSearchQuery = searchQuery;

    if (cookieCredentialDateFilterNode) {
        cookieCredentialDateFilterNode.value = cookieCredentialSelectedDate;
    }
    if (cookieCredentialSearchNode) {
        cookieCredentialSearchNode.value = cookieCredentialSearchQuery;
    }
}

async function saveCookieCredentialFilterState() {
    await chrome.storage.local.set({
        [COOKIE_CREDENTIAL_SELECTED_DATE_KEY]: cookieCredentialSelectedDate || getTodayCookieCredentialDateKey(),
        [COOKIE_CREDENTIAL_SEARCH_KEY]: cookieCredentialSearchQuery
    }).catch(() => {});
}

function setCookieCredentialSelectedDate(value = '') {
    const normalized = String(value || '').trim();
    cookieCredentialSelectedDate = normalized || getTodayCookieCredentialDateKey();
    return cookieCredentialSelectedDate;
}

function setCookieCredentialSearchQuery(value = '') {
    cookieCredentialSearchQuery = normalizeCookieCredentialSearchQuery(value);
    return cookieCredentialSearchQuery;
}

function getCookieCredentialSelectedDateValue() {
    return String(cookieCredentialSelectedDate || '').trim() || getTodayCookieCredentialDateKey();
}

function getCookieCredentialVisibleItems(items = []) {
    const normalizedItems = Array.isArray(items) ? items : [];
    const selectedDate = getCookieCredentialSelectedDateValue();
    const searchQuery = normalizeCookieCredentialSearchQuery(cookieCredentialSearchQuery);

    return normalizedItems.filter((item) => {
        if (selectedDate !== 'all' && String(item.dateKey || '').trim() !== selectedDate) {
            return false;
        }
        return cookieCredentialItemMatchesQuery(item, searchQuery);
    });
}

function buildCookieCredentialDateOptions(items = []) {
    const normalizedItems = Array.isArray(items) ? items : [];
    const counts = new Map();
    normalizedItems.forEach((item) => {
        const dateKey = String(item.dateKey || getCookieCredentialDateKey(item.savedAt) || '').trim();
        if (!dateKey) {
            return;
        }
        counts.set(dateKey, (counts.get(dateKey) || 0) + 1);
    });

    const todayKey = getTodayCookieCredentialDateKey();
    const optionKeys = new Set(['all', todayKey, getCookieCredentialSelectedDateValue()]);
    counts.forEach((_count, dateKey) => optionKeys.add(dateKey));

    return Array.from(optionKeys)
        .filter(Boolean)
        .sort((left, right) => {
            if (left === 'all') return -1;
            if (right === 'all') return 1;
            if (left === todayKey) return -1;
            if (right === todayKey) return 1;
            return right.localeCompare(left);
        })
        .map((dateKey) => {
            const count = dateKey === 'all'
                ? normalizedItems.length
                : counts.get(dateKey) || 0;
            return {
                value: dateKey,
                label: `${formatCookieCredentialDateLabel(dateKey)}${dateKey === 'all' ? '' : `（${count} 条）`}`,
                count
            };
        });
}

function renderCookieCredentialDateFilterOptions(items = []) {
    if (!cookieCredentialDateFilterNode) {
        return [];
    }

    const selectedDate = getCookieCredentialSelectedDateValue();
    const options = buildCookieCredentialDateOptions(items);
    if (!options.some((option) => option.value === selectedDate)) {
        options.push({
            value: selectedDate,
            label: formatCookieCredentialDateLabel(selectedDate),
            count: 0
        });
    }

    cookieCredentialDateFilterNode.innerHTML = options.map((option) => (
        `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`
    )).join('');
    cookieCredentialDateFilterNode.value = selectedDate;
    return options;
}

function buildCookieCredentialEmptyMessage(totalCount = 0, visibleCount = 0) {
    if (totalCount <= 0) {
        return '暂无已保存记录，填写账号、密码、备注和卡密后点击“保存到缓存”。';
    }

    const selectedDate = getCookieCredentialSelectedDateValue();
    const selectedLabel = formatCookieCredentialDateLabel(selectedDate);
    const searchText = normalizeCookieCredentialSearchQuery(cookieCredentialSearchQuery);
    const parts = [];
    if (selectedDate !== 'all') {
        parts.push(`日期「${selectedLabel}」`);
    } else {
        parts.push('全部日期');
    }
    if (searchText) {
        parts.push(`关键词「${searchText}」`);
    }
    parts.push(`未找到可显示的记录（${visibleCount}/${totalCount} 条）`);
    return parts.join('，');
}

function renderCookieCredentialCacheList(state = { items: [] }) {
    if (!cookieCredentialListNode) {
        return;
    }

    const items = Array.isArray(state.items) ? state.items : [];
    renderCookieCredentialDateFilterOptions(items);

    const visibleItems = getCookieCredentialVisibleItems(items);
    if (cookieCredentialCountNode) {
        cookieCredentialCountNode.textContent = items.length > visibleItems.length
            ? `${visibleItems.length} / ${items.length} 条`
            : items.length > 0
                ? `${items.length} 条`
                : '0 条';
    }

    if (items.length === 0) {
        cookieCredentialListNode.innerHTML = '<div class="cookie-credential-empty">暂无已保存记录，填写账号、密码、备注和卡密后点击“保存到缓存”。</div>';
        return;
    }

    if (visibleItems.length === 0) {
        cookieCredentialListNode.innerHTML = `<div class="cookie-credential-empty">${escapeHtml(buildCookieCredentialEmptyMessage(items.length, visibleItems.length))}</div>`;
        return;
    }

    const groupedItems = new Map();
    visibleItems.forEach((item) => {
        const dateKey = String(item.dateKey || getCookieCredentialDateKey(item.savedAt) || '').trim() || getTodayCookieCredentialDateKey();
        const currentItems = groupedItems.get(dateKey) || [];
        currentItems.push(item);
        groupedItems.set(dateKey, currentItems);
    });

    const groupEntries = Array.from(groupedItems.entries()).sort((left, right) => right[0].localeCompare(left[0]));
    cookieCredentialListNode.innerHTML = groupEntries.map(([dateKey, groupItems]) => {
        const groupTitle = formatCookieCredentialDateLabel(dateKey);
        const groupCountText = `${groupItems.length} 条`;
        const itemsHtml = groupItems.map((item) => {
            const label = buildCookieCredentialListLabel(item);
            const isEditing = String(item.id || '').trim() === editingCookieCredentialId;
            return `
              <details class="cookie-credential-item${isEditing ? ' is-editing' : ''}" data-cookie-credential-item data-cookie-id="${escapeHtml(item.id)}">
                <summary class="cookie-credential-item__summary">
                  <div class="cookie-credential-item__summary-main">
                    <div class="cookie-credential-item__title">${escapeHtml(label.title)}</div>
                    <div class="cookie-credential-item__meta">${escapeHtml(label.meta)}</div>
                  </div>
                  <div class="cookie-credential-item__summary-actions">
                    <div class="cookie-credential-item__summary-action-row">
                      <button type="button" class="button-secondary" data-cookie-credential-action="copy">复制完整信息</button>
                      <button type="button" class="button-secondary" data-cookie-credential-action="edit">编辑</button>
                    </div>
                    <div class="cookie-credential-item__summary-action-row">
                      <button type="button" class="button-secondary cookie-credential-copy-account-password-btn" data-cookie-credential-action="copy-account-password">复制账号密码</button>
                      <button type="button" class="button-secondary cookie-credential-delete-btn" data-cookie-credential-action="delete">删除</button>
                    </div>
                  </div>
                </summary>
                <div class="cookie-credential-item__body">
                  <div class="cookie-credential-item__field">
                    <label>备注</label>
                    <div class="cookie-credential-item__value">${escapeHtml(String(item.note || '').trim() || '未填写')}</div>
                  </div>
                  <div class="cookie-credential-item__field">
                    <label>卡密</label>
                    <div class="cookie-credential-item__value">${escapeHtml(String(item.cardKey || '').trim() || '未填写')}</div>
                  </div>
                  <div class="cookie-credential-item__field">
                    <label>账号</label>
                    <div class="cookie-credential-item__value">${escapeHtml(String(item.account || '').trim() || '未填写')}</div>
                  </div>
                  <div class="cookie-credential-item__field">
                    <label>密码</label>
                    <div class="cookie-credential-item__value">${escapeHtml(String(item.password || '').trim() || '未填写')}</div>
                  </div>
                </div>
              </details>
            `;
        }).join('');
        return `
          <section class="cookie-credential-group" data-cookie-credential-group data-cookie-group-date="${escapeHtml(dateKey)}">
            <div class="cookie-credential-group__head">
              <div class="cookie-credential-group__head-main">
                <div class="cookie-credential-group__title">${escapeHtml(groupTitle)}</div>
                <div class="chip">${escapeHtml(groupCountText)}</div>
              </div>
              <div class="cookie-credential-group__actions">
                <button type="button" class="button-secondary cookie-credential-group__copy-all-btn" data-cookie-credential-action="copy-group-account-password" data-cookie-group-date="${escapeHtml(dateKey)}">复制全部账号密码</button>
              </div>
            </div>
            <div class="cookie-credential-group__list">
              ${itemsHtml}
            </div>
          </section>
        `;
    }).join('');
}

async function refreshCookieCredentialCacheUi() {
    await loadCookieCredentialFilterState().catch(() => {});
    const state = await loadCookieCredentialCacheState().catch(() => ({ items: [] }));
    renderCookieCredentialCacheList(state);
    return state;
}

async function rerenderCookieCredentialCacheUi() {
    const state = await loadCookieCredentialCacheState().catch(() => ({ items: [] }));
    renderCookieCredentialCacheList(state);
    return state;
}

async function copyCookieInputValue(inputNode, label = '内容') {
    const value = String(inputNode?.value || '').trim();
    if (!value) {
        throw new Error(`没有可复制的${label}`);
    }

    await copyTextToClipboard(value);
    return value;
}

async function copyCookieCredentialItem(cardId = '') {
    const state = await loadCookieCredentialCacheState().catch(() => ({ items: [] }));
    const item = state.items.find((entry) => String(entry.id || '').trim() === String(cardId || '').trim()) || null;
    if (!item) {
        throw new Error('未找到可复制的缓存记录');
    }

    const text = buildCookieCredentialClipboardText(item);
    await copyTextToClipboard(text);
    return item;
}

async function copyCookieCredentialAccountPasswordItem(cardId = '') {
    const state = await loadCookieCredentialCacheState().catch(() => ({ items: [] }));
    const item = state.items.find((entry) => String(entry.id || '').trim() === String(cardId || '').trim()) || null;
    if (!item) {
        throw new Error('未找到可复制的缓存记录');
    }

    const text = buildCookieCredentialAccountPasswordText(item);
    await copyTextToClipboard(text);
    return item;
}

async function copyCookieCredentialAccountPasswordGroup(dateKey = '') {
    const state = await loadCookieCredentialCacheState().catch(() => ({ items: [] }));
    const visibleItems = getCookieCredentialVisibleItems(state.items);
    const normalizedDateKey = String(dateKey || '').trim();
    const groupItems = visibleItems.filter((item) => String(item.dateKey || '').trim() === normalizedDateKey);
    if (!groupItems.length) {
        throw new Error('未找到可复制的分组记录');
    }

    const text = buildCookieCredentialGroupAccountPasswordText(groupItems);
    await copyTextToClipboard(text);
    return groupItems;
}

async function editCookieCredentialItem(cardId = '') {
    const state = await loadCookieCredentialCacheState().catch(() => ({ items: [] }));
    const item = state.items.find((entry) => String(entry.id || '').trim() === String(cardId || '').trim()) || null;
    if (!item) {
        throw new Error('未找到可编辑的缓存记录');
    }

    setCookieCredentialEditTarget(item);
    renderCookieCredentialCacheList(state);
    return item;
}

async function saveCookieCredentialEditRecord() {
    const editingId = String(editingCookieCredentialId || '').trim();
    if (!editingId) {
        throw new Error('请先选择一条记录再编辑');
    }

    const account = String(editCookieAccountInput?.value || '').trim();
    const password = String(editCookiePasswordInput?.value || '').trim();
    const note = String(editCookieNoteInput?.value || '').trim();
    const cardKey = String(editCookieCardKeyInput?.value || '').trim();

    if (!account && !password) {
        throw new Error('请先填写账号或密码');
    }

    const state = await loadCookieCredentialCacheState().catch(() => ({ items: [] }));
    const existingItem = state.items.find((item) => String(item.id || '').trim() === editingId) || null;
    if (!existingItem) {
        throw new Error('未找到当前正在编辑的记录');
    }

    const nextItem = normalizeCookieCredentialCacheEntry({
        id: editingId,
        account,
        password,
        note,
        cardKey,
        savedAt: new Date().toISOString()
    });
    const nextItems = state.items.filter((item) => String(item.id || '').trim() !== editingId);
    nextItems.unshift(nextItem);
    nextItems.splice(COOKIE_CREDENTIAL_CACHE_MAX_ITEMS);
    await saveCookieCredentialCacheState(nextItems);
    cookieCredentialSelectedDate = nextItem.dateKey || getTodayCookieCredentialDateKey();
    await saveCookieCredentialFilterState();
    clearCookieCredentialEditTarget();
    renderCookieCredentialCacheList({ items: nextItems });
    return nextItem;
}

async function deleteCookieCredentialItem(cardId = '') {
    const state = await loadCookieCredentialCacheState().catch(() => ({ items: [] }));
    const selectedId = String(cardId || '').trim();
    const item = state.items.find((entry) => String(entry.id || '').trim() === selectedId) || null;
    if (!item) {
        throw new Error('未找到可删除的缓存记录');
    }

    const confirmed = window.confirm(`确定删除缓存记录「${item.note || item.cardKey || item.account || '未命名'}」吗？`);
    if (!confirmed) {
        return { cancelled: true };
    }

    const nextItems = state.items.filter((entry) => String(entry.id || '').trim() !== selectedId);
    await saveCookieCredentialCacheState(nextItems);

    if (editingCookieCredentialId === selectedId) {
        clearCookieCredentialEditTarget();
    }

    renderCookieCredentialCacheList({ items: nextItems });
    return item;
}

function normalizeCookieImportBool(value = false) {
    return value === true || value === 'true' || value === 'TRUE' || value === 1 || value === '1';
}

function normalizeCookieImportSameSite(value = '') {
    const text = String(value || '').trim().toLowerCase();
    if (!text) {
        return '';
    }

    if (text === 'lax') return 'lax';
    if (text === 'strict') return 'strict';
    if (text === 'no_restriction' || text === 'none') return 'no_restriction';
    return '';
}

function normalizeCookieImportEntry(entry = {}, fallbackIndex = 0) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const name = String(source.name || source.key || source.cookieName || '').trim();
    const value = String(source.value ?? source.content ?? source.cookieValue ?? '').trim();
    const domain = String(source.domain || source.host || source.cookieDomain || '').trim().replace(/^\./, '');
    const path = String(source.path || source.cookiePath || '/').trim() || '/';
    const secure = normalizeCookieImportBool(source.secure);
    const httpOnly = normalizeCookieImportBool(source.httpOnly || source.http_only || source.httponly);
    const hostOnly = normalizeCookieImportBool(source.hostOnly || source.host_only || source.hostonly);
    const sameSite = normalizeCookieImportSameSite(source.sameSite || source.samesite);
    let expirationDate = Number(source.expirationDate || source.expires || source.expire || 0);
    if (Number.isFinite(expirationDate) && expirationDate > 1e12) {
        expirationDate = Math.floor(expirationDate / 1000);
    }
    const result = {
        name,
        value,
        domain,
        path,
        secure,
        httpOnly,
        hostOnly
    };

    if (sameSite) {
        result.sameSite = sameSite;
    }

    if (Number.isFinite(expirationDate) && expirationDate > 0) {
        result.expirationDate = expirationDate;
    }

    if (source.session === true) {
        result.session = true;
    }

    if (!result.name && !result.value && !domain) {
        result.name = `cookie_${fallbackIndex + 1}`;
    }

    return result;
}

function normalizeBrowserStorageEntry(entry = {}, fallbackIndex = 0) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const normalizeStorageMap = (value = {}) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return {};
        }
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            if (!String(key || '').trim()) {
                continue;
            }
            result[String(key)] = item == null ? '' : String(item);
        }
        return result;
    };

    return {
        id: String(source.id || `browser-storage-${fallbackIndex + 1}`).trim(),
        url: String(source.url || '').trim(),
        origin: String(source.origin || '').trim(),
        localStorage: normalizeStorageMap(source.localStorage || source.local_storage || {}),
        sessionStorage: normalizeStorageMap(source.sessionStorage || source.session_storage || {})
    };
}

function parseCookieImportLine(line = '', fallbackIndex = 0) {
    const text = String(line || '').trim();
    if (!text || text.startsWith('#')) {
        return null;
    }

    if (text.includes('\t')) {
        const columns = text.split('\t');
        if (columns.length >= 7) {
            const [domain, includeSubdomains, path, secure, expirationDate, name, value] = columns;
            return normalizeCookieImportEntry({
                domain,
                path,
                secure: normalizeCookieImportBool(secure),
                httpOnly: false,
                expirationDate: Number(expirationDate || 0),
                name,
                value
            }, fallbackIndex);
        }
    }

    const segments = text.split(';').map((segment) => segment.trim()).filter(Boolean);
    if (segments.length === 0) {
        return null;
    }

    const [nameValue, ...attributes] = segments;
    const separatorIndex = nameValue.indexOf('=');
    if (separatorIndex <= 0) {
        return null;
    }

    const entry = {
        name: nameValue.slice(0, separatorIndex).trim(),
        value: nameValue.slice(separatorIndex + 1).trim()
    };

    for (const attribute of attributes) {
        const equalsIndex = attribute.indexOf('=');
        const attributeName = String(equalsIndex >= 0 ? attribute.slice(0, equalsIndex) : attribute).trim().toLowerCase();
        const attributeValue = equalsIndex >= 0 ? String(attribute.slice(equalsIndex + 1)).trim() : '';

        if (!attributeName) {
            continue;
        }

        if (attributeName === 'domain') {
            entry.domain = attributeValue;
        } else if (attributeName === 'path') {
            entry.path = attributeValue || '/';
        } else if (attributeName === 'secure') {
            entry.secure = true;
        } else if (attributeName === 'httponly') {
            entry.httpOnly = true;
        } else if (attributeName === 'expires') {
            const expiresAt = new Date(attributeValue).getTime();
            if (Number.isFinite(expiresAt)) {
                entry.expirationDate = Math.floor(expiresAt / 1000);
            }
        } else if (attributeName === 'max-age') {
            const maxAge = Number(attributeValue);
            if (Number.isFinite(maxAge) && maxAge > 0) {
                entry.expirationDate = Math.floor(Date.now() / 1000) + maxAge;
            }
        } else if (attributeName === 'samesite') {
            entry.sameSite = attributeValue;
        }
    }

    return normalizeCookieImportEntry(entry, fallbackIndex);
}

function parseCookieImportText(text = '') {
    const raw = String(text || '').trim();
    if (!raw) {
        throw new Error('Cookie 文件为空');
    }

    const tryParseJson = () => {
        try {
            return JSON.parse(raw);
        } catch (_error) {
            return null;
        }
    };

    const parsed = tryParseJson();
    if (parsed) {
        if (Array.isArray(parsed)) {
            return parsed.map((item, index) => normalizeCookieImportEntry(item, index)).filter((item) => item.name);
        }

        if (parsed && typeof parsed === 'object') {
            if (Array.isArray(parsed.cookies)) {
                return parsed.cookies.map((item, index) => normalizeCookieImportEntry(item, index)).filter((item) => item.name);
            }

            if (parsed.pageUrl || parsed.pageTitle || parsed.browserStorage || parsed.capturedAt) {
                const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
                if (cookies.length > 0) {
                    return cookies.map((item, index) => normalizeCookieImportEntry(item, index)).filter((item) => item.name);
                }
            }

            if (parsed.name || parsed.key || parsed.cookieName) {
                return [normalizeCookieImportEntry(parsed, 0)].filter((item) => item.name);
            }
        }
    }

    const lines = raw.split(/\r?\n/);
    const items = [];
    for (const [index, line] of lines.entries()) {
        const item = parseCookieImportLine(line, index);
        if (item && item.name) {
            items.push(item);
        }
    }

    if (items.length > 0) {
        return items;
    }

    throw new Error('未识别到可导入的 Cookie 数据');
}

function parseCookieImportEnvelope(text = '') {
    const raw = String(text || '').trim();
    if (!raw) {
        return { cookies: [], browserStorage: [], pageUrl: '', pageTitle: '', account: '', password: '', capturedAt: '', sourceName: '' };
    }

    try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return {
                cookies: Array.isArray(parsed.cookies) ? parsed.cookies.map((item, index) => normalizeCookieImportEntry(item, index)).filter((item) => item.name) : [],
                browserStorage: Array.isArray(parsed.browserStorage)
                    ? parsed.browserStorage.map((item, index) => normalizeBrowserStorageEntry(item, index))
                    : [],
                pageUrl: String(parsed.pageUrl || '').trim(),
                pageTitle: String(parsed.pageTitle || '').trim(),
                account: String(parsed.account || '').trim(),
                password: String(parsed.password || '').trim(),
                capturedAt: String(parsed.capturedAt || '').trim(),
                sourceName: String(parsed.source || parsed.sourceName || parsed.fileName || '').trim()
            };
        }
    } catch (_error) {
    }

    return {
        cookies: parseCookieImportText(raw),
        browserStorage: [],
        pageUrl: '',
        pageTitle: '',
        account: '',
        password: '',
        capturedAt: '',
        sourceName: ''
    };
}

async function getCurrentActiveTabForCookieImport() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const tab = Array.isArray(tabs) ? tabs.find((item) => item && Number(item.id || 0) > 0) || null : null;
    if (!tab) {
        throw new Error('未找到可注入 Cookie 的当前标签页');
    }
    return tab;
}

async function importCookiesFromText(text = '', sourceName = '') {
    const envelope = parseCookieImportEnvelope(text);
    const cookies = envelope.cookies;
    const hasBrowserStorage = Array.isArray(envelope.browserStorage) && envelope.browserStorage.length > 0;
    const hasCredentials = Boolean(String(envelope.account || '').trim() || String(envelope.password || '').trim());

    if (!cookies.length && !hasBrowserStorage && !hasCredentials) {
        throw new Error('未识别到可导入的 Cookie、浏览器存储或账号密码数据');
    }

    const tab = await getCurrentActiveTabForCookieImport();
    if (accountInput && String(envelope.account || '').trim()) {
        accountInput.value = String(envelope.account || '').trim();
    }
    if (passwordInput && String(envelope.password || '').trim()) {
        passwordInput.value = String(envelope.password || '').trim();
    }
    await savePreset();
    setStatus('正在恢复账号/密码、浏览器存储和 Cookie...', '');

    if (!cookies.length && !hasBrowserStorage) {
        const message = '已导入账号/密码';
        setStatus(message, 'success');
        showActionToast(message, 'success');
        return {
            success: true,
            importedCount: 0,
            failedCount: 0,
            browserStorageCount: 0,
            restoredLocalStorageCount: 0,
            restoredSessionStorageCount: 0,
            message
        };
    }

    const result = await chrome.runtime.sendMessage({
        type: 'cookie-capture-import-cookies',
        payload: {
            tabId: Number(tab.id || 0) || 0,
            tabUrl: String(envelope.pageUrl || tab.url || '').trim(),
            pageUrl: String(envelope.pageUrl || tab.url || '').trim(),
            pageTitle: String(envelope.pageTitle || '').trim(),
            sourceName: String(sourceName || envelope.sourceName || '').trim(),
            cookies,
            browserStorage: Array.isArray(envelope.browserStorage) ? envelope.browserStorage : [],
            account: String(envelope.account || '').trim(),
            password: String(envelope.password || '').trim(),
            capturedAt: String(envelope.capturedAt || '').trim()
        }
    });

    if (!result || result.success !== true) {
        throw new Error(result?.error || 'Cookie 注入失败');
    }

    const successMessage = result.message || `已导入 ${result.importedCount || cookies.length} 条 Cookie`;
    setStatus(successMessage, 'success');
    showActionToast(successMessage, 'success');
    return result;
}

async function savePreset() {
    try {
        await chrome.storage.local.set({
            [ACCOUNT_KEY]: String(accountInput?.value || '').trim(),
            [PASSWORD_KEY]: String(passwordInput?.value || '').trim(),
            [COOKIE_NOTE_KEY]: String(cookieNoteInput?.value || '').trim(),
            [COOKIE_CARD_KEY]: String(cookieCardKeyInput?.value || '').trim()
        });
    } catch (_error) {
    }
}

async function loadPreset() {
    try {
        const stored = await chrome.storage.local.get([ACCOUNT_KEY, PASSWORD_KEY, COOKIE_NOTE_KEY, COOKIE_CARD_KEY]);
        if (accountInput) {
            accountInput.value = String(stored[ACCOUNT_KEY] || '');
        }
        if (passwordInput) {
            passwordInput.value = String(stored[PASSWORD_KEY] || '');
        }
        if (cookieNoteInput) {
            cookieNoteInput.value = String(stored[COOKIE_NOTE_KEY] || '');
        }
        if (cookieCardKeyInput) {
            cookieCardKeyInput.value = String(stored[COOKIE_CARD_KEY] || '');
        }
    } catch (_error) {
    }
}

async function saveCookieCredentialRecord() {
    const account = String(accountInput?.value || '').trim();
    const password = String(passwordInput?.value || '').trim();
    const note = String(cookieNoteInput?.value || '').trim();
    const cardKey = String(cookieCardKeyInput?.value || '').trim();

    if (!account && !password) {
        throw new Error('请先填写账号或密码');
    }

    const state = await loadCookieCredentialCacheState().catch(() => ({ items: [] }));
    const editingId = String(editingCookieCredentialId || '').trim();
    const nextItem = normalizeCookieCredentialCacheEntry({
        id: editingId || buildCookieCredentialCacheId({ account, password, note, cardKey }),
        account,
        password,
        note,
        cardKey,
        savedAt: new Date().toISOString()
    });
    const nextItems = state.items.filter((item) => String(item.id || '').trim() !== nextItem.id);
    nextItems.unshift(nextItem);
    nextItems.splice(COOKIE_CREDENTIAL_CACHE_MAX_ITEMS);
    await saveCookieCredentialCacheState(nextItems);
    cookieCredentialSelectedDate = nextItem.dateKey || getTodayCookieCredentialDateKey();
    await saveCookieCredentialFilterState();
    renderCookieCredentialCacheList({ items: nextItems });
    await savePreset();
    return nextItem;
}

async function captureCurrentTab() {
    const account = String(accountInput?.value || '').trim();
    const password = String(passwordInput?.value || '').trim();
    const fileName = buildPresetFileName(account, password);

    captureButton.disabled = true;
    setStatus('正在抓取当前页面...', '');

    try {
        await savePreset();
        const result = await chrome.runtime.sendMessage({
            type: 'cookie-capture-start',
            payload: {
                account,
                password,
                fileName
            }
        });

        if (!result || result.success !== true) {
            setStatus(result?.error || '抓取失败', 'error');
            return;
        }

        setStatus(`已保存 ${result.fileName}`, 'success');
    } catch (error) {
        setStatus(error && error.message ? error.message : '抓取失败', 'error');
    } finally {
        captureButton.disabled = false;
    }
}

function formatCookieManagerExpiry(cookie = {}) {
    if (cookie.session === true || !Number.isFinite(Number(cookie.expirationDate))) {
        return '会话期间';
    }

    const date = new Date(Number(cookie.expirationDate) * 1000);
    if (Number.isNaN(date.getTime())) {
        return '会话期间';
    }

    return date.toLocaleString('zh-CN', { hour12: false });
}

async function getCurrentActiveTabForCookieManager() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
    const tab = Array.isArray(tabs) ? tabs.find((item) => item && Number(item.id || 0) > 0) || null : null;
    if (!tab) {
        throw new Error('未找到可管理 Cookie 的当前标签页');
    }
    return tab;
}

async function fetchCookieManagerList() {
    const tab = await getCurrentActiveTabForCookieManager();
    const result = await chrome.runtime.sendMessage({
        type: 'cookie-capture-list-cookies',
        payload: { tabId: Number(tab.id || 0) || 0 }
    });

    if (!result || result.success !== true) {
        throw new Error(result?.error || '获取 Cookie 列表失败');
    }

    return {
        tabId: result.tabId,
        pageUrl: String(result.pageUrl || ''),
        cookies: Array.isArray(result.cookies) ? result.cookies : []
    };
}

function renderCookieManagerList(state = { pageUrl: '', cookies: [] }) {
    if (!cookieManagerListNode) {
        return;
    }

    const cookies = Array.isArray(state.cookies) ? state.cookies : [];
    if (cookieManagerCountNode) {
        cookieManagerCountNode.textContent = `${cookies.length} 条`;
    }
    if (cookieManagerSubtitleNode) {
        cookieManagerSubtitleNode.textContent = state.pageUrl
            ? `当前页面：${state.pageUrl}`
            : '未识别到当前页面地址';
    }

    if (cookies.length === 0) {
        cookieManagerListNode.innerHTML = '<div class="cookie-credential-empty">当前页面没有可管理的 Cookie。</div>';
        return;
    }

    cookieManagerListNode.innerHTML = cookies.map((cookie, index) => {
        const name = String(cookie.name || '').trim() || `cookie_${index + 1}`;
        const domain = String(cookie.domain || '').trim();
        const path = String(cookie.path || '/').trim() || '/';
        const value = String(cookie.value || '');
        const expiry = formatCookieManagerExpiry(cookie);

        return `
          <div class="cookie-manager-item" data-cookie-manager-item data-cookie-name="${escapeHtml(name)}" data-cookie-domain="${escapeHtml(domain)}" data-cookie-path="${escapeHtml(path)}" data-cookie-store-id="${escapeHtml(String(cookie.storeId || ''))}" data-cookie-secure="${cookie.secure === true ? '1' : '0'}">
            <div class="cookie-manager-item__main">
              <div class="cookie-manager-item__title">${escapeHtml(name)}</div>
              <div class="cookie-manager-item__meta">域：${escapeHtml(domain || '-')} · 路径：${escapeHtml(path)} · 过期：${escapeHtml(expiry)}</div>
              <div class="cookie-manager-item__value">${escapeHtml(value)}</div>
            </div>
            <button type="button" class="button-secondary cookie-credential-delete-btn" data-cookie-manager-action="delete">删除</button>
          </div>
        `;
    }).join('');
}

async function refreshCookieManagerList() {
    const state = await fetchCookieManagerList();
    renderCookieManagerList(state);
    return state;
}

async function openCookieManagerPanel() {
    if (!cookieManagerPanelNode) {
        return;
    }

    cookieManagerPanelNode.classList.add('is-visible');
    if (cookieManagerSubtitleNode) {
        cookieManagerSubtitleNode.textContent = '正在读取当前页面 Cookie...';
    }

    try {
        await refreshCookieManagerList();
    } catch (error) {
        const message = error && error.message ? error.message : '读取 Cookie 失败';
        if (cookieManagerSubtitleNode) {
            cookieManagerSubtitleNode.textContent = message;
        }
        if (cookieManagerListNode) {
            cookieManagerListNode.innerHTML = `<div class="cookie-credential-empty">${escapeHtml(message)}</div>`;
        }
    }
}

function closeCookieManagerPanel() {
    if (!cookieManagerPanelNode) {
        return;
    }
    cookieManagerPanelNode.classList.remove('is-visible');
}

async function deleteCookieManagerItem(itemNode = null) {
    if (!itemNode) {
        throw new Error('未找到可删除的 Cookie');
    }

    const tab = await getCurrentActiveTabForCookieManager();
    const cookie = {
        name: String(itemNode.dataset.cookieName || '').trim(),
        domain: String(itemNode.dataset.cookieDomain || '').trim(),
        path: String(itemNode.dataset.cookiePath || '/').trim(),
        storeId: String(itemNode.dataset.cookieStoreId || '').trim(),
        secure: itemNode.dataset.cookieSecure === '1'
    };

    const result = await chrome.runtime.sendMessage({
        type: 'cookie-capture-remove-cookie',
        payload: { tabId: Number(tab.id || 0) || 0, cookie }
    });

    if (!result || result.success !== true) {
        throw new Error(result?.error || '删除 Cookie 失败');
    }

    return { ...result, name: cookie.name };
}

async function clearCurrentPageCache() {
    clearCurrentPageCacheButton.disabled = true;
    setStatus('正在清理当前页面缓存...', '');

    try {
        const result = await chrome.runtime.sendMessage({
            type: 'cookie-capture-clear-current-page-cache',
            payload: {}
        });

        if (!result || result.success !== true) {
            setStatus(result?.error || '清理失败', 'error');
            return;
        }

        const parts = [];
        if (Number.isFinite(Number(result.removedCookieCount)) && Number(result.removedCookieCount) > 0) {
            parts.push(`Cookie ${result.removedCookieCount} 个`);
        }
        if (Number.isFinite(Number(result.clearedLocalStorageCount)) && Number(result.clearedLocalStorageCount) > 0) {
            parts.push(`localStorage ${result.clearedLocalStorageCount} 项`);
        }
        if (Number.isFinite(Number(result.clearedSessionStorageCount)) && Number(result.clearedSessionStorageCount) > 0) {
            parts.push(`sessionStorage ${result.clearedSessionStorageCount} 项`);
        }
        if (Number.isFinite(Number(result.clearedCacheStorageCount)) && Number(result.clearedCacheStorageCount) > 0) {
            parts.push(`CacheStorage ${result.clearedCacheStorageCount} 项`);
        }
        if (Number.isFinite(Number(result.clearedIndexedDbCount)) && Number(result.clearedIndexedDbCount) > 0) {
            parts.push(`IndexedDB ${result.clearedIndexedDbCount} 项`);
        }

        setStatus(parts.length > 0 ? `已清理当前页面缓存：${parts.join('、')}` : '已清理当前页面缓存', 'success');
    } catch (error) {
        setStatus(error && error.message ? error.message : '清理失败', 'error');
    } finally {
        clearCurrentPageCacheButton.disabled = false;
    }
}


globalThis.CookieCaptureCookieCredentials = {
    formatCookieCredentialTime,
    padCookieCredentialDatePart,
    getTodayCookieCredentialDateKey,
    getCookieCredentialDateKey,
    getCookieCredentialDateFromKey,
    getCookieCredentialYesterdayKey,
    formatCookieCredentialDateLabel,
    formatCookieCredentialTimeLabel,
    buildCookieCredentialSearchText,
    normalizeCookieCredentialSearchQuery,
    cookieCredentialItemMatchesQuery,
    buildCookieCredentialCacheId,
    normalizeCookieCredentialCacheEntry,
    buildCookieCredentialListLabel,
    buildCookieCredentialClipboardText,
    buildCookieCredentialAccountPasswordText,
    buildCookieCredentialGroupAccountPasswordText,
    focusCookieCredentialEditPanel,
    closeCookieCredentialEditPanel,
    syncCookieCredentialEditUi,
    setCookieCredentialEditTarget,
    clearCookieCredentialEditTarget,
    loadCookieCredentialCacheState,
    saveCookieCredentialCacheState,
    loadCookieCredentialFilterState,
    saveCookieCredentialFilterState,
    setCookieCredentialSelectedDate,
    setCookieCredentialSearchQuery,
    getCookieCredentialSelectedDateValue,
    getCookieCredentialVisibleItems,
    buildCookieCredentialDateOptions,
    renderCookieCredentialDateFilterOptions,
    buildCookieCredentialEmptyMessage,
    renderCookieCredentialCacheList,
    refreshCookieCredentialCacheUi,
    rerenderCookieCredentialCacheUi,
    copyCookieInputValue,
    copyCookieCredentialItem,
    copyCookieCredentialAccountPasswordItem,
    copyCookieCredentialAccountPasswordGroup,
    editCookieCredentialItem,
    saveCookieCredentialEditRecord,
    deleteCookieCredentialItem,
    normalizeCookieImportBool,
    normalizeCookieImportSameSite,
    normalizeCookieImportEntry,
    normalizeBrowserStorageEntry,
    parseCookieImportLine,
    parseCookieImportText,
    getCurrentActiveTabForCookieImport,
    importCookiesFromText,
    savePreset,
    loadPreset,
    saveCookieCredentialRecord,
    captureCurrentTab,
    clearCurrentPageCache,
    formatCookieManagerExpiry,
    getCurrentActiveTabForCookieManager,
    fetchCookieManagerList,
    renderCookieManagerList,
    refreshCookieManagerList,
    openCookieManagerPanel,
    closeCookieManagerPanel,
    deleteCookieManagerItem
};
