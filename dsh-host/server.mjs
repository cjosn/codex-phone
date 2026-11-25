// dsh-host/server.mjs — 让「官方 dsh-go App」直接连 Codex 的兼容宿主
//
// 它不是新 App，而是一个**冒充 dsh web 的 host**：把 dsh_client 用的那四个
// 载体端点（launch-token 登录 / cookie / POST /api/<endpoint> / WS /api/remote.mux）
// 实现一遍，底下换成 codex。形状照 packages/dsh_client/test/fixtures 里真机
// 抓的帧写（dsh web 0.2.0-rc.2，2026-10-23）。
//
// 于是：手机装官方 dsh-go APK → 主机填本机地址 → 得到 Codex 移动端。
// App 一行不用改，也不用重新编译。
//
//   node dsh-host/server.mjs --backend fake --port 3080
//   node dsh-host/server.mjs --backend app-server --codex codex --port 3080
//
// 已实现的最小面（够聊天、流式、审批、会话列表）：
//   GET  /?token=…            303 + Set-Cookie（dsh-auth-<sha256(authority)>）
//   GET  /                    200 占位页
//   POST /api/session/{list,create,prompt,cancel,rename}
//   POST /api/workspace/initializeDefault
//   POST /api/llm/listProviders, agentPresets/list, permissionPresets/catalog
//   WS   /api/remote.mux      $events ready/emit + session/follow（snapshot/event/assistant-stream）

import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { normalize } from '../bridge/adapter.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const PORT = Number(arg('port', '3080'));
const HOST = arg('host', '0.0.0.0');
const BACKEND = arg('backend', 'fake');           // fake | app-server
const CODEX = arg('codex', 'codex');
const CWD = arg('cwd', process.cwd());
const VERBOSE = argv.includes('--verbose');
const TOKEN = arg('token', crypto.randomBytes(8).toString('hex'));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// ------------------------------------------------------------------ cookie
function cookieNameFor(authority) {
  const h = crypto.createHash('sha256').update(authority).digest('base64url');
  return `dsh-auth-${h}`;
}
const COOKIE_VALUE = 'v1.' + crypto.randomBytes(18).toString('base64url') + '.' + crypto.randomBytes(16).toString('base64url');

// ------------------------------------------------------------------ WebSocket（手写，零依赖）
function wsAccept(key) {
  return crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
}
function wsFrame(str, opcode = 0x1) {
  const payload = Buffer.from(str, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}
class WsConn {
  constructor(socket) { this.socket = socket; this.buf = Buffer.alloc(0); this.open = true; this.onText = null; this.onClose = null; }
  start() {
    this.socket.on('data', (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      for (;;) {
        const b = this.buf;
        if (b.length < 2) return;
        const opcode = b[0] & 0x0f;
        const masked = (b[1] & 0x80) !== 0;
        let len = b[1] & 0x7f, off = 2;
        if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
        const need = off + (masked ? 4 : 0) + len;
        if (b.length < need) return;
        let payload = b.subarray(need - len, need);
        if (masked) {
          const mask = b.subarray(off, off + 4);
          const copy = Buffer.from(payload);
          for (let i = 0; i < copy.length; i++) copy[i] ^= mask[i & 3];
          payload = copy;
        }
        this.buf = b.subarray(need);
        if (opcode === 0x8) { this.close(); return; }
        if (opcode === 0x9) { this.socket.write(wsFrame('', 0xa)); continue; }
        if (opcode === 0x1) { try { this.onText?.(JSON.parse(payload.toString('utf8'))); } catch (e) { log('bad ws frame:', e.message); } }
      }
    });
    this.socket.on('close', () => this.close());
    this.socket.on('error', () => this.close());
  }
  send(obj) { if (this.open) { try { this.socket.write(wsFrame(JSON.stringify(obj))); } catch { this.close(); } } }
  close() { if (!this.open) return; this.open = false; try { this.socket.end(wsFrame('', 0x8)); } catch {} this.onClose?.(); }
}

// ------------------------------------------------------------------ Codex 后端（JSON-RPC over stdio）
class CodexProc {
  constructor() { this.pending = new Map(); this.id = 1; this.proc = null; this.approvals = new Map(); this.onEvent = () => {}; }
  start() {
    const [cmd, args] = BACKEND === 'fake'
      ? [process.execPath, [path.resolve(HERE, '..', 'bridge', 'fake-codex.mjs')]]
      : [CODEX, ['app-server']];
    this.proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd) });
    this.proc.on('error', (e) => log('codex spawn failed:', e.message));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { if (VERBOSE) log('codex:', String(d).trim().slice(0, 200)); });
    readline.createInterface({ input: this.proc.stdout.setEncoding('utf8') }).on('line', (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.id != null && (m.result !== undefined || m.error !== undefined)) {
        const p = this.pending.get(m.id); if (!p) return;
        this.pending.delete(m.id);
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        return;
      }
      if (m.id != null && m.method) {           // 审批：server→client request
        for (const e of normalize(m.method, m.params || {}, { isRequest: true, requestId: m.id })) {
          if (e.type === 'approval.request') this.approvals.set(e.approvalId, m.id);
          this.onEvent(e);
        }
        return;
      }
      if (m.method) for (const e of normalize(m.method, m.params || {}, { verbose: VERBOSE })) this.onEvent(e);
    });
    return this.request('initialize', { clientInfo: { name: 'dsh-host', version: '0.1.0' } }, 8000)
      .catch((e) => log('initialize 失败（真 codex 方法名可能变了）:', e.message));
  }
  request(method, params, timeout = 20000) {
    const id = this.id++;
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error('rpc timeout ' + method)); }, timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); res(v); }, reject: (e) => { clearTimeout(t); rej(e); } });
    });
  }
  respond(id, result) { this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
}

