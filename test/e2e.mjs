// e2e.mjs — 端到端自检：起 fake codex → 起 bridge → 建会话 → 发消息 → 收审批 → 批准 → 收 turn.end
//
// 跑法： node test/e2e.mjs
// 全部通过时退出码 0；任何一步失败打印原因并以 1 退出。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 18787;
const TOKEN = 'e2e-token';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const seen = [];
let failures = 0;

function check(name, cond, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${extra}`); }
}

async function api(route, body) {
  const r = await fetch(`${BASE}/api/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-codex-go-token': TOKEN },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${route}: HTTP ${r.status} ${JSON.stringify(j)}`);
  return j;
}

async function waitHealth(ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(150);
  }
  throw new Error('bridge 没起来');
}

function tail(s, n = 1200) { return s.length > n ? '…' + s.slice(-n) : s; }

const child = spawn(process.execPath, [
  path.join(ROOT, 'bridge', 'server.mjs'),
  '--mode', 'fake', '--port', String(PORT), '--token', TOKEN,
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

let bridgeOut = '';
child.stdout.on('data', (d) => { bridgeOut += d; });
child.stderr.on('data', (d) => { bridgeOut += d; });

const cleanup = () => { try { child.kill(); } catch {} };
process.on('exit', cleanup);

try {
  console.log('1) 起 bridge（fake codex）');
  const h = await waitHealth();
  check('healthz 返回 ok', h.ok === true, JSON.stringify(h));
  check('mode = fake', h.mode === 'fake', JSON.stringify(h.mode));

  console.log('2) 未带 token 的请求要被挡住');
  const unauth = await fetch(`${BASE}/api/thread/list`, { method: 'POST', body: '{}' });
  check('无 token → 401', unauth.status === 401, String(unauth.status));

  console.log('3) 建会话');
  const created = await api('thread/create', {});
  check('拿到 threadId', /^th_/.test(created.threadId || ''), JSON.stringify(created));

  console.log('4) 挂上 SSE');
  const ctrl = new AbortController();
  const sse = await fetch(`${BASE}/api/events?token=${TOKEN}&after=0`, { signal: ctrl.signal });
  check('SSE 200', sse.status === 200, String(sse.status));
  check('content-type 是 event-stream', /event-stream/.test(sse.headers.get('content-type') || ''));

  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let approved = false;

  (async () => {
    while (true) {
      let chunk;
      try { chunk = await reader.read(); } catch { break; }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let e; try { e = JSON.parse(line.slice(6)); } catch { continue; }
        seen.push(e);
        if (e.type === 'approval.request' && !approved) {
          approved = true;
          console.log('   · 收到审批请求，批准它');
          api('approval', { approvalId: e.approvalId, decision: 'accept' })
            .then((r) => console.log('   · 审批已回：', JSON.stringify(r)))
            .catch((err) => console.log('   · 审批失败：', err.message));
        }
      }
    }
  })();

  console.log('5) 发一条消息');
  const sent = await api('turn/send', { threadId: created.threadId, text: '帮我跑一下测试' });
  check('拿到 turnId', !!sent.turnId, JSON.stringify(sent));

  console.log('6) 等 turn.end（最多 30s）');
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && !seen.some((e) => e.type === 'turn.end')) await sleep(200);

  console.log('7) 断言事件序列');
  const types = seen.map((e) => e.type);
  check('收到 reasoning.delta', types.includes('reasoning.delta'), JSON.stringify(types));
  check('收到 text.delta', types.includes('text.delta'), JSON.stringify(types));
  check('收到 tool.start', types.includes('tool.start'), JSON.stringify(types));
  check('收到 approval.request', types.includes('approval.request'), JSON.stringify(types));
  check('收到 tool.output', types.includes('tool.output'), JSON.stringify(types));
  check('收到 tool.end', types.includes('tool.end'), JSON.stringify(types));
  check('收到 diff', types.includes('diff'), JSON.stringify(types));
  check('收到 turn.end', types.includes('turn.end'), JSON.stringify(types));

  const approval = seen.find((e) => e.type === 'approval.request');
  check('审批带 approvalId 与 command', !!approval?.approvalId && /npm test/.test(JSON.stringify(approval?.payload ?? {})),
    JSON.stringify(approval));

  const te = seen.find((e) => e.type === 'turn.end');
  check('turn.end 状态 completed', te?.status === 'completed', JSON.stringify(te));
  check('turn.end 带 usage', !!te?.usage, JSON.stringify(te));

  // 工具输出里应该有那条测试结果（证明审批通过后 fake 才继续跑）
  const toolOut = seen.filter((e) => e.type === 'tool.output').map((e) => e.chunk).join('');
  check('工具输出含 12 passed（审批通过后才执行）', /12 passed/.test(toolOut), toolOut.slice(0, 200));

  ctrl.abort();
  console.log(`\n共收到 ${seen.length} 个事件：${[...new Set(types)].join(', ')}`);
} catch (e) {
  failures++;
  console.log('\n异常：', e.message);
  console.log('--- bridge 输出 ---\n' + tail(bridgeOut));
} finally {
  cleanup();
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
