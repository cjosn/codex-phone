// fake-codex.mjs — 模拟 `codex app-server`（JSON-RPC 2.0 over stdio，一行一条）
//
// 目的：在你还没装 codex、或不想让它真跑命令的机器上，把整条链路（手机 → bridge
// → codex）先跑通。它演的剧本是一条完整的 turn：
//   推理片段 → 文本增量 → 起一个命令工具 → 请求审批 → 收到批准后出结果 → turn 结束
//
// 它刻意模仿 app-server 的形状（方法名/通知形状都是"最像真货"的那种），
// 所以 adapter.mjs 对它的映射逻辑与真 codex 是同一套。真 codex 对不上时，
// 拿这里的形状跟真事件对比，改 adapter 即可。

import readline from 'node:readline';

const log = (...a) => process.stderr.write(`[fake-codex] ${a.join(' ')}\n`);

let nextThread = 1;
const threads = new Map();
const pendingApprovals = new Map();   // requestId -> {resolve}（支持多轮并发，真 app-server 也是并发）

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}
function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runTurn({ threadId, text, turnId }) {
  const itemId = `msg_${Date.now()}`;

  notify('item/reasoningDelta', { threadId, turnId, item: { id: `${itemId}_r`, type: 'reasoning', text: '先看清楚要做什么，再决定用哪个工具。' } });
  await sleep(120);

  const chunks = [
    '收到：' + String(text).slice(0, 60),
    '\n我来跑一下测试确认现状。',
  ];
  for (const c of chunks) {
    notify('item/textDelta', { threadId, turnId, item: { id: itemId, type: 'agent_message', text: c } });
    await sleep(150);
  }

  // 工具：一条命令
  const cmdId = `call_${Date.now()}`;
  notify('item/started', {
    threadId, turnId,
    item: { id: cmdId, type: 'exec_command', command: 'npm test -- --runInBand', phase: 'started' },
  });
  await sleep(200);

  // 请求审批（server→client request：带 id，等客户端回 result）
  const requestId = 900 + Math.floor(Math.random() * 90);
  notify('item/requestApproval', {
    threadId, turnId,
    approvalId: `ap_${requestId}`,
    command: 'npm test -- --runInBand',
    item: { id: cmdId, type: 'exec_command' },
  });
  send({
    jsonrpc: '2.0', id: requestId, method: 'exec/requestApproval',
    params: { threadId, turnId, approvalId: `ap_${requestId}`, command: 'npm test -- --runInBand' },
  });

  // 等批准（最多 60s）
  const decision = await new Promise((resolve) => {
    const t = setTimeout(() => { pendingApprovals.delete(requestId); resolve('timeout'); }, 60000);
    pendingApprovals.set(requestId, (d) => { clearTimeout(t); pendingApprovals.delete(requestId); resolve(d); });
  });

  if (decision === 'decline') {
    notify('item/updated', {
      threadId, turnId,
      item: { id: cmdId, type: 'exec_command', command: 'npm test -- --runInBand', aggregated_output: '已取消（用户拒绝）', exit_code: null, phase: 'completed' },
    });
  } else if (decision === 'timeout') {
    notify('turn/completed', { threadId, turnId, status: 'interrupted' });
    return;
  } else {
    notify('item/updated', {
      threadId, turnId,
      item: {
        id: cmdId, type: 'exec_command', command: 'npm test -- --runInBand',
        aggregated_output: 'PASS  src/adapter.test.mjs\nPASS  src/server.test.mjs\n\nTests: 12 passed, 12 total',
        exit_code: 0, phase: 'completed',
      },
    });
    await sleep(150);
    // 再来一个补丁 item，让手机端能渲染 diff
    const patchId = `patch_${Date.now()}`;
    notify('item/completed', {
      threadId, turnId,
      item: {
        id: patchId, type: 'apply_patch',
        patch: [
          'diff --git a/src/server.mjs b/src/server.mjs',
          'index 1a2b3c4..5d6e7f8 100644',
          '--- a/src/server.mjs',
          '+++ b/src/server.mjs',
          '@@ -10,3 +10,4 @@',
          ' export function handle(req) {',
          '-  return oldWay(req);',
          '+  return newWay(req);',
          '+  // 顺手补一条注释',
          ' }',
        ].join('\n'),
      },
    });
    await sleep(150);
    notify('item/textDelta', { threadId, turnId, item: { id: itemId, type: 'agent_message', text: '\n全绿。要不要我把改动也提交了？' } });
  }

  notify('turn/completed', {
    threadId, turnId, status: 'completed',
    usage: { inputTokens: 1820, outputTokens: 260, cachedInputTokens: 512 },
  });
}

// ------------------------------------------------------------------ main loop
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { log('bad json:', t.slice(0, 80)); return; }

  // 客户端对我们发起的请求的应答（审批）
  if (msg.id != null && msg.method === undefined) {
    const p = pendingApprovals.get(msg.id);
    if (p) {
      const d = msg.result?.decision ?? 'decline';
      log('approval response:', d);
      p(d);
    } else {
      log('unmatched response id', msg.id);
    }
    return;
  }

  const { id, method, params = {} } = msg;
  log('→', method);

  switch (method) {
    case 'initialize':
      respond(id, { userAgent: 'fake-codex/0.1.0', capabilities: { threadStart: true, turnStart: true, approvals: true } });
      return;
    case 'thread/start': {
      const threadId = `t_${nextThread++}`;
      threads.set(threadId, { cwd: params.cwd || params.workingDirectory || process.cwd() });
      respond(id, { threadId, thread: { id: threadId, cwd: threads.get(threadId).cwd } });
      return;
    }
    case 'thread/list':
      respond(id, { threads: [...threads].map(([tid, v]) => ({ id: tid, title: `会话 ${tid}`, cwd: v.cwd, updatedAt: Date.now() })) });
      return;
    case 'thread/resume':
      respond(id, { threadId: params.threadId });
      return;
    case 'turn/start': {
      const threadId = params.threadId || [...threads.keys()][0] || 't_1';
      const text = params.input?.[0]?.text ?? params.items?.[0]?.text ?? params.text ?? '';
      const turnId = `turn_${Date.now()}`;
      respond(id, { turnId });
      setTimeout(() => { runTurn({ threadId, text, turnId }).catch((e) => log('runTurn error', e.message)); }, 30);
      return;
    }
    case 'turn/interrupt':
      notify('turn/completed', { threadId: params.threadId, status: 'interrupted' });
      respond(id, { ok: true });
      return;
    default:
      error(id, -32601, `method not found: ${method}`);
  }
});

process.stdin.on('end', () => process.exit(0));
log('ready');
