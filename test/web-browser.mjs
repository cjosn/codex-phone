import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const fixtureToken = 'web-test-session-token';
const output = process.env.POCKET_WEB_SHOTS || path.join(tmpdir(), 'pocket-web-shots');
const requests = [];
let stream;
let seq = 0;
let releaseSend;
let sendCount = 0;
const ring = [];
const fixture = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname;
  function json(status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  }
  if (route === '/healthz') return json(200, { ok: true, mode: 'app-server', seq });
  if (route.startsWith('/api/') && req.headers.authorization !== `Bearer ${fixtureToken}`) return json(401, {});
  if (route === '/api/events') {
    const after = Number(url.searchParams.get('after'));
    requests.push({ route, after, url: req.url });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': started\n\n');
    for (const rec of ring) if (rec.seq > after) res.write(packet(rec));
    stream = res;
    return;
  }
  if (route.startsWith('/api/')) {
    let data = '';
    for await (const chunk of req) data += chunk;
    const body = data ? JSON.parse(data) : {};
    requests.push({ route, body });
    switch (route) {
      case '/api/thread/list': return json(200, { threads: [{ id: 'original', name: '现有项目会话', cwd: 'C:\\demo' }] });
      case '/api/thread/resume': return json(200, { threadId: 'original', thread: { id: 'original', turns: [{ id: 'previous', status: 'completed', items: [
        { id: 'u', type: 'userMessage', content: [{ type: 'text', text: '读取历史' }] },
        { id: 'a', type: 'agentMessage', text: '已读取 **历史**。\n```js\nconst a = 1;\n```' },
      ] }] } });
      case '/api/thread/create': return json(200, { threadId: 'new', thread: { cwd: body.cwd } });
      case '/api/turn/send': {
        if (++sendCount === 2) return json(500, { error: { message: `上游不可用 ${fixtureToken}` } });
        await new Promise(resolve => { releaseSend = resolve; });
        return json(200, { turnId: 'turn-1' });
      }
      case '/api/turn/interrupt': return json(200, {});
      case '/api/approval': return json(200, { ok: true });
      case '/api/config': return json(200, { provider: 'demo', model: 'model-1', baseUrl: 'https://example.com/v1', apiKeyConfigured: true, apiKey: 'test-key-never-render' });
      case '/api/models': return json(404, {});
      case '/api/account': return json(200, { account: null, requiresOpenaiAuth: true });
      default: return json(404, {});
    }
  }
  const names = { '/': 'index.html', '/pocket.css': 'pocket.css', '/pocket.js': 'pocket.js' };
  if (!names[route]) return json(404, {});
  res.setHeader('Content-Type', { '/': 'text/html', '/pocket.css': 'text/css', '/pocket.js': 'text/javascript' }[route] + '; charset=utf-8');
  res.end(await readFile(new URL(`../web/${names[route]}`, import.meta.url)));
});
function packet(rec) { return `id: ${rec.seq}\ndata: ${JSON.stringify(rec)}\n\n`; }
function emit(event, live = true) {
  const rec = { ...event, seq: ++seq };
  ring.push(rec);
  if (live) stream.write(packet(rec));
  return rec;
}
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${fixture.address().port}`;
const cdpPort = 20222 + Math.floor(Math.random() * 1000);
const profile = await mkdtemp(path.join(tmpdir(), 'web-pocket-test-'));
const edge = spawn(process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, `${origin}/?token=${fixtureToken}`,
], { stdio: 'ignore', windowsHide: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(test, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try { const value = await test(); if (value) return value; } catch { /* retry while UI settles */ }
    await sleep(70);
  }
  throw new Error(`Timed out: ${label}`);
}
let socket;
try {
  const page = await until(async () => (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find(item => item.type === 'page' && item.url.startsWith(origin)), 'Edge target');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
    if (!pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(Error(msg.error.message));
    else resolve(msg.result);
  };
  function cdp(method, params = {}) {
    const id = ++nextId;
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  }
  async function evaluate(expression) {
    const response = await cdp('Runtime.evaluate', { expression, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || expression);
    return response.result.value;
  }
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const contains = value => evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`);
  const setInput = value => evaluate(`document.querySelector('#input').value=${JSON.stringify(value)}; document.querySelector('#input').dispatchEvent(new Event('input'))`);
  async function metrics(width, height, mobile) {
    await cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
  }
  async function shot(name) {
    await mkdir(output, { recursive: true });
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(output, `${name}.png`), Buffer.from(data, 'base64'));
  }
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await metrics(1280, 800, false);
  await until(() => stream && contains('本机已连接'), 'authenticated health and SSE');
  assert.equal(await evaluate('location.search'), '');
  assert.equal(await evaluate('localStorage.length'), 0);
  await click('.session-item');
  await until(() => evaluate(`document.querySelector('#log code')?.textContent === 'const a = 1;'`), 'Codex raw history and Markdown');
  await click('#newTask');
  await until(() => evaluate(`document.querySelector('#taskTitle').textContent === '新任务'`), 'new task selected');
  await evaluate(`document.querySelector('#effort').value = 'high'`);
  await setInput('运行验证');
  await click('#send');
  await until(() => releaseSend, 'turn/send request');
  assert.equal(requests.find(item => item.route === '/api/turn/send').body.reasoningEffort, 'high');
  emit({ threadId: 'new', type: 'turn.start', turnId: 'turn-1' });
  emit({ threadId: 'original', type: 'text.delta', itemId: 'foreign', text: 'DO NOT CROSS THREADS' });
  emit({ threadId: 'new', type: 'text.delta', itemId: 'msg', turnId: 'turn-1', text: '已开始。\n\n```js\n' });
  releaseSend();
  await until(() => contains('运行验证'), 'confirmed prompt appears');
  stream.end();
  const waitAfter = seq;
  const repeated = emit({ threadId: 'new', type: 'text.delta', itemId: 'msg', turnId: 'turn-1', text: 'test();\n```' }, false);
  await until(() => requests.some(item => item.route === '/api/events' && item.after === waitAfter), 'SSE resumes from last sequence');
  stream.write(packet(repeated));
  emit({ threadId: 'new', type: 'tool.start', itemId: 'tool', turnId: 'turn-1', name: '运行测试', args: { command: 'npm test' } });
  emit({ threadId: 'new', type: 'tool.output', itemId: 'tool', turnId: 'turn-1', chunk: 'PASS' });
  emit({ threadId: 'new', type: 'tool.output', itemId: 'tool', turnId: 'turn-1', chunk: 'PASS\n', replace: true });
  emit({ threadId: 'new', type: 'tool.end', itemId: 'tool', turnId: 'turn-1', status: 'completed', exitCode: 0 });
  emit({ threadId: 'new', type: 'diff', itemId: 'patch', turnId: 'turn-1', patch: '-旧\n+新' });
  emit({ threadId: 'new', type: 'approval.request', itemId: 'other', approvalId: 'rpc:1', turnId: 'turn-1', kind: 'command', payload: { command: 'npm test' } });
  await until(() => evaluate(`document.querySelector('.approval button') && document.querySelector('.diff .add')?.textContent === '+新'`), 'tool, diff and approval');
  assert.equal(await evaluate(`document.querySelector('#log code').textContent`), 'test();');
  assert.equal(await evaluate(`document.querySelector('.card .out').textContent`), 'PASS\n');
  assert.equal(await contains('DO NOT CROSS THREADS'), false);
  await shot('pocket-desktop1280');
  await click('.approval .no');
  await until(() => contains('已拒绝'), 'approval acknowledged');
  assert.equal(requests.find(item => item.route === '/api/approval').body.decision, 'decline');
  await click('#stop');
  await until(() => requests.some(item => item.route === '/api/turn/interrupt'), 'stop request');
  assert.equal(requests.find(item => item.route === '/api/turn/interrupt').body.turnId, 'turn-1');
  emit({ threadId: 'new', type: 'turn.end', turnId: 'turn-1', status: 'interrupted' });
  await until(() => contains('任务已中断'), 'interrupt completion displayed');
  await setInput('保留未发送内容');
  await click('#send');
  await until(() => contains('发送失败'), 'HTTP failure displayed');
  assert.equal(await evaluate(`document.querySelector('#input').value`), '保留未发送内容');
  assert.equal(await contains(fixtureToken), false);
  assert.ok(requests.filter(item => item.route === '/api/events').every(item => !item.url.includes(fixtureToken)));
  await click('#dismissNotice');
  for (const [width, height] of [[360, 800], [430, 932]]) {
    await metrics(width, height, true);
    await until(() => evaluate(`innerWidth === ${width} && document.querySelector('#sidebar').getBoundingClientRect().right <= 0`), `viewport ${width} with closed drawer`);
    assert.equal(await evaluate(`document.documentElement.scrollWidth`), width);
    assert.ok(await evaluate(`document.querySelector('footer').getBoundingClientRect().bottom <= innerHeight`));
    await shot(`pocket-mobile${width}`);
    await click('#menu');
    assert.ok(await evaluate(`document.querySelector('#sidebar').classList.contains('open')`));
    await until(() => evaluate(`Math.round(document.querySelector('#sidebar').getBoundingClientRect().left) === 0`), 'drawer transition');
    if (width === 430) await shot('pocket-drawer430');
    await click('#closeSidebar');
  }
  await click('#menu');
  await click('#settingsButton');
  await click('#loadConfig');
  await until(() => contains('模型列表不可用'), 'unavailable endpoint displayed');
  assert.equal(await evaluate(`document.querySelector('#providerKey').value`), '');
  assert.equal(await contains('test-key-never-render'), false);
  await click('#loadAccount');
  await until(() => contains('需要登录 OpenAI 账号'), 'account status');
  assert.deepEqual(errors, []);
  console.log(`PASS: Edge browser HTTP/SSE fixture and 360/430/1280 layouts. Screenshots: ${output}`);
} finally {
  socket?.close();
  edge.kill();
  fixture.closeAllConnections();
  fixture.close();
}
