const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { postEventStream } = require('../../src/app/main/lib/http');

test('流式 AI 请求可由 AbortSignal 立即停止', async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('event: reasoning_delta\ndata: {"delta":"正在思考"}\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const controller = new AbortController();
  const request = postEventStream(
    `http://127.0.0.1:${server.address().port}/chat`,
    {},
    () => controller.abort(),
    5000,
    { signal: controller.signal },
  );

  await assert.rejects(request, (error) => error?.name === 'AbortError');
});
