'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createHeySureFileMaterializer,
  normalizeFileRefs,
} = require('../../../src/app/main/features/ai-chat/heysure-file-materializer');

const REF = `file_${'a'.repeat(32)}`;

function fileResponse(data, overrides = {}) {
  const digest = overrides.digest || crypto.createHash('sha256').update(data).digest('hex');
  return new Response(data, {
    status: overrides.status || 200,
    headers: {
      'content-length': String(data.length),
      'x-heysure-file-ref': REF,
      'x-heysure-file-sha256': digest,
      'x-heysure-file-name': encodeURIComponent('报告.txt'),
    },
  });
}

function linkResponse(digest) {
  return new Response(JSON.stringify({
    links: [{
      file_ref: REF,
      url: 'https://heysure.example/api/tmp-files/fgrant_test/capability-token',
      sha256: digest,
    }],
    count: 1,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('HeySure 文件经鉴权下载、SHA-256 校验并物化到任务目录', async (t) => {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aifree-materialize-'));
  t.after(() => fs.rmSync(sandboxDir, { recursive: true, force: true }));
  const requests = [];
  const data = Buffer.from('server-file');
  const digest = crypto.createHash('sha256').update(data).digest('hex');
  const materialize = createHeySureFileMaterializer({
    sandboxDir,
    fetch: async (url, options) => {
      requests.push({ url: String(url), options });
      return options.method === 'POST' ? linkResponse(digest) : fileResponse(data);
    },
  });

  const paths = await materialize({
    server: 'https://heysure.example/base', token: 'private-token', aiConfigId: 19,
    taskId: 'task-1', refs: [REF],
  });

  assert.equal(requests[0].url, 'https://heysure.example/api/devices/files/links');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer private-token');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    ai_config_id: 19, file_refs: [REF], ttl_seconds: 300,
  });
  assert.equal(requests[1].url, 'https://heysure.example/api/tmp-files/fgrant_test/capability-token');
  assert.equal(requests[1].options.headers.Authorization, undefined);
  assert.equal(path.relative(sandboxDir, paths[0]), path.join('Incoming', 'task-1', '1-报告.txt'));
  assert.deepEqual(fs.readFileSync(paths[0]), data);
});

test('校验失败会拒绝文件并清理当前任务的部分落地内容', async (t) => {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aifree-materialize-bad-'));
  t.after(() => fs.rmSync(sandboxDir, { recursive: true, force: true }));
  const materialize = createHeySureFileMaterializer({
    sandboxDir,
    fetch: async (_url, options) => options.method === 'POST'
      ? linkResponse('0'.repeat(64))
      : fileResponse(Buffer.from('tampered'), { digest: '0'.repeat(64) }),
  });

  await assert.rejects(
    materialize({ server: 'https://heysure.example', token: 'token', aiConfigId: 19, taskId: 'bad-task', refs: [REF] }),
    /SHA-256/,
  );
  assert.equal(fs.existsSync(path.join(sandboxDir, 'Incoming', 'bad-task')), false);
});

test('file_ref 与本地路径混用或引用重复时在下载前拒绝', () => {
  assert.throws(() => normalizeFileRefs({ file_ref: REF, path: 'local.txt' }), /不能.*混用/);
  assert.throws(() => normalizeFileRefs({ file_refs: [REF, REF] }), /重复/);
});
