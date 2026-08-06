'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  cookieHeader,
  createBrowserDownloadService,
} = require('../../../src/app/main/services/browser-download-service');

test('browser download saves into an AI workspace subdirectory with matching cookies only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-download-'));
  const requests = [];
  const service = createBrowserDownloadService({
    sandboxDir: root,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url, options) => {
      requests.push({ url: url.href, cookie: options.headers.Cookie });
      return new Response('download-data', {
        status: 200,
        headers: { 'content-disposition': 'attachment; filename="report.txt"' },
      });
    },
  });
  try {
    const result = await service.execute({
      action: 'download', url: 'https://files.example.test/private/report',
      directory: 'downloads/reports',
      cookies: [
        { name: 'session', value: 'secret', domain: '.example.test', path: '/', secure: true },
        { name: 'foreign', value: 'nope', domain: 'other.test', path: '/' },
      ],
    });
    assert.equal(fs.readFileSync(result.absolute_path, 'utf8'), 'download-data');
    assert.equal(result.relative_path, path.join('downloads', 'reports', 'report.txt'));
    assert.deepEqual(requests, [{
      url: 'https://files.example.test/private/report', cookie: 'session=secret',
    }]);
    assert.equal(fs.readdirSync(path.dirname(result.absolute_path)).some((name) => name.endsWith('.part')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('browser download forwards page headers and rejects HTML returned for a media URL', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-media-download-'));
  const requests = [];
  const service = createBrowserDownloadService({
    sandboxDir: root,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (_url, options) => {
      requests.push(options.headers);
      return new Response('<html>hotlink denied</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  try {
    await assert.rejects(service.execute({
      action: 'download',
      url: 'https://cdn.example.test/video.mp4',
      referer: 'https://www.example.test/watch/1',
      user_agent: 'AI-FREE Chromium',
      media_type: 'video',
    }), /非媒体内容/);
    assert.equal(requests[0].Referer, 'https://www.example.test/watch/1');
    assert.equal(requests[0]['User-Agent'], 'AI-FREE Chromium');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('browser download saves session JSON and rejects directories outside the workspace', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-session-download-'));
  const service = createBrowserDownloadService({ sandboxDir: root, fetchImpl: globalThis.fetch });
  const session = { pageUrl: 'https://example.test/', cookies: [{ name: 'sid', value: 'value' }] };
  try {
    const saved = await service.execute({ action: 'save_session', session, filename: 'example' });
    assert.deepEqual(JSON.parse(fs.readFileSync(saved.absolute_path, 'utf8')), session);
    assert.equal(saved.relative_path.startsWith(`sessions${path.sep}`), true);
    await assert.rejects(
      service.execute({ action: 'save_session', session, directory: '../outside' }),
      /超出 AI 工作区/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('cookie matching honors domain, path, secure and expiration', () => {
  const value = cookieHeader([
    { name: 'ok', value: '1', domain: '.example.test', path: '/files', secure: true },
    { name: 'host-only', value: '4', domain: 'example.test', path: '/', hostOnly: true },
    { name: 'path', value: '2', domain: 'example.test', path: '/admin' },
    { name: 'expired', value: '3', domain: 'example.test', path: '/', expirationDate: 1 },
  ], new URL('https://example.test/files/a.zip'));
  assert.equal(value, 'ok=1; host-only=4');
  assert.equal(cookieHeader([
    { name: 'host-only', value: '4', domain: 'example.test', path: '/', hostOnly: true },
  ], new URL('https://cdn.example.test/file.zip')), '');
});

test('browser download rematches cookies after redirects and removes oversized partial files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-redirect-download-'));
  const requests = [];
  const service = createBrowserDownloadService({
    sandboxDir: root,
    resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url, options) => {
      requests.push({ url: url.href, cookie: options.headers.Cookie || '' });
      if (url.hostname === 'source.example.test') {
        return new Response(null, { status: 302, headers: { location: 'https://other.test/file.bin' } });
      }
      return new Response('too-large', { status: 200 });
    },
  });
  try {
    await assert.rejects(service.execute({
      action: 'download', url: 'https://source.example.test/start', max_bytes: 4,
      cookies: [{ name: 'sid', value: 'secret', domain: 'source.example.test', path: '/' }],
    }), /超过大小限制/);
    assert.deepEqual(requests, [
      { url: 'https://source.example.test/start', cookie: 'sid=secret' },
      { url: 'https://other.test/file.bin', cookie: '' },
    ]);
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.part')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('browser download rejects localhost and private DNS answers before fetching', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-free-private-download-'));
  let fetched = false;
  const service = createBrowserDownloadService({
    sandboxDir: root,
    resolveHost: async () => [{ address: '192.168.1.20', family: 4 }],
    fetchImpl: async () => { fetched = true; return new Response('unsafe'); },
  });
  try {
    await assert.rejects(
      service.execute({ action: 'download', url: 'http://internal.example.test/secret' }),
      /私网/,
    );
    await assert.rejects(
      service.execute({ action: 'download', url: 'http://localhost/secret' }),
      /localhost/,
    );
    assert.equal(fetched, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
