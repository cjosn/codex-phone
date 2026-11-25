#!/usr/bin/env node
// android-screen.mjs —— 不依赖任何 App / 无障碍 / Shizuku，只用 adb 操作手机屏幕。
// 给「桌面端 DSH / Codex / 任何能跑 shell 的 agent」用：读屏 → 编号 → 点按，和 dsh-go 一样的手感。
//
// 前置：手机开「USB 调试」或「无线调试」，PC 上 `adb devices` 能看到设备。
//       Windows 直接用它（自动找 adb.exe），也可以 `set ADB=C:\platform-tools\adb.exe`。
//
// 用法（CLI）：
//   node android-screen.mjs dump            读当前屏幕，输出带编号的文本
//   node android-screen.mjs dump --json     同一份快照的 JSON（元素 + bounds）
//   node android-screen.mjs tap 7           点第 7 项（用最近一次 dump 的编号）
//   node android-screen.mjs tap --x 540 --y 300
//   node android-screen.mjs type "你好" --submit
//   node android-screen.mjs key back
//   node android-screen.mjs swipe down
//   node android-screen.mjs collect 3 --pages 10     滚列表收全部条目
//   node android-screen.mjs shot ./a.png
//   node android-screen.mjs apps
//   node android-screen.mjs open com.tencent.mobileqq
//   node android-screen.mjs --mcp           作为 stdio MCP server（给 agent 直接接）
//
// 可选：--serial <设备号>  或环境变量 ADB_SERIAL / ADB

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ADB = process.env.ADB || (process.platform === 'win32' ? 'adb.exe' : 'adb');
const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(process.env.TMPDIR || tmpdir(), 'android-screen-snapshot.json');

const LABEL_CAP = 60;
const CHAR_BUDGET = 3000;
const POOR_TREE = 5;

