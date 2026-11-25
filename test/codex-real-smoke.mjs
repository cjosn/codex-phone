// Black-box smoke for the pinned official Codex CLI/app-server.
// Run: node test/codex-real-smoke.mjs [path-to-codex.exe] [--fixture]
// This test uses an isolated CODEX_HOME and never reads the caller's Codex login.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const fixtureMode = argv.includes('--fixture');
const suppliedCodex = argv.find((arg) => !arg.startsWith('--'));
const CODEX = suppliedCodex || path.resolve(ROOT, 'tooling/sdk/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const TIMEOUT_MS = 45000;

function cleanEnv(home, apiKey) {
  const env = { ...process.env, CODEX_HOME: home, NO_COLOR: '1', RUST_LOG: 'off' };
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME_OVERRIDE', 'CODEX_GO_API_KEY']) delete env[key];
  if (apiKey) env.CODEX_FIXTURE_API_KEY = apiKey;
  else delete env.CODEX_FIXTURE_API_KEY;
  return env;
}

class AppServer {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.messages = [];
    this.stderr = '';
    child.stdout.setEncoding('utf8');
    let buffer = '';
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
        if (message.error) {
          const error = new Error(message.error.message || `RPC ${waiting.method} failed`);
          error.rpcCode = message.error.code;
          error.data = message.error.data;
          waiting.reject(error);
        } else waiting.resolve(message.result);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { this.stderr = (this.stderr + chunk).slice(-6000); });
    child.on('exit', (code, signal) => {
      for (const [id, waiting] of this.pending) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error(`app-server exited (${code ?? signal}): ${this.stderr.trim()}`));
        this.pending.delete(id);
      }
    });
  }
  call(method, params = {}, timeout = TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`RPC timeout: ${method}`));
      }, timeout);
      this.pending.set(String(id), { resolve, reject, timer, method });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
  notify(method, params = {}) { this.child.stdin.write(`${JSON.stringify({ method, params })}\n`); }
  async close() {
    for (const value of this.pending.values()) clearTimeout(value.timer);
    this.pending.clear();
    if (this.child.exitCode == null && this.child.signalCode == null) {
      const closed = once(this.child, 'close');
      this.child.stdin.end();
      const timeout = setTimeout(() => this.child.kill(), 4000);
      await closed;
      clearTimeout(timeout);
    }
  }
}

