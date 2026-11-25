// CONTRACT-V3 A/B: real compatibility proxy + multi-channel registry.
// The upstream here is a local fake chat/completions server; the bridge runs against the
// explicitly selected synthetic JSON-RPC fixture. Nothing here pretends to call a real relay.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { start as startCompatProxy, toChatRequest } from '../bridge/compat-proxy.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const token = 'synthetic-channels-token';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 5000) {
 const end = Date.now() + timeout;
 while (Date.now() < end) { const value = await check(); if (value) return value; await delay(20); }
 throw Error(`Timed out: ${label}`);
}
async function exists(target) { try { await stat(target); return true; } catch { return false; } }

// 本机假上游：记录每个请求（含 Authorization 与 JSON body），由测试决定怎么回答。
async function fakeUpstream(handler) {
 const requests = [];
 const server = createServer((request, response) => {
  response.on('error', () => {});
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
   const raw = Buffer.concat(chunks).toString('utf8');
   let body = null;
   try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
   const record = { method: request.method, path: request.url, headers: { ...request.headers }, authorization: request.headers.authorization ?? null, body, raw };
   requests.push(record);
   Promise.resolve(handler({ request, response, body, raw })).catch(() => response.destroy());
  });
 });
 server.on('clientError', () => {});
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 return {
  requests,
  url: `http://127.0.0.1:${server.address().port}`,
  close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
 };
}

// 读 Responses SSE：事件名与 data.type 必须一致（标准 `event: <type>\ndata: {...}` 块）。
async function readResponsesSse(response) {
 assert.equal(response.status, 200);
 assert.match(response.headers.get('content-type'), /text\/event-stream/);
 const events = [];
 const reader = response.body.getReader();
 const decoder = new TextDecoder();
 let buffer = '';
 while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let boundary;
  while ((boundary = buffer.indexOf('\n\n')) >= 0) {
   const block = buffer.slice(0, boundary);
   buffer = buffer.slice(boundary + 2);
   const lines = block.split('\n');
   const eventLine = lines.find(line => line.startsWith('event: '));
   const dataLine = lines.find(line => line.startsWith('data: '));
   if (!eventLine || !dataLine) continue;
   const event = eventLine.slice(7).trim();
   const data = JSON.parse(dataLine.slice(6));
   assert.equal(data.type, event, 'every SSE block must carry the same event name and data type');
   events.push({ event, data });
  }
 }
 return events;
}

const RESPONSES_BODY = {
 model: 'deepseek-v4.1-flash',
 stream: true,
 instructions: 'Be terse.',
 input: [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: '读一下 a.txt' }] },
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: '再描述这张图' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
 ],
 tools: [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, strict: false }],
 tool_choice: 'auto',
 max_output_tokens: 64,
 reasoning: { effort: 'high' },
};

test('a namespace tool from codex is flattened into its per-tool functions', () => {
 // codex 0.170 把整个 MCP 服务器发成一个 type:'namespace' 工具；三种 chat 类 wire 都没有这个概念，
 // 旧实现只认 type:'function' 会把它连同里面的 100+ 个工具一起丢掉（手机上的模型就是这样盲的）。
 const request = toChatRequest({
  model: 'probe-model',
  input: [{ role: 'user', content: 'hi' }],
  tools: [
   { type: 'function', name: 'exec_command', description: 'run', parameters: { type: 'object', properties: {} } },
   {
    type: 'namespace', name: 'mcp__phone', description: 'server summary',
    tools: [
     { type: 'function', name: 'screen', description: 'read the phone screen', parameters: { type: 'object', properties: {} } },
     { type: 'function', name: 'tap', description: 'tap an element', parameters: { type: 'object', properties: {} } },
     { type: 'function', name: 'screen', description: 'duplicate name must not be sent twice', parameters: { type: 'object', properties: {} } },
    ],
   },
  ],
 }, 'probe-model');
 assert.deepEqual(request.tools.map(tool => tool.function.name), ['exec_command', 'screen', 'tap']);
 assert.equal(request.tools[1].function.description, 'read the phone screen');
 assert(request.tools.every(tool => tool.type === 'function'), 'chat wire may only carry plain functions');
 const collision = toChatRequest({
  model: 'probe-model', input: [{ role: 'user', content: 'hi' }],
  tools: [
   { type: 'namespace', name: 'mcp__a', tools: [{ type: 'function', name: 'screen', parameters: { type: 'object' } }] },
   { type: 'namespace', name: 'mcp__b', tools: [{ type: 'function', name: 'screen', parameters: { type: 'object' } }] },
  ],
 }, 'probe-model');
 assert.deepEqual(collision.tools.map(tool => tool.function.name), ['screen', 'b__screen'], 'same-name tools in different namespaces need distinct aliases');
});

test('chat tool calls restore the namespace required by the codex router', { timeout: 30000 }, async t => {
 const upstream = await fakeUpstream(({ response }) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'screen', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
  response.end('data: [DONE]\n\n');
 });
 t.after(() => upstream.close());
 const proxy = await startCompatProxy(0, '127.0.0.1', {
  lookupChannel: id => ({ id, baseUrl: `${upstream.url}/v1`, wire: 'openai-chat', model: 'probe-model', apiKey: 'probe' }),
 });
 t.after(() => proxy.close());
 const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/relay/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
  model: 'probe-model', input: [{ role: 'user', content: 'read the screen' }],
  tools: [{ type: 'namespace', name: 'mcp__phone', tools: [{ type: 'function', name: 'screen', description: 'read', parameters: { type: 'object', properties: {} } }] }],
 }) });
 const events = await readResponsesSse(response);
 const calls = [
  ...events.filter(item => item.data.item?.type === 'function_call').map(item => item.data.item),
  ...events.filter(item => item.event === 'response.completed').flatMap(item => (item.data.response?.output ?? []).filter(output => output.type === 'function_call')),
 ];
 assert.ok(calls.length >= 3, 'added/done/completed must all carry the same call');
 for (const call of calls) {
  assert.equal(call.name, 'screen');
  assert.equal(call.namespace, 'mcp__phone');
  if (call.status !== 'in_progress') assert.equal(call.arguments, '{}');
 }
});

test('compat proxy maps a streaming chat upstream onto the Responses event sequence', { timeout: 30000 }, async t => {
 const upstream = await fakeUpstream(({ response }) => {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const chunks = [
   { id: 'chatcmpl-1', choices: [{ index: 0, delta: { role: 'assistant' } }] },
   { choices: [{ index: 0, delta: { reasoning_content: '想一想。' } }] },
   { choices: [{ index: 0, delta: { reasoning_content: '再想一步。' } }] },
   { choices: [{ index: 0, delta: { content: '你好' } }] },
   { choices: [{ index: 0, delta: { content: '，世界' } }] },
   { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'read_file', arguments: '{"path"' } }] } }] },
   { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ':"a.txt"}' } }] } }] },
   { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
   { choices: [], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, completion_tokens_details: { reasoning_tokens: 3 } } },
  ];
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end('data: [DONE]\n\n');
 });
 t.after(() => upstream.close());
 const proxy = await startCompatProxy(0, '127.0.0.1', {
  lookupChannel: id => (id === 'relay-a' ? { id, baseUrl: `${upstream.url}/v1`, wire: 'chat', model: 'fallback-model', apiKey: 'sk-proxy-test' } : null),
 });
 t.after(() => proxy.close());

 const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/relay-a/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(RESPONSES_BODY),
 });
 const events = await readResponsesSse(response);
 assert.deepEqual(events.map(item => item.event), [
  'response.created',
  'response.output_item.added',
  'response.reasoning_summary_text.delta',
  'response.reasoning_summary_text.delta',
  'response.output_item.added',
  'response.output_text.delta',
  'response.output_text.delta',
  'response.output_item.added',
  'response.function_call_arguments.delta',
  'response.function_call_arguments.delta',
  'response.output_item.done',
  'response.output_item.done',
  'response.output_item.done',
  'response.completed',
 ]);
 assert.deepEqual(events.filter(item => item.event === 'response.reasoning_summary_text.delta').map(item => item.data.delta), ['想一想。', '再想一步。']);
 assert.deepEqual(events.filter(item => item.event === 'response.output_text.delta').map(item => item.data.delta), ['你好', '，世界']);
 assert.deepEqual(events.filter(item => item.event === 'response.function_call_arguments.delta').map(item => item.data.delta), ['{"path"', ':"a.txt"}']);
 const added = events.filter(item => item.event === 'response.output_item.added').map(item => item.data.item);
 assert.deepEqual(added.map(item => item.type), ['reasoning', 'message', 'function_call']);
 assert.equal(added[2].call_id, 'call_abc');
 assert.equal(added[2].name, 'read_file');
 assert.equal(added[2].arguments, '');
 const done = events.filter(item => item.event === 'response.output_item.done').map(item => item.data.item);
 assert.deepEqual(done.map(item => item.type), ['reasoning', 'message', 'function_call']);
 assert.equal(done[0].summary[0].text, '想一想。再想一步。');
 assert.equal(done[1].role, 'assistant');
 assert.equal(done[1].content[0].type, 'output_text');
 assert.equal(done[1].content[0].text, '你好，世界');
 assert.equal(done[2].call_id, 'call_abc');
 assert.equal(done[2].name, 'read_file');
 assert.equal(done[2].arguments, '{"path":"a.txt"}');
 const completed = events.at(-1).data.response;
 assert.equal(completed.status, 'completed');
 assert.equal(completed.object, 'response');
 assert.deepEqual(completed.output.map(item => item.type), ['reasoning', 'message', 'function_call']);
 assert.deepEqual({
  input: completed.usage.input_tokens,
  output: completed.usage.output_tokens,
  total: completed.usage.total_tokens,
  reasoning: completed.usage.output_tokens_details.reasoning_tokens,
 }, { input: 11, output: 7, total: 18, reasoning: 3 });

 // 上游请求形状：Responses 请求被翻译成 chat/completions。
 const sent = upstream.requests[0];
 assert.equal(sent.method, 'POST');
 assert.match(sent.path, /\/v1\/chat\/completions$/);
 assert.equal(sent.authorization, 'Bearer sk-proxy-test');
 assert.equal(sent.body.stream, true);
 assert.equal(sent.body.model, 'deepseek-v4.1-flash');
 assert.equal(sent.body.max_tokens, 64);
 assert.equal(sent.body.tool_choice, 'auto');
 assert.equal(sent.body.reasoning, undefined, 'reasoning.effort is dropped for relays');
 assert.deepEqual(sent.body.messages, [
  { role: 'system', content: 'Be terse.' },
  { role: 'user', content: '读一下 a.txt' },
  { role: 'user', content: [{ type: 'text', text: '再描述这张图' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
 ]);
 assert.deepEqual(sent.body.tools, [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, strict: false } }]);
});