function adb(args, bin = false) {
  const serial = process.env.ADB_SERIAL;
  const full = serial ? ['-s', serial, ...args] : args;
  const out = execFileSync(ADB, full, { encoding: bin ? 'buffer' : 'utf8', maxBuffer: 64 << 20 });
  return out;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function die(msg, code = 1) {
  process.stderr.write(`android-screen: ${msg}\n`);
  process.exit(code);
}

// ---------- 读屏 ----------
function dumpXml(file) {
  // 调试用：直接读一份 uiautomator XML，不连设备
  if (file) return readFileSync(file, 'utf8');
  // 优先 exec-out（不回写 /sdcard）；老设备回退到文件 + cat
  try {
    const out = adb(['exec-out', 'uiautomator', 'dump', '/dev/tty']);
    const i = out.indexOf('<?xml');
    if (i >= 0) return out.slice(i);
  } catch { /* 回退 */ }
  adb(['shell', 'uiautomator', 'dump', '/sdcard/adump.xml']);
  return adb(['exec-out', 'cat', '/sdcard/adump.xml']);
}

function screenSize(xml) {
  try {
    const out = adb(['shell', 'wm', 'size']);
    const m = out.match(/(\d+)x(\d+)/);
    if (m) return { width: +m[1], height: +m[2] };
  } catch { /* 无设备时回退到 XML 推断 */ }
  const all = [...(xml || '').matchAll(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/g)];
  const w = Math.max(1080, ...all.map((m) => +m[3]));
  const h = Math.max(2400, ...all.map((m) => +m[4]));
  return { width: w, height: h };
}

// 极简 XML 解析：只认 <node ...>...嵌套...</node> 与自闭合，够 uiautomator 用。
function parseXml(xml) {
  const root = { tag: 'root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<\s*(\/?)([a-zA-Z:]+)((?:\s+[a-zA-Z_:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|<\?[^>]*\?>|<!--[\s\S]*?-->/g;
  let m;
  while ((m = re.exec(xml))) {
    const [, closing, tag, attrStr, selfClose] = m;
    if (!tag || tag.startsWith('?') || tag.startsWith('!')) continue;
    if (closing) { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    const ar = /([a-zA-Z_:.-]+)\s*=\s*"([^"]*)"/g;
    let a;
    while ((a = ar.exec(attrStr || ''))) attrs[a[1]] = a[2];
    const node = { tag, attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

function boundsOf(a) {
  const m = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a.bounds || '');
  return m ? [+m[1], +m[2], +m[3], +m[4]] : [0, 0, 0, 0];
}
const truthy = (v) => v === 'true';

const EDITABLE_HINT = /EditText|AutoComplete|SearchView|TextField/i;
const SCROLL_HINT = /ScrollView|RecyclerView|ListView|ViewPager|WebView/i;
const PASSWORD_HINT = /password|passwd|pwd/i;

function nodeInfo(n) {
  const a = n.attrs;
  const cls = a.class || '';
  const short = cls.split('.').pop() || '';
  // 只有真文字才算文字；resource-id 尾段只作为「无文字按钮」的兜底标签
  const text = (a.text || a['content-desc'] || '').replace(/\s+/g, ' ').trim();
  const idTail = (a['resource-id'] || '').split('/').pop() || '';
  const password = truthy(a.password) || PASSWORD_HINT.test(cls) || PASSWORD_HINT.test(a['resource-id'] || '');
  const editable = EDITABLE_HINT.test(cls) || truthy(a['focusable'] && a['class']?.includes('Edit')) ;
  const scrollable = truthy(a.scrollable) || SCROLL_HINT.test(cls);
  const clickable = truthy(a.clickable) || truthy(a['long-clickable']);
  return { short, text, idTail, password, editable, scrollable, clickable, bounds: boundsOf(a) };
}

function labelOf(info) {
  if (info.password) return '密码框';
  return info.text.slice(0, LABEL_CAP);
}

function roleOf(info) {
  if (info.password) return '密码框';
  if (info.scrollable && !info.text) return '列表';
  if (info.editable) return '输入框';
  if (/Button/.test(info.short)) return '按钮';
  if (/CheckBox|Switch|RadioButton/.test(info.short)) return '开关';
  if (info.clickable && info.text) return '链接';
  if (info.clickable) return '按钮';
  if (/Image/.test(info.short) && !info.text) return '图片';
  return '文本';
}

/** 从 XML 树压出「一行一个元素」：
 *  可交互节点 → 一行（吞掉其下不可交互的文本）；纯文字节点 → 一行；纯布局 → 继续下钻。
 *  列表容器里的纯文字条目要照常出，否则列表读出来是空的。 */
function flatten(tree, depth = 0, out = []) {
  const walk = (n, d) => {
    if (n.tag !== 'node') {
      for (const c of n.children || []) walk(c, d);
      return;
    }
    const info = nodeInfo(n);
    const inter = info.clickable || info.editable || info.scrollable;
    const isInterNode = (x) => {
      const ci = nodeInfo(x);
      return ci.clickable || ci.editable || ci.scrollable;
    };

    if (inter) {
      const parts = [];
      const grab = (x) => {
        for (const c of x.children || []) {
          if (c.tag !== 'node') { grab(c); continue; }
          const ci = nodeInfo(c);
          const ciInter = ci.clickable || ci.editable || ci.scrollable;
          if (!ciInter && ci.text) parts.push(ci.text);
          if (!ciInter) grab(c);
        }
      };
      grab(n);
      let label = info.password ? '' : (info.text || parts.join(' · ') || info.idTail).slice(0, LABEL_CAP);
      if (info.scrollable && !info.text) label = '';
      if (info.editable && !info.text) label = '';
      out.push({ role: roleOf(info), label, bounds: info.bounds, clickable: info.clickable, editable: info.editable, depth: d });

      const nd = info.scrollable ? d + 1 : d;
      const rec = (x) => {
        for (const c of x.children || []) {
          if (c.tag !== 'node') { rec(c); continue; }
          if (isInterNode(c)) { walk(c, nd); continue; }
          const ci = nodeInfo(c);
          // 列表里的纯文字条目也要出（否则列表是空的）
          if (info.scrollable && ci.text) { walk(c, nd); continue; }
          rec(c);
        }
      };
      rec(n);
    } else if (info.text) {
      out.push({ role: roleOf(info), label: info.text.slice(0, LABEL_CAP), bounds: info.bounds, clickable: false, editable: false, depth: d });
      const rec = (x) => {
        for (const c of x.children || []) {
          if (c.tag !== 'node') { rec(c); continue; }
          if (isInterNode(c)) walk(c, d);
          else rec(c);
        }
      };
      rec(n);
    } else {
      for (const c of n.children || []) walk(c, d);
    }
  };
  walk(tree, depth);
  return out;
}

function snapshot({ detail = false, xmlFile = null } = {}) {
  const xml = dumpXml(xmlFile);
  const { width, height } = screenSize(xml);
  const tree = parseXml(xml);
  const items = flatten(tree).sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0]);

  const textCount = (xml.match(/\stext="[^"]+"/g) || []).length;

  // 分区：按元素上沿归入 顶部 / 中部 / 底部（与 dsh-go 的 ScreenFormat 同规则），
  // 只在分区切换时输出一次标题；同一块内容即使跨阈值也不会重复出标题。
  const zoneOf = (y) => (y < height * 0.22 ? '顶部' : y < height * 0.8 ? '中部' : '底部');

  const lines = [];
  const elements = [];
  let budget = CHAR_BUDGET;
  let hidden = 0;
  let id = 0;
  let lastZone = null;

  const push = (line) => {
    if (budget - line.length < 0) { hidden += 1; return false; }
    budget -= line.length + 1; lines.push(line); return true;
  };

  for (const it of items) {
    const z = zoneOf(it.bounds[1]);
    if (z !== lastZone) { if (push(z)) lastZone = z; }
    id += 1;
    const text = `[${id}] ${it.role}${it.label ? ' ' + it.label : ''}`;
    const line = '  '.repeat(Math.min(it.depth, 2)) + text;
    if (push(line)) elements.push({ id, role: it.role, label: it.label, bounds: it.bounds, clickable: it.clickable, editable: it.editable });
    else id -= 1;
  }

  const header = [`屏幕 s1 · ${width > height ? '横屏' : '竖屏'} · 共 ${elements.length} 项`];
  if (hidden > 0) header.push(`…另有 ${hidden} 项未显示（可 swipe 或分页看）`);
  if (textCount < POOR_TREE) header.push('提示：本页文字很少（游戏、自绘界面常见），可先 shot 截图；否则请用户协助。');
  if (!elements.length) header.push('（没有可读的元素）');

  const snap = { text: [...header, ...lines].join('\n'), elements, width, height, truncated: hidden > 0 };
  saveSnapshot(snap);
  return snap;
}

function saveSnapshot(snap) {
  try { writeFileSync(CACHE, JSON.stringify({ at: Date.now(), ...snap })); } catch { /* ignore */ }
}

function loadSnapshot(maxAgeMs = 120000) {
  if (!existsSync(CACHE)) die('还没有屏幕快照，先跑一次 dump');
  const snap = JSON.parse(readFileSync(CACHE, 'utf8'));
  if (Date.now() - snap.at > maxAgeMs) die(`快照已过期（${Math.round((Date.now() - snap.at) / 1000)}s 前），先重新 dump`);
  return snap;
}

// ---------- 动作 ----------
function tapById(snap, id) {
  const el = snap.elements.find((e) => e.id === id);
  if (!el) die(`编号 ${id} 不属于当前屏幕（共 ${snap.elements.length} 项），先重新 dump`);
  const [l, t, r, b] = el.bounds;
  return { x: Math.round((l + r) / 2), y: Math.round((t + b) / 2) };
}

function doTap(x, y, long = false) {
  adb(['shell', 'input', long ? 'swipe' : 'tap', ...(long ? [x, y, x, y, 800] : [x, y])].map(String));
}

function doType(text, submit) {
  if (/[\s'"]/.test(text)) {
    // adb input text 不支持空格与引号，走转义
    const esc = text.replace(/([\\'"&()<>|;$`*\s])/g, '\\$1');
    adb(['shell', 'input', 'text', esc]);
  } else {
    adb(['shell', 'input', 'text', text]);
  }
  if (submit) adb(['shell', 'input', 'keyevent', '66']);
}

const KEYMAP = { back: 4, home: 3, recents: 187, notifications: 83, enter: 66, del: 67 };
function doKey(k) {
  const code = KEYMAP[k];
  if (!code) die(`不认识的键：${k}（可用 ${Object.keys(KEYMAP).join('/')}）`);
  adb(['shell', 'input', 'keyevent', code]);
}

function doSwipe(dir, snap) {
  const w = snap?.width || 1080;
  const h = snap?.height || 2400;
  const cx = Math.round(w / 2), cy = Math.round(h / 2);
  const map = {
    up: [cx, cy + 400, cx, cy - 400],
    down: [cx, cy - 400, cx, cy + 400],
    left: [Math.round(w * 0.8), cy, Math.round(w * 0.2), cy],
    right: [Math.round(w * 0.2), cy, Math.round(w * 0.8), cy],
  };
  const [x1, y1, x2, y2] = map[dir] || map.up;
  adb(['shell', 'input', 'swipe', x1, y1, x2, y2, 350].map(String));
}

// ---------- 命令行 ----------
function parseArgs(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['json', 'long', 'submit', 'mcp', 'detail'].includes(k)) flags[k] = true;
      else { flags[k] = argv[++i]; }
    } else pos.push(a);
  }
  return { pos, flags };
}

function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  if (flags.serial) process.env.ADB_SERIAL = flags.serial;

  switch (cmd) {
    case 'dump': {
      const snap = snapshot({ detail: !!flags.detail, xmlFile: flags['xml-file'] || null });
      console.log(flags.json ? JSON.stringify(snap, null, 2) : snap.text);
      return;
    }
    case 'tap': {
      const snap = loadSnapshot();
      if (flags.x != null && flags.y != null) return doTap(+flags.x, +flags.y, !!flags.long);
      const id = +pos[1];
      if (!Number.isFinite(id)) die('用法：tap <编号>  或  tap --x 540 --y 300');
      const { x, y } = tapById(snap, id);
      doTap(x, y, !!flags.long);
      console.log(`已点 [${id}] @ ${x},${y}`);
      return;
    }
    case 'type': {
      const text = pos[1] ?? '';
      if (!text) die('用法：type "文字" [--submit]');
      doType(text, !!flags.submit);
      console.log(`已输入 ${text.length} 字${flags.submit ? '并提交' : ''}`);
      return;
    }
    case 'key': return doKey(pos[1] || 'back');
    case 'swipe': return doSwipe(pos[1] || 'up', loadSnapshot());
    case 'shot': {
      const path = pos[1] || 'screen.png';
      const buf = adb(['exec-out', 'screencap', '-p'], true);
      writeFileSync(path, buf);
      console.log(`已保存 ${path}（${buf.length} 字节）`);
      return;
    }
    case 'apps': {
      const out = adb(['shell', 'pm', 'list', 'packages', '-3']);
      console.log(out.split('\n').map((l) => l.replace('package:', '')).filter(Boolean).join('\n'));
      return;
    }
    case 'open': {
      const t = pos[1];
      if (!t) die('用法：open <包名|https://...>');
      if (/^https?:/.test(t)) adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', t]);
      else adb(['shell', 'monkey', '-p', t, '-c', 'android.intent.category.LAUNCHER', '1']);
      console.log(`已请求打开 ${t}`);
      return;
    }
    case 'collect': {
      const listId = +pos[1];
      const maxPages = +(flags.pages || 10);
      let snap = snapshot();
      const listEl = snap.elements.find((e) => e.id === listId);
      if (!listEl) die(`编号 ${listId} 不是当前屏幕的列表`);
      const seen = new Set();
      const rows = [];
      for (let p = 0; p < maxPages; p++) {
        for (const e of snap.elements) {
          if (e.id === listId) continue;
          if (e.bounds[1] < listEl.bounds[1] || e.bounds[3] > listEl.bounds[3]) continue;
          const key = `${e.role}|${e.label}`;
          if (seen.has(key) || !e.label) continue;
          seen.add(key); rows.push(e.label);
        }
        if (flags.until && rows.some((r) => r.includes(flags.until))) break;
        doSwipe('up', snap);
        sleep(350);
        snap = snapshot();
      }
      console.log(rows.join('\n'));
      return;
    }
    default:
      die('用法见文件头注释：dump | tap | type | key | swipe | collect | shot | apps | open | --mcp');
  }
}

// ---------- MCP 模式 ----------
const MCP_TOOLS = [
  { name: 'screen', description: '读当前屏幕，返回带编号的元素列表；编号只在本屏有效。', inputSchema: { type: 'object', properties: { detail: { type: 'boolean' } }, additionalProperties: false } },
  { name: 'tap', description: '按编号点击（用最近一次 screen 的编号），返回提示。', inputSchema: { type: 'object', properties: { id: { type: 'integer' }, long: { type: 'boolean' } }, required: ['id'] } },
  { name: 'type', description: '在当前焦点输入框输入文字。', inputSchema: { type: 'object', properties: { text: { type: 'string' }, submit: { type: 'boolean' } }, required: ['text'] } },
  { name: 'scroll', description: '滚动屏幕。', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] } }, required: ['direction'] } },
  { name: 'key', description: '按系统键。', inputSchema: { type: 'object', properties: { key: { type: 'string', enum: ['back', 'home', 'recents', 'notifications'] } }, required: ['key'] } },
  { name: 'collect', description: '自动滚动列表收集全部条目。', inputSchema: { type: 'object', properties: { list: { type: 'integer' }, max_pages: { type: 'integer' } }, required: ['list'] } },
  { name: 'apps', description: '列出已安装的第三方应用包名。', inputSchema: { type: 'object', properties: {} } },
  { name: 'open', description: '打开应用或链接。', inputSchema: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] } },
  { name: 'shot', description: '截图并返回文件路径。', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
];

