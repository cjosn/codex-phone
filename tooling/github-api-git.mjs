#!/usr/bin/env node
// GitHub's Git database API fallback. Import writes objects only, never refs/index.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const gitHash = (type, body) => createHash('sha1').update(Buffer.from(`${type} ${body.length}\0`)).update(body).digest('hex');
const validSha = sha => /^[a-f0-9]{40}$/.test(sha);
export function repositorySlug(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('Repo must be owner/name');
  return repo;
}
export function readToken(repo, env = process.env) {
  repositorySlug(repo);
  if (env.GITHUB_TOKEN || env.GH_TOKEN) return env.GITHUB_TOKEN || env.GH_TOKEN;
  try {
    const result = execFileSync('git', ['credential', 'fill'], {
      input: `protocol=https\nhost=github.com\npath=${repo}.git\n\n`, encoding: 'utf8',
      env: { ...env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'ignore'], timeout: 15000,
    });
    return /^password=(.*)$/m.exec(result)?.[1]?.replace(/\r$/, '') || '';
  } catch { return ''; }
}
export function githubClient(repo, { token = '', fetchImpl = fetch } = {}) {
  repositorySlug(repo);
  return async (endpoint, method = 'GET', body) => {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/${endpoint}`, {
      method, headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Codex-Pocket-Source', ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60000), redirect: 'error',
    });
    // Never print response bodies: errors can include request data or credentials.
    if (!response.ok) {
      const error = new Error(`GitHub API ${method} ${endpoint}: HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  };
}
export function writeObject(gitDir, type, body, expected) {
  body = Buffer.from(body);
  const sha = gitHash(type, body);
  if (expected && sha !== expected) throw new Error(`Git ${type} hash mismatch: ${expected}`);
  const target = path.join(gitDir, 'objects', sha.slice(0, 2), sha.slice(2));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const raw = Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]);
  if (fs.existsSync(target)) {
    if (!inflateSync(fs.readFileSync(target)).equals(raw)) throw new Error(`Existing Git object is corrupt: ${sha}`);
  } else fs.writeFileSync(target, deflateSync(raw), { flag: 'wx' });
  return sha;
}
function localObject(gitDir, sha) {
  if (!gitDir) return null;
  try {
    const loose = path.join(gitDir, 'objects', sha.slice(0, 2), sha.slice(2));
    if (fs.existsSync(loose)) {
      const raw = inflateSync(fs.readFileSync(loose));
      const zero = raw.indexOf(0), [type, size] = raw.subarray(0, zero).toString().split(' ');
      const body = raw.subarray(zero + 1);
      if (body.length !== Number(size) || gitHash(type, body) !== sha) throw new Error('Corrupt object');
      return { type, body };
    }
    const options = { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 128 * 1024 * 1024 };
    const type = execFileSync('git', [`--git-dir=${gitDir}`, 'cat-file', '-t', sha], options).toString().trim();
    const body = execFileSync('git', [`--git-dir=${gitDir}`, 'cat-file', type, sha], options);
    if (gitHash(type, body) !== sha) throw new Error('Corrupt object');
    return { type, body };
  } catch { return null; }
}
export function encodeTree(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path + (a.type === 'tree' ? '/' : '')), Buffer.from(b.path + (b.type === 'tree' ? '/' : ''))));
  return Buffer.concat(sorted.map(entry => {
    if (entry.path.includes('/') || entry.path.includes('\0') || !validSha(entry.sha)) throw new Error('Invalid tree entry');
    return Buffer.concat([Buffer.from(`${entry.mode.replace(/^0+/, '')} ${entry.path}\0`), Buffer.from(entry.sha, 'hex')]);
  }));
}
function treeChildren(body) {
  const entries = [];
  for (let offset = 0; offset < body.length;) {
    const space = body.indexOf(32, offset), zero = body.indexOf(0, space);
    if (space < 0 || zero < 0 || zero + 21 > body.length) throw new Error('Invalid Git tree');
    const mode = body.subarray(offset, space).toString();
    entries.push({ type: mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob', sha: body.subarray(zero + 1, zero + 21).toString('hex') });
    offset = zero + 21;
  }
  return entries;
}
const zones = ['+0000', ...Array.from({ length: 105 }, (_, i) => {
  const minutes = (i - 48) * 15;
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
}).filter(zone => zone !== '+0000')];
export function encodeCommit(commit) {
  // Signed GitHub commits expose the exact signed payload. Insert its signature
  // using Git's continuation-line format, then verify the complete object hash.
  if (commit.verification?.payload && commit.verification?.signature) {
    const payload = commit.verification.payload;
    const split = payload.indexOf('\n\n');
    const signature = commit.verification.signature.replace(/\n$/, '').replace(/\n/g, '\n ');
    const body = Buffer.from(`${payload.slice(0, split)}\ngpgsig ${signature}${payload.slice(split)}`);
    if (gitHash('commit', body) === commit.sha) return body;
  }
  const identity = (person, zone) => `${person.name} <${person.email}> ${Math.floor(Date.parse(person.date) / 1000)} ${zone}`;
  const prefix = `tree ${commit.tree.sha}\n${commit.parents.map(parent => `parent ${parent.sha}\n`).join('')}`;
  const messages = [...new Set([commit.message, `${commit.message}\n`])];
  // The API normalizes dates to UTC and loses original offsets. Offsets in
  // modern Git commits are normally quarter-hour multiples; never accept a
  // reconstruction until the upstream SHA-1 matches.
  for (const authorZone of zones) for (const committerZone of zones) for (const message of messages) {
    const body = Buffer.from(`${prefix}author ${identity(commit.author, authorZone)}\ncommitter ${identity(commit.committer, committerZone)}\n\n${message}`);
    if (gitHash('commit', body) === commit.sha) return body;
  }
  throw new Error(`Cannot reconstruct exact commit ${commit.sha}; original signature/encoding/timezone required`);
}
export async function importHistory({ repo, sha, gitDir, alternateGitDir, depth = 1, api = githubClient(repo, { token: readToken(repo) }) }) {
  if (!validSha(sha)) throw new Error('Expected a full commit SHA');
  if (!Number.isSafeInteger(depth) || depth < 1) throw new Error('Depth must be a positive integer');
  const seen = new Set(), shallow = new Set();
  let requests = 0;
  const get = async endpoint => { requests++; return api(endpoint); };
  async function visit(id, expectedType, level = 1) {
    if (seen.has(id)) return;
    seen.add(id);
    let object = localObject(gitDir, id) || localObject(alternateGitDir, id);
    if (!object) {
      if (expectedType === 'commit') object = { type: 'commit', body: encodeCommit(await get(`git/commits/${id}`)) };
      else if (expectedType === 'tree') object = { type: 'tree', body: encodeTree((await get(`git/trees/${id}`)).tree) };
      else {
        const blob = await get(`git/blobs/${id}`);
        if (blob.encoding !== 'base64') throw new Error(`Unsupported blob encoding: ${id}`);
        object = { type: 'blob', body: Buffer.from(blob.content.replace(/\s/g, ''), 'base64') };
      }
    }
    if (object.type !== expectedType) throw new Error(`Unexpected object type: ${id}`);
    writeObject(gitDir, object.type, object.body, id);
    if (object.type === 'commit') {
      const header = object.body.toString().split('\n\n')[0];
      await visit(/^tree ([a-f0-9]{40})$/m.exec(header)[1], 'tree');
      for (const match of header.matchAll(/^parent ([a-f0-9]{40})$/gm)) {
        if (level >= depth) shallow.add(id);
        else await visit(match[1], 'commit', level + 1);
      }
    } else if (object.type === 'tree') {
      for (const entry of treeChildren(object.body)) {
        if (entry.type === 'commit') throw new Error('Submodule import needs its own repository');
        await visit(entry.sha, entry.type);
      }
    }
  }
  await visit(sha, 'commit');
  return { sha, objects: seen.size, requests, gitDir: path.resolve(gitDir), shallow: [...shallow] };
}

function argsMap(args) {
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error('Expected --name value arguments');
    values[args[i].slice(2)] = args[i + 1];
  }
  return values;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, ...args] = process.argv.slice(2), options = argsMap(args);
    if (command !== 'import') throw new Error('Usage: github-api-git.mjs import --repo owner/name --sha FULL_SHA --git-dir SCRATCH [--alternate-git-dir OLD_GIT_DIR]');
    if (!options['git-dir']) throw new Error('--git-dir is required; import never updates refs or index');
    console.log(JSON.stringify(await importHistory({ repo: options.repo, sha: options.sha, gitDir: options['git-dir'], alternateGitDir: options['alternate-git-dir'], depth: Number(options.depth || 1) })));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
