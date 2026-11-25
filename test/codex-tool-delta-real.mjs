// MANUAL black-box integration test; not part of the default node:test auto suite.
// Run from codex-go: node test/codex-tool-delta-real.mjs
// Uses the pinned official Codex 0.170, the real bridge and a loopback chat SSE fixture.
// This is NOT validation against an external upstream service, model or credential.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CODEX = path.join(ROOT, 'tooling/sdk/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const STATE_ROOT = path.join(ROOT, 'tooling/sdk/user-state/local');
const CHANNEL_ID = 'fixture-tool-delta';
const MODEL = 'fixture-codex-tool-delta';
const CALL_ID = 'call_fixture_tool_delta';
const ECHO_TEXT = 'CODEX_TOOL_DELTA_OK';
const FINAL_TEXT = 'Tool arguments streamed; fixture command completed.';
const ARGUMENT_PARTS = [
  '{"cmd":"echo CODEX_',
  'TOOL_DELTA_OK","yield_time_ms":1000,"max_output_tokens":200}',
];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function isolatedEnv(home) {
  const env = {
    ...process.env,
    CODEX_HOME: home,
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: '1',
    RUST_LOG: 'off',
    NODE_USE_ENV_PROXY: '0',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
  for (const key of [
    'OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME_OVERRIDE', 'CODEX_GO_API_KEY',
    'CODEX_GO_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
  ]) delete env[key];
  return env;
}

async function codexVersion(home) {
  await mkdir(home, { recursive: true });
  return await new Promise((resolve, reject) => {
    const child = spawn(CODEX, ['--version'], {
      cwd: ROOT, env: isolatedEnv(home), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0
      ? resolve(stdout.trim())
      : reject(Error(`Official Codex --version exited ${code}`)));
  });
}

function chatSse(res, chunk) {
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

async function startFixture() {
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : null;
      requests.push({
        method: req.method,
        path: req.url,
        authorizationPresent: typeof req.headers.authorization === 'string',
        body,
      });
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'unexpected fixture route' } }));
        return;
      }
      if (req.headers.authorization !== 'Bearer local-fixture-only-not-a-credential') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'synthetic fixture credential missing' } }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.flushHeaders?.();
      if (requests.length === 1) {
        const tool = body?.tools?.find(item => item?.function?.name === 'exec_command')
          ?? body?.tools?.find(item => item?.function?.name === 'shell_command');
        assert.ok(tool, 'Codex must advertise exec_command or shell_command');
        assert.equal(tool.function.name, 'exec_command', 'This fixture uses the exec_command argument schema');
        chatSse(res, { id: 'chatcmpl-fixture-tool', choices: [{ index: 0, delta: { role: 'assistant' } }] });
        chatSse(res, { id: 'chatcmpl-fixture-tool', choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, id: CALL_ID, type: 'function',
          function: { name: 'exec_command', arguments: ARGUMENT_PARTS[0] },
        }] } }] });
        await delay(40);
        chatSse(res, { id: 'chatcmpl-fixture-tool', choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, function: { arguments: ARGUMENT_PARTS[1] },
        }] } }] });
        chatSse(res, { id: 'chatcmpl-fixture-tool', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        chatSse(res, { id: 'chatcmpl-fixture-tool', choices: [], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } });
        res.end('data: [DONE]\n\n');
        return;
      }
      assert.equal(requests.length, 2, 'Exactly one tool request and one follow-up request are expected');
      const toolMessage = body?.messages?.find(message => message?.role === 'tool' && message?.tool_call_id === CALL_ID);
      assert.ok(toolMessage, 'The second chat request must contain the real tool result for the same call ID');
      assert.match(String(toolMessage.content), new RegExp(ECHO_TEXT), 'Codex must really execute echo and return its output');
      chatSse(res, { id: 'chatcmpl-fixture-final', choices: [{ index: 0, delta: { role: 'assistant', content: FINAL_TEXT.slice(0, 24) } }] });
      await delay(30);
      chatSse(res, { id: 'chatcmpl-fixture-final', choices: [{ index: 0, delta: { content: FINAL_TEXT.slice(24) } }] });
      chatSse(res, { id: 'chatcmpl-fixture-final', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      chatSse(res, { id: 'chatcmpl-fixture-final', choices: [], usage: { prompt_tokens: 16, completion_tokens: 9, total_tokens: 25 } });
      res.end('data: [DONE]\n\n');
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      if (!res.writableEnded) res.end(JSON.stringify({ error: { message: 'fixture assertion failed' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    async close() {
      server.closeAllConnections?.();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}

async function waitFor(check, description, timeoutMs = 90000, child = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw Error(`Bridge exited (${child.exitCode}) while waiting for ${description}`);
    const value = await check();
    if (value) return value;
    await delay(25);
  }
  throw Error(`Timed out waiting for ${description}`);
}

async function main() {
  await mkdir(STATE_ROOT, { recursive: true });
  const temp = await mkdtemp(path.join(STATE_ROOT, 'codex-tool-delta-real-'));
  const home = path.join(temp, 'codex-home');
  const work = path.join(temp, 'work');
  await mkdir(work, { recursive: true });
  const version = await codexVersion(path.join(temp, 'version-home'));
  assert.match(version, /0\.170\.0/);

  const fixture = await startFixture();
  const bridgeToken = 'local-bridge-fixture-token-not-a-credential';
  const bridge = spawn(process.execPath, [
    path.join(ROOT, 'bridge/server.mjs'),
    '--codex', CODEX,
    '--codex-home', home,
    '--cwd', work,
    '--port', '0',
    '--token', bridgeToken,
  ], {
    cwd: ROOT, env: isolatedEnv(home), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let bridgeStdout = '';
  let bridgeStderr = '';
  bridge.stdout.setEncoding('utf8');
  bridge.stderr.setEncoding('utf8');
  bridge.stdout.on('data', chunk => { bridgeStdout = (bridgeStdout + chunk).slice(-24000); });
  bridge.stderr.on('data', chunk => { bridgeStderr = (bridgeStderr + chunk).slice(-12000); });

  let origin = null;
  let streamController = null;
  let streamTask = null;
  const events = [];
  try {
    origin = await waitFor(
      () => bridgeStdout.match(/codex-go: (http:\/\/127\.0\.0\.1:\d+)\//)?.[1],
      'real bridge launch', 60000, bridge,
    );
    const headers = { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' };
    const api = async (route, body) => {
      const response = await fetch(`${origin}/api/${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(60000),
      });
      const data = await response.json();
      assert.equal(response.status, 200, `${route} returned ${response.status}: ${JSON.stringify(data)}`);
      return data;
    };
    const health = async () => {
      const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(10000) });
      assert.equal(response.status, 200);
      return await response.json();
    };
    assert.match((await health()).codexVersion, /0\.170\.0/);

    const saved = await api('channels/save', {
      id: CHANNEL_ID,
      name: 'Loopback tool delta fixture',
      baseUrl: fixture.baseUrl,
      wire: 'openai-chat',
      model: MODEL,
      models: [MODEL],
      apiKey: 'local-fixture-only-not-a-credential',
    });
    assert.equal(saved.wire, 'openai-chat');
    assert.equal(saved.apiKeyConfigured, true);
    assert(!JSON.stringify(saved).includes('local-fixture-only-not-a-credential'));
    const activated = await api('channels/activate', { id: CHANNEL_ID });
    assert.equal(activated.active, CHANNEL_ID);
    await api('config', { approvalPolicy: 'never', sandboxMode: 'danger-full-access' });

    streamController = new AbortController();
    const stream = await fetch(`${origin}/api/events?after=0`, { headers, signal: streamController.signal });
    assert.equal(stream.status, 200);
    streamTask = (async () => {
      const decoder = new TextDecoder();
      let pending = '';
      for await (const bytes of stream.body) {
        pending += decoder.decode(bytes, { stream: true });
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const block = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = block.split(/\r?\n/).find(line => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    })().catch(error => { if (!streamController.signal.aborted) throw error; });

    const { threadId } = await api('thread/create', { cwd: work, approvalPolicy: 'never' });
    assert.ok(threadId);
    const sent = await api('turn/send', {
      threadId,
      text: 'Run the local echo fixture with exec_command, then report completion.',
      approvalPolicy: 'never',
      sandboxMode: 'danger-full-access',
    });
    const turnId = sent.turnId;
    assert.ok(turnId);
    const turnEnd = await waitFor(
      () => events.find(event => event.type === 'turn.end' && event.threadId === threadId && event.turnId === turnId),
      'turn completion', 90000, bridge,
    );
    assert.equal(turnEnd.status, 'completed');
    await waitFor(() => fixture.requests.length === 2, 'second fixture request', 10000, bridge);
    await delay(400);

    const own = events.filter(event => event.threadId === threadId && event.turnId === turnId);
    const starts = own.filter(event => event.type === 'turn.start');
    const ends = own.filter(event => event.type === 'turn.end');
    assert.equal(starts.length, 1, 'No duplicate turn.start is allowed');
    assert.equal(ends.length, 1, 'No duplicate turn.end is allowed');
    const deltas = own.filter(event => event.type === 'tool.args.delta');
    assert.deepEqual(deltas.map(event => event.delta), ARGUMENT_PARTS, 'Two argument deltas must arrive in fixture order');
    assert.ok(deltas.every(event => event.itemId === CALL_ID && event.callId === CALL_ID));
    assert.ok(deltas.every(event => event.threadId === threadId && event.turnId === turnId),
      'Official thread-id + x-codex-turn-metadata must correlate every mirrored delta to this turn');
    const toolStarts = own.filter(event => event.type === 'tool.start' && event.itemId === CALL_ID);
    assert.equal(toolStarts.length, 1, 'Exactly one matching tool.start is required');
    assert.match(String(toolStarts[0].name), /echo CODEX_TOOL_DELTA_OK/, 'tool.start must describe the real fixture command');
    assert.equal(deltas[0].itemId, toolStarts[0].itemId, 'tool.args.delta itemId must equal tool.start call_id');
    const text = own.filter(event => event.type === 'text.delta').map(event => event.text).join('');
    assert.equal(text, FINAL_TEXT);
    const toolOutput = own.filter(event => event.type === 'tool.output' && event.itemId === CALL_ID)
      .map(event => event.chunk).join('');
    assert.match(toolOutput, new RegExp(ECHO_TEXT));
    assert.equal(fixture.requests.length, 2);
    assert.ok(fixture.requests.every(request => request.authorizationPresent));
    assert.equal(fixture.requests[0].path, '/v1/chat/completions');
    assert.equal(fixture.requests[1].path, '/v1/chat/completions');
    assert.deepEqual((await api('turn/active', {})).turns, [], 'No zombie active turn may remain');
    assert.equal((await health()).activeTurns, 0);
    // Do not print tokens, authorization values, request payloads or persisted secrets.
    console.log(JSON.stringify({
      result: 'PASS',
      codex: version,
      bridge: 'real bridge/server.mjs',
      upstream: 'loopback openai-chat SSE fixture; no external model or credentials',
      threadId,
      turnId,
      fixtureRequests: fixture.requests.length,
      turn: { start: starts.length, end: ends.length, status: turnEnd.status },
      tool: {
        name: toolStarts[0].name,
        callId: CALL_ID,
        startItemIdMatches: true,
        argumentDeltas: deltas.map(event => ({ itemId: event.itemId, length: event.delta.length })),
        argumentOrder: 'PASS',
        officialHeaderCorrelation: 'PASS (thread/turn matched on every requestCorrelation-gated delta)',
        echoObserved: true,
      },
      text,
      duplicateTurns: 0,
      zombieTurns: 0,
    }, null, 2));
  } catch (error) {
    const safeMessage = String(error?.stack ?? error)
      .replaceAll(bridgeToken, '[redacted]')
      .replaceAll('local-fixture-only-not-a-credential', '[redacted]');
    console.error(`MANUAL CODEX TOOL DELTA TEST FAILED: ${safeMessage}`);
    console.error(`Observed event counts: ${JSON.stringify(events.reduce((counts, event) => {
      counts[event.type] = (counts[event.type] ?? 0) + 1;
      return counts;
    }, {}))}`);
    process.exitCode = 1;
  } finally {
    streamController?.abort();
    await streamTask;
    if (bridge.exitCode === null && bridge.signalCode === null) {
      const closed = once(bridge, 'close');
      if (origin) {
        await fetch(`${origin}/api/bridge/stop`, {
          method: 'POST',
          headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      } else bridge.kill();
      const killer = setTimeout(() => bridge.kill(), 8000);
      await closed;
      clearTimeout(killer);
    }
    await fixture.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
}

await main();