test('compat proxy synthesizes full events from a non-streaming upstream and round-trips tool items', { timeout: 30000 }, async t => {
 const upstream = await fakeUpstream(({ response }) => {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
   id: 'chatcmpl-json',
   object: 'chat.completion',
   choices: [{
    index: 0,
    message: {
     role: 'assistant',
     reasoning_content: '先想想。',
     content: '目录里有 a.txt 和 b.txt。',
     tool_calls: [{ id: 'call_json', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }],
    },
    finish_reason: 'tool_calls',
   }],
   usage: { prompt_tokens: 9, completion_tokens: 12, total_tokens: 21 },
  }));
 });
 t.after(() => upstream.close());
 const proxy = await startCompatProxy(0, '127.0.0.1', {
  lookupChannel: id => (id === 'relay-json' ? { id, baseUrl: `${upstream.url}/v1`, wire: 'chat', model: 'fallback-model', apiKey: 'sk-json' } : null),
 });
 t.after(() => proxy.close());

 const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/relay-json/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
   model: 'relay-json-model',
   stream: true,
   input: [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '列目录' }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'list_dir', arguments: '{"path":"."}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'a.txt\nb.txt' },
   ],
   tools: [{ type: 'function', name: 'list_dir', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
  }),
 });
 const events = await readResponsesSse(response);
 assert.deepEqual(events.map(item => item.event), [
  'response.created',
  'response.output_item.added',
  'response.reasoning_summary_text.delta',
  'response.output_item.added',
  'response.output_text.delta',
  'response.output_item.added',
  'response.function_call_arguments.delta',
  'response.output_item.done',
  'response.output_item.done',
  'response.output_item.done',
  'response.completed',
 ]);
 assert.deepEqual(events.filter(item => item.event === 'response.reasoning_summary_text.delta').map(item => item.data.delta), ['先想想。']);
 assert.deepEqual(events.filter(item => item.event === 'response.output_text.delta').map(item => item.data.delta), ['目录里有 a.txt 和 b.txt。']);
 assert.deepEqual(events.filter(item => item.event === 'response.function_call_arguments.delta').map(item => item.data.delta), ['{"path":"."}']);
 const completed = events.at(-1).data.response;
 assert.deepEqual(completed.usage, {
  input_tokens: 9, input_tokens_details: { cached_tokens: 0 },
  output_tokens: 12, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 21,
 });

 // 工具往返：Responses function_call -> chat assistant.tool_calls，function_call_output -> role:tool。
 assert.deepEqual(upstream.requests[0].body.messages, [
  { role: 'user', content: '列目录' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_dir', arguments: '{"path":"."}' } }] },
  { role: 'tool', tool_call_id: 'call_1', content: 'a.txt\nb.txt' },
 ]);
 assert.deepEqual(upstream.requests[0].body.tools, [{ type: 'function', function: { name: 'list_dir', description: '', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }]);
});

