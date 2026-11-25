// Real phone bridge probe: create an isolated two-turn thread, revert the second turn,
// then read durable history again. This never runs git or file rollback commands.
import assert from 'node:assert/strict';
const [base, token] = process.argv.slice(2);
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function post(path, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) throw Error(`${path} ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}
async function history(threadId) {
  const value = await post('/api/thread/resume', { threadId });
  return value.items ?? [];
}
async function turn(threadId, text) {
  const sent = await post('/api/turn/send', { threadId, text });
  const deadline = Date.now() + 90000;
  for (;;) {
    await delay(300);
    const items = await history(threadId);
    const completed = items.some(item => item.turnId === sent.turnId && item.type === 'agentMessage');
    if (completed) return { turnId: sent.turnId, items };
    if (Date.now() > deadline) throw Error(`Timed out waiting for ${sent.turnId}`);
  }
}
const created = await post('/api/thread/create', { cwd: '/root/workspace', developerInstructions: 'For this isolated history probe, answer each request with only the requested marker. Do not use tools.' });
const threadId = created.threadId;
try {
  const first = await turn(threadId, 'Reply with only FIRST_HISTORY_MARKER');
  const second = await turn(threadId, 'Reply with only SECOND_HISTORY_MARKER');
  assert.equal(second.items.length > first.items.length, true);
  await post('/api/thread/revert', { threadId, beforeTurnId: second.turnId });
  const reverted = await history(threadId);
  const serialized = JSON.stringify(reverted);
  assert(serialized.includes('FIRST_HISTORY_MARKER'));
  assert(!serialized.includes('SECOND_HISTORY_MARKER'));
  console.log('REVERT_RESULT ' + JSON.stringify({ threadId, beforeTurnId: second.turnId, beforeItems: second.items.length, afterItems: reverted.length, firstKept: true, secondRemoved: true, filesUntouched: true }));
} finally {
  await post('/api/thread/delete', { threadId }).catch(() => {});
}