function sendSse(res, event) {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

async function makeFixture() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    requests.push({ url: req.url, auth: req.headers.authorization, body: raw });
    if (req.url !== '/v1/responses' || req.method !== 'POST') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unexpected fixture path' } }));
      return;
    }
    if (req.headers.authorization !== 'Bearer codex-fixture-only-key') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture key missing' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' });
    res.flushHeaders?.();
    const createdAt = Math.floor(Date.now() / 1000);
    const requestBody = JSON.parse(raw);
    const wantsTool = JSON.stringify(requestBody.input).includes('Run the local tool fixture');
    const toolAlreadyReturned = (requestBody.input ?? []).some(item => item.type === 'function_call_output' && String(item.output).includes('CODEX_TOOL_OK'));
    if (wantsTool && !toolAlreadyReturned) {
      const tools = requestBody.tools ?? [];
      const tool = tools.find(item => item.name === 'exec_command') ?? tools.find(item => item.name === 'shell_command');
      assert(tool, `No supported command tool advertised: ${tools.map(item => item.name).join(', ')}`);
      const argumentsValue = tool.name === 'exec_command'
        ? {cmd:'echo CODEX_TOOL_OK', yield_time_ms:1000, max_output_tokens:200}
        : {command:'echo CODEX_TOOL_OK', timeout_ms:10000};
      const call = {type:'function_call', id:'fc_real_tool', call_id:'call_real_tool', name:tool.name, arguments:JSON.stringify(argumentsValue), status:'completed'};
      sendSse(res, {type:'response.created', response:{id:'resp_real_tool', status:'in_progress', output:[]}});
      sendSse(res, {type:'response.output_item.added', output_index:0, item:{...call,arguments:'',status:'in_progress'}});
      sendSse(res, {type:'response.function_call_arguments.delta', output_index:0, item_id:call.id, delta:call.arguments});
      sendSse(res, {type:'response.function_call_arguments.done', output_index:0, item_id:call.id, arguments:call.arguments});
      sendSse(res, {type:'response.output_item.done', output_index:0, item:call});
      sendSse(res, {type:'response.completed', response:{id:'resp_real_tool', status:'completed', output:[call], usage:{input_tokens:4,output_tokens:8,total_tokens:12}}});
      res.end('data: [DONE]\n\n');
      return;
    }
    const message = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Codex fixture text stream is working.' }] };
    sendSse(res, { type: 'response.created', response: { id: 'resp_fixture', object: 'response', created_at: createdAt, status: 'in_progress', model: 'gpt-5-codex', output: [] } });
    sendSse(res, { type: 'response.output_item.added', response_id: 'resp_fixture', output_index: 0, item: { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
    sendSse(res, { type: 'response.content_part.added', response_id: 'resp_fixture', item_id: 'msg_fixture', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
    sendSse(res, { type: 'response.output_text.delta', response_id: 'resp_fixture', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'Codex fixture ' });
    await new Promise((resolve) => setTimeout(resolve, 35));
    sendSse(res, { type: 'response.output_text.delta', response_id: 'resp_fixture', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'text stream is working.' });
    sendSse(res, { type: 'response.output_text.done', response_id: 'resp_fixture', item_id: 'msg_fixture', output_index: 0, content_index: 0, text: 'Codex fixture text stream is working.' });
    sendSse(res, { type: 'response.content_part.done', response_id: 'resp_fixture', item_id: 'msg_fixture', output_index: 0, content_index: 0, part: { type: 'output_text', text: 'Codex fixture text stream is working.' } });
    sendSse(res, { type: 'response.output_item.done', response_id: 'resp_fixture', output_index: 0, item: message });
    sendSse(res, { type: 'response.completed', response: { id: 'resp_fixture', object: 'response', created_at: createdAt, status: 'completed', model: 'gpt-5-codex', output: [message], usage: { input_tokens: 4, output_tokens: 8, total_tokens: 12 } } });
    res.end('data: [DONE]\n\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, requests, port: server.address().port };
}

async function startCodex(home, apiKey) {
  const child = spawn(CODEX, ['app-server'], {
    cwd: ROOT,
    env: cleanEnv(home, apiKey),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const rpc = new AppServer(child);
  const init = await rpc.call('initialize', {
    clientInfo: { name: 'codex-go-real-smoke', version: '1.0.0' },
    capabilities: { experimentalApi: true },
  }, 60000);
  rpc.notify('initialized');
  return { child, rpc, init };
}

async function noAuthSmoke(home) {
  await mkdir(home, { recursive: true });
  const { child, rpc, init } = await startCodex(home, null);
  const result = { initialize: { userAgent: init.userAgent ?? null, codexHome: init.codexHome ?? null }, calls: {} };
  const run = async (name, fn, required = false) => {
    try { result.calls[name] = { ok: true, result: await fn() }; }
    catch (error) {
      result.calls[name] = { ok: false, code: error.rpcCode ?? null, message: error.message };
      if (required) throw error;
    }
  };
  try {
    await run('thread/list', () => rpc.call('thread/list', { limit: 3 }), true);
    await run('model/list', () => rpc.call('model/list', { limit: 3 }), false);
    await run('account/read', () => rpc.call('account/read', {}), true);
    await run('thread/start', () => rpc.call('thread/start', { cwd: home }), false);
    const start = result.calls['thread/start'];
    const threadId = start?.result?.thread?.id;
    if (threadId) {
      // A newly created empty thread has no persisted rollout until a turn.
      await run('thread/resume-empty', () => rpc.call('thread/resume', { threadId, excludeTurns: false }), false);
      await run('thread/read-empty', () => rpc.call('thread/read', { threadId, includeTurns: true }), false);
      await run('turn/interrupt-no-turn', () => rpc.call('turn/interrupt', { threadId, turnId: 'not-a-real-turn' }), false);
    }
  } finally { await rpc.close(); }
  assert.equal(child.spawnfile, CODEX);
  return result;
}

async function fixtureSmoke(home, fixture) {
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, 'config.toml'), [
    'model = "gpt-5-codex"',
    'model_provider = "codex_fixture"',
    'approval_policy = "never"',
    'sandbox_mode = "danger-full-access"',
    '',
    '[model_providers.codex_fixture]',
    'name = "Codex local fixture"',
    `base_url = "http://127.0.0.1:${fixture.port}/v1"`,
    'wire_api = "responses"',
    'env_key = "CODEX_FIXTURE_API_KEY"',
    '',
  ].join('\n'), { mode: 0o600 });
  const { rpc } = await startCodex(home, 'codex-fixture-only-key');
  try {
    const started = await rpc.call('thread/start', { cwd: home, model: 'gpt-5-codex', modelProvider: 'codex_fixture' });
    const threadId = started.thread?.id;
    assert.ok(threadId, 'thread/start must return a Codex thread ID');
    const turnStart = await rpc.call('turn/start', { threadId, input: [{ type: 'text', text: 'Say a short greeting.' }] }, 90000);
    const turnId = turnStart.turn?.id;
    assert.ok(turnId, 'turn/start must return a Codex turn ID');
    const completed = await waitForTurn(rpc, threadId, turnId, 90000);
    assert.equal(completed.turn.status, 'completed', `turn status: ${completed.turn.status}`);
    const text = (completed.turn.items ?? []).filter((item) => item.type === 'agentMessage').map((item) => item.text).join('');
    assert.match(text, /Codex fixture text stream is working\./);
    assert.ok(fixture.requests.length > 0, 'Codex must call the local fixture');
    const sent = fixture.requests.find((request) => request.url === '/v1/responses');
    assert.ok(sent, 'Responses API path must be used');
    assert.equal(sent.auth, 'Bearer codex-fixture-only-key');
    const toolThread = (await rpc.call('thread/start', {cwd:home, model:'gpt-5-codex', modelProvider:'codex_fixture', sandbox:'danger-full-access', approvalPolicy:'never'})).thread.id;
    const toolTurn = (await rpc.call('turn/start', {threadId:toolThread, input:[{type:'text',text:'Run the local tool fixture and report its output.'}]})).turn.id;
    const toolCompleted = await waitForTurn(rpc, toolThread, toolTurn, 90000);
    assert.equal(toolCompleted.turn.status, 'completed');
    assert(fixture.requests.some(request => JSON.parse(request.body).input?.some(item => item.type === 'function_call_output' && String(item.output).includes('CODEX_TOOL_OK'))), 'A genuine Codex command output must be replayed to the provider');
    return { threadId, turnId, status: completed.turn.status, text, fixtureRequests: fixture.requests.length, toolRoundTrip:true, model: JSON.parse(sent.body).model };
  } finally { await rpc.close(); }
}

function waitForTurn(rpc, threadId, turnId, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`turn ${turnId} did not complete`)); }, timeout);
    const listener = (chunk) => {
      // The AppServer line decoder records notifications on `messages`; observe via small polling.
    };
    const start = rpc.messages.length;
    const poll = setInterval(() => {
      const message = rpc.messages.slice(start).find((candidate) => candidate.method === 'turn/completed'
        && candidate.params?.threadId === threadId && candidate.params?.turn?.id === turnId);
      if (message) { cleanup(); resolve(message.params); }
      const failed = rpc.messages.slice(start).find((candidate) => candidate.method === 'error'
        && candidate.params?.threadId === threadId && candidate.params?.turnId === turnId);
      if (failed) { cleanup(); reject(new Error(`Codex turn failed: ${JSON.stringify(failed.params.error ?? failed.params)}`)); }
    }, 25);
    rpc.child.stdout.on('data', listener);
    function cleanup() { clearTimeout(timer); clearInterval(poll); rpc.child.stdout.off('data', listener); }
  });
}

