// Manual completion for the official local ChatGPT OAuth listener.
// The callback contains short-lived OAuth state; never log or persist it.
export function validateChatgptCallback(value) {
  if (typeof value !== 'string' || !value.trim()) throw Object.assign(new Error('Paste the complete callback URL from the browser'), {code: 'account/callback-url', status: 400});
  let url;
  try { url = new URL(value.trim()); } catch { throw Object.assign(new Error('Callback must be a complete URL'), {code: 'account/callback-url', status: 400}); }
  const localHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const port = url.port || '80';
  if (url.protocol !== 'http:' || !localHost || port !== '1455' || url.username || url.password) {
    throw Object.assign(new Error('Only the official http://127.0.0.1:1455 callback is accepted'), {code: 'account/callback-url', status: 400});
  }
  if (!url.search) throw Object.assign(new Error('The callback is missing its OAuth query parameters'), {code: 'account/callback-url', status: 400});
  return url;
}

export async function completeLocalOAuthCallback(value, fetchImpl = fetch) {
  const url = validateChatgptCallback(value);
  let response;
  try {
    response = await fetchImpl(url, {redirect: 'manual', signal: AbortSignal.timeout(15000), headers: {accept: 'text/html,application/json'}});
  } catch (error) {
    throw Object.assign(new Error(`The local OAuth listener could not be reached: ${error.message}`), {code: 'account/callback-unreachable', status: 502});
  }
  // Do not return the response body: it can contain account or token data.
  return {status: response.status, ok: response.ok};
}
