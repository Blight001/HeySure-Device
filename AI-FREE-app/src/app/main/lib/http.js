const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');

function getProxyAuthorization(proxyUrl) {
  if (!proxyUrl?.username && !proxyUrl?.password) return '';
  const username = decodeURIComponent(proxyUrl.username);
  const password = decodeURIComponent(proxyUrl.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

function createJsonRequestData(method, options) {
  const upperMethod = String(method || 'GET').toUpperCase();
  const payload = ['GET', 'HEAD'].includes(upperMethod) ? null : Buffer.from(JSON.stringify(options.data ?? {}));
  const customHeaders = options.headers && typeof options.headers === 'object' ? options.headers : {};
  return {
    method: upperMethod,
    payload,
    timeoutMs: Number(options.timeoutMs) || 15000,
    headers: {
      'Content-Type': 'application/json',
      ...customHeaders,
      ...(payload ? { 'Content-Length': payload.length } : {}),
    },
  };
}

function parseJsonResponse(raw) {
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function parseEventStreamData(raw) {
  try { return JSON.parse(raw); } catch (_) { return raw; }
}

function readJsonResponse(response, resolve, reject, abortedMessage = '响应连接已中断') {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    resolve({
      status: response.statusCode,
      ok: response.statusCode >= 200 && response.statusCode < 300,
      body: parseJsonResponse(raw),
      raw,
    });
  });
  response.on('aborted', () => reject(new Error(abortedMessage)));
  response.on('error', reject);
}

function configureRequest(request, requestData, reject) {
  request.on('error', reject);
  request.on('timeout', () => {
    try { request.destroy(); } catch (_) {}
    reject(new Error(`请求超时（${requestData.timeoutMs / 1000 | 0}秒）`));
  });
  if (requestData.payload) request.write(requestData.payload);
  request.end();
}

function requestHttpTargetViaProxy(targetUrl, proxyUrl, requestData, resolve, reject) {
  const proxyAuthorization = getProxyAuthorization(proxyUrl);
  const proxyLibrary = proxyUrl.protocol === 'https:' ? https : http;
  let request;
  request = proxyLibrary.request({
    hostname: proxyUrl.hostname,
    port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.href,
    method: requestData.method,
    timeout: requestData.timeoutMs,
    ...(proxyUrl.protocol === 'https:' ? { rejectUnauthorized: false } : {}),
    headers: {
      ...requestData.headers,
      Host: targetUrl.host,
      ...(proxyAuthorization ? { 'Proxy-Authorization': proxyAuthorization } : {}),
    },
  }, (response) => readJsonResponse(response, resolve, reject, '代理响应连接已中断'));
  configureRequest(request, requestData, reject);
}

function requestHttpsTargetViaProxy(targetUrl, proxyUrl, requestData, resolve, reject) {
  const proxyAuthorization = getProxyAuthorization(proxyUrl);
  const agent = new (/** @type {any} */ (HttpsProxyAgent))(proxyUrl, {
    rejectUnauthorized: false,
    headers: proxyAuthorization ? { 'Proxy-Authorization': proxyAuthorization } : {},
  });
  let request;
  request = https.request({
    hostname: targetUrl.hostname,
    port: targetUrl.port || 443,
    path: targetUrl.pathname + (targetUrl.search || ''),
    method: requestData.method,
    timeout: requestData.timeoutMs,
    rejectUnauthorized: false,
    agent,
    headers: requestData.headers,
  }, (response) => readJsonResponse(response, resolve, reject, '代理响应连接已中断'));
  configureRequest(request, requestData, reject);
}

function requestJsonOverHttpProxy(method, targetUrl, proxyUrl, options = {}) {
  const requestData = createJsonRequestData(method, options);
  return new Promise((resolve, reject) => {
    if (targetUrl.protocol === 'http:') {
      requestHttpTargetViaProxy(targetUrl, proxyUrl, requestData, resolve, reject);
    } else {
      requestHttpsTargetViaProxy(targetUrl, proxyUrl, requestData, resolve, reject);
    }
  });
}

function requestJsonDirect(method, targetUrl, options, resolve, reject) {
  const requestData = createJsonRequestData(method, options);
  const isHttps = targetUrl.protocol === 'https:';
  const library = isHttps ? https : http;
  let request;
  request = library.request({
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isHttps ? 443 : 80),
    path: targetUrl.pathname + (targetUrl.search || ''),
    method: requestData.method,
    timeout: requestData.timeoutMs,
    ...(isHttps ? { rejectUnauthorized: false } : {}),
    headers: requestData.headers,
  }, (response) => readJsonResponse(response, resolve, reject));
  configureRequest(request, requestData, reject);
}

