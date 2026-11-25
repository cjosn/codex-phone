// Real bridge HTTP/SSE exercised against an explicitly selected SYNTHETIC JSON-RPC executable.
// This does not install, invoke, or claim to validate the official Codex CLI.
// Run directly: node test/bridge-contract.test.mjs (also supports node --test).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { normalize } from '../bridge/adapter.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const token = 'synthetic-bridge-contract-token';
const key = 'synthetic-config-key-never-return';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(20); }
  throw Error(`Timed out: ${label}`);
}

async function collectSse(url, signal) {
  const response = await fetch(url, { signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = [];
  const done = (async () => {
    const reader = response.body.getReader(); let buffer = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = block.split('\n').find(line => line.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    } catch (error) { if (!signal.aborted) throw error; }
  })();
  return { events, done };
}

test('plan and diff notifications preserve their official snapshot shapes', () => {
  const patch = normalize('item/fileChange/patchUpdated', {
    threadId: 't1', turnId: 'turn1', itemId: 'file1',
    changes: [{ path: 'lib/a.dart', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-old\n+new' }],
  })[0];
  assert.equal(patch.type, 'diff');
  assert.equal(patch.patch, '@@ -1 +1 @@\n-old\n+new');
  assert.equal(patch.replace, true);
  assert.equal(patch.changes[0].path, 'lib/a.dart');
  assert(!patch.patch.includes('threadId'));
  const turn = normalize('turn/diff/updated', { threadId: 't1', turnId: 'turn1', diff: 'complete snapshot' })[0];
  assert.deepEqual({ itemId: turn.itemId, patch: turn.patch, replace: turn.replace }, { itemId: 'turn-diff', patch: 'complete snapshot', replace: true });
  const plan = normalize('turn/plan/updated', { threadId: 't1', turnId: 'turn1', plan: [{ step: 'inspect', status: 'inProgress' }] })[0];
  assert.deepEqual(plan.steps, [{ step: 'inspect', status: 'inProgress' }]);
  const mcpPlan = normalize('item/completed', {
    threadId: 't1', turnId: 'turn1',
    item: { id: 'plan-call', type: 'mcpToolCall', tool: 'plan_update_step', status: 'completed', result: { structuredContent: { data: { plan: { steps: [{ title: 'inspect', status: 'done' }, { title: 'edit', status: 'in_progress' }] } } } } },
  }).find(event => event.type === 'plan.updated');
  assert.deepEqual(mcpPlan.steps, [{ step: 'inspect', status: 'completed' }, { step: 'edit', status: 'inProgress' }]);
  const finalTool = normalize('turn/completed', {
    threadId: 't1', turn: {id: 'turn1', status: 'completed', items: [
      {id: 'call-1', type: 'commandExecution', status: 'completed', exitCode: 0, aggregatedOutput: 'done'},
      {id: 'message-1', type: 'agentMessage', text: 'finished'},
    ]},
  });
  assert.deepEqual(finalTool.map(event => event.type), ['item.end', 'tool.output', 'tool.end', 'turn.end']);
  assert.equal(finalTool[1].chunk, 'done');
  assert.equal(finalTool[2].status, 'completed');
});

test('local MCP stdio toolkit executes constrained files, calendar and persistent sequential workflows', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'codex-mcp-toolkit-'));
  const inputPath = join(root, 'mcp-input.jsonl'), outputPath = join(root, 'mcp-output.jsonl'), errorPath = join(root, 'mcp-error.log');
  const dataDir = join(root, 'data'), workflowId = '00000000-0000-4000-8000-000000000001'; await mkdir(dataDir, { recursive: true });
  await writeFile(join(root, 'note.txt'), '真实内容🙂');
  await writeFile(join(dataDir, 'workflows.json'), JSON.stringify([{ id: workflowId, name: 'stdio sequence', createdAt: 1, steps: [{ type: 'shell', argv: [process.execPath, '-e', "process.stdout.write('one')"] }, { type: 'shell', argv: [process.execPath, '-e', "process.stdout.write('two')"] }] }]));
  const messages = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'contract-test', version: '1' } } },
    { id: 2, method: 'tools/list', params: {} },
    { id: 3, method: 'tools/call', params: { name: 'file_write', arguments: { path: 'new-note.txt', content: '真实内容🙂' } } },
    { id: 4, method: 'tools/call', params: { name: 'file_list', arguments: { path: '.' } } },
    { id: 5, method: 'tools/call', params: { name: 'file_read', arguments: { path: '../outside.txt' } } },
    { id: 6, method: 'tools/call', params: { name: 'calendar', arguments: { year: 2024, month: 2 } } },
    { id: 7, method: 'tools/call', params: { name: 'time_now', arguments: { timeZone: 'Asia/Shanghai' } } },
    { id: 8, method: 'tools/call', params: { name: 'workflow_run', arguments: { id: workflowId } } },
    { id: 9, method: 'tools/call', params: { name: 'workflow_run', arguments: { id: workflowId, approveShell: true } } },
    { id: 10, method: 'tools/call', params: { name: 'file_read', arguments: { path: 'note.txt' } } },
  ];
  await writeFile(inputPath, messages.map(message => JSON.stringify({ jsonrpc: '2.0', ...message })).join('\n') + '\n');
  const input = await open(inputPath, 'r'), output = await open(outputPath, 'w'), errors = await open(errorPath, 'w');
  const child = spawn(process.execPath, [resolve(here, '../bridge/mcp-server.mjs')], { env: { ...process.env, CODEX_GO_ALLOWED_ROOTS: root, CODEX_GO_DATA_DIR: dataDir }, stdio: [input.fd, output.fd, errors.fd], windowsHide: true });
  const [code] = await once(child, 'close'); await input.close(); await output.close(); await errors.close();
  assert.equal(code, 0, await readFile(errorPath, 'utf8'));
  const responses = new Map((await readFile(outputPath, 'utf8')).trim().split('\n').map(line => { const message = JSON.parse(line); return [message.id, message.result]; }));
  assert.equal(responses.get(1).serverInfo.name, 'codex-go-local-toolkit');
  assert(responses.get(2).tools.some(tool => tool.name === 'file_read')); assert(responses.get(2).tools.some(tool => tool.name === 'workflow_run'));
  assert.equal(responses.get(3).isError, false); assert.equal(await readFile(join(root, 'new-note.txt'), 'utf8'), '真实内容🙂');
  assert(responses.get(4).structuredContent.data.entries.some(entry => entry.name === 'mcp-input.jsonl'));
  assert.equal(responses.get(10).structuredContent.data.content, '真实内容🙂');
  assert.equal(responses.get(5).isError, true, 'allowed roots must reject traversal');
  assert.match(responses.get(5).structuredContent.error.code, /^(path|toolpack)\/outside-roots$/);
  assert.equal(responses.get(6).structuredContent.data.weeks.flat().includes(29), true);
  assert.equal(responses.get(7).structuredContent.data.timeZone, 'Asia/Shanghai');
  assert.equal(responses.get(8).isError, true); assert.match(responses.get(8).content[0].text, /approveShell/);
  const run = responses.get(9); assert.equal(run.isError, false, JSON.stringify(run)); assert.deepEqual(run.structuredContent.data.steps.map(step => step.stdout), ['one', 'two']);
  const persisted = JSON.parse(await readFile(join(dataDir, 'workflow-runs.json'), 'utf8')); assert.equal(persisted[0].status, 'completed');
  await rm(root, { recursive: true, force: true });
});

