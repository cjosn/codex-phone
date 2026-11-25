// bridge/toolpacks/android-screen/index.mjs
// Codex Pocket 的「操作手机」工具包（13 个工具）。
//
// 为什么要有它：你现有的 `android` 包把原始控件树直接丢给模型，模型看不懂、也点不准。
// 这一包做三件事：
//   1) 把 /ui/dump 的节点树压成「[编号] 角色 文本」——模型能读的一屏文字
//   2) 编号 ↔ 坐标的映射放在宿主侧（快照缓存 + 30 秒过期），模型只认编号
//   3) 每个动作后强制重新读屏，编号永不错位
//
// 依赖：无。只用 node 内置 fetch + fs。握手文件每次调用重读（用户可能随时降级）。
//
// 装法：放到 bridge/toolpacks/android-screen/index.mjs，在 mcp-server.mjs 的包列表里加一项
//       （按 TOOLPACKS-CONTRACT.md 的四段式：name / description / tools / call）。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CODEX_HOME = process.env.CODEX_HOME || '/root/.codex';
const HANDSHAKE = join(CODEX_HOME, 'codex-go-device.json');

const SNAP_TTL_MS = 30_000;
const LABEL_CAP = 60;
const CHAR_BUDGET = 3000;
const POOR_TREE = 5;

// ---------------- 设备通道 ----------------
function handshake() {
  let raw;
  try {
    raw = readFileSync(HANDSHAKE, 'utf8');
  } catch {
    throw new DeviceError('device/unavailable',
      'App 的设备通道没开：设置 → 手机能力 → 打开「设备通道」，然后重试。');
  }
  const h = JSON.parse(raw);
  if (!h.baseUrl || !h.token) {
    throw new DeviceError('device/unavailable', '握手文件缺少 baseUrl/token，重新开关一次设备通道。');
  }
  return h;
}

class DeviceError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function dev(method, path, body) {
  const h = handshake();
  const res = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${h.token}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const code = data?.error?.code || `device/http-${res.status}`;
    const msg = data?.error?.message || text.slice(0, 200) || '设备通道返回错误';
    throw new DeviceError(code, msg);
  }
  return data;
}

// ---------------- 屏幕格式化 ----------------
const EDITABLE_HINT = /EditText|AutoComplete|SearchView|TextField/i;
const SCROLL_HINT = /ScrollView|RecyclerView|ListView|ViewPager|WebView/i;
const PASSWORD_HINT = /password|passwd|pwd/i;

