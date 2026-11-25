const $ = id => document.getElementById(id);
const log = $('log');
const welcome = $('welcome');
const input = $('input');
const storageKey = 'codex-pocket.connection';
const launch = new URL(location.href);
let saved = {};
try {
  saved = JSON.parse(sessionStorage.getItem(storageKey) || '{}');
  localStorage.removeItem('cg_token');
} catch { /* storage may be unavailable in a WebView */ }
let base = saved.base || location.origin;
let token = launch.searchParams.get('token') ?? saved.token ?? '';
if (launch.searchParams.has('token')) {
  base = location.origin;
  launch.searchParams.delete('token');
  history.replaceState(null, '', launch);
  remember();
}
let cwd = '';
let model = '';
let provider = '';
let connected = false;
let generation = 0;
let controller;
let seq = 0;
let active = null;
let pendingSelect = null;
let selecting = false;
let threads = [];
let contexts = [];
const states = new Map();

function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function remember() {
  try { sessionStorage.setItem(storageKey, JSON.stringify({ base, token })); } catch { /* optional */ }
}

function normalizeBase(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('请输入不含账号、Token 或查询参数的 HTTP(S) 地址');
  }
  return url.href.replace(/\/+$/, '');
}

function clean(text) {
  let result = String(text ?? '未知错误');
  for (const secret of [token, $('providerKey').value]) {
    if (secret) result = result.split(secret).join('[已隐藏]');
  }
  return result.replace(/\b(?:sk-[\w-]{8,}|Bearer\s+[^\s,;]+)/gi, '[已隐藏]');
}

function failure(error) {
  return clean(error?.message || error?.code || error);
}

function notice(text = '') {
  $('noticeText').textContent = clean(text);
  $('notice').hidden = !text;
}

function status(text, type = '') {
  $('connectionStatus').textContent = text;
  $('sidebarStatus').textContent = text;
  $('statusDot').className = `dot ${type}`;
}

function settingsMessage(text, cls = '') {
  $('settingsMessage').className = cls;
  $('settingsMessage').textContent = clean(text);
}

async function request(path, { method = 'GET', body, signal, auth = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (auth && token) {
    headers.Authorization = `Bearer ${token}`;
    headers['X-Codex-Go-Token'] = token;
  }
  if (body != null) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}/${path}`, {
    method, headers, cache: 'no-store', credentials: 'omit', redirect: 'error',
    referrerPolicy: 'no-referrer', signal, body: body == null ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) throw new Error('连接未授权，请检查设备 Token');
  if (response.status === 404 || response.status === 405) throw new Error(`当前 bridge 未提供 ${path}（HTTP ${response.status}）`);
  if (!response.ok || !data || data.ok === false) {
    throw new Error(data?.error?.message || data?.error?.code || data?.note || `无效响应（HTTP ${response.status}）`);
  }
  return data;
}

const api = (route, body, signal) => request(`api/${route}`, { method: body == null ? 'GET' : 'POST', body, signal });
const threadKey = value => String(value ?? '').replace(/^th_/, '');
const sameThread = (first, second) => !!first && !!second && threadKey(first) === threadKey(second);
const titleOf = thread => thread?.name || thread?.title || thread?.preview || '未命名任务';
const pathName = value => value?.split(/[\\/]/).filter(Boolean).pop() || value || '';

function stateFor(id) {
  const key = threadKey(id);
  if (!states.has(key)) {
    states.set(key, { id, records: new Map(), approvals: new Map(), turnId: null, pending: false,
      busy: false, stopping: false, terminated: new Set(), issue: '', initialized: false });
  }
  return states.get(key);
}

function updateWorkspace() {
  const path = active?.cwd || cwd;
  $('workspaceName').textContent = pathName(path) || '选择项目目录';
  $('topWorkspace').textContent = pathName(path) || '工作区';
  $('pathLabel').textContent = path || '选择项目路径';
  $('projectPath').title = path || '';
}

function controls() {
  const state = active && stateFor(active.id);
  const running = !!(state?.busy || state?.pending);
  $('send').hidden = running;
  $('send').disabled = !connected || selecting || !input.value.trim();
  $('stop').hidden = !running;
  $('stop').disabled = !connected || !state?.turnId || state.stopping;
  $('newTask').disabled = !connected || selecting;
  $('activity').textContent = state?.stopping ? '正在停止…' : running ? 'Codex 正在处理' : 'Codex Pocket';
}

function renderSessions() {
  const list = $('sessions');
  list.replaceChildren();
  const matching = cwd ? threads.filter(thread => !thread.cwd || thread.cwd === cwd) : threads;
  $('threadCount').textContent = matching.length || '';
  if (!matching.length) list.append(element('p', 'muted', connected ? '此工作区没有会话' : '连接后查看最近任务'));
  for (const thread of matching) {
    const button = element('button', `session-item${sameThread(thread.id, active?.id) ? ' selected' : ''}`, titleOf(thread));
    button.title = titleOf(thread);
    button.onclick = () => selectThread(thread);
    list.append(button);
  }
}

async function refreshThreads(signal) {
  const result = await api('thread/list', {}, signal);
  if (signal?.aborted) return;
  if (!Array.isArray(result.threads)) throw new Error('bridge 未返回任务列表');
  threads = result.threads.map(thread => ({ ...thread, id: thread.id ?? thread.threadId })).filter(thread => thread.id);
  if (active) active = { ...active, ...threads.find(thread => sameThread(thread.id, active.id)), id: active.id };
  renderSessions();
  updateHeading();
}

function updateHeading() {
  $('taskTitle').textContent = active ? titleOf(active) : '新任务';
  updateWorkspace();
}

function addInline(parent, text) {
  const tokens = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^\s)]+\))/g;
  let last = 0;
  for (const match of text.matchAll(tokens)) {
    parent.append(text.slice(last, match.index));
    const value = match[0];
    if (value[0] === '`') parent.append(element('code', '', value.slice(1, -1)));
    else if (value.startsWith('**')) parent.append(element('strong', '', value.slice(2, -2)));
    else {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(value);
      try {
        const href = new URL(parts[2]);
        if (!['https:', 'http:'].includes(href.protocol)) throw new Error();
        const link = element('a', '', parts[1]);
        link.href = href.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        parent.append(link);
      } catch { parent.append(value); }
    }
    last = match.index + value.length;
  }
  parent.append(text.slice(last));
}

