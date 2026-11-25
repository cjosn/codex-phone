// 探针用上游：记录每个请求的 path/model/输入条数到 JSONL，并按 Responses 协议回一段最小 SSE。
// 第三个参数若给出，则「model 等于它」时回 404（模拟中转站「模型不存在或未启用」）。
// 用法：node test/fixture-upstream.mjs <port> <logPath> [rejectModel]
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const port = Number(process.argv[2]);
const logPath = process.argv[3];
const rejectModel = process.argv[4] ?? null;

const sendSse = (res, event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);

const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try { body = JSON.parse(raw); } catch { /* 保留原样 */ }
  const input = Array.isArray(body.input) ? body.input : [];
  appendFileSync(logPath, JSON.stringify({
    path: req.url,
    model: body.model ?? null,
    auth: req.headers.authorization ?? null,
    inputCount: input.length,
  }) + '\n');

  if (req.method !== 'POST' || !/\/v1\/responses$/.test(req.url ?? '')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'unexpected path' } }));
    return;
  }
  if (rejectModel && body.model === rejectModel) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: `模型不存在或未启用：${rejectModel}`, code: 404 }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', 'cache-control': 'no-cache' });
  res.flushHeaders?.();
  const message = { id: 'msg_probe', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'probe ok' }] };
  sendSse(res, { type: 'response.created', response: { id: 'resp_probe', object: 'response', created_at: 1, status: 'in_progress', model: body.model ?? 'probe', output: [] } });
  sendSse(res, { type: 'response.output_item.added', response_id: 'resp_probe', output_index: 0, item: { id: 'msg_probe', type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
  sendSse(res, { type: 'response.output_text.delta', response_id: 'resp_probe', item_id: 'msg_probe', output_index: 0, content_index: 0, delta: 'probe ok' });
  sendSse(res, { type: 'response.output_item.done', response_id: 'resp_probe', output_index: 0, item: message });
  sendSse(res, { type: 'response.completed', response: { id: 'resp_probe', object: 'response', created_at: 1, status: 'completed', model: body.model ?? 'probe', output: [message], usage: { input_tokens: 3, output_tokens: 3, total_tokens: 6 } } });
  res.end('data: [DONE]\n\n');
});

server.listen(port, '127.0.0.1', () => console.log(`fixture-upstream listening on ${port}`));
