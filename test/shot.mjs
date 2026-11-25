// shot.mjs — 用 Edge 的 CDP 截一张手机尺寸的图（不依赖任何第三方包）
//
// 为什么不用 `--screenshot`：我们的页面有一条常驻 SSE，headless 的
// --virtual-time-budget 会一直等网络空闲，永远不返回。所以这里开 CDP，
// 等够真实时间，再 Page.captureScreenshot。
//
// 用法：node test/shot.mjs <url> <out.png> [waitMs] [width] [height]

import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const [url, out, waitMsArg, wArg, hArg] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node shot.mjs <url> <out.png> [waitMs] [width] [height]');
  process.exit(2);
}
const waitMs = Number(waitMsArg || 7000);
const W = Number(wArg || 430), H = Number(hArg || 932);
const PORT = 19222 + Math.floor(Math.random() * 300);
const EDGE = process.env.EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const profile = path.join(process.env.TEMP || '.', `codex-go-shot-${Date.now()}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitCdp(ms = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {}
    await sleep(150);
  }
  throw new Error('CDP 没起来');
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error('ws error')); });
    const c = new Cdp(ws);
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.id && c.pending.has(msg.id)) {
        const { res, rej } = c.pending.get(msg.id); c.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
        return;
      }
      // 页面侧日志/异常/网络错误：截图没问题但页面没动静时，全靠这里定位
      if (msg.method === 'Runtime.consoleAPICalled') {
        c.events.push('console.' + msg.params.type + ': ' + msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        c.events.push('EXCEPTION: ' + (d.exception?.description || d.text));
      } else if (msg.method === 'Log.entryAdded') {
        c.events.push('log.' + msg.params.entry.level + ': ' + msg.params.entry.text);
      } else if (msg.method === 'Network.loadingFailed') {
        c.events.push('netfail: ' + msg.params.errorText);
      }
    };
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`timeout ${method}`)); }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

const edge = spawn(EDGE, [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, url,
], { stdio: 'ignore', windowsHide: true });

let cdp;
try {
  await waitCdp();
  // 直接复用启动时打开的那个标签页：不新建、不 navigate。
  // （之前用 about:blank + Page.navigate 会留下两个 page target，
  //  demo 在其中一个里跑、截图截的却是另一个，表现就是"永远只有停止按钮"）
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page' && /^https?:/.test(t.url || ''));
    if (!target) await sleep(150);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error('拿不到 page target');

  cdp = await Cdp.open(target.webSocketDebuggerUrl);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await sleep(waitMs);

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await mkdir(path.dirname(path.resolve(out)), { recursive: true });
  await writeFile(out, Buffer.from(data, 'base64'));
  console.log('saved', out);

  // 顺手把渲染后的正文抠出来，便于无图也能核对
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: 'document.body.innerText.slice(0, 1200)', returnByValue: true,
  });
  console.log('--- body text ---');
  console.log(result.value || '(empty)');

  if (cdp.events.length) {
    console.log('--- page log ---');
    for (const e of cdp.events.slice(-25)) console.log('  ' + e);
  }
} catch (e) {
  console.error('shot failed:', e.message);
  process.exitCode = 1;
} finally {
  cdp?.close();
  try { edge.kill(); } catch {}
}
