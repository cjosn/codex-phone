// selftest.mjs — 用「dsh_client 的眼光」验证 dsh-host：握手 → mux → 建会话 → 发消息 → 审批 → turn/end
//
// 形状照 packages/dsh_client/test/support/fake_dsh.dart 与 fixtures 里的真机帧写，
// 所以这里过了，官方 App 的连接路径就没有结构性偏差。
//
//   node dsh-host/selftest.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = 13080;
const TOKEN = 'selftest-token';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ✓ ' + name);
  else { fails++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); }
};

const child = spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--backend', 'fake', '--port', String(PORT), '--token', TOKEN, '--cwd', ROOT], {
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
const stop = () => { try { child.kill(); } catch {} };
process.on('exit', stop);

async function waitHealth(ms = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(`${BASE}/`); if (r.status) return; } catch {}
    await sleep(120);
  }
  throw new Error('host 没起来:\n' + out);
}

try {
  console.log('1) launch-token 登录（应 303 + Set-Cookie）');
  await waitHealth();
  const login = await fetch(`${BASE}/?token=${TOKEN}`, { redirect: 'manual' });
  const setCookie = login.headers.get('set-cookie') || '';
  ok('303', login.status === 303, String(login.status));
  ok('Set-Cookie 带 dsh-auth-<sha256(authority)>', /dsh-auth-[A-Za-z0-9_-]{43}=v1\./.test(setCookie), setCookie.slice(0, 80));

  const cookie = setCookie.split(';')[0];
  const index = await fetch(`${BASE}/`, { headers: { cookie } });
  ok('带 cookie 拿首页 200', index.status === 200, String(index.status));
  const noCookie = await fetch(`${BASE}/`);
  ok('不带 cookie 401', noCookie.status === 401, String(noCookie.status));

  console.log('2) 一元 RPC');
  const rpc = async (endpoint, args = {}) => {
    const r = await fetch(`${BASE}/api/${endpoint}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', host: `127.0.0.1:${PORT}` },
      body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: endpoint, payload: { args } }),
    });
    const j = await r.json();
    return j.result;
  };
  const unauthed = await fetch(`${BASE}/api/session/list`, { method: 'POST', body: '{}' });
  ok('未授权 RPC 401', unauthed.status === 401, String(unauthed.status));

  const created = await rpc('session/create', { request: { title: '自测会话', cwd: ROOT } });
  ok('session/create 返回 sessionId', created?.ok === true && /^session-/.test(created.value?.sessionId || ''), JSON.stringify(created));
  const sid = created.value.sessionId;

  const listed = await rpc('session/list');
  ok('session/list 能列出刚建的会话', listed?.value?.items?.some((s) => s.sessionId === sid), JSON.stringify(listed).slice(0, 200));

  console.log('3) mux：$events ready + session/follow snapshot');
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/remote.mux?token=${TOKEN}`);
  const frames = [];
  let eventsStream = null, followStream = null;
  const follows = [];

  const wsReady = new Promise((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = (e) => rej(new Error('ws error'));
    setTimeout(() => rej(new Error('ws timeout')), 8000);
  });
  ws.onmessage = (m) => {
    const f = JSON.parse(m.data);
    frames.push(f);
    if (f.type === 'item') follows.push(f);
  };
  await wsReady;
  ok('mux 建连', true);

  const sendOpen = (streamId, endpoint, args) => ws.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));

  eventsStream = 'ev-' + crypto.randomUUID();
  sendOpen(eventsStream, '$events', {});
  await sleep(250);
  const ready = follows.find((f) => f.streamId === eventsStream && f.value?.type === 'ready');
  ok('$events 收到 ready', !!ready, JSON.stringify(follows.map((f) => f.value?.type)));
  ok('ready 带 clientId 与 host.home', !!ready?.value?.clientId && !!ready?.value?.host?.home, JSON.stringify(ready?.value));

  // 会话列表的实时刷新：mux 在线时新建会话，$events 必须吐出 api-session/added
  await rpc('session/create', { request: { title: '广播测试', cwd: ROOT } });
  await sleep(200);

  followStream = 'fu-' + crypto.randomUUID();
  sendOpen(followStream, 'session/follow', { request: { address: { kind: 'session', sessionId: sid } } });
  await sleep(300);
  const snap = follows.find((f) => f.streamId === followStream && f.value?.type === 'snapshot');
  ok('follow 收到 snapshot', !!snap, JSON.stringify(follows.filter((f) => f.streamId === followStream).map((f) => f.value?.type)));
  ok('snapshot.header 是 v4 且 id 对上', snap?.value?.header?.version === 4 && snap.value.header.id === sid, JSON.stringify(snap?.value?.header));
  ok('snapshot 带 cursor/records/projections/assistantStream',
    snap?.value?.cursor != null && Array.isArray(snap.value.records) && !!snap.value.projections?.values && snap.value.assistantStream != null,
    Object.keys(snap?.value || {}).join(','));
  ok('projections.values.title = 会话标题', snap?.value?.projections?.values?.title === '自测会话', snap?.value?.projections?.values?.title);

  console.log('4) 发一条 prompt，看事件序列');
  const prompt = await rpc('session/prompt', {
    request: { address: { kind: 'session', sessionId: sid }, content: [{ type: 'text', text: '帮我跑一下测试' }] },
  });
  ok('session/prompt accepted', prompt?.ok === true, JSON.stringify(prompt));

  // 审批：等 approval/requested 后回 accept
  let approved = false;
  for (let i = 0; i < 120 && !approved; i++) {
    const ap = follows.find((f) => f.streamId === followStream && f.value?.type === 'event' && f.value.event?.type === 'approval/requested');
    if (ap) {
      const approvalId = ap.value.event.data.approvalId;
      const r = await rpc('approval/respond', { sessionId: sid, approvalId, decision: 'accept' });
      ok('approval/respond 被接受', r?.ok === true, JSON.stringify(r));
      approved = true;
      break;
    }
    await sleep(150);
  }
  ok('收到 approval/requested 并已批准', approved);

  // 等 turn/end
  let ended = null;
  for (let i = 0; i < 120 && !ended; i++) {
    const e = follows.find((f) => f.streamId === followStream && f.value?.type === 'event' && f.value.event?.type === 'turn/end');
    if (e) ended = e.value.event;
    else await sleep(150);
  }
  ok('收到 turn/end', !!ended, JSON.stringify(ended));

  const evTypes = follows
    .filter((f) => f.streamId === followStream && f.value?.type === 'event')
    .map((f) => f.value.event.type);
  ok('事件里有 turn/start', evTypes.includes('turn/start'), evTypes.join(','));
  ok('事件里有 step/start', evTypes.includes('step/start'), evTypes.join(','));
  ok('事件里有 user/message', evTypes.includes('user/message'), evTypes.join(','));
  ok('事件里有 assistant/message', evTypes.includes('assistant/message'), evTypes.join(','));
  ok('事件里有 step/end', evTypes.includes('step/end'), evTypes.join(','));

  const streams = follows.filter((f) => f.streamId === followStream && f.value?.type === 'assistant-stream').map((f) => f.value.frame);
  ok('assistant-stream 有 start 帧', streams.some((f) => f.type === 'start'), JSON.stringify(streams.map((f) => f.type)));
  ok('assistant-stream 有 delta 帧', streams.some((f) => f.type === 'delta'), JSON.stringify(streams.map((f) => f.type)));
  ok('assistant-stream 有 end 帧', streams.some((f) => f.type === 'end'), JSON.stringify(streams.map((f) => f.type)));
  ok('delta 帧带 revision 且递增', streams.filter((f) => f.type === 'delta').every((f, i, a) => typeof f.revision === 'number' && (i === 0 || f.revision > a[i - 1].revision)));

  const asst = follows.find((f) => f.streamId === followStream && f.value?.type === 'event' && f.value.event?.type === 'assistant/message');
  ok('assistant/message 带文本', /12 passed|收到/.test(JSON.stringify(asst?.value?.event?.data ?? {})), JSON.stringify(asst?.value?.event?.data).slice(0, 160));

  const globalEmits = follows.filter((f) => f.streamId === eventsStream && f.value?.type === 'emit');
  ok('$events 有 api-session/added（会话列表靠它实时刷新）', globalEmits.some((f) => f.value.event === 'api-session/added'), JSON.stringify(globalEmits.map((f) => f.value.event)));

  ws.close();
  console.log(`\n共收到 ${follows.length} 个 mux item`);
} catch (e) {
  fails++;
  console.log('\n异常：', e.message);
  console.log('--- host 输出 ---\n' + out.slice(-2000));
} finally {
  stop();
}

console.log(fails === 0 ? '\n全部通过 ✓' : `\n${fails} 项失败 ✗`);
process.exit(fails === 0 ? 0 : 1);