// ------------------------------------------------------------------ 会话与事件
class Host {
  constructor() {
    this.codex = new CodexProc();
    this.sessions = new Map();       // sessionId -> {id, title, cwd, createdAt, events:[], seq, turn, threads}
    this.muxes = new Set();          // 活跃的 ws 连接
    this.current = new Map();        // sessionId -> 正在跑的 codexThreadId
    this.codex.onEvent = (e) => this.onCodexEvent(e);
  }

  async start() { await this.codex.start(); }

  newSession({ title = 'Codex 会话', cwd = CWD } = {}) {
    const id = 'session-' + crypto.randomUUID();
    const s = {
      id, title, cwd, createdAt: Date.now(), seq: 0, turn: 0,
      events: [{ type: 'permission/preset', seq: 0, time: Date.now(), data: { preset: 'workspace-write' } }],
      codexThreadId: null,
      watchers: new Set(),
      tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
    s.seq = 1;
    this.sessions.set(id, s);
    this.emitGlobal('api-session/added', [{ sessionId: id, updatedAt: s.createdAt, cwd, title }]);
    return s;
  }

  emitGlobal(name, args) {
    for (const m of this.muxes) {
      const sid = m.mux?.eventsStreamId;
      if (sid) m.item(sid, { type: 'emit', event: name, args });
    }
  }

  pushEvent(s, type, data) {
    const ev = { type, seq: s.seq++, time: Date.now(), data };
    s.events.push(ev);
    for (const w of s.watchers) w.event(ev);
    return ev;
  }

  async prompt(s, text) {
    s.turn += 1;
    this.pushEvent(s, 'turn/start', { turn: s.turn });
    this.pushEvent(s, 'step/start', { turn: s.turn, step: 1 });
    this.pushEvent(s, 'user/message', { turn: s.turn, step: 1, content: [{ type: 'text', text }] });

    // 先把活动绑定立起来：codex 的事件可能在 await 之后立刻到，路由要靠它
    s.activeDsh = { turn: s.turn, step: 1, text: '' };
    this.current.set(s.id, true);

    if (!s.codexThreadId) {
      const created = await this.codex.request('thread/start', { cwd: s.cwd }).catch((e) => { log('thread/start:', e.message); return null; });
      s.codexThreadId = created?.threadId ?? 't_local';
    }
    const turnId = `turn_${Date.now()}`;
    for (const w of s.watchers) w.assistantStart(s.turn, 1, turnId);

    const started = await this.codex.request('turn/start', {
      threadId: s.codexThreadId, input: [{ type: 'text', text }],
    }).catch((e) => { log('turn/start:', e.message); return null; });

    s.activeTurnId = started?.turnId ?? turnId;
    return s.activeTurnId;
  }

  onCodexEvent(e) {
    // codex 的事件没有 session 绑定，这里按"最近一个活动的 session"路由
    const s = this.activeSession();
    if (!s) return;
    const dsh = s.activeDsh;
    switch (e.type) {
      case 'text.delta': {
        if (!dsh) break;
        for (const w of s.watchers) w.assistantFrame({ type: 'delta', attemptId: `${s.id}:${dsh.turn}`, revision: (w.rev = (w.rev || 0) + 1), turn: dsh.turn, step: dsh.step, text: e.text });
        dsh.text += e.text || '';
        break;
      }
      case 'reasoning.delta':
        for (const w of s.watchers) w.assistantFrame({ type: 'reasoning', attemptId: `${s.id}:${dsh?.turn ?? 1}`, revision: (w.rev = (w.rev || 0) + 1), turn: dsh?.turn ?? 1, step: dsh?.step ?? 1, text: e.text });
        break;
      case 'tool.start':
        this.pushEvent(s, 'tool/call', { turn: dsh?.turn ?? 1, step: dsh?.step ?? 1, toolCallId: e.itemId, name: e.name, input: e.args });
        break;
      case 'tool.output':
        this.pushEvent(s, 'tool/result', { turn: dsh?.turn ?? 1, step: dsh?.step ?? 1, toolCallId: e.itemId, output: e.chunk });
        break;
      case 'tool.end':
        this.pushEvent(s, 'tool/end', { turn: dsh?.turn ?? 1, step: dsh?.step ?? 1, toolCallId: e.itemId, status: e.status });
        break;
      case 'diff':
        this.pushEvent(s, 'tool/call', { turn: dsh?.turn ?? 1, step: dsh?.step ?? 1, toolCallId: e.itemId, name: 'apply_patch', input: { patch: e.patch } });
        break;
      case 'approval.request':
        this.pushEvent(s, 'approval/requested', {
          approvalId: e.approvalId, kind: e.kind, payload: e.payload,
          turn: dsh?.turn ?? 1, step: dsh?.step ?? 1,
        });
        break;
      case 'turn.end': {
        if (dsh?.text) this.pushEvent(s, 'assistant/message', { turn: dsh.turn, step: dsh.step, message: { role: 'assistant', content: [{ type: 'text', text: dsh.text }] } });
        for (const w of s.watchers) w.assistantFrame({ type: 'end', attemptId: `${s.id}:${dsh?.turn ?? 1}`, revision: (w.rev = (w.rev || 0) + 1), turn: dsh?.turn ?? 1, step: dsh?.step ?? 1 });
        this.pushEvent(s, 'step/end', { turn: dsh?.turn ?? 1, step: dsh?.step ?? 1 });
        this.pushEvent(s, 'turn/end', { turn: dsh?.turn ?? 1, reason: (e.status === 'completed' ? 'completed' : e.status) });
        s.activeDsh = null;
        this.current.delete(s.id);
        break;
      }
      default: break;
    }
  }

  activeSession() {
    for (const id of this.current.keys()) { const s = this.sessions.get(id); if (s?.activeDsh) return s; }
    for (const s of this.sessions.values()) if (s.watchers.size) return s;
    return null;
  }

  respondApproval(sessionId, approvalId, decision) {
    const reqId = this.codex.approvals.get(String(approvalId));
    if (reqId != null) {
      this.codex.respond(reqId, { decision: decision === 'decline' ? 'decline' : decision === 'acceptForSession' ? 'acceptForSession' : 'accept' });
      this.codex.approvals.delete(String(approvalId));
      return { accepted: true };
    }
    return { accepted: false };
  }
}

// ------------------------------------------------------------------ follow 流
class Follow {
  constructor(conn, streamId, s) {
    this.conn = conn; this.streamId = streamId; this.s = s; this.rev = 0;
    this.assistantStreamActive = true;
  }
  item(value) { this.conn.send({ type: 'item', streamId: this.streamId, value }); }

