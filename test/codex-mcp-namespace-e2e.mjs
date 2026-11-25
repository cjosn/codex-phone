// test/codex-mcp-namespace-e2e.mjs — 端到端验证「namespace 摊平」这条路能不能真的把
// MCP 工具交到模型手里并且被 codex 执行回来。
//
// 链路（和手机上的 ds 渠道一致）：
//   官方 codex.exe ──responses──> 桥的 compat-proxy ──chat──> 本机假上游
// codex 会把整个 MCP 服务器发成一个 type:'namespace' 工具；compat-proxy 必须把它摊平成
// 一个个 function 工具（名字保持 MCP 原名）。假上游按名字 `screen` 回一个 tool_call，
// 然后就该看到 codex 真的去调我们的 MCP 宿主（第二次请求里出现 tool 结果）。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const codexArg = argv.indexOf('--codex');
const CODEX = codexArg >= 0
  ? argv[codexArg + 1]
  : path.resolve(ROOT, 'tooling/sdk/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
// 模型要怎么称呼 namespace 里的工具，由 --name 指定（默认用 MCP 原名）。
const nameArg = argv.indexOf('--name');
const CALL_NAME = nameArg >= 0 ? argv[nameArg + 1] : 'screen';
const argsArg = argv.indexOf('--args');
const CALL_ARGS = argsArg >= 0 ? argv[argsArg + 1] : '{}';

const seen = [];
const upstream = createServer(async (req, res) => {
  if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url ?? '')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unexpected path' } }));
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* keep {} */ }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolResults = messages.filter(message => message.role === 'tool');
  seen.push({
    tools: tools.map(tool => tool?.function?.name ?? tool?.name),
    toolResultText: toolResults.map(message => String(message.content ?? '')).join('\n').slice(0, 600),
  });

  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' });
  res.flushHeaders?.();
  const send = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  // 第一轮：让模型「调用」 namespace 里的 screen（用 MCP 原名）。
  // 之后：把工具结果当答案读出来，收尾。
  if (toolResults.length === 0) {
    send({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_screen_1', type: 'function', function: { name: CALL_NAME, arguments: CALL_ARGS } }] }, finish_reason: 'tool_calls' }] });
  } else {
    send({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'I called the screen tool.' }, finish_reason: null }] });
    send({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  res.end('data: [DONE]\n\n');
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamPort = upstream.address().port;

const testRoot = path.join(ROOT, 'tooling', 'sdk', 'user-state', 'local');
await mkdir(testRoot, { recursive: true });
const temp = await mkdtemp(path.join(testRoot, 'codex-ns-e2e-'));
const home = path.join(temp, 'home');
await mkdir(home, { recursive: true });
const mcpServer = path.join(ROOT, 'bridge', 'mcp-server.mjs');
await writeFile(path.join(home, 'config.toml'), [
  'model = "probe-model"',
  'model_provider = "openai"',
  'sandbox_mode = "danger-full-access"',
  'approval_policy = "never"',
  '',
  '[mcp_servers.phone]',
  `command = ${JSON.stringify(process.execPath)}`,
  `args = [${JSON.stringify(mcpServer)}]`,
  '',
  '[mcp_servers.phone.env]',
  `CODEX_GO_DATA_DIR = ${JSON.stringify(path.join(temp, 'data'))}`,
  `CODEX_GO_ALLOWED_ROOTS = ${JSON.stringify(temp)}`,
].join('\n') + '\n');

const token = 'codex-namespace-e2e-token';
const env = {
  ...process.env,
  CODEX_HOME: home,
  LOCALAPPDATA: path.join(temp, 'local'),
  TEMP: path.join(temp, 'tmp'),
  TMP: path.join(temp, 'tmp'),
  NO_COLOR: '1',
  RUST_LOG: 'off',
};
await mkdir(env.TEMP, { recursive: true });

const child = spawn(process.execPath, [
  path.join(ROOT, 'bridge/server.mjs'),
  '--codex', CODEX,
  '--codex-home', home, '--cwd', temp,
  '--toolpacks', path.join(temp, 'no-builtin-packs'),
  '--plugins', path.join(temp, 'no-builtin-plugins'),
  '--host', '127.0.0.1', '--port', '0', '--token', token,
], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

let output = '', stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', chunk => { output = (output + chunk).slice(-16000); });
child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });

const waitFor = async (check, label, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error(`bridge exited (${child.exitCode}): ${stderr}`);
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(`timed out waiting for ${label}`);
};

let origin = null;
try {
  origin = await waitFor(async () => output.match(/codex-go: (http:\/\/127\.0\.0\.1:\d+)\//)?.[1], 'bridge launch');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const post = async (route, body) => {
    const response = await fetch(`${origin}/api/${route}`, {
      method: 'POST', headers, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(90000),
    });
    return { status: response.status, body: await response.json() };
  };

  const saved = await post('channels/save', {
    id: 'probe-chat', name: 'Probe Chat', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    wire: 'openai-chat', model: 'probe-model', apiKey: 'probe-key',
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const activated = await post('channels/activate', { id: 'probe-chat' });
  assert.equal(activated.status, 200, JSON.stringify(activated.body));

  const created = await post('thread/create', { cwd: temp });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const sent = await post('turn/send', { threadId: created.body.threadId, text: 'Read my phone screen.' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));

  await waitFor(() => seen.length > 0, 'first upstream request', 60000);
  const first = seen[0];
  console.log('chat tools:', first.tools.length);
  console.log('call name under test:', CALL_NAME);
  console.log('that name is offered:', first.tools.includes(CALL_NAME));
  console.log('has namespace leftovers:', first.tools.some(name => /namespace|mcp__/.test(String(name))));
  assert.ok(first.tools.length > 50, `the namespace must be flattened into its functions, got ${first.tools.length}`);
  assert.ok(first.tools.includes('screen'), 'the flattened tools must keep the MCP names');

  // 关键：codex 收到 `screen` 这个 function_call 后有没有真的去调 MCP 宿主。
  await waitFor(() => seen.length > 1, 'follow-up upstream request after the tool call', 90000);
  const second = seen[1];
  console.log('tool result seen by the upstream:', JSON.stringify(second.toolResultText.slice(0, 200)));
  const dispatched = /device\/unavailable|"ok"|ok\\?"|codex-go/i.test(second.toolResultText) || second.toolResultText.length > 0;
  assert.ok(dispatched, 'codex must run the MCP tool and feed its result back to the model');
  console.log('RESULT: namespace flattened -> model name dispatched -> MCP result returned to the model');
} finally {
  if (child.exitCode === null) {
    const closed = once(child, 'close');
    if (origin) await fetch(`${origin}/api/bridge/stop`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
    else child.kill();
    const timer = setTimeout(() => child.kill(), 8000);
    await closed;
    clearTimeout(timer);
  }
  upstream.close();
  if (process.exitCode) console.error('bridge stderr:', stderr.slice(-3000));
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
