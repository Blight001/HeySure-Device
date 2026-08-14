'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { once } = require('events');
const { app, BrowserWindow } = require('electron');
const { createBrowserRuntimeManager } = require('../../../src/app/main/browser-runtime');
const { MAX_MESSAGE_BYTES, PROTOCOL_VERSION } = require('../../../src/app/main/browser-runtime/chromium-command-client');

const acceptanceChromiumPath = String(process.env.AI_FREE_ACCEPTANCE_CHROMIUM_PATH || '').trim();
if (acceptanceChromiumPath) {
  process.env.AI_FREE_CHROMIUM_HANDSHAKE = 'prototype';
  process.env.AI_FREE_CHROMIUM_PATH = acceptanceChromiumPath;
} else {
  delete process.env.AI_FREE_CHROMIUM_HANDSHAKE;
  delete process.env.AI_FREE_CHROMIUM_PATH;
}

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-phase3-'));
const pageLoads = new Map();
const requests = [];
let manager;
let window;
let server;

function cookieHeaderHas(header, name, value) {
  return String(header || '').split(/;\s*/).includes(`${name}=${value}`);
}

function createTestServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const profile = String(url.searchParams.get('profile') || 'origin');
    requests.push({
      path: url.pathname,
      query: url.search,
      profile,
      cookie: String(request.headers.cookie || ''),
    });
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    if (url.pathname.startsWith('/asset-') && url.pathname.endsWith('.svg')) {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#345"/><text x="20" y="120" fill="white">${url.pathname}</text></svg>`);
      return;
    }
    if (url.pathname === '/input-result' || url.pathname === '/file-click' ||
        url.pathname === '/file-result' || url.pathname === '/native-event') {
      response.end('ok');
      return;
    }
    if (url.pathname === '/file-input') {
      response.end(`<!doctype html><meta charset="utf-8"><title>FILE_INPUT_READY</title>
        <input id="file" type="file" style="position:fixed;inset:0;width:100vw;height:100vh">
        <script>
          document.querySelector('#file').addEventListener('click', (event) => {
            fetch('/file-click?trusted=' + event.isTrusted).catch(() => {});
          });
          document.querySelector('#file').addEventListener('change', (event) => {
            const file = event.target.files[0];
            fetch('/file-result?name=' + encodeURIComponent(file?.name || '')
              + '&size=' + Number(file?.size || 0)).catch(() => {});
          });
        </script>`);
      return;
    }
    if (url.pathname === '/input') {
      response.end(`<!doctype html><meta charset="utf-8"><title>INPUT_READY</title>
        <button id="target" style="position:fixed;inset:0;width:100vw;height:100vh">input target</button>
        <script>
          document.querySelector('#target').addEventListener('click', (event) => {
            fetch('/input-result?profile=${profile}&trusted=' + event.isTrusted).catch(() => {});
          });
        </script>`);
      return;
    }
    if (url.pathname === '/coordinate-input') {
      response.end(`<!doctype html><meta charset="utf-8"><title>COORDINATE_INPUT_READY</title>
        <button style="position:fixed;left:0;top:0">错误按钮</button>
        <button id="publish" style="position:fixed;left:200px;top:150px;width:240px;height:80px"><span>发布</span></button>
        <xhs-publish-btn id="closed-publish" style="position:fixed;left:500px;top:150px;width:180px;height:80px">
          <template shadowrootmode="closed">
            <style>button{width:180px;height:80px;border:0;border-radius:20px;background:#ff2442;color:white}</style>
            <button type="button" aria-disabled="false">封闭发布</button>
          </template>
        </xhs-publish-btn>
        <button id="covered" style="position:fixed;left:20px;top:260px;width:180px;height:60px;z-index:1">被遮挡按钮</button>
        <div id="cover" style="position:fixed;left:20px;top:260px;width:180px;height:60px;z-index:2;background:white">遮罩</div>
        <p id="long-text" style="position:fixed;left:20px;top:340px;width:600px;height:80px">${'这是需要截断的长文本段落。'.repeat(30)}</p>
        <script>
          document.querySelector('#publish').addEventListener('click', (event) => {
            fetch('/input-result?profile=coordinate&trusted=' + event.isTrusted).catch(() => {});
          });
          document.querySelector('#closed-publish').addEventListener('click', (event) => {
            fetch('/input-result?profile=closed-shadow&trusted=' + event.isTrusted).catch(() => {});
          });
        </script>`);
      return;
    }
    if (url.pathname === '/semantic-controls') {
      response.end(`<!doctype html><meta charset="utf-8"><title>SEMANTIC_CONTROLS_READY</title>
        <style>body{display:grid;grid-template-columns:repeat(3,220px);gap:14px;padding:20px}
          input,textarea,select,button,[role],[contenteditable]{min-height:36px}</style>
        <label for="username">用户名</label><input id="username" placeholder="请输入账号" required>
        <label for="password">密码</label><input id="password" type="password" value="observe-must-not-leak">
        <textarea id="bio" aria-label="个人简介"></textarea>
        <label><input id="remember" type="checkbox" checked>记住登录</label>
        <label><input id="plan" type="radio" name="plan" checked>专业版</label>
        <select id="region"><option value="cn">中国</option><option value="sg" selected>新加坡</option></select>
        <div id="editor" contenteditable="plaintext-only" aria-label="正文编辑器">草稿</div>
        <button id="details" type="button" aria-expanded="true">详情</button>
        <div id="notifications" role="switch" aria-checked="false" tabindex="0">通知</div>
        <div id="settings-tab" role="tab" aria-selected="true" tabindex="0">设置</div>`);
      return;
    }
    if (url.pathname === '/media-grid') {
      response.end(`<!doctype html><meta charset="utf-8"><title>MEDIA_GRID_READY</title>
        <style>.tile{position:fixed;width:220px;height:160px;object-fit:cover}.clickable{cursor:pointer}
          #one{left:20px;top:20px}#two{left:260px;top:20px}#three{left:20px;top:210px;background-image:url('/asset-three.svg');background-size:cover}#four{left:260px;top:210px}</style>
        <a href="/asset-one-full.svg"><img id="one" class="tile clickable" src="/asset-one.svg"></a>
        <picture><source srcset="/asset-two.svg 1x, /asset-two-large.svg 2x"><img id="two" class="tile" src="/asset-two-thumb.svg"></picture>
        <div id="three" class="tile"></div>
        <img id="four" class="tile clickable" src="/asset-four-thumb.svg" data-image-url="/asset-four.svg">
        <a id="download-file" download="locked.svg" href="/asset-download.svg" style="position:fixed;left:520px;top:20px">下载测试</a>`);
      return;
    }
    if (url.pathname === '/native-input') {
      response.end(`<!doctype html><meta charset="utf-8"><title>NATIVE_INPUT_READY</title>
        <input id="native-input" style="position:fixed;left:20px;top:20px;width:300px;height:50px">
        <div style="height:2400px"></div>
        <script>
          const input = document.querySelector('#native-input');
          input.addEventListener('input', (event) => fetch('/native-event?kind=input&trusted=' +
            event.isTrusted + '&value=' + encodeURIComponent(input.value)).catch(() => {}));
          input.addEventListener('keydown', (event) => fetch('/native-event?kind=key&trusted=' +
            event.isTrusted + '&key=' + encodeURIComponent(event.key) + '&ctrl=' + event.ctrlKey +
            '&shift=' + event.shiftKey + '&alt=' + event.altKey + '&meta=' + event.metaKey).catch(() => {}));
          input.addEventListener('mouseup', (event) => fetch('/native-event?kind=selection&trusted=' +
            event.isTrusted + '&start=' + input.selectionStart + '&end=' + input.selectionEnd).catch(() => {}));
          addEventListener('wheel', (event) => fetch('/native-event?kind=wheel&trusted=' +
            event.isTrusted).catch(() => {}), { once: true });
          setTimeout(() => {
            const delayed = document.createElement('button');
            delayed.id = 'delayed-native-target';
            delayed.textContent = 'ready';
            document.body.append(delayed);
          }, 500);
        </script>`);
      return;
    }
    if (url.pathname === '/navigate') {
      response.end(`<title>NAVIGATED_${profile.toUpperCase()}</title><h1>navigate ok</h1>`);
      return;
    }
    const count = (pageLoads.get(profile) || 0) + 1;
    pageLoads.set(profile, count);
    response.end(`<!doctype html><meta charset="utf-8"><title>loading</title>
      <script>
        const profile = ${JSON.stringify(profile)};
        const visible = document.cookie.includes('visible=' + profile.toUpperCase());
        const httpOnlyHidden = !document.cookie.includes('secret=');
        const stored = localStorage.getItem('profileKey') || '';
        const sessionStored = sessionStorage.getItem('sessionKey') || '';
        document.title = 'PROFILE_' + profile.toUpperCase() + ';VISIBLE_' + (visible ? 'YES' : 'NO') +
          ';HTTPONLY_HIDDEN_' + (httpOnlyHidden ? 'YES' : 'NO') + ';LOCAL_' + stored +
          ';SESSION_' + sessionStored + ';LOAD_${count}';
      </script>`);
  });
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function findFiles(root, matcher) {
  const found = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (matcher(fullPath, entry.name)) found.push(fullPath);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return found;
}