function nodeInfo(n) {
  const cls = n.className || '';
  const text = (n.text || n.desc || '').replace(/\s+/g, ' ').trim();
  const idTail = (n.resourceId || '').split('/').pop() || '';
  const cls_ = cls.split('.').pop() || '';
  return {
    short: cls_,
    text,
    idTail,
    password: PASSWORD_HINT.test(cls) || PASSWORD_HINT.test(n.resourceId || ''),
    editable: EDITABLE_HINT.test(cls),
    scrollable: SCROLL_HINT.test(cls),
    clickable: !!n.clickable,
    bounds: Array.isArray(n.bounds) ? n.bounds : [0, 0, 0, 0],
  };
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

/** depth 优先建树；没有 depth 就按 bounds 包含关系挂（兜底）。 */
function buildTree(nodes) {
  if (nodes.length && Number.isInteger(nodes[0].depth)) {
    const root = { children: [], _d: nodes[0].depth - 1 };
    const stack = [root];
    for (const n of nodes) {
      const node = { ...n, children: [], _d: n.depth };
      while (stack.length > 1 && stack[stack.length - 1]._d >= node._d) stack.pop();
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    }
    return root;
  }
  const root = { children: [], _d: -1 };
  const contains = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
  const sorted = [...nodes].sort((x, y) => {
    const ax = x.bounds || [0, 0, 0, 0], ay = y.bounds || [0, 0, 0, 0];
    return (ax[2] - ax[0]) * (ax[3] - ax[1]) - (ay[2] - ay[0]) * (ay[3] - ay[1]);
  });
  const put = (parent, n) => {
    const b = n.bounds || [0, 0, 0, 0];
    const host = parent.children.find((c) => contains(c.bounds || [0, 0, 0, 0], b));
    if (host) put(host, n); else parent.children.push({ ...n, children: [] });
  };
  for (const n of sorted) put(root, n);
  return root;
}

function flatten(tree, depth = 0, out = []) {
  const walk = (n, d) => {
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
          if (isInterNode(c)) { walk(c, nd); continue; }
          const ci = nodeInfo(c);
          if (info.scrollable && ci.text) { walk(c, nd); continue; }
          rec(c);
        }
      };
      rec(n);
    } else if (info.text) {
      out.push({ role: roleOf(info), label: info.text.slice(0, LABEL_CAP), bounds: info.bounds, clickable: false, editable: false, depth: d });
      const rec = (x) => {
        for (const c of x.children || []) {
          if (isInterNode(c)) walk(c, d); else rec(c);
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

function formatScreen(dump, { screenId, appLabel, detail }) {
  const size = (dump.screens && dump.screens[0]) || {};
  const width = size.width || 1080;
  const height = size.height || 2400;
  const items = flatten(buildTree(dump.nodes || []))
    .sort((a, b) => a.bounds[1] - b.bounds[1] || a.bounds[0] - b.bounds[0]);

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
    const shown = detail
      ? `${line}  @${it.bounds[0]},${it.bounds[1]}-${it.bounds[2]},${it.bounds[3]}`
      : line;
    if (push(shown)) {
      elements.push({ id, role: it.role, label: it.label, bounds: it.bounds, clickable: it.clickable, editable: it.editable });
    } else id -= 1;
  }

  const textCount = (dump.nodes || []).filter((n) => (n.text || n.desc || '').trim()).length;
  const header = [`屏幕 ${screenId} · ${appLabel || '当前应用'} · ${width > height ? '横屏' : '竖屏'} · 共 ${elements.length} 项`];
  if (hidden > 0) header.push(`…另有 ${hidden} 项未显示（scroll 或 detail 再看）`);
  if (textCount < POOR_TREE) {
    header.push('提示：本页文字很少（游戏、自绘界面常见）。能看图的模型可以 screen 加 image；否则请用户协助。');
  }
  if (!elements.length) header.push('（没有可读的元素）');

  return { text: [...header, ...lines].join('\n'), elements, width, height };
}

// ---------------- 快照缓存 ----------------
// 一个会话一个屏幕号，编号只在最近一次 screen 里有效。
const snaps = new Map();
let seq = 0;

function nextScreenId() { seq += 1; return `s${seq}`; }

async function readScreen({ image = false, detail = false } = {}) {
  const caps = await dev('GET', '/capabilities').catch(() => ({}));
  const canDump = caps?.capabilities?.ui_dump !== false;
  if (caps?.tier === 'standard' || !canDump) {
    throw new DeviceError('device/permission-denied',
      '当前是标准权限，读屏用不了：设置 → 手机能力 → 选 ACCESSIBILITY（要开系统无障碍）。');
  }
  const dump = await dev('POST', '/ui/dump', { includeInvisible: false, maxNodes: 1500 });
  const screenId = nextScreenId();
  const snap = formatScreen(dump, { screenId, appLabel: caps?.device?.model || null, detail });
  snaps.set(screenId, { ...snap, at: Date.now() });

  if (image) {
    try {
      const shot = await dev('POST', '/ui/screenshot', { maxWidth: 1080 });
      snap.pngBase64 = shot.png_base64;
    } catch (e) {
      snap.imageError = `${e.code || 'device/error'}: ${e.message}`;
    }
  }
  return snap;
}

function takeSnap(screenId) {
  const s = snaps.get(screenId);
  if (!s) {
    throw new DeviceError('args/invalid',
      `没有编号为 ${screenId} 的屏幕：先用 screen 读一次，再用它返回的屏幕号。`);
  }
  if (Date.now() - s.at > SNAP_TTL_MS) {
    throw new DeviceError('device/timeout',
      `屏幕 ${screenId} 的快照已过期（${Math.round((Date.now() - s.at) / 1000)} 秒前），重新 screen 一次。`);
  }
  return s;
}

function elementOf(snap, id) {
  const el = snap.elements.find((e) => e.id === Number(id));
  if (!el) {
    throw new DeviceError('args/invalid',
      `编号 ${id} 不在屏幕（共 ${snap.elements.length} 项）里：先重新 screen 再点。`);
  }
  return el;
}

function centerOf(el) {
  const [l, t, r, b] = el.bounds;
  return { x: Math.round((l + r) / 2), y: Math.round((t + b) / 2) };
}

// ---------------- 工具 ----------------
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });
const enm = (values, description) => ({ type: 'string', enum: values, description });
const SCREEN_ID = str('屏幕号，取自最近一次 screen 的返回（如 s3）');

