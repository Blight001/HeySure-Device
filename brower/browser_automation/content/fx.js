// content/fx.js — 页面操作动效（手型光标 / 点击涟漪 / 输入高亮 / 滚动·拖拽轨迹 / 截图快门）
// 与 device/extension/src/content/fx.ts 对齐的纯 JS 版本。作为内容脚本注入页面（隔离世界），
// 对外暴露 window.__hsFx，供 background 的 executePageAction 注入函数在真正操作 DOM 前调用，
// 让 AI 的浏览器操作在页面上有可见反馈。开关：chrome.storage.local['agent-settings'].mouseFx。

(() => {
    'use strict';
    if (window.__hsFx && window.__hsFx.__installed) {
        return; // 幂等：内容脚本或 executeScript 重复注入时不重复安装。
    }

    const FX = '__hs_ba_fx__';
    const HAND_HOTSPOT = { x: 1, y: 1 };
    const HAND_SIZE = 32;
    let handUrl = '';
    try { handUrl = chrome.runtime.getURL('cursors/hand.png'); } catch (_e) { handUrl = ''; }

    let fxEnabled = true;
    let fxCursor = null;
    let fxTrail = null;
    let fxX = 0;
    let fxY = 0;
    let fxHideTimer = null;
    let moveAnim = null;
    let screenshotOverlay = null;

    const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
    // rAF 在后台（隐藏）标签页会暂停，届时动画的 await 永不 resolve。既然隐藏标签
    // 看不到动效，就把「隐藏」当作「关闭」，所有调用点直接跳过动画、保持操作快速。
    const isFxEnabled = () => fxEnabled && !document.hidden && !!handUrl;

    // 读取开关（agent-settings.mouseFx，默认开启）并监听变化。
    try {
        chrome.storage.local.get('agent-settings').then((r) => {
            const s = r && r['agent-settings'];
            if (s && typeof s.mouseFx === 'boolean') fxEnabled = s.mouseFx;
        }).catch(() => {});
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === 'local' && changes['agent-settings']) {
                const s = changes['agent-settings'].newValue;
                if (s && typeof s.mouseFx === 'boolean') fxEnabled = s.mouseFx;
            }
        });
    } catch (_e) {}

    function handImg(className, ghost) {
        const opacity = ghost ? 'opacity:.22;' : '';
        return `<img class="${className}" src="${handUrl}" width="${HAND_SIZE}" height="${HAND_SIZE}" alt="" draggable="false" style="${opacity}"/>`;
    }

    function ensureStyles() {
        let style = document.getElementById(FX + '_style');
        if (!style) {
            style = document.createElement('style');
            style.id = FX + '_style';
            (document.head || document.documentElement).appendChild(style);
        }
        style.textContent = `
    .${FX}-cur,.${FX}-trail,.${FX}-ring,.${FX}-spark,.${FX}-trail-line,.${FX}-scroll-hint,
    .${FX}-shot-frame,.${FX}-shot-flash,.${FX}-shot-scan,.${FX}-hover-glow{position:fixed;left:0;top:0;pointer-events:none;}
    .${FX}-cur{z-index:2147483647;opacity:0;will-change:transform;}
    .${FX}-cur.show{opacity:1;}
    .${FX}-cur.noanim{transition:none!important;}
    .${FX}-cur-in{display:block;transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px) scale(1);
      transform-origin:0 0;transition:transform .12s cubic-bezier(.34,1.4,.64,1);}
    .${FX}-cur-in.pulse{animation:${FX}-press .28s cubic-bezier(.34,1.4,.64,1);}
    .${FX}-cur-in.hold{transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px) scale(.84);}
    @keyframes ${FX}-press{
      0%{transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px) scale(1);}
      38%{transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px) scale(.76);}
      62%{transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px) scale(.76);}
      100%{transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px) scale(1);}}
    .${FX}-cur-pointer,.${FX}-trail-pointer{display:block;width:${HAND_SIZE}px;height:${HAND_SIZE}px;
      user-select:none;-webkit-user-drag:none;background:transparent;}
    .${FX}-cur-pointer{filter:drop-shadow(0 1px 2px rgba(15,23,42,.28));}
    .${FX}-trail{z-index:2147483646;opacity:0;will-change:transform;}
    .${FX}-trail.show{opacity:1;}
    .${FX}-trail-in{display:block;transform:translate(-${HAND_HOTSPOT.x}px,-${HAND_HOTSPOT.y}px);filter:blur(.4px);}
    .${FX}-ring,.${FX}-spark{z-index:2147483645;}
    .${FX}-ring{width:12px;height:12px;border-radius:50%;border:2px solid rgba(129,140,248,.85);
      transform:translate(-50%,-50%) scale(.35);opacity:.95;animation:${FX}-ring .72s cubic-bezier(.22,1,.36,1) forwards;}
    .${FX}-ring.alt{border-color:rgba(251,191,36,.9);box-shadow:0 0 10px rgba(251,191,36,.35);}
    @keyframes ${FX}-ring{70%{opacity:.45;}100%{transform:translate(-50%,-50%) scale(3.8);opacity:0;}}
    .${FX}-spark{width:5px;height:5px;border-radius:50%;background:rgba(165,180,252,.9);
      transform:translate(-50%,-50%) scale(1);animation:${FX}-spark .55s ease-out forwards;}
    @keyframes ${FX}-spark{100%{transform:translate(-50%,-50%) scale(2.4);opacity:0;}}
    .${FX}-trail-line{height:2px;border-radius:2px;transform-origin:0 50%;opacity:0;z-index:2147483645;
      background:linear-gradient(90deg,rgba(99,102,241,0),rgba(129,140,248,.75),rgba(99,102,241,0));
      animation:${FX}-trail-line .75s ease-out forwards;}
    @keyframes ${FX}-trail-line{0%{opacity:.75;}100%{opacity:0;}}
    .${FX}-scroll-hint{width:3px;border-radius:3px;transform:translateX(-50%);opacity:0;z-index:2147483645;
      background:linear-gradient(180deg,rgba(99,102,241,0),rgba(129,140,248,.7),rgba(99,102,241,0));
      animation:${FX}-scroll-hint .62s ease-out forwards;}
    @keyframes ${FX}-scroll-hint{0%{opacity:.7;}100%{opacity:0;}}
    .${FX}-hover-glow{z-index:2147483644;border-radius:6px;
      box-shadow:0 0 0 2px rgba(129,140,248,.55),0 0 20px rgba(99,102,241,.35);
      animation:${FX}-hover-glow .35s ease-out;}
    @keyframes ${FX}-hover-glow{from{opacity:0;transform:scale(.98);}to{opacity:1;transform:scale(1);}}
    .${FX}-shot-wrap{position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483644;pointer-events:none;overflow:hidden;}
    .${FX}-shot-dim{position:fixed;background:rgba(2,6,23,.54);}
    .${FX}-shot-frame{z-index:1;box-sizing:border-box;border:2px solid rgba(56,189,248,.95);border-radius:6px;
      box-shadow:inset 0 0 28px rgba(56,189,248,.2);animation:${FX}-shot-frame .5s ease-out;}
    @keyframes ${FX}-shot-frame{from{opacity:0;transform:scale(.985);}to{opacity:1;transform:scale(1);}}
    .${FX}-shot-scan{position:absolute;height:2px;width:100%;left:0;top:0;z-index:2;
      background:linear-gradient(90deg,transparent,rgba(56,189,248,.95),transparent);
      box-shadow:0 0 14px rgba(56,189,248,.65);animation:${FX}-shot-scan 1.1s ease-in-out infinite;}
    @keyframes ${FX}-shot-scan{0%{top:0;opacity:.25;}50%{opacity:1;}100%{top:calc(100% - 2px);opacity:.25;}}
    .${FX}-shot-flash{inset:0;width:100vw;height:100vh;z-index:2147483645;
      background:radial-gradient(circle at 50% 42%,rgba(255,255,255,.95) 0%,rgba(255,255,255,.55) 38%,rgba(186,230,253,.2) 100%);
      opacity:0;animation:${FX}-shot-flash .9s ease-out forwards;}
    @keyframes ${FX}-shot-flash{0%{opacity:0;}14%{opacity:.9;}100%{opacity:0;}}`;
    }

    function ensureCursor() {
        if (!isFxEnabled() || !document.body) return null;
        ensureStyles();
        if (fxCursor && document.documentElement.contains(fxCursor)) return fxCursor;

        const cur = document.createElement('div');
        cur.className = `${FX}-cur noanim`;
        cur.innerHTML = `<span class="${FX}-cur-in">${handImg(`${FX}-cur-pointer`)}</span>`;
        document.body.appendChild(cur);
        fxCursor = cur;

        if (!fxTrail || !document.documentElement.contains(fxTrail)) {
            const trail = document.createElement('div');
            trail.className = `${FX}-trail`;
            trail.innerHTML = `<span class="${FX}-trail-in">${handImg(`${FX}-trail-pointer`, true)}</span>`;
            document.body.appendChild(trail);
            fxTrail = trail;
        }

        if (!fxX && !fxY) { fxX = window.innerWidth / 2; fxY = window.innerHeight / 2; }
        place(fxX, fxY, false);
        if (fxTrail) {
            fxTrail.style.transform = `translate(${fxX}px, ${fxY}px)`;
            fxTrail.classList.remove('show');
        }
        return cur;
    }

    function place(x, y, animate) {
        if (!fxCursor) return;
        fxX = x; fxY = y;
        fxCursor.classList.toggle('noanim', !animate);
        fxCursor.style.transform = `translate(${x}px, ${y}px)`;
    }

    function scheduleHide() {
        if (fxHideTimer) clearTimeout(fxHideTimer);
        fxHideTimer = setTimeout(() => {
            if (fxCursor) fxCursor.classList.remove('show');
            if (fxTrail) fxTrail.classList.remove('show');
        }, 1800);
    }

    function showCursor() {
        if (fxCursor) fxCursor.classList.add('show');
        if (fxTrail) fxTrail.classList.add('show');
    }

    function spawn(cls, x, y, life, extra) {
        if (!document.body) return;
        const el = document.createElement('div');
        el.className = `${FX}-${cls}`;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        if (extra) extra(el);
        document.body.appendChild(el);
        setTimeout(() => el.remove(), life || 700);
    }

    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    const cursorInner = () => (fxCursor ? fxCursor.querySelector(`.${FX}-cur-in`) : null);

    async function pressPulse() {
        const inner = cursorInner();
        if (!inner) return;
        inner.classList.remove('hold');
        void inner.offsetWidth;
        inner.classList.add('pulse');
        await sleep(280);
        inner.classList.remove('pulse');
    }

    async function pressHold() {
        const inner = cursorInner();
        if (!inner) return;
        inner.classList.remove('pulse');
        inner.classList.add('hold');
        await sleep(90);
    }

    async function pressRelease() {
        const inner = cursorInner();
        if (!inner) return;
        inner.classList.remove('hold');
        await sleep(130);
    }

    function clickRipples(x, y, variant) {
        const ringClass = variant === 'right' ? 'ring alt' : 'ring';
        for (const d of [0, 55, 110]) setTimeout(() => spawn(ringClass, x, y, 760), d);
        for (let i = 0; i < 6; i++) {
            const ang = (Math.PI * 2 * i) / 6;
            const r = 10 + Math.random() * 6;
            setTimeout(() => spawn('spark', x + Math.cos(ang) * r, y + Math.sin(ang) * r, 560), 20);
        }
    }

    async function moveTo(x, y) {
        if (!ensureCursor()) return;
        showCursor();
        const startX = fxX, startY = fxY;
        const dx = x - startX, dy = y - startY;
        const dist = Math.hypot(dx, dy);
        const duration = Math.min(Math.max(dist * 0.55, 180), 520);
        if (moveAnim) cancelAnimationFrame(moveAnim);
        await new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                if (moveAnim) { cancelAnimationFrame(moveAnim); moveAnim = null; }
                clearTimeout(backstop);
                place(x, y, false);
                resolve();
            };
            const backstop = setTimeout(finish, duration + 400);
            const t0 = performance.now();
            const step = (now) => {
                const t = Math.min(1, (now - t0) / duration);
                const e = easeOutCubic(t);
                place(startX + dx * e, startY + dy * e, false);
                if (fxTrail) {
                    const lag = 0.28;
                    const tx = startX + dx * Math.max(0, e - lag);
                    const ty = startY + dy * Math.max(0, e - lag);
                    fxTrail.style.transform = `translate(${tx}px, ${ty}px)`;
                }
                if (t < 1) moveAnim = requestAnimationFrame(step);
                else finish();
            };
            moveAnim = requestAnimationFrame(step);
        });
    }

    function centerOf(el) {
        try {
            const r = el.getBoundingClientRect();
            const cx = Math.min(Math.max(r.left + r.width / 2, 4), window.innerWidth - 4);
            const cy = Math.min(Math.max(r.top + r.height / 2, 4), window.innerHeight - 4);
            return { x: cx, y: cy };
        } catch (_e) {
            return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        }
    }

    // ── 对外 API（executePageAction 在真正操作 DOM 前 await 调用）──────────────
    async function moveToEl(el) {
        if (!isFxEnabled() || !el) return;
        const { x, y } = centerOf(el);
        await moveTo(x, y);
    }

    async function clickEl(el, variant) {
        if (!isFxEnabled() || !el) return;
        const { x, y } = centerOf(el);
        await moveTo(x, y);
        const v = variant === 'right' ? 'right' : variant === 'double' ? 'double' : 'left';
        const rip = v === 'right' ? 'right' : 'left';
        if (v === 'double') {
            await pressPulse(); clickRipples(x, y, rip);
            await sleep(100);
            await pressPulse(); clickRipples(x, y, rip);
        } else {
            await pressPulse(); clickRipples(x, y, rip);
        }
        scheduleHide();
    }

    async function typeEl(el) {
        if (!isFxEnabled() || !el) return;
        const { x, y } = centerOf(el);
        await moveTo(x, y);
        ensureStyles();
        try {
            const r = el.getBoundingClientRect();
            spawn('hover-glow', r.left - 4, r.top - 4, 900, (g) => {
                g.style.width = `${r.width + 8}px`;
                g.style.height = `${r.height + 8}px`;
            });
        } catch (_e) {}
        await pressPulse();
        scheduleHide();
    }

    async function scrollDrag(direction, amount) {
        if (!isFxEnabled()) return;
        ensureCursor();
        const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
        const len = Math.min(Math.max(amount || 0, 80), 220);
        let startY = cy, endY = cy;
        if (direction === 'down') { startY = cy + len / 2; endY = cy - len / 2; }
        else if (direction === 'up') { startY = cy - len / 2; endY = cy + len / 2; }
        else if (direction === 'bottom') { startY = cy + 110; endY = cy - 110; }
        else if (direction === 'top') { startY = cy - 110; endY = cy + 110; }
        showCursor();
        place(cx, startY, false);
        if (fxTrail) fxTrail.style.transform = `translate(${cx}px, ${startY}px)`;
        await pressHold();
        spawn('scroll-hint', cx, Math.min(startY, endY), 620, (el) => {
            el.style.height = `${Math.abs(endY - startY)}px`;
        });
        place(cx, endY, true);
        if (fxTrail) fxTrail.style.transform = `translate(${cx}px, ${endY}px)`;
        await sleep(280);
        await pressRelease();
        scheduleHide();
    }

    function clearShot() {
        if (screenshotOverlay) { screenshotOverlay.remove(); screenshotOverlay = null; }
        document.querySelectorAll(`.${FX}-shot-flash`).forEach((el) => el.remove());
    }

    async function shotBefore() {
        if (!isFxEnabled() || !document.body) return;
        ensureStyles();
        clearShot();
        const wrap = document.createElement('div');
        wrap.className = `${FX}-shot-wrap`;
        const frame = document.createElement('div');
        frame.className = `${FX}-shot-frame`;
        frame.style.left = '10px';
        frame.style.top = '10px';
        frame.style.width = `${Math.max(0, window.innerWidth - 20)}px`;
        frame.style.height = `${Math.max(0, window.innerHeight - 20)}px`;
        const scan = document.createElement('div');
        scan.className = `${FX}-shot-scan`;
        frame.appendChild(scan);
        wrap.appendChild(frame);
        document.body.appendChild(wrap);
        screenshotOverlay = wrap;
        await sleep(520);
        clearShot();
    }

    async function shotAfter() {
        if (!isFxEnabled() || !document.body) return;
        ensureStyles();
        clearShot();
        const flash = document.createElement('div');
        flash.className = `${FX}-shot-flash`;
        document.body.appendChild(flash);
        setTimeout(() => flash.remove(), 950);
        await sleep(300);
    }

    window.__hsFx = {
        __installed: true,
        enabled: isFxEnabled,
        moveToEl,
        clickEl,
        typeEl,
        scrollDrag,
        shotBefore,
        shotAfter
    };
})();
