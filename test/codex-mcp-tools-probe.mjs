// test/codex-mcp-tools-probe.mjs — 决定性实验：官方 codex 0.170 到底有没有把 MCP 工具
// 写进发给上游的请求里？
//
// 做法：起一个本机假上游（openai-responses wire），把每次请求 body.tools 的名字记下来；
// 用官方 codex.exe 起桥，配一个只有 mcp_servers.phone（指向我们的 mcp-server.mjs）的 CODEX_HOME，
// 建会话 → 发一回合 → 打印上游实际收到的工具名。
//
// 用法：node test/codex-mcp-tools-probe.mjs [--codex <path>]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

const requests = [];
function sse(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try { body = JSON.parse(raw); } catch { /* keep {} */ }
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const aggregate = tools.find(tool => /^mcp__/.test(String(tool?.name ?? tool?.function?.name ?? '')));
  requests.push({
    path: req.url,
    model: body.model ?? null,
    toolCount: tools.length,
    toolNames: tools.map(tool => tool?.name ?? tool?.function?.name ?? tool?.type ?? '?'),
    aggregate: aggregate ?? null,
  });
  if (!/\/responses$/.test(req.url ?? '')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unexpected path' } }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' });
  res.flushHeaders?.();
  const message = { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'probe ok' }] };
  sse(res, { type: 'response.created', response: { id: 'resp_probe', object: 'response', created_at: 1, status: 'in_progress', model: body.model ?? 'x', output: [] } });
  sse(res, { type: 'response.output_item.added', response_id: 'resp_probe', output_index: 0, item: { id: 'msg_probe', type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
  sse(res, { type: 'response.output_text.delta', response_id: 'resp_probe', item_id: 'msg_probe', output_index: 0, content_index: 0, delta: 'probe ok' });
  sse(res, { type: 'response.output_item.done', response_id: 'resp_probe', output_index: 0, item: message });
  sse(res, { type: 'response.completed', response: { id: 'resp_probe', object: 'response', created_at: 1, status: 'completed', model: body.model ?? 'x', output: [message], usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 } } });
  res.end('data: [DONE]\n\n');
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamPort = upstream.address().port;

const testRoot = path.join(ROOT, 'tooling', 'sdk', 'user-state', 'local');
await mkdir(testRoot, { recursive: true });
const temp = await mkdtemp(path.join(testRoot, 'codex-mcp-probe-'));
const home = path.join(temp, 'home');
await mkdir(home, { recursive: true });

// 只有 MCP，没有任何花哨配置：codex 若仍然不给工具，就不是我们桥写错了。
const mcpServer = path.join(ROOT, 'bridge', 'mcp-server.mjs');
await writeFile(path.join(home, 'config.toml'), [
  'model = "probe-model"',
  'model_provider = "probe"',
  'sandbox_mode = "danger-full-access"',
  'approval_policy = "never"',
  '',
  '[model_providers.probe]',
  'name = "probe"',
  `base_url = "http://127.0.0.1:${upstreamPort}/v1"`,
  'wire_api = "responses"',
  'env_key = "CODEX_GO_PROBE_KEY"',
  'requires_openai_auth = false',
  '',
  '[mcp_servers.phone]',
  `command = ${JSON.stringify(process.execPath)}`,
  `args = [${JSON.stringify(mcpServer)}]`,
  '',
  '[mcp_servers.phone.env]',
  `CODEX_GO_DATA_DIR = ${JSON.stringify(path.join(temp, 'data'))}`,
  `CODEX_GO_ALLOWED_ROOTS = ${JSON.stringify(temp)}`,
].join('\n') + '\n');

const token = 'codex-mcp-probe-token';
const env = {
  ...process.env,
  CODEX_HOME: home,
  CODEX_GO_PROBE_KEY: 'probe-key',
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

const waitFor = async (check, label, timeout = 40000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw Error(`bridge exited (${child.exitCode}): ${stderr}`);
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error(`timed out waiting for ${label}`);
};

let origin = null;
try {
  origin = await waitFor(async () => output.match(/codex-go: (http:\/\/127\.0\.0\.1:\d+)\//)?.[1], 'bridge launch');
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const post = async (route, body) => {
    const response = await fetch(`${origin}/api/${route}`, {
      method: 'POST', headers, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(60000),
    });
    return { status: response.status, body: await response.json() };
  };

  // codex 自己认为这个 MCP 服务器有哪些工具（间接证据）
  const mcpStatus = await post('mcp', {});
  const servers = Array.isArray(mcpStatus.body?.data) ? mcpStatus.body.data : [];
  const phone = servers.find(server => server.name === 'phone');
  const reported = phone ? Object.keys(phone.tools ?? {}) : [];
  console.log('mcpServerStatus:', phone ? `${reported.length} tools` : 'server missing', reported.slice(0, 6).join(','));

  const created = await post('thread/create', { cwd: temp });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const sent = await post('turn/send', { threadId: created.body.threadId, text: 'Say probe ok.' });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await waitFor(async () => requests.length > 0, 'upstream request', 45000);

  const last = requests.at(-1);
  console.log('upstream tools:', last.toolCount);
  console.log('names:', last.toolNames.join(',') || '(none)');
  const hasMcpTool = last.toolNames.some(name => /^mcp__|phone__|^screen$/.test(String(name)));
  console.log(hasMcpTool ? 'RESULT: codex DOES send MCP tools upstream' : 'RESULT: codex sends NO MCP tools upstream');
  console.log('hasExecCommand:', last.toolNames.some(name => /exec_command/.test(String(name))));
  const agg = last.aggregate ?? {};
  console.log('aggregate keys:', Object.keys(agg).join(','));
  console.log('aggregate type:', agg.type, 'name:', agg.name);
  const inner = agg.tools ?? agg.functions ?? agg.items ?? null;
  console.log('inner tools:', Array.isArray(inner) ? inner.length : typeof inner);
  if (Array.isArray(inner)) console.log('inner names:', inner.slice(0, 8).map(t => t?.name ?? t?.function?.name ?? t?.type).join(','));
  if (Array.isArray(inner) && inner[0]) console.log('inner[0]:', JSON.stringify(inner[0]).slice(0, 700));
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
  if (process.exitCode) console.error('bridge stderr:', stderr);
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