async function bridgeSmoke(testDirectory, fixture) {
  await mkdir(testDirectory, { recursive: true });
  const token = 'codex-bridge-integration-fixture-token';
  const child = spawn(process.execPath, [path.join(ROOT, 'bridge/server.mjs'), '--codex', CODEX, '--codex-home', testDirectory, '--cwd', testDirectory, '--port', '0', '--token', token], {
    cwd: ROOT, env: cleanEnv(testDirectory, null), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let output = '', stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output = (output + chunk).slice(-16000); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
  const waitFor = async (fn, description, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw Error(`Bridge exited (${child.exitCode}): ${stderr}`);
      const value = fn();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error(`Timed out waiting for ${description}`);
  };
  const controller = new AbortController();
  let streamTask;
  let origin;
  try {
    origin = await waitFor(() => output.match(/codex-go: (http:\/\/127\.0\.0\.1:\d+)\//)?.[1], 'Codex bridge launch');
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const call = async (route, body) => {
      const response = await fetch(`${origin}/api/${route}`, {
        method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000),
      });
      const data = await response.json();
      assert.equal(response.status, 200, `${route}: ${JSON.stringify(data)}`);
      return data;
    };
    const health = await (await fetch(`${origin}/healthz`)).json();
    assert.equal(health.engine, 'codex');
    assert.match(health.codexVersion, /0\.170\.0/);
    assert.equal((await fetch(`${origin}/`)).status, 200);
    assert.equal((await fetch(`${origin}/pocket.js`)).status, 200);
    assert(Array.isArray((await call('models')).models));
    assert.equal((await call('account')).account, null);
    const initial = await call('config');
    assert.equal(initial.provider, 'openai');
    const config = await call('config', { provider:'codex_fixture', baseUrl:`http://127.0.0.1:${fixture.port}/v1`, model:'gpt-5-codex', apiKey:'codex-fixture-only-key', approvalPolicy:'on-request' });
    assert.equal(config.provider, 'codex_fixture');
    assert.equal(config.apiKeyConfigured, true);
    assert(!JSON.stringify(config).includes('codex-fixture-only-key'));
    const stream = await fetch(`${origin}/api/events?after=0`, { headers, signal:controller.signal });
    assert.equal(stream.status, 200);
    const events = [];
    streamTask = (async () => {
      let pending = '';
      const decoder = new TextDecoder();
      for await (const bytes of stream.body) {
        pending += decoder.decode(bytes, {stream:true});
        let index;
        while ((index = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, index);
          pending = pending.slice(index + 2);
          const data = block.split('\n').find(line => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    })().catch(error => { if (!controller.signal.aborted) throw error; });
    const {threadId} = await call('thread/create', {cwd:testDirectory});
    assert(threadId);
    const {turnId} = await call('turn/send', {threadId, text:'Say a short greeting.'});
    const turnEnd = await waitFor(() => events.find(event => event.type === 'turn.end' && event.turnId === turnId), 'Responses completion', 60000);
    assert.equal(turnEnd.status, 'completed', JSON.stringify(turnEnd));
    const text = events.filter(event => event.type === 'text.delta' && event.turnId === turnId).map(event => event.text).join('');
    assert.match(text, /Codex fixture text stream is working\./);
    assert.equal(fixture.requests.at(-1).auth, 'Bearer codex-fixture-only-key');
    const history = await call('thread/resume', {threadId});
    assert(history.items.some(item => item.type === 'agentMessage' && item.text === text), 'Persisted assistant message missing');
    const threads = await call('thread/list', {});
    assert(threads.threads.some(thread => thread.id === threadId));
    console.log('Real Codex bridge smoke:', JSON.stringify({ version:'0.170.0', authenticatedInference:true, text, webUi:true, persistedHistory:true, status:turnEnd.status }));
  } finally {
    controller.abort();
    await streamTask;
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      if (origin) {
        await fetch(`${origin}/api/bridge/stop`, {method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}'}).catch(() => {});
      } else child.kill();
      const timeout = setTimeout(() => child.kill(), 8000);
      await closed;
      clearTimeout(timeout);
    }
  }
}

// Keep runtime state outside Windows TEMP and independent of the user's login.
const testRoot = path.join(ROOT, 'tooling', 'sdk', 'user-state', 'local');
await mkdir(testRoot, { recursive: true });
const temp = await mkdtemp(path.join(testRoot, 'codex-go-real-smoke-'));
let fixture;
try {
  assert.ok(CODEX && path.isAbsolute(CODEX), 'Pass an absolute Codex executable path');
  const version = await new Promise((resolve, reject) => {
    const child = spawn(CODEX, ['--version'], { cwd: ROOT, env: cleanEnv(path.join(temp, 'version-home'), null), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`codex --version exited ${code}: ${output}`)));
  });
  assert.match(version, /0\.170\.0/);
  console.log(`Official Codex CLI: ${version}`);
  const basic = await noAuthSmoke(path.join(temp, 'no-auth-home'));
  console.log('No-auth RPC smoke:', JSON.stringify(basic));
  if (fixtureMode) {
    fixture = await makeFixture();
    const streamed = await fixtureSmoke(path.join(temp, 'fixture-home'), fixture);
    console.log('Local Responses fixture:', JSON.stringify(streamed));
    console.log('Fixture model request:', (await readFile(path.join(temp, 'fixture-home', 'config.toml'), 'utf8')).match(/model_provider = .*/)?.[0]);
    await bridgeSmoke(path.join(temp, 'bridge-home'), fixture);
  }
} catch (error) {
  console.error('REAL CODEX SMOKE FAILED:', error.stack ?? error);
  process.exitCode = 1;
} finally {
  fixture?.server.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