function waitForEvent(emitter, eventName, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(eventName, onEvent);
      reject(new Error(`等待 ${eventName} 超时`));
    }, timeoutMs);
    const onEvent = (value) => {
      if (!predicate(value)) return;
      clearTimeout(timer);
      emitter.off(eventName, onEvent);
      resolve(value);
    };
    emitter.on(eventName, onEvent);
  });
}

async function waitForRequest(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = requests.find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待输入事件结果超时');
}

async function launchProfile(profileId, targetUrl, options = {}) {
  const state = await manager.launchProfile({
    profileId,
    runtimeType: 'chromium',
    initialUrl: 'about:blank',
    launchTimeoutMs: 30000,
    hideToolbar: options.hideToolbar === true,
    extraArgs: ['--enable-logging=stderr'],
  }, { x: 0, y: 41, width: 1180, height: 719 });
  assert.equal(state.status, 'ready');
  assert.equal(state.bridgeConnected, true);
  assert(state.sessionId && state.browserHwnd);
  const marker = profileId.slice(-1).toUpperCase();
  const result = await manager.importSession(profileId, {
    targetUrl,
    cookies: [
      { name: 'visible', value: marker, url: targetUrl, path: '/', sameSite: 'lax' },
      { name: 'secret', value: `http-only-${marker}`, url: targetUrl, path: '/', httpOnly: true, sameSite: 'lax' },
    ],
    browserStorage: [{
      origin: new URL(targetUrl).origin,
      localStorage: { profileKey: marker },
      sessionStorage: { sessionKey: `session-${marker}` },
    }],
  });
  assert.equal(result.cookiesImported, 2);
  assert.equal(result.storageOriginsImported, 1);
  assert.equal(result.storageResults[0].localVerified, true);
  assert.equal(result.storageResults[0].sessionVerified, true);
  assert.match(result.navigation.title,
    new RegExp(`PROFILE_${marker};VISIBLE_YES;HTTPONLY_HIDDEN_YES;LOCAL_${marker};SESSION_session-${marker}`));
  return { state, result };
}