function markdown(node, source) {
  node.replaceChildren();
  const lines = source.split('\n');
  for (let i = 0; i < lines.length;) {
    const line = lines[i++];
    if (!line.trim()) continue;
    if (/^\s*```/.test(line)) {
      const code = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      if (i < lines.length) i++;
      const pre = element('pre');
      pre.append(element('code', '', code.join('\n')));
      node.append(pre);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const bullet = /^(\s*[-*]|\s*\d+\.)\s+(.+)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[1]);
      const list = element(ordered ? 'ol' : 'ul');
      const add = text => { const item = element('li'); addInline(item, text); list.append(item); };
      add(bullet[2]);
      while (i < lines.length) {
        const next = /^(\s*[-*]|\s*\d+\.)\s+(.+)$/.exec(lines[i]);
        if (!next || /\d/.test(next[1]) !== ordered) break;
        add(next[2]);
        i++;
      }
      node.append(list);
      continue;
    }
    const quote = /^>\s?/.test(line);
    const block = element(heading ? `h${heading[1].length}` : quote ? 'blockquote' : 'p');
    const body = [heading ? heading[2] : quote ? line.replace(/^>\s?/, '') : line];
    if (!heading && !quote) {
      while (i < lines.length && lines[i].trim() && !/^\s*(?:```|#{1,3}\s|>|[-*]\s|\d+\.\s)/.test(lines[i])) body.push(lines[i++]);
    }
    addInline(block, body.join('\n'));
    node.append(block);
  }
}

const recordKey = (kind, event) => `${kind}:${event.itemId || event.turnId || 'active'}`;

function record(state, kind, event) {
  const key = recordKey(kind, event);
  if (!state.records.has(key)) state.records.set(key, { kind, turnId: event.turnId, text: '' });
  return state.records.get(key);
}

function toolRecord(state, event) {
  return record(state, 'tool', event);
}

function textValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return clean(value);
  return clean(JSON.stringify(value, null, 2));
}

function turnIssue(event) {
  if (/^(completed|success)$/i.test(event.status || '')) return '';
  if (/interrupt|cancel/i.test(event.status || '')) return '任务已中断';
  return event.error ? `任务失败：${failure(event.error)}` : `任务结束：${event.status || '未返回结果'}`;
}