test('synthetic JSON-RPC executable validates real bridge HTTP/SSE contracts', { timeout: 45000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'codex-bridge-contract-'));
  const tracePath = join(home, 'synthetic-trace.jsonl');
  const outputPath = join(home, 'stdout.log'), errorPath = join(home, 'stderr.log');
  const out = await open(outputPath, 'w'), err = await open(errorPath, 'w');
  const child = spawn(process.execPath, [resolve(here, '../bridge/server.mjs'), '--codex', process.execPath, '--codex-arg', join(here, 'protocol-fixture.mjs'), '--codex-home', home, '--cwd', home, '--host', '127.0.0.1', '--port', '0', '--token', token], { env: { ...process.env, CODEX_FIXTURE_TRACE: tracePath }, stdio: ['ignore', out.fd, err.fd], windowsHide: true });
  const exited = once(child, 'close');
  const controllers = [];
  try {
    const base = await until(async () => {
      const output = await readFile(outputPath, 'utf8');
      const match = output.match(/codex-go: (http:\/\/127\.0\.0\.1:\d+)\//);
      if (child.exitCode !== null) throw Error(`Bridge exited ${child.exitCode}: ${await readFile(errorPath, 'utf8')}`);
      return match?.[1];
    }, 'bridge startup', 8000);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    async function api(route, body, options = {}) {
      const response = await fetch(`${base}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options });
      return { status: response.status, body: await response.json() };
    }
    const trace = async () => (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    await t.test('HTTP auth and malformed request bodies', async () => {
      assert.equal((await fetch(`${base}/api/models`)).status, 401);
      assert.equal((await fetch(`${base}/api/models`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
      for (const body of ['null', '[]', '"text"', '{bad']) {
        const response = await fetch(`${base}/api/turn/send`, { method: 'POST', headers, body });
        assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'request/json');
      }
      assert.equal((await api('turn/send', {})).status, 400);
      const cross = await api('models', undefined, { headers: { ...headers, origin: 'https://example.invalid' } });
      assert.equal(cross.status, 403);
      const crossStream = await fetch(`${base}/api/events?token=${token}&after=0`, { headers: { origin: 'https://example.invalid' } });
      assert.equal(crossStream.status, 403, 'SSE must enforce the same origin policy as unary APIs');
      assert.equal((await api('thread/create', { cwd: 42 })).status, 400, 'wrong cwd type must be a request error');
    });
    await t.test('config stores key only in isolated credential file and restarts fixture', async () => {
      const configured = await api('config', { provider: 'synthetic', model: 'synthetic-model', baseUrl: 'https://example.invalid/v1', apiKey: key });
      assert.equal(configured.status, 200, JSON.stringify(configured.body));
      assert.equal(configured.body.apiKeyConfigured, true);
      assert(!JSON.stringify(configured.body).includes(key));
      const readback = await api('config'); assert(!JSON.stringify(readback.body).includes(key));
      const calls = await trace();
      const edits = calls.filter(item => item.method === 'config/batchWrite').flatMap(item => item.params.edits);
      assert(!JSON.stringify(edits).includes(key), 'Config write must store reference, not key literal');
      assert.equal(edits.find(edit => edit.keyPath === 'model_providers.synthetic').value.env_key, 'CODEX_GO_SYNTHETIC_KEY');
      assert.equal((await api('config', { provider: 'bad.dot', model: 'x' })).status, 400);
      assert.equal((await api('config', { unknownField: true })).status, 400);
      assert.equal((await api('config', { baseUrl: 'https://user:pass@example.invalid/v1' })).status, 400);
      assert.equal((await api('config', { reasoningEffort: { invalid: true } })).status, 400);
      assert.equal((await api('config', { reasoningEffort: 'invented' })).status, 400);
      const migrated = await api('config', { approvalPolicy: 'on-failure' });
      assert.equal(migrated.status, 200, JSON.stringify(migrated.body));
      assert.equal(migrated.body.approvalPolicy, 'on-request');
      assert.equal(migrated.body.migrated, true);
    });
    await t.test('MCP management uses official config batch writes', async () => {
      const added = await api('mcp/add', { name: 'local-tools', command: process.execPath, args: ['bridge/mcp-server.mjs'], env: { CODEX_GO_ALLOWED_ROOTS: home }, enabled: true });
      assert.equal(added.status, 200, JSON.stringify(added.body));
      const writes = (await trace()).filter(item => item.method === 'config/batchWrite');
      const edit = writes.at(-1).params.edits[0];
      assert.equal(edit.keyPath, 'mcp_servers.local-tools'); assert.equal(edit.value.command, process.execPath);
      assert.equal((await api('mcp', {})).status, 200);
      assert.equal((await api('mcp/add', { name: 'bad.dot', command: 'x' })).status, 400);
      assert.equal((await api('mcp/remove', { name: 'local-tools' })).status, 200);
      const removal = (await trace()).filter(item => item.method === 'config/batchWrite').at(-1).params.edits[0];
      assert.equal(removal.value, null);
    });
    await t.test('workflows persist definitions and execute real sequential protocol actions', async () => {
      const prompt = await api('workflow/create', { name: 'two prompts', steps: [{ type: 'prompt', text: 'first synthetic step' }, { type: 'prompt', text: 'second synthetic step' }] });
      assert.equal(prompt.status, 200, JSON.stringify(prompt.body));
      const run = await api('workflow/run', { id: prompt.body.id });
      assert.equal(run.status, 200, JSON.stringify(run.body)); assert.deepEqual(run.body.steps.map(step => step.status), ['completed', 'completed']);
      assert.equal(new Set(run.body.steps.map(step => step.turnId)).size, 2, 'each prompt must have its own real turn');
      const view = await api('workflow/get', { id: prompt.body.id }); assert.equal(view.body.runs.length, 1);
      assert.equal((await api('workflow/list', {})).body.workflows.length, 1);
      const shell = await api('workflow/create', { name: 'approved PTY', steps: [{ type: 'shell', argv: ['synthetic-safe-command'] }] });
      const denied = await api('workflow/run', { id: shell.body.id }); assert.equal(denied.status, 400); assert.equal(denied.body.error.code, 'workflow/approval-required');
      const approved = await api('workflow/run', { id: shell.body.id, approveShell: true }); assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.steps[0].process, 'codex-pty'); assert.match(approved.body.steps[0].stdout, /synthetic workflow output/);
      assert.equal((await api('workflow/delete', { id: shell.body.id })).status, 200);
    });
    const a = (await api('thread/create', {})).body.threadId;
    const b = (await api('thread/create', {})).body.threadId;
    assert(a && b && a !== b);
    await t.test('agent instructions enter thread startup and every turn requests reasoning summaries', async () => {
      const starts = (await trace()).filter(item => item.method === 'thread/start').slice(-2);
      assert.equal(starts.length, 2);
      for (const start of starts) {
        assert.match(start.params.developerInstructions, /autonomous coding and device agent/);
        assert.match(start.params.developerInstructions, /inspect the relevant files/);
      }
      const sent = await api('turn/send', { threadId: a, text: 'instruction defaults' });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const turn = (await trace()).filter(item => item.method === 'turn/start').at(-1);
      assert.equal(turn.params.summary, 'auto');
      assert.equal('developerInstructions' in turn.params, false, 'codex 0.170 turn/start has no instruction field');
      assert.equal((await trace()).filter(item => item.method === 'thread/resume' && item.params.threadId === a).length, 0, 'unchanged instructions do not resume a running thread again');
      assert.equal((await api('thread/create', { developerInstructions: 42 })).status, 400);
      assert.equal((await api('thread/create', { config: [] })).status, 400);
      await api('thread/create', { config: { features: { code_mode: false } } });
      const configured = (await trace()).filter(item => item.method === 'thread/start').at(-1);
      assert.equal(configured.params.config.features.code_mode, false);
    });
    await t.test('legacy approval and multimodal attachments reach official turn/start without changing plain text', async () => {
      const created = await api('thread/create', { approvalPolicy: 'on-failure' });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const legacyThread = created.body.threadId;
      const threadStart = (await trace()).filter(item => item.method === 'thread/start').at(-1);
      assert.equal(threadStart.params.approvalPolicy, 'on-request');
      const sent = await api('turn/send', {
        threadId: legacyThread, text: 'inspect these attachments', approvalPolicy: 'on-failure',
        images: ['data:image/png;base64,iVBORw0KGgo='],
        files: [{ name: 'notes.md', mime: 'text/markdown', text: '# Fixture\nOriginal text.' }],
      });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      const turnStart = (await trace()).filter(item => item.method === 'turn/start').at(-1);
      assert.equal(turnStart.params.approvalPolicy, 'on-request');
      assert.equal(turnStart.params.input[0].text, 'inspect these attachments');
      assert.deepEqual(turnStart.params.input[1], { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' });
      assert.match(turnStart.params.input[2].text, /untrusted document/);
      assert.match(turnStart.params.input[2].text, /Original text\./);
      await delay(80);
      const plain = await api('turn/send', { threadId: legacyThread, text: 'plain only' });
      assert.equal(plain.status, 200, JSON.stringify(plain.body));
      assert.equal(Object.hasOwn(plain.body, 'attachmentWarnings'), false);
      const plainStart = (await trace()).filter(item => item.method === 'turn/start').at(-1);
      assert.deepEqual(plainStart.params.input, [{ type: 'text', text: 'plain only' }]);
      assert.equal('images' in plainStart.params, false);
      assert.equal('files' in plainStart.params, false);
    });
    await t.test('SSE replay keeps sequence order and thread isolation', async () => {
      await api('turn/send', { threadId: a, text: 'success A' });
      await until(async () => (await trace()).some(x => x.method === 'turn/start' && x.params.threadId === a), 'A turn request');
      await delay(100);
      await api('turn/send', { threadId: b, text: 'success B' }); await delay(100);
      const controller = new AbortController(); controllers.push(controller);
      const stream = await collectSse(`${base}/api/events?token=${token}&after=0&threadId=${a}`, controller.signal);
      await until(() => stream.events.some(event => event.type === 'turn.end'), 'replayed completed A');
      assert(stream.events.every(event => !event.threadId || event.threadId === a), 'B events must not leak into A stream');
      assert(stream.events.some(event => event.type === 'text.delta' && event.text.includes('中文🙂')));
      assert(stream.events.some(event => event.type === 'usage'));
      assert(stream.events.every((event, index, all) => index === 0 || event.seq > all[index - 1].seq));
      const cursor = stream.events.at(-1).seq;
      controller.abort(); await stream.done;
      const next = new AbortController(); controllers.push(next);
      await api('turn/send', { threadId: a, text: 'success replay continuation' }); await delay(100);
      const replay = await collectSse(`${base}/api/events?token=${token}&after=${cursor}&threadId=${a}`, next.signal);
      await until(() => replay.events.some(event => event.type === 'turn.end'), 'post-cursor A events');
      assert(replay.events.every(event => event.seq > cursor)); next.abort(); await replay.done;
    });
    await t.test('active turn rejects concurrent send and credential reconfiguration', async () => {
      const held = await api('turn/send', { threadId: a, text: 'hold' });
      assert.equal(held.status, 200);
      assert.equal((await api('turn/send', { threadId: a, text: 'concurrent' })).status, 409);
      assert.equal((await api('config', { model: 'synthetic-model' })).status, 409);
      assert.equal((await api('turn/interrupt', { threadId: a })).status, 200);
      await until(async () => (await (await fetch(`${base}/healthz`)).json()).activeTurns === 0, 'interrupt releases thread');
    });
    await t.test('busy configuration reports the active threads and interrupt-all releases them', async () => {
      await api('turn/send', { threadId: a, text: 'hold-all' });
      const active = await api('turn/active', {});
      assert.equal(active.status, 200, JSON.stringify(active.body));
      assert(active.body.turns.some(entry => entry.threadId === a), 'active turn must be listed');
      const blocked = await api('config', { model: 'synthetic-model' });
      assert.equal(blocked.status, 409);
      assert.deepEqual(blocked.body.error.details.activeTurns, [a]);
      const cleared = await api('turn/interrupt-all', {});
      assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
      assert(cleared.body.interrupted.some(entry => entry.threadId === a));
      assert.deepEqual(cleared.body.remaining, []);
      await until(async () => (await (await fetch(`${base}/healthz`)).json()).activeTurns === 0, 'interrupt-all releases every turn');
      assert.equal((await api('config', { model: 'synthetic-model' })).status, 200, 'configuration succeeds once no turn is active');
    });
    await t.test('approval sends official JSON-RPC decision and prevents duplicate reply', async () => {
      const cursor = (await (await fetch(`${base}/healthz`)).json()).seq;
      await api('turn/send', { threadId: a, text: 'approval' }); await delay(100);
      const controller = new AbortController(); controllers.push(controller);
      const stream = await collectSse(`${base}/api/events?token=${token}&after=${cursor}&threadId=${a}`, controller.signal);
      const approval = await until(() => stream.events.find(event => event.type === 'approval.request'), 'approval event');
      assert.equal((await api('approval', { approvalId: approval.approvalId, decision: 'invalid' })).status, 400);
      assert.equal((await api('approval', { approvalId: approval.approvalId, decision: 'accept' })).status, 200);
      await until(() => stream.events.some(event => event.type === 'turn.end'), 'approved completion');
      assert.equal((await api('approval', { approvalId: approval.approvalId, decision: 'accept' })).status, 409);
      const response = (await trace()).find(item => item.kind === 'client-response' && String(item.id).startsWith('fixture-approval-'));
      assert.deepEqual(response.result, { decision: 'accept' }); controller.abort(); await stream.done;
    });
    await t.test('context usage counts the current request, not the session total', async () => {
      // 真机踩过：codex 的 tokenUsage.total 是会话累计（一条短消息 53k，三条 159k），
      // 拿它画进度环会出现「说两句话上下文就满了」。占用必须取 last（当前这次请求）。
      await api('turn/send', { threadId: a, text: 'usage-check' });
      await until(async () => (await (await fetch(`${base}/healthz`)).json()).activeTurns === 0, 'usage turn finished');
      const view = await api('context', { threadId: a });
      assert.equal(view.status, 200, JSON.stringify(view.body));
      assert.equal(view.body.usage.totalTokens, 19, 'occupancy = last.inputTokens + last.outputTokens');
      assert.equal(view.body.usage.percent, 2, 'percent uses occupancy over the window (19/1000 rounds to 2)');
    });
    await t.test('MCP elicitation becomes an approval card and returns action accept', async () => {
      const cursor = (await (await fetch(`${base}/healthz`)).json()).seq;
      await api('turn/send', { threadId: a, text: 'elicitation' });
      const controller = new AbortController(); controllers.push(controller);
      const stream = await collectSse(`${base}/api/events?token=${token}&after=${cursor}&threadId=${a}`, controller.signal);
      const approval = await until(() => stream.events.find(event => event.type === 'approval.request'), 'MCP approval event');
      assert.equal(approval.kind, 'elicitation');
      assert.match(approval.payload.reason, /Allow the plan tool/);
      assert.equal((await api('approval', { approvalId: approval.approvalId, decision: 'accept' })).status, 200);
      await until(() => stream.events.some(event => event.type === 'turn.end'), 'MCP approved completion');
      const response = (await trace()).find(item => item.kind === 'client-response' && String(item.id).startsWith('fixture-elicitation-'));
      assert.deepEqual(response.result, { action: 'accept', content: null, _meta: null });
      assert(!stream.events.some(event => event.code === 'codex/unsupported-interaction'));
      controller.abort(); await stream.done;
    });
    await t.test('full access auto-accepts MCP elicitation instead of asking again', async () => {
      // 用户点了「完全权限」并且已经允许过：MCP 工具审批不该再逐次弹卡。
      const cursor = (await (await fetch(`${base}/healthz`)).json()).seq;
      await api('turn/send', { threadId: a, text: 'elicitation', approvalPolicy: 'never' });
      const controller = new AbortController(); controllers.push(controller);
      const stream = await collectSse(`${base}/api/events?token=${token}&after=${cursor}&threadId=${a}`, controller.signal);
      await until(() => stream.events.some(event => event.type === 'turn.end'), 'auto-approved completion');
      assert(!stream.events.some(event => event.type === 'approval.request'), 'no approval card under full access');
      const auto = stream.events.find(event => event.type === 'approval.auto');
      assert(auto, 'the UI still gets an approval.auto notice');
      const response = (await trace()).find(item => item.kind === 'client-response' && String(item.id).startsWith('fixture-elicitation-'));
      assert.deepEqual(response.result, { action: 'accept', content: null, _meta: null });
      controller.abort(); await stream.done;
    });
    await t.test('danger-full-access auto-accepts command approvals without a dead card', async () => {
      const cursor = (await (await fetch(`${base}/healthz`)).json()).seq;
      await api('turn/send', { threadId: a, text: 'approval', sandboxMode: 'danger-full-access', approvalPolicy: 'on-request' });
      const controller = new AbortController(); controllers.push(controller);
      const stream = await collectSse(`${base}/api/events?token=${token}&after=${cursor}&threadId=${a}`, controller.signal);
      await until(() => stream.events.some(event => event.type === 'turn.end'), 'command auto-approved completion');
      assert(!stream.events.some(event => event.type === 'approval.request'));
      assert(stream.events.some(event => event.type === 'approval.auto' && event.decision === 'accept'));
      const response = (await trace()).find(item => item.kind === 'client-response' && String(item.id).startsWith('fixture-approval-'));
      assert.deepEqual(response.result, { decision: 'accept' });
      assert.equal((await (await fetch(`${base}/healthz`)).json()).activeTurns, 0);
      controller.abort(); await stream.done;
    });
    await t.test('completed turns expire outstanding approval requests', async () => {
      const cursor = (await (await fetch(`${base}/healthz`)).json()).seq;
      await api('turn/send', { threadId: a, text: 'stale-approval' }); await delay(100);
      const controller = new AbortController(); controllers.push(controller);
      const stream = await collectSse(`${base}/api/events?token=${token}&after=${cursor}&threadId=${a}`, controller.signal);
      const approval = await until(() => stream.events.find(event => event.type === 'approval.request'), 'approval before completed turn');
      await until(() => stream.events.some(event => event.type === 'turn.end'), 'completed turn invalidates pending request');
      assert.equal((await api('approval', { approvalId: approval.approvalId, decision: 'accept' })).status, 409);
      controller.abort(); await stream.done;
    });
    await t.test('an upstream 404 for the model becomes an actionable message', async () => {
      const cursor = (await (await fetch(`${base}/healthz`)).json()).seq;
      await api('turn/send', { threadId: a, text: 'model-missing' }); await delay(100);
      const controller = new AbortController(); controllers.push(controller);
      const stream = await collectSse(`${base}/api/events?token=${token}&after=${cursor}&threadId=${a}`, controller.signal);
      const end = await until(() => stream.events.find(event => event.type === 'turn.end'), 'failed turn end for a missing model');
      assert.equal(end.status, 'failed');
      // 不再把 codex 的原始 JSON 甩给用户（实测 0.170 的 message 里就是上游原话 + URL）。
      assert.match(end.error.message, /这个渠道没有当前模型/);
      assert.match(end.error.message, /换一个模型/);
      assert(!end.error.message.includes('127.0.0.1'), 'the message must not leak the local proxy URL');
      controller.abort(); await stream.done;
      await until(async () => (await (await fetch(`${base}/healthz`)).json()).activeTurns === 0, 'failed turn released');
    });
    await t.test('developerInstructions and summary:auto really reach codex, and thread/revert is forwarded', async () => {
      // 新会话通过 developerInstructions 固定初始人设/行为规范；每个 turn 请求 summary:auto。
      // 这两条如果不进报文，手机上就表现为「没人设、没思考链、不像 Codex」。
      const before = (await trace()).length;
      const created = await api('thread/create', { cwd: home });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const threadId = created.body.threadId;
      assert.equal(typeof created.body.developerInstructions, 'string');
      assert.match(created.body.developerInstructions, /Codex/);
      const startCall = (await trace()).slice(before).filter(item => item.method === 'thread/start').at(-1);
      assert.equal(typeof startCall.params.developerInstructions, 'string', 'thread/start must carry developerInstructions');
      assert.ok(startCall.params.developerInstructions.length > 40, 'the injected rules must be substantial');
      assert.equal(startCall.params.baseInstructions, undefined, 'baseInstructions must stay empty so the official codex baseline survives');

      const beforeTurn = (await trace()).length;
      assert.equal((await api('turn/send', { threadId, text: 'plan a small change' })).status, 200);
      const turnCall = (await trace()).slice(beforeTurn).filter(item => item.method === 'turn/start').at(-1);
      assert.equal(turnCall.params.summary, 'auto', 'turn/start must ask for a reasoning summary');

      await delay(60);
      const reverted = await api('thread/revert', { threadId, beforeTurnId: 'turn-xyz' });
      assert.equal(reverted.status, 200, JSON.stringify(reverted.body));
      assert.equal(reverted.body.threadId, threadId);
      const revertCall = (await trace()).filter(item => item.method === 'thread/revert').at(-1);
      assert.equal(revertCall.params.beforeTurnId, 'turn-xyz');
      assert.equal((await api('thread/revert', { threadId })).status, 400, 'beforeTurnId is required');
      await api('turn/send', { threadId, text: 'hold' });
      const busyRevert = await api('thread/revert', { threadId, beforeTurnId: 'turn-xyz' });
      assert.equal(busyRevert.status, 409, 'an active turn must not be reverted');
      assert.equal(busyRevert.body.error.code, 'codex/thread-busy');
      await api('turn/interrupt', { threadId });
      await until(async () => (await (await fetch(`${base}/healthz`)).json()).activeTurns === 0, 'turn released after revert');
    });
    await t.test('turn failure surfaces error and unlocks thread for another turn', async () => {
      const cursor = (await (await fetch(`${base}/healthz`)).json()).seq;
      await api('turn/send', { threadId: a, text: 'fail' }); await delay(100);
      const controller = new AbortController(); controllers.push(controller);
      const stream = await collectSse(`${base}/api/events?token=${token}&after=${cursor}&threadId=${a}`, controller.signal);
      const end = await until(() => stream.events.find(event => event.type === 'turn.end'), 'failed turn end');
      assert.equal(end.status, 'failed'); assert.equal(end.error.message, 'synthetic turn failure');
      assert(stream.events.some(event => event.type === 'error' && event.message === 'synthetic turn failure'));
      assert.equal((await api('turn/send', { threadId: a, text: 'recovery' })).status, 200);
      controller.abort(); await stream.done;
    });
  } finally {
    for (const controller of controllers) controller.abort();
    child.kill(); await Promise.race([exited, delay(3000)]);
    await out.close(); await err.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Synthetic toolpack module shape: mirrors TOOLPACKS-CONTRACT.md §3 (meta + tools + run).
function packModule(name, title, tools) {
  return `export const meta = ${JSON.stringify({ name, title, version: '1.0.0', description: `${title} helpers` })};
export const tools = ${JSON.stringify(tools.map(tool => ({ name: tool, description: `Run ${tool}.`, inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false } })))};
export const run = async () => ({ ok: true });
`;
}
function bridgeApi(base, headers) {
  return async function api(route, body, options = {}) {
    const response = await fetch(`${base}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options });
    return { status: response.status, body: await response.json() };
  };
}
async function exists(target) { try { await stat(target); return true; } catch { return false; } }
async function waitForBridge(child, outputPath, errorPath) {
  return until(async () => {
    if (child.exitCode !== null) throw Error(`Bridge exited ${child.exitCode}: ${await readFile(errorPath, 'utf8')}`);
    return (await readFile(outputPath, 'utf8')).match(/codex-go: (http:\/\/127\.0\.0\.1:\d+)\//)?.[1];
  }, 'bridge startup', 15000);
}

test('bridge handshake, subagent runs, provider model fetch and toolpacks follow the contract', { timeout: 90000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'codex-go-api-contract-'));
  const outputPath = join(home, 'stdout.log'), errorPath = join(home, 'stderr.log');
  const builtinPacks = join(home, 'builtin-packs');
  const upstreamRequests = [];
  const upstream = createServer((request, response) => {
    upstreamRequests.push({ url: request.url, authorization: request.headers.authorization });
    response.on('error', () => {});
    const send = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (request.url === '/bad/models') return send(503, { error: { message: 'synthetic upstream outage' } });
    if (request.url === '/junk/models') return send(200, 'not json at all');
    if (request.url === '/huge/models') return send(200, `{"data":[${' '.repeat(2 * 1024 * 1024 + 64)}null]}`);
    if (request.url === '/empty/models') return send(200, { data: [] });
    const authorization = request.headers.authorization;
    if (authorization !== 'Bearer sk-live' && authorization !== 'Bearer sk-stored-key') return send(401, { error: { message: 'bad key' } });
    return send(200, { object: 'list', data: [{ id: 'gpt-6.2-sol', owned_by: 'openai' }, { id: 'gpt-6.2-sol' }, { id: 'relay-mini', ownedBy: 'relay' }, { bad: true }, 'string-model'] });
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  // Builtin packs, a user pack and a deliberately broken user pack, all isolated in the temp home.
  await mkdir(join(builtinPacks, 'git'), { recursive: true }); await writeFile(join(builtinPacks, 'git', 'index.mjs'), packModule('git', 'Git', ['git_status', 'git_commit']));
  await mkdir(join(builtinPacks, 'web'), { recursive: true }); await writeFile(join(builtinPacks, 'web', 'index.mjs'), packModule('web', 'Web', ['web_fetch']));
  await mkdir(join(home, 'toolpacks', 'memory'), { recursive: true }); await writeFile(join(home, 'toolpacks', 'memory', 'index.mjs'), packModule('memory', 'Memory', ['memory_save']));
  await mkdir(join(home, 'toolpacks', 'zzbroken'), { recursive: true }); await writeFile(join(home, 'toolpacks', 'zzbroken', 'index.mjs'), "export const meta = {name:'zzbroken',");
  await writeFile(join(home, 'codex-go-secrets.json'), JSON.stringify({ CODEX_GO_RELAY2_KEY: 'sk-stored-key' }));
  await writeFile(join(home, 'synthetic-protocol-config.json'), JSON.stringify({ model_provider: 'openai', model: 'synthetic-model', model_providers: { relay2: { name: 'relay2', base_url: `${upstreamBase}/v1`, env_key: 'CODEX_GO_RELAY2_KEY' } } }));
  const out = await open(outputPath, 'w'), err = await open(errorPath, 'w');
  const child = spawn(process.execPath, [resolve(here, '../bridge/server.mjs'), '--codex', process.execPath, '--codex-arg', join(here, 'protocol-fixture.mjs'), '--codex-home', home, '--cwd', home, '--toolpacks', builtinPacks, '--host', '127.0.0.1', '--port', '0', '--token', token], { env: { ...process.env, CODEX_FIXTURE_TRACE: join(home, 'trace.jsonl') }, stdio: ['ignore', out.fd, err.fd], windowsHide: true });
  const exited = once(child, 'close');
  let base = '';
  const healthz = async () => (await (await fetch(`${base}/healthz`)).json());
  try {
    base = await waitForBridge(child, outputPath, errorPath);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const api = bridgeApi(base, headers);
    await t.test('writes the guest handshake file and never exposes the token over HTTP', async () => {
      const handshakePath = join(home, 'codex-go-bridge.json');
      const handshake = JSON.parse(await readFile(handshakePath, 'utf8'));
      assert.deepEqual(Object.keys(handshake).sort(), ['baseUrl', 'pid', 'startedAt', 'token', 'version']);
      assert.equal(handshake.baseUrl, base);
      assert.equal(handshake.token, token);
      assert.equal(handshake.pid, child.pid);
      assert.equal(handshake.version, '0.9.5');
      assert(Number.isInteger(handshake.startedAt) && handshake.startedAt > 0);
      if (process.platform !== 'win32') assert.equal((await stat(handshakePath)).mode & 0o777, 0o600, 'handshake must be mode 0600');
      const surfaces = [await healthz(), (await api('config')).body, (await api('toolpacks', {})).body, (await api('subagent/runs', {})).body, (await api('providers/models', { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-live' })).body];
      for (const surface of surfaces) assert(!JSON.stringify(surface).includes(token), 'no HTTP payload may carry the bridge token');
    });
    await t.test('thread delete maps to the official RPC and rejects missing ids', async () => {
      const created = await api('thread/create', { cwd: home });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const threadId = created.body.threadId;
      const removed = await api('thread/delete', { threadId });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.equal((await api('thread/delete', {})).status, 400);
    });
    await t.test('subagent run resolves the final assistant text and leaves no zombie turn', async () => {
      const run = await api('subagent/run', { prompt: 'summarize the workspace please', title: '子任务', name: 'researcher', role: 'reader', parentThreadId: 'parent-fixture', timeoutMs: 30000 });
      assert.equal(run.status, 200, JSON.stringify(run.body));
      assert.deepEqual(Object.keys(run.body).sort(), ['status', 'text', 'threadId', 'turnId']);
      assert.equal(run.body.status, 'completed');
      assert.match(run.body.threadId, /^fixture-thread-/);
      assert.match(run.body.turnId, /^fixture-turn-/);
      assert.match(run.body.text, /中文🙂/);
      assert.equal((await healthz()).activeTurns, 0, 'the completed subagent turn must be released');
      const input = (await readFile(join(home, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const start = input.filter(item => item.method === 'turn/start').at(-1);
      assert.equal(start.params.input[0].text, 'summarize the workspace please');
      const treeResponse = await fetch(`${base}/api/subagent/tree?parentThreadId=parent-fixture`, { headers });
      assert.equal(treeResponse.status, 200);
      const tree = await treeResponse.json();
      assert.equal(tree.agents.length, 1);
      assert.equal(tree.agents[0].name, 'researcher');
      assert.equal(tree.agents[0].role, 'reader');
      assert.equal(tree.agents[0].state, 'done');
      assert.equal(tree.agents[0].agentThreadId, run.body.threadId);
      assert(tree.agents[0].logs.some(log => log.type === 'text.delta' && log.text.includes('中文🙂')));
      // 子 Agent 的会话不进主历史；显式要求时才返回。
      const history = await api('thread/list', {});
      assert(!history.body.threads.some(thread => thread.id === run.body.threadId), 'subagent threads must not pollute user history');
      const withSubagents = await api('thread/list', { includeSubagents: true });
      assert(withSubagents.body.threads.some(thread => thread.id === run.body.threadId));
    });
    await t.test('subagent validation, failure and timeout use stable codes', async () => {
      assert.equal((await api('subagent/run', {})).status, 400);
      assert.equal((await api('subagent/run', { prompt: '   ' })).status, 400);
      assert.equal((await api('subagent/run', { prompt: 'x', timeoutMs: 999 })).status, 400);
      assert.equal((await api('subagent/run', { prompt: 'x', timeoutMs: 1800001 })).status, 400);
      assert.equal((await api('subagent/run', { prompt: 'x', timeoutMs: '600000' })).status, 400);
      assert.equal((await api('subagent/run', { prompt: 'x', cwd: 42 })).status, 400);
      assert.equal((await api('subagent/run', { prompt: 'x', model: 7 })).status, 400);
      assert.equal((await api('subagent/run', { prompt: 'x', reasoningEffort: 'invented' })).status, 400);
      assert.equal((await api('subagent/run', { prompt: 'x', title: '' })).status, 400);
      assert.equal((await api('subagent/run', { prompt: 'x', unknownField: true })).status, 400);
      const failed = await api('subagent/run', { prompt: 'fail this turn', title: 'failing run' });
      assert.equal(failed.status, 502, JSON.stringify(failed.body));
      assert.equal(failed.body.error.code, 'codex/subagent-failed');
      assert.equal(failed.body.error.message, 'synthetic turn failure');
      assert.match(failed.body.error.details.threadId, /^fixture-thread-/);
      assert.equal((await healthz()).activeTurns, 0, 'a failed subagent turn must be released');
      const slow = await api('subagent/run', { prompt: 'hold this turn', title: 'timed out run', timeoutMs: 1000 });
      assert.equal(slow.status, 504, JSON.stringify(slow.body));
      assert.equal(slow.body.error.code, 'codex/subagent-timeout');
      assert.equal(slow.body.error.details.timeoutMs, 1000);
      assert.match(slow.body.error.details.threadId, /^fixture-thread-/);
      await until(async () => (await healthz()).activeTurns === 0, 'timeout must release the turn');
    });
    await t.test('subagent runs keeps the last 20 in-memory runs newest first', async () => {
      const runs = await api('subagent/runs', {});
      assert.equal(runs.status, 200);
      assert(Array.isArray(runs.body.runs));
      assert.deepEqual(runs.body.runs.map(run => run.status), ['timeout', 'failed', 'completed']);
      const [newest] = runs.body.runs;
      assert.deepEqual(Object.keys(newest).sort(), ['finishedAt', 'id', 'preview', 'startedAt', 'status', 'threadId', 'title']);
      assert(newest.finishedAt >= newest.startedAt);
      assert.match(runs.body.runs[0].threadId, /^fixture-thread-/);
      assert.equal(runs.body.runs[2].title, '子任务');
      assert.match(runs.body.runs[2].preview, /中文🙂/);
      for (let index = 0; index < 19; index += 1) {
        const run = await api('subagent/run', { prompt: `cap ${index}` });
        assert.equal(run.status, 200, JSON.stringify(run.body));
      }
      const capped = await api('subagent/runs', {});
      assert.equal(capped.body.runs.length, 20, 'only the most recent 20 runs are kept');
      assert.equal(capped.body.runs.filter(run => run.status === 'completed').length, 19);
      assert.equal(capped.body.runs.at(-1).status, 'timeout', 'the oldest kept run is the timeout run');
      assert(!capped.body.runs.some(run => ['子任务', 'failing run'].includes(run.title)), 'evicted runs are the oldest ones');
      assert(capped.body.runs[0].title.startsWith('cap '), 'newest run is first');
    });
    await t.test('provider model fetch normalizes the upstream catalog', async () => {
      const listed = await api('providers/models', { baseUrl: `${upstreamBase}/v1`, apiKey: 'sk-live' });
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assert.deepEqual(listed.body, {
        baseUrl: `${upstreamBase}/v1`,
        models: [{ id: 'gpt-6.2-sol', ownedBy: 'openai' }, { id: 'relay-mini', ownedBy: 'relay' }, { id: 'string-model', ownedBy: null }],
        count: 3,
      });
      assert.equal(upstreamRequests.at(-1).url, '/v1/models');
      assert.equal(upstreamRequests.at(-1).authorization, 'Bearer sk-live');
      const trailing = await api('providers/models', { baseUrl: `${upstreamBase}/v1/`, apiKey: 'sk-live' });
      assert.equal(trailing.body.baseUrl, `${upstreamBase}/v1`);
      assert.equal(upstreamRequests.at(-1).url, '/v1/models');
      for (const candidate of [upstreamBase, `${upstreamBase}/v`]) {
        const normalized = await api('providers/models', { baseUrl: candidate, apiKey: 'sk-live' });
        assert.equal(normalized.status, 200, JSON.stringify(normalized.body));
        assert.equal(normalized.body.baseUrl, `${upstreamBase}/v1`);
        assert.equal(upstreamRequests.at(-1).url, '/v1/models');
      }
      const stored = await api('providers/models', { baseUrl: `${upstreamBase}/v1`, provider: 'relay2' });
      assert.equal(stored.status, 200, JSON.stringify(stored.body));
      assert.equal(upstreamRequests.at(-1).authorization, 'Bearer sk-stored-key', 'a provider without apiKey must use the stored provider secret');
      const empty = await api('providers/models', { baseUrl: `${upstreamBase}/empty`, apiKey: 'sk-live' });
      assert.deepEqual(empty.body, { baseUrl: `${upstreamBase}/empty`, models: [], count: 0 });
    });
    await t.test('provider model fetch maps upstream, network and limit failures', async () => {
      const outage = await api('providers/models', { baseUrl: `${upstreamBase}/bad`, apiKey: 'sk-live' });
      assert.equal(outage.status, 502); assert.equal(outage.body.error.code, 'provider/models-fetch'); assert.equal(outage.body.error.details.status, 503);
      const unreachable = await api('providers/models', { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-live' });
      assert.equal(unreachable.status, 502); assert.equal(unreachable.body.error.code, 'provider/models-unreachable');
      const huge = await api('providers/models', { baseUrl: `${upstreamBase}/huge`, apiKey: 'sk-live' });
      assert.equal(huge.status, 502); assert.equal(huge.body.error.code, 'provider/models-too-large');
      const junk = await api('providers/models', { baseUrl: `${upstreamBase}/junk`, apiKey: 'sk-live' });
      assert.equal(junk.status, 502); assert.equal(junk.body.error.code, 'provider/models-invalid');
      assert.match(junk.body.error.hint, /手动输入模型 ID/);
      assert.match(junk.body.error.hint, /\/v1/);
      for (const body of [outage, unreachable, huge, junk]) assert(!JSON.stringify(body).includes('sk-live'), 'errors must never echo the API key');
      for (const baseUrl of ['https://user:pass@relay.example/v1', 'https://relay.example/v1?key=1', 'https://relay.example/v1#fragment', 'relay.example/v1', 'ftp://relay.example/v1', '', '   ']) {
        const rejected = await api('providers/models', { baseUrl, apiKey: 'sk-live' });
        assert.equal(rejected.status, 400, `must reject ${JSON.stringify(baseUrl)}`);
        assert.equal(rejected.body.error.code, 'provider/base-url');
      }
      assert.equal((await api('providers/models', { baseUrl: `${upstreamBase}/v1` })).body.error.code, 'provider/api-key');
      assert.equal((await api('providers/models', { baseUrl: `${upstreamBase}/v1`, apiKey: '   ' })).body.error.code, 'provider/api-key');
      assert.equal((await api('providers/models', { baseUrl: `${upstreamBase}/v1`, provider: 'nosuch' })).body.error.code, 'provider/unknown');
      assert.equal((await api('providers/models', { baseUrl: `${upstreamBase}/v1`, apiKey: 'sk-live', extra: 1 })).status, 400);
      assert.equal((await fetch(`${base}/api/providers/models`, { headers })).status, 405, 'models fetch is POST only');
    });
    await t.test('toolpack list, toggle and builtin removal protection', async () => {
      const listed = await api('toolpacks', {});
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assert.deepEqual(listed.body.packs.map(pack => pack.name), ['git', 'web', 'memory', 'zzbroken']);
      const git = listed.body.packs[0];
      assert.deepEqual(git, {
        name: 'git', title: 'Git', version: '1.0.0', description: 'Git helpers', builtin: true, enabled: true,
        tools: [{ name: 'git_status', description: 'Run git_status.' }, { name: 'git_commit', description: 'Run git_commit.' }],
      });
      assert.equal(listed.body.packs[1].builtin, true);
      assert.equal(listed.body.packs[2].builtin, false);
      assert.equal(listed.body.packs[2].tools[0].name, 'memory_save');
      assert.deepEqual(listed.body.packs[3].tools, []);
      assert.match(listed.body.packs[3].error, /zzbroken|SyntaxError|Unexpected/i, 'a broken pack must be reported, not hidden');
      const off = await api('toolpacks/toggle', { name: 'web', enabled: false });
      assert.equal(off.status, 200, JSON.stringify(off.body)); assert.deepEqual(off.body, { name: 'web', enabled: false });
      assert.deepEqual(JSON.parse(await readFile(join(home, 'codex-go-toolpacks.json'), 'utf8')), { disabled: ['web'] });
      assert.equal((await api('toolpacks', {})).body.packs.find(pack => pack.name === 'web').enabled, false);
      assert.equal((await api('toolpacks', {})).body.packs.find(pack => pack.name === 'git').enabled, true);
      assert.deepEqual((await api('toolpacks/toggle', { name: 'web', enabled: true })).body, { name: 'web', enabled: true });
      assert.deepEqual(JSON.parse(await readFile(join(home, 'codex-go-toolpacks.json'), 'utf8')), { disabled: [] });
      const missing = await api('toolpacks/toggle', { name: 'ghost', enabled: false });
      assert.equal(missing.status, 404); assert.equal(missing.body.error.code, 'toolpack/not-found');
      assert.equal((await api('toolpacks/toggle', { name: 'web' })).status, 400);
      assert.equal((await api('toolpacks/toggle', { name: 'web', enabled: 'no' })).status, 400);
      assert.equal((await api('toolpacks/toggle', { name: 'Bad.Name', enabled: false })).status, 400);
      assert.equal((await api('toolpacks/toggle', { name: 'web', enabled: false, extra: 1 })).status, 400);
      const builtin = await api('toolpacks/remove', { name: 'git' });
      assert.equal(builtin.status, 400); assert.equal(builtin.body.error.code, 'toolpack/builtin');
      assert.equal(await exists(join(builtinPacks, 'git', 'index.mjs')), true, 'builtin packs stay on disk');
      assert.equal((await api('toolpacks/remove', { name: 'ghost' })).status, 404);
      assert.equal((await fetch(`${base}/api/toolpacks`, { headers })).status, 405, 'toolpack list is POST only');
    });
    await t.test('toolpack import copies a directory and is idempotent by pack name', async () => {
      const incoming = join(home, 'incoming');
      const source = join(incoming, 'mypack');
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'index.mjs'), packModule('mypack', 'My Pack', ['my_pack_tool']));
      await writeFile(join(source, 'README.md'), 'synthetic pack asset\n');
      const imported = await api('toolpacks/import', { path: source });
      assert.equal(imported.status, 200, JSON.stringify(imported.body));
      assert.deepEqual(imported.body, { name: 'mypack' });
      assert.equal(await exists(join(home, 'toolpacks', 'mypack', 'index.mjs')), true);
      assert.equal(await readFile(join(home, 'toolpacks', 'mypack', 'README.md'), 'utf8'), 'synthetic pack asset\n', 'the whole directory is copied');
      const installed = (await api('toolpacks', {})).body.packs.find(pack => pack.name === 'mypack');
      assert.equal(installed.builtin, false); assert.equal(installed.tools.length, 1);
      assert.deepEqual((await api('toolpacks/import', { path: source })).body, { name: 'mypack' }, 're-import is idempotent');
      assert.deepEqual((await api('toolpacks/import', { path: join(home, 'toolpacks', 'mypack') })).body, { name: 'mypack' });
      assert.equal((await api('toolpacks/import', { path: 'relative/pack' })).status, 400);
      assert.equal((await api('toolpacks/import', { path: join(home, 'absent') })).status, 400);
      assert.equal((await api('toolpacks/import', { path: source, extra: 1 })).status, 400);
      const bare = join(incoming, 'bare'); await mkdir(bare, { recursive: true }); await writeFile(join(bare, 'notes.txt'), 'no module');
      assert.equal((await api('toolpacks/import', { path: bare })).body.error.code, 'toolpack/import');
      const badName = join(incoming, 'badname'); await mkdir(badName, { recursive: true }); await writeFile(join(badName, 'index.mjs'), packModule('Bad-Name', 'Bad', ['bad_tool']));
      assert.equal((await api('toolpacks/import', { path: badName })).body.error.code, 'toolpack/invalid');
      const reserved = join(incoming, 'git-clone'); await mkdir(reserved, { recursive: true }); await writeFile(join(reserved, 'index.mjs'), packModule('git', 'Git Clone', ['git_clone']));
      const reservedResult = await api('toolpacks/import', { path: reserved });
      assert.equal(reservedResult.status, 400); assert.equal(reservedResult.body.error.code, 'toolpack/builtin');
      const removed = await api('toolpacks/remove', { name: 'mypack' });
      assert.equal(removed.status, 200); assert.deepEqual(removed.body, { removed: true, name: 'mypack' });
      assert.equal(await exists(join(home, 'toolpacks', 'mypack')), false);
      assert.equal((await api('toolpacks', {})).body.packs.some(pack => pack.name === 'mypack'), false);
      assert.equal((await api('toolpacks/remove', { name: 'mypack' })).status, 404);
      assert.equal((await api('toolpacks/remove', { name: 'zzbroken' })).status, 200, 'a broken user pack can still be removed');
    });
  } finally {
    child.kill(); await Promise.race([exited, delay(5000)]);
    upstream.close(); upstream.closeAllConnections?.();
    await out.close(); await err.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('toolpack API stays honest when the builtin and user pack directories are absent', { timeout: 30000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'codex-go-toolpacks-empty-'));
  const outputPath = join(home, 'stdout.log'), errorPath = join(home, 'stderr.log');
  const out = await open(outputPath, 'w'), err = await open(errorPath, 'w');
  const child = spawn(process.execPath, [resolve(here, '../bridge/server.mjs'), '--codex', process.execPath, '--codex-arg', join(here, 'protocol-fixture.mjs'), '--codex-home', home, '--cwd', home, '--toolpacks', join(home, 'no-such-builtin-dir'), '--host', '127.0.0.1', '--port', '0', '--token', token], { stdio: ['ignore', out.fd, err.fd], windowsHide: true });
  const exited = once(child, 'close');
  try {
    const base = await waitForBridge(child, outputPath, errorPath);
    const api = bridgeApi(base, { authorization: `Bearer ${token}`, 'content-type': 'application/json' });
    const listed = await api('toolpacks', {});
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(listed.body, { packs: [] });
    assert.equal((await api('subagent/runs', {})).body.runs.length, 0);
    const source = join(home, 'incoming-pack');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'index.mjs'), packModule('incoming_pack', 'Incoming', ['incoming_tool']));
    assert.deepEqual((await api('toolpacks/import', { path: source })).body, { name: 'incoming_pack' });
    assert.equal((await api('toolpacks', {})).body.packs.length, 1);
    assert.equal((await api('toolpacks/toggle', { name: 'incoming_pack', enabled: false })).status, 200);
    assert.equal((await api('toolpacks', {})).body.packs[0].enabled, false);
    assert.equal((await api('toolpacks/remove', { name: 'incoming_pack' })).status, 200);
    assert.deepEqual((await api('toolpacks', {})).body, { packs: [] });
  } finally {
    child.kill(); await Promise.race([exited, delay(5000)]);
    await out.close(); await err.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// Synthetic JSON-RPC executable following the test/protocol-fixture.mjs pattern, extended with
// thread/compact/start and tokenUsage so CONTRACT-V2 §B can be driven end to end.
// This is NOT the official Codex CLI.
const compactFixtureSource = `// Synthetic JSON-RPC test executable (protocol-fixture.mjs pattern, compact + usage capable).
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

if (!process.argv.includes('app-server')) throw Error('Fixture must be explicitly selected as an app-server executable');
const tracePath = process.env.CODEX_FIXTURE_TRACE;
const trace = value => { if (tracePath) appendFileSync(tracePath, JSON.stringify(value) + '\\n'); };
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const threads = new Map();
const failCompact = new Set();
let threadCounter = 0, turnCounter = 0;
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
 try {
  const message = JSON.parse(line);
  if (!message.method) return trace({ kind: 'client-response', ...message });
  const { id, method, params = {} } = message;
  trace({ kind: 'request', method, params });
  if (method === 'initialized') return;
  if (method === 'initialize') return reply(id, { userAgent: 'synthetic-compact-fixture/0.170.0' });
  if (method === 'config/read') return reply(id, { config: { model_provider: 'openai', model: 'synthetic-model', model_providers: {} }, origins: {}, layers: null });
  if (method === 'thread/start') {
   const thread = { id: 'compact-thread-' + (++threadCounter), name: null, preview: '', cwd: params.cwd, turns: [], createdAt: 1, updatedAt: 1 };
   threads.set(thread.id, thread);
   reply(id, { thread, model: 'synthetic-model', modelProvider: 'openai' });
   return;
  }
  if (method === 'thread/resume' || method === 'thread/read') return reply(id, { thread: threads.get(params.threadId) || { id: params.threadId, turns: [] } });
  if (method === 'thread/compact/start') {
   if (!threads.has(params.threadId)) return send({ id, error: { code: -32602, message: 'synthetic unknown thread' } });
   if (failCompact.has(params.threadId)) return send({ id, error: { code: -32000, message: 'synthetic compact failure' } });
   return reply(id, {});
  }
  if (method === 'turn/start') {
   const turnId = 'compact-turn-' + (++turnCounter);
   const text = (params.input || []).filter(item => item.type === 'text').map(item => item.text).join(' ');
   reply(id, { turn: { id: turnId, items: [], status: 'inProgress', error: null } });
   notify('turn/started', { threadId: params.threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } });
   setTimeout(() => {
    const total = text.includes('low-usage')
     ? { totalTokens: 82, inputTokens: 80, cachedInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0 }
     : { totalTokens: 9600, inputTokens: 9000, cachedInputTokens: 0, outputTokens: 600, reasoningOutputTokens: 0 };
    notify('thread/tokenUsage/updated', { threadId: params.threadId, turnId, tokenUsage: { total, last: total, modelContextWindow: 8192 } });
    if (text.includes('fail-compact')) failCompact.add(params.threadId);
    notify('item/agentMessage/delta', { threadId: params.threadId, turnId, itemId: 'synthetic-compact-message', delta: 'compact fixture reply' });
    notify('turn/completed', { threadId: params.threadId, turn: { id: turnId, status: 'completed', items: [], error: null } });
   }, 20);
   return;
  }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'Synthetic fixture does not implement ' + method } });
 } catch (error) { process.stderr.write('Synthetic compact fixture error: ' + error.message + '\\n'); }
});
`;

test('context settings, token usage tracking and automatic compaction follow contract section B', { timeout: 60000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'codex-go-context-'));
  const outputPath = join(home, 'stdout.log'), errorPath = join(home, 'stderr.log');
  const fixturePath = join(home, 'compact-fixture.mjs');
  const tracePath = join(home, 'trace.jsonl');
  await writeFile(fixturePath, compactFixtureSource);
  const out = await open(outputPath, 'w'), err = await open(errorPath, 'w');
  const child = spawn(process.execPath, [resolve(here, '../bridge/server.mjs'), '--codex', process.execPath, '--codex-arg', fixturePath, '--codex-home', home, '--cwd', home, '--toolpacks', join(home, 'no-builtin-packs'), '--plugins', join(home, 'no-builtin-plugins'), '--host', '127.0.0.1', '--port', '0', '--token', token], { env: { ...process.env, CODEX_FIXTURE_TRACE: tracePath }, stdio: ['ignore', out.fd, err.fd], windowsHide: true });
  const exited = once(child, 'close');
  const controllers = [];
  const settingsPath = join(home, 'codex-go-settings.json');
  try {
    const base = await waitForBridge(child, outputPath, errorPath);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const api = bridgeApi(base, headers);
    const trace = async () => (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const seq = async () => (await (await fetch(`${base}/healthz`)).json()).seq;
    const compactCalls = async threadId => (await trace()).filter(item => item.kind === 'request' && item.method === 'thread/compact/start' && (!threadId || item.params.threadId === threadId));
    async function streamFor(threadId) {
      const controller = new AbortController(); controllers.push(controller);
      return collectSse(`${base}/api/events?token=${token}&after=${await seq()}&threadId=${threadId}`, controller.signal);
    }
    await t.test('context read returns contract defaults without creating the settings file', async () => {
      const defaults = await api('context', {});
      assert.equal(defaults.status, 200, JSON.stringify(defaults.body));
      assert.deepEqual(defaults.body, { enabled: true, thresholdPercent: 75, keepRecentTurns: 4, autoCompact: true, summaryModel: null, contextWindowTokens: null, usage: { totalTokens: 0, contextWindow: null, contextWindowSource: 'unknown', percent: 0 } });
      assert.equal(await exists(settingsPath), false, 'reading context settings must not create the file');
      assert(!JSON.stringify(defaults.body).includes(token), 'context read must never expose the bridge token');
      assert.equal((await fetch(`${base}/api/context`, { headers })).status, 405, 'context read is POST only');
      assert.equal((await api('context', { threadId: 42 })).status, 400);
      assert.equal((await api('context', { unknownField: 1 })).status, 400);
    });
    await t.test('context config validates ranges and persists only the context block', async () => {
      for (const body of [{ thresholdPercent: 9 }, { thresholdPercent: 96 }, { thresholdPercent: 75.5 }, { thresholdPercent: '75' }, { keepRecentTurns: -1 }, { keepRecentTurns: 51 }, { keepRecentTurns: 2.5 }, { enabled: 'yes' }, { autoCompact: 1 }, { enabled: null }, { summaryModel: '' }, { summaryModel: '   ' }, { summaryModel: 'x'.repeat(201) }]) {
        const rejected = await api('context/config', body);
        assert.equal(rejected.status, 400, `must reject ${JSON.stringify(body)}`);
        assert.equal(rejected.body.error.code, 'context/invalid', `stable code for ${JSON.stringify(body)}`);
      }
      assert.equal((await api('context/config', { unknownField: true })).body.error.code, 'request/invalid');
      assert.equal(await exists(settingsPath), false, 'rejected writes must not create the settings file');
      const saved = await api('context/config', { thresholdPercent: 50, keepRecentTurns: 2, summaryModel: 'gpt-5-mini' });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual(saved.body, { enabled: true, thresholdPercent: 50, keepRecentTurns: 2, autoCompact: true, summaryModel: 'gpt-5-mini', contextWindowTokens: null, usage: { totalTokens: 0, contextWindow: null, contextWindowSource: 'unknown', percent: 0 } });
      assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')), { context: { enabled: true, thresholdPercent: 50, keepRecentTurns: 2, autoCompact: true, summaryModel: 'gpt-5-mini', contextWindowTokens: null } });
      assert.deepEqual((await api('context', {})).body, saved.body);
      const clearedModel = await api('context/config', { summaryModel: null });
      assert.equal(clearedModel.body.summaryModel, null);
      assert.equal(clearedModel.body.thresholdPercent, 50, 'partial updates keep the other fields');
    });
    await t.test('token usage is tracked, broadcast and triggers one automatic compaction', async () => {
      await api('context/config', { thresholdPercent: 50, autoCompact: true });
      const threadId = (await api('thread/create', {})).body.threadId;
      assert.match(threadId, /^compact-thread-\d+$/);
      const stream = await streamFor(threadId);
      assert.equal((await api('turn/send', { threadId, text: 'warm the context window' })).status, 200);
      const compacted = await until(() => stream.events.find(event => event.type === 'context.compacted'), 'automatic compaction event');
      const usage = stream.events.find(event => event.type === 'context.usage');
      assert(usage, 'context.usage must be broadcast');
      assert.deepEqual({ threadId: usage.threadId, totalTokens: usage.totalTokens, contextWindow: usage.contextWindow, contextWindowSource: usage.contextWindowSource, percent: usage.percent }, { threadId, totalTokens: 9600, contextWindow: 8192, contextWindowSource: 'upstream', percent: 100 });
      assert.deepEqual({ threadId: compacted.threadId, percent: compacted.percent }, { threadId, percent: 100 });
      assert(stream.events.some(event => event.type === 'turn.end'), 'compaction must not swallow the turn end');
      assert(stream.events.every(event => !event.threadId || event.threadId === threadId), 'thread streams stay isolated');
      await until(async () => (await compactCalls(threadId)).length === 1, 'one thread/compact/start call');
      assert.deepEqual((await api('context', { threadId })).body.usage, { totalTokens: 9600, contextWindow: 8192, contextWindowSource: 'upstream', percent: 100 });
      assert.deepEqual((await api('context', {})).body.usage, { totalTokens: 9600, contextWindow: 8192, contextWindowSource: 'upstream', percent: 100 }, 'the latest usage is reported without a threadId');
      controllers.pop().abort(); await stream.done;
      // 同一个 thread 60 秒内不重复触发自动压缩。
      assert.equal((await api('turn/send', { threadId, text: 'second turn within the window' })).status, 200);
      await until(async () => (await compactCalls()).length >= 1 && (await trace()).filter(item => item.method === 'turn/start' && item.params.threadId === threadId).length === 2, 'second turn started');
      await delay(400);
      assert.equal((await compactCalls(threadId)).length, 1, 'the same thread must not be compacted twice within 60s');
    });
    await t.test('the user-set context window drives the percentage instead of the upstream one', async () => {
      // 回归点：窗口大小只存在 App 本地时，桥算百分比用的是上游上报值，
      // 用户填了 20000 也不会有任何变化（「设置不生效」）。
      await api('context/config', { thresholdPercent: 95, autoCompact: false });
      const threadId = (await api('thread/create', {})).body.threadId;
      const stream = await streamFor(threadId);
      assert.equal((await api('turn/send', { threadId, text: 'window override check' })).status, 200);
      const before = await until(() => stream.events.find(event => event.type === 'context.usage'), 'usage before the override');
      assert.equal(before.contextWindowSource, 'upstream');
      assert.equal(before.percent, 100, 'the fixture reports 9600/8192');

      const configured = await api('context/config', { contextWindowTokens: 20000 });
      assert.equal(configured.status, 200, JSON.stringify(configured.body));
      assert.equal(configured.body.contextWindowTokens, 20000);
      // 刚改完窗口就来看用量，分母与百分比必须已经是新的（不能等下一轮 turn）。
      assert.deepEqual(configured.body.usage, { totalTokens: 9600, contextWindow: 20000, contextWindowSource: 'user', percent: 48 });
      assert.deepEqual((await api('context', { threadId })).body.usage, { totalTokens: 9600, contextWindow: 20000, contextWindowSource: 'user', percent: 48 });
      assert.equal((await api('turn/send', { threadId, text: 'window override check again' })).status, 200);
      const after = await until(
        () => stream.events.filter(event => event.type === 'context.usage').at(-1)?.contextWindowSource === 'user'
          ? stream.events.filter(event => event.type === 'context.usage').at(-1)
          : undefined,
        'usage with the user window',
      );
      assert.equal(after.contextWindow, 20000, 'the user window wins over modelContextWindow');
      assert.equal(after.percent, 48, '9600 / 20000 = 48%');
      assert.deepEqual((await api('context', {})).body.usage, { totalTokens: 9600, contextWindow: 20000, contextWindowSource: 'user', percent: 48 });

      // 清空后回到上游值。
      const cleared = await api('context/config', { contextWindowTokens: null });
      assert.equal(cleared.body.contextWindowTokens, null);
      assert.equal((await api('turn/send', { threadId, text: 'window override cleared' })).status, 200);
      const restored = await until(
        () => stream.events.filter(event => event.type === 'context.usage').at(-1)?.contextWindowSource === 'upstream'
          ? stream.events.filter(event => event.type === 'context.usage').at(-1)
          : undefined,
        'usage back to the upstream window',
      );
      assert.equal(restored.contextWindow, 8192);
      for (const bad of [0, 999, 10000001, 1.5, '20000']) {
        assert.equal((await api('context/config', { contextWindowTokens: bad })).body.error.code, 'context/invalid', `rejects ${bad}`);
      }
      controllers.pop().abort(); await stream.done;
    });
    await t.test('threshold, autoCompact switch and failures are reported honestly', async () => {
      await api('context/config', { thresholdPercent: 95, autoCompact: true });
      const quiet = (await api('thread/create', {})).body.threadId;
      const quietStream = await streamFor(quiet);
      assert.equal((await api('turn/send', { threadId: quiet, text: 'low-usage turn' })).status, 200);
      await until(() => quietStream.events.some(event => event.type === 'turn.end'), 'low usage turn end');
      await delay(300);
      assert(quietStream.events.some(event => event.type === 'context.usage' && event.percent === 1), 'low usage is still broadcast');
      assert(!quietStream.events.some(event => event.type === 'context.compacted'), 'usage under the threshold must not compact');
      assert.equal((await compactCalls(quiet)).length, 0);
      controllers.pop().abort(); await quietStream.done;

      await api('context/config', { thresholdPercent: 10, autoCompact: false });
      const disabled = (await api('thread/create', {})).body.threadId;
      const disabledStream = await streamFor(disabled);
      assert.equal((await api('turn/send', { threadId: disabled, text: 'auto compact disabled' })).status, 200);
      await until(() => disabledStream.events.some(event => event.type === 'turn.end'), 'disabled turn end');
      await delay(300);
      assert(!disabledStream.events.some(event => event.type === 'context.compacted'), 'autoCompact:false must not compact');
      assert.equal((await compactCalls(disabled)).length, 0);
      controllers.pop().abort(); await disabledStream.done;

      await api('context/config', { autoCompact: true });
      const failing = (await api('thread/create', {})).body.threadId;
      const failingStream = await streamFor(failing);
      assert.equal((await api('turn/send', { threadId: failing, text: 'please fail-compact this one' })).status, 200);
      const failure = await until(() => failingStream.events.find(event => event.type === 'context.compact-failed'), 'compaction failure event');
      assert.equal(failure.threadId, failing);
      assert.equal(failure.percent, 100);
      assert.equal(failure.code, 'codex/rpc-error');
      assert.match(failure.message, /synthetic compact failure/);
      assert(failingStream.events.some(event => event.type === 'turn.end' && event.status === 'completed'), 'a failed compaction must not break the conversation');
      assert.equal((await (await fetch(`${base}/healthz`)).json()).activeTurns === 0, true);
      controllers.pop().abort(); await failingStream.done;
    });
    await t.test('manual compaction calls the official RPC and maps failures', async () => {
      const threadId = (await api('thread/create', {})).body.threadId;
      const started = await api('context/compact', { threadId });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.deepEqual(started.body, { threadId, status: 'started' });
      assert.equal((await compactCalls(threadId)).length, 1);
      for (const body of [{}, { threadId: '' }, { threadId: 42 }, { threadId, extra: 1 }]) {
        const rejected = await api('context/compact', body);
        assert.equal(rejected.status, 400, `must reject ${JSON.stringify(body)}`);
      }
      const unknown = await api('context/compact', { threadId: 'no-such-thread' });
      assert.equal(unknown.status, 502);
      assert.equal(unknown.body.error.code, 'codex/rpc-error');
    });
  } finally {
    for (const controller of controllers) controller.abort();
    child.kill(); await Promise.race([exited, delay(3000)]);
    await out.close(); await err.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('persona managed block and plugin management follow contract sections C and D', { timeout: 60000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'codex-go-persona-plugins-'));
  const outputPath = join(home, 'stdout.log'), errorPath = join(home, 'stderr.log');
  const builtinPacks = join(home, 'builtin-packs');
  const builtinPlugins = join(home, 'builtin-plugins');
  const agentsPath = join(home, 'AGENTS.md');
  const skillsDir = join(home, 'skills');
  const userText = '# 用户手写指令\n\n保持中文回答🙂\n';
  const alphaSkill = '---\nname: alpha_skill\ndescription: 内置技能\n---\n\n# Alpha skill\n\n内置技能原始内容。\n';
  const userSkill = '# User skill\n\n用户技能内容。\n';
  await mkdir(join(builtinPacks, 'corepack'), { recursive: true });
  await writeFile(join(builtinPacks, 'corepack', 'index.mjs'), packModule('corepack', 'Core', ['core_tool']));
  await mkdir(join(builtinPlugins, 'alpha', 'toolpacks', 'alpha_pack'), { recursive: true });
  await mkdir(join(builtinPlugins, 'alpha', 'skills', 'alpha_skill'), { recursive: true });
  await writeFile(join(builtinPlugins, 'alpha', 'plugin.json'), JSON.stringify({ name: 'alpha', title: '内置 Alpha', version: '1.0.0', description: '内置插件示例', author: 'codex-pocket' }));
  await writeFile(join(builtinPlugins, 'alpha', 'toolpacks', 'alpha_pack', 'index.mjs'), packModule('alpha_pack', 'Alpha Pack', ['alpha_tool']));
  await writeFile(join(builtinPlugins, 'alpha', 'skills', 'alpha_skill', 'SKILL.md'), alphaSkill);
  const out = await open(outputPath, 'w'), err = await open(errorPath, 'w');
  const child = spawn(process.execPath, [resolve(here, '../bridge/server.mjs'), '--codex', process.execPath, '--codex-arg', join(here, 'protocol-fixture.mjs'), '--codex-home', home, '--cwd', home, '--toolpacks', builtinPacks, '--plugins', builtinPlugins, '--host', '127.0.0.1', '--port', '0', '--token', token], { env: { ...process.env, CODEX_FIXTURE_TRACE: join(home, 'trace.jsonl') }, stdio: ['ignore', out.fd, err.fd], windowsHide: true });
  const exited = once(child, 'close');
  const seen = [];
  try {
    const base = await waitForBridge(child, outputPath, errorPath);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const api = async (route, body) => {
      const result = await bridgeApi(base, headers)(route, body);
      seen.push(result.body);
      return result;
    };
    const personaBlockText = (name, style, instructions) => [
      '<!-- codex-pocket:persona:start -->',
      ...(name ? [`Name: ${name}`] : []),
      ...(style ? [`Style: ${style}`] : []),
      ...(instructions ? [...(name || style ? [''] : []), instructions] : []),
      '<!-- codex-pocket:persona:end -->',
    ].join('\n');
    await t.test('persona read returns contract defaults for an untouched home', async () => {
      const read = await api('persona', {});
      assert.equal(read.status, 200, JSON.stringify(read.body));
      assert.deepEqual({ name: read.body.name, style: read.body.style, instructions: read.body.instructions, active: read.body.active, path: read.body.path }, { name: '', style: '', instructions: '', active: true, path: agentsPath });
      assert.match(read.body.effectiveInstructions, /autonomous coding and device agent/);
      assert.equal(read.body.injection, 'developerInstructions+AGENTS.md');
      assert.equal(await exists(agentsPath), false, 'reading must not create AGENTS.md');
      assert.equal((await api('persona', { extra: 1 })).status, 400);
      assert.equal((await fetch(`${base}/api/persona`, { headers })).status, 405, 'persona read is POST only');
    });
    await t.test('persona save writes the managed block and preserves hand-written bytes', async () => {
      await writeFile(agentsPath, userText);
      const saved = await api('persona/save', { name: '小明', style: '简洁', instructions: '优先给出结论', active: true });
      assert.equal(saved.status, 200, JSON.stringify(saved.body));
      assert.deepEqual({ name: saved.body.name, style: saved.body.style, instructions: saved.body.instructions, active: saved.body.active, path: saved.body.path }, { name: '小明', style: '简洁', instructions: '优先给出结论', active: true, path: agentsPath });
      assert.match(saved.body.effectiveInstructions, /Name: 小明\nStyle: 简洁\n\n优先给出结论/);
      const block = personaBlockText('小明', '简洁', '优先给出结论');
      assert.equal(await readFile(agentsPath, 'utf8'), `${userText}\n${block}\n`);
      assert.deepEqual(JSON.parse(await readFile(join(home, 'codex-go-persona.json'), 'utf8')), { name: '小明', style: '简洁', instructions: '优先给出结论', active: true });
      assert.deepEqual((await api('persona', {})).body, saved.body);
      // 重复保存必须幂等，不能在文件里累积空行。
      await api('persona/save', { name: '小明', style: '简洁', instructions: '优先给出结论', active: true });
      assert.equal(await readFile(agentsPath, 'utf8'), `${userText}\n${block}\n`, 'repeated saves stay byte-identical');
    });
    await t.test('persona save replaces only the block and keeps trailing user content', async () => {
      const block = personaBlockText('小明', '简洁', '优先给出结论');
      const tail = '## 尾巴\n\n手写尾巴保持不动。\n';
      await writeFile(agentsPath, `${userText}\n${block}\n${tail}`);
      const updated = await api('persona/save', { instructions: '先给结论，再给理由' });
      assert.equal(updated.status, 200, JSON.stringify(updated.body));
      assert.equal(updated.body.name, '小明', 'omitted fields keep their stored value');
      assert.equal(updated.body.style, '简洁');
      const nextBlock = personaBlockText('小明', '简洁', '先给结论，再给理由');
      assert.equal(await readFile(agentsPath, 'utf8'), `${userText}\n${nextBlock}\n${tail}`);
      // 只清空 instructions：Name/Style 仍在，托管区块按新内容重写。
      const partial = await api('persona/save', { instructions: '' });
      assert.equal(partial.body.instructions, '');
      assert.equal(await readFile(agentsPath, 'utf8'), `${userText}\n${personaBlockText('小明', '简洁', '')}\n${tail}`);
    });
    await t.test('persona deactivation and clearing remove the block but keep persona.json', async () => {
      const block = personaBlockText('小明', '简洁', '先给结论，再给理由');
      // 这个子用例自己写 AGENTS.md，所以先把人设存成与区块一致的内容，避免依赖上一个用例的残留状态。
      const prepared = await api('persona/save', { name: '小明', style: '简洁', instructions: '先给结论，再给理由', active: true });
      assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
      await writeFile(agentsPath, `${userText}\n${block}\n`);
      const deactivated = await api('persona/save', { active: false });
      assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
      assert.equal(deactivated.body.active, false);
      assert.equal(await readFile(agentsPath, 'utf8'), userText, 'AGENTS.md must be restored byte-for-byte');
      assert.deepEqual(JSON.parse(await readFile(join(home, 'codex-go-persona.json'), 'utf8')), { name: '小明', style: '简洁', instructions: '先给结论，再给理由', active: false }, 'active:false keeps persona.json');
      const reactivated = await api('persona/save', { active: true });
      assert.equal(reactivated.body.active, true);
      assert.equal(await readFile(agentsPath, 'utf8'), `${userText}\n${block}\n`);
      const cleared = await api('persona/save', { name: '', style: '', instructions: '', active: true });
      assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
      assert.equal(await readFile(agentsPath, 'utf8'), userText, 'empty strings clear the managed block');
      assert.deepEqual(JSON.parse(await readFile(join(home, 'codex-go-persona.json'), 'utf8')), { name: '', style: '', instructions: '', active: true });
    });
    await t.test('persona validation rejects bad fields and unterminated blocks', async () => {
      assert.equal((await api('persona/save', { name: 42 })).body.error.code, 'persona/invalid');
      assert.equal((await api('persona/save', { active: 'yes' })).body.error.code, 'persona/invalid');
      assert.equal((await api('persona/save', { style: 'x'.repeat(2001) })).body.error.code, 'persona/invalid');
      assert.equal((await api('persona/save', { instructions: 'x'.repeat(40001) })).body.error.code, 'persona/invalid');
      assert.equal((await api('persona/save', { instructions: '<!-- codex-pocket:persona:end -->' })).body.error.code, 'persona/invalid');
      assert.equal((await api('persona/save', { unknown: true })).body.error.code, 'request/invalid');
      await writeFile(agentsPath, '手写内容\n<!-- codex-pocket:persona:start -->\n没有结束标记\n');
      const broken = await api('persona/save', { instructions: '任何内容' });
      assert.equal(broken.status, 500);
      assert.equal(broken.body.error.code, 'persona/state');
      assert.match(broken.body.error.message, /unterminated/i);
      await writeFile(agentsPath, '手写内容\n<!-- codex-pocket:persona:end -->\n没有开始标记\n');
      assert.equal((await api('persona/save', { instructions: '任何内容' })).body.error.code, 'persona/state');
      await writeFile(agentsPath, userText);
    });
    await t.test('developer instructions apply to new threads and honor session overrides', async () => {
      await api('persona/save', { name: '全局', style: '', instructions: '全局约束', active: true });
      const created = await api('thread/create', {});
      const threadId = created.body.threadId;
      let calls = (await readFile(join(home, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const started = calls.filter(item => item.method === 'thread/start').at(-1);
      assert.match(started.params.developerInstructions, /autonomous coding and device agent/);
      assert.match(started.params.developerInstructions, /Name: 全局\n\n全局约束/);
      assert.equal((await api('turn/send', { threadId, text: 'global instructions' })).status, 200);
      await delay(60);
      calls = (await readFile(join(home, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      assert.equal(calls.filter(item => item.method === 'turn/start').at(-1).params.summary, 'auto');
      await api('persona/save', { instructions: '更新约束' });
      await api('thread/create', {});
      calls = (await readFile(join(home, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const refreshed = calls.filter(item => item.method === 'thread/start').at(-1);
      assert.match(refreshed.params.developerInstructions, /更新约束/);
      assert.doesNotMatch(refreshed.params.developerInstructions, /全局约束/);
      await api('thread/create', { developerInstructions: '会话约束' });
      calls = (await readFile(join(home, 'trace.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const customStart = calls.filter(item => item.method === 'thread/start').at(-1);
      assert.match(customStart.params.developerInstructions, /会话约束/);
      assert.doesNotMatch(customStart.params.developerInstructions, /更新约束/);
    });
    await t.test('plugin listing reports manifest metadata and syncs builtin skills at startup', async () => {
      const listed = await api('plugins', {});
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assert.deepEqual(listed.body, { plugins: [{ name: 'alpha', title: '内置 Alpha', version: '1.0.0', description: '内置插件示例', builtin: true, enabled: true, toolpacks: ['alpha_pack'], skills: ['alpha_skill'] }] });
      await until(async () => exists(join(skillsDir, 'alpha_skill', 'SKILL.md')), 'startup skill sync');
      assert.equal(await readFile(join(skillsDir, 'alpha_skill', 'SKILL.md'), 'utf8'), alphaSkill, 'enabled plugin skills are copied byte-for-byte');
      const packs = await api('toolpacks', {});
      assert.deepEqual(packs.body.packs.map(pack => pack.name), ['corepack', 'alpha_pack'], 'plugin toolpacks load like builtin packs');
      assert.equal(packs.body.packs[1].builtin, false);
      assert.equal(packs.body.packs[1].tools[0].name, 'alpha_tool');
      assert.equal((await fetch(`${base}/api/plugins`, { headers })).status, 405, 'plugin list is POST only');
      assert.equal((await api('plugins', { extra: 1 })).status, 400);
    });
    await t.test('plugin toggle persists state and adds/removes skills', async () => {
      const off = await api('plugins/toggle', { name: 'alpha', enabled: false });
      assert.equal(off.status, 200, JSON.stringify(off.body));
      assert.deepEqual(off.body, { name: 'alpha', enabled: false });
      assert.deepEqual(JSON.parse(await readFile(join(home, 'codex-go-plugins.json'), 'utf8')), { disabled: ['alpha'] });
      assert.equal(await exists(join(skillsDir, 'alpha_skill')), false, 'disabling removes the synced skill directory');
      assert.equal((await api('plugins', {})).body.plugins[0].enabled, false);
      assert.deepEqual((await api('toolpacks', {})).body.packs.map(pack => pack.name), ['corepack'], 'a disabled plugin stops contributing toolpacks');
      const on = await api('plugins/toggle', { name: 'alpha', enabled: true });
      assert.deepEqual(on.body, { name: 'alpha', enabled: true });
      assert.deepEqual(JSON.parse(await readFile(join(home, 'codex-go-plugins.json'), 'utf8')), { disabled: [] });
      assert.equal(await readFile(join(skillsDir, 'alpha_skill', 'SKILL.md'), 'utf8'), alphaSkill, 're-enabling restores the skill');
      assert.deepEqual((await api('toolpacks', {})).body.packs.map(pack => pack.name), ['corepack', 'alpha_pack']);
      const ghost = await api('plugins/toggle', { name: 'ghost', enabled: false });
      assert.equal(ghost.status, 404); assert.equal(ghost.body.error.code, 'plugin/not-found');
      assert.equal((await api('plugins/toggle', { name: 'alpha', enabled: 'no' })).status, 400);
      assert.equal((await api('plugins/toggle', { name: 'alpha' })).status, 400);
      assert.equal((await api('plugins/toggle', { name: 'Bad.Name', enabled: false })).status, 400);
      assert.equal((await api('plugins/toggle', { name: 'alpha', enabled: false, extra: 1 })).status, 400);
    });
    await t.test('plugin install copies the directory, is idempotent and validates manifests', async () => {
      const source = join(home, 'incoming', 'user-plugin');
      await mkdir(join(source, 'toolpacks', 'user_pack'), { recursive: true });
      await mkdir(join(source, 'skills', 'user_skill'), { recursive: true });
      await writeFile(join(source, 'plugin.json'), JSON.stringify({ name: 'user-plugin', title: '用户插件', version: '0.2.0', description: '用户插件描述' }));
      await writeFile(join(source, 'toolpacks', 'user_pack', 'index.mjs'), packModule('user_pack', 'User Pack', ['user_tool']));
      await writeFile(join(source, 'skills', 'user_skill', 'SKILL.md'), userSkill);
      await writeFile(join(source, 'README.md'), 'plugin asset v1\n');
      const installed = await api('plugins/install', { path: source });
      assert.equal(installed.status, 200, JSON.stringify(installed.body));
      assert.deepEqual(installed.body, { name: 'user-plugin' });
      assert.equal(await readFile(join(home, 'plugins', 'user-plugin', 'README.md'), 'utf8'), 'plugin asset v1\n');
      assert.equal(await readFile(join(skillsDir, 'user_skill', 'SKILL.md'), 'utf8'), userSkill, 'installing an enabled plugin syncs its skills');
      const listing = (await api('plugins', {})).body.plugins;
      assert.deepEqual(listing.map(plugin => plugin.name), ['alpha', 'user-plugin']);
      assert.deepEqual(listing[1], { name: 'user-plugin', title: '用户插件', version: '0.2.0', description: '用户插件描述', builtin: false, enabled: true, toolpacks: ['user_pack'], skills: ['user_skill'] });
      assert.deepEqual((await api('toolpacks', {})).body.packs.map(pack => pack.name), ['corepack', 'alpha_pack', 'user_pack']);
      // 重名覆盖（幂等）：版本与资产一起替换。
      await writeFile(join(source, 'plugin.json'), JSON.stringify({ name: 'user-plugin', title: '用户插件', version: '0.3.0', description: '用户插件描述' }));
      await writeFile(join(source, 'README.md'), 'plugin asset v2\n');
      assert.deepEqual((await api('plugins/install', { path: source })).body, { name: 'user-plugin' });
      assert.equal((await api('plugins', {})).body.plugins.find(plugin => plugin.name === 'user-plugin').version, '0.3.0');
      assert.equal(await readFile(join(home, 'plugins', 'user-plugin', 'README.md'), 'utf8'), 'plugin asset v2\n');
      assert.equal(await exists(join(home, 'plugins', 'user-plugin', 'plugin.json.tmp')), false);
      assert.equal((await api('plugins/install', { path: 'relative/plugin' })).status, 400);
      assert.equal((await api('plugins/install', { path: join(home, 'absent') })).status, 400);
      assert.equal((await api('plugins/install', { path: source, extra: 1 })).status, 400);
      assert.equal((await api('plugins/install', {})).status, 400);
      const bare = join(home, 'incoming', 'bare');
      await mkdir(bare, { recursive: true }); await writeFile(join(bare, 'notes.txt'), 'no manifest');
      const bareResult = await api('plugins/install', { path: bare });
      assert.equal(bareResult.status, 400); assert.equal(bareResult.body.error.code, 'plugin/invalid');
      const badName = join(home, 'incoming', 'badname');
      await mkdir(badName, { recursive: true }); await writeFile(join(badName, 'plugin.json'), JSON.stringify({ name: 'Bad Name' }));
      assert.equal((await api('plugins/install', { path: badName })).body.error.code, 'plugin/invalid');
      const badPack = join(home, 'incoming', 'badpack');
      await mkdir(join(badPack, 'toolpacks', 'Bad-Pack'), { recursive: true }); await writeFile(join(badPack, 'plugin.json'), JSON.stringify({ name: 'badpack' }));
      assert.equal((await api('plugins/install', { path: badPack })).body.error.code, 'plugin/invalid');
      const reserved = join(home, 'incoming', 'alpha-clone');
      await mkdir(reserved, { recursive: true }); await writeFile(join(reserved, 'plugin.json'), JSON.stringify({ name: 'alpha' }));
      const reservedResult = await api('plugins/install', { path: reserved });
      assert.equal(reservedResult.status, 400); assert.equal(reservedResult.body.error.code, 'plugin/builtin');
      // 插件的工具包名必须全局唯一：后加载者被跳过，但要在 toolpacks 列表里留下原因。
      const dupeSource = join(home, 'incoming', 'dupe');
      await mkdir(join(dupeSource, 'toolpacks', 'alpha_pack'), { recursive: true });
      await writeFile(join(dupeSource, 'plugin.json'), JSON.stringify({ name: 'dupe', title: '重复工具包' }));
      await writeFile(join(dupeSource, 'toolpacks', 'alpha_pack', 'index.mjs'), packModule('alpha_pack', 'Dupe Alpha', ['dupe_tool']));
      assert.deepEqual((await api('plugins/install', { path: dupeSource })).body, { name: 'dupe' });
      const conflicted = (await api('toolpacks', {})).body.packs;
      assert.deepEqual(conflicted.map(pack => pack.name), ['corepack', 'alpha_pack', 'alpha_pack', 'user_pack']);
      assert.deepEqual(conflicted[2].tools, []);
      assert.equal(conflicted[2].builtin, false);
      assert.match(conflicted[2].error, /Plugin dupe ships toolpack alpha_pack/);
      // 损坏的用户插件目录要出现在列表里并带 error，而不是被静默隐藏。
      const brokenDir = join(home, 'plugins', 'broken');
      await mkdir(brokenDir, { recursive: true });
      const brokenEntry = (await api('plugins', {})).body.plugins.find(plugin => plugin.name === 'broken');
      assert.equal(brokenEntry.enabled, true);
      assert.equal(brokenEntry.builtin, false);
      assert.match(brokenEntry.error, /plugin\.json/);
      assert.deepEqual(brokenEntry.toolpacks, []);
      assert.deepEqual(brokenEntry.skills, []);
      await rm(brokenDir, { recursive: true, force: true });
      assert.equal((await api('plugins/remove', { name: 'dupe' })).status, 200);
      assert.deepEqual((await api('toolpacks', {})).body.packs.map(pack => pack.name), ['corepack', 'alpha_pack', 'user_pack'], 'removing the conflicting plugin clears its skipped entry');
    });
    await t.test('plugin removal refuses builtins and cleans user plugins, skills and state', async () => {
      const builtin = await api('plugins/remove', { name: 'alpha' });
      assert.equal(builtin.status, 400);
      assert.equal(builtin.body.error.code, 'plugin/builtin');
      assert.equal(await exists(join(builtinPlugins, 'alpha', 'plugin.json')), true, 'builtin plugin directories stay on disk');
      await api('plugins/toggle', { name: 'user-plugin', enabled: false });
      assert.equal(await exists(join(skillsDir, 'user_skill')), false);
      const removed = await api('plugins/remove', { name: 'user-plugin' });
      assert.equal(removed.status, 200, JSON.stringify(removed.body));
      assert.deepEqual(removed.body, { removed: true, name: 'user-plugin' });
      assert.equal(await exists(join(home, 'plugins', 'user-plugin')), false);
      assert.deepEqual(JSON.parse(await readFile(join(home, 'codex-go-plugins.json'), 'utf8')), { disabled: [] }, 'removal clears the disabled entry');
      assert.deepEqual((await api('plugins', {})).body.plugins.map(plugin => plugin.name), ['alpha']);
      assert.deepEqual((await api('toolpacks', {})).body.packs.map(pack => pack.name), ['corepack', 'alpha_pack']);
      assert.equal((await api('plugins/remove', { name: 'user-plugin' })).status, 404);
      assert.equal((await api('plugins/remove', { name: 'ghost' })).body.error.code, 'plugin/not-found');
      assert.equal((await api('plugins/remove', { name: 'Bad.Name' })).status, 400);
      assert.equal((await api('plugins/remove', { name: 'alpha', extra: 1 })).status, 400);
      for (const body of seen) assert(!JSON.stringify(body).includes(token), 'no plugin/persona payload may carry the bridge token');
    });
  } finally {
    child.kill(); await Promise.race([exited, delay(5000)]);
    await out.close(); await err.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('the stall watchdog is not kept alive by upstream retry noise', { timeout: 30000 }, async t => {
  // 上游断流时 codex 会一直发 "Reconnecting... n/5"，界面就永远「正在思考」。
  // 看门狗只认「有进展」的事件，重试噪音不能给它续命。
  const home = await mkdtemp(join(tmpdir(), 'codex-go-stall-'));
  const outputPath = join(home, 'stdout.log'), errorPath = join(home, 'stderr.log');
  const out = await open(outputPath, 'w'), err = await open(errorPath, 'w');
  const child = spawn(process.execPath, [resolve(here, '../bridge/server.mjs'), '--codex', process.execPath, '--codex-arg', join(here, 'protocol-fixture.mjs'), '--codex-home', home, '--cwd', home, '--toolpacks', join(home, 'no-builtin-packs'), '--plugins', join(home, 'no-builtin-plugins'), '--host', '127.0.0.1', '--port', '0', '--token', token], { env: { ...process.env, CODEX_GO_TURN_STALL_MS: '700', CODEX_GO_TURN_STALL_CHECK_MS: '150' }, stdio: ['ignore', out.fd, err.fd], windowsHide: true });
  const exited = once(child, 'close');
  const controllers = [];
  try {
    const base = await waitForBridge(child, outputPath, errorPath);
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const api = bridgeApi(base, headers);
    const threadId = (await api('thread/create', {})).body.threadId;
    const cursor = (await (await fetch(`${base}/healthz`)).json()).seq;
    assert.equal((await api('turn/send', { threadId, text: 'retry-storm' })).status, 200);
    const controller = new AbortController(); controllers.push(controller);
    const stream = await collectSse(`${base}/api/events?token=${token}&after=${cursor}&threadId=${threadId}`, controller.signal);
    // 噪音先到（3 条 willRetry），随后看门狗按「无进展」收尾。
    await until(() => stream.events.filter(event => event.type === 'error').length >= 2, 'retry noise events');
    const end = await until(() => stream.events.find(event => event.type === 'turn.end'), 'watchdog turn end', 8000);
    assert.equal(end.status, 'failed');
    assert.match(end.error, /没有进展/);
    controller.abort(); await stream.done;
    await until(async () => (await (await fetch(`${base}/healthz`)).json()).activeTurns === 0, 'watchdog releases the turn');
  } finally {
    child.kill(); await Promise.race([exited, delay(5000)]);
    await out.close(); await err.close();
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});