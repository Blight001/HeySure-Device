(function initAiFreeBrowserSettingsModule() {
  let loaded = false;
  let current = {};
  let browserHistory = [];
  let browserProfileAudit = null;
  let selectedHistoryId = '';
  let historyRefreshTimer = null;
  let browserHistoryRefreshCount = 0;
  let browserSettingsPreviousFocus = null;
  let editingDefaultSettings = false;
  const el = (id) => document.getElementById(id);
  const value = (id, fallback = '') => el(id)?.value ?? fallback;
  const checked = (id) => el(id)?.checked === true;
  const setValue = (id, next) => { if (el(id)) el(id).value = next ?? ''; };
  const setChecked = (id, next) => { if (el(id)) el(id).checked = next === true; };
  const number = (id, fallback = 0) => Number.isFinite(Number(value(id))) ? Number(value(id)) : fallback;
  const randomItem = (items) => items[Math.floor(Math.random() * items.length)];
  const randomSeed = () => Math.random().toString(16).slice(2) + Date.now().toString(16);
  const readPath = (source, path) => path.split('.').reduce((result, key) => result?.[key], source);
  const writePath = (source, path, next) => {
    const keys = path.split('.'); let target = source;
    keys.slice(0, -1).forEach((key) => { target[key] ||= {}; target = target[key]; });
    target[keys.at(-1)] = next;
  };
  const text = (...values) => {
    const found = values.find((item) => item !== undefined && item !== null && item !== '');
    return String(found === undefined ? '' : found).trim();
  };
  const errorText = (error, fallback = '') => text(error && error.message, error, fallback);
  const requireOk = (response, fallback) => {
    if (!response || response.ok !== true) throw new Error(text(response && response.error, fallback));
    return response;
  };

  function setStatus(message, type = '') {
    const target = el('ai-free-settings-status'); if (!target) return;
    target.textContent = String(message || '');
    target.classList.toggle('is-error', type === 'error');
    target.classList.toggle('is-success', type === 'success');
  }

  function setBrowserHistoryRefreshing(refreshing) {
    browserHistoryRefreshCount = Math.max(0, browserHistoryRefreshCount + (refreshing ? 1 : -1));
    const active = browserHistoryRefreshCount > 0;
    const button = el('refresh-browser-history');
    const list = el('browser-history-list');
    if (button) {
      button.disabled = active;
      button.setAttribute('aria-label', active ? '正在刷新浏览器记录' : '刷新浏览器记录');
    }
    list?.setAttribute('aria-busy', active ? 'true' : 'false');
  }

  function renderBrowserCapacity(capacity) {
    const target = el('browser-capacity-status');
    if (!target) return;
    const snapshot = capacity?.snapshot || {};
    const labels = { normal: '资源正常', warning: '资源紧张', critical: '资源不足' };
    if (!capacity) {
      target.textContent = '设备容量暂不可用';
      return;
    }
    target.textContent = `${snapshot.activeProfiles || 0} / ${snapshot.profileLimit || 0} · ${labels[snapshot.pressure] || '资源未知'}`;
    target.dataset.pressure = snapshot.pressure || 'unknown';
  }

  function animateBrowserHistoryRemoval(historyIds) {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
    const ids = new Set((Array.isArray(historyIds) ? historyIds : [historyIds]).map(String));
    const rows = [...document.querySelectorAll('.browser-history-item')]
      .filter((row) => ids.has(String(row.dataset.historyId || '')));
    if (!rows.length) return Promise.resolve();
    rows.forEach((row) => row.classList.add('is-removing'));
    return new Promise((resolve) => setTimeout(resolve, 190));
  }

  function openBrowserSettingsDialog(title = '浏览器参数配置') {
    const dialog = el('browser-settings-dialog');
    if (!dialog) return;
    browserSettingsPreviousFocus = document.activeElement;
    const titleElement = el('browser-settings-dialog-title');
    if (titleElement) titleElement.textContent = title;
    dialog.hidden = false;
    document.body.classList.add('browser-settings-dialog-open');
    setTimeout(() => el('browser-settings-dialog-close')?.focus(), 0);
  }

  function closeBrowserSettingsDialog() {
    const dialog = el('browser-settings-dialog');
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true;
    document.body.classList.remove('browser-settings-dialog-open');
    browserSettingsPreviousFocus?.focus?.();
    browserSettingsPreviousFocus = null;
  }

  const {
    renderBrowserHistory,
    renderBrowserProfileAudit,
    formatBrowserHistoryDateTime,
  } = window.createAiFreeBrowserHistoryView({
    el,
    getBrowserHistory: () => browserHistory,
    getBrowserProfileAudit: () => browserProfileAudit,
    openBrowserHistory,
    selectBrowserHistory,
  });
  function updateBrowserHistorySelection(options) {
    const keepEmpty = !selectedHistoryId && (options.keepEmptySelection === true || editingDefaultSettings);
    const selectionStillValid = options.keepSelection === true
      && browserHistory.some((item) => item.id === selectedHistoryId);
    if (!keepEmpty && !selectionStillValid) {
      const active = browserHistory.find((item) => item.isActive);
      selectedHistoryId = active ? active.id : text(browserHistory[0] && browserHistory[0].id);
    }
  }

  async function refreshBrowserHistory(options = {}) {
    setBrowserHistoryRefreshing(true);
    try {
      const response = await window.aiFree.browser.getHistory();
      requireOk(response, '读取浏览器记录失败');
      browserHistory = Array.isArray(response.history) ? response.history : [];
      browserProfileAudit = response.profileAudit && typeof response.profileAudit === 'object'
        ? response.profileAudit
        : null;
      renderBrowserCapacity(response.capacity);
      updateBrowserHistorySelection(options);
      renderBrowserHistory();
      renderBrowserProfileAudit();
      return browserHistory;
    } catch (error) {
      const list = el('browser-history-list');
      if (list) list.innerHTML = '<div class="browser-history-empty">浏览器记录读取失败</div>';
      if (options.silent !== true) setStatus(errorText(error), 'error');
      return [];
    } finally {
      setBrowserHistoryRefreshing(false);
    }
  }

  async function selectBrowserHistory(historyId, options = {}) {
    editingDefaultSettings = false;
    selectedHistoryId = String(historyId || '');
    renderBrowserHistory();
    const item = browserHistory.find((entry) => entry.id === selectedHistoryId);
    const recordFields = el('browser-record-edit-fields');
    const deleteButton = el('delete-browser-record');
    if (recordFields) recordFields.hidden = false;
    if (deleteButton) deleteButton.hidden = false;
    setValue('browser-record-name', text(item && item.name, '新建窗口'));
    if (el('save-ai-free-settings')) el('save-ai-free-settings').textContent = '保存修改';
    if (options.openDialog === true) {
      openBrowserSettingsDialog(item ? `编辑浏览器 · ${item.name}` : '编辑浏览器');
    }
    setStatus('正在读取独立浏览器参数…');
    try {
      const response = await window.aiFree.browser.getSettings( { historyId: selectedHistoryId });
      requireOk(response, '读取参数失败');
      fillForm(response.settings, response.runtimeInfo);
      setStatus('已载入该浏览器的独立参数');
    } catch (error) {
      setStatus(errorText(error), 'error');
    }
  }

  async function openDefaultBrowserSettings() {
    editingDefaultSettings = true;
    selectedHistoryId = '';
    renderBrowserHistory();
    if (el('browser-record-edit-fields')) el('browser-record-edit-fields').hidden = true;
    if (el('delete-browser-record')) el('delete-browser-record').hidden = true;
    if (el('save-ai-free-settings')) el('save-ai-free-settings').textContent = '保存参数';
    openBrowserSettingsDialog('浏览器默认环境配置');
    setStatus('正在读取默认环境参数…');
    try {
      const response = await window.aiFree.browser.getSettings( {});
      if (!response?.ok) throw new Error(response?.error || '读取默认参数失败');
      fillForm(response.settings, response.runtimeInfo);
      setStatus('已载入浏览器默认环境参数');
    } catch (error) {
      setStatus(error?.message || String(error), 'error');
    }
  }

  async function openBrowserHistory(historyId, triggerButton = null) {
    triggerButton?.classList.add('is-processing');
    if (triggerButton) triggerButton.disabled = true;
    setStatus('正在打开浏览器…');
    try {
      const response = await window.aiFree.browser.openHistory( { historyId });
      if (!response?.ok) throw new Error(response?.error || '打开浏览器失败');
      await refreshBrowserHistory({ keepSelection: true, silent: true, animate: false });
      setStatus(`已打开“${response.name || '浏览器'}”`, 'success');
    } catch (error) {
      setStatus(error?.message || String(error), 'error');
    } finally {
      triggerButton?.classList.remove('is-processing');
      if (triggerButton) triggerButton.disabled = false;
    }
  }

  async function deleteBrowserHistory(item, options = {}) {
    const name = String(item?.name || '新建窗口');
    const message = item?.isOpen
      ? `确认关闭“${name}”并删除该条浏览器记录？`
      : `确认删除“${name}”的浏览器记录？`;
    if (!window.MessageModal?.showConfirmDialog) {
      setStatus('软件确认弹窗未就绪', 'error');
      return;
    }
    window.MessageModal.showConfirmDialog(message, async () => {
      setStatus(`正在删除“${name}”…`);
      try {
        const response = await window.aiFree.browser.deleteHistory( { historyId: item.id });
        if (!response?.ok) throw new Error(response?.error || '删除失败');
        clearTimeout(historyRefreshTimer);
        await animateBrowserHistoryRemoval(item.id);
        if (selectedHistoryId === item.id) selectedHistoryId = '';
        await refreshBrowserHistory({ silent: true, animate: false });
        if (options.closeDialogOnSuccess === true) {
          closeBrowserSettingsDialog();
        } else if (selectedHistoryId) {
          await selectBrowserHistory(selectedHistoryId);
        }
        setStatus(`已删除“${response.name || name}”`, 'success');
      } catch (error) {
        setStatus(error?.message || String(error), 'error');
      }
    }, null, 'warning');
  }

  function scheduleBrowserHistoryRefresh() {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = setTimeout(() => void refreshBrowserHistory({ keepSelection: true, silent: true }), 120);
  }

  function setSegment(path, next) {
    document.querySelectorAll(`.segmented[data-field="${path}"] button`).forEach((button) => {
      button.classList.toggle('active', button.dataset.value === String(next));
    });
    writePath(current, path, next === 'true' ? true : next === 'false' ? false : next);
    syncConditionalFields();
  }

  function getSegment(path, fallback = '') {
    return document.querySelector(`.segmented[data-field="${path}"] button.active`)?.dataset.value ?? fallback;
  }

  function syncConditionalFields() {
    if (el('custom-proxy-fields')) el('custom-proxy-fields').hidden = getSegment('proxy.mode') !== 'custom';
    if (el('homepage-url')) el('homepage-url').hidden = getSegment('homepage.mode') !== 'custom';
    if (el('browser-user-agent')) el('browser-user-agent').disabled = getSegment('ua.mode') !== 'custom';
    if (el('sec-ch-ua-brands')) el('sec-ch-ua-brands').hidden = getSegment('secChUa.mode') !== 'custom';
    if (el('browser-timezone')) el('browser-timezone').hidden = checked('timezone-by-ip');
    if (el('custom-geolocation')) el('custom-geolocation').hidden = checked('geolocation-by-ip') || getSegment('geolocation.permission') === 'block';
    if (el('custom-resolution')) el('custom-resolution').hidden = getSegment('resolution.mode') !== 'custom';
    if (el('webgl-metadata-fields')) el('webgl-metadata-fields').hidden = getSegment('webglMetadata.mode') !== 'custom';
    if (el('launch-args')) el('launch-args').hidden = getSegment('launchArgs.mode') !== 'custom';
  }

  function fillForm(settings, runtimeInfo = {}) {
    current = window.fillAiFreeBrowserSettingsForm({
      el, readPath, setChecked, setSegment, setValue, syncConditionalFields,
      segmentPaths: ['os','proxy.mode','homepage.mode','ua.mode','secChUa.mode','webrtc.mode','geolocation.permission','resolution.mode','fonts.mode','canvas.mode','webglImage.mode','webglMetadata.mode','webgpu.mode','audioContext.mode','clientRects.mode','speechVoices.mode','deviceName.mode','macAddress.mode','sslEnabled','portScanProtection.enabled','launchArgs.mode'],
    }, settings, runtimeInfo);
  }

  function collectForm() {
    let brands = []; try { brands = JSON.parse(value('sec-ch-ua-brands', '[]')); } catch (_) { brands = []; }
    const setting = {
      ...current, os: getSegment('os', 'win11'), browserVersion: value('browser-version'), kernelVersion: value('kernel-version', 'auto'),
      proxy: { mode: getSegment('proxy.mode','default'), protocol: value('proxy-protocol','http'), host: value('proxy-host'), port: value('proxy-port'), username: value('proxy-username'), password: value('proxy-password'), apiUrl: value('proxy-api-url') },
      cookies: value('browser-cookies','[]'), homepage: { mode: getSegment('homepage.mode','default'), url: value('homepage-url') },
      ua: { mode: getSegment('ua.mode','default'), value: value('browser-user-agent') }, secChUa: { mode: getSegment('secChUa.mode','default'), brands },
      language: { mode: 'custom', value: value('browser-locale') }, timezone: { mode: checked('timezone-by-ip') ? 'ip' : 'custom', value: value('browser-timezone') },
      webrtc: { mode: getSegment('webrtc.mode','replace') }, geolocation: { permission: getSegment('geolocation.permission','ask'), mode: checked('geolocation-by-ip') ? 'ip' : 'custom', longitude: number('geo-longitude'), latitude: number('geo-latitude'), accuracy: number('geo-accuracy',100) },
      resolution: { mode: getSegment('resolution.mode','follow'), width: number('resolution-width',1366), height: number('resolution-height',768) },
      fonts: { mode: getSegment('fonts.mode','system'), seed: current.fonts?.seed }, canvas: { mode: getSegment('canvas.mode','noise'), seed: current.canvas?.seed },
      webglImage: { mode: getSegment('webglImage.mode','noise'), seed: current.webglImage?.seed }, webglMetadata: { mode: getSegment('webglMetadata.mode','custom'), vendor: value('browser-webgl-vendor'), renderer: value('browser-webgl-renderer') },
      webgpu: { mode: getSegment('webgpu.mode','webgl') }, audioContext: { mode: getSegment('audioContext.mode','noise'), seed: current.audioContext?.seed }, clientRects: { mode: getSegment('clientRects.mode','noise'), seed: current.clientRects?.seed }, speechVoices: { mode: getSegment('speechVoices.mode','noise'), seed: current.speechVoices?.seed },
      cpu: number('browser-cpu',8), memory: number('browser-memory',8), deviceName: { mode: getSegment('deviceName.mode','default'), value: value('device-name') }, macAddress: { mode: getSegment('macAddress.mode','default'), value: value('mac-address') },
      doNotTrack: checked('do-not-track'), sslEnabled: getSegment('sslEnabled') === 'true', portScanProtection: { enabled: getSegment('portScanProtection.enabled') === 'true', allowList: value('port-scan-allow-list').split(/[\s,;]+/).filter(Boolean) }, hardwareAcceleration: checked('hardware-acceleration'), lowSpecMode: value('low-spec-mode', 'auto'), launchArgs: { mode: getSegment('launchArgs.mode','default'), value: value('launch-args') },
    };
    return setting;
  }

  const validateSettings = window.validateAiFreeBrowserSettings;
  function randomIdentity() {
    const os = randomItem(['win10','win11']); const version = randomItem([145,146,147,148,149,150]);
    setSegment('os', os); setValue('browser-version', version); setSegment('ua.mode','custom');
    setSegment('secChUa.mode','custom'); setSegment('webglMetadata.mode','custom'); setSegment('deviceName.mode','custom'); setSegment('macAddress.mode','custom');
    setValue('browser-user-agent', `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Safari/537.36`);
    setValue('sec-ch-ua-brands', JSON.stringify([{brand:'Chromium',version:String(version)},{brand:'Google Chrome',version:String(version)},{brand:'Not_A Brand',version:'24'}], null, 2));
    const gpu = randomItem([['Google Inc. (Intel)','ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)'],['Google Inc. (NVIDIA)','ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 Direct3D11 vs_5_0 ps_5_0, D3D11)'],['Google Inc. (AMD)','ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)']]);
    setValue('browser-webgl-vendor',gpu[0]); setValue('browser-webgl-renderer',gpu[1]); setValue('browser-cpu',randomItem([4,6,8,12,16])); setValue('browser-memory',randomItem([4,8,16,32]));
    ['fonts','canvas','webglImage','audioContext','clientRects','speechVoices'].forEach((key) => { current[key] ||= {}; current[key].seed = randomSeed(); });
    setValue('device-name', `DESKTOP-${Math.random().toString(36).slice(2,9).toUpperCase()}`); setValue('mac-address', Array.from({length:6},()=>Math.floor(Math.random()*256).toString(16).padStart(2,'0')).join('-').toUpperCase());
    setStatus('已生成一组匹配的系统、UA、硬件与噪声种子。');
  }

  async function loadSettings(force = false) {
    if (loaded && !force) return; setStatus('正在读取本地参数…');
    try { await refreshBrowserHistory({ silent: true }); const response = await window.aiFree.browser.getSettings( selectedHistoryId ? { historyId: selectedHistoryId } : {}); if (!response?.ok) throw new Error(response?.error || '读取参数失败'); fillForm(response.settings,response.runtimeInfo); loaded = true; setStatus('参数已从本机载入'); } catch (error) { setStatus(error?.message || String(error),'error'); }
  }

  function settingsSaveTarget() {
    const historyId = editingDefaultSettings ? '' : selectedHistoryId;
    const historyItem = historyId
      ? browserHistory.find((item) => item.id === historyId) || null
      : null;
    const requestedName = historyId ? text(value('browser-record-name')) : '';
    if (historyId && !requestedName) throw new Error('浏览器名称不能为空');
    return { historyId, historyItem, requestedName };
  }

  async function persistBrowserSettings(target) {
    const settings = collectForm();
    validateSettings(settings);
    const response = await window.aiFree.browser.setSettings({
      settings,
      historyId: target.historyId,
      applyToActive: checked('apply-settings-to-active'),
      restartChromium: checked('restart-chromium-settings'),
    });
    requireOk(response, '保存失败');
    fillForm(response.settings, response.runtimeInfo);
    return response;
  }

  async function renameSavedBrowser(target) {
    if (!target.historyItem || target.requestedName === text(target.historyItem.name)) return false;
    const response = await window.aiFree.browser.renameHistory({
      historyId: target.historyId,
      name: target.requestedName,
    });
    requireOk(response, '重命名失败');
    const savedName = text(response.name, target.requestedName);
    setValue('browser-record-name', savedName);
    const title = el('browser-settings-dialog-title');
    if (title) title.textContent = `编辑浏览器 · ${savedName}`;
    return true;
  }

  function settingsSavedMessage(target, response, renamed) {
    const result = response && response.activeResult || {};
    if (renamed) {
      return result.restarted ? '已保存名称和参数，并重启 Chromium 环境。' : '已保存浏览器名称和参数。';
    }
    if (result.restarted) return '已保存并重启 Chromium 环境。';
    if (result.restartRequired) return '已保存独立参数；部分内核项需重启后生效。';
    if (result.applied) return '已保存并应用到该浏览器。';
    return target.historyId ? '已保存该浏览器的独立参数。' : '已保存为默认环境配置。';
  }

  async function saveSettings(event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    // 表单内包含羊毛资源等非配置按钮，仅“保存参数”按钮可触发保存
    if (event && event.submitter && event.submitter.id !== 'save-ai-free-settings') return;
    const button = el('save-ai-free-settings');
    if (button) button.disabled = true;
    setStatus('正在保存并应用…');
    let settingsSaved = false;
    try {
      const target = settingsSaveTarget();
      const response = await persistBrowserSettings(target);
      settingsSaved = true;
      const renamed = await renameSavedBrowser(target);
      await refreshBrowserHistory({ keepSelection: true, keepEmptySelection: !target.historyId, silent: true });
      setStatus(settingsSavedMessage(target, response, renamed), 'success');
    } catch (error) {
      const message = errorText(error);
      setStatus(settingsSaved ? `参数已保存，但名称修改失败：${message}` : message, 'error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function resetSettings(){try{const targetHistoryId=editingDefaultSettings?'':selectedHistoryId;const response=await window.aiFree.browser.resetSettings({historyId:targetHistoryId,applyToActive:checked('apply-settings-to-active'),restartChromium:checked('restart-chromium-settings')});if(response?.ok){fillForm(response.settings,response.runtimeInfo);await refreshBrowserHistory({keepSelection:true,keepEmptySelection:!targetHistoryId,silent:true});setStatus(targetHistoryId?'该浏览器已恢复默认配置。':'已恢复默认配置。','success');}else throw new Error(response?.error||'恢复默认失败');}catch(error){setStatus(error?.message||String(error),'error');}}
  async function testProxy(){setStatus('正在检测代理…');const response=await window.aiFree.browser.testProxy({proxy:collectForm().proxy});setStatus(response?.ok?`代理可用：${response.ip||'连接成功'}（${response.elapsedMs||0}ms）`:response?.error||'代理不可用',response?.ok?'success':'error');}
  async function extractProxy(){const response=await window.aiFree.browser.extractProxy({apiUrl:value('proxy-api-url')});if(response?.ok){setValue('proxy-protocol',response.proxy.protocol);setValue('proxy-host',response.proxy.host);setValue('proxy-port',response.proxy.port);setValue('proxy-username',response.proxy.username);setValue('proxy-password',response.proxy.password);setStatus('已从 API 提取代理。','success');}else setStatus(response?.error||'提取代理失败','error');}

  document.addEventListener('DOMContentLoaded',()=>{
    if (!document.documentElement.classList.contains('browser-settings-page')) return;
    window.bindAiFreeBrowserSettingsEvents({
      closeBrowserSettingsDialog, deleteBrowserHistory, el, extractProxy,
      getBrowserHistory: () => browserHistory,
      getSelectedHistoryId: () => selectedHistoryId,
      loadSettings, openDefaultBrowserSettings,
      randomIdentity, refreshBrowserHistory, resetSettings, saveSettings,
      scheduleBrowserHistoryRefresh, setSegment, setValue, syncConditionalFields,
      testProxy,
    });
    void refreshBrowserHistory({ silent: true });
  });
}());
