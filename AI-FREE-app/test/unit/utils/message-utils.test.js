'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { sanitizeUserFacingMessage } = require('../../../src/app/shared/message-utils');

test('user-facing message sanitizer removes cookie terminology and normalizes whitespace', () => {
  assert.equal(sanitizeUserFacingMessage(''), '账号分配失败');
  assert.equal(sanitizeUserFacingMessage(null, 'fallback'), 'fallback');
  assert.equal(sanitizeUserFacingMessage('获取 Cookie\r\n失败'), '获取账号信息 失败');
  assert.equal(sanitizeUserFacingMessage('Cookie 获取失败'), '账号信息获取失败');
  assert.equal(sanitizeUserFacingMessage('cookies unavailable'), '账号信息 unavailable');
  assert.equal(sanitizeUserFacingMessage('cookie'), '账号信息');
  assert.equal(sanitizeUserFacingMessage('  ready   now  '), 'ready now');
});
