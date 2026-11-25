// bridge/phone.mjs — 手机通道的命令行入口（MCP 工具没接进会话时的可靠兜底）。
//
// 为什么需要它：codex 0.170 在本机可以列出 121 个 MCP 工具（mcpServerStatus/list 有），
// 但模型侧拿不到任何 MCP 工具函数，只有 exec_command/write_stdin。于是屏幕读写只能走
// 「模型能执行命令」这条路。本文件把同一套设备通道端点包成一条命令，编号快照落在
// ${CODEX_HOME}/codex-go-screen.json，所以 screen 之后可以在另一条命令里 tap <编号>。
//
// 用法（在 PRoot 里，node 在 /opt/node/bin）：
//   node /opt/codex-go/bridge/phone.mjs screen
//   node /opt/codex-go/bridge/phone.mjs tap 3 --reason "open the third row"
//   node /opt/codex-go/bridge/phone.mjs type "hello" --submit --reason "fill the box"
//   node /opt/codex-go/bridge/phone.mjs key back --reason "leave this screen"
//   node /opt/codex-go/bridge/phone.mjs scroll down --reason "reveal later rows"
//   node /opt/codex-go/bridge/phone.mjs apps
//   node /opt/codex-go/bridge/phone.mjs open com.android.settings --reason "show settings"
//   node /opt/codex-go/bridge/phone.mjs collect --rounds 5 --reason "read the whole list"
//
// 退出码：0 成功；2 参数错；3 通道没开/握手缺失；4 设备侧拒绝（App 的 error.code 原样打印）。
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { screenText } from './toolpacks/android/screen-view.mjs';

const CODEX_HOME = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const HANDSHAKE = path.join(CODEX_HOME, 'codex-go-device.json');
const SNAPSHOT = path.join(CODEX_HOME, 'codex-go-screen.json');
const TIMEOUT_MS = Number(process.env.CODEX_GO_PHONE_TIMEOUT_MS) || 20000;