function requestJson(method, url, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const targetUrl = new URL(url);
      const proxyServer = String(options.proxyServer || '').trim();
      if (proxyServer) {
        const proxyUrl = new URL(proxyServer);
        if (!['http:', 'https:'].includes(proxyUrl.protocol)) {
          throw new Error(`IP 探测暂不支持此代理协议: ${proxyUrl.protocol}`);
        }
        requestJsonOverHttpProxy(method, targetUrl, proxyUrl, options).then(resolve, reject);
        return;
      }
      requestJsonDirect(method, targetUrl, options, resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

function postJson(url, data, timeoutMs = 15000, options = {}) {
  return requestJson('POST', url, { ...options, data, timeoutMs });
}

function getJson(url, timeoutMs = 15000, options = {}) {
  if (timeoutMs && typeof timeoutMs === 'object') {
    options = timeoutMs || {};
    timeoutMs = Number(options.timeoutMs || 15000);
  }
  return requestJson('GET', url, { ...options, timeoutMs });
}

function createAbortError() {
  const error = new Error('AI 输出已停止');
  error.name = 'AbortError';
  return error;
}

function resolveInvalidEventStream(response, resolve) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = parseJsonResponse(raw);
    resolve({
      ok: false,
      status: response.statusCode,
      message: body?.message || body?.error || raw || `HTTP ${response.statusCode}`,
      ...(body && typeof body === 'object' ? body : {}),
    });
  });
}

function parseEventStreamBlock(block) {
  let type = 'message';
  const dataLines = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim() || 'message';
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  const raw = dataLines.join('\n');
  if (raw === '[DONE]') return null;
  return { type, data: parseEventStreamData(raw) };
}

class EventStreamReader {
  constructor(onEvent, resolve) {
    this.onEvent = onEvent;
    this.resolve = resolve;
    this.buffer = '';
    this.finalResult = null;
    this.streamError = null;
  }

  dispatch(block) {
    const event = parseEventStreamBlock(block);
    if (!event) return;
    if (event.type === 'result') this.finalResult = event.data;
    if (event.type === 'error') this.streamError = event.data;
    const payload = event.data && typeof event.data === 'object' ? event.data : { data: event.data };
    try { this.onEvent?.({ type: event.type, ...payload }); } catch (_) {}
  }

  push(chunk) {
    this.buffer = `${this.buffer}${chunk}`.replace(/\r\n/g, '\n');
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      if (block.trim()) this.dispatch(block);
      boundary = this.buffer.indexOf('\n\n');
    }
  }

  finish() {
    if (this.buffer.trim()) this.dispatch(this.buffer);
    this.resolve(this.finalResult || this.streamError || { ok: false, message: '流式响应意外结束' });
  }
}

function handleEventStreamResponse(response, onEvent, resolve, reject) {
  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  const valid = response.statusCode >= 200 && response.statusCode < 300 && contentType.includes('text/event-stream');
  if (!valid) return resolveInvalidEventStream(response, resolve);
  const reader = new EventStreamReader(onEvent, resolve);
  response.setEncoding('utf8');
  response.on('data', (chunk) => reader.push(chunk));
  response.on('end', () => reader.finish());
  response.on('aborted', () => reject(new Error('流式响应连接已中断')));
  response.on('error', reject);
}

function createEventStreamRequest(url, data, timeoutMs, options, resolve, reject) {
  const targetUrl = new URL(url);
  const isHttps = targetUrl.protocol === 'https:';
  const payload = Buffer.from(JSON.stringify(data ?? {}));
  const library = isHttps ? https : http;
  let request;
  request = library.request({
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isHttps ? 443 : 80),
    path: targetUrl.pathname + (targetUrl.search || ''),
    method: 'POST',
    timeout: Number(timeoutMs) || 180000,
    ...(isHttps ? { rejectUnauthorized: false } : {}),
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': payload.length,
    },
  }, (response) => handleEventStreamResponse(response, options.onEvent, resolve, reject));
  request.on('error', reject);
  request.on('timeout', () => {
    try { request.destroy(); } catch (_) {}
    reject(new Error(`请求超时（${Math.round((Number(timeoutMs) || 180000) / 1000)}秒）`));
  });
  options.signal?.addEventListener?.('abort', () => {
    try { request.destroy(createAbortError()); } catch (_) {}
  }, { once: true });
  request.write(payload);
  request.end();
}

function postEventStream(url, data, onEvent, timeoutMs = 180000, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      if (options?.signal?.aborted) return reject(createAbortError());
      createEventStreamRequest(url, data, timeoutMs, { ...options, onEvent }, resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

function httpGetUniversal(urlStr, timeoutMs = 10000, options = {}) {
  return requestJson('GET', urlStr, {
    ...options,
    timeoutMs,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  });
}

module.exports = { postJson, postEventStream, getJson, httpGetUniversal };
