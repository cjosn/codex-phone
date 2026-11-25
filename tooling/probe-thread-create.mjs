// 一次性探针：起桥 + 假 codex，问 /api/thread/create 到底回了什么。
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('.');
const home = await mkdtemp(path.join(os.tmpdir(), 'probe-create-'));
await mkdir(path.join(home, 'none'), { recursive: true });
const outPath = path.join(home, 'out.log');
const errPath = path.join(home, 'err.log');
const { open } = await import('node:fs/promises');
const out = await open(outPath, 'w');
const err = await open(errPath, 'w');

const child = spawn(process.execPath, [
  path.join(root, 'bridge/server.mjs'),
  '--codex', process.execPath, '--codex-arg', path.join(root, 'test/protocol-fixture.mjs'),
  '--codex-home', home, '--cwd', home,
  '--toolpacks', path.join(home, 'none'), '--plugins', path.join(home, 'none'),
  '--host', '127.0.0.1', '--port', '0', '--token', 'tok',
], { stdio: ['ignore', out.fd, err.fd] });

const wait = async () => {
  for (let i = 0; i < 200; i++) {
    await new Promise(r => setTimeout(r, 100));
    const text = await readFile(outPath, 'utf8').catch(() => '');
    const match = text.match(/codex-go: (http:\/\/127\.0\.0\.1:\d+)\//);
    if (match) return match[1];
  }
  throw new Error('bridge did not start: ' + await readFile(errPath, 'utf8'));
};

try {
  const base = await wait();
  const response = await fetch(`${base}/api/thread/create`, {
    method: 'POST',
    headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: home }),
  });
  const body = await response.json();
  console.log('status', response.status);
  console.log('keys', Object.keys(body));
  console.log('developerInstructions type', typeof body.developerInstructions);
  console.log(JSON.stringify(body).slice(0, 400));
} finally {
  child.kill();
  await new Promise(r => setTimeout(r, 500));
}
