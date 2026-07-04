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

    return [normalizedSelector];
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

