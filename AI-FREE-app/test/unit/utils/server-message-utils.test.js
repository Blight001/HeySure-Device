'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const messages = require('../../../src/app/shared/server-message-utils');

test('server message type and text readers support every transport envelope', () => {
  const typeCases = [
    [{ message_type: 'UPDATE' }, 'update'], [{ messageType: 'Shutdown' }, 'shutdown'],
    [{ data: { message_type: 'A' } }, 'a'], [{ data: { messageType: 'B' } }, 'b'],
    [{ announcement: { message_type: 'C' } }, 'c'], [{ announcement: { messageType: 'D' } }, 'd'],
    [{ payload: { message_type: 'E' } }, 'e'], [{ payload: { messageType: 'F' } }, 'f'],
    [{}, ''],
  ];
  for (const [input, expected] of typeCases) assert.equal(messages.getServerMessageType(input), expected);
  const textCases = [
    [{ message: 'one' }, 'one'], [{ content: 'two' }, 'two'], [{ data: { message: 'three' } }, 'three'],
    [{ data: { content: 'four' } }, 'four'], [{ announcement: { message: 'five' } }, 'five'],
    [{ announcement: { content: 'six' } }, 'six'], [{}, ''],
  ];
  for (const [input, expected] of textCases) assert.equal(messages.getServerMessageText(input), expected);
});

test('update version reader supports current, legacy and raw aliases', () => {
  const fields = ['version', 'latest_version', 'latestVersion', 'targetVersion', 'target_version', 'update_version', 'updateVersion'];
  for (const field of fields) assert.equal(messages.getUpdateVersion({ [field]: ' 1.2.3 ' }), '1.2.3');
  for (const field of fields) assert.equal(messages.getUpdateVersion({ raw: { [field]: ' 2.0.0 ' } }), '2.0.0');
  assert.equal(messages.getUpdateVersion({}), '');
});

test('update and shutdown classification covers explicit types and announcement text', () => {
  for (const type of ['app_update', 'update', 'software_update', 'upgrade']) {
    assert.equal(messages.isUpdateLikeMessage({ type }), true);
    assert.equal(messages.isUpdateLikeMessage({ message_type: type }), true);
  }
  assert.equal(messages.isUpdateLikeMessage({ message_type: 'success', version: '1.0.0' }), true);
  assert.equal(messages.isUpdateLikeMessage({ message_type: 'success' }), false);
  assert.equal(messages.isUpdateLikeMessage({ type: 'announcement' }), false);
  assert.equal(messages.isShutdownAnnouncement({ type: 'announcement', message_type: 'shutdown' }), true);
  assert.equal(messages.isShutdownAnnouncement({ type: 'announcement', message: '软件暂时无法使用' }), true);
  assert.equal(messages.isShutdownAnnouncement({ type: 'announcement', content: '服务停用' }), true);
  assert.equal(messages.isShutdownAnnouncement({ type: 'notice', message_type: 'shutdown' }), false);
  assert.equal(messages.isShutdownAnnouncement({ type: 'announcement', content: '正常公告' }), false);
});