test('compat proxy relays upstream failures as HTTP errors instead of faking success', { timeout: 30000 }, async t => {
 const limited = await fakeUpstream(({ response }) => {
  response.writeHead(429, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'quota exceeded for this month', type: 'insufficient_quota' } }));
 });
 t.after(() => limited.close());
 const silent = await fakeUpstream(({ response }) => {
  // 永远是 200 + SSE 头，但一个字节的数据都不发：必须命中「无数据超时」。
  response.writeHead(200, { 'content-type': 'text/event-stream' });
 });
 t.after(() => silent.close());
 const closed = createServer(() => {});
 await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
 const closedPort = closed.address().port;
 await new Promise(resolve => { closed.closeAllConnections?.(); closed.close(() => resolve()); });

 const proxy = await startCompatProxy(0, '127.0.0.1', {
  noDataTimeoutMs: 400,
  lookupChannel: id => ({
   'relay-429': { id, baseUrl: `${limited.url}/v1`, wire: 'chat', apiKey: 'sk-429' },
   'relay-down': { id, baseUrl: `http://127.0.0.1:${closedPort}/v1`, wire: 'chat', apiKey: 'sk-down' },
   'relay-silent': { id, baseUrl: `${silent.url}/v1`, wire: 'chat' },
   official: { id, baseUrl: 'https://api.openai.com/v1', wire: 'responses' },
  }[id] ?? null),
 });
 t.after(() => proxy.close());
 const call = (id, body = { model: 'm', stream: true, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }) =>
  fetch(`http://127.0.0.1:${proxy.port}/v1/${id}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

 const refused = await call('ghost');
 assert.equal(refused.status, 404);
 assert.equal((await refused.json()).error.code, 'channel/unknown');

 const wrongWire = await call('official');
 assert.equal(wrongWire.status, 400);
 assert.equal((await wrongWire.json()).error.code, 'channel/wire');

 const quota = await call('relay-429');
 assert.equal(quota.status, 429, 'upstream HTTP status is passed through');
 const quotaBody = await quota.json();
 assert.equal(quotaBody.error.type, 'upstream_error');
 assert.equal(quotaBody.error.code, 429);
 assert.match(quotaBody.error.message, /quota exceeded/);
 assert(quotaBody.error.message.length <= 301);

 const down = await call('relay-down');
 assert.equal(down.status, 502);
 const downBody = await down.json();
 assert.equal(downBody.error.code, 'connect_failed');
 assert.equal(downBody.error.type, 'upstream_unreachable');

 const timeout = await call('relay-silent');
 assert.equal(timeout.status, 504, 'a silent upstream must surface as a gateway timeout');
 const timeoutBody = await timeout.json();
 assert.equal(timeoutBody.error.type, 'upstream_timeout');
 assert.equal(timeoutBody.error.code, 'timeout');

 const method = await fetch(`http://127.0.0.1:${proxy.port}/v1/relay-429/responses`);
 assert.equal(method.status, 405);
 const malformed = await fetch(`http://127.0.0.1:${proxy.port}/v1/relay-429/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
 assert.equal(malformed.status, 400);
 assert.equal((await malformed.json()).error.code, 'request/json');
});

// ---- CONTRACT-V4 B：其余 wire 的适配器（每个 wire 一个本地假上游）----
const WIRE_BODY = {
 model: 'wire-model',
 stream: true,
 instructions: 'Be terse.',
 input: [
  { type: 'message', role: 'user', content: [{ type: 'input_text', text: '列目录' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] },
  { type: 'function_call', call_id: 'call_1', name: 'list_dir', arguments: '{"path":"."}' },
  { type: 'function_call_output', call_id: 'call_1', output: 'a.txt' },
 ],
 tools: [{ type: 'function', name: 'list_dir', description: 'List a directory', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
 tool_choice: 'auto',
 max_output_tokens: 64,
};

function proxyFor(upstream, wire, extra = {}) {
 return startCompatProxy(0, '127.0.0.1', {
  lookupChannel: id => (id === 'wire' ? { id, baseUrl: `${upstream.url}${extra.basePath ?? ''}`, wire, model: 'fallback-model', apiKey: extra.apiKey ?? 'sk-wire', ...extra.channel } : null),
 });
}

test('anthropic wire maps messages, thinking and tool_use deltas onto Responses events', { timeout: 30000 }, async t => {
 const upstream = await fakeUpstream(({ response }) => {
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', { type: 'message_start', message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: 11, output_tokens: 0 } } });
  send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先想' } });
  send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '一步。' } });
  send('content_block_stop', { type: 'content_block_stop', index: 0 });
  send('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  send('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } });
  send('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '，世界' } });
  send('content_block_stop', { type: 'content_block_stop', index: 1 });
  send('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'list_dir', input: {} } });
  send('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path"' } });
  send('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: ':"."}' } });
  send('content_block_stop', { type: 'content_block_stop', index: 2 });
  send('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } });
  send('message_stop', { type: 'message_stop' });
  response.end();
 });
 t.after(() => upstream.close());
 const proxy = await proxyFor(upstream, 'anthropic', { basePath: '/v1', apiKey: 'sk-anthropic' });
 t.after(() => proxy.close());

 const events = await readResponsesSse(await fetch(`http://127.0.0.1:${proxy.port}/v1/wire/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(WIRE_BODY),
 }));
 assert.deepEqual(events.map(item => item.event), [
  'response.created',
  'response.output_item.added', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.delta', 'response.output_item.done',
  'response.output_item.added', 'response.output_text.delta', 'response.output_text.delta', 'response.output_item.done',
  'response.output_item.added', 'response.function_call_arguments.delta', 'response.function_call_arguments.delta', 'response.output_item.done',
  'response.completed',
 ]);
 const done = events.filter(item => item.event === 'response.output_item.done').map(item => item.data.item);
 assert.deepEqual(done.map(item => item.type), ['reasoning', 'message', 'function_call']);
 assert.equal(done[0].summary[0].text, '先想一步。');
 assert.equal(done[1].content[0].text, '你好，世界');
 assert.deepEqual({ call_id: done[2].call_id, name: done[2].name, arguments: done[2].arguments }, { call_id: 'toolu_1', name: 'list_dir', arguments: '{"path":"."}' });
 assert.deepEqual(events.at(-1).data.response.usage, {
  input_tokens: 11, input_tokens_details: { cached_tokens: 0 },
  output_tokens: 7, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 18,
 });

 const sent = upstream.requests[0];
 assert.equal(sent.path, '/v1/messages');
 assert.equal(sent.headers['x-api-key'], 'sk-anthropic');
 assert.equal(sent.headers['anthropic-version'], '2023-06-01');
 assert.equal(sent.headers.authorization, undefined, 'anthropic must not receive a Bearer header');
 assert.equal(sent.body.model, 'wire-model');
 assert.equal(sent.body.max_tokens, 64);
 assert.equal(sent.body.stream, true);
 assert.equal(sent.body.system, 'Be terse.');
 assert.deepEqual(sent.body.messages, [
  { role: 'user', content: [{ type: 'text', text: '列目录' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'list_dir', input: { path: '.' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.txt' }] },
 ]);
 assert.deepEqual(sent.body.tools, [{ name: 'list_dir', description: 'List a directory', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }]);
 assert.deepEqual(sent.body.tool_choice, { type: 'auto' });

 // 不传 max_output_tokens 时 anthropic 的 max_tokens 兜底 4096（它要求必填）。
 await fetch(`http://127.0.0.1:${proxy.port}/v1/wire/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'wire-model', stream: false, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }),
 });
 assert.equal(upstream.requests[1].body.max_tokens, 4096);
});

test('gemini wire uses :streamGenerateContent?alt=sse and synthesizes generateContent output', { timeout: 30000 }, async t => {
 const upstream = await fakeUpstream(({ request, response }) => {
  const replyJson = () => {
   response.writeHead(200, { 'content-type': 'application/json' });
   response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: '完成。' }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } }));
  };
  // gemini-json 模拟「忽略 alt=sse 的网关」，gemini-x 走真实 SSE；非流式路径一律回 JSON。
  if (request.url.includes('gemini-json') || !request.url.includes('alt=sse')) return replyJson();
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const chunk of [
   { candidates: [{ content: { parts: [{ text: '先看看目录。', thought: true }] } }] },
   { candidates: [{ content: { parts: [{ text: '目录里有' }] } }] },
   { candidates: [{ content: { parts: [{ text: ' a.txt。' }] } }] },
   { candidates: [{ content: { parts: [{ functionCall: { name: 'list_dir', args: { path: '.' } } }] } }] },
   { usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 12, totalTokenCount: 21, thoughtsTokenCount: 3 } },
  ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end();
 });
 t.after(() => upstream.close());
 const proxy = await proxyFor(upstream, 'gemini', { basePath: '/v1beta', apiKey: 'sk-gemini' });
 t.after(() => proxy.close());
 const body = { ...WIRE_BODY, model: 'gemini-2.5-pro', temperature: 0.2 };

 const events = await readResponsesSse(await fetch(`http://127.0.0.1:${proxy.port}/v1/wire/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
 }));
 assert.deepEqual(events.map(item => item.event), [
  'response.created',
  'response.output_item.added', 'response.reasoning_summary_text.delta',
  'response.output_item.added', 'response.output_text.delta', 'response.output_text.delta',
  'response.output_item.added', 'response.function_call_arguments.delta',
  'response.output_item.done', 'response.output_item.done', 'response.output_item.done',
  'response.completed',
 ]);
 assert.deepEqual(events.filter(item => item.event === 'response.output_text.delta').map(item => item.data.delta), ['目录里有', ' a.txt。']);
 assert.deepEqual(events.filter(item => item.event === 'response.function_call_arguments.delta').map(item => item.data.delta), ['{"path":"."}']);
 const done = events.filter(item => item.event === 'response.output_item.done').map(item => item.data.item);
 assert.equal(done[0].summary[0].text, '先看看目录。');
 assert.equal(done[1].content[0].text, '目录里有 a.txt。');
 assert.equal(done[2].name, 'list_dir');
 assert.deepEqual(events.at(-1).data.response.usage, {
  input_tokens: 9, input_tokens_details: { cached_tokens: 0 },
  output_tokens: 12, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 21,
 });

 const sent = upstream.requests[0];
 assert.equal(sent.path, '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse', 'base /v1beta must not be duplicated');
 assert.equal(sent.headers['x-goog-api-key'], 'sk-gemini');
 assert.equal(sent.headers.authorization, undefined);
 assert.deepEqual(sent.body, {
  contents: [
   { role: 'user', parts: [{ text: '列目录' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] },
   { role: 'model', parts: [{ functionCall: { name: 'list_dir', args: { path: '.' } } }] },
   { role: 'user', parts: [{ functionResponse: { name: 'list_dir', response: { result: 'a.txt' } } }] },
  ],
  systemInstruction: { parts: [{ text: 'Be terse.' }] },
  tools: [{ functionDeclarations: [{ name: 'list_dir', description: 'List a directory', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }] }],
  toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
  generationConfig: { maxOutputTokens: 64, temperature: 0.2 },
 });

 // 上游忽略 alt=sse 直接回 JSON 时，仍要合成完整事件序列（客户端仍要 SSE）。
 const synthesized = await readResponsesSse(await fetch(`http://127.0.0.1:${proxy.port}/v1/wire/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, model: 'gemini-json' }),
 }));
 assert.equal(upstream.requests[1].path, '/v1beta/models/gemini-json:streamGenerateContent?alt=sse');
 assert.deepEqual(synthesized.map(item => item.event), [
  'response.created', 'response.output_item.added', 'response.output_text.delta', 'response.output_item.done', 'response.completed',
 ]);
 assert.deepEqual(synthesized.filter(item => item.event === 'response.output_text.delta').map(item => item.data.delta), ['完成。']);
 assert.equal(synthesized.at(-1).data.response.usage.total_tokens, 7);

 // 非流式客户端：改打 :generateContent，直接回完整 response 对象。
 const plain = await fetch(`http://127.0.0.1:${proxy.port}/v1/wire/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, stream: false }),
 });
 assert.equal(plain.status, 200);
 assert.match(plain.headers.get('content-type'), /application\/json/);
 assert.equal(upstream.requests[2].path, '/v1beta/models/gemini-2.5-pro:generateContent', 'non-streaming clients use :generateContent');
 assert.equal(upstream.requests[2].body.generationConfig.maxOutputTokens, 64);
 const plainBody = await plain.json();
 assert.equal(plainBody.object, 'response');
 assert.equal(plainBody.output[0].content[0].text, '完成。');
 assert.equal(plainBody.usage.total_tokens, 7);
});

test('ollama wire speaks NDJSON with options.num_predict and no auth', { timeout: 30000 }, async t => {
 const upstream = await fakeUpstream(({ response }) => {
  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  for (const chunk of [
   { message: { role: 'assistant', thinking: '先想' }, done: false },
   { message: { role: 'assistant', thinking: '一步。' }, done: false },
   { message: { role: 'assistant', content: '你好' }, done: false },
   { message: { role: 'assistant', content: '，世界' }, done: false },
   { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_dir', arguments: { path: '.' } } }] }, done: false },
   { done: true, prompt_eval_count: 5, eval_count: 6 },
  ]) response.write(`${JSON.stringify(chunk)}\n`);
  response.end();
 });
 t.after(() => upstream.close());
 const proxy = await proxyFor(upstream, 'ollama', { apiKey: null, channel: {} });
 t.after(() => proxy.close());
 const body = { ...WIRE_BODY, model: 'llama3.2', max_output_tokens: 8 };

 const events = await readResponsesSse(await fetch(`http://127.0.0.1:${proxy.port}/v1/wire/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
 }));
 assert.deepEqual(events.map(item => item.event), [
  'response.created',
  'response.output_item.added', 'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.delta',
  'response.output_item.added', 'response.output_text.delta', 'response.output_text.delta',
  'response.output_item.added', 'response.function_call_arguments.delta',
  'response.output_item.done', 'response.output_item.done', 'response.output_item.done',
  'response.completed',
 ]);
 const done = events.filter(item => item.event === 'response.output_item.done').map(item => item.data.item);
 assert.equal(done[0].summary[0].text, '先想一步。');
 assert.equal(done[1].content[0].text, '你好，世界');
 assert.deepEqual({ name: done[2].name, arguments: done[2].arguments }, { name: 'list_dir', arguments: '{"path":"."}' });
 assert.deepEqual(events.at(-1).data.response.usage, {
  input_tokens: 5, input_tokens_details: { cached_tokens: 0 },
  output_tokens: 6, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 11,
 });

 const sent = upstream.requests[0];
 assert.equal(sent.path, '/api/chat', 'ollama base has no version segment to duplicate');
 assert.equal(sent.headers.authorization, undefined);
 assert.equal(sent.headers['x-api-key'], undefined);
 assert.equal(sent.body.model, 'llama3.2');
 assert.equal(sent.body.stream, true);
 assert.deepEqual(sent.body.options, { num_predict: 8 });
 assert.equal(sent.body.max_tokens, undefined, 'ollama takes options.num_predict, not max_tokens');
 assert.deepEqual(sent.body.messages[0], { role: 'system', content: 'Be terse.' });
});

test('azure-openai wire rewrites the deployment path without duplicating /openai', { timeout: 30000 }, async t => {
 const upstream = await fakeUpstream(({ response }) => {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`);
  response.end('data: [DONE]\n\n');
 });
 t.after(() => upstream.close());
 const proxy = await proxyFor(upstream, 'azure-openai', { basePath: '/openai', apiKey: 'sk-azure' });
 t.after(() => proxy.close());

 const events = await readResponsesSse(await fetch(`http://127.0.0.1:${proxy.port}/v1/wire/responses`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'gpt-4o', stream: true, max_output_tokens: 32, input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] }),
 }));
 assert.deepEqual(events.map(item => item.event), ['response.created', 'response.output_item.added', 'response.output_text.delta', 'response.output_item.done', 'response.completed']);
 const sent = upstream.requests[0];
 assert.equal(sent.path, '/openai/deployments/gpt-4o/chat/completions?api-version=2024-10-21', 'the /openai segment must appear exactly once');
 assert.equal(sent.headers['api-key'], 'sk-azure');
 assert.equal(sent.headers.authorization, undefined);
 assert.equal(sent.body.model, 'gpt-4o');
 assert.equal(sent.body.max_tokens, 32);
 assert.deepEqual(sent.body.messages, [{ role: 'user', content: 'hi' }]);
});

