// 真机同款链路的端到端验证（本机跑官方 codex 0.170）：
//   渠道 A 上建会话 → 切到渠道 B → 老会话被拒绝（channel/thread-binding）
//   → thread/fork 搬到 B → 同一段历史在 B 上继续，上游确实收到 B 的地址与模型。
// 用法：node test/codex-channel-rebind-real.mjs [--codex <path>]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const codexArg = argv.indexOf('--codex');
const CODEX = codexArg >= 0 ? argv[codexArg + 1] : path.resolve(ROOT, 'tooling/sdk/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const FIXTURE_KEY = 'codex-rebind-fixture-key';

function sendSse(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

// 两个前缀代表两个中转站：/pa/v1 与 /pb/v1。
async function makeUpstream() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = {};
    try { body = JSON.parse(raw); } catch { /* 记录原样 */ }
    const developerInput = (Array.isArray(body.input) ? body.input : []).filter(item => item?.role === 'developer').flatMap(item => (Array.isArray(item.content) ? item.content : [item.content]).map(part => typeof part === 'string' ? part : part?.text ?? ''));
    requests.push({ path: req.url, model: body.model ?? null, auth: req.headers.authorization ?? null, input: Array.isArray(body.input) ? body.input.length : 0, instructionText: [typeof body.instructions === 'string' ? body.instructions : '', ...developerInput].join('\n'), reasoningSummary: body.reasoning?.summary ?? null });
    if (req.method !== 'POST' || !/\/v1\/responses$/.test(req.url ?? '')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unexpected path' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' });
    res.flushHeaders?.();
    const message = { id: 'msg_rebind', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'rebind ok' }] };
    sendSse(res, { type: 'response.created', response: { id: 'resp_rebind', object: 'response', created_at: 1, status: 'in_progress', model: body.model ?? 'x', output: [] } });
    sendSse(res, { type: 'response.output_item.added', response_id: 'resp_rebind', output_index: 0, item: { id: 'msg_rebind', type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
    sendSse(res, { type: 'response.output_text.delta', response_id: 'resp_rebind', item_id: 'msg_rebind', output_index: 0, content_index: 0, delta: 'rebind ok' });
    sendSse(res, { type: 'response.output_item.done', response_id: 'resp_rebind', output_index: 0, item: message });
    sendSse(res, { type: 'response.completed', response: { id: 'resp_rebind', object: 'response', created_at: 1, status: 'completed', model: body.model ?? 'x', output: [message], usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 } } });
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, requests, port: server.address().port };
}

const testRoot = path.join(ROOT, 'tooling', 'sdk', 'user-state', 'local');
await mkdir(testRoot, { recursive: true });
const temp = await mkdtemp(path.join(testRoot, 'codex-rebind-'));
const home = path.join(temp, 'home');
await mkdir(home, { recursive: true });
const upstream = await makeUpstream();
const token = 'codex-rebind-fixture-token';

const env = {
  ...process.env,
  CODEX_HOME: home,
  LOCALAPPDATA: path.join(temp, 'local'),
  TEMP: path.join(temp, 'temp'),
  TMP: path.join(temp, 'temp'),
  NO_COLOR: '1',
  RUST_LOG: 'off',
};
await mkdir(env.TEMP, { recursive: true });

const child = spawn(process.execPath, [
  path.join(ROOT, 'bridge/server.mjs'),
  '--codex', CODEX,
  '--codex-home', home, '--cwd', home,
  '--toolpacks', path.join(home, 'no-builtin-packs'),
  '--plugins', path.join(home, 'no-builtin-plugins'),
  '--host', '127.0.0.1', '--port', '0', '--token', token,
], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

let output = '', stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-16000); });
child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-16000); });

const waitFor = async (check, label, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error(`bridge exited (${child.exitCode}): ${stderr}`);
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error(`timed out waiting for ${label}`);
};

