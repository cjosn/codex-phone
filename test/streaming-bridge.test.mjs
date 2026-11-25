import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {test} from 'node:test';
import {start as startCompatProxy} from '../bridge/compat-proxy.mjs';

async function upstreamWith(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}

async function responseEvents(response) {
  const text = await response.text();
  return [...text.matchAll(/^event: ([^\n]+)\ndata: ([^\n]+)\n\n/gm)]
    .map(match => ({event: match[1], data: JSON.parse(match[2])}));
}

const correlationHeaders = {
  'content-type': 'application/json',
  'thread-id': 'thread-real',
  'x-codex-turn-metadata': JSON.stringify({thread_id: 'thread-real', turn_id: 'turn-real'}),
};

test('compat mirrors correlated tool argument fragments without changing Responses SSE', async t => {
  const upstream = await upstreamWith((req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    for (const payload of [
      {choices: [{delta: {tool_calls: [{index: 0, id: 'call-1', function: {name: 'file_read', arguments: '{"path":'}}]}}]},
      {choices: [{delta: {tool_calls: [{index: 0, function: {arguments: '"README.md"}'}}]}}]},
      {choices: [{delta: {}, finish_reason: 'tool_calls'}], usage: {prompt_tokens: 3, completion_tokens: 2, total_tokens: 5}},
    ]) res.write(`data: ${JSON.stringify(payload, null, 2).replaceAll('\n', '\ndata: ')}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  t.after(() => upstream.close());
  const deltas = [];
  const proxy = await startCompatProxy(0, '127.0.0.1', {
    lookupChannel: () => ({wire: 'openai-chat', baseUrl: upstream.url, model: 'fixture', apiKey: 'fixture-only'}),
    onToolArgumentsDelta: event => deltas.push(event),
  });
  t.after(() => proxy.close());
  const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/main/responses`, {
    method: 'POST', headers: correlationHeaders,
    body: JSON.stringify({model: 'fixture', stream: true, input: 'read README'}),
  });
  assert.equal(response.status, 200);
  const events = await responseEvents(response);
  assert.deepEqual(events.filter(event => event.event === 'response.function_call_arguments.delta').map(event => event.data.delta), ['{"path":', '"README.md"}']);
  assert.deepEqual(deltas.map(event => event.delta), ['{"path":', '"README.md"}']);
  for (const delta of deltas) {
    assert.equal(delta.threadId, 'thread-real');
    assert.equal(delta.turnId, 'turn-real');
    assert.equal(delta.callId, 'call-1');
    assert.equal(delta.name, 'file_read');
    assert.equal(delta.itemId, 'call-1', 'app-server exposes call_id as its tool item id');
    assert.match(delta.upstreamItemId, /^fc_/);
  }
  assert.equal(events.at(-1).data.response.output[0].arguments, '{"path":"README.md"}');
});

test('correlation requires matching thread metadata and never guesses a turn', async t => {
  const upstream = await upstreamWith((req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.end(`data: ${JSON.stringify({choices: [{delta: {tool_calls: [{id: 'c', function: {name: 'f', arguments: '{}'}}]}}]})}\n\ndata: [DONE]\n\n`);
  });
  t.after(() => upstream.close());
  const deltas = [];
  const proxy = await startCompatProxy(0, '127.0.0.1', {
    lookupChannel: () => ({wire: 'openai-chat', baseUrl: upstream.url, model: 'fixture'}),
    onToolArgumentsDelta: event => deltas.push(event),
  });
  t.after(() => proxy.close());
  for (const headers of [
    {'content-type': 'application/json'},
    {...correlationHeaders, 'thread-id': 'different-thread'},
    {'content-type': 'application/json', 'thread-id': 'thread-real', 'x-codex-turn-metadata': '{bad json'},
  ]) {
    const response = await fetch(`http://127.0.0.1:${proxy.port}/v1/main/responses`, {
      method: 'POST', headers, body: JSON.stringify({model: 'fixture', stream: true, input: 'go'}),
    });
    assert.equal(response.status, 200);
    await response.text();
  }
  assert.deepEqual(deltas, []);
});

test('multiline SSE is decoded once and malformed JSON becomes an explicit failed response', async t => {
  let malformed = false;
  const upstream = await upstreamWith((req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    if (malformed) res.end('data: {not json\n\n');
    else res.end(`data: ${JSON.stringify({choices: [{delta: {content: 'kept'}}]}, null, 2).replaceAll('\n', '\ndata: ')}\n\ndata: [DONE]\n\n`);
  });
  t.after(() => upstream.close());
  const proxy = await startCompatProxy(0, '127.0.0.1', {
    lookupChannel: () => ({wire: 'openai-chat', baseUrl: upstream.url, model: 'fixture'}),
  });
  t.after(() => proxy.close());
  const request = () => fetch(`http://127.0.0.1:${proxy.port}/v1/main/responses`, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({model: 'fixture', stream: true, input: 'hello'}),
  });
  const valid = await responseEvents(await request());
  assert.equal(valid.find(event => event.event === 'response.output_text.delta').data.delta, 'kept');
  malformed = true;
  const invalid = await responseEvents(await request());
  assert.equal(invalid.at(-1).event, 'response.failed');
  assert.match(invalid.at(-1).data.response.error.message, /malformed JSON/);
});