function applyEvent(state, event) {
  switch (event.type) {
    case 'turn.start':
      if (state.terminated.has(event.turnId)) break;
      state.turnId = event.turnId || state.turnId;
      state.busy = true;
      state.issue = '';
      break;
    case 'turn.end':
      if (event.turnId) state.terminated.add(event.turnId);
      if (event.turnId && state.turnId && event.turnId !== state.turnId) break;
      state.busy = state.pending = state.stopping = false;
      state.turnId = null;
      state.issue = turnIssue(event);
      if (state.issue) state.records.set(`result:${event.turnId ?? event.seq}`, { kind: 'system', text: state.issue });
      for (const approval of state.approvals.values()) {
        if (!approval.done && (!event.turnId || !approval.turnId || approval.turnId === event.turnId)) approval.done = '任务已结束';
      }
      break;
    case 'text.delta':
      record(state, 'assistant', event).text += clean(event.text ?? '');
      break;
    case 'text.completed':
      record(state, 'assistant', event).text = clean(event.text ?? '');
      break;
    case 'reasoning.delta':
      record(state, 'reasoning', event).text += clean(event.text ?? '');
      break;
    case 'tool.start': {
      const tool = toolRecord(state, event);
      tool.name = clean(event.name || '工具');
      tool.args = textValue(event.args?.command ?? event.args);
      break;
    }
    case 'tool.output': {
      const tool = toolRecord(state, event);
      const chunk = clean(event.chunk ?? '');
      if (event.replace || event.aggregated) tool.text = chunk;
      else tool.text += chunk;
      break;
    }
    case 'tool.end': {
      const tool = toolRecord(state, event);
      tool.status = event.status || (event.exitCode ? 'failed' : 'completed');
      tool.exitCode = event.exitCode;
      break;
    }
    case 'diff':
      record(state, 'diff', event).text = textValue(event.patch ?? event.diff);
      break;
    case 'approval.request': {
      if (!event.approvalId || state.approvals.has(event.approvalId)) break;
      const approval = { ...event, kind: 'approval', requestKind: event.kind };
      state.approvals.set(event.approvalId, approval);
      state.records.set(`approval:${event.approvalId}`, approval);
      break;
    }
    case 'approval.resolved': {
      const approval = state.approvals.get(event.approvalId);
      if (approval) approval.done = event.decision === 'decline' ? '已拒绝' : '审批已处理';
      break;
    }
    case 'error':
      state.issue = failure(event.message || event.code);
      state.records.set(`error:${event.seq}`, { kind: 'system', text: state.issue });
      break;
  }
}

function readHistory(state, data) {
  const thread = data.thread || {};
  const turns = thread.turns ?? data.turns;
  const items = data.items;
  if (!Array.isArray(items) && !Array.isArray(turns)) throw new Error('bridge 未返回可恢复的任务历史');
  const previous = state.records;
  state.records = new Map();
  function textParts(content) {
    if (typeof content === 'string') return clean(content);
    return (Array.isArray(content) ? content : []).map(part => typeof part === 'string' ? clean(part) :
      part.type === 'text' ? clean(part.text ?? '') : part.type === 'image' || part.type === 'localImage' ? '[图片]' : '').filter(Boolean).join('\n');
  }
  function item(raw, turnId) {
    const entry = raw.item || raw;
    const key = entry.id || `${turnId}:${state.records.size}`;
    const ids = { itemId: key, turnId: raw.turnId || entry.turnId || turnId };
    switch (entry.type) {
      case 'userMessage':
      case 'user_message':
        if (entry.id) state.records.delete(`submitted:${ids.turnId}`);
        record(state, 'user', ids).text = textParts(entry.content ?? entry.text);
        break;
      case 'agentMessage':
      case 'agent_message':
        record(state, 'assistant', ids).text = textParts(entry.text ?? entry.content);
        break;
      case 'reasoning':
        record(state, 'reasoning', ids).text = textParts(entry.summary || entry.content);
        break;
      case 'fileChange': {
        const patch = (entry.changes || []).map(change => change.diff || change.patch).filter(Boolean).join('\n');
        if (patch) applyEvent(state, { type: 'diff', ...ids, patch });
        break;
      }
      case 'commandExecution':
      case 'mcpToolCall':
      case 'dynamicToolCall':
      case 'webSearch': {
        const tool = toolRecord(state, ids);
        tool.name = clean(entry.tool || entry.command || entry.type);
        tool.args = textValue(entry.command ?? entry.arguments ?? entry.query);
        tool.text = textValue(entry.aggregatedOutput ?? entry.result);
        tool.status = entry.status;
        tool.exitCode = entry.exitCode;
        break;
      }
    }
  }
  const seen = new Set();
  for (const turn of turns || []) {
    for (const raw of turn.items || []) {
      if (raw.id) seen.add(raw.id);
      item(raw, turn.id);
    }
    if (/^in.?progress$/i.test(turn.status || '')) {
      state.turnId = turn.id;
      state.busy = true;
    } else if (turn.id && turn.status) {
      state.terminated.add(turn.id);
      if (turn.id === state.turnId) {
        state.busy = state.pending = state.stopping = false;
        state.turnId = null;
      }
      const issue = turnIssue(turn);
      if (issue) state.records.set(`result:${turn.id}`, { kind: 'system', text: issue });
    }
  }
  for (const raw of items || []) if (!seen.has((raw.item || raw).id)) item(raw);
  const users = new Set([...state.records.values()].filter(value => value.kind === 'user').map(value => value.turnId || value.text));
  for (const [key, value] of previous) {
    if (state.records.has(key) || (value.kind === 'user' && users.has(value.turnId || value.text))) continue;
    state.records.set(key, value);
  }
  state.initialized = true;
}

