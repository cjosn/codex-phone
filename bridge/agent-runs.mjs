// Parallel observation of subagent runs. Existing subagent/run results remain unchanged.
import {randomUUID} from 'node:crypto';

const terminal = state => state === 'done' || state === 'failed';
const normalizedState = state => /^(done|completed|success)$/i.test(state ?? '') ? 'done' : 'failed';
const bytes = text => Buffer.byteLength(text, 'utf8');

export function redactAgentText(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/([?&](?:access_token|refresh_token|token|api[_-]?key|key|authorization)=)[^&#\s"'<>]*/gi, '$1[REDACTED]')
    .replace(/((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|cookie)["']?)\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1"[REDACTED]"');
}

function clip(text, limit) {
  if (bytes(text) <= limit) return {text, truncated: false};
  const suffix = '\n[truncated: 内容超过日志限额]';
  const room = Math.max(0, limit - bytes(suffix));
  let prefix = Buffer.from(text).subarray(0, room).toString('utf8');
  if (prefix.endsWith('\ufffd')) prefix = prefix.slice(0, -1);
  return {text: prefix + suffix, truncated: true};
}
const safe = (value, limit = 4096) => value == null ? null : clip(redactAgentText(value), limit).text;

export class AgentRunRegistry {
  constructor({emit = () => {}, now = Date.now, maxCompleted = 100, maxLogBytes = 65536, onChange = null} = {}) {
    this.emit = emit;
    this.now = now;
    this.maxCompleted = Math.max(0, Math.floor(maxCompleted));
    this.maxLogBytes = Math.max(256, Math.floor(maxLogBytes));
    this.onChange = typeof onChange === 'function' ? onChange : null;
    this.runs = new Map();
    this.threads = new Map();
    // 子会话 id 要长期记住：完成后路由表会清空，但历史列表仍必须排除它。
    this.subagentThreads = new Set();
    this.version = 0;
  }

  view() {
    return {boardVersion: this.version, agents: [...this.runs.values()].map(run => this.snapshot(run))};
  }

  // Restart-safe history: only finished/failed/queued runs are meaningful after
  // a restart; a "running" run lost its live turn and is reported honestly as failed.
  restore(state) {
    if (!state || !Array.isArray(state.agents)) return 0;
    let restored = 0;
    for (const agent of state.agents) {
      if (!agent?.agentId || this.runs.has(agent.agentId)) continue;
      const run = {
        agentId: agent.agentId, revision: Number(agent.revision) || 1,
        name: safe(agent.name ?? 'Subagent', 200), role: safe(agent.role, 200), task: safe(agent.task ?? ''),
        state: agent.state === 'running' ? 'failed' : agent.state,
        parentId: agent.parentId ?? null, parentThreadId: agent.parentThreadId ?? null,
        agentThreadId: agent.agentThreadId ?? null,
        queuedAt: agent.queuedAt ?? null, startedAt: agent.startedAt ?? null, endedAt: agent.endedAt ?? this.now(),
        error: agent.state === 'running' ? '该子 Agent 在桥重启前仍在运行，原回合已中断' : (agent.error ?? null),
        logs: Array.isArray(agent.logs) ? agent.logs.slice(-500) : [], logBytes: 0,
        droppedLogs: Number(agent.droppedLogs) || 0, droppedBytes: Number(agent.droppedBytes) || 0,
        nextSeq: (Array.isArray(agent.logs) && agent.logs.length ? Math.max(...agent.logs.map(log => Number(log.seq) || 0)) : 0) + 1,
      };
      run.logBytes = run.logs.reduce((sum, log) => sum + bytes(JSON.stringify(log)), 0);
      this.runs.set(run.agentId, run);
      if (run.agentThreadId) this.threads.set(run.agentThreadId, run.agentId);
      if (run.agentThreadId) this.subagentThreads.add(run.agentThreadId);
      restored++;
    }
    if (restored) this.onChange?.(this.view());
    return restored;
  }

  changed() { this.onChange?.(this.view()); }

  queue(meta = {}) {
    const agentId = meta.agentId ?? `agent-${randomUUID()}`;
    if (this.runs.has(agentId)) throw new Error(`Agent already exists: ${agentId}`);
    const run = {
      agentId, revision: 1, name: safe(meta.name ?? meta.title ?? 'Subagent', 200), role: safe(meta.role, 200),
      task: safe(meta.task ?? meta.prompt ?? ''), state: 'queued',
      parentId: meta.parentId ?? null, parentThreadId: meta.parentThreadId ?? null,
      agentThreadId: null, queuedAt: this.now(), startedAt: null, endedAt: null, error: null,
      logs: [], logBytes: 0, droppedLogs: 0, droppedBytes: 0, nextSeq: 1,
    };
    this.runs.set(agentId, run);
    this.status(run);
    return this.snapshot(run);
  }

  start(agentId, {threadId} = {}) {
    const run = this.runs.get(agentId);
    if (!run || terminal(run.state)) return null;
    if (!threadId) throw new Error('start requires the actual agent threadId');
    if (run.agentThreadId) this.threads.delete(run.agentThreadId);
    run.agentThreadId = threadId;
    this.threads.set(threadId, agentId);
    this.subagentThreads.add(threadId);
    run.revision++;
    run.state = 'running';
    run.startedAt ??= this.now();
    this.status(run);
    return this.snapshot(run);
  }

  accept(event) {
    const run = this.runs.get(this.threads.get(event?.threadId));
    if (!run || terminal(run.state)) return false;
    const type = event.type;
    if (type !== 'text.delta' && type !== 'reasoning.delta' && !type?.startsWith('tool.')) return false;
    const text = type === 'tool.start'
      ? [event.name, event.args == null ? '' : redactAgentText(event.args)].filter(Boolean).join('\n')
      : event.text ?? event.chunk ?? event.delta ?? (type === 'tool.end' ? event.status ?? 'completed' : '');
    const clipped = clip(redactAgentText(text), Math.min(8192, this.maxLogBytes - 160));
    const log = {
      seq: run.nextSeq++, at: this.now(), type,
      level: type === 'reasoning.delta' ? 'reasoning' : type.startsWith('tool.') ? 'tool' : 'text',
      text: clipped.text, truncated: clipped.truncated,
      ...(event.itemId == null ? {} : {itemId: safe(event.itemId, 100)}),
      ...(event.name == null ? {} : {name: safe(event.name, 200)}),
      ...(event.status == null ? {} : {status: safe(event.status, 100)}),
      ...(event.replace === true ? {replace: true} : {}),
    };
    // Count the full encoded entry, so floods of tiny events are bounded too.
    const size = bytes(JSON.stringify(log));
    // Name/item metadata can push a single entry over the cap. Keep the visible notice.
    if (size > this.maxLogBytes) {
      delete log.name; delete log.itemId; delete log.status;
      const overhead = bytes(JSON.stringify({...log, text: '', truncated: true}));
      const shortened = clip(log.text, this.maxLogBytes - overhead);
      log.text = shortened.text;
      log.truncated ||= shortened.truncated;
      while (bytes(JSON.stringify(log)) > this.maxLogBytes) {
        const overflow = bytes(JSON.stringify(log)) - this.maxLogBytes;
        log.text = clip(log.text, bytes(log.text) - overflow).text;
        log.truncated = true;
      }
    }
    run.logs.push(log);
    run.logBytes += bytes(JSON.stringify(log));
    while (run.logBytes > this.maxLogBytes && run.logs.length > 1) {
      const removed = run.logs.shift();
      const removedBytes = bytes(JSON.stringify(removed));
      run.logBytes -= removedBytes;
      run.droppedLogs++;
      run.droppedBytes += removedBytes;
    }
    run.revision++;
    this.publish({type: 'agent.log', ...this.route(run), revision: run.revision, log: structuredClone(log),
      firstSeq: run.logs[0]?.seq ?? run.nextSeq, droppedLogs: run.droppedLogs, droppedBytes: run.droppedBytes,
      level: log.level, text: log.text});
    return true;
  }

  finish(agentId, {state = 'done', error = null} = {}) {
    const run = this.runs.get(agentId);
    if (!run || terminal(run.state)) return null;
    run.revision++;
    run.state = normalizedState(state);
    run.endedAt = this.now();
    run.error = safe(error?.message ?? error ?? (state === 'timeout' ? 'Subagent timed out' : null));
    if (run.agentThreadId) this.threads.delete(run.agentThreadId);
    this.status(run);
    const completed = [...this.runs.values()].filter(run => terminal(run.state));
    while (completed.length > this.maxCompleted) {
      const removed = completed.shift();
      this.runs.delete(removed.agentId);
      this.publish({type: 'agent.removed', ...this.route(removed), reason: 'completed-limit'});
    }
    return this.snapshot(run);
  }

  publish(event) {
    this.emit({...event, boardVersion: ++this.version});
    this.changed();
  }
  route(run) {
    return {agentId: run.agentId, threadId: run.parentThreadId,
      parentThreadId: run.parentThreadId, agentThreadId: run.agentThreadId};
  }
  snapshot(run, logs = true) {
    const {nextSeq, logs: entries, ...meta} = run;
    return structuredClone({...meta, ...(logs ? {logs: entries} : {})});
  }
  status(run) {
    this.publish({type: 'agent.status', ...this.snapshot(run, false), ...this.route(run)});
  }
  tree({parentThreadId} = {}) {
    const agents = [...this.runs.values()]
      .filter(run => parentThreadId === undefined || run.parentThreadId === parentThreadId)
      .map(run => this.snapshot(run));
    const ids = new Set(agents.map(run => run.agentId));
    return {boardVersion: this.version, agents, roots: agents.filter(run => !ids.has(run.parentId)).map(run => run.agentId)};
  }
}
