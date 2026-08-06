'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const parser = require('../../../src/app/main/features/account/account-import-parser');

test('cookie entries normalize aliases, flags, expiration and target URL', () => {
  assert.equal(parser.normalizeImportedCookieEntry('', ''), null);
  assert.equal(parser.normalizeImportedCookieEntry('invalid', ''), null);
  assert.deepEqual(parser.normalizeImportedCookieEntry('sid=value=rest', 'https://default.test'), {
    name: 'sid', value: 'value=rest', path: '/', url: 'https://default.test', secure: false, httpOnly: false,
  });
  const cookie = parser.normalizeImportedCookieEntry({
    Name: 'token', Value: 42, Domain: '.example.test', Path: '/app', Expires: '123',
    samesite: 'none', Secure: 'TRUE', http_only: 1,
  });
  assert.equal(cookie.url, 'https://example.test/');
  assert.equal(cookie.expirationDate, 123);
  assert.equal(cookie.sameSite, 'no_restriction');
  assert.equal(cookie.secure, true);
  assert.equal(cookie.httpOnly, true);
});

test('account import accepts JSON envelopes, Netscape rows and cookie headers', () => {
  const json = parser.parseImportedAccountContent(JSON.stringify({ data: {
    cookies: [{ name: 'sid', value: 'one' }],
    browserStorage: [{ url: 'https://app.test', localStorage: { key: 'value' } }],
  } }), 'https://default.test');
  assert.equal(json.cookies[0].name, 'sid');
  assert.equal(json.browserStorage.length, 1);
  const netscape = parser.parseImportedCookieContent('#HttpOnly_.example.test\tTRUE\t/\tTRUE\t123\tsid\tvalue', '');
  assert.equal(netscape[0].httpOnly, true);
  const header = parser.parseImportedCookieContent('sid=one; Path=/; token=two', 'https://default.test');
  assert.deepEqual(header.map((item) => item.name), ['sid', 'token']);
  assert.deepEqual(parser.parseImportedAccountContent('', ''), { cookies: [], browserStorage: [] });
});

test('target inference prioritizes storage, cookie URL, domain and fallback', () => {
  assert.equal(parser.inferImportedTargetUrl({ browserStorage: [{ origin: 'https://storage.test' }] }, ''), 'https://storage.test');
  assert.equal(parser.inferImportedTargetUrl({ cookies: [{ url: 'https://cookie.test' }] }, ''), 'https://cookie.test');
  assert.equal(parser.inferImportedTargetUrl({ cookies: [{ domain: '.domain.test' }] }, ''), 'https://domain.test/');
  assert.equal(parser.inferImportedTargetUrl(null, 'https://fallback.test'), 'https://fallback.test');
  assert.equal(parser.isPlaceholderTargetUrl('about:blank'), true);
  assert.equal(parser.isPlaceholderTargetUrl('https://mail.google.com'), true);
  assert.equal(parser.isPlaceholderTargetUrl('https://example.test'), false);
  assert.equal(parser.isPlaceholderTargetUrl('not a url'), false);
});
