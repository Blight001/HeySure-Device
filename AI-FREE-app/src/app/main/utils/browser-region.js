const REGION_PRESETS = {
    cn: {
        label: '中国大陆',
        locale: 'zh-CN',
        timezoneId: 'Asia/Shanghai',
        acceptLanguage: 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    hk: {
        label: '中国香港',
        locale: 'zh-HK',
        timezoneId: 'Asia/Hong_Kong',
        acceptLanguage: 'zh-HK,zh;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    tw: {
        label: '中国台湾',
        locale: 'zh-TW',
        timezoneId: 'Asia/Taipei',
        acceptLanguage: 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    jp: {
        label: '日本',
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
        acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    kr: {
        label: '韩国',
        locale: 'ko-KR',
        timezoneId: 'Asia/Seoul',
        acceptLanguage: 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    sg: {
        label: '新加坡',
        locale: 'en-SG',
        timezoneId: 'Asia/Singapore',
        acceptLanguage: 'en-SG,en;q=0.9,en-US;q=0.8'
    },
    us: {
        label: '美国',
        locale: 'en-US',
        timezoneId: 'America/New_York',
        acceptLanguage: 'en-US,en;q=0.9'
    },
    gb: {
        label: '英国',
        locale: 'en-GB',
        timezoneId: 'Europe/London',
        acceptLanguage: 'en-GB,en;q=0.9,en-US;q=0.8'
    },
    de: {
        label: '德国',
        locale: 'de-DE',
        timezoneId: 'Europe/Berlin',
        acceptLanguage: 'de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    fr: {
        label: '法国',
        locale: 'fr-FR',
        timezoneId: 'Europe/Paris',
        acceptLanguage: 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    ca: {
        label: '加拿大',
        locale: 'en-CA',
        timezoneId: 'America/Toronto',
        acceptLanguage: 'en-CA,en;q=0.9,en-US;q=0.8'
    },
    au: {
        label: '澳大利亚',
        locale: 'en-AU',
        timezoneId: 'Australia/Sydney',
        acceptLanguage: 'en-AU,en;q=0.9,en-US;q=0.8'
    },
    nl: {
        label: '荷兰',
        locale: 'nl-NL',
        timezoneId: 'Europe/Amsterdam',
        acceptLanguage: 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    in: {
        label: '印度',
        locale: 'en-IN',
        timezoneId: 'Asia/Kolkata',
        acceptLanguage: 'en-IN,en;q=0.9,en-US;q=0.8'
    },
    ru: {
        label: '俄罗斯',
        locale: 'ru-RU',
        timezoneId: 'Europe/Moscow',
        acceptLanguage: 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
    },
    th: {
        label: '泰国',
        locale: 'th-TH',
        timezoneId: 'Asia/Bangkok',
        acceptLanguage: 'th-TH,th;q=0.9,en-US;q=0.8,en;q=0.7'
    }
};

// 格式化/规范化：normalizeBrowserRegionKey的具体业务逻辑。
function normalizeBrowserRegionKey(value) {
    return String(value || '').trim().toLowerCase().replace(/\s+/g, '');
}

// 获取/读取/解析：getBrowserRegionPreset的具体业务逻辑。
function getBrowserRegionPreset(region) {
    const key = normalizeBrowserRegionKey(region);
    if (!key || key === 'auto' || key === 'system') {
        return null;
    }

    const preset = REGION_PRESETS[key];
    if (!preset) {
        return null;
    }

    return {
        key,
        ...preset
    };
}

// 处理：inferBrowserRegionKeyFromLocale的具体业务逻辑。
function inferBrowserRegionKeyFromLocale(locale) {
    const raw = String(locale || '').trim().replace('_', '-').toLowerCase();
    if (!raw) {
        return null;
    }

    const [language, territory = ''] = raw.split('-');
    const normalizedTerritory = territory.toUpperCase();

    if (language === 'zh') return ({ HK: 'hk', TW: 'tw' })[normalizedTerritory] || 'cn';
    if (language === 'en') return ({ SG: 'sg', GB: 'gb', UK: 'gb', CA: 'ca', AU: 'au', IN: 'in' })[normalizedTerritory] || 'us';
    return ({ ja: 'jp', ko: 'kr', de: 'de', fr: 'fr', nl: 'nl', ru: 'ru', th: 'th' })[language] || null;
}

module.exports = {
    REGION_PRESETS,
    getBrowserRegionPreset,
    inferBrowserRegionKeyFromLocale,
};
