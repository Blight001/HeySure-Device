'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  attachHeySureDownloadedFile,
  createHeySureFileUploader,
  resolveSandboxFile,
} = require('../../../src/app/main/features/ai-chat/heysure-file-uploader');

function temporaryWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heysure-upload-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('HeySure uploader only accepts files inside AI-Workspace', (t) => {
  const root = temporaryWorkspace(t);
  const outside = path.join(path.dirname(root), 'outside-image.png');
  fs.writeFileSync(outside, 'outside');
  t.after(() => fs.rmSync(outside, { force: true }));

  assert.throws(() => resolveSandboxFile(root, outside), /工作区/);
});

test('HeySure uploader posts a bounded workspace file and validates file_ref', async (t) => {
  const root = temporaryWorkspace(t);
  const image = path.join(root, 'cat.jpg');
  fs.writeFileSync(image, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const calls = [];
  const upload = createHeySureFileUploader({
    sandboxDir: root,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return {
        ok: true, status: 200,
        json: async () => ({
          file_ref: `file_${'a'.repeat(32)}`,
          workspace_path: 'Uploads/cat.jpg', mime_type: 'image/jpeg',
          can_send_to_user: true,
        }),
      };
    },
  });

  const result = await upload({
    server: 'https://heysure.example/base', token: 'secret', aiConfigId: 7,
    localPath: image, sessionId: 'chat-1',
  });

  assert.equal(result.file_ref, `file_${'a'.repeat(32)}`);
  assert.equal(calls[0].url, 'https://heysure.example/api/chat/attachments/upload');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].init.body.get('ai_config_id'), '7');
  assert.equal(calls[0].init.body.get('session_id'), 'chat-1');
  assert.equal(calls[0].init.body.get('file').name, 'cat.jpg');
});

test('HeySure uploader streams videos larger than the old 30 MB image-oriented limit', async (t) => {
  const root = temporaryWorkspace(t);
  const video = path.join(root, 'clip.mp4');
  fs.writeFileSync(video, 'video');
  fs.truncateSync(video, 31 * 1024 * 1024);
  let uploadedFile;
  const upload = createHeySureFileUploader({
    sandboxDir: root,
    fetch: async (_url, init) => {
      uploadedFile = init.body.get('file');
      return {
        ok: true, status: 200,
        json: async () => ({
          file_ref: `file_${'c'.repeat(32)}`,
          workspace_path: 'Uploads/clip.mp4', mime_type: 'video/mp4',
          can_send_to_user: false,
        }),
      };
    },
  });

  const result = await upload({
    server: 'https://heysure.example', token: 'secret', aiConfigId: 7,
    localPath: video, sessionId: 'chat-video',
  });

  assert.equal(uploadedFile.name, 'clip.mp4');
  assert.equal(uploadedFile.size, 31 * 1024 * 1024);
  assert.equal(result.mime_type, 'video/mp4');
});

test('download result gains file_ref and a view-image next action', async () => {
  const fileRef = `file_${'b'.repeat(32)}`;
  const result = await attachHeySureDownloadedFile({
    sourceName: 'browser_file', args: { action: 'download_element' },
    result: { success: true, absolute_path: 'C:/AI-Workspace/cat.jpg' },
    server: 'https://heysure.example', token: 'secret', aiConfigId: 9,
    upload: async () => ({
      file_ref: fileRef, workspace_path: 'Uploads/cat.jpg',
      mime_type: 'image/jpeg', can_send_to_user: true,
    }),
  });

  assert.equal(result.uploaded_to_heysure, true);
  assert.equal(result.file_ref, fileRef);
  assert.match(result.next_action, /view_image/);
});

test('failed server upload preserves successful local download result', async () => {
  const result = await attachHeySureDownloadedFile({
    sourceName: 'browser_file', args: { action: 'download' },
    result: { success: true, absolute_path: 'C:/AI-Workspace/cat.jpg' },
    upload: async () => { throw new Error('network unavailable'); },
  });

  assert.equal(result.success, true);
  assert.equal(result.uploaded_to_heysure, false);
  assert.match(result.server_upload_error, /network unavailable/);
});