async function stopAndAssertReleased(profileId, pid) {
  const paths = manager.store.getProfilePaths(profileId);
  const instance = manager.chromium.instances.get(profileId);
  await manager.stop(profileId, 'chromium', { timeoutMs: 5000 });
  assert.equal(manager.getState(profileId).status, 'stopped');
  assert.equal(isPidAlive(pid), false, `${profileId} Chromium 根进程必须退出`);
  assert.equal(fs.existsSync(paths.lock), false, `${profileId} Profile Lock 必须释放`);
  assert.equal(instance.commandClient.server, null, `${profileId} Named Pipe server 必须关闭`);
}

async function shutdown(exitCode) {
  try { await manager?.stopAll({ timeoutMs: 5000 }); } catch (_) {}
  try { await new Promise((resolve) => server?.close(resolve)); } catch (_) {}
  if (exitCode === 0) {
    try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch (_) {}
  } else {
    console.error(`[phase3-acceptance] failure artifacts preserved at ${runtimeRoot}`);
  }
  app.exit(exitCode);
}

app.whenReady().then(async () => {
  server = createTestServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ width: 1200, height: 800, show: true, title: 'AI-FREE Phase 3 Acceptance' });
  await window.loadURL('data:text/html,<body style="background:%23101827;color:white"><h2>Phase 3 acceptance</h2></body>');
  const acceptanceResourcesPath = String(process.env.AI_FREE_ACCEPTANCE_RESOURCES_PATH || '').trim()
    || (acceptanceChromiumPath
      ? path.dirname(acceptanceChromiumPath)
      : path.resolve(__dirname, '..', '..', '..', 'resources'));
  manager = createBrowserRuntimeManager({
    userDataDir: runtimeRoot,
    sandboxDir: path.join(runtimeRoot, 'AI-Workspace'),
    resourcesPath: acceptanceResourcesPath,
    getParentWindow: () => window,
    logger: console,
  });

  const a = await launchProfile('phase3_a', `${origin}/page?profile=a`);
  await manager.hide('phase3_a', 'chromium');
  const b = await launchProfile(
    'phase3_b',
    `${origin}/page?profile=b`,
    { hideToolbar: true },
  );

  const aRequest = requests.find((item) => item.path === '/page' && item.profile === 'a');
  const bRequest = requests.find((item) => item.path === '/page' && item.profile === 'b');
  assert(aRequest && cookieHeaderHas(aRequest.cookie, 'visible', 'A'));
  assert(aRequest && cookieHeaderHas(aRequest.cookie, 'secret', 'http-only-A'));
  assert(bRequest && cookieHeaderHas(bRequest.cookie, 'visible', 'B'));
  assert(bRequest && cookieHeaderHas(bRequest.cookie, 'secret', 'http-only-B'));
  assert.equal(cookieHeaderHas(aRequest.cookie, 'visible', 'B'), false);
  assert.equal(cookieHeaderHas(bRequest.cookie, 'visible', 'A'), false);

  const subUrls = [
    `${origin}/sub?profile=b&site=video`,
    `${origin}/sub?profile=b&site=image`,
  ];
  const openedTabs = await manager.openTabs('phase3_b', 'chromium', subUrls);
  assert.equal(openedTabs.result.opened, 2);
  await waitForRequest((item) => item.path === '/sub' && item.query.includes('site=video'));
  await waitForRequest((item) => item.path === '/sub' && item.query.includes('site=image'));
  const subRequests = requests.filter((item) => item.path === '/sub');
  assert(subRequests.every((item) => cookieHeaderHas(item.cookie, 'visible', 'B')));
  const duplicateTabs = await manager.openTabs('phase3_b', 'chromium', subUrls);
  assert.equal(duplicateTabs.result.opened, 0);
  assert.equal(duplicateTabs.result.skipped, 2);
  const tabsAfterOpen = await manager.dispatchAutomationByProcessId(b.state.pid, 'list-tabs', {});
  assert.equal(tabsAfterOpen.result.activeTab.url, subUrls.at(-1));

  await manager.hide('phase3_b', 'chromium');
  await manager.show('phase3_a', 'chromium');
  const aReloadAfterB = await manager.reload('phase3_a', 'chromium');
  assert.match(aReloadAfterB.result.title,
    /PROFILE_A;VISIBLE_YES;HTTPONLY_HIDDEN_YES;LOCAL_A;SESSION_session-A/);
  const latestARequest = requests.filter((item) => item.path === '/page' && item.profile === 'a').at(-1);
  assert(latestARequest && cookieHeaderHas(latestARequest.cookie, 'visible', 'A'));
  assert(latestARequest && cookieHeaderHas(latestARequest.cookie, 'secret', 'http-only-A'));
  assert.equal(cookieHeaderHas(latestARequest.cookie, 'visible', 'B'), false);
  assert.equal(cookieHeaderHas(latestARequest.cookie, 'secret', 'http-only-B'), false);
  await manager.hide('phase3_a', 'chromium');
  await manager.show('phase3_b', 'chromium');

  const inputPage = await manager.navigate('phase3_b', 'chromium', `${origin}/input?profile=b`);
  assert.equal(inputPage.result.title, 'INPUT_READY');
  await new Promise((resolve) => setTimeout(resolve, 500));
  await manager.hide('phase3_b', 'chromium');
  const inputDispatch = await manager.dispatchInputByProcessId(b.state.pid, {
    inputType: 'mouse', action: 'click', x: 10, y: 10,
    viewportWidth: 1000, viewportHeight: 600,
  });
  assert.equal(inputDispatch.result.dispatched, true);
  const inputRequest = await waitForRequest((item) => item.path === '/input-result' && item.profile === 'b');
  assert.equal(new URLSearchParams(inputRequest.query || '').get('trusted'), 'true');

  const coordinatePage = await manager.navigate('phase3_b', 'chromium', `${origin}/coordinate-input`);
  assert.equal(coordinatePage.result.title, 'COORDINATE_INPUT_READY');
  const topmostObserved = await manager.dispatchAutomationByProcessId(b.state.pid, 'observe-page', {
    limit: 50, text_limit: 40, show_highlights: false,
  });
  assert.equal(topmostObserved.result.topmostFiltered, true);
  assert.equal(topmostObserved.result.textLimit, 40);
  assert.equal(topmostObserved.result.closedShadowSupported, true);
  assert.equal(topmostObserved.result.accessibilitySupplementedCount, 1);
  assert.equal(topmostObserved.result.items.some((item) => item.text === '被遮挡按钮'), false);
  const visiblePublishItems = topmostObserved.result.items.filter((item) => item.text === '发布');
  assert.equal(visiblePublishItems.length, 1);
  assert.equal(visiblePublishItems[0].kind, 'interactive');
  assert.equal(visiblePublishItems[0].tag, 'button');
  assert.equal(Number.isFinite(visiblePublishItems[0].clickX), true);
  assert.equal(Number.isFinite(visiblePublishItems[0].clickY), true);
  const longTextItem = topmostObserved.result.items.find((item) => item.selector === '#long-text');
  assert.equal(longTextItem?.kind, 'text');
  assert.equal(longTextItem?.text.length, 40);
  assert.equal(longTextItem?.textTruncated, true);
  const closedShadowObserved = await manager.dispatchAutomationByProcessId(b.state.pid, 'observe-page', {
    keyword: '封闭发布', limit: 10, show_highlights: false,
  });
  const closedPublishItem = closedShadowObserved.result.items.find((item) => item.text === '封闭发布');
  assert.equal(closedPublishItem?.tag, 'button');
  assert.equal(closedPublishItem?.kind, 'interactive');
  assert.equal(closedPublishItem?.accessibilityFallback, true);
  assert.equal(closedPublishItem?.selector, undefined);
  assert.equal(Number.isFinite(closedPublishItem?.clickX), true);
  assert.equal(Number.isFinite(closedPublishItem?.clickY), true);
  const closedShadowClicked = await manager.dispatchAutomationByProcessId(
    b.state.pid, 'perform-action', {
      action: 'click', ref: closedPublishItem.id,
      x: closedPublishItem.clickX, y: closedPublishItem.clickY,
    },
  );
  assert.equal(closedShadowClicked.result.targetMode, 'viewport-coordinate');
  const closedShadowRequest = await waitForRequest(
    (item) => item.path === '/input-result' && item.profile === 'closed-shadow',
  );
  assert.equal(new URLSearchParams(closedShadowRequest.query || '').get('trusted'), 'true');
  const coordinateObserved = await manager.dispatchAutomationByProcessId(b.state.pid, 'observe-page', {
    keyword: '发布', limit: 10, show_highlights: false,
  });
  const publishItem = coordinateObserved.result.items.find((item) => item.text === '发布');
  assert.equal(publishItem?.selector, '#publish');
  const targetX = publishItem.clickX;
  const targetY = publishItem.clickY;
  const coordinateClicked = await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'click', ref: publishItem.id, selector: 'button', x: targetX, y: targetY,
  });
  assert.equal(coordinateClicked.result.inputMode, 'chromium-visible-pointer');
  assert.equal(coordinateClicked.result.targetMode, 'viewport-coordinate');
  assert.deepEqual(coordinateClicked.result.target, { x: targetX, y: targetY });
  const coordinateRequest = await waitForRequest(
    (item) => item.path === '/input-result' && item.profile === 'coordinate',
  );
  assert.equal(new URLSearchParams(coordinateRequest.query || '').get('trusted'), 'true');

  const semanticPage = await manager.navigate('phase3_b', 'chromium', `${origin}/semantic-controls`);
  assert.equal(semanticPage.result.title, 'SEMANTIC_CONTROLS_READY');
  const semanticObserved = await manager.dispatchAutomationByProcessId(b.state.pid, 'observe-page', {
    limit: 50, show_highlights: false,
  });
  const semanticItem = (selector) => semanticObserved.result.items.find((item) => item.selector === selector);
  assert.equal(semanticItem('#username')?.role, 'textbox');
  assert.equal(semanticItem('#username')?.controlType, 'text-input');
  assert.equal(semanticItem('#username')?.editable, true);
  assert.equal(semanticItem('#username')?.label, '用户名');
  assert.equal(semanticItem('#username')?.required, true);
  assert.equal(semanticItem('#password')?.inputType, 'password');
  assert.equal(semanticItem('#password')?.text, '');
  assert.equal(semanticItem('#password')?.value, '');
  assert.equal(semanticItem('#bio')?.multiline, true);
  assert.equal(semanticItem('#remember')?.controlType, 'checkbox');
  assert.equal(semanticItem('#remember')?.checked, true);
  assert.equal(semanticItem('#plan')?.controlType, 'radio');
  assert.equal(semanticItem('#region')?.role, 'combobox');
  assert.equal(semanticItem('#region')?.options.find((option) => option.selected)?.value, 'sg');
  assert.equal(semanticItem('#editor')?.controlType, 'rich-text-input');
  assert.equal(semanticItem('#details')?.expanded, true);
  assert.equal(semanticItem('#notifications')?.role, 'switch');
  assert.equal(semanticItem('#notifications')?.ariaChecked, 'false');
  assert.equal(semanticItem('#settings-tab')?.role, 'tab');
  const inputsOnly = await manager.dispatchAutomationByProcessId(b.state.pid, 'observe-page', {
    filter: 'input', limit: 20, show_highlights: false,
  });
  assert(inputsOnly.result.items.some((item) => item.selector === '#username'));
  assert(inputsOnly.result.items.some((item) => item.selector === '#editor'));
  assert(inputsOnly.result.items.every((item) => item.editable === true));

  const mediaPage = await manager.navigate('phase3_b', 'chromium', `${origin}/media-grid`);
  assert.equal(mediaPage.result.title, 'MEDIA_GRID_READY');
  const mediaObserved = await manager.dispatchAutomationByProcessId(b.state.pid, 'observe-page', {
    filter: 'media', limit: 20, show_highlights: false,
  });
  const mediaItems = mediaObserved.result.items.filter((item) => item.kind === 'media');
  assert.equal(mediaItems.length, 4);
  assert(mediaItems.every((item) => Array.isArray(item.mediaUrls)));
  assert(mediaItems.every((item) => item.downloadUrl?.startsWith(origin)));
  assert.equal(mediaItems.find((item) => item.selector === '#one')?.interactive, true);
  assert.equal(mediaItems.find((item) => item.selector === '#one')?.linkedUrl, `${origin}/asset-one-full.svg`);
  assert(mediaItems.find((item) => item.selector === '#two')?.mediaUrls.includes(`${origin}/asset-two-large.svg`));
  assert.equal(mediaItems.find((item) => item.selector === '#three')?.mediaType, 'background-image');
  assert(mediaItems.find((item) => item.selector === '#four')?.mediaUrls.includes(`${origin}/asset-four.svg`));
  assert.equal(mediaObserved.result.downloadLinks.filter((item) => item.kind === 'media').length, 4);

  const downloadObserved = await manager.dispatchAutomationByProcessId(b.state.pid, 'observe-page', {
    keyword: '下载测试', limit: 10, show_highlights: false,
  });
  const downloadItem = downloadObserved.result.items.find((item) => item.selector === '#download-file');
  await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'click', ref: downloadItem.id, x: downloadItem.clickX, y: downloadItem.clickY,
  });
  const lockedDownload = path.join(runtimeRoot, 'AI-Workspace', 'locked.svg');
  const downloadDeadline = Date.now() + 15000;
  while (!fs.existsSync(lockedDownload) && Date.now() < downloadDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fs.existsSync(lockedDownload), true, '普通 Chromium 下载必须自动保存到 AI-Workspace');

  const uploadPath = path.join(runtimeRoot, 'AI-Workspace', 'input-video.mp4');
  fs.writeFileSync(uploadPath, 'ai-free-upload-acceptance');
  await manager.show('phase3_b', 'chromium');
  const filePageUrl = `${origin}/file-input?profile=b`;
  const filePage = await manager.navigate('phase3_b', 'chromium', filePageUrl);
  assert.equal(filePage.result.title, 'FILE_INPUT_READY');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const selection = await manager.selectFilesByProcessId(b.state.pid, {
    pageUrl: filePageUrl, path: uploadPath, ttlMs: 5000,
  });
  assert.equal(selection.result.queued, true);
  const fileInputDispatch = await manager.dispatchInputByProcessId(b.state.pid, {
    inputType: 'mouse', action: 'click', x: 10, y: 10,
    viewportWidth: 1000, viewportHeight: 600,
  });
  assert.equal(fileInputDispatch.result.dispatched, true);
  const fileClick = await waitForRequest((item) => item.path === '/file-click');
  assert.equal(new URLSearchParams(fileClick.query || '').get('trusted'), 'true');
  const fileRequest = await waitForRequest((item) => item.path === '/file-result');
  const fileQuery = new URLSearchParams(fileRequest.query || '');
  assert.equal(fileQuery.get('name'), 'input-video.mp4');
  assert.equal(Number(fileQuery.get('size')), fs.statSync(uploadPath).size);
  await manager.navigate('phase3_b', 'chromium', `${origin}/page?profile=b`);

  const nativePage = await manager.navigate('phase3_b', 'chromium', `${origin}/native-input?profile=b`);
  assert.equal(nativePage.result.title, 'NATIVE_INPUT_READY');
  const waited = await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'wait', selector: '#delayed-native-target', timeout: 3000,
  });
  assert.equal(waited.result.found, true);
  const observed = await manager.dispatchAutomationByProcessId(b.state.pid, 'observe-page', {
    limit: 20, show_highlights: true, highlight_duration_ms: 30000,
  });
  assert.equal(observed.result.highlightMode, 'chromium-native-overlay');
  assert(observed.result.highlightedCount > 0);
  assert(observed.result.highlightedCount <= 20);
  assert.equal(observed.result.highlightDurationMs, 30000);
  const typed = await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'type', selector: '#native-input', text: 'Native42',
  });
  assert.equal(typed.result.inputMode, 'chromium-native-keyboard');
  const typedRequest = await waitForRequest((item) => item.path === '/native-event'
    && new URLSearchParams(item.query).get('kind') === 'input'
    && new URLSearchParams(item.query).get('value') === 'Native42');
  assert.equal(new URLSearchParams(typedRequest.query).get('trusted'), 'true');
  assert.equal(new URLSearchParams(typedRequest.query).get('value'), 'Native42');
  const pressed = await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'press_key', selector: '#native-input', key: 'Enter', ctrl: true,
  });
  assert.equal(pressed.result.inputMode, 'chromium-native-keyboard');
  const keyRequest = await waitForRequest((item) => item.path === '/native-event'
    && new URLSearchParams(item.query).get('kind') === 'key');
  assert.equal(new URLSearchParams(keyRequest.query).get('trusted'), 'true');
  assert.equal(new URLSearchParams(keyRequest.query).get('key'), 'Enter');
  assert.equal(new URLSearchParams(keyRequest.query).get('ctrl'), 'true');
  assert.equal(new URLSearchParams(keyRequest.query).get('shift'), 'false');
  const selected = await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'set_selection', selector: '#native-input', start: 6, end: 8,
  });
  assert.equal(selected.result.selectionStart, 6);
  assert.equal(selected.result.selectionEnd, 8);
  await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'press_key', selector: '#native-input', key: 'Backspace',
  });
  const deletedSelection = await waitForRequest((item) => item.path === '/native-event'
    && new URLSearchParams(item.query).get('kind') === 'input'
    && new URLSearchParams(item.query).get('value') === 'Native');
  assert.equal(new URLSearchParams(deletedSelection.query).get('trusted'), 'true');
  await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'press_key', selector: '#native-input', key: 'Home',
  });
  await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'press_key', selector: '#native-input', key: 'Shift+ArrowRight', repeat: 3,
  });
  await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'insert_text', selector: '#native-input', text: 'XYZ',
  });
  const insertedAtSelection = await waitForRequest((item) => item.path === '/native-event'
    && new URLSearchParams(item.query).get('kind') === 'input'
    && new URLSearchParams(item.query).get('value') === 'XYZive');
  assert.equal(new URLSearchParams(insertedAtSelection.query).get('trusted'), 'true');
  await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'press_key', selector: '#native-input', key: 'Ctrl+A',
  });
  const selectAllKey = await waitForRequest((item) => item.path === '/native-event'
    && new URLSearchParams(item.query).get('kind') === 'key'
    && new URLSearchParams(item.query).get('key').toLowerCase() === 'a'
    && new URLSearchParams(item.query).get('ctrl') === 'true');
  assert.equal(new URLSearchParams(selectAllKey.query).get('trusted'), 'true');
  await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'insert_text', selector: '#native-input', text: 'Mouse selection text',
  });
  await waitForRequest((item) => item.path === '/native-event'
    && new URLSearchParams(item.query).get('kind') === 'input'
    && new URLSearchParams(item.query).get('value') === 'Mouse selection text');
  const dragged = await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'drag', x: 35, y: 45, to_x: 180, to_y: 45,
  });
  assert.equal(dragged.result.inputMode, 'chromium-visible-pointer-drag');
  const mouseSelection = await waitForRequest((item) => item.path === '/native-event'
    && new URLSearchParams(item.query).get('kind') === 'selection'
    && Number(new URLSearchParams(item.query).get('end'))
      > Number(new URLSearchParams(item.query).get('start')));
  assert.equal(new URLSearchParams(mouseSelection.query).get('trusted'), 'true');
  const scrolled = await manager.dispatchAutomationByProcessId(b.state.pid, 'perform-action', {
    action: 'scroll', direction: 'down', amount: 300,
  });
  assert.equal(scrolled.result.inputMode, 'chromium-native-wheel');
  const wheelRequest = await waitForRequest((item) => item.path === '/native-event'
    && new URLSearchParams(item.query).get('kind') === 'wheel');
  assert.equal(new URLSearchParams(wheelRequest.query).get('trusted'), 'true');
  await manager.navigate('phase3_b', 'chromium', `${origin}/page?profile=b`);

  const beforeReload = pageLoads.get('b');
  const reload = await manager.reload('phase3_b', 'chromium');
  assert(pageLoads.get('b') > beforeReload, 'reload 必须触发新的 HTTP 页面请求');
  assert.match(reload.result.title, /PROFILE_B/);
  const navigate = await manager.navigate('phase3_b', 'chromium', `${origin}/navigate?profile=b`);
  assert.equal(navigate.result.url, `${origin}/navigate?profile=b`);
  assert.equal(navigate.result.title, 'NAVIGATED_B');

  const clientB = manager.chromium.instances.get('phase3_b').commandClient;
  const invalidSessionId = `invalid-session-${Date.now()}`;
  const invalidSessionResponse = waitForEvent(clientB, 'response', (message) => message.requestId === invalidSessionId);
  clientB.sendRaw({
    type: 'reload', protocolVersion: PROTOCOL_VERSION, profileId: 'phase3_b',
    sessionId: 'wrong-session', requestId: invalidSessionId,
  });
  assert.equal((await invalidSessionResponse).error.code, 'SESSION_ID_MISMATCH');
  const invalidProfileId = `invalid-profile-${Date.now()}`;
  const invalidProfileResponse = waitForEvent(clientB, 'response', (message) => message.requestId === invalidProfileId);
  clientB.sendRaw({
    type: 'reload', protocolVersion: PROTOCOL_VERSION, profileId: 'wrong-profile',
    sessionId: clientB.sessionId, requestId: invalidProfileId,
  });
  assert.equal((await invalidProfileResponse).error.code, 'PROFILE_ID_MISMATCH');
  await assert.rejects(clientB.send('set-storage', {
    origin: 'http://unrelated.invalid', targetUrl: `${origin}/page?profile=b`,
    localStorage: { bad: '1' }, sessionStorage: {},
  }), (error) => /** @type {any} */ (error).code === 'STORAGE_ORIGIN_FORBIDDEN');

  const cookieFilesA = findFiles(manager.store.getProfilePaths('phase3_a').chromiumData,
    (_fullPath, name) => name === 'Cookies');
  const storageFilesA = findFiles(manager.store.getProfilePaths('phase3_a').chromiumData,
    (fullPath) => /Local Storage/i.test(fullPath));
  assert(cookieFilesA.length > 0, '独立 Chromium Profile 必须生成实际 Cookie Store');
  assert(storageFilesA.length > 0, '独立 Chromium Profile 必须生成实际 Local Storage 数据');

  await stopAndAssertReleased('phase3_a', a.state.pid);
  await stopAndAssertReleased('phase3_b', b.state.pid);

  const restoredB = await manager.launchProfile({
    profileId: 'phase3_b',
    runtimeType: 'chromium',
    initialUrl: '',
    restoreLastSession: true,
    restoreFallbackUrl: `${origin}/page?profile=b`,
    launchTimeoutMs: 30000,
    hideToolbar: true,
  }, { x: 0, y: 41, width: 1180, height: 719 });
  const restoredReload = await manager.reload('phase3_b', 'chromium');
  assert.equal(restoredReload.result.url, `${origin}/navigate?profile=b`);
  assert.equal(restoredReload.result.title, 'NAVIGATED_B');
  const restoredA = await manager.launchProfile({
    profileId: 'phase3_a',
    runtimeType: 'chromium',
    initialUrl: '',
    restoreLastSession: true,
    restoreFallbackUrl: `${origin}/page?profile=a`,
    launchTimeoutMs: 30000,
  }, { x: 0, y: 41, width: 1180, height: 719 });
  await manager.stopAll({ timeoutMs: 5000 });
  assert.equal(manager.getState('phase3_a').status, 'stopped');
  assert.equal(manager.getState('phase3_b').status, 'stopped');
  assert.equal(isPidAlive(restoredA.pid), false);
  assert.equal(isPidAlive(restoredB.pid), false);

  const oversized = await manager.launchProfile({
    profileId: 'phase3_oversized', runtimeType: 'chromium', initialUrl: 'about:blank', launchTimeoutMs: 30000,
  }, { x: 0, y: 41, width: 1180, height: 719 });
  const oversizedClient = manager.chromium.instances.get('phase3_oversized').commandClient;
  const oversizedResponse = waitForEvent(oversizedClient, 'response',
    (message) => message.error?.code === 'MESSAGE_TOO_LARGE');
  const invalidHeader = Buffer.alloc(4);
  invalidHeader.writeUInt32LE(MAX_MESSAGE_BYTES + 1, 0);
  oversizedClient.socket.write(invalidHeader);
  assert.equal((await oversizedResponse).error.code, 'MESSAGE_TOO_LARGE');
  await manager.stop('phase3_oversized', 'chromium', { timeoutMs: 1000 });
  assert.equal(isPidAlive(oversized.pid), false);

  console.log('[phase3-acceptance] navigate/reload command responses passed');
  console.log('[phase3-acceptance] trusted local file selection reached the real HTML file input');
  console.log('[phase3-acceptance] native keyboard and wheel events reached the page as trusted input');
  console.log('[phase3-acceptance] native drag, caret selection, insert text and editing shortcuts passed');
  console.log('[phase3-acceptance] observe returned only topmost click owners and truncated long text');
  console.log('[phase3-acceptance] observe identified four obfuscated media elements and returned direct links');
  console.log('[phase3-acceptance] regular browser downloads were locked to AI-Workspace');
  console.log('[phase3-acceptance] closed Shadow DOM controls were observed and clicked as trusted native input');
  console.log('[phase3-acceptance] observed coordinates clicked the topmost target as trusted native input');
  console.log('[phase3-acceptance] native observe highlights were attached outside the page DOM');
  console.log('[phase3-acceptance] visible + HttpOnly cookies reached real Chromium requests');
  console.log('[phase3-acceptance] LocalStorage/SessionStorage verification and two-Profile isolation passed');
  console.log('[phase3-acceptance] invalid session/profile/origin/oversized message rejection passed');
  console.log('[phase3-acceptance] process, Named Pipe and Profile Lock release passed');
  console.log('[phase3-acceptance] stopAll graceful quit and last-session restore passed');
  await shutdown(0);
}).catch(async (error) => {
  console.error('[phase3-acceptance] FAILED', error.stack || error);
  try { console.error('[phase3-acceptance] runtime states', manager?.listStates()); } catch (_) {}
  await shutdown(1);
});

app.on('window-all-closed', () => { void shutdown(0); });