function renderRecord(key, entry, state) {
  if (entry.kind === 'user') {
    const row = element('div', 'row me');
    row.append(element('div', 'bubble', entry.text));
    return row;
  }
  if (entry.kind === 'assistant') {
    const row = element('div', 'row agent');
    const bubble = element('div', `bubble${state.busy && (!entry.turnId || entry.turnId === state.turnId) ? ' streaming' : ''}`);
    const body = element('div', 'markdown');
    markdown(body, entry.text);
    bubble.append(element('div', 'agent-mark', '✳ Codex'), body);
    row.append(bubble);
    return row;
  }
  if (entry.kind === 'reasoning') {
    const node = element('details', 'think');
    node.dataset.key = key;
    node.open = [...log.querySelectorAll('details[open]')].some(current => current.dataset.key === key);
    node.append(element('summary', '', '推理'), element('div', 'body', entry.text));
    return node;
  }
  if (entry.kind === 'system') return element('div', 'sys', entry.text);
  if (entry.kind === 'approval') return renderApproval(entry, state);
  const card = element('section', 'card');
  const heading = element('div', 'hd');
  if (entry.kind === 'diff') {
    heading.append(element('span', 'name', '补丁'), element('span', 'tag', 'diff'));
    const box = element('div', 'diff');
    for (const line of entry.text.split('\n')) {
      const cls = /^(\+\+\+|---|@@|diff |index )/.test(line) ? 'hunk' : line[0] === '+' ? 'add' : line[0] === '-' ? 'del' : '';
      box.append(element('div', cls, line || ' '));
    }
    card.append(heading, box);
  } else {
    const failed = (entry.status && !/completed|success|^inProgress$/i.test(entry.status)) || !!entry.exitCode;
    const running = !entry.status || /^inProgress$/i.test(entry.status);
    heading.append(element('span', 'name', entry.name || '工具'), element('span', `tag ${failed ? 'bad' : running ? 'run' : 'ok'}`,
      failed ? (entry.exitCode ? `退出 ${entry.exitCode}` : `失败 · ${entry.status}`) : running ? '运行中' : '完成'));
    card.append(heading);
    if (entry.args) card.append(element('pre', '', entry.args));
    if (entry.text) card.append(element('pre', 'out', entry.text));
  }
  return card;
}

function renderApproval(entry, state) {
  const card = element('section', 'approval');
  const label = /patch|fileChange/.test(entry.requestKind) ? '修改文件需要审批' : entry.requestKind === 'permissions' ? '权限请求' : '执行命令需要审批';
  card.append(element('div', 'hd', label));
  const payload = entry.payload || {};
  const description = [textValue(payload.command || payload.patch || payload.permissions), clean(payload.cwd || ''), clean(payload.reason || '')].filter(Boolean).join('\n');
  if (description) card.append(element('div', 'what', description));
  if (entry.done) card.append(element('div', 'done', entry.done));
  else {
    const actions = element('div', 'acts');
    for (const [decision, title] of [['accept', '批准'], ['acceptForSession', '本会话批准'], ['decline', '拒绝']]) {
      const button = element('button', decision === 'decline' ? 'no' : 'ok', title);
      button.disabled = entry.submitting || !connected;
      button.onclick = async () => {
        if (entry.submitting || entry.done) return;
        entry.submitting = true;
        renderLog();
        try {
          await api('approval', { approvalId: entry.approvalId, decision, threadId: state.id }, controller?.signal);
          entry.done = decision === 'decline' ? '已拒绝' : '已提交批准';
          entry.failure = '';
        } catch (error) { entry.failure = `审批提交失败：${failure(error)}`; }
        finally { entry.submitting = false; if (sameThread(active?.id, state.id)) renderLog(); }
      };
      actions.append(button);
    }
    card.append(actions);
    if (entry.failure) card.append(element('div', 'done', entry.failure));
  }
  return card;
}

