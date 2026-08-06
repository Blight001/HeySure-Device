'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const response = require('../../../src/app/main/utils/license-response');

test('license response text extraction respects top-level and nested precedence', () => {
  assert.equal(response.pickFirstText('', '  first  ', 'second'), 'first');
  assert.equal(response.pickFirstText(null, 42), '');
  assert.equal(response.pickFirstValue(undefined, '', 0, 'later'), 0);
  assert.equal(response.pickFirstValue(null, '   ', false), false);
  assert.equal(response.extractNestedText({ message: 'top', data: { message: 'nested' } }), 'top');
  assert.equal(response.extractNestedText({ data: { error_description: 'nested error' } }), 'nested error');
  assert.equal(response.extractNestedText({ result: { reason: 'result reason' } }), 'result reason');
  assert.equal(response.extractNestedText({ payload: { detail: 'payload detail' } }), 'payload detail');
  assert.equal(response.extractNestedText({ announcement: { description: 'announcement' } }), 'announcement');
  assert.equal(response.extractNestedText(null), '');
});

test('license states normalize aliases and preserve unknown server states', () => {
  for (const state of ['active', 'SUCCESS', 'valid', 'enabled', 'normal', 'ok', 'passed', 'pass']) {
    assert.equal(response.extractValidationState({ state }), 'active');
  }
  for (const state of ['disabled', 'blocked', 'banned', 'revoked', 'forbidden', 'frozen', 'card_blocked']) {
    assert.equal(response.extractValidationState({ error_code: state }), 'disabled');
  }
  for (const state of ['expired', 'expire', 'overdue']) {
    assert.equal(response.extractValidationState({ data: { card_state: state } }), 'expired');
  }
  for (const state of ['not_found', 'missing', 'not_exist']) {
    assert.equal(response.extractValidationState({ result: { status: state } }), 'not_found');
  }
  assert.equal(response.extractValidationState({ payload: { code: 'pending_activation' } }), 'pending');
  assert.equal(response.extractValidationState({ code: 'maintenance' }), 'maintenance');
  assert.equal(response.extractValidationState({}), '');
  assert.equal(response.extractValidationState(null), '');
});

test('validation success and user-facing failures cover boolean and state responses', () => {
  assert.equal(response.isValidationSuccess({ valid: true }), true);
  assert.equal(response.isValidationSuccess({ is_valid: true }), true);
  assert.equal(response.isValidationSuccess({ success: true }), true);
  assert.equal(response.isValidationSuccess({ ok: true }), true);
  assert.equal(response.isValidationSuccess({ data: { state: 'active' } }), true);
  assert.equal(response.isValidationSuccess({ state: 'expired' }), false);
  assert.equal(response.isValidationSuccess(null), false);

  assert.equal(response.getValidationFailureMessage({ message: 'server detail' }), 'server detail');
  assert.equal(response.getValidationFailureMessage({ state: 'not_found' }), '账号不存在');
  assert.equal(response.getValidationFailureMessage({ state: 'expired' }), '账号会话已过期，请重新登录');
  assert.equal(response.getValidationFailureMessage({ state: 'disabled' }), '账号已被禁用');
  assert.equal(response.getValidationFailureMessage({ state: 'pending' }), '账号暂未生效');
  assert.equal(response.getValidationFailureMessage({ ok: false }, 'fallback'), 'fallback');
  assert.equal(response.getValidationFailureMessage({}, 'fallback'), 'fallback');
});