  emitSnapshot() {
    const s = this.s;
    this.item({
      type: 'snapshot',
      header: { version: 4, id: s.id, createdAt: s.createdAt, cwd: s.cwd, isSeeded: false, agentPreset: 'standard' },
      cursor: s.seq,
      records: s.events.map((e) => ({ type: 'event', event: e })),
      hasMore: false,
      projections: {
        asOfSeq: s.seq,
        values: {
          title: s.title,
          goal: null,
          tokenUsage: s.tokenUsage,
          contextPressure: {},
          contextBreakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
          inbox: { 'next-turn': [], 'next-step': [] },
          sessionStatus: 'idle',
        },
      },
      assistantStream: { revision: this.rev },
    });
  }

  event(ev) { this.item({ type: 'event', event: ev }); }
  assistantStart(turn, step, attemptId) {
    this.rev += 1;
    this.item({ type: 'assistant-stream', frame: { type: 'start', attemptId: `${this.s.id}:${turn}`, revision: this.rev, turn, step, startedAfterSeq: this.s.seq } });
  }
  assistantFrame(frame) { this.rev += 1; this.item({ type: 'assistant-stream', frame: { ...frame, revision: this.rev } }); }
}

// ------------------------------------------------------------------ HTTP
const host = new Host();

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function cookieOk(req) {
  const raw = req.headers.cookie || '';
  const authority = req.headers.host || '';
  const want = `${cookieNameFor(authority)}=${COOKIE_VALUE}`;
  return raw.split(';').map((x) => x.trim()).includes(want);
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

const RPC = {
  'session/list': () => ({
    items: [...host.sessions.values()].map((s) => ({
      sessionId: s.id, title: s.title, cwd: s.cwd, createdAt: s.createdAt, updatedAt: s.createdAt, status: 'idle',
    })),
  }),
  'session/create': (args) => {
    const s = host.newSession({ title: args?.request?.title || 'Codex 会话', cwd: args?.request?.cwd || CWD });
    return { sessionId: s.id, agentPreset: 'standard' };
  },
  'session/prompt': async (args) => {
    const sid = args?.request?.address?.sessionId ?? args?.sessionId;
    const s = host.sessions.get(sid);
    if (!s) return { ok: false, error: { code: 'session/not-found', message: sid } };
    const text = (args?.request?.content || args?.request?.blocks || [])
      .filter((b) => b?.type === 'text').map((b) => b.text).join('\n') || args?.request?.text || '';
    const turnId = await host.prompt(s, text);
    return { accepted: true, turnId };
  },
  'session/cancel': (args) => {
    const sid = args?.request?.address?.sessionId ?? args?.sessionId;
    const s = host.sessions.get(sid);
    if (s) { host.codex.request('turn/interrupt', { threadId: s.codexThreadId }).catch(() => {}); }
    return { accepted: true };
  },
  'session/rename': (args) => {
    const sid = args?.request?.address?.sessionId ?? args?.sessionId;
    const s = host.sessions.get(sid);
    if (s) { s.title = args?.request?.title ?? s.title; host.emitGlobal('api-session/added', [{ sessionId: s.id, updatedAt: Date.now(), cwd: s.cwd, title: s.title }]); }
    return { title: s?.title ?? '', seq: s?.seq ?? 0 };
  },
  'workspace/initializeDefault': () => ({ ok: true }),
  'llm/listProviders': () => ([{ id: 'codex', name: 'Codex', configured: true }]),
  'llm/listConfigurableProviders': () => ([{ id: 'codex', name: 'Codex', configured: true }, { id: 'openai', name: 'OpenAI', configured: false }]),
  'agentPresets/list': () => ({ presets: [{ id: 'standard', name: 'Standard' }] }),
  'permissionPresets/catalog': () => ({ options: [{ id: 'workspace-write' }, { id: 'read-only' }, { id: 'danger-full-access' }], defaultOptions: { 'workspace-write': true }, defaultPreset: 'workspace-write' }),
  'credentials/describe': (args) => (Object.fromEntries((args?.refs || []).map((r) => [r, { present: true }]))),
  'session/modelCatalog': () => ({ default: 'codex', routableProviders: ['codex'], groups: [], failures: [] }),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 1) launch-token 登录
  if (url.pathname === '/' && req.method === 'GET' && url.searchParams.has('token')) {
    if (url.searchParams.get('token') !== TOKEN) { res.writeHead(401); return res.end('bad token'); }
    const name = cookieNameFor(req.headers.host || '');
    res.writeHead(303, {
      location: './',
      'set-cookie': `${name}=${COOKIE_VALUE}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`,
    });
    return res.end();
  }

  // 2) 占位首页（App 只用它确认 cookie 有效）
  if (url.pathname === '/' && req.method === 'GET') {
    res.writeHead(cookieOk(req) ? 200 : 401, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><title>codex-go host</title><h1>codex-go</h1>');
  }

  // 3) mux 走 server.on('upgrade')，不在这里（HTTP handler 里 writeHead(101) 不是合法握手）
  if (url.pathname === '/api/remote.mux') { res.writeHead(400); return res.end('websocket only'); }

  // 4) 一元 RPC
  if (url.pathname.startsWith('/api/')) {
    if (!cookieOk(req)) { res.writeHead(401); return res.end('unauthorized'); }
    const endpoint = url.pathname.slice('/api/'.length);
    const envelope = await readJson(req);
    const args = envelope?.payload?.args ?? envelope?.args ?? {};
    const handler = RPC[endpoint];
    if (!handler) {
      log('未实现的 endpoint:', endpoint);
      return json(res, 200, { type: 'server-response', rpcId: envelope?.rpcId, result: { ok: false, error: { code: 'gateway/method-not-allowed', message: endpoint, details: {} } } });
    }
    try {
      const value = await handler(args);
      if (value && value.ok === false) return json(res, 200, { type: 'server-response', rpcId: envelope?.rpcId, result: value });
      return json(res, 200, { type: 'server-response', rpcId: envelope?.rpcId, result: { ok: true, value } });
    } catch (e) {
      log('endpoint 失败', endpoint, e.message);
      return json(res, 200, { type: 'server-response', rpcId: envelope?.rpcId, result: { ok: false, error: { code: 'gateway/internal', message: String(e.message), details: {} } } });
    }
  }

  res.writeHead(404); res.end();
});

// ------------------------------------------------------------------ WebSocket upgrade（mux）
server.on('upgrade', (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/api/remote.mux') { socket.destroy(); return; }
  // App 带 cookie；脚本可以退化成 ?token=（同一把 launch token）
  const authed = cookieOk(req) || url.searchParams.get('token') === TOKEN;
  if (!authed) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return; }
  const accept = wsAccept(req.headers['sec-websocket-key'] || '');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const conn = new WsConn(socket);
  conn.mux = { eventsStreamId: null, follows: new Map() };
  conn.item = (streamId, value) => conn.send({ type: 'item', streamId, value });
  host.muxes.add(conn);

  conn.onClose = () => {
    host.muxes.delete(conn);
    for (const f of conn.mux.follows.values()) f.s.watchers.delete(f);
    log(`mux closed (clients=${host.muxes.size})`);
  };

  conn.onText = (frame) => {
    if (frame.type !== 'open') return;
    const { streamId, endpoint, payload } = frame;
    if (endpoint === '$events') {
      conn.mux.eventsStreamId = streamId;
      conn.item(streamId, { type: 'ready', clientId: 'codex-go-' + crypto.randomUUID().slice(0, 8), host: { home: CWD } });
      return;
    }
    if (endpoint === 'session/follow') {
      const sid = payload?.args?.request?.address?.sessionId ?? payload?.args?.sessionId;
      const s = host.sessions.get(sid);
      if (!s) { conn.send({ type: 'error', streamId, error: { code: 'session/not-found', message: String(sid) } }); return; }
      const f = new Follow(conn, streamId, s);
      s.watchers.add(f);
      conn.mux.follows.set(streamId, f);
      f.emitSnapshot();
      return;
    }
    if (endpoint === 'workspace/follow') { conn.item(streamId, { type: 'snapshot', workspaces: [] }); return; }
    conn.send({ type: 'error', streamId, error: { code: 'gateway/method-not-allowed', message: endpoint } });
  };

  conn.start();
  log(`mux open (clients=${host.muxes.size})`);
});

// ------------------------------------------------------------------ boot
// 审批回执走一元 endpoint（App 的 approvals API）
RPC['approval/respond'] = (args) => host.respondApproval(args?.sessionId, args?.approvalId, args?.decision);

(async () => {
  await host.start();
  server.listen(PORT, HOST, () => {
    log('codex-go dsh-host up');
    log(`  backend  ${BACKEND}`);
    log(`  token    ${TOKEN}`);
    log(`  本机     http://127.0.0.1:${PORT}/?token=${TOKEN}`);
    log('  手机 dsh-go App：主机填上面这个地址（局域网换成本机 IP）');
  });
})();

process.on('SIGINT', () => { log('bye'); process.exit(0); });