function die(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function handshake() {
  let raw;
  try {
    raw = await readFile(HANDSHAKE, 'utf8');
  } catch {
    die(3, 'The device channel is off: ' + HANDSHAKE + ' is missing. Open Codex Pocket -> Settings -> 手机能力 and turn the channel on.');
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    die(3, 'The device handshake file is not valid JSON; turn the channel off and on again in Codex Pocket.');
  }
  if (!value?.baseUrl || !value?.token) die(3, 'The device handshake has no baseUrl/token; turn the channel off and on again.');
  return { baseUrl: String(value.baseUrl).replace(/\/+$/, ''), token: String(value.token) };
}

async function call(endpoint, body) {
  const hs = await handshake();
  const init = {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${hs.token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`${hs.baseUrl}${endpoint}`, init);
  } catch (error) {
    die(3, `Cannot reach the phone channel (${error?.name === 'TimeoutError' ? 'timeout' : error?.cause?.code ?? error?.message}). Is Codex Pocket in the foreground with the channel on?`);
  }
  const raw = await response.text().catch(() => '');
  let value = {};
  try {
    value = raw ? JSON.parse(raw) : {};
  } catch {
    if (!response.ok) die(4, `The phone answered HTTP ${response.status} with a non-JSON body: ${raw.slice(0, 300)}`);
  }
  if (!response.ok) {
    const code = value?.error?.code ?? `HTTP ${response.status}`;
    const message = value?.error?.message ?? raw.slice(0, 300);
    die(4, `${code}: ${message}`);
  }
  return value;
}

async function saveSnapshot(snapshot) {
  await mkdir(CODEX_HOME, { recursive: true, mode: 0o700 });
  const temporary = `${SNAPSHOT}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(temporary, SNAPSHOT);
}

async function loadSnapshot() {
  try {
    return JSON.parse(await readFile(SNAPSHOT, 'utf8'));
  } catch {
    return null;
  }
}

async function capture() {
  const dump = await call('/ui/dump', { includeInvisible: false, maxNodes: 1500 });
  const screenId = `s${Date.now().toString(36)}`;
  const view = screenText(dump, { screenId });
  const size = (Array.isArray(dump?.screens) ? dump.screens[0] : null) || {};
  const snapshot = {
    screenId,
    elements: view.elements,
    truncated: view.truncated || dump?.truncated === true,
    width: Number(size.width) || 1080,
    height: Number(size.height) || 2400,
  };
  await saveSnapshot(snapshot);
  return { ...snapshot, text: view.text };
}

function printScreen(view, extra = '') {
  if (extra) process.stdout.write(`${extra}\n`);
  process.stdout.write(`${view.text}\n`);
}

// --- 参数解析 ---------------------------------------------------------------
const argv = process.argv.slice(2);
const command = argv[0];
const positional = [];
const flags = {};
for (let index = 1; index < argv.length; index++) {
  const token = argv[index];
  if (token === '--submit') { flags.submit = true; continue; }
  if (token === '--reason') { flags.reason = argv[++index] ?? ''; continue; }
  if (token === '--rounds') { flags.rounds = Number(argv[++index]); continue; }
  if (token === '--text') { flags.text = argv[++index] ?? ''; continue; }
  positional.push(token);
}
const reason = typeof flags.reason === 'string' && flags.reason.trim()
  ? flags.reason.trim()
  : `phone.mjs ${command ?? 'unknown'} from the agent loop`;

if (!command) die(2, 'usage: phone.mjs screen|tap|type|key|scroll|apps|open|collect [args]');

switch (command) {
  case 'screen': {
    printScreen(await capture());
    break;
  }
  case 'tap': {
    const raw = positional[0];
    if (raw === undefined) die(2, 'tap needs an id from the latest screen output, or x,y');
    const snapshot = await loadSnapshot();
    if (!snapshot) die(2, 'No screen has been read yet in this device session. Run: phone.mjs screen');
    let body;
    let label = null;
    if (raw.includes(',')) {
      const [x, y] = raw.split(',').map(Number);
      if (!Number.isFinite(x) || !Number.isFinite(y)) die(2, 'tap x,y needs two integers, for example 540,300');
      body = { x, y, reason };
    } else {
      const id = Number(raw);
      const element = snapshot.elements.find(item => item.id === id);
      if (!element) die(2, `Id ${raw} is not on the screen that was last read (${snapshot.screenId}, ${snapshot.elements.length} items). Run: phone.mjs screen`);
      const [left, top, right, bottom] = element.bounds;
      body = { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2), reason };
      label = element.label || null;
    }
    await call('/ui/tap', body);
    printScreen(await capture(), `已点 ${raw}${label ? `（${label}）` : ''}`);
    break;
  }
  case 'type': {
    const text = flags.text ?? positional.join(' ');
    if (text === undefined || text === '') die(2, 'type needs the text to write into the focused field');
    const value = await call('/ui/text', { text, submit: flags.submit === true, reason });
    printScreen(await capture(), `已输入（模式 ${value?.mode ?? 'unknown'}，回车 ${value?.submitted === true ? '已按' : '未按'}）`);
    break;
  }
  case 'key': {
    const key = positional[0];
    if (!key) die(2, 'key needs one of back, home, recents, enter, del');
    await call('/ui/key', { key, reason });
    printScreen(await capture(), `已按键 ${key}`);
    break;
  }
  case 'scroll': {
    const direction = positional[0] === 'up' ? 'up' : 'down';
    const snapshot = await loadSnapshot() ?? { width: 1080, height: 2400, elements: [] };
    const x = Math.round(snapshot.width / 2);
    const top = Math.round(snapshot.height * 0.25);
    const bottom = Math.round(snapshot.height * 0.75);
    const inset = Math.max(24, Math.round((bottom - top) * 0.2));
    const topY = top + inset;
    const bottomY = bottom - inset;
    const fromY = direction === 'up' ? topY : bottomY;
    const toY = direction === 'up' ? bottomY : topY;
    await call('/ui/swipe', { fromX: x, fromY, toX: x, toY, durationMs: 400, reason });
    printScreen(await capture(), `已向${direction === 'up' ? '上' : '下'}滚动`);
    break;
  }
  case 'apps': {
    const value = await call('/app/list?includeSystem=false');
    const apps = Array.isArray(value?.apps) ? value.apps : [];
    process.stdout.write(`共 ${apps.length} 个可打开的应用\n`);
    for (const app of apps) process.stdout.write(`  ${app.label ?? ''} · ${app.packageName ?? ''}\n`);
    break;
  }
  case 'open': {
    const packageName = positional[0];
    if (!packageName) die(2, 'open needs a package id, for example com.android.settings');
    await call('/app/start', { package: packageName, reason });
    printScreen(await capture(), `已请求打开 ${packageName}（启动回话不等于任务完成，下面是实际落到的屏幕）`);
    break;
  }
  case 'collect': {
    const rounds = Number.isFinite(flags.rounds) ? flags.rounds : 5;
    const seen = new Set();
    const items = [];
    for (let round = 0; round < rounds; round++) {
      const view = await capture();
      let added = 0;
      for (const element of view.elements) {
        const label = (element.label || '').trim();
        if (!label || seen.has(label)) continue;
        seen.add(label);
        items.push(label);
        added++;
      }
      if (round > 0 && added === 0) break;
      if (round === rounds - 1) break;
      const snapshot = await loadSnapshot();
      const x = Math.round((snapshot?.width ?? 1080) / 2);
      const top = Math.round((snapshot?.height ?? 2400) * 0.25);
      const bottom = Math.round((snapshot?.height ?? 2400) * 0.75);
      const inset = Math.max(24, Math.round((bottom - top) * 0.2));
      await call('/ui/swipe', { fromX: x, fromY: bottom - inset, toX: x, toY: top + inset, durationMs: 400, reason });
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    process.stdout.write(`共收集 ${items.length} 条（已按文字去重）\n`);
    for (const item of items) process.stdout.write(`  - ${item}\n`);
    break;
  }
  default:
    die(2, `Unknown command ${JSON.stringify(command)}; use screen, tap, type, key, scroll, apps, open or collect`);
}
