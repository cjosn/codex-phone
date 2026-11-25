// device/uia.mjs — 用语义（文案）驱动 adb UI，而不是猜坐标
//
// 每次操作前自动 dump 一次，按 content-desc / text / hint 找元素，取中心点再点。
// 这样键盘弹起、页面滚动导致坐标漂移时依然稳。
//
//   node device/uia.mjs dump
//   node device/uia.mjs tap "添加 SSH 主机"
//   node device/uia.mjs type codex
//   node device/uia.mjs clear
//   node device/uia.mjs key BACK
//   node device/uia.mjs shot device/device.png
//   node device/uia.mjs wait 1500

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ADB = process.env.ADB_PATH || 'C:/Users/13721/Tools/platform-tools/adb.exe';
const adb = (...args) => execFileSync(ADB, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 });

function shell(cmd) {
  return adb('shell', cmd).toString('utf8');
}

function dump() {
  shell('uiautomator dump /sdcard/__uia.xml');
  const xml = adb('exec-out', 'cat', '/sdcard/__uia.xml').toString('utf8');
  const out = [];
  for (const m of xml.matchAll(/<node[^>]*>/g)) {
    const n = m[0];
    const attr = (k) => (n.match(new RegExp(k + '="([^"]*)"')) || [])[1] ?? '';
    const b = n.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
    if (!b) continue;
    out.push({
      cls: attr('class'),
      text: decode(attr('text')),
      desc: decode(attr('content-desc')),
      hint: decode(attr('hint')),
      clickable: attr('clickable') === 'true',
      x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4],
      cx: ((+b[1]) + (+b[3])) >> 1,
      cy: ((+b[2]) + (+b[4])) >> 1,
    });
  }
  return out;
}

// uiautomator 把换行写成 &#10;，中文有时是 UTF-8 被当 latin1 —— 先解实体
function decode(s) {
  if (!s) return s;
  return s.replace(/&#10;/g, '\n').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

function find(nodes, needle) {
  const n = needle.trim();
  // 先要完全同名（按钮的 content-desc 往往就是它的文案），否则「只保存在这台手机上」
  // 这种说明文本会把「保存」抢走。
  const exact = nodes.find((x) => x.desc === n || x.text === n);
  if (exact) return exact;
  const hit = nodes.find((x) => x.desc.startsWith(n) || x.text.startsWith(n) || x.hint.startsWith(n))
    || nodes.find((x) => x.desc.includes(n) || x.text.includes(n) || x.hint.includes(n));
  if (!hit) {
    const cand = nodes.filter((x) => x.desc || x.text || x.hint)
      .map((x) => (x.desc || x.text || x.hint).split('\n')[0]).slice(0, 24);
    throw new Error(`找不到「${n}」。当前可见：\n  ` + cand.join('\n  '));
  }
  return hit;
}

const [cmd, ...rest] = process.argv.slice(2);
const arg = rest.join(' ');

switch (cmd) {
  case 'dump': {
    for (const x of dump()) {
      const label = x.desc || x.text || x.hint;
      if (!label) continue;
      console.log(`${String(x.cy).padStart(4)} ${String(x.cx).padStart(4)} ${x.cls.split('.').pop().padEnd(12)} ${JSON.stringify(label.slice(0, 44))}`);
    }
    break;
  }
  case 'tapxy': {
    const [x, y] = rest.map(Number);
    shell(`input tap ${x} ${y}`);
    console.log(`tap ${x},${y}`);
    break;
  }
  case 'tap': {
    const x = find(dump(), arg);
    shell(`input tap ${x.cx} ${x.cy}`);
    console.log(`tap ${JSON.stringify(arg)} @ ${x.cx},${x.cy}`);
    break;
  }
  case 'type': {
    const b64 = Buffer.from(arg, 'utf8').toString('base64');
    shell(`am broadcast -a ADB_INPUT_B64 --es msg ${b64}`);
    console.log(`type ${JSON.stringify(arg)}`);
    break;
  }
  case 'clear': {
    shell('am broadcast -a ADB_CLEAR_TEXT');
    console.log('clear');
    break;
  }
  case 'key': {
    shell(`input keyevent KEYCODE_${arg}`);
    console.log(`key ${arg}`);
    break;
  }
  case 'swipe': {
    const [x1, y1, x2, y2, ms] = rest.map(Number);
    shell(`input swipe ${x1} ${y1} ${x2} ${y2} ${ms || 300}`);
    console.log('swipe');
    break;
  }
  case 'wait': {
    const ms = Number(rest[0] || 1000);
    await new Promise((r) => setTimeout(r, ms));
    console.log(`wait ${ms}`);
    break;
  }
  case 'shot': {
    const out = rest[0] || 'device/device.png';
    const png = adb('exec-out', 'screencap', '-p');
    writeFileSync(out, png);
    console.log('saved ' + out + ' (' + png.length + ' bytes)');
    break;
  }
  case 'focus': {
    console.log(shell(`dumpsys window | grep -E 'mCurrentFocus'`));
    break;
  }
  default:
    console.log('usage: dump | tap <文案> | type <文本> | clear | key <KEYCODE> | swipe x1 y1 x2 y2 ms | wait ms | shot [path] | focus');
}
