import test from 'node:test';
import assert from 'node:assert/strict';
import {AgentRunRegistry} from '../bridge/agent-runs.mjs';
import {createServer} from 'node:http';
import {tools} from '../bridge/toolpacks/subagent/index.mjs';

function setup(options = {}) {
  const events = []; let clock = 1000;
  return {events, registry: new AgentRunRegistry({emit: e => events.push(e), now: () => clock++, ...options})};
}

test('three concurrent runs immediately queue then independently run and complete', async () => {
  const {registry: r, events} = setup();
  const runs = [0, 1, 2].map(n => r.queue({name: `worker ${n}`, role: 'research', task: `task ${n}`, parentThreadId: 'main'}));
  assert.deepEqual(events.map(e => e.state), ['queued', 'queued', 'queued']);
  assert.ok(runs.every(run => run.startedAt === null));
  await Promise.all(runs.map(async (run, n) => {
    r.start(run.agentId, {threadId: `child-${n}`});
    await Promise.resolve();
    r.accept({type: 'text.delta', threadId: `child-${n}`, text: `result ${n}`});
    r.finish(run.agentId, {state: 'completed'});
  }));
  for (const run of runs) {
    assert.deepEqual(events.filter(e => e.agentId === run.agentId && e.type === 'agent.status').map(e => e.state), ['queued', 'running', 'done']);
  }
  assert.ok(events.every(e => e.threadId === 'main'));
  assert.ok(r.tree().agents.every(run => run.startedAt < run.endedAt && run.logs.length === 1));
});

test('finished agents survive a bridge restart and keep their real thread for continuing', () => {
  const {registry: first} = setup();
  const done = first.queue({name: 'worker', role: 'research', task: 'do work', parentThreadId: 'main'});
  first.start(done.agentId, {threadId: 'child-42'});
  first.accept({type: 'text.delta', threadId: 'child-42', text: 'finished result'});
  first.finish(done.agentId, {state: 'completed'});
  const interrupted = first.queue({name: 'busy', task: 'still running', parentThreadId: 'main'});
  first.start(interrupted.agentId, {threadId: 'child-99'});
  const saved = first.view();
  const {registry: second} = setup();
  assert.equal(second.restore(saved), 2);
  const restored = second.tree().agents.find(agent => agent.agentId === done.agentId);
  assert.equal(restored.state, 'done');
  assert.equal(restored.agentThreadId, 'child-42');
  assert.equal(restored.logs[0].text, 'finished result');
  const lost = second.tree().agents.find(agent => agent.agentId === interrupted.agentId);
  assert.equal(lost.state, 'failed');
  assert.match(lost.error, /重启前仍在运行/);
  assert.equal(second.accept({type: 'text.delta', threadId: 'child-99', text: 'late'}), false);
  assert.equal(second.restore(saved), 0, 'restoring twice must not duplicate agents');
});

test('startup failures and legacy timeout finish as failed, without stale routing', () => {
  const {registry: r, events} = setup();
  const first = r.queue({task: 'startup'});
  r.finish(first.agentId, {state: 'failed', error: new Error('start failed')});
  const second = r.queue({task: 'deadline'});
  r.start(second.agentId, {threadId: 'child'});
  r.finish(second.agentId, {state: 'timeout'});
  assert.equal(r.accept({type: 'text.delta', threadId: 'child', text: 'late'}), false);
  assert.deepEqual(r.tree().agents.map(a => [a.state, a.error]), [['failed', 'start failed'], ['failed', 'Subagent timed out']]);
  assert.ok(events.every(e => e.threadId === null));
});

test('explicit parent isolation, unknown parents stay global and snapshots retain logs', () => {
  const {registry: r, events} = setup();
  const a = r.queue({parentThreadId: 'a'});
  const b = r.queue({parentThreadId: 'b', parentId: a.agentId});
  r.queue({task: 'global'});
  r.start(a.agentId, {threadId: 'child-a'});
  r.start(b.agentId, {threadId: 'child-b'});
  r.accept({type: 'reasoning.delta', threadId: 'child-b', text: 'thinking'});
  assert.equal(r.accept({type: 'text.delta', threadId: 'a', text: 'parent text'}), false);
  assert.equal(r.tree({parentThreadId: 'a'}).agents.length, 1);
  assert.equal(r.tree({parentThreadId: 'b'}).agents[0].logs[0].text, 'thinking');
  assert.equal(events.at(-1).threadId, 'b');
  assert.equal(events.at(-1).agentThreadId, 'child-b');
  const snapshot = r.tree(); snapshot.agents[1].logs[0].text = 'changed';
  assert.equal(r.tree().agents[1].logs[0].text, 'thinking');
});

