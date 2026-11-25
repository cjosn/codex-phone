// Synthetic JSON-RPC test executable. This is NOT the official Codex CLI.
import { createInterface } from 'node:readline';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

if (!process.argv.includes('app-server')) throw Error('Fixture must be explicitly selected as an app-server executable');
const configPath = join(process.env.CODEX_HOME, 'synthetic-protocol-config.json');
const tracePath = process.env.CODEX_FIXTURE_TRACE;
const trace = value => { if (tracePath) appendFileSync(tracePath, JSON.stringify(value) + '\n'); };
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({ id, result });
const notify = (method, params) => send({ method, params });
const threads = new Map();
const approvals = new Map();
let threadCounter = 0, turnCounter = 0;
let config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : { model_provider: 'openai', model: 'synthetic-model', model_providers: {} };
function complete(threadId, turnId, failed = false) {
  const turn = { id: turnId, status: failed ? 'failed' : 'completed', items: [], error: failed ? { message: 'synthetic turn failure', codexErrorInfo: 'other', additionalDetails: null } : null };
  threads.get(threadId)?.turns.push(turn);
  if (failed) notify('error', { threadId, turnId, willRetry: false, error: turn.error });
  else {
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'synthetic-message', delta: `fixture reply ${threadId} 中文🙂` });
    notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { totalTokens: 4000, inputTokens: 3990, cachedInputTokens: 4, outputTokens: 10, reasoningOutputTokens: 1 }, last: { totalTokens: 19, inputTokens: 12, cachedInputTokens: 4, outputTokens: 7, reasoningOutputTokens: 1 }, modelContextWindow: 1000 } });
  }
  notify('turn/completed', { threadId, turn });
}
// 上游 404 的真实形状（实测 codex 0.170）：先几次 willRetry 的 Reconnecting，
// 最后是 willRetry:false 的错误 + status=failed 的 turn/completed。
function completeWithModel404(threadId, turnId) {
  const detail = 'unexpected status 404 Not Found: {"message":"模型不存在或未启用：synthetic-model","code":404}';
  const error = { message: detail, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 404 } }, additionalDetails: null, misalignment: null };
  notify('error', { threadId, turnId, willRetry: false, error });
  const turn = { id: turnId, status: 'failed', items: [], error };
  threads.get(threadId)?.turns.push(turn);
  notify('turn/completed', { threadId, turn });
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  try {
    const message = JSON.parse(line);
    if (!message.method) {
      trace({ kind: 'client-response', ...message });
      const approval = approvals.get(String(message.id));
      if (approval) { approvals.delete(String(message.id)); complete(approval.threadId, approval.turnId); }
      return;
    }
    trace({ kind: 'request', method: message.method, params: message.params });
    const { id, method, params = {} } = message;
    if (method === 'initialized') return;
    if (method === 'initialize') return reply(id, { userAgent: 'synthetic-protocol-fixture/0.170.0', platformFamily: 'test', platformOs: 'test' });
    if (method === 'config/read') return reply(id, { config, origins: {}, layers: null });
    if (method === 'config/batchWrite') {
      for (const edit of params.edits) {
        const keys = edit.keyPath.split('.');
        let target = config;
        for (const key of keys.slice(0, -1)) target = target[key] ??= {};
        target[keys.at(-1)] = edit.value;
      }
      writeFileSync(configPath, JSON.stringify(config));
      return reply(id, { status: 'ok', version: 'synthetic', filePath: configPath, overriddenMetadata: null });
    }
    if (method === 'mcpServerStatus/list') return reply(id, { data: Object.entries(config.mcp_servers ?? {}).map(([name, server]) => ({ name, tools: {}, resources: [], resourceTemplates: [] })), nextCursor: null });
    if (method === 'command/exec') {
      reply(id, {});
      notify('command/exec/outputDelta', { processId: params.processId, stream: 'stdout', deltaBase64: Buffer.from('synthetic workflow output').toString('base64') });
      notify('command/exec/terminated', { processId: params.processId, exitCode: 0 });
      return;
    }
    if (method === 'command/exec/terminate') return reply(id, {});
    if (method === 'model/list') return reply(id, { data: [{ id: 'synthetic-model', model: 'synthetic-model', displayName: 'Synthetic fixture', hidden: false, isDefault: true, description: 'Protocol fixture only', supportedReasoningEfforts: [], defaultReasoningEffort: 'medium', inputModalities: ['text'], supportsPersonality: false }], nextCursor: null });
    if (method === 'account/read') return reply(id, { account: null, requiresOpenaiAuth: false });
    if (method === 'account/login/start') return reply(id, { type: 'chatgpt', loginId: 'synthetic-login', authUrl: 'https://example.invalid/synthetic-login' });
    if (method === 'account/logout') return reply(id, {});
    if (method === 'thread/start') {
      const thread = { id: `fixture-thread-${++threadCounter}`, name: null, preview: '', cwd: params.cwd, turns: [], createdAt: 1, updatedAt: 1 };
      // codex 把 provider 绑在 thread 上：记下来，thread/start、thread/resume、thread/fork 都要回它。
      thread.modelProvider = params.modelProvider ?? config.model_provider ?? 'openai';
      thread.model = params.model ?? config.model ?? 'synthetic-model';
      threads.set(thread.id, thread); reply(id, { thread, model: thread.model, modelProvider: thread.modelProvider, cwd: params.cwd, approvalPolicy: 'on-request', sandbox: { type: 'readOnly' }, reasoningEffort: null });
      notify('thread/started', { thread }); return;
    }
    if (method === 'thread/list') return reply(id, { data: [...threads.values()], nextCursor: null });
    if (['thread/read', 'thread/resume'].includes(method)) {
      const thread = threads.get(params.threadId) ?? { id: params.threadId, turns: [], modelProvider: config.model_provider, model: config.model };
      return reply(id, { thread, model: thread.model, modelProvider: thread.modelProvider });
    }
    if (method === 'thread/fork') {
      const parent = threads.get(params.threadId);
      if (!parent) return send({ id, error: { code: -32602, message: 'thread/fork needs a known thread' } });
      const thread = { ...parent, id: `fixture-thread-${++threadCounter}`, turns: [...parent.turns], createdAt: 2, updatedAt: 2 };
      thread.modelProvider = params.modelProvider ?? parent.modelProvider;
      thread.model = params.model ?? parent.model;
      threads.set(thread.id, thread);
      reply(id, { thread, model: thread.model, modelProvider: thread.modelProvider });
      notify('thread/started', { thread }); return;
    }
    if (method === 'fs/readDirectory') {
      return reply(id, { entries: [{ fileName: 'fixture-entry.txt', isDirectory: false, isFile: true }, { fileName: 'fixture-dir', isDirectory: true, isFile: false }] });
    }
    if (['thread/name/set', 'thread/archive', 'thread/delete'].includes(method)) return reply(id, {});
    if (method === 'turn/interrupt') { reply(id, {}); complete(params.threadId, params.turnId); return; }
    if (method === 'thread/revert') { reply(id, {threadId: params.threadId, revertedTurns: 1}); return; }
    if (method === 'turn/start') {
      const turnId = `fixture-turn-${++turnCounter}`;
      const text = params.input?.filter(item => item.type === 'text').map(item => item.text).join(' ') ?? '';
      reply(id, { turn: { id: turnId, items: [], status: 'inProgress', error: null } });
      notify('turn/started', { threadId: params.threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } });
      setTimeout(() => {
        if (text.includes('retry-storm')) {
          // 只有「Reconnecting... n/5」噪音、没有进展：桥的看门狗不该被这些续命。
          for (let index = 1; index <= 3; index++) {
            setTimeout(() => notify('error', {
              threadId: params.threadId, turnId, willRetry: true,
              error: { message: `Reconnecting... ${index}/3`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } }, additionalDetails: null },
            }), index * 120);
          }
          return;
        }
        if (text.includes('model-missing')) { completeWithModel404(params.threadId, turnId); return; }
        if (text.includes('elicitation')) {
          const requestId = `fixture-elicitation-${turnId}`;
          approvals.set(requestId, { threadId: params.threadId, turnId });
          send({ id: requestId, method: 'mcpServer/elicitation/request', params: { threadId: params.threadId, turnId, serverName: 'phone', request: { mode: 'form', message: 'Allow the plan tool to run?', requestedSchema: { type: 'object', properties: {} } } } });
        } else if (text.includes('approval')) {
          const requestId = `fixture-approval-${turnId}`;
          approvals.set(requestId, { threadId: params.threadId, turnId });
          send({ id: requestId, method: 'item/commandExecution/requestApproval', params: { threadId: params.threadId, turnId, itemId: `command-${turnId}`, command: 'echo synthetic', cwd: process.cwd(), reason: 'Synthetic approval test', availableDecisions: ['accept', 'decline', 'cancel'] } });
          if (text.includes('stale-approval')) complete(params.threadId, turnId);
        } else if (!text.includes('hold')) complete(params.threadId, turnId, text.includes('fail'));
      }, 30);
      return;
    }
    if (id !== undefined) send({ id, error: { code: -32601, message: `Synthetic fixture does not implement ${method}` } });
  } catch (error) { process.stderr.write(`Synthetic fixture error: ${error.message}\n`); }
});
