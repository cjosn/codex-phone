// 证据脚本：用官方 codex 0.170 真实二进制跑「同一 thread 换 model / 换 provider」，
// 记录上游实际收到的 model 与 base_url 路径。只回答一个问题：
//   切换渠道（provider）后，老 thread 的下一回合到底打到哪、带什么 model？
// 用法：node test/codex-thread-model-probe.mjs [--codex <path>]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const codexArg = argv.indexOf('--codex');
const CODEX = codexArg >= 0 ? argv[codexArg + 1]
  : path.resolve(ROOT, 'tooling/sdk/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe');

const log = (...values) => console.log(...values);

function sendSse(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

// 一个上游，两个前缀：/pa/v1 与 /pb/v1 代表两个不同中转站。
async function makeUpstream() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 记录原样即可 */ }
    requests.push({ path: req.url, model: body.model ?? null, auth: req.headers.authorization ?? null });
    if (req.method !== 'POST' || !/\/v1\/responses$/.test(req.url)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unexpected path' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' });
    res.flushHeaders?.();
    const message = { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'probe ok' }] };
    sendSse(res, { type: 'response.created', response: { id: 'resp_probe', object: 'response', created_at: 1, status: 'in_progress', model: body.model ?? 'probe', output: [] } });
    sendSse(res, { type: 'response.output_item.added', response_id: 'resp_probe', output_index: 0, item: { id: 'msg_probe', type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
    sendSse(res, { type: 'response.output_text.delta', response_id: 'resp_probe', item_id: 'msg_probe', output_index: 0, content_index: 0, delta: 'probe ok' });
    sendSse(res, { type: 'response.output_item.done', response_id: 'resp_probe', output_index: 0, item: message });
    sendSse(res, { type: 'response.completed', response: { id: 'resp_probe', object: 'response', created_at: 1, status: 'completed', model: body.model ?? 'probe', output: [message], usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 } } });
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, requests, port: server.address().port };
}

