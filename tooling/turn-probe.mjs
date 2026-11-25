// 诊断：在电脑上通过 adb forward 订阅手机桥的 SSE，看一次 turn 到底发生了什么。
// 用法: node tooling/turn-probe.mjs <baseUrl> <token> <text>
const [base, token, text = 'reply with OK only', model] = process.argv.slice(2);
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

async function post(path, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const payload = await response.text();
  return { status: response.status, payload };
}

const health = await (await fetch(`${base}/healthz`)).json();
const created = await post('/api/thread/create', { cwd: '/root/workspace', ...(process.env.CODEX_PROBE_INSTRUCTIONS ? { developerInstructions: process.env.CODEX_PROBE_INSTRUCTIONS } : {}), ...(process.env.CODEX_PROBE_CONFIG ? { config: JSON.parse(process.env.CODEX_PROBE_CONFIG) } : {}) });
const threadId = JSON.parse(created.payload).threadId;
console.log('thread', threadId, 'seq', health.seq);

const controller = new AbortController();
const stream = await fetch(`${base}/api/events?after=${health.seq}&threadId=${threadId}`, { headers, signal: controller.signal });
console.log('sse status', stream.status);
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = '', answer = '', reasoning = '', planEvents = 0, diffEvents = 0, steerStatus = null, steering = false;
const timer = setTimeout(() => controller.abort(), 90000);

const sent = await post('/api/turn/send', { threadId, text, ...(model ? { model } : {}) });
console.log('turn/send', sent.status, sent.payload);

try {
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const dataLine = chunk.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(5).trim());
      if (event.type === 'text.delta') answer += event.text || '';
      if (event.type === 'reasoning.delta') reasoning += event.text || '';
      if (event.type === 'plan.updated') planEvents++;
      if (event.type === 'diff') diffEvents++;
      if (process.env.CODEX_PROBE_STEER && !steering && ['reasoning.delta', 'text.delta', 'tool.start'].includes(event.type)) {
        steering = true;
        const expectedTurnId = JSON.parse(sent.payload).turnId;
        const steered = await post('/api/turn/steer', { threadId, expectedTurnId, text: process.env.CODEX_PROBE_STEER });
        steerStatus = steered.status;
        console.log('STEER_RESULT ' + steered.status + ' ' + steered.payload);
      }
      const brief = { type: event.type, status: event.status, error: event.message || event.error?.message };
      if (['text.delta', 'reasoning.delta'].includes(event.type)) brief.length = (event.delta || event.text || '').length;
      if (process.env.CODEX_PROBE_QUIET !== '1') console.log(JSON.stringify(brief));
      if (event.type === 'turn.end' || event.type === 'error') {
        if (event.type === 'turn.end') {
          console.log('PROBE_RESULT ' + JSON.stringify({ status: event.status, answer, reasoningLength: reasoning.length, planEvents, diffEvents, steerStatus }));
          if (process.env.CODEX_PROBE_CLEANUP === '1') await post('/api/thread/delete', { threadId });
          clearTimeout(timer); controller.abort(); break;
        }
      }
    }
  }
} catch (error) {
  if (error.name !== 'AbortError') throw error;
} finally {
  clearTimeout(timer);
}
