// 临时探针：抓 bridge 推出来的审批事件，核对 approvalId / payload 形状
const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const TOKEN = process.argv[3] || 'dev';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (route, body) => {
  const r = await fetch(`${BASE}/api/${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-codex-go-token': TOKEN },
    body: JSON.stringify(body || {}),
  });
  return r.json();
};

const ctrl = new AbortController();
const sse = await fetch(`${BASE}/api/events?token=${TOKEN}&after=0`, { signal: ctrl.signal });
const reader = sse.body.getReader();
const dec = new TextDecoder();
let buf = '';
const got = [];

(async () => {
  while (true) {
    let c; try { c = await reader.read(); } catch { break; }
    if (c.done) break;
    buf += dec.decode(c.value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try { got.push(JSON.parse(line.slice(6))); } catch {}
    }
  }
})();

const t = await api('thread/create', {});
await api('turn/send', { threadId: t.threadId, text: 'probe' });
await sleep(2500);

const aps = got.filter((e) => e.type === 'approval.request');
console.log('approval.request 条数 =', aps.length);
for (const a of aps) console.log('  ', JSON.stringify(a));

const ac = aps[0];
if (ac) console.log('批准 →', JSON.stringify(await api('approval', { approvalId: ac.approvalId, decision: 'accept' })));
await sleep(2500);
console.log('事件类型序列 =', got.map((e) => e.type).join(','));
ctrl.abort();
process.exit(0);
