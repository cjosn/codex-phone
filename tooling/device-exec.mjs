// tooling/device-exec.mjs — 在手机上（PRoot 里）跑一条命令并把输出打到电脑上。
// 用法: node tooling/device-exec.mjs <baseUrl> <token> "<command>"
// 原理: 桥的 /api/exec 是真 PTY（codex command/exec），输出是 base64 的 exec.output 事件。
const [base, token, command, timeoutMsArg] = process.argv.slice(2);
if (!base || !token || !command) {
  console.error('usage: node tooling/device-exec.mjs <baseUrl> <token> "<command>" [timeoutMs]');
  process.exit(2);
}
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const timeoutMs = Number(timeoutMsArg) || 60000;
const processId = `probe-${Date.now()}`;

const health = await (await fetch(`${base}/healthz`)).json();
const stream = await fetch(`${base}/api/events?after=${health.seq}`, { headers });
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let output = '';
let settled = false;

const sent = await fetch(`${base}/api/exec`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ processId, argv: ['/bin/bash', '-lc', command], rows: 40, cols: 200 }),
});
if (!sent.ok) {
  console.error('exec request failed', sent.status, await sent.text());
  process.exit(1);
}

const deadline = Date.now() + timeoutMs;
const timer = setInterval(() => {}, 1 << 30);
try {
  while (Date.now() < deadline) {
    const race = await Promise.race([
      reader.read(),
      new Promise(resolve => setTimeout(() => resolve({ timeout: true }), 250)),
    ]);
    if (race.timeout) continue;
    if (race.done) break;
    buffer += decoder.decode(race.value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const data = block.split('\n').find(line => line.startsWith('data: '));
      if (!data) continue;
      let event;
      try { event = JSON.parse(data.slice(6)); } catch { continue; }
      if (event.processId && event.processId !== processId) continue;
      if (event.type === 'exec.output') {
        output += Buffer.from(event.delta || '', 'base64').toString('utf8');
      }
      // 输出里出现我们的结束哨兵就收工，避免等满整段时间。
      if (output.includes('__DEVICE_EXEC_DONE__')) { settled = true; break; }
    }
    if (settled) break;
  }
} finally {
  clearInterval(timer);
  await fetch(`${base}/api/exec/terminate`, { method: 'POST', headers, body: JSON.stringify({ processId }) }).catch(() => {});
}

process.stdout.write(output);
process.exit(0);