let frame;
function renderLog(force = false) {
  if (frame != null) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    frame = null;
    const atBottom = force || log.scrollHeight - log.scrollTop - log.clientHeight < 100;
    const state = active && stateFor(active.id);
    const entries = state ? [...state.records] : [];
    log.replaceChildren(...(entries.length ? entries.map(([key, value]) => renderRecord(key, value, state)) : [welcome]));
    if (atBottom) log.scrollTop = log.scrollHeight;
    controls();
  });
}

function handleEvent(event, id) {
  const n = Number(event.seq ?? id);
  if (!Number.isSafeInteger(n) || n <= seq) return;
  if (n !== seq + 1 || event.code === 'GAP' || event.type === 'resync.required') {
    notice('实时消息有缺失。请重新打开任务读取 Codex 历史。');
  }
  seq = n;
  if (!event.threadId) {
    if (event.type === 'error' && event.code !== 'GAP') {
      notice(`Codex：${failure(event.message || event.code)}`);
      if (event.code === 'CODEX_EXIT') {
        connected = false;
        status('Codex 已退出', 'err');
        for (const state of states.values()) { state.pending = state.busy = state.stopping = false; }
        renderLog();
      }
    }
    if (event.type?.startsWith('account.')) void loadAccount();
    return;
  }
  if (pendingSelect && sameThread(pendingSelect.id, event.threadId)) pendingSelect.events.push(event);
  const state = stateFor(event.threadId);
  applyEvent(state, event);
  if (sameThread(active?.id, event.threadId)) {
    if (event.type === 'turn.end' && state.issue) notice(state.issue);
    renderLog();
  }
  if (event.type === 'turn.end' && !selecting) void refreshThreads(controller?.signal).catch(() => {});
}

async function consumeEvents(response, signal) {
  if (!response.body) throw new Error('浏览器无法读取事件流');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventId = '';
  let data = [];
  function line(value) {
    if (!value) {
      if (data.length) {
        try { handleEvent(JSON.parse(data.join('\n')), eventId); } catch { notice('收到无效的 Codex 事件'); }
      }
      data = [];
      eventId = '';
      return;
    }
    if (value.startsWith('id:')) eventId = value.slice(3).trim();
    if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /, ''));
  }
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
      }
    }
  } finally { reader.releaseLock(); }
}

function realHealth(health) {
  if (!health.ok || health.fake || health.mode !== 'app-server') throw new Error('此地址未运行真实 Codex App Server');
}

