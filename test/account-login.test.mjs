import assert from 'node:assert/strict';
import {test} from 'node:test';
import {completeLocalOAuthCallback, validateChatgptCallback} from '../bridge/account-login.mjs';

test('manual ChatGPT callback accepts only the official loopback listener', () => {
  const valid = validateChatgptCallback('http://127.0.0.1:1455/auth/callback?code=fixture&state=fixture');
  assert.equal(valid.pathname, '/auth/callback');
  assert.equal(validateChatgptCallback('http://localhost:1455/final?state=fixture').hostname, 'localhost');
  for (const value of [
    '', 'not a url', 'https://127.0.0.1:1455/auth/callback?code=x',
    'http://example.com:1455/auth/callback?code=x', 'http://127.0.0.1:1456/auth/callback?code=x',
    'http://user:pass@127.0.0.1:1455/auth/callback?code=x', 'http://127.0.0.1:1455/auth/callback',
  ]) assert.throws(() => validateChatgptCallback(value), error => error.code === 'account/callback-url' && error.status === 400);
});

test('completion returns only status and never echoes callback or response secrets', async () => {
  let requested;
  const secret = 'fixture-oauth-secret';
  const result = await completeLocalOAuthCallback(`http://127.0.0.1:1455/auth/callback?code=${secret}&state=x`, async url => {
    requested = url;
    return new Response('secret response body', {status: 200});
  });
  assert.equal(requested.searchParams.get('code'), secret);
  assert.deepEqual(result, {status: 200, ok: true});
  assert(!JSON.stringify(result).includes(secret));
  const rejected = await completeLocalOAuthCallback('http://127.0.0.1:1455/auth/callback?error=denied', async () => new Response('no', {status: 403}));
  assert.deepEqual(rejected, {status: 403, ok: false});
});
