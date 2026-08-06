'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

let loadBehavior = 'success';
const windows = [];

class FakeDownloadItem extends EventEmitter {
  constructor() {
    super();
    this.savePath = '';
  }
  getFilename() { return 'release.zip'; }
  getReceivedBytes() { return 50; }
  getTotalBytes() { return 100; }
  setSavePath(value) { this.savePath = value; }
}

class FakeWebContents extends EventEmitter {
  constructor(owner) {
    super();
    this.owner = owner;
    this.session = new EventEmitter();
    this.url = '';
    this.inputs = [];
    this.windowOpenHandler = null;
  }
  executeJavaScript() {
    return Promise.resolve({ tagName: 'button', text: '下载', x: 100, y: 60, width: 80, height: 30 });
  }
  focus() {}
  getURL() { return this.url; }
  sendInputEvent(event) {
    this.inputs.push(event);
    if (event.type !== 'mouseUp') return;
    const item = new FakeDownloadItem();
    this.owner.downloadItem = item;
    this.session.emit('will-download', {}, item);
    setImmediate(() => {
      item.emit('updated');
      item.emit('done', {}, 'completed');
    });
  }
  setWindowOpenHandler(handler) { this.windowOpenHandler = handler; }
}

class FakeBrowserWindow {
  constructor(options) {
    this.options = options;
    this.destroyed = false;
    this.progress = [];
    this.titles = [];
    this.webContents = new FakeWebContents(this);
    windows.push(this);
  }
  close() { this.destroyed = true; }
  focus() {}
  isDestroyed() { return this.destroyed; }
  loadURL(url) {
    this.webContents.url = url;
    if (loadBehavior === 'reject') return Promise.reject(new Error('load failed'));
    setImmediate(() => {
      if (loadBehavior === 'render-gone') this.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
      else this.webContents.emit('did-finish-load');
    });
    return Promise.resolve();
  }
  moveTop() {}
  setProgressBar(value) { this.progress.push(value); }
  setTitle(value) { this.titles.push(value); }
  show() {}
  showInactive() {}
}

const electronPath = require.resolve('electron');
const targetPath = require.resolve('../../../src/app/main/features/updates/update-download-page');
require.cache[electronPath] = { exports: {
  BrowserWindow: FakeBrowserWindow,
  app: { getPath: () => '' },
  shell: { openPath: async () => '' },
} };
delete require.cache[targetPath];
const { openDownloadPageAndAutoClick } = require(targetPath);

test.beforeEach(() => {
  loadBehavior = 'success';
  windows.length = 0;
});

test('download page clicks the visible target and resolves completed downloads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-download-page-'));
  const progress = [];
  try {
    const result = await openDownloadPageAndAutoClick({
      url: 'https://download.test/view/release',
      saveDir: root,
      logger: silentLogger(),
      onProgress: (event) => progress.push(event),
      showWindow: true,
    });
    const win = windows[0];
    assert.equal(result.suggestedName, 'release.zip');
    assert.equal(result.savePath, path.join(root, 'release.zip'));
    assert.equal(win.downloadItem.savePath, result.savePath);
    assert.deepEqual(win.webContents.inputs.map((event) => event.type), ['mouseMove', 'mouseDown', 'mouseUp']);
    assert.equal(progress[0].phase, 'downloading');
    assert.equal(progress[0].percent, 50);
    assert.equal(win.progress.includes(0.5), true);
    assert.match(win.titles.at(-1), /50%/);
    assert.equal(win.destroyed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('window-open navigation is reused and renderer failures reject cleanly', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-download-page-fail-'));
  try {
    loadBehavior = 'render-gone';
    const pending = openDownloadPageAndAutoClick({
      url: 'https://download.test/view/release',
      saveDir: root,
      logger: silentLogger(),
      allowAutoClickOnAnyPage: true,
    });
    await assert.rejects(pending, /进程异常退出: crashed/);
    assert.equal(windows[0].destroyed, true);

    loadBehavior = 'reject';
    await assert.rejects(openDownloadPageAndAutoClick({
      url: 'https://download.test/view/release',
      saveDir: root,
      logger: silentLogger(),
    }), /load failed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid page inputs fail before creating a BrowserWindow', async () => {
  await assert.rejects(openDownloadPageAndAutoClick({ url: '', saveDir: 'x' }), /地址为空/);
  await assert.rejects(openDownloadPageAndAutoClick({ url: 'https://download.test', saveDir: '' }), /未指定下载目录/);
  assert.equal(windows.length, 0);
});

function silentLogger() {
  return { warn() {} };
}