class AppServer {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.messages = [];
    this.stderr = '';
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        this.messages.push(message);
        if (message.id == null) continue;
        const waiting = this.pending.get(String(message.id));
        if (!waiting) continue;
        clearTimeout(waiting.timer);
        this.pending.delete(String(message.id));
        if (message.error) waiting.reject(Object.assign(new Error(message.error.message), { rpc: message.error }));
        else waiting.resolve(message.result);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
  }
  call(method, params = {}, timeout = 60000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(String(id)); reject(new Error(`RPC timeout ${method}`)); }, timeout);
      this.pending.set(String(id), { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ method, params })}\n`); }
  async close() {
    for (const value of this.pending.values()) clearTimeout(value.timer);
    this.pending.clear();
    if (this.child.exitCode == null) {
      const closed = once(this.child, 'close');
      this.child.stdin.end();
      setTimeout(() => this.child.kill(), 4000).unref();
      await closed;
    }
  }
}

function waitForTurn(rpc, threadId, turnId, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`turn ${turnId} timed out`)); }, timeout);
    const start = rpc.messages.length;
    const poll = setInterval(() => {
      const recent = rpc.messages.slice(start);
      const done = recent.find((m) => m.method === 'turn/completed' && m.params?.threadId === threadId && m.params?.turn?.id === turnId);
      if (done) { cleanup(); resolve(done.params.turn); return; }
      const failed = recent.find((m) => m.method === 'error' && m.params?.threadId === threadId && m.params?.turnId === turnId);
      if (failed) { cleanup(); reject(new Error(`turn failed: ${JSON.stringify(failed.params.error ?? failed.params)}`)); }
    }, 25);
    function cleanup() { clearTimeout(timer); clearInterval(poll); }
  });
}

const temp = await mkdtemp(path.join(ROOT, 'tooling', 'sdk', 'user-state', 'local', 'model-probe-'));
const home = path.join(temp, 'home');
await mkdir(home, { recursive: true });
const upstream = await makeUpstream();
const port = upstream.port;
const env = {
  ...process.env,
  CODEX_HOME: home,
  LOCALAPPDATA: path.join(temp, 'local'),
  TEMP: path.join(temp, 'temp'),
  TMP: path.join(temp, 'temp'),
  NO_COLOR: '1',
  RUST_LOG: 'off',
  PROBE_KEY: 'probe-key-only',
};
await mkdir(env.TEMP, { recursive: true });
await writeFile(path.join(home, 'config.toml'), [
  'model = "model-a"',
  'model_provider = "pa"',
  'approval_policy = "never"',
  'sandbox_mode = "danger-full-access"',
  '',
  '[model_providers.pa]',
  'name = "Provider A"',
  `base_url = "http://127.0.0.1:${port}/pa/v1"`,
  'wire_api = "responses"',
  'env_key = "PROBE_KEY"',
  '',
  '[model_providers.pb]',
  'name = "Provider B"',
  `base_url = "http://127.0.0.1:${port}/pb/v1"`,
  'wire_api = "responses"',
  'env_key = "PROBE_KEY"',
  '',
].join('\n'), { mode: 0o600 });

const child = spawn(CODEX, ['app-server'], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const rpc = new AppServer(child);
const findings = {};
const lastRequest = () => upstream.requests.at(-1) ?? null;
const turn = async (label, threadId, params) => {
  const before = upstream.requests.length;
  const started = await rpc.call('turn/start', { threadId, input: [{ type: 'text', text: label }], ...params });
  const turnId = started.turn?.id;
  const finished = await waitForTurn(rpc, threadId, turnId);
  const fresh = upstream.requests.slice(before);
  findings[label] = { status: finished.status, requests: fresh };
  log(label, '->', JSON.stringify({ status: finished.status, requests: fresh.map((r) => ({ path: r.path, model: r.model })) }));
  return finished;
};

try {
  const init = await rpc.call('initialize', { clientInfo: { name: 'codex-go-probe', version: '0.1.0' }, capabilities: { experimentalApi: true } }, 60000);
  rpc.notify('initialized');
  log('initialize:', init.userAgent ?? '(no userAgent)');

  // 1) 建 thread 时用 pa/model-a，跑一回合
  const thread = (await rpc.call('thread/start', { cwd: temp, model: 'model-a', modelProvider: 'pa' })).thread;
  await turn('1-start-a', thread.id, {});

  // 2) 同一 thread，turn/start 显式换 model（同 provider）
  await turn('2-turn-model-b', thread.id, { model: 'model-b' });

  // 3) 再跑一回合，不带 model：thread 记住的是 model-b 还是 model-a？
  await turn('3-no-model-after-override', thread.id, {});

  // 4) 模拟「切渠道」：直接改 config（等于 applyChannelConfig 的 batchWrite）
  await rpc.call('config/batchWrite', {
    edits: [
      { keyPath: 'model_providers.pb', value: { name: 'Provider B', base_url: `http://127.0.0.1:${port}/pb/v1`, wire_api: 'responses', env_key: 'PROBE_KEY' }, mergeStrategy: 'replace' },
      { keyPath: 'model_provider', value: 'pb', mergeStrategy: 'replace' },
      { keyPath: 'model', value: 'model-c', mergeStrategy: 'replace' },
    ],
    reloadUserConfig: true,
  });
  await turn('4-after-provider-switch-no-model', thread.id, {});
  await turn('5-after-provider-switch-model-c', thread.id, { model: 'model-c' });

  // 6) 修复候选：thread/resume 时带上 model + modelProvider，再跑
  await rpc.call('config/batchWrite', {
    edits: [
      { keyPath: 'model_provider', value: 'pa', mergeStrategy: 'replace' },
      { keyPath: 'model', value: 'model-a', mergeStrategy: 'replace' },
    ],
    reloadUserConfig: true,
  });
  const resumed = await rpc.call('thread/resume', { threadId: thread.id, model: 'model-d', modelProvider: 'pa' });
  findings['6-resume-response'] = { model: resumed.model ?? null, modelProvider: resumed.modelProvider ?? null };
  log('thread/resume({model:model-d, modelProvider:pa}) ->', JSON.stringify(findings['6-resume-response']));
  await turn('6-turn-after-resume-model-d', thread.id, {});
} catch (error) {
  log('PROBE ERROR:', error.message, rpc.stderr.slice(-1500));
  process.exitCode = 1;
} finally {
  await rpc.close();
  upstream.server.close();
  await rm(temp, { recursive: true, force: true });
  log('FINDINGS:', JSON.stringify(findings, null, 1));
}
