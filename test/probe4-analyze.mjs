// 读 probe4 的原始日志，回答：404 模型时 codex 发了几次重试、错误文本是什么。
import { readFileSync } from 'node:fs';

const dir = 'tooling/sdk/user-state/local/probe4-run';
const upstream = readFileSync(`${dir}/upstream.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
console.log('upstream requests:', upstream.length, '| models:', [...new Set(upstream.map((row) => row.model))].join(','));

const messages = readFileSync(`${dir}/codex-messages.jsonl`, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
for (const message of messages) {
  const raw = message.raw ?? '';
  if (raw.includes('"method":"error"') || raw.includes('turn/completed') || raw.includes('turn/started')) {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* 保留原文 */ }
    const label = parsed?.method ?? '?';
    const detail = parsed?.params ?? raw;
    console.log(`--- t=${message.t}ms ${label}`);
    console.log(JSON.stringify(detail).slice(0, 900));
  }
}
