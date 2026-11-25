#!/usr/bin/env node
// Source publication policy. This file is the auditable allowlist; .gitignore
// alone is insufficient because tracked files bypass ignore rules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gitHash, encodeTree, githubClient, readToken, repositorySlug } from './github-api-git.mjs';

export const APP = 'dshgo-fork/dsh-Go-main/app/';
const FORK = 'dshgo-fork/dsh-Go-main/';
const KOTLIN = 'android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/';
const sourceExtensions = /\.(?:mjs|cjs|js|ts|json|md|txt|ps1|py|sh|ya?ml|gradle|kts|properties|xml|html|css|dart|kt|diff|patch|toml|pro)$/i;
const deniedSegments = /(^|\/)(?:\.git|node_modules|\.dart_tool|\.gradle|\.idea|\.vscode|\.pub-cache|\.pub|\.codex|\.ssh|\.aws|\.gnupg|user-data|build|coverage|__pycache__|\.cache|\.work|sdk|cache|stage|shots|runtime-out)(\/|$)/i;
export function exclusionReason(file) {
  const p = file.replaceAll('\\', '/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').some(part => part === '..' || part === '.')) return 'unsafe-path';
  if (deniedSegments.test(p) || /(^|\/)runtime\/out[^/]*(\/|$)/i.test(p)) return 'generated-or-local';
  if (/^device\/.*\.(?:json|xml|png|jpe?g)$/i.test(p)) return 'private-config';
  if (/(^|\/)(?:local\.properties|key\.properties|\.env(?:\..*)?|auth\.json|(?:channels-)?secrets\.json|credentials\.json|codex-go-(?:device|bridge|channels|secrets)\.json|ssh_host_key[^/]*)$/i.test(p)) return 'private-config';
  if (/\.(?:apk|aab|apks|tar(?:\.[a-z0-9]+)?|xz|gz|zip|7z|jks|keystore|p12|pfx|key|pem|log|pid|pyc|class|mp4|webm|hprof|exe|dll|so)$/i.test(p)) return 'binary-or-private';
  return '';
}
export function nativeFiles(root) {
  const gradle = path.join(root, APP, 'android/app/build.gradle.kts');
  if (!fs.existsSync(gradle)) return new Set();
  const text = fs.readFileSync(gradle, 'utf8');
  const block = /val\s+codexNativeFiles\s*=\s*setOf\(([\s\S]*?)\)\.map/.exec(text)?.[1];
  if (!block) throw new Error('Cannot parse codexNativeFiles; update source policy before publishing');
  return new Set([...block.matchAll(/"([^"\r\n]+\.kt)"/g)].map(match => APP + KOTLIN + match[1]));
}
export function isAllowed(file, { native = new Set() } = {}) {
  const p = file.replaceAll('\\', '/');
  if (exclusionReason(p)) return false;
  if (/^(?:\.gitignore|\.gitattributes|README\.md|HANDOFF-[^/]+\.md|CHECKLIST-[^/]+\.md|CONTINUE\.md|PLAN\.md|EXPORT-README\.md|RELEASE-[^/]+\.md|OPERIT-[^/]+\.md|dev-run-bridge\.ps1)$/.test(p)) return true;
  if (/^(?:bridge|docs|test|tooling|device|web|dsh-host)\//.test(p)) return sourceExtensions.test(p) || /(^|\/)(?:LICENSE|NOTICE|OFL\.txt)$/.test(p);
  if (!p.startsWith(FORK)) return false;
  const relative = p.slice(FORK.length);
  if (/^(?:LICENSE|THIRD_PARTY_NOTICES\.md|ASSETS\.md|CONTRIBUTING(?:\.en)?\.md|README(?:\.en)?\.md|AGENTS\.md|\.gitignore)$/.test(relative)) return true;
  // Runtime build inputs required by Codex, not the obsolete DSH overlay/vendor.
  if (/^runtime\/codex-go\/[^/]+\.(?:py|sh|mjs|json|md)$/.test(relative)) return true;
  if (/^runtime\/lib\/[^/]+\.(?:py|sh)$/.test(relative)) return true;
  if (/^runtime\/(?:build-runtime\.sh|\.gitignore)$/.test(relative)) return true;
  if (/^tooling\/(?:build_number\.py|build-apk\.sh)$/.test(relative)) return true;
  if (!p.startsWith(APP)) return false;
  const app = p.slice(APP.length);
  if (/^(?:pubspec\.(?:yaml|lock)|analysis_options\.yaml|l10n\.yaml|\.metadata|\.gitignore|README\.md)$/.test(app)) return true;
  if (app === 'lib/main.dart' || /^lib\/codex\/.*\.dart$/.test(app)) return true;
  if (/^lib\/l10n\/(?:parts\/.*\.arb|app_(?:en|zh)\.arb)$/.test(app) || app === 'tool/l10n_merge.py') return true;
  if (/^test\/(?:codex_pocket|support)\//.test(app)) return sourceExtensions.test(app);
  if (/^assets\/fonts\/JetBrainsMono-(?:Regular|Medium|Bold)\.ttf$/.test(app) || app === 'assets/fonts/OFL.txt' || app === 'assets/brand/codex-go.svg') return true;
  if (/^android\/(?:build\.gradle\.kts|settings\.gradle\.kts|gradle\.properties|gradlew(?:\.bat)?|gradle\/wrapper\/gradle-wrapper\.(?:properties|jar)|\.gitignore)$/.test(app)) return true;
  if (/^android\/app\/(?:build\.gradle\.kts|proguard-rules\.pro)$/.test(app)) return true;
  if (/^android\/app\/src\/(?:main|debug|profile)\/AndroidManifest\.xml$/.test(app)) return true;
  if (native.has(p)) return true;
  if (/^android\/app\/src\/(?:test|androidTest)\/kotlin\/.*\/codex\/.*\.kt$/.test(app)) return true;
  // Only the current Codex launcher, themes and referenced accessibility/network
  // resources. Old whale/companion/frost/ink artwork has no publication grant.
  if (/^android\/app\/src\/main\/res\/(?:mipmap-[^/]+\/ic_launcher(?:_round|_foreground)?\.(?:png|xml)|drawable(?:-v21)?\/(?:ic_launcher_(?:background|monochrome)|launch_background|launch_icon_none)\.xml|values[^/]*\/(?:styles|entry_colors|entry_strings)\.xml|xml\/codex_[^/]+\.xml|xml\/network_security_config\.xml)$/.test(app)) return true;
  return false;
}
const digest = value => createHash('sha256').update(value).digest('hex');
// Exceptions must name an exact path, category and SHA-256 of the matched
// synthetic token. Never exempt a directory or all tests. Changing a fixture
// requires reviewing and updating its digest. No exception contains a key.
export const SYNTHETIC_EXCEPTIONS = [
  { path: 'EXPORT-README.md', category: 'api-key', sha256: '221df437bc4f8c4d9718bd7a9ec4c1021c72fd69dfb2a5f568ecf4607c824bee', reason: 'Truncated hexadecimal example in export documentation, line 56' },
  { path: 'test/bridge-contract.test.mjs', category: 'api-key', sha256: 'cd11bb03fde6f82d6bb2cd353fa1440e903e7d2eac5d65210f90717bc94f8493', reason: 'Local HTTP mock stored-provider key and exact assertions, lines 414/424/530' },
  ...[
    ['50f206babd3102dd3f0a5c7f3ede92e8c31d7e0def8ad19873003d68c96cf7b5', 'Loopback chat proxy fixture, lines 171/227'],
    ['12c521683ebed75a51fc8b7003f9ba191130a0ffbc0a2d2a69011a02c1bdb1fd', 'Loopback Anthropic adapter fixture, lines 417/442'],
    ['ced5a3186164ca01b06b7bdddea062d6b9e76624d0aa5cba334a489242b1494c', 'Local registry mock relay and non-disclosure assertions, lines 735-801'],
    ['2efaebb7a751d9217415ed9aeda9e4a611945fb5a773088ed871e41e179e598b', 'Local registry mock official channel, lines 742-760'],
    ['f85871573fdc36bdee6cae86ce122895e34337cfec980bad3c6d35091cd2528b', 'Loopback model-catalog fixture, lines 770/778'],
    ['270169c8f9ad3b14433b7b1417f5ffaa49d19b1aa49da7bd9c7b542d1c61ce85', 'Loopback end-to-end chat fixture, lines 817/835'],
    ['4521c1cc240c2b09fe04a5e63252d4e55fa21ba3bca4897d98748e63476cb263', 'Loopback wire/auth mock suite, lines 976-1174'],
  ].map(([sha256, reason]) => ({ path: 'test/channels.test.mjs', category: 'api-key', sha256, reason })),
];
const patterns = [
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['api-key', /\bsk-[A-Za-z0-9_-]{8,}/g],
  ['private-key', /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ['channel-secret', /\bCODEX_GO_CHANNEL_[A-Z0-9_]+["']?\s*(?:=|:)\s*["']?([A-Za-z0-9_./+\-=]{12,})/g],
  ['url-credential', /https?:\/\/[^\s/@:'"]+:[^\s/@'"]{8,}@/g],
];
export function scanText(file, text, exceptions = SYNTHETIC_EXCEPTIONS) {
  const findings = [], allowed = [];
  for (const [category, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const value = category === 'channel-secret' ? match[1] : match[0];
      const item = { path: file, line: text.slice(0, match.index).split('\n').length, category };
      const exception = exceptions.find(entry => entry.path === file && entry.category === category && entry.sha256 === digest(value));
      (exception ? allowed : findings).push(item);
    }
  }
  return { findings, allowed };
}
function git(root, args, options = {}) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' }, ...options,
    });
  } catch { throw new Error(`git ${args[0]} failed (no command output logged)`); }
}
export function collectSources(root, { candidates, exceptions = SYNTHETIC_EXCEPTIONS } = {}) {
  root = path.resolve(root);
  const realRoot = fs.realpathSync(root);
  const paths = candidates || git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const native = nativeFiles(root), files = [], excluded = [], findings = [], allowed = [];
  for (const file of [...new Set(paths.map(p => p.replaceAll('\\', '/')))].sort()) {
    if (!isAllowed(file, { native })) { excluded.push({ path: file, category: exclusionReason(file) || 'outside-source-domains' }); continue; }
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) continue; // tracked deletion is omitted from the new snapshot
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsupported source file: ${file}`);
    const resolved = path.relative(realRoot, fs.realpathSync(absolute));
    if (resolved.startsWith('..' + path.sep) || path.isAbsolute(resolved)) throw new Error(`Source file escapes workspace: ${file}`);
    if (stat.size > 10 * 1024 * 1024) throw new Error(`Source file exceeds 10 MiB: ${file}`);
    const bytes = fs.readFileSync(absolute);
    const scan = scanText(file, bytes.toString('utf8'), exceptions);
    findings.push(...scan.findings); allowed.push(...scan.allowed);
    files.push({ path: file, size: bytes.length, sha256: digest(bytes), mode: /(?:\.sh|\/gradlew)$/.test(file) ? '100755' : '100644' });
  }
  return { files, excluded, findings, allowed, bytes: files.reduce((sum, file) => sum + file.size, 0) };
}
function requireCleanScan(manifest) {
  if (manifest.findings.length) {
    // Only path, line and category leave this module; no source snippets/values.
    for (const finding of manifest.findings) console.error(JSON.stringify(finding));
    throw new Error(`Source scan blocked: ${manifest.findings.length} potential secrets`);
  }
  if (!manifest.files.length) throw new Error('No source files selected');
}
function readSnapshot(root, manifest) {
  return manifest.files.map(file => {
    const bytes = fs.readFileSync(path.join(root, file.path));
    if (digest(bytes) !== file.sha256) throw new Error(`Source changed during sync: ${file.path}; rerun publication`);
    return { ...file, bytes, sha: gitHash('blob', bytes) };
  });
}
export function buildTree(files, writeTree) {
  const root = new Map();
  for (const file of files) {
    const pieces = file.path.split('/');
    let node = root;
    for (const piece of pieces.slice(0, -1)) {
      if (!node.has(piece)) node.set(piece, new Map());
      node = node.get(piece);
    }
    node.set(pieces.at(-1), file);
  }
  function visit(node) {
    const entries = [...node.entries()].map(([name, value]) => value instanceof Map
      ? { path: name, mode: '040000', type: 'tree', sha: visit(value) }
      : { path: name, mode: value.mode, type: 'blob', sha: value.sha });
    return writeTree(entries);
  }
  return visit(root);
}
export async function syncViaApi({ repo, branch, files, message, token, api = githubClient(repo, { token }) }) {
  if (!token) throw new Error('Source publication needs GITHUB_TOKEN, GH_TOKEN or a non-interactive Git credential');
  let parent = null, base = null;
  try {
    parent = (await api(`git/ref/heads/${branch}`)).object.sha;
    base = await api(`git/commits/${parent}`);
  } catch (error) {
    if (parent || ![404, 409].includes(error.status)) throw error;
    // Only a proven empty repository may receive a root source commit.
    let empty = false;
    try { empty = (await api('commits?per_page=1')).length === 0; }
    catch (probe) { if (probe.status === 409) empty = true; else throw probe; }
    if (!empty) throw new Error('Source branch is missing in a nonempty repository');
  }
  const expectedTree = buildTree(files, entries => gitHash('tree', encodeTree(entries)));
  if (expectedTree === base?.tree.sha) return parent;
  const existing = base ? await api(`git/trees/${base.tree.sha}?recursive=1`) : { tree: [] };
  if (existing.truncated) throw new Error('Remote source tree is truncated; use Git transport');
  const oldBlobs = new Set(existing.tree.filter(entry => entry.type === 'blob').map(entry => entry.sha));
  // Construct a complete snapshot, so excluded files cannot survive in the tip.
  // UTF-8 source can be embedded directly in one create-tree call. Only binary
  // build inputs need separate base64 blob calls (fonts / Gradle wrapper).
  const treeEntries = [];
  for (const file of files) {
    const entry = { path: file.path, mode: file.mode, type: 'blob' };
    const text = file.bytes.toString('utf8');
    if (!oldBlobs.has(file.sha) && Buffer.from(text, 'utf8').equals(file.bytes)) {
      treeEntries.push({ ...entry, content: text });
      continue;
    }
    if (!oldBlobs.has(file.sha)) {
      const blob = await api('git/blobs', 'POST', { content: file.bytes.toString('base64'), encoding: 'base64' });
      if (blob.sha !== file.sha) throw new Error(`Uploaded blob hash mismatch: ${file.path}`);
      oldBlobs.add(file.sha);
    }
    treeEntries.push({ ...entry, sha: file.sha });
  }
  const tree = await api('git/trees', 'POST', { tree: treeEntries });
  if (tree.sha !== expectedTree) throw new Error('Uploaded source tree hash mismatch');
  const commit = await api('git/commits', 'POST', { message, tree: tree.sha, parents: parent ? [parent] : [] });
  if (!parent) {
    await api('git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: commit.sha });
    return commit.sha;
  }
  // Recheck before updating; force:false also rejects a concurrent divergent
  // update after this read. Never retry by replacing a newer remote head.
  if ((await api(`git/ref/heads/${branch}`)).object.sha !== parent) throw new Error('Remote branch changed during source sync; rerun');
  await api(`git/refs/heads/${branch}`, 'PATCH', { sha: commit.sha, force: false });
  return commit.sha;
}
export async function syncSource({ root, repo, branch = 'main', message = 'chore: synchronize release source', transport = 'auto' }) {
  repositorySlug(repo);
  if (!/^[A-Za-z0-9_-]+$/.test(branch)) throw new Error('Unsupported branch name');
  if (!['auto', 'git', 'api'].includes(transport)) throw new Error('Transport must be auto, git or api');
  const manifest = collectSources(root);
  requireCleanScan(manifest);
  const files = readSnapshot(root, manifest);
  const token = readToken(repo);
  if (transport === 'api') return { sha: await syncViaApi({ repo, branch, files, message, token }), transport: 'api', files: files.length };
  // A private temporary repository avoids changing the user's index, refs,
  // staged work or working tree. Fetch and push always use normal HTTPS/TLS.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-source-'));
  const networkEnv = { ...process.env, GCM_INTERACTIVE: 'never', GIT_TERMINAL_PROMPT: '0' };
  if (token) {
    const slot = Number(networkEnv.GIT_CONFIG_COUNT || 0);
    networkEnv.GIT_CONFIG_COUNT = String(slot + 1);
    networkEnv[`GIT_CONFIG_KEY_${slot}`] = 'http.https://github.com/.extraHeader';
    networkEnv[`GIT_CONFIG_VALUE_${slot}`] = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  try {
    git(scratch, ['init', '--bare', '--quiet']);
    git(scratch, ['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
    try { git(scratch, ['fetch', '--quiet', '--depth=1', 'origin', `refs/heads/${branch}`], { env: networkEnv, timeout: 60000 }); }
    catch (error) {
      if (transport !== 'auto') throw error;
      return { sha: await syncViaApi({ repo, branch, files, message, token }), transport: 'api', files: files.length };
    }
    const parent = git(scratch, ['rev-parse', 'FETCH_HEAD']).trim();
    for (const file of files) {
      const sha = git(scratch, ['hash-object', '-w', '--stdin'], { input: file.bytes }).trim();
      if (sha !== file.sha) throw new Error(`Local blob hash mismatch: ${file.path}`);
    }
    const tree = buildTree(files, entries => git(scratch, ['mktree', '-z'], { input: entries.map(entry => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}\0`).join('') }).trim());
    if (tree === git(scratch, ['rev-parse', `${parent}^{tree}`]).trim()) return { sha: parent, transport: 'git', files: files.length };
    const sha = git(scratch, ['-c', 'user.name=Codex Pocket Release', '-c', 'user.email=codex-pocket-release@users.noreply.github.com', 'commit-tree', tree, '-p', parent], { input: message + '\n' }).trim();
    // Explicit fast-forward push only. Once fetch succeeds, a failed push is
    // fatal; API fallback must not conceal an auth error or concurrent change.
    git(scratch, ['push', '--quiet', 'origin', `${sha}:refs/heads/${branch}`], { env: networkEnv, timeout: 60000 });
    return { sha, transport: 'git', files: files.length };
  } finally {
    // This path is created above by mkdtempSync; never delete a caller path.
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function options(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || !args[i + 1]) throw new Error('Expected --name value');
    parsed[args[i].slice(2)] = args[i + 1];
  }
  return parsed;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command = 'scan', ...args] = process.argv.slice(2), opts = options(args), root = path.resolve(opts.root || path.join(import.meta.dirname, '..'));
    if (command === 'manifest' || command === 'scan') {
      const manifest = collectSources(root);
      if (command === 'manifest') console.log(JSON.stringify(manifest, null, 2));
      else {
        for (const finding of manifest.findings) console.log(JSON.stringify(finding));
        console.log(JSON.stringify({ files: manifest.files.length, bytes: manifest.bytes, excluded: manifest.excluded.length, findings: manifest.findings.length, synthetic: manifest.allowed.length }));
      }
      if (manifest.findings.length) process.exitCode = 1;
    } else if (command === 'sync') console.log(JSON.stringify(await syncSource({ root, repo: opts.repo, branch: opts.branch, message: opts.message, transport: opts.transport })));
    else if (command === 'credential') {
      // PowerShell captures this command in memory; never invoke it to a log.
      process.stdout.write(readToken(opts.repo));
    } else throw new Error('Usage: source-control.mjs scan|manifest|sync [--root PATH] [--repo owner/name] [--transport auto|git|api]');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