async function eventLoop(signal) {
  let delay = 500;
  let reconnect = false;
  while (!signal.aborted) {
    try {
      if (reconnect) {
        const health = await request('healthz', { signal, auth: false });
        realHealth(health);
        if (Number.isSafeInteger(health.seq) && health.seq < seq) {
          seq = health.seq;
          notice('Codex 已重启。请重新打开任务读取历史。');
        }
      }
      const response = await fetch(`${base}/api/events?after=${seq}`, {
        signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}`, 'X-Codex-Go-Token': token },
      });
      if (response.status === 401 || response.status === 403) {
        connected = false;
        status('Token 无效', 'err');
        notice('实时连接未授权，请检查设置中的设备 Token');
        controls();
        return;
      }
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
        throw new Error(`事件流不可用（HTTP ${response.status}）`);
      }
      if (signal.aborted) return;
      connected = true;
      status('本机已连接', 'on');
      controls();
      renderLog();
      delay = 500;
      reconnect = true;
      await consumeEvents(response, signal);
      if (!signal.aborted && connected) throw new Error('实时连接断开，将自动重连');
    } catch (error) {
      if (signal.aborted) return;
      connected = false;
      status('重连中', 'err');
      $('sidebarStatus').textContent = failure(error);
      controls();
      renderLog();
    }
    await new Promise(resolve => setTimeout(resolve, delay));
    delay = Math.min(12000, delay * 2);
  }
}

async function connect() {
  const current = ++generation;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  connected = false;
  controls();
  notice();
  if (!token) {
    status('等待 Token');
    renderSessions();
    return false;
  }
  status('连接中');
  try {
    const health = await request('healthz', { signal, auth: false });
    realHealth(health);
    await refreshThreads(signal);
    if (current !== generation) return false;
    seq = Number.isSafeInteger(health.seq) ? health.seq : 0;
    if (!cwd && health.cwd) { cwd = health.cwd; updateWorkspace(); }
    connected = true;
    status('本机已连接', 'on');
    renderSessions();
    controls();
    void eventLoop(signal);
    return true;
  } catch (error) {
    if (signal.aborted) return false;
    status('连接失败', 'err');
    notice(`未连接：${failure(error)}`);
    settingsMessage(`连接失败：${failure(error)}`, 'error');
    return false;
  }
}

async function createThread() {
  const data = await api('thread/create', { ...(cwd && { cwd }), ...(model && { model }), ...(provider && { provider }), approvalPolicy: $('approvalPolicy').value }, controller?.signal);
  const id = data.threadId ?? data.thread?.id;
  if (!id) throw new Error('bridge 未返回新任务 ID');
  active = { id, cwd: data.cwd || data.thread?.cwd || cwd, ...data.thread, title: data.thread?.name || '新任务' };
  stateFor(id).initialized = true;
  threads = [active, ...threads.filter(thread => !sameThread(thread.id, id))];
  updateHeading();
  renderSessions();
  renderLog(true);
  closeSidebar();
  return active;
}

async function newTask() {
  if (!connected || selecting) return;
  selecting = true;
  controls();
  notice();
  try { await createThread(); }
  catch (error) { notice(`新建任务失败：${failure(error)}`); }
  finally { selecting = false; controls(); }
}

async function selectThread(thread) {
  if (!connected || selecting) return;
  selecting = true;
  const selection = { id: thread.id, events: [] };
  pendingSelect = selection;
  controls();
  notice();
  try {
    const data = await api('thread/resume', { threadId: thread.id }, controller?.signal);
    const id = data.threadId ?? data.thread?.id;
    if (!sameThread(id, thread.id)) throw new Error('bridge 返回了其他任务');
    const state = stateFor(id);
    readHistory(state, data);
    // Events already applied to pre-resume state must only be restored where the snapshot lacks them.
    // The bridge can supply an exact event checkpoint when it has one.
    if (Number.isSafeInteger(data.seq)) {
      for (const event of selection.events) {
        if (event.seq <= data.seq || !sameThread(event.threadId, id)) continue;
        const kind = event.type.startsWith('text.') ? 'assistant' : event.type.startsWith('reasoning.') ? 'reasoning' : event.type.startsWith('tool.') ? 'tool' : null;
        if (kind && state.records.has(recordKey(kind, event))) continue;
        applyEvent(state, event);
      }
    }
    active = { ...thread, ...data.thread, ...data.cwd && { cwd: data.cwd }, id };
    updateHeading();
    renderSessions();
    renderLog(true);
    closeSidebar();
  } catch (error) { notice(`恢复任务失败：${failure(error)}`); }
  finally { pendingSelect = null; selecting = false; controls(); }
}

async function send() {
  const message = input.value.trim();
  if (!message || !connected || selecting || (active && stateFor(active.id).busy)) return;
  selecting = true;
  controls();
  notice();
  let state;
  try {
    if (!active) await createThread();
    const thread = active;
    state = stateFor(thread.id);
    state.pending = true;
    controls();
    const text = contexts.length ? `${message}\n\n补充上下文：\n${contexts.join('\n\n')}` : message;
    const sent = await api('turn/send', {
      threadId: thread.id, text, reasoningEffort: $('effort').value, approvalPolicy: $('approvalPolicy').value,
      ...(model && { model }),
    }, controller?.signal);
    const turnId = sent.turnId ?? sent.turn?.id;
    if (!turnId) throw new Error('bridge 未返回任务运行 ID');
    const alreadySent = [...state.records.values()].some(entry => entry.kind === 'user' && entry.turnId === turnId);
    if (!alreadySent) {
      const row = { kind: 'user', turnId, text: clean(text) };
      const ordered = new Map();
      let inserted = false;
      for (const entry of state.records) {
        if (!inserted && entry[1].turnId === turnId) { ordered.set(`submitted:${turnId}`, row); inserted = true; }
        ordered.set(...entry);
      }
      if (!inserted) ordered.set(`submitted:${turnId}`, row);
      state.records = ordered;
    }
    if (!state.terminated.has(turnId)) { state.turnId = turnId; state.busy = true; }
    input.value = '';
    contexts = [];
    renderContexts();
    resizeInput();
    renderLog(true);
  } catch (error) { notice(`发送失败：${failure(error)}`); }
  finally { if (state) state.pending = false; selecting = false; controls(); }
}

async function stop() {
  if (!active) return;
  const state = stateFor(active.id);
  if (!state.turnId || state.stopping) return;
  const turnId = state.turnId;
  state.stopping = true;
  controls();
  try { await api('turn/interrupt', { threadId: state.id, turnId }, controller?.signal); }
  catch (error) {
    state.stopping = false;
    notice(`停止失败：${failure(error)}`);
    controls();
  }
}

function openSidebar() {
  $('sidebar').classList.add('open');
  $('scrim').hidden = false;
  $('scrim').classList.add('show');
  $('menu').setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('scrim').classList.remove('show');
  $('scrim').hidden = true;
  $('menu').setAttribute('aria-expanded', 'false');
}

function showDialog(id) {
  const dialog = $(id);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(id) {
  const dialog = $(id);
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

function openPath() {
  $('pathInput').value = cwd || active?.cwd || '';
  showDialog('pathDialog');
}

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(150, input.scrollHeight)}px`;
  controls();
}

function renderContexts() {
  $('contextChips').replaceChildren(...contexts.map((text, index) => {
    const chip = element('span', 'chip', text.length > 40 ? `${text.slice(0, 40)}…` : text);
    const button = element('button', '', '×');
    button.setAttribute('aria-label', '移除此上下文');
    button.onclick = () => { contexts.splice(index, 1); renderContexts(); };
    chip.append(button);
    return chip;
  }));
}

function settingConnection() {
  if (!connected) throw new Error('请先保存并连接到 bridge');
  if (normalizeBase($('connectionUrl').value.trim()) !== base || $('connectionToken').value.trim() !== token) {
    throw new Error('连接设置已修改，请先保存并连接');
  }
  return controller.signal;
}

function showConfig(data) {
  model = typeof data.model === 'string' ? data.model : '';
  provider = typeof data.provider === 'string' ? data.provider : '';
  $('model').value = model;
  $('provider').value = provider;
  $('providerUrl').value = typeof data.baseUrl === 'string' ? data.baseUrl : '';
  $('providerKey').value = '';
  $('providerKey').placeholder = data.apiKeyConfigured ? '已在主机配置，留空保留' : '主机未报告密钥，留空不修改';
}

async function loadConfig() {
  try {
    const signal = settingConnection();
    const data = await api('config', undefined, signal);
    showConfig(data);
    settingsMessage('已读取主机配置', 'success');
    try {
      const result = await api('models', undefined, signal);
      const models = result.models ?? result.data;
      $('models').replaceChildren(...(models || []).filter(item => item.id || item.model).map(item => {
        const option = element('option');
        option.value = item.id || item.model;
        option.label = item.displayName || item.name || option.value;
        return option;
      }));
    } catch (error) { settingsMessage(`已读取配置。模型列表不可用：${failure(error)}`, 'error'); }
  } catch (error) { settingsMessage(`读取配置失败：${failure(error)}`, 'error'); }
}

async function saveConfig() {
  const button = $('saveConfig');
  button.disabled = true;
  try {
    const signal = settingConnection();
    const apiKey = $('providerKey').value;
    const baseUrl = $('providerUrl').value.trim();
    const selectedModel = $('model').value.trim();
    const selectedProvider = $('provider').value.trim();
    const data = await api('config', {
      ...(selectedModel && { model: selectedModel }), ...(selectedProvider && { provider: selectedProvider }),
      ...(baseUrl && { baseUrl }), ...(apiKey && { apiKey }),
    }, signal);
    showConfig(data);
    settingsMessage('已保存主机模型配置', 'success');
  } catch (error) { settingsMessage(`保存配置失败：${failure(error)}`, 'error'); }
  finally { $('providerKey').value = ''; button.disabled = false; }
}

async function loadAccount() {
  try {
    const data = await api('account', undefined, settingConnection());
    if (!Object.hasOwn(data, 'account')) throw new Error('bridge 未返回账号状态');
    const account = data.account;
    $('accountStatus').textContent = account ? clean([account.type, account.email, account.planType].filter(Boolean).join(' · ') || '已登录')
      : data.requiresOpenaiAuth ? '需要登录 OpenAI 账号' : '未登录 Codex 账号';
  } catch (error) { $('accountStatus').textContent = `账号读取失败：${failure(error)}`; }
}

async function startLogin() {
  const button = $('startLogin');
  button.disabled = true;
  try {
    const result = await api('account/login/start', { type: 'chatgpt' }, settingConnection());
    const url = new URL(result.authUrl ?? result.authorizationUrl);
    if (url.protocol !== 'https:') throw new Error('bridge 未返回有效的 HTTPS 登录地址');
    const link = element('a', '', '打开 Codex 登录页面');
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    $('accountStatus').replaceChildren(link);
    settingsMessage('请在登录页面完成授权，然后读取账号状态。');
  } catch (error) { settingsMessage(`登录启动失败：${failure(error)}`, 'error'); }
  finally { button.disabled = false; }
}

function openSettings() {
  $('connectionUrl').value = base;
  $('connectionToken').value = token;
  $('cwd').value = cwd;
  $('model').value = model;
  $('provider').value = provider;
  $('providerKey').value = '';
  settingsMessage('');
  closeSidebar();
  showDialog('settings');
}

$('menu').onclick = openSidebar;
$('taskTop').onclick = () => {
  if (matchMedia('(max-width:720px)').matches) openSidebar();
  else { $('recent').focus(); $('recent').click(); }
};
$('scrim').onclick = $('closeSidebar').onclick = closeSidebar;
$('settingsButton').onclick = openSettings;
$('closeSettings').onclick = () => closeDialog('settings');
$('settings').addEventListener('close', () => { $('providerKey').value = ''; $('connectionToken').value = ''; });
$('settingsForm').onsubmit = async event => {
  event.preventDefault();
  try {
    const nextBase = normalizeBase($('connectionUrl').value.trim());
    const nextToken = $('connectionToken').value.trim();
    const destination = new URL(nextBase);
    if (destination.origin !== location.origin) {
      // The target bridge serves its own UI and uses a per-origin session token.
      // Never carry this page's device token across origins in a URL or request.
      location.assign(`${nextBase}/`);
      return;
    }
    if (!nextToken) throw new Error('请输入设备 Token');
    if (nextBase !== base || nextToken !== token) {
      active = null;
      states.clear();
      threads = [];
      model = provider = '';
      $('model').value = $('provider').value = $('providerUrl').value = '';
      $('providerKey').value = '';
      $('models').replaceChildren();
      $('accountStatus').textContent = '尚未读取账号状态';
      closeSidebar();
      renderLog(true);
    }
    base = nextBase;
    token = nextToken;
    cwd = $('cwd').value.trim();
    remember();
    updateHeading();
    if (await connect()) closeDialog('settings');
  } catch (error) { settingsMessage(failure(error), 'error'); }
};
$('loadConfig').onclick = loadConfig;
$('saveConfig').onclick = saveConfig;
$('loadAccount').onclick = loadAccount;
$('startLogin').onclick = startLogin;
for (const id of ['workspaceNav', 'workspaceTop', 'addWorkspace', 'projectPath']) $(id).onclick = openPath;
$('closePath').onclick = () => closeDialog('pathDialog');
$('pathForm').onsubmit = event => {
  event.preventDefault();
  cwd = $('pathInput').value.trim();
  if (active && active.cwd && active.cwd !== cwd) { active = null; renderLog(true); }
  updateHeading();
  renderSessions();
  controls();
  closeDialog('pathDialog');
};
$('contextButton').onclick = () => { $('contextInput').value = ''; showDialog('contextDialog'); };
$('closeContext').onclick = () => closeDialog('contextDialog');
$('contextForm').onsubmit = event => {
  event.preventDefault();
  const text = $('contextInput').value.trim();
  if (text) contexts.push(text);
  renderContexts();
  closeDialog('contextDialog');
};
$('recent').onclick = async () => {
  if (!connected) { openSettings(); return; }
  try { await refreshThreads(controller?.signal); }
  catch (error) { notice(`读取任务失败：${failure(error)}`); }
};
$('newTask').onclick = newTask;
$('send').onclick = send;
$('stop').onclick = stop;
$('dismissNotice').onclick = () => notice();
input.addEventListener('input', resizeInput);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    void send();
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeSidebar();
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !event.shiftKey) {
    event.preventDefault();
    void newTask();
  }
});
closeSidebar();
resizeInput();
void connect();