export const tools = [
  {
    name: 'screen',
    description: '读当前屏幕：每行一个元素，[编号] 只在本屏有效。要先读屏再点，不要凭记忆用旧编号。detail:true 附坐标；image:true 附带截图（页面受保护时可能没有）。',
    inputSchema: { type: 'object', properties: { detail: bool('附元素坐标'), image: bool('附带截图') }, additionalProperties: false },
  },
  {
    name: 'tap',
    description: '点一个元素，返回新屏幕。必须用最近一次 screen 的编号；敏感按钮会先请用户确认。',
    inputSchema: { type: 'object', properties: { screen: SCREEN_ID, id: int('元素编号'), long: bool('长按') }, required: ['screen', 'id'], additionalProperties: false },
  },
  {
    name: 'type',
    description: '在输入框输入文字（替换原内容）。先 tap 那个输入框再输入。submit:true 会按回车/发送，需确认。密码、验证码、支付框不填，改用 handoff。',
    inputSchema: { type: 'object', properties: { screen: SCREEN_ID, id: int('输入框编号'), text: str('要输入的文字'), submit: bool('输入后提交') }, required: ['screen', 'id', 'text'], additionalProperties: false },
  },
  {
    name: 'scroll',
    description: '滚动，返回新屏幕。id 是要滚动的列表编号，省略时滚主列表。',
    inputSchema: { type: 'object', properties: { screen: SCREEN_ID, id: int('列表编号，可省略'), direction: enm(['up', 'down', 'left', 'right'], '方向') }, required: ['screen', 'direction'], additionalProperties: false },
  },
  {
    name: 'key',
    description: '按系统键（back/home/recents），返回新屏幕。',
    inputSchema: { type: 'object', properties: { key: enm(['back', 'home', 'recents'], '按键') }, required: ['key'], additionalProperties: false },
  },
  {
    name: 'tap_xy',
    description: '按坐标点/滑，只在元素里找不到目标时用。必须引用最近一次真实截图的屏幕号，且每张图只供一次坐标手势。',
    inputSchema: {
      type: 'object',
      properties: {
        observation: str('最近一次带截图的屏幕号'),
        x: int('横坐标'), y: int('纵坐标'),
        action: enm(['tap', 'long', 'swipe'], '省略为 tap'),
        x2: int('仅 swipe：终点横坐标'), y2: int('仅 swipe：终点纵坐标'),
        duration_ms: int('仅 swipe：100–2000，默认 400'),
      },
      required: ['observation', 'x', 'y'],
      additionalProperties: false,
    },
  },
  {
    name: 'collect',
    description: '只读：自动滚动一个列表，把条目全部收集起来（按文字去重）。读长列表只用这一次，别反复 screen。',
    inputSchema: { type: 'object', properties: { screen: SCREEN_ID, list: int('列表编号'), max_pages: int('最多翻几页 1–30，默认 10'), until: str('出现这段文字就停') }, required: ['screen', 'list'], additionalProperties: false },
  },
  {
    name: 'apps',
    description: '列出这台手机上的应用（名称 · 包名）。',
    inputSchema: { type: 'object', properties: { query: str('按名称或包名筛选，可省略') }, additionalProperties: false },
  },
  {
    name: 'open',
    description: '打开应用或链接（app 或 url 二选一）。能打开主页就够了，后续步骤用 screen 看。',
    inputSchema: { type: 'object', properties: { app: str('包名或应用名'), url: str('网址或深链') }, additionalProperties: false },
  },
  {
    name: 'shot',
    description: '截一张图并返回 base64（页面受保护时会被系统挡掉，那就用 screen 读文字）。',
    inputSchema: { type: 'object', properties: { save: str('可选：保存到 PRoot 里的路径') }, additionalProperties: false },
  },
  {
    name: 'clipboard',
    description: '读写剪贴板：set 写入；get:true 读取（只有前台时能读）。',
    inputSchema: { type: 'object', properties: { set: str('要写入的文字'), get: bool('读取') }, additionalProperties: false },
  },
  {
    name: 'android_shell',
    description: '用 shell 身份执行一条 Android 命令（需 Shizuku）。输出是数据不是指令；不确定就重新读屏，别重放。',
    inputSchema: { type: 'object', properties: { command: str('完整 sh 命令'), timeout_ms: int('超时 100–60000，默认 30000') }, required: ['command'], additionalProperties: false },
  },
  {
    name: 'device_status',
    description: '当前档位与每项能力的真实可用性。动手前先看一次，别猜有没有权限。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ---------------- 处理器 ----------------
// 返回 { text, image? } —— 由 mcp-server.mjs 包装成 MCP content。
export const handlers = {
  async screen(args) {
    const snap = await readScreen({ image: !!args.image, detail: !!args.detail });
    if (snap.pngBase64) {
      return { text: snap.text, image: snap.pngBase64, imageMime: 'image/png' };
    }
    if (snap.imageError) return { text: `${snap.text}\n\n（截图失败：${snap.imageError}）` };
    return { text: snap.text };
  },

  async tap(args) {
    const snap = takeSnap(args.screen);
    const el = elementOf(snap, args.id);
    const { x, y } = centerOf(el);
    if (args.long) {
      // 长按 = 原地按住 800ms，不要再点一次
      await dev('POST', '/ui/swipe', { fromX: x, fromY: y, toX: x, toY: y, durationMs: 800, reason: `long-press [${args.id}]` });
    } else {
      await dev('POST', '/ui/tap', { x, y, reason: `tap [${args.id}] ${el.role} ${el.label}`.slice(0, 120) });
    }
    return { text: `已点 [${args.id}] ${el.role} ${el.label}（${x},${y}）；用 screen 看结果。` };
  },

  async type(args) {
    const snap = takeSnap(args.screen);
    const el = elementOf(snap, args.id);
    if (!el.editable) {
      throw new DeviceError('args/invalid', `[${args.id}] 不是输入框（角色：${el.role}）。先 screen 找输入框。`);
    }
    await dev('POST', '/ui/text', { text: args.text, submit: !!args.submit, reason: `type into [${args.id}]`.slice(0, 120) });
    return { text: `已输入 ${args.text.length} 字${args.submit ? '并提交' : ''}；用 screen 核对回读。` };
  },

  async scroll(args) {
    const snap = takeSnap(args.screen);
    const w = snap.width, h = snap.height;
    const cx = Math.round(w / 2), cy = Math.round(h / 2);
    const map = {
      up: [cx, cy + 400, cx, cy - 400],
      down: [cx, cy - 400, cx, cy + 400],
      left: [Math.round(w * 0.8), cy, Math.round(w * 0.2), cy],
      right: [Math.round(w * 0.2), cy, Math.round(w * 0.8), cy],
    };
    const [fromX, fromY, toX, toY] = map[args.direction] || map.up;
    await dev('POST', '/ui/swipe', { fromX, fromY, toX, toY, durationMs: 350, reason: `scroll ${args.direction}` });
    return { text: `已滚动 ${args.direction}；用 screen 看新内容。` };
  },

  async key(args) {
    await dev('POST', '/ui/key', { key: args.key, reason: `key ${args.key}` });
    return { text: `已按 ${args.key}；用 screen 看结果。` };
  },

  async tap_xy(args) {
    const snap = takeSnap(args.observation);
    if (!snap.pngBase64) {
      throw new DeviceError('device/permission-denied',
        `屏幕 ${args.observation} 没有截图可供坐标参照：先 screen {image:true} 拿一张图，再按它的坐标点。`);
    }
    const action = args.action || 'tap';
    if (action === 'swipe') {
      await dev('POST', '/ui/swipe', {
        fromX: args.x, fromY: args.y, toX: args.x2 ?? args.x, toY: args.y2 ?? args.y,
        durationMs: Math.min(2000, Math.max(100, args.duration_ms || 400)),
        reason: 'coordinate swipe',
      });
    } else {
      await dev('POST', '/ui/tap', { x: args.x, y: args.y, reason: `coordinate ${action}` });
      if (action === 'long') {
        await dev('POST', '/ui/swipe', { fromX: args.x, fromY: args.y, toX: args.x, toY: args.y, durationMs: 800, reason: 'long press' });
      }
    }
    return { text: `已执行 ${action}（${args.x},${args.y}）；先 screen 确认画面变化，再决定下一步。` };
  },

  async collect(args) {
    const snap = takeSnap(args.screen);
    const listEl = elementOf(snap, args.list);
    if (listEl.role !== '列表') {
      throw new DeviceError('args/invalid', `[${args.list}] 不是列表（角色：${listEl.role}）。`);
    }
    const maxPages = Math.min(30, Math.max(1, args.max_pages || 10));
    const seen = new Set();
    const rows = [];
    let cur = snap;
    for (let page = 0; page < maxPages; page++) {
      const list = cur.elements.find((e) => e.id === args.list) || listEl;
      for (const e of cur.elements) {
        if (e.id === args.list) continue;
        if (e.bounds[1] < list.bounds[1] - 2 || e.bounds[3] > list.bounds[3] + 2) continue;
        if (!e.label) continue;
        const key = `${e.role}|${e.label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(e.label);
      }
      if (args.until && rows.some((r) => r.includes(args.until))) break;
      const w = cur.width, h = cur.height;
      await dev('POST', '/ui/swipe', {
        fromX: Math.round(w / 2), fromY: Math.round(list.bounds[1] + (list.bounds[3] - list.bounds[1]) * 0.8),
        toX: Math.round(w / 2), toY: Math.round(list.bounds[1] + (list.bounds[3] - list.bounds[1]) * 0.25),
        durationMs: 400, reason: 'collect: page down',
      });
      await new Promise((r) => setTimeout(r, 450));
      const dump = await dev('POST', '/ui/dump', { includeInvisible: false, maxNodes: 1500 });
      const sid = nextScreenId();
      cur = { ...formatScreen(dump, { screenId: sid }), at: Date.now() };
      snaps.set(sid, cur);
    }
    const body = rows.length ? rows.map((r, i) => `${i + 1}. ${r}`).join('\n') : '（这个列表没有可读条目）';
    return { text: `共 ${rows.length} 条：\n${body}` };
  },

  async apps(args) {
    const data = await dev('GET', '/app/list?includeSystem=false');
    const q = (args.query || '').toLowerCase();
    const list = (data.apps || []).filter((a) =>
      !q || (a.label || '').toLowerCase().includes(q) || (a.packageName || '').toLowerCase().includes(q));
    if (!list.length) return { text: '没有匹配的应用。' };
    return { text: list.map((a) => `${a.label} · ${a.packageName}`).join('\n') };
  },

  async open(args) {
    if (args.url) {
      await dev('POST', '/app/start', { uri: args.url, reason: `open ${args.url}`.slice(0, 120) });
      return { text: `已请求打开 ${args.url}；用 screen 看落地页。` };
    }
    if (!args.app) throw new DeviceError('args/invalid', 'app 或 url 必须给一个。');
    const data = await dev('GET', '/app/list?includeSystem=false');
    const q = args.app.toLowerCase();
    const hit = (data.apps || []).find((a) =>
      a.packageName === args.app || (a.label || '').toLowerCase() === q || (a.label || '').toLowerCase().includes(q));
    if (!hit) throw new DeviceError('args/invalid', `没有找到应用「${args.app}」，用 apps 先列一遍。`);
    await dev('POST', '/app/start', { package: hit.packageName, reason: `open ${hit.label}` });
    return { text: `已请求打开 ${hit.label}（${hit.packageName}）；用 screen 看是否真的到了。` };
  },

  async shot(args) {
    const data = await dev('POST', '/ui/screenshot', { maxWidth: 1080 });
    if (args.save) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(args.save, Buffer.from(data.png_base64, 'base64'));
      return { text: `已保存到 ${args.save}（${data.width}x${data.height}）` };
    }
    return { text: `截图 ${data.width}x${data.height}（${data.bytes || 0} 字节）`, image: data.png_base64, imageMime: 'image/png' };
  },

  async clipboard(args) {
    if (args.set != null) {
      await dev('POST', '/clipboard', { text: String(args.set) });
      return { text: `已写入剪贴板 ${String(args.set).length} 字` };
    }
    const data = await dev('GET', '/clipboard');
    return { text: data.text || '（剪贴板为空或读不到）' };
  },

  async android_shell(args) {
    const data = await dev('POST', '/shell/exec', {
      command: args.command,
      timeoutMs: Math.min(60_000, Math.max(100, args.timeout_ms || 30_000)),
      reason: 'android shell',
    });
    return { text: `exit=${data.exitCode} uid=${data.uid}\n${data.stdout || ''}${data.stderr ? '\n[stderr]\n' + data.stderr : ''}` };
  },

  async device_status() {
    const caps = await dev('GET', '/capabilities');
    const lines = [
      `档位：${caps.tier}`,
      `设备：${caps.device?.model || '?'} · Android ${caps.device?.androidRelease || '?'}`,
      `可用：${Object.entries(caps.capabilities || {}).filter(([, v]) => v).map(([k]) => k).join(', ') || '（无）'}`,
      `不可用：${(caps.denied || []).map((d) => `${d.capability}（${d.hint}）`).join('；') || '（无）'}`,
    ];
    return { text: lines.join('\n') };
  },
};

// 离线测试用：不接设备也能验证格式化
export { formatScreen };

export const toolpack = {
  name: 'android-screen',
  description: '操作手机屏幕：读屏（带编号）、点按、输入、滚动、收列表、截图。编号只在本屏有效。',
  tools,
  handlers,
};


// --- TOOLPACKS-CONTRACT §3 注册 -------------------------------------------------
// 只做接线，不改上面任何工具实现：
//   * 契约要求包导出 meta，并要求每个工具带 run(args, ctx)；本包原本是 tools + handlers 两张表，
//     这里把 handlers 绑成 run。
//   * 契约 §3.3 要求有副作用的工具在 read-only 沙箱里先抛 sandbox/denied；守卫放在这一层，
//     工具内部仍然一行不动。
export const meta = {
  name: toolpack.name,
  title: 'Android Screen',
  version: '1.0.0',
  description: toolpack.description,
};

const SIDE_EFFECT_TOOLS = new Set(['tap', 'type', 'scroll', 'key', 'tap_xy', 'collect', 'open', 'android_shell']);
const READ_ONLY_MODES = new Set(['read-only', 'readonly', 'read_only']);

function assertSandboxAllows(ctx, tool, what) {
  const mode = String(ctx?.sandboxMode ?? '').toLowerCase();
  if (!ctx?.readOnly && !READ_ONLY_MODES.has(mode)) return;
  throw Object.assign(
    new Error(
      `${tool} ${what}, but this session runs in a read-only sandbox (sandbox_mode = read-only), so nothing was `
        + 'touched on the phone. Ask the user to switch sandbox_mode to workspace-write or danger-full-access and '
        + 'retry, or stay with the read-only tools screen and device_status.',
    ),
    { code: 'sandbox/denied' },
  );
}

function writesClipboard(args) {
  return Boolean(args && typeof args === 'object' && (args.text !== undefined || args.set !== undefined || args.write === true));
}

for (const tool of tools) {
  const handler = handlers[tool.name];
  if (typeof handler !== 'function') continue;
  tool.run = async (args, ctx) => {
    if (SIDE_EFFECT_TOOLS.has(tool.name)) assertSandboxAllows(ctx, tool.name, 'changes the phone');
    if (tool.name === 'clipboard' && writesClipboard(args)) assertSandboxAllows(ctx, 'clipboard', 'writes the clipboard');
    return handler(args, ctx);
  };
}
