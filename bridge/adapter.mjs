// Strict adapter for the official Codex app-server 0.170.0 notification surface.
// Schema source: openai/codex rust-v0.170.0, app-server-protocol/schema/json.

const TOOL_TYPES = new Set([
  'commandExecution', 'mcpToolCall', 'dynamicToolCall', 'webSearch',
  'imageGeneration', 'collabAgentToolCall', 'fileChange', 'functionCallOutput',
]);

const asText = (value) => value == null ? null : (typeof value === 'string' ? value : JSON.stringify(value));

function emit(type, params, fields = {}) {
  const out = { type, ...fields };
  if (params.threadId != null) out.threadId = String(params.threadId);
  if (params.turnId != null) out.turnId = String(params.turnId);
  return out;
}

export function normalize(method, params = {}, ctx = {}) {
  const p = params && typeof params === 'object' ? params : {};
  const threadId = p.threadId ?? p.thread?.id ?? ctx.threadId ?? null;
  const turnId = p.turnId ?? p.turn?.id ?? ctx.turnId ?? null;
  const base = { ...p, ...(threadId == null ? {} : { threadId }), ...(turnId == null ? {} : { turnId }) };
  const item = p.item ?? null;
  const itemId = p.itemId ?? item?.id ?? null;
  const type = item?.type ?? '';
  const events = [];
  const add = (name, fields = {}) => events.push(emit(name, base, fields));

  switch (method) {
    case 'thread/started':
      add('thread.started', { thread: p.thread });
      break;
    case 'turn/started':
      add('turn.start', { turnId: p.turn?.id ?? turnId, status: p.turn?.status ?? 'inProgress' });
      break;
    case 'turn/completed': {
      const turn = p.turn ?? {};
      // 0.170 can include a finished local command only in the final turn
      // snapshot, without a separate item/completed notification.
      for (const item of Array.isArray(turn.items) ? turn.items : []) {
        if (item?.type === 'commandExecution' && item.id) {
          events.push(...normalize('item/completed', {threadId, turnId: turn.id ?? turnId, item}));
        }
      }
      add('turn.end', {
        turnId: turn.id ?? turnId,
        status: turn.status ?? (turn.error ? 'failed' : 'completed'),
        usage: turn.usage ?? null,
        error: turn.error ?? null,
      });
      break;
    }
    case 'item/agentMessage/delta':
      add('text.delta', { itemId, text: asText(p.delta) ?? '' });
      add('item.delta', { itemId, itemType: type || 'agentMessage', field: 'text', delta: asText(p.delta) ?? '' });
      break;
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
      add('reasoning.delta', { itemId, text: asText(p.delta) ?? '' });
      add('item.delta', { itemId, itemType: 'reasoning', field: 'summary', delta: asText(p.delta) ?? '' });
      break;
    case 'item/commandExecution/outputDelta':
      add('tool.output', { itemId, chunk: asText(p.delta) ?? '' });
      add('item.delta', { itemId, itemType: 'commandExecution', field: 'output', delta: asText(p.delta) ?? '' });
      break;
    case 'item/fileChange/outputDelta':
      add('tool.output', { itemId, chunk: asText(p.delta) ?? '' });
      break;
    case 'item/fileChange/patchUpdated': {
      const changes = Array.isArray(p.changes) ? p.changes : [];
      const patch = changes.map(change => change?.diff).filter(value => typeof value === 'string').join('\n');
      add('diff', { itemId, patch, changes, replace: true });
      break;
    }
    case 'item/started': {
      // 过程流（「过程流改造方案」P1）：item 一出现就先画一行，带上协议给的真实开始时间。
      // 旧的 tool.start 仍然发，保证没升级的客户端不受影响。
      const startedAtMs = Number.isFinite(p.startedAtMs) ? p.startedAtMs : null;
      add('item.start', {
        itemId,
        itemType: type || null,
        name: item?.tool ?? item?.server ?? item?.command ?? null,
        startedAtMs,
      });
      if (item && TOOL_TYPES.has(type)) {
        add('tool.start', {
          itemId: item.id,
          name: item.tool ?? item.server ?? item.command ?? type,
          args: item.arguments ?? item.command ?? item,
        });
      }
      break;
    }
    case 'item/completed': {
      // 过程流（P2）：收尾带上协议自己的 durationMs / status / exitCode，
      // 界面据此显示「读取 server.mjs · 0.2s ✓」，不用自己掐表。
      const statusText = typeof item?.status === 'string' ? item.status : 'completed';
      const okStatus = /completed|success|ok/i.test(statusText) || item?.exitCode === 0;
      add('item.end', {
        itemId,
        itemType: type || null,
        status: okStatus ? 'completed' : statusText,
        exitCode: Number.isInteger(item?.exitCode) ? item.exitCode : null,
        durationMs: Number.isFinite(item?.durationMs) ? item.durationMs : null,
      });
      if (item && TOOL_TYPES.has(type)) {
        if (type === 'fileChange') {
          const patch = item.changes?.map((c) => c.diff ?? c.patch).filter(Boolean).join('\n');
          if (patch) add('diff', { itemId: item.id, patch, changes: item.changes, replace: true });
        }
        if (type === 'commandExecution' && item.aggregatedOutput) {
          add('tool.output', { itemId: item.id, chunk: item.aggregatedOutput, replace: true });
        }
        if (type === 'mcpToolCall' && /^plan_(create|add_step|update_step|complete)$/.test(String(item.tool ?? ''))) {
          const plan = item.result?.structuredContent?.data?.plan ?? item.result?.structuredContent?.plan ?? item.result?.data?.plan ?? null;
          if (Array.isArray(plan?.steps)) {
            add('plan.updated', {
              steps: plan.steps.map(step => ({ step: step?.title ?? '', status: ({ done: 'completed', in_progress: 'inProgress' })[step?.status] ?? step?.status ?? 'pending' })),
              explanation: plan.summary ?? null,
            });
          }
        }
        const failed = item.status && !/completed|success/i.test(item.status);
        add('tool.end', {
          itemId: item.id,
          status: failed ? item.status : 'completed',
          exitCode: item.exitCode ?? null,
        });
      }
      break;
    }
    case 'command/exec/outputDelta':
      // 终端输出：base64 字节，由 App 解成文本写进 xterm。
      add('exec.output', {
        processId: p.processId,
        stream: p.stream ?? 'stdout',
        delta: p.deltaBase64 ?? '',
        capReached: p.capReached === true,
      });
      break;
    case 'turn/plan/updated':
      // Agent 的计划清单：每步有 step + status，UI 直接当 TODO 渲染。
      add('plan.updated', {
        steps: Array.isArray(p.plan)
          ? p.plan.map((s) => ({ step: s?.step ?? String(s), status: s?.status ?? null }))
          : [],
        explanation: p.explanation ?? null,
      });
      break;
    case 'thread/goal/updated':
      add('goal.updated', { goal: p.goal ?? null });
      break;
    case 'thread/status/changed':
      add('thread.status', { status: p.status ?? null });
      break;
    case 'turn/diff/updated':
      add('diff', { itemId: itemId ?? 'turn-diff', patch: asText(p.diff ?? p.patch ?? '') ?? '', replace: true });
      break;
    case 'item/mcpToolCall/progress':
      add('tool.output', { itemId, chunk: asText(p.message ?? p.delta ?? '') ?? '', replace: false });
      break;
    default:
      if (ctx.isRequest) return [approvalEvent(method, p, ctx, threadId, turnId)];
      if (ctx.verbose) add('unmapped', { method });
  }
  return events;
}

function approvalEvent(method, params, ctx, threadId, turnId) {
  const p = params ?? {};
  const kind = method.includes('fileChange') ? 'fileChange'
    : method.includes('permissions') ? 'permissions'
      : method.includes('elicitation') ? 'elicitation' : 'command';
  const payload = method.includes('fileChange')
    ? { reason: p.reason ?? null, itemId: p.itemId ?? null }
    : method.includes('permissions')
      ? { reason: p.reason ?? null, permissions: p.permissions ?? null }
      : method.includes('elicitation')
        ? { reason: p.request?.message ?? p.message ?? null, serverName: p.serverName ?? null }
      : { command: p.command ?? null, cwd: p.cwd ?? null, reason: p.reason ?? null };
  return {
    type: 'approval.request',
    approvalId: String(p.approvalId ?? `request:${ctx.requestId}`),
    kind,
    payload,
    itemId: p.itemId ?? null,
    threadId: threadId == null ? null : String(threadId),
    turnId: turnId == null ? null : String(turnId),
    _internal: { requestId: ctx.requestId, method },
  };
}
