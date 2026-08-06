const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { httpGetUniversal } = require('../../src/app/main/lib/http');

test('HTTPS proxy detection sends TLS through the CONNECT tunnel instead of opening a direct socket', async () => {
  let tunnelReceivedTls = false;
  const proxy = http.createServer();
  proxy.on('connect', (_request, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', (chunk) => {
      // TLS records start with content type 0x16 for the ClientHello handshake.
      tunnelReceivedTls = chunk.length > 0 && chunk[0] === 0x16;
      socket.destroy();
    });
  });

  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  const { port } = proxy.address();

  try {
    await assert.rejects(
      httpGetUniversal('https://proxy-tunnel.invalid/trace', 1500, {
        proxyServer: `http://127.0.0.1:${port}`,
      }),
    );
    assert.equal(tunnelReceivedTls, true);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
  }
});
