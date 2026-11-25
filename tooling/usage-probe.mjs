// tooling/usage-probe.mjs — 抓一条 usage / context.usage 的原始 payload，确认分母分子。
const [base, token, text] = process.argv.slice(2);
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const post = async (route, body) => {
  const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  return response.json().catch(() => ({}));
};
const health = await (await fetch(`${base}/healthz`)).json();
const created = await post('thread/create', { cwd: '/root/workspace' });
const threadId = created.threadId;
const controller = new AbortController();
const stream = await fetch(`${base}/api/events?after=${health.seq}&threadId=${threadId}`, { headers, signal: controller.signal });
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
const timer = setTimeout(() => controller.abort(), 120000);
await post('turn/send', { threadId, text });
const seen = [];
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
      if (event.type === 'usage' || event.type === 'context.usage') seen.push(event);
      if (event.type === 'turn.end') { clearTimeout(timer); controller.abort(); break; }
    }
  }
} catch (error) { if (error.name !== 'AbortError') throw error; }
finally { clearTimeout(timer); }
console.log('samples:', seen.length);
for (const event of seen) console.log(event.type, JSON.stringify(event).slice(0, 700));