const controller = new AbortController();
let streamTask = null;
const events = [];
let origin = null;
try {
  origin = await waitFor(async () => output.match(/codex-go: (http:\/\/127\.0\.0\.1:\d+)\//)?.[1], 'bridge launch');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const call = async (route, body) => {
    const response = await fetch(`${origin}/api/${route}`, {
      method: body === undefined ? 'GET' : 'POST', headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60000),
    });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (route, body) => {
    const result = await call(route, body);
    assert.equal(result.status, 200, `${route}: ${JSON.stringify(result.body)}`);
    return result.body;
  };

  const stream = await fetch(`${origin}/api/events?after=0`, { headers, signal: controller.signal });
  assert.equal(stream.status, 200);
  streamTask = (async () => {
    let pending = '';
    const decoder = new TextDecoder();
    for await (const bytes of stream.body) {
      pending += decoder.decode(bytes, { stream: true });
      let index;
      while ((index = pending.indexOf('\n\n')) >= 0) {
        const block = pending.slice(0, index);
        pending = pending.slice(index + 2);
        const data = block.split('\n').find((line) => line.startsWith('data: '));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) throw error; });

  // 两个渠道，都是 responses 直连本机 fixture（这样能看清 codex 实际打到哪）。
  await ok('channels/save', { id: 'relay-a', name: 'Relay A', baseUrl: `http://127.0.0.1:${upstream.port}/pa/v1`, wire: 'openai-responses', model: 'model-a', apiKey: FIXTURE_KEY });
  await ok('channels/save', { id: 'relay-b', name: 'Relay B', baseUrl: `http://127.0.0.1:${upstream.port}/pb/v1`, wire: 'openai-responses', model: 'model-b', apiKey: FIXTURE_KEY });
  assert.equal((await ok('channels/activate', { id: 'relay-a' })).active, 'relay-a');
  await ok('persona/save', { name: 'Real protocol probe', instructions: 'GLOBAL PERSONA MARKER', active: true });

  const created = await ok('thread/create', { cwd: home });
  assert.equal(created.channel, 'relay-a', 'thread/create must report its channel binding');

  await ok('turn/send', { threadId: created.threadId, text: 'first turn on relay A' });
  await waitFor(async () => events.some((event) => event.type === 'turn.end' && event.threadId === created.threadId && event.status === 'completed'), 'first turn completion', 60000);
  const firstRequests = upstream.requests.filter((request) => request.path.startsWith('/pa/'));
  assert.ok(firstRequests.length > 0, 'the first turn must reach relay A');
  assert.equal(firstRequests.at(-1).model, 'model-a');
  assert.match(firstRequests.at(-1).instructionText, /autonomous coding and device agent/);
  assert.match(firstRequests.at(-1).instructionText, /GLOBAL PERSONA MARKER/);
  assert.equal(firstRequests.at(-1).reasoningSummary, 'auto');

  // 切渠道：老会话继续发必须被拒绝（否则新模型名会打到旧上游）。
  assert.equal((await ok('channels/activate', { id: 'relay-b' })).active, 'relay-b');
  const refused = await call('turn/send', { threadId: created.threadId, text: 'should not reach relay A' });
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'channel/thread-binding');
  assert.equal(refused.body.error.details.boundChannel, 'relay-a');
  assert.equal(refused.body.error.details.activeChannel, 'relay-b');
  assert.equal(upstream.requests.filter((request) => request.path.startsWith('/pa/')).length, firstRequests.length, 'a refused send must not touch relay A');

  // fork 到 B：历史照抄，接着在 B 上跑。
  const forked = await ok('thread/fork', { threadId: created.threadId });
  assert.notEqual(forked.threadId, created.threadId);
  assert.equal(forked.modelProvider, 'relay-b');
  assert.equal(forked.model, 'model-b');
  const resumed = await ok('thread/resume', { threadId: forked.threadId });
  assert.equal(resumed.channel, 'relay-b', 'the forked thread is bound to the new channel');
  assert.ok(resumed.items.some((item) => item.type === 'agentMessage' && item.text.includes('rebind ok')), 'fork must keep the earlier conversation');

  await ok('turn/send', { threadId: forked.threadId, text: 'second turn on relay B' });
  await waitFor(async () => events.some((event) => event.type === 'turn.end' && event.threadId === forked.threadId && event.status === 'completed'), 'forked turn completion', 60000);
  const secondRequests = upstream.requests.filter((request) => request.path.startsWith('/pb/'));
  assert.ok(secondRequests.length > 0, 'the forked turn must reach relay B');
  assert.equal(secondRequests.at(-1).model, 'model-b');
  assert.equal(secondRequests.at(-1).reasoningSummary, 'auto');
  assert.equal(upstream.requests.filter((request) => request.path.startsWith('/pa/')).length, firstRequests.length, 'nothing new may reach relay A after the switch');
  assert.ok(secondRequests.at(-1).input > 1, 'the forked turn must replay the earlier conversation');

  console.log('Channel rebind E2E:', JSON.stringify({
    firstTurn: { path: firstRequests.at(-1).path, model: firstRequests.at(-1).model },
    refused: refused.body.error.code,
    fork: { from: created.threadId, to: forked.threadId, provider: forked.modelProvider },
    secondTurn: { path: secondRequests.at(-1).path, model: secondRequests.at(-1).model, input: secondRequests.at(-1).input },
    instructions: { default: true, initialPersona: true, reasoningSummary: secondRequests.at(-1).reasoningSummary },
  }));
} finally {
  controller.abort();
  await streamTask?.catch(() => {});
  if (child.exitCode === null) {
    const closed = once(child, 'close');
    if (origin) await fetch(`${origin}/api/bridge/stop`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    else child.kill();
    const timer = setTimeout(() => child.kill(), 8000);
    await closed;
    clearTimeout(timer);
  }
  upstream.server.close();
  if (process.exitCode) console.error('bridge stderr:', stderr);
  // Windows 上 codex 的 rollout 文件可能还没释放：清理失败不该让验证结果变红。
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