test('logs preserve real event order, redact credentials, and visibly bound giant outputs', () => {
  const {registry: r, events} = setup({maxLogBytes: 700});
  const {agentId} = r.queue({task: 'GET https://host/?token=secret Bearer abc.def'});
  r.start(agentId, {threadId: 'child'});
  for (const event of [
    {type: 'reasoning.delta', text: 'consider'},
    {type: 'tool.start', name: 'fetch', args: {authorization: 'Bearer hidden', url: 'https://host/?api_key=private'}},
    {type: 'tool.args.delta', delta: 'argument'},
    {type: 'tool.output', chunk: 'x'.repeat(10000)},
    {type: 'tool.end', status: 'completed'},
    {type: 'text.delta', text: 'answer'},
  ]) r.accept({...event, threadId: 'child'});
  const logs = events.filter(e => e.type === 'agent.log');
  assert.deepEqual(logs.map(e => e.log.type), ['reasoning.delta', 'tool.start', 'tool.args.delta', 'tool.output', 'tool.end', 'text.delta']);
  assert.ok(logs[3].text.includes('truncated'));
  const snapshot = r.tree().agents[0];
  assert.ok(snapshot.logBytes <= 700);
  assert.ok(snapshot.droppedLogs > 0);
  assert.deepEqual(snapshot.logs.map(l => l.seq), [...snapshot.logs.map(l => l.seq)].sort((a,b) => a-b));
  const json = JSON.stringify(events);
  for (const secret of ['secret', 'abc.def', 'hidden', 'private']) assert.ok(!json.includes(secret), secret);
});

test('tiny event floods and completed retention are bounded with explicit removal', () => {
  const {registry: r, events} = setup({maxLogBytes: 256, maxCompleted: 1});
  const {agentId} = r.queue(); r.start(agentId, {threadId: 't'});
  for (let n = 0; n < 100; n++) r.accept({type: 'tool.output', threadId: 't', chunk: '中文😀'.repeat(100), name: 'n'.repeat(200), itemId: 'id'.repeat(100)});
  for (const type of ['tool.args.delta', 'tool.output', 'reasoning.delta']) {
    r.accept({type, threadId: 't', text: '\\"\n\t'.repeat(1000)});
    assert.ok(r.tree().agents[0].logBytes <= 256);
  }
  assert.ok(r.tree().agents[0].logBytes <= 256);
  assert.ok(r.tree().agents[0].logs[0].truncated);
  r.finish(agentId);
  const next = r.queue(); r.finish(next.agentId);
  assert.equal(r.tree().agents.length, 1);
  assert.ok(events.some(e => e.type === 'agent.removed' && e.agentId === agentId));
});

test('MCP passes explicit board metadata but preserves legacy results and omitted parents', async t => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({threadId: 'child', turnId: 'turn', status: 'completed', text: 'answer'}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const ctx = {bridge: {baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'fixture'}, timeoutMs: 5000};
  const run = tools.find(tool => tool.name === 'subagent_run');
  const result = await run.run({prompt: 'task', name: 'reviewer', role: 'review', parentId: 'agent-parent', parentThreadId: 'main'}, ctx);
  assert.deepEqual(requests[0], {prompt: 'task', name: 'reviewer', role: 'review', parentId: 'agent-parent', parentThreadId: 'main', timeoutMs: 4000});
  assert.equal(result.status, 'completed');
  assert.equal(result.threadId, 'child');
  assert.equal(result.text, 'answer');
  await run.run({prompt: 'without parent'}, ctx);
  assert.ok(!('parentThreadId' in requests[1]));
  await assert.rejects(run.run({prompt: 'task', name: 'x'.repeat(201)}, ctx), {code: 'args/invalid'});
});

