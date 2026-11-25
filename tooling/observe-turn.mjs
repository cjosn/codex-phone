// tooling/observe-turn.mjs — 在真机上新建一个会话、发一条消息、把 SSE 事件与最终屏幕打出来。
// 用法: node tooling/observe-turn.mjs <baseUrl> <token> "<text>" [--tool screen]
const [base, token, text, ...rest] = process.argv.slice(2);
if (!base || !token || !text) {
  console.error('usage: node tooling/observe-turn.mjs <baseUrl> <token> "<text>"');
  process.exit(2);
}
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const post = async (route, body) => {
  const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const health = await (await fetch(`${base}/healthz`)).json();
const created = await post('thread/create', { cwd: '/root/workspace' });
const threadId = created.body.threadId;
console.log('thread', threadId, 'seq', health.seq);

const controller = new AbortController();
const stream = await fetch(`${base}/api/events?after=${health.seq}&threadId=${threadId}`, { headers, signal: controller.signal });
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
const counts = new Map();
const interesting = [];
const timer = setTimeout(() => controller.abort(), 180000);

const sent = await post('turn/send', { threadId, text });
console.log('turn/send', sent.status, JSON.stringify(sent.body));

try {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const line = block.split('\n').find(item => item.startsWith('data: '));
      if (!line) continue;
      let event;
      try { event = JSON.parse(line.slice(6)); } catch { continue; }
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      if (['approval.request', 'item.start', 'item.end', 'tool.start', 'tool.end', 'plan.updated', 'error'].includes(event.type)
          && interesting.length < 40) {
        interesting.push({
          type: event.type,
          kind: event.kind ?? null,
          name: event.name ?? event.itemType ?? null,
          status: event.status ?? null,
          reason: event.payload?.reason ?? event.message ?? null,
        });
      }
      if (event.type === 'turn.end') {
        console.log('turn.end', event.status, event.error?.message ?? '');
        clearTimeout(timer);
        controller.abort();
        break;
      }
    }
  }
} catch (error) {
  if (error.name !== 'AbortError') throw error;
} finally {
  clearTimeout(timer);
}

console.log('event counts:', JSON.stringify(Object.fromEntries([...counts].sort())));
console.log('interesting events:');
for (const item of interesting) console.log(' ', JSON.stringify(item));
console.log('THREAD', threadId);