test('every proxied wire relays an upstream 429 as a real HTTP error', { timeout: 30000 }, async t => {
 for (const wire of ['anthropic', 'gemini', 'azure-openai', 'ollama']) {
  const upstream = await fakeUpstream(({ response }) => {
   response.writeHead(429, { 'content-type': 'application/json' });
   response.end(JSON.stringify({ error: { message: 'quota exceeded for this month', type: 'insufficient_quota' } }));
  });
  const proxy = await proxyFor(upstream, wire, { basePath: '/v1' });
  try {
   const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/wire/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(WIRE_BODY),
   });
   assert.equal(response.status, 429, `${wire} must pass the upstream status through`);
   const payload = await response.json();
   assert.equal(payload.error.type, 'upstream_error', wire);
   assert.equal(payload.error.code, 429, wire);
   assert.match(payload.error.message, /quota exceeded/, wire);
  } finally {
   await proxy.close();
   await upstream.close();
  }
 }
 // 未知 wire 与 openai-responses 直连都必须被拒绝，代理不猜。
 const bogus = await startCompatProxy(0, '127.0.0.1', {
  lookupChannel: id => ({ id, baseUrl: 'http://127.0.0.1:1/v1', wire: id === 'direct' ? 'responses' : 'grpc' }),
 });
 try {
  for (const id of ['direct', 'mystery']) {
   const response = await fetch(`http://127.0.0.1:${bogus.port}/v1/${id}/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'm', input: 'hi' }),
   });
   assert.equal(response.status, 400, id);
   assert.equal((await response.json()).error.code, 'channel/wire', id);
  }
 } finally {
  await bogus.close();
 }
});

test('channels API persists a registry, hides keys and rewrites codex config on activation', { timeout: 60000 }, async t => {
 const home = await mkdtemp(join(tmpdir(), 'codex-channels-'));
 const tracePath = join(home, 'synthetic-trace.jsonl');
 const outputPath = join(home, 'stdout.log'), errorPath = join(home, 'stderr.log');
 const out = await open(outputPath, 'w'), err = await open(errorPath, 'w');
 const child = spawn(process.execPath, [
  resolve(here, '../bridge/server.mjs'),
  '--codex', process.execPath, '--codex-arg', join(here, 'protocol-fixture.mjs'),
  '--codex-home', home, '--cwd', home,
  '--toolpacks', join(home, 'no-builtin-packs'), '--plugins', join(home, 'no-builtin-plugins'),
  '--host', '127.0.0.1', '--port', '0', '--token', token,
 ], { env: { ...process.env, CODEX_FIXTURE_TRACE: tracePath }, stdio: ['ignore', out.fd, err.fd], windowsHide: true });
 const exited = once(child, 'close');
 let compatPort = null;
 try {
  const base = await until(async () => {
   const output = await readFile(outputPath, 'utf8');
   const match = output.match(/codex-go: (http:\/\/127\.0\.0\.1:\d+)\//);
   if (child.exitCode !== null) throw Error(`Bridge exited ${child.exitCode}: ${await readFile(errorPath, 'utf8')}`);
   return match?.[1];
  }, 'bridge startup', 8000);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const api = async (route, body) => {
   const response = await fetch(`${base}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
   return { status: response.status, body: await response.json() };
  };
  const health = async () => (await (await fetch(`${base}/healthz`)).json());
  const trace = async () => {
   if (!(await exists(tracePath))) return [];
   return (await readFile(tracePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  };
  const channelFile = join(home, 'codex-go-channels.json');
  const secretsFile = join(home, 'codex-go-secrets.json');
  const seen = [];
  const remember = value => { seen.push(JSON.stringify(value)); return value; };

  await t.test('empty registry, POST-only surface and compat port exposure', async () => {
   const empty = remember((await api('channels', {})).body);
   assert.deepEqual(empty, { active: null, channels: [] });
   assert.equal(await exists(channelFile), false, 'listing must not create the registry file');
   assert.equal((await fetch(`${base}/api/channels`, { headers })).status, 405, 'channels is POST-only');
   const status = await health();
   assert.ok(Number.isInteger(status.compatPort) && status.compatPort > 0, 'healthz must expose the compatibility proxy port');
   assert.equal(status.activeTurns, 0);
   compatPort = status.compatPort;
   // 代理确实挂在 bridge 的渠道注册表上：未知渠道 404。
   const unknown = await fetch(`http://127.0.0.1:${compatPort}/v1/ghost/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
   assert.equal(unknown.status, 404);
   assert.equal((await unknown.json()).error.code, 'channel/unknown');
  });

  await t.test('save rejects unknown fields and malformed values', async () => {
   const valid = { name: 'Relay', baseUrl: 'https://relay.example/v1', wire: 'chat' };
   const cases = [
    [{ ...valid, surprise: true }, 400, 'request/invalid'],
    [{ ...valid, name: '' }, 400, 'channel/name'],
    [{ ...valid, wire: 'grpc' }, 400, 'channel/wire'],
    [{ ...valid, baseUrl: 'https://user:pass@relay.example/v1' }, 400, 'channel/base-url'],
    [{ ...valid, baseUrl: 'not a url' }, 400, 'channel/base-url'],
    [{ ...valid, id: 'Bad.Id' }, 400, 'channel/id'],
    [{ ...valid, models: 'model-a' }, 400, 'channel/models'],
    [{ ...valid, apiKey: '   ' }, 400, 'channel/api-key'],
   ];
   for (const [body, status, code] of cases) {
    const result = await api('channels/save', body);
    assert.equal(result.status, status, JSON.stringify(body));
    assert.equal(result.body.error.code, code, JSON.stringify(body));
   }
   assert.equal(await exists(channelFile), false, 'rejected saves must not touch the registry');
  });

  await t.test('two channels persist, keys stay in the secrets file and lists hide them', async () => {
   const chat = remember((await api('channels/save', {
    id: 'relay-a', name: '中转 A', baseUrl: 'https://relay-a.example/v1', wire: 'chat', model: 'deepseek-v4.1-flash', apiKey: 'sk-relay-secret',
   })).body);
   assert.deepEqual(chat, {
    id: 'relay-a', name: '中转 A', baseUrl: 'https://relay-a.example/v1', wire: 'openai-chat',
    model: 'deepseek-v4.1-flash', models: [], apiKeyConfigured: true, active: false,
   });
   const official = remember((await api('channels/save', {
    name: 'Official Responses', baseUrl: 'https://api.openai.com/v1', wire: 'responses', model: 'gpt-6.2-sol', apiKey: 'sk-official-secret',
   })).body);
   assert.equal(official.id, 'official-responses', 'missing id is slugged from the name');
   assert.equal(official.active, false);
   const list = remember((await api('channels', {})).body);
   assert.equal(list.active, null);
   assert.deepEqual(list.channels.map(channel => channel.id), ['relay-a', 'official-responses']);
   assert.deepEqual(list.channels.map(channel => channel.wire), ['openai-chat', 'openai-responses']);
   assert.deepEqual(JSON.parse(await readFile(channelFile, 'utf8')).channels.map(channel => channel.wire), ['openai-chat', 'openai-responses'], 'legacy wire values are persisted in canonical form');
   assert.deepEqual(list.channels.map(channel => channel.apiKeyConfigured), [true, true]);
   const stored = JSON.parse(await readFile(channelFile, 'utf8'));
   assert.equal(stored.active, null);
   assert.deepEqual(stored.channels.map(channel => channel.envKey), ['CODEX_GO_CHANNEL_RELAY_A_KEY', 'CODEX_GO_CHANNEL_OFFICIAL_RESPONSES_KEY']);
   assert.deepEqual(stored.channels[0].models, []);
   const secrets = JSON.parse(await readFile(secretsFile, 'utf8'));
   assert.equal(secrets.CODEX_GO_CHANNEL_RELAY_A_KEY, 'sk-relay-secret');
   assert.equal(secrets.CODEX_GO_CHANNEL_OFFICIAL_RESPONSES_KEY, 'sk-official-secret');
   assert(!JSON.stringify(list).includes('sk-relay-secret'));
   assert(!JSON.stringify(list).includes('sk-official-secret'));
  });

  await t.test('models endpoint uses the stored channel key and can be driven directly', async () => {
   const upstream = await fakeUpstream(({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'relay-model-1', owned_by: 'relay' }, { id: 'relay-model-2' }, { id: 'relay-model-1' }] }));
   });
   t.after(() => upstream.close());
   const saved = remember((await api('channels/save', {
    id: 'local-relay', name: 'Local Relay', baseUrl: `${upstream.url}/v1`, wire: 'chat', apiKey: 'sk-models-secret',
   })).body);
   assert.equal(saved.apiKeyConfigured, true);
   const models = remember((await api('channels/models', { id: 'local-relay' })).body);
   assert.deepEqual(models.models, [{ id: 'relay-model-1' }, { id: 'relay-model-2' }]);
   assert.equal(models.count, 2);
   assert.equal(upstream.requests[0].method, 'GET');
   assert.equal(upstream.requests[0].path, '/v1/models');
   assert.equal(upstream.requests[0].authorization, 'Bearer sk-models-secret', 'the stored channel key must be used');
   const inline = remember((await api('channels/models', { baseUrl: `${upstream.url}/v1`, wire: 'chat', apiKey: 'sk-inline' })).body);
   assert.deepEqual(inline.models, [{ id: 'relay-model-1' }, { id: 'relay-model-2' }]);
   assert.equal(upstream.requests[1].authorization, 'Bearer sk-inline');
   for (const candidate of [upstream.url, `${upstream.url}/v`]) {
    const normalized = await api('channels/models', { baseUrl: candidate, wire: 'openai-chat', apiKey: 'sk-inline' });
    assert.equal(normalized.status, 200, JSON.stringify(normalized.body));
    assert.equal(normalized.body.baseUrl, `${upstream.url}/v1`);
    assert.equal(upstream.requests.at(-1).path, '/v1/models');
   }
   const anthropic = await api('channels/models', { baseUrl: upstream.url, wire: 'anthropic', apiKey: 'sk-inline' });
   assert.equal(anthropic.status, 200, JSON.stringify(anthropic.body));
   assert.equal(anthropic.body.baseUrl, upstream.url, 'non-OpenAI wires must not get an implicit /v1');
   assert.equal(upstream.requests.at(-1).path, '/models');
   const junkUpstream = await fakeUpstream(({ response }) => {
    response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html>');
   });
   t.after(() => junkUpstream.close());
   const junk = await api('channels/models', { baseUrl: `${junkUpstream.url}/v`, wire: 'openai-chat', apiKey: 'sk-inline' });
   assert.equal(junk.status, 502);
   assert.equal(junk.body.error.code, 'provider/models-invalid');
   assert.match(junk.body.error.hint, /少了 \/v1/);
   assert.match(junk.body.error.hint, /手动输入模型 ID/);
   assert.equal(junk.body.error.normalizedBaseUrl, `${junkUpstream.url}/v1`);
   assert.equal((await api('channels/models', { id: 'ghost' })).status, 404);
   assert.equal((await api('channels/models', {})).status, 400);
  });

  await t.test('activating a chat channel writes the loopback proxy base URL', async () => {
   const activated = remember((await api('channels/activate', { id: 'relay-a' })).body);
   assert.equal(activated.active, 'relay-a');
   assert.equal(activated.channels.find(channel => channel.id === 'relay-a').active, true);
   assert.equal(activated.channels.find(channel => channel.id === 'official-responses').active, false);
   const status = await health();
   const edits = (await trace()).filter(item => item.method === 'config/batchWrite').at(-1).params.edits;
   const provider = edits.find(edit => edit.keyPath === 'model_providers.relay-a');
   assert.equal(provider.value.wire_api, 'responses');
   assert.equal(provider.value.base_url, `http://127.0.0.1:${status.compatPort}/v1/relay-a`);
   assert.equal(provider.value.env_key, 'CODEX_GO_CHANNEL_RELAY_A_KEY');
   assert.equal(provider.value.name, '中转 A');
   assert.equal(edits.find(edit => edit.keyPath === 'model_provider').value, 'relay-a');
   assert.equal(edits.find(edit => edit.keyPath === 'model').value, 'deepseek-v4.1-flash');
   assert.equal(JSON.parse(await readFile(channelFile, 'utf8')).active, 'relay-a');
   assert(!JSON.stringify(edits).includes('sk-relay-secret'), 'config writes must never carry the key literal');
  });

  await t.test('a chat channel is reachable through the bridge proxy with its stored key', async () => {
   const upstream = await fakeUpstream(({ response }) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of [
     { choices: [{ index: 0, delta: { reasoning_content: '先看目录。' } }] },
     { choices: [{ index: 0, delta: { content: '目录里有 a.txt。' } }] },
     { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
     { choices: [], usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } },
    ]) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end('data: [DONE]\n\n');
   });
   t.after(() => upstream.close());
   const saved = remember((await api('channels/save', {
    id: 'bridge-chat', name: 'Bridge Chat', baseUrl: `${upstream.url}/v1`, wire: 'chat', model: 'bridge-model', apiKey: 'sk-bridge-chat',
   })).body);
   assert.equal(saved.apiKeyConfigured, true);
   assert.equal((await api('channels/activate', { id: 'bridge-chat' })).body.active, 'bridge-chat');
   const status = await health();
   const response = await fetch(`http://127.0.0.1:${status.compatPort}/v1/bridge-chat/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
     model: 'bridge-model', stream: true, instructions: 'hi',
     input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '列目录' }] }],
    }),
   });
   const events = await readResponsesSse(response);
   assert.deepEqual(events.map(item => item.event), [
    'response.created', 'response.output_item.added', 'response.reasoning_summary_text.delta',
    'response.output_item.added', 'response.output_text.delta',
    'response.output_item.done', 'response.output_item.done', 'response.completed',
   ]);
   assert.equal(events.at(-1).data.response.usage.total_tokens, 10);
   assert.equal(upstream.requests[0].authorization, 'Bearer sk-bridge-chat', 'the proxy must use the key stored for that channel');
   assert.equal(upstream.requests[0].body.model, 'bridge-model');
   // 删掉这个活动渠道后回到第一个渠道，后续断言不受影响。
   assert.equal((await api('channels/remove', { id: 'bridge-chat' })).body.active, 'relay-a');
  });

  await t.test('activating a responses channel keeps its own base URL', async () => {
   const activated = remember((await api('channels/activate', { id: 'official-responses' })).body);
   assert.equal(activated.active, 'official-responses');
   const edits = (await trace()).filter(item => item.method === 'config/batchWrite').at(-1).params.edits;
   const provider = edits.find(edit => edit.keyPath === 'model_providers.official-responses');
   assert.deepEqual(provider.value, {
    name: 'Official Responses', base_url: 'https://api.openai.com/v1', wire_api: 'responses', env_key: 'CODEX_GO_CHANNEL_OFFICIAL_RESPONSES_KEY',
   });
   assert.equal(edits.find(edit => edit.keyPath === 'model_provider').value, 'official-responses');
   assert.equal(edits.find(edit => edit.keyPath === 'model').value, 'gpt-6.2-sol');
  });

  await t.test('activation interrupts the running turn instead of leaving it retrying the old channel', async () => {
   const thread = await api('thread/create', { cwd: home });
   assert.equal(thread.status, 200, JSON.stringify(thread.body));
   const threadId = thread.body.threadId;
   const turn = await api('turn/send', { threadId, text: 'hold this turn open' });
   assert.equal(turn.status, 200, JSON.stringify(turn.body));
   await until(async () => (await health()).activeTurns === 1, 'turn becomes active');
   // interruptAll:false 保留旧的拒绝语义（老客户端还在用）。
   const blocked = await api('channels/activate', { id: 'relay-a', interruptAll: false });
   assert.equal(blocked.status, 409);
   assert.equal(blocked.body.error.code, 'codex/busy');
   assert.deepEqual(blocked.body.error.details.activeTurns, [threadId]);
   assert.match(blocked.body.error.details.hint, /Interrupt/);
   assert.equal((await api('channels', {})).body.active, 'official-responses', 'a blocked activation must not switch channels');
   // 默认：先停掉旧渠道上的回合，再切渠道，别让它继续打旧上游。
   const switched = await api('channels/activate', { id: 'relay-a' });
   assert.equal(switched.status, 200, JSON.stringify(switched.body));
   assert.equal(switched.body.active, 'relay-a');
   assert.deepEqual(switched.body.interrupted.map(item => item.threadId), [threadId]);
   await until(async () => (await health()).activeTurns === 0, 'the interrupted turn is released');
  });

  await t.test('a thread stays bound to its channel: turn/send refuses the mismatch and thread/fork moves it', async () => {
   const created = await api('thread/create', { cwd: home });
   assert.equal(created.status, 200, JSON.stringify(created.body));
   const threadId = created.body.threadId;
   assert.equal((await api('channels/activate', { id: 'official-responses' })).body.active, 'official-responses');
   // codex 0.170 里老 thread 只认建线程时的 provider：拿新渠道的模型名打旧渠道 =
   // 上游 404「模型不存在」→ 重试 5 次 → 界面一直 Reconnecting。所以桥必须直接拒绝。
   const refused = await api('turn/send', { threadId, text: 'wrong channel' });
   assert.equal(refused.status, 409, JSON.stringify(refused.body));
   assert.equal(refused.body.error.code, 'channel/thread-binding');
   assert.equal(refused.body.error.details.boundChannel, 'relay-a');
   assert.equal(refused.body.error.details.activeChannel, 'official-responses');
   assert.match(refused.body.error.details.hint, /thread\/fork/);
   const startsBefore = (await trace()).filter(item => item.method === 'turn/start' && item.params.threadId === threadId).length;
   assert.equal(startsBefore, 0, 'a refused send must not reach the old channel');
   // fork 是唯一能把老会话搬到新渠道的办法，默认搬到现在活动的渠道。
   const forked = await api('thread/fork', { threadId });
   assert.equal(forked.status, 200, JSON.stringify(forked.body));
   assert.notEqual(forked.body.threadId, threadId);
   assert.equal(forked.body.modelProvider, 'official-responses');
   const forkParams = (await trace()).filter(item => item.method === 'thread/fork').at(-1).params;
   assert.equal(forkParams.modelProvider, 'official-responses');
   assert.equal(forkParams.model, 'gpt-6.2-sol');
   const sent = await api('turn/send', { threadId: forked.body.threadId, text: 'forked turn' });
   assert.equal(sent.status, 200, JSON.stringify(sent.body));
   const turnStart = (await trace()).filter(item => item.method === 'turn/start').at(-1);
   assert.equal(turnStart.params.threadId, forked.body.threadId);
   assert.equal(turnStart.params.model, 'gpt-6.2-sol');
   await until(async () => (await health()).activeTurns === 0, 'forked turn completes');
   assert.equal((await api('channels/activate', { id: 'relay-a' })).body.active, 'relay-a');
  });

  await t.test('fs/list forwards to codex instead of answering with an empty object', async () => {
   const listed = await api('fs/list', { path: home });
   assert.equal(listed.status, 200, JSON.stringify(listed.body));
   assert.equal(listed.body.entries?.[0]?.fileName, 'fixture-entry.txt');
   assert.ok((await trace()).some(item => item.method === 'fs/readDirectory'), 'the bridge must ask codex for the directory');
  });

  await t.test('thread/rebind stops the running turn, forks onto the active channel and archives the source', async () => {
   // 用户场景：同一个会话里，第一句用 A 渠道，第二句换成 B 渠道。
   // 分两步做（activate → fork）时回合没停干净 fork 会失败，界面表现就是「换了渠道连不上」。
   assert.equal((await api('channels/activate', { id: 'relay-a' })).body.active, 'relay-a');
   const source = (await api('thread/create', { cwd: home })).body.threadId;
   assert.equal((await api('turn/send', { threadId: source, text: 'hold this one' })).status, 200);
   await until(async () => (await health()).activeTurns === 1, 'the source turn is running');
   assert.equal((await api('channels/activate', { id: 'official-responses' })).body.active, 'official-responses');
   const started = await api('thread/rebind', { threadId: source });
   assert.equal(started.status, 200, JSON.stringify(started.body));
   assert.equal(started.body.forked, true);
   assert.notEqual(started.body.threadId, source);
   assert.equal(started.body.channel, 'official-responses');
   const forked = (await trace()).filter(item => item.method === 'thread/fork').at(-1).params;
   assert.equal(forked.threadId, source);
   assert.equal(forked.modelProvider, 'official-responses');
   assert.ok((await trace()).some(item => item.method === 'thread/archive' && item.params.threadId === source), 'the source thread is archived so the drawer does not show a duplicate conversation');
   const resumed = await api('thread/resume', { threadId: started.body.threadId });
   assert.equal(resumed.body.channel, 'official-responses');
   // 已经在这个渠道上时不重复 fork。
   const again = await api('thread/rebind', { threadId: started.body.threadId });
   assert.equal(again.status, 200, JSON.stringify(again.body));
   assert.equal(again.body.forked, false);
   assert.equal(again.body.threadId, started.body.threadId);
   assert.equal((await api('thread/rebind', { threadId: 42 })).status, 400);
   assert.equal((await api('thread/rebind', { threadId: source, nope: 1 })).status, 400);
  });

  await t.test('thread/fork can branch from a specific turn', async () => {
   assert.equal((await api('channels/activate', { id: 'relay-a' })).body.active, 'relay-a');
   const source = (await api('thread/create', { cwd: home })).body.threadId;
   const forked = await api('thread/fork', { threadId: source, lastTurnId: 'turn-42' });
   assert.equal(forked.status, 200, JSON.stringify(forked.body));
   const params = (await trace()).filter(item => item.method === 'thread/fork').at(-1).params;
   assert.equal(params.lastTurnId, 'turn-42', 'branching from one message must pass lastTurnId');
   assert.equal(params.modelProvider, 'relay-a');
  });

  await t.test('removing the active channel switches to the first remaining one, then to none', async () => {
   assert.equal((await api('channels/activate', { id: 'relay-a' })).body.active, 'relay-a');
   const removed = remember((await api('channels/remove', { id: 'relay-a' })).body);
   assert.deepEqual(removed, { removed: true, id: 'relay-a', active: 'official-responses' });
   const edits = (await trace()).filter(item => item.method === 'config/batchWrite').at(-1).params.edits;
   assert.equal(edits.find(edit => edit.keyPath === 'model_providers.official-responses').value.base_url, 'https://api.openai.com/v1');
   assert.equal(edits.find(edit => edit.keyPath === 'model_provider').value, 'official-responses');
   const list = remember((await api('channels', {})).body);
   assert.deepEqual(list.channels.map(channel => channel.id), ['official-responses', 'local-relay']);
   assert.equal(list.active, 'official-responses');
   assert.equal((await api('channels/remove', { id: 'relay-a' })).status, 404);
   assert.equal((await api('channels/remove', { id: 'relay-a' })).body.error.code, 'channel/unknown');
   assert.equal((await api('channels/activate', { id: 'ghost' })).status, 404);
   assert.deepEqual(remember((await api('channels/remove', { id: 'local-relay' })).body), { removed: true, id: 'local-relay', active: 'official-responses' });
   assert.deepEqual(remember((await api('channels/remove', { id: 'official-responses' })).body), { removed: true, id: 'official-responses', active: null });
   const empty = remember((await api('channels', {})).body);
   assert.deepEqual(empty, { active: null, channels: [] });
   const cleared = (await trace()).filter(item => item.method === 'config/batchWrite').at(-1).params.edits[0];
   assert.equal(cleared.keyPath, 'model_providers.official-responses');
   assert.equal(cleared.value, null);
   assert.equal(JSON.parse(await readFile(channelFile, 'utf8')).active, null);
  });

  await t.test('wire values are normalized on save and legacy values stay readable', async () => {
   const legacyChat = remember((await api('channels/save', { id: 'legacy-chat', name: 'Legacy Chat', baseUrl: 'https://legacy.example/v1', wire: 'chat', model: 'legacy-model', apiKey: 'sk-wire-secret' })).body);
   assert.equal(legacyChat.wire, 'openai-chat', 'legacy chat is normalized on save');
   const legacyResponses = remember((await api('channels/save', { id: 'legacy-responses', name: 'Legacy Responses', baseUrl: 'https://legacy.example/v1', wire: 'responses', model: 'legacy-model', apiKey: 'sk-wire-secret' })).body);
   assert.equal(legacyResponses.wire, 'openai-responses', 'legacy responses is normalized on save');
   const anthropic = remember((await api('channels/save', { id: 'wire-anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', wire: 'anthropic', model: 'claude-sonnet-4', apiKey: 'sk-wire-secret' })).body);
   assert.equal(anthropic.wire, 'anthropic');
   for (const wire of ['gemini', 'azure-openai', 'ollama']) {
    const saved = remember((await api('channels/save', { id: `wire-${wire}`, name: `Wire ${wire}`, baseUrl: `https://${wire}.example/v1`, wire, model: 'wire-model', ...(wire === 'ollama' ? {} : { apiKey: 'sk-wire-secret' }) })).body);
    assert.equal(saved.wire, wire, wire);
   }
   const bogus = await api('channels/save', { id: 'wire-bogus', name: 'Bogus', baseUrl: 'https://bogus.example/v1', wire: 'grpc' });
   assert.equal(bogus.status, 400);
   assert.equal(bogus.body.error.code, 'channel/wire');
   const stored = JSON.parse(await readFile(channelFile, 'utf8'));
   assert.deepEqual(stored.channels.map(channel => channel.wire), ['openai-chat', 'openai-responses', 'anthropic', 'gemini', 'azure-openai', 'ollama']);
   for (const channel of stored.channels) assert.equal((await api('channels/remove', { id: channel.id })).body.removed, true, channel.id);
  });

  await t.test('channels/models follows each wire endpoint, auth header and parsing', async () => {
   const openai = await fakeUpstream(({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'resp-model', owned_by: 'openai' }] }));
   });
   const anthropic = await fakeUpstream(({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'claude-model' }] }));
   });
   const gemini = await fakeUpstream(({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ models: [{ name: 'models/gemini-one' }, { name: 'models/gemini-two' }] }));
   });
   const azure = await fakeUpstream(({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'azure-model' }] }));
   });
   const ollama = await fakeUpstream(({ response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ models: [{ name: 'llama3.2' }] }));
   });
   t.after(() => Promise.all([openai, anthropic, gemini, azure, ollama].map(upstream => upstream.close())));

   const definitions = [
    { id: 'models-responses', name: 'Models Responses', baseUrl: `${openai.url}/v1`, wire: 'openai-responses', model: 'resp-model', apiKey: 'sk-wire-secret' },
    { id: 'models-anthropic', name: 'Models Anthropic', baseUrl: `${anthropic.url}/v1`, wire: 'anthropic', model: 'claude-model', apiKey: 'sk-wire-secret' },
    { id: 'models-gemini', name: 'Models Gemini', baseUrl: `${gemini.url}/v1beta`, wire: 'gemini', model: 'gemini-one', apiKey: 'sk-wire-secret' },
    { id: 'models-azure', name: 'Models Azure', baseUrl: `${azure.url}`, wire: 'azure-openai', model: 'azure-model', apiKey: 'sk-wire-secret' },
    { id: 'models-ollama', name: 'Models Ollama', baseUrl: `${ollama.url}`, wire: 'ollama', model: 'llama3.2' },
   ];
   for (const definition of definitions) assert.equal((await api('channels/save', definition)).status, 200, definition.id);

   const responses = remember((await api('channels/models', { id: 'models-responses' })).body);
   assert.deepEqual(responses.models, [{ id: 'resp-model' }]);
   assert.equal(responses.count, 1);
   assert.equal(openai.requests[0].method, 'GET');
   assert.equal(openai.requests[0].path, '/v1/models');
   assert.equal(openai.requests[0].authorization, 'Bearer sk-wire-secret');

   const anthropicModels = remember((await api('channels/models', { id: 'models-anthropic' })).body);
   assert.deepEqual(anthropicModels.models, [{ id: 'claude-model' }]);
   assert.equal(anthropic.requests[0].path, '/v1/models');
   assert.equal(anthropic.requests[0].headers['x-api-key'], 'sk-wire-secret');
   assert.equal(anthropic.requests[0].headers['anthropic-version'], '2023-06-01');
   assert.equal(anthropic.requests[0].authorization, null);

   const geminiModels = remember((await api('channels/models', { id: 'models-gemini' })).body);
   assert.deepEqual(geminiModels.models, [{ id: 'gemini-one' }, { id: 'gemini-two' }], 'gemini models/ prefix is stripped');
   assert.equal(gemini.requests[0].path, '/v1beta/models', 'the /v1beta base is not duplicated');
   assert.equal(gemini.requests[0].headers['x-goog-api-key'], 'sk-wire-secret');

   const azureModels = remember((await api('channels/models', { id: 'models-azure' })).body);
   assert.deepEqual(azureModels.models, [{ id: 'azure-model' }]);
   assert.equal(azure.requests[0].path, '/openai/models?api-version=2024-10-21', 'azure needs the api-version query parameter');
   assert.equal(azure.requests[0].headers['api-key'], 'sk-wire-secret');

   const ollamaModels = remember((await api('channels/models', { id: 'models-ollama' })).body);
   assert.deepEqual(ollamaModels.models, [{ id: 'llama3.2' }]);
   assert.equal(ollama.requests[0].path, '/api/tags', 'ollama lists through /api/tags');
   assert.equal(ollama.requests[0].authorization, null);
   assert.equal(ollama.requests[0].headers['x-api-key'], undefined);

   for (const id of ['models-responses', 'models-anthropic', 'models-gemini', 'models-azure', 'models-ollama']) {
    assert.equal((await api('channels/remove', { id })).body.removed, true, id);
   }
  });

  await t.test('channels/test probes connect, auth, list and infer before reporting ok', async () => {
   const healthy = await fakeUpstream(({ request, response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.method === 'GET') response.end(JSON.stringify({ data: [{ id: 'probe-model' }] }));
    else response.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
   });
   const rejected = await fakeUpstream(({ response }) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'invalid key' } }));
   });
   const broken = await fakeUpstream(({ response }) => {
    response.writeHead(500, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'model list down' } }));
   });
   const inferFail = await fakeUpstream(({ request, response }) => {
    if (request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ data: [{ id: 'probe-model' }] })); return; }
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'rate limited' } }));
   });
   const local = await fakeUpstream(({ request, response }) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.method === 'GET') response.end(JSON.stringify({ models: [{ name: 'llama3.2' }] }));
    else response.end(JSON.stringify({ message: { role: 'assistant', content: 'pong' }, done: true, prompt_eval_count: 1, eval_count: 1 }));
   });
   const closed = createServer(() => {});
   await new Promise(resolve => closed.listen(0, '127.0.0.1', resolve));
   const closedPort = closed.address().port;
   await new Promise(resolve => { closed.closeAllConnections?.(); closed.close(() => resolve()); });
   t.after(() => Promise.all([healthy, rejected, broken, inferFail, local].map(upstream => upstream.close())));

   const channels = [
    { id: 'probe-ok', name: 'Probe OK', baseUrl: `${healthy.url}/v1`, wire: 'chat', model: 'probe-model', apiKey: 'sk-wire-secret' },
    { id: 'probe-auth', name: 'Probe Auth', baseUrl: `${rejected.url}/v1`, wire: 'chat', model: 'probe-model', apiKey: 'sk-wire-secret' },
    { id: 'probe-list', name: 'Probe List', baseUrl: `${broken.url}/v1`, wire: 'chat', model: 'probe-model', apiKey: 'sk-wire-secret' },
    { id: 'probe-infer', name: 'Probe Infer', baseUrl: `${inferFail.url}/v1`, wire: 'chat', model: 'probe-model', apiKey: 'sk-wire-secret' },
    { id: 'probe-connect', name: 'Probe Connect', baseUrl: `http://127.0.0.1:${closedPort}/v1`, wire: 'chat', model: 'probe-model', apiKey: 'sk-wire-secret' },
    { id: 'probe-ollama', name: 'Probe Ollama', baseUrl: `${local.url}`, wire: 'ollama', model: 'llama3.2' },
   ];
   for (const channel of channels) assert.equal((await api('channels/save', channel)).status, 200, channel.id);

   const ok = await api('channels/test', { id: 'probe-ok' });
   assert.equal(ok.status, 200, JSON.stringify(ok.body));
   assert.equal(ok.body.ok, true);
   assert.equal(ok.body.wire, 'openai-chat');
   assert.equal(ok.body.models, 1);
   assert(Number.isInteger(ok.body.latencyMs) && ok.body.latencyMs >= 0, 'latencyMs must be a number');
   assert.equal(healthy.requests.length, 2, 'connect+list is one GET, infer is one POST');
   assert.equal(healthy.requests[0].method, 'GET');
   assert.equal(healthy.requests[0].path, '/v1/models');
   assert.equal(healthy.requests[0].authorization, 'Bearer sk-wire-secret');
   assert.equal(healthy.requests[1].method, 'POST');
   assert.equal(healthy.requests[1].path, '/v1/chat/completions');
   assert.deepEqual(healthy.requests[1].body, { model: 'probe-model', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false });

   const auth = await api('channels/test', { id: 'probe-auth' });
   assert.equal(auth.status, 502);
   assert.equal(auth.body.error.code, 'channel/test');
   assert.equal(auth.body.error.details.stage, 'auth');
   assert.equal(auth.body.error.details.status, 401);

   const list = await api('channels/test', { id: 'probe-list' });
   assert.equal(list.status, 502);
   assert.equal(list.body.error.details.stage, 'list');
   assert.equal(list.body.error.details.status, 500);

   const infer = await api('channels/test', { id: 'probe-infer' });
   assert.equal(infer.status, 502);
   assert.equal(infer.body.error.details.stage, 'infer');
   assert.equal(infer.body.error.details.status, 429);

   const connect = await api('channels/test', { id: 'probe-connect' });
   assert.equal(connect.status, 502);
   assert.equal(connect.body.error.details.stage, 'connect');

   const ollama = await api('channels/test', { id: 'probe-ollama' });
   assert.equal(ollama.status, 200, JSON.stringify(ollama.body));
   assert.equal(ollama.body.wire, 'ollama');
   assert.equal(ollama.body.models, 1);
   assert.equal(local.requests[0].path, '/api/tags');
   assert.equal(local.requests[1].path, '/api/chat');
   assert.deepEqual(local.requests[1].body, { model: 'llama3.2', messages: [{ role: 'user', content: 'ping' }], stream: false, options: { num_predict: 1 } });
   assert.equal(local.requests[1].authorization, null, 'ollama needs no key');

   assert.equal((await api('channels/test', {})).status, 400);
   assert.equal((await api('channels/test', {})).body.error.code, 'channel/id');
   assert.equal((await api('channels/test', { id: 'ghost' })).status, 404);
   assert.equal((await api('channels/test', { id: 'probe-ok', surprise: true })).body.error.code, 'request/invalid');
   for (const channel of channels) assert.equal((await api('channels/remove', { id: channel.id })).body.removed, true, channel.id);
  });

  await t.test('activation routes every proxied wire through the local proxy and keeps openai-responses direct', async () => {
   assert.equal((await api('channels/save', { id: 'wire-gemini', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', wire: 'gemini', model: 'gemini-2.5-pro', apiKey: 'sk-wire-secret' })).status, 200);
   assert.equal((await api('channels/save', { id: 'wire-direct', name: 'Direct', baseUrl: 'https://api.openai.com/v1', wire: 'responses', model: 'gpt-6.2-sol', apiKey: 'sk-wire-secret' })).status, 200);
   const compat = (await health()).compatPort;
   assert.equal((await api('channels/activate', { id: 'wire-gemini' })).body.active, 'wire-gemini');
   let edits = (await trace()).filter(item => item.method === 'config/batchWrite').at(-1).params.edits;
   let provider = edits.find(edit => edit.keyPath === 'model_providers.wire-gemini');
   assert.equal(provider.value.wire_api, 'responses');
   assert.equal(provider.value.base_url, `http://127.0.0.1:${compat}/v1/wire-gemini`, 'gemini is proxied through the loopback adapter');
   assert.equal((await api('channels/activate', { id: 'wire-direct' })).body.active, 'wire-direct');
   edits = (await trace()).filter(item => item.method === 'config/batchWrite').at(-1).params.edits;
   provider = edits.find(edit => edit.keyPath === 'model_providers.wire-direct');
   assert.equal(provider.value.base_url, 'https://api.openai.com/v1', 'openai-responses stays a direct connection');
   assert.equal(provider.value.wire_api, 'responses');
   assert.equal((await api('channels/remove', { id: 'wire-gemini' })).body.removed, true);
   assert.equal((await api('channels/remove', { id: 'wire-direct' })).body.removed, true);
  });

  await t.test('no channel payload ever carried a key or the bridge token', async () => {
   for (const payload of seen) {
    assert(!payload.includes('sk-relay-secret'));
    assert(!payload.includes('sk-official-secret'));
    assert(!payload.includes('sk-models-secret'));
    assert(!payload.includes('sk-wire-secret'));
    assert(!payload.includes(token));
   }
  });

  // 退出时兼容代理必须跟着关闭，不能在后台留监听端口。
  child.kill();
  await Promise.race([exited, delay(5000)]);
  await until(async () => {
   try {
    await fetch(`http://127.0.0.1:${compatPort}/v1/ghost/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return false;
   } catch { return true; }
  }, 'compat proxy closed on shutdown', 5000);
 } finally {
  child.kill();
  await Promise.race([exited, delay(5000)]);
  await out.close(); await err.close();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
 }
});

test('channel registry rejects a corrupt file instead of guessing', { timeout: 20000 }, async t => {
 const home = await mkdtemp(join(tmpdir(), 'codex-channels-corrupt-'));
 const outputPath = join(home, 'stdout.log'), errorPath = join(home, 'stderr.log');
 const out = await open(outputPath, 'w'), err = await open(errorPath, 'w');
 await writeFile(join(home, 'codex-go-channels.json'), '{"active":"gone","channels":[{"id":"Bad.Id","name":"x","baseUrl":"https://x.example/v1","wire":"chat"}]}');
 const child = spawn(process.execPath, [
  resolve(here, '../bridge/server.mjs'),
  '--codex', process.execPath, '--codex-arg', join(here, 'protocol-fixture.mjs'),
  '--codex-home', home, '--cwd', home,
  '--toolpacks', join(home, 'no-builtin-packs'), '--plugins', join(home, 'no-builtin-plugins'),
  '--host', '127.0.0.1', '--port', '0', '--token', token,
 ], { stdio: ['ignore', out.fd, err.fd], windowsHide: true });
 const exited = once(child, 'close');
 try {
  const base = await until(async () => {
   const output = await readFile(outputPath, 'utf8');
   const match = output.match(/codex-go: (http:\/\/127\.0\.0\.1:\d+)\//);
   if (child.exitCode !== null) throw Error(`Bridge exited ${child.exitCode}: ${await readFile(errorPath, 'utf8')}`);
   return match?.[1];
  }, 'bridge startup', 8000);
  const response = await fetch(`${base}/api/channels`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error.code, 'channel/state');
  assert.equal(body.error.details.path, join(home, 'codex-go-channels.json'));
  // 坏文件不影响其它接口：healthz 仍然可用。
  const health = await (await fetch(`${base}/healthz`)).json();
  assert.equal(health.ok, true);
 } finally {
  child.kill();
  await Promise.race([exited, delay(5000)]);
  await out.close(); await err.close();
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
 }
});
