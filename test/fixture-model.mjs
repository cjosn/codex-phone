// test/fixture-model.mjs — 本地合成 Responses 模型，用来在没有真 key 的情况下
// 验证「工具调用 / 思考链 / 补丁」在真机 UI 上到底渲染成什么样。
//
// 它说的是 codex app-server 认的 Responses SSE 协议（形状取自 test/codex-real-smoke.mjs
// 里已经对着真 codex 0.170.0 验过的那套）。
//
//   node test/fixture-model.mjs --port 8790
//
// 然后在 App 的「设置」里填：
//   Provider      OpenAI Compatible（或 openai）
//   Base URL      http://127.0.0.1:8790/v1
//   模型           gpt-5-codex
//   API Key       codex-fixture-only-key
//
// 配合 adb reverse，让手机 127.0.0.1:8790 打到电脑：
//   adb reverse tcp:8790 tcp:8790

import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

const PORT = Number(arg('port', '8790'));
const HOST = arg('host', '0.0.0.0');
const KEY = arg('key', 'codex-fixture-only-key');
const WITH_REASONING = !argv.includes('--no-reasoning');
const WITH_PATCH = !argv.includes('--no-patch');

const sse = (res, event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
const now = () => Math.floor(Date.now() / 1000);

function reasoningBlock(res, responseId, text) {
  // codex 0.170 的 Responses 里 reasoning 是独立 output_item，带 summary 数组。
  const id = 'rs_fixture';
  sse(res, {
    type: 'response.output_item.added',
    response_id: responseId,
    output_index: 0,
    item: { id, type: 'reasoning', summary: [] },
  });
  for (const piece of text.match(/.{1,18}/gs) ?? [text]) {
    sse(res, {
      type: 'response.reasoning_summary_text.delta',
      response_id: responseId,
      item_id: id,
      output_index: 0,
      summary_index: 0,
      delta: piece,
    });
  }
  sse(res, {
    type: 'response.reasoning_summary_text.done',
    response_id: responseId,
    item_id: id,
    output_index: 0,
    summary_index: 0,
    text,
  });
  sse(res, {
    type: 'response.reasoning_summary_part.done',
    response_id: responseId,
    item_id: id,
    output_index: 0,
    summary_index: 0,
    part: { type: 'summary_text', text },
  });
  sse(res, {
    type: 'response.output_item.done',
    response_id: responseId,
    output_index: 0,
    item: { id, type: 'reasoning', summary: [{ type: 'summary_text', text }] },
  });
}

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  if (!req.url?.startsWith('/v1/')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not the fixture' } }));
    return;
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'gpt-5-codex', object: 'model' }] }));
    return;
  }
  if (req.url !== '/v1/responses') {
    res.writeHead(404).end('{}');
    return;
  }
  const auth = req.headers.authorization ?? '';
  if (!auth.includes(KEY)) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'fixture key missing' } }));
    return;
  }

  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {}

  const input = JSON.stringify(body.input ?? '');
  const tools = body.tools ?? [];
  const cmdTool = tools.find((t) => t.name === 'exec_command') ?? tools.find((t) => t.name === 'shell_command');
  const patchTool = tools.find((t) => t.name === 'apply_patch');

  const ranCommand = (body.input ?? []).some(
    (item) => item.type === 'function_call_output' && String(item.output ?? '').includes('CODEX_GO_TOOL_OK'),
  );
  const appliedPatch = (body.input ?? []).some(
    (item) => item.type === 'function_call_output' && /patch|applied/i.test(String(item.output ?? '')),
  );

  console.log(
    `[fixture] responses  tools=${tools.map((t) => t.name).join(',')}  ranCommand=${ranCommand} appliedPatch=${appliedPatch}`,
  );

  const responseId = 'resp_' + Math.random().toString(36).slice(2, 8);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.flushHeaders?.();
  sse(res, {
    type: 'response.created',
    response: { id: responseId, object: 'response', created_at: now(), status: 'in_progress', model: 'gpt-5-codex', output: [] },
  });

  // 第一轮：先跑一条命令，让 UI 出工具卡
  if (cmdTool && input.includes('CODEX_GO_TOOL') === false && !ranCommand && input.includes('fixture')) {
    let outputIndex = 0;
    if (WITH_REASONING) {
      reasoningBlock(res, responseId, '先确认一下当前目录，再决定要不要改文件。');
      outputIndex = 1;
    }
    const args =
      cmdTool.name === 'exec_command'
        ? { cmd: 'echo CODEX_GO_TOOL_OK && ls -1 | head -5', yield_time_ms: 1000, max_output_tokens: 400 }
        : { command: 'echo CODEX_GO_TOOL_OK && ls -1 | head -5', timeout_ms: 10000 };
    const call = {
      type: 'function_call',
      id: 'fc_fixture_' + outputIndex,
      call_id: 'call_fixture_' + outputIndex,
      name: cmdTool.name,
      arguments: JSON.stringify(args),
      status: 'completed',
    };
    sse(res, { type: 'response.output_item.added', response_id: responseId, output_index: outputIndex, item: { ...call, arguments: '', status: 'in_progress' } });
    sse(res, { type: 'response.function_call_arguments.delta', response_id: responseId, output_index: outputIndex, item_id: call.id, delta: call.arguments });
    sse(res, { type: 'response.function_call_arguments.done', response_id: responseId, output_index: outputIndex, item_id: call.id, arguments: call.arguments });
    sse(res, { type: 'response.output_item.done', response_id: responseId, output_index: outputIndex, item: call });
    sse(res, { type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed', output: [call], usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21 } } });
    res.end('data: [DONE]\n\n');
    return;
  }

  // 第二轮：命令结果回来了，出一个补丁，让 UI 出 diff
  if (patchTool && ranCommand && !appliedPatch && WITH_PATCH) {
    const patch = [
      '*** Begin Patch',
      '*** Update File: fixture-note.txt',
      '@@',
      '-旧的一行',
      '+新的一行',
      '+再加一行注释',
      '*** End Patch',
    ].join('\n');
    const call = {
      type: 'function_call',
      id: 'fc_fixture_patch',
      call_id: 'call_fixture_patch',
      name: patchTool.name,
      arguments: JSON.stringify({ input: patch }),
      status: 'completed',
    };
    sse(res, { type: 'response.output_item.added', response_id: responseId, output_index: 0, item: { ...call, arguments: '', status: 'in_progress' } });
    sse(res, { type: 'response.function_call_arguments.done', response_id: responseId, output_index: 0, item_id: call.id, arguments: call.arguments });
    sse(res, { type: 'response.output_item.done', response_id: responseId, output_index: 0, item: call });
    sse(res, { type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed', output: [call], usage: { input_tokens: 20, output_tokens: 14, total_tokens: 34 } } });
    res.end('data: [DONE]\n\n');
    return;
  }

  // 默认：一段文本回答（分片流式，验证逐字效果）
  const text =
    '工具跑完了。\n\n' +
    '这是一个**合成模型**的回复：它只用来验证手机端能不能正确渲染思考链、工具卡和补丁，不代表真实模型质量。\n\n' +
    '```\nCODEX_GO_TOOL_OK\n```\n';
  const itemId = 'msg_fixture';
  sse(res, { type: 'response.output_item.added', response_id: responseId, output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
  sse(res, { type: 'response.content_part.added', response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
  for (const piece of text.match(/[\s\S]{1,12}/g) ?? []) {
    sse(res, { type: 'response.output_text.delta', response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, delta: piece });
    await new Promise((r) => setTimeout(r, 18));
  }
  sse(res, { type: 'response.output_text.done', response_id: responseId, item_id: itemId, output_index: 0, content_index: 0, text });
  sse(res, { type: 'response.output_item.done', response_id: responseId, output_index: 0, item: { id: itemId, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] } });
  sse(res, { type: 'response.completed', response: { id: responseId, object: 'response', created_at: now(), status: 'completed', model: 'gpt-5-codex', output: [], usage: { input_tokens: 30, output_tokens: 60, total_tokens: 90 } } });
  res.end('data: [DONE]\n\n');
});

server.listen(PORT, HOST, () => {
  console.log(`[fixture] http://${HOST}:${PORT}/v1   key=${KEY}`);
  console.log('[fixture] base URL 填这个地址；adb reverse tcp:' + PORT + ' tcp:' + PORT + ' 让手机够得着');
});
