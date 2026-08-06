function normalizeSelectorCandidates(by = 'css_selector', selector = '') {
    const normalizedBy = String(by || 'css_selector').trim().toLowerCase();
    const normalizedSelector = String(selector || '').trim();
    if (!normalizedSelector) {
        return [];
    }

    if (normalizedBy === 'auto') {
        if (/^(?:text=|id=|class=|name=|placeholder=|aria-label=|aria=)/i.test(normalizedSelector) || normalizedSelector.includes(':has-text(')) {
            return [normalizedSelector];
        }

        return [normalizedSelector, `text=${normalizedSelector}`];
    }

    if (normalizedBy === 'text') {
        return [`text=${normalizedSelector}`];
    }

    // css_selector (default): for robustness on type/click, include a text fallback candidate
    // This helps when CSS selector is brittle after page redesigns (e.g. Baidu #kw -> textarea change)
    return [normalizedSelector, `text=${normalizedSelector}`];
}

function resolveTemplate(value, variables = {}) {
    if (typeof value !== 'string' || !value) {
        return value;
    }

    return value.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
        if (Object.prototype.hasOwnProperty.call(variables, key)) {
            const replacement = variables[key];
            if (replacement !== undefined && replacement !== null && replacement !== '') {
                return String(replacement);
            }
        }

        return match;
    });
}

// 变量输入：每个 type 步骤自动成为一个「变量槽」。变量键取步骤显式 variable 字段，
// 否则按其在所有 type 步骤中的顺序回退为 var1/var2/...（1-based）。运行前可通过
// MCP inputs / 卡片注册面板的输入框按键覆盖，未覆盖则用步骤自身 text 作为默认值。
function resolveStepVariableKey(step = {}, typeOrdinal = 1) {
    const explicit = String((step && step.variable) || '').trim();
    if (explicit) {
        return explicit;
    }
    const ordinal = Number.isFinite(Number(typeOrdinal)) && Number(typeOrdinal) > 0 ? Math.floor(Number(typeOrdinal)) : 1;
    return `var${ordinal}`;
}

// 归一化运行时传入的变量覆盖值：支持对象 { key: value }、数组（按顺序映射 var1..varN），
// 以及兼容旧字段 account/password/email/code。返回纯对象（键→字符串值）。
function normalizeRunInputs(payload = {}, cardData = {}) {
    const out = {};
    const mergeObject = (obj) => {
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            for (const [rawKey, rawValue] of Object.entries(obj)) {
                const key = String(rawKey || '').trim();
                if (!key || rawValue === undefined || rawValue === null) {
                    continue;
                }
                out[key] = String(rawValue);
            }
        }
    };
    const mergeArray = (arr) => {
        if (Array.isArray(arr)) {
            arr.forEach((value, index) => {
                if (value === undefined || value === null) {
                    return;
                }
                out[`var${index + 1}`] = String(value);
            });
        }
    };

    const source = payload && typeof payload === 'object' ? payload : {};
    if (Array.isArray(source.inputs)) {
        mergeArray(source.inputs);
    } else {
        mergeObject(source.inputs);
    }
    if (Array.isArray(source.variables)) {
        mergeArray(source.variables);
    } else {
        mergeObject(source.variables);
    }
    ['account', 'password', 'email', 'code'].forEach((key) => {
        const value = source[key];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            out[key] = String(value);
        }
    });
    return out;
}

function generateRandomString(length = 12, type = 'mixed') {
    const size = Number.isFinite(Number(length)) && Number(length) > 0 ? Number(length) : 12;
    const normalizedType = String(type || 'mixed').trim().toLowerCase();
    let alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    if (normalizedType === 'lowercase') {
        alphabet = 'abcdefghijklmnopqrstuvwxyz';
    } else if (normalizedType === 'uppercase') {
        alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    } else if (normalizedType === 'numeric' || normalizedType === 'number') {
        alphabet = '0123456789';
    } else if (normalizedType === 'alphanumeric') {
        alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    } else if (normalizedType === 'mixed') {
        alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
    }

    let output = '';
    for (let index = 0; index < size; index += 1) {
        output += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return output;
}