function mcpMode() {
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const { id, method, params } = msg;
      if (method === 'initialize') {
        send({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'android-screen', version: '1' } } });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } });
      } else if (method === 'tools/call') {
        const args = params?.arguments || {};
        try {
          let text = '';
          if (params.name === 'screen') text = snapshot().text;
          else if (params.name === 'tap') { const s = loadSnapshot(); const p = tapById(s, args.id); doTap(p.x, p.y, !!args.long); text = `已点 [${args.id}]`; }
          else if (params.name === 'type') { doType(args.text, !!args.submit); text = '已输入'; }
          else if (params.name === 'scroll') { doSwipe(args.direction, loadSnapshot()); text = `已滚动 ${args.direction}`; }
          else if (params.name === 'key') { doKey(args.key); text = `已按 ${args.key}`; }
          else if (params.name === 'apps') text = adb(['shell', 'pm', 'list', 'packages', '-3']).replace(/package:/g, '');
          else if (params.name === 'open') { adb(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', args.target]); text = '已请求打开'; }
          else if (params.name === 'collect') text = '（CLI 里用 collect，MCP 模式暂简化）';
          else if (params.name === 'shot') { const p = args.path || 'screen.png'; writeFileSync(p, adb(['exec-out', 'screencap', '-p'], true)); text = p; }
          else text = `未知工具 ${params.name}`;
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } });
        } catch (e) {
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `出错：${e.message}` }], isError: true } });
        }
      } else if (id !== undefined) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
      }
    }
  });
}

if (process.argv.includes('--mcp')) mcpMode();
else main();
