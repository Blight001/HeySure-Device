'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { getJson, httpGetUniversal, postEventStream, postJson } = require('../../src/app/main/lib/http');

let server;
let baseUrl;
test.before(async () => {
  server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      if (request.url === '/json') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ method: request.method, accept: request.headers.accept || '', body: Buffer.concat(chunks).toString() }));
      } else if (request.url === '/plain') {
        response.writeHead(418, { 'content-type': 'text/plain' }); response.end('teapot');
      } else if (request.url === '/sse') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': comment\n\n');
        response.write('event: delta\ndata: {"text":"hello"}\n\n');
        response.write('event: note\ndata: plain\ndata: text\n\n');
        response.write('event: nullable\ndata: null\n\n');
        response.write('data: [DONE]\n\n');
        response.end('event: result\ndata: {"ok":true,"answer":42}\n\n');
      } else if (request.url === '/sse-error') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('event: error\ndata: {"ok":false,"message":"stream failed"}');
      } else if (request.url === '/bad-stream') {
        response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ message: 'bad request', code: 'BAD' }));
      } else {
        response.writeHead(404); response.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => new Promise((resolve) => server.close(resolve)));

test('JSON helpers support GET overloads, headers, POST bodies and non-JSON errors', async () => {
  const get = await getJson(`${baseUrl}/json`, { timeoutMs: 1000, headers: { 'x-fixture': 'yes' } });
  assert.equal(get.ok, true);
  assert.equal(get.body.method, 'GET');
  const universal = await httpGetUniversal(`${baseUrl}/json`, 1000);
  assert.equal(universal.body.accept, 'application/json');
  const post = await postJson(`${baseUrl}/json`, { value: 1 }, 1000);
  assert.equal(post.body.method, 'POST');
  assert.deepEqual(JSON.parse(post.body.body), { value: 1 });
  const plain = await getJson(`${baseUrl}/plain`, 1000);
  assert.deepEqual({ status: plain.status, ok: plain.ok, body: plain.body, raw: plain.raw }, { status: 418, ok: false, body: null, raw: 'teapot' });
  await assert.rejects(getJson('not a url'), /Invalid URL/);
  await assert.rejects(getJson(`${baseUrl}/json`, 1000, { proxyServer: 'socks5://127.0.0.1:1' }), /暂不支持/);
});

test('event stream parser emits JSON and text events and returns final result', async () => {
  const events = [];
  const result = await postEventStream(`${baseUrl}/sse`, { prompt: 'hello' }, (event) => events.push(event), 1000);
  assert.deepEqual(result, { ok: true, answer: 42 });
  assert.deepEqual(events.map((event) => event.type), ['delta', 'note', 'nullable', 'result']);
  assert.equal(events[1].data, 'plain\ntext');
  assert.equal(events[2].data, null);
  const error = await postEventStream(`${baseUrl}/sse-error`, {}, null, 1000);
  assert.deepEqual(error, { ok: false, message: 'stream failed' });
});

test('event stream handles HTTP errors, pre-abort and callback failures', async () => {
  const bad = await postEventStream(`${baseUrl}/bad-stream`, {}, null, 1000);
  assert.deepEqual(bad, { ok: false, status: 400, message: 'bad request', code: 'BAD' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(postEventStream(`${baseUrl}/sse`, {}, null, 1000, { signal: controller.signal }), (error) => error.name === 'AbortError');
  const result = await postEventStream(`${baseUrl}/sse`, {}, () => { throw new Error('consumer failure'); }, 1000);
  assert.equal(result.ok, true);
  await assert.rejects(postEventStream('invalid', {}, null, 1000), /Invalid URL/);
});
