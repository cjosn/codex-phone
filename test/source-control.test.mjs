import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP, isAllowed, exclusionReason, scanText, collectSources, nativeFiles, SYNTHETIC_EXCEPTIONS, buildTree, syncViaApi, syncSource } from '../tooling/source-control.mjs';
import { gitHash, encodeTree, encodeCommit, writeObject, importHistory, githubClient } from '../tooling/github-api-git.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const repo = 'cjosn/codex-phone';
const nativeRoot = APP + 'android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/';
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-source-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function put(dir, file, content) {
  const target = path.join(dir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}
function inventory(dir) {
  const result = {};
  function visit(base, prefix = '') {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const file = prefix + entry.name;
      if (entry.isDirectory()) visit(path.join(base, entry.name), file + '/');
      else result[file] = sha256(fs.readFileSync(path.join(base, entry.name)));
    }
  }
  visit(dir);
  return result;
}

test('publication domains include maintained bridge, docs and reproducible Codex inputs', () => {
  const positive = [
    'README.md', 'HANDOFF-2026-11-25.md', '.gitignore', 'docs/RELEASE-CHECKLIST.md',
    'bridge/server.mjs', 'bridge/adapter.mjs', 'bridge/toolpacks/android/index.mjs',
    'test/bridge-contract.test.mjs', 'tooling/publish-source.ps1', 'device/android-screen.mjs',
    APP + 'lib/main.dart', APP + 'lib/codex/new_feature.dart', APP + 'pubspec.lock',
    APP + 'lib/l10n/parts/chat_en.arb', APP + 'lib/l10n/app_zh.arb', APP + 'tool/l10n_merge.py',
    APP + 'test/codex_pocket/new_feature_test.dart', APP + 'test/support/fonts.dart',
    APP + 'assets/fonts/JetBrainsMono-Regular.ttf', APP + 'assets/fonts/OFL.txt', APP + 'assets/brand/codex-go.svg',
    APP + 'android/gradle/wrapper/gradle-wrapper.jar', APP + 'android/gradlew',
    APP + 'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_foreground.png',
    APP + 'android/app/src/main/res/xml/codex_device_accessibility.xml',
    'dshgo-fork/dsh-Go-main/LICENSE', 'dshgo-fork/dsh-Go-main/ASSETS.md',
    'dshgo-fork/dsh-Go-main/THIRD_PARTY_NOTICES.md', 'dshgo-fork/dsh-Go-main/runtime/codex-go/verify-runtime.py',
  ];
  for (const file of positive) assert.equal(isAllowed(file), true, file);
});

test('tracked files cannot bypass safety exclusions, private data or artwork policy', () => {
  const negative = [
    'dist/release.apk', 'tooling/cache/big.json', 'tooling/sdk/config.json', 'bridge/node_modules/x/index.mjs',
    'bridge/.env', 'bridge/.env.production', 'device/ssh_host_key', 'device/ssh_host_key.pub',
    'bridge/auth.json', 'bridge/channels-secrets.json', 'bridge/credentials.json', 'bridge/private.pem',
    'bridge/codex-go-secrets.json', 'bridge/codex-go-channels.json', 'bridge/user-data/state.json',
    'tooling/.codex/config.toml', 'device/private-config.json',
    'bridge-home/codex-go-secrets.json', APP + 'android/local.properties', APP + 'android/key.properties',
    APP + 'android/release.jks', APP + 'build/generated.json', APP + '.dart_tool/package_config.json',
    APP + 'assets/brand/whale.svg', APP + 'assets/fonts/DshIcons.ttf', APP + 'lib/companion/old.dart',
    APP + 'android/app/src/main/res/mipmap-mdpi/ic_launcher_night.png',
    APP + 'android/app/src/main/res/drawable-nodpi/companion_widget_idle.png',
    'dshgo-fork/dsh-Go-main/packages/dartssh2/test/fixtures/id_rsa',
    'dshgo-fork/dsh-Go-main/runtime/out/arm64-v8a/assets/runtime/manifest.json',
    'dshgo-fork/dsh-Go-main/runtime/out-tawcroot/a.json',
    'dshgo-fork/dsh-Go-main/runtime/stage/x.json',
    '../docs/secret.md', 'docs/../../secret.md', '/docs/absolute.md', 'C:/docs/absolute.md',
  ];
  for (const file of negative) assert.equal(isAllowed(file), false, file);
  assert.equal(exclusionReason('tooling/cache/a.json'), 'generated-or-local');
  assert.equal(exclusionReason(APP + 'android/key.properties'), 'private-config');
});

test('Kotlin allowlist is reparsed at scan time, including newly registered modules', t => {
  const dir = temp(t), gradle = APP + 'android/app/build.gradle.kts';
  put(dir, gradle, 'val codexNativeFiles = setOf("MainActivity.kt").map { it }');
  put(dir, nativeRoot + 'MainActivity.kt', 'class MainActivity');
  put(dir, nativeRoot + 'codex/AddedLater.kt', 'class AddedLater');
  const candidates = [gradle, nativeRoot + 'MainActivity.kt', nativeRoot + 'codex/AddedLater.kt'];
  assert.equal(collectSources(dir, { candidates }).files.length, 2);
  put(dir, gradle, 'val codexNativeFiles = setOf("MainActivity.kt", "codex/AddedLater.kt").map { it }');
  assert(nativeFiles(dir).has(nativeRoot + 'codex/AddedLater.kt'));
  assert.equal(collectSources(dir, { candidates }).files.length, 3);
  put(dir, gradle, 'val renamedList = listOf("MainActivity.kt")');
  assert.throws(() => nativeFiles(dir), /Cannot parse codexNativeFiles/);
});

test('secret findings contain only path, line, category for real-shaped positive cases', () => {
  const cases = [
    ['github-token', 'gh' + 'p_' + 'a'.repeat(36)],
    ['github-token', 'github' + '_pat_' + 'z'.repeat(60)],
    ['api-key', 's' + 'k-' + 'realisticRandom'.repeat(4)],
    ['private-key', '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----'],
    ['private-key', '-----BEGIN ' + 'RSA PRIVATE KEY-----'],
    ['aws-access-key', 'AK' + 'IA' + 'A'.repeat(16)],
    ['channel-secret', 'CODEX_GO_' + 'CHANNEL_A_KEY="' + 'hiddenValue'.repeat(4) + '"'],
    ['channel-secret', '"CODEX_GO_' + 'CHANNEL_A_KEY": "' + 'hiddenValue'.repeat(4) + '"'],
    ['url-credential', 'https://user:' + 'notForTheLog' + '@example.com'],
  ];
  for (const [category, value] of cases) {
    const { findings, allowed } = scanText('docs/new.md', 'heading\n' + value);
    assert.equal(allowed.length, 0);
    assert(findings.some(finding => finding.category === category), category);
    for (const finding of findings) {
      assert.deepEqual(Object.keys(finding).sort(), ['category', 'line', 'path']);
      assert.equal(finding.line, 2);
      assert(!JSON.stringify(finding).includes(value));
    }
  }
});

test('secret negative examples and exact synthetic exceptions do not exempt arbitrary tests', () => {
  const harmless = 'process.env.GITHUB_TOKEN; "CODEX_GO_CHANNEL_A_KEY"; ghp_xxx; sk-...; public SSH key; token = process.env.TOKEN;';
  assert.deepEqual(scanText('test/new.test.mjs', harmless).findings, []);
  const value = 's' + 'k-' + 'synthetic-value-only';
  const exception = { path: 'test/exact.test.mjs', category: 'api-key', sha256: sha256(value), reason: 'unit mock' };
  assert.equal(scanText(exception.path, value, [exception]).allowed.length, 1);
  assert.equal(scanText('test/other.test.mjs', value, [exception]).findings.length, 1);
  assert.equal(scanText(exception.path, value + '-changed', [exception]).findings.length, 1);
  assert.equal(scanText(exception.path, value, [{ ...exception, category: 'github-token' }]).findings.length, 1);
  for (const entry of SYNTHETIC_EXCEPTIONS) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert(!entry.path.includes('*'));
    assert(entry.reason.length > 15);
  }
});

test('collector filters explicitly tracked private files and scans every allowed document', t => {
  const dir = temp(t), secret = 's' + 'k-' + 'must-be-blocked-123456789';
  put(dir, 'README.md', '# Public source');
  put(dir, 'docs/new.md', secret);
  put(dir, 'bridge/auth.json', JSON.stringify({ token: secret }));
  const manifest = collectSources(dir, { candidates: ['README.md', 'docs/new.md', 'bridge/auth.json'] });
  assert.deepEqual(manifest.files.map(file => file.path), ['README.md', 'docs/new.md']);
  assert.deepEqual(manifest.findings, [{ path: 'docs/new.md', line: 1, category: 'api-key' }]);
  assert.equal(manifest.excluded[0].category, 'private-config');
  assert(!JSON.stringify(manifest).includes(secret));
});

test('collector refuses a source directory junction outside the workspace', t => {
  const dir = temp(t), external = temp(t);
  put(external, 'external.md', 'private user data');
  fs.symlinkSync(external, path.join(dir, 'docs'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => collectSources(dir, { candidates: ['docs/external.md'] }), /escapes workspace/);
});

test('sync blocks secret-bearing source before credentials, network or writes', async t => {
  const dir = temp(t);
  execFileSync('git', ['init', '--quiet', dir]); // private test repo; never commit, stage or push
  put(dir, 'README.md', 's' + 'k-' + 'blocked-value-in-unit-fixture');
  const before = inventory(dir), messages = [], original = console.error;
  console.error = message => messages.push(message);
  try { await assert.rejects(syncSource({ root: dir, repo, transport: 'api' }), /Source scan blocked/); }
  finally { console.error = original; }
  assert.deepEqual(inventory(dir), before);
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(messages[0]), { path: 'README.md', line: 1, category: 'api-key' });
});

test('Git tree encoding and source modes match Git object hashing', t => {
  const dir = temp(t), bytes = Buffer.from('source\n');
  const blob = gitHash('blob', bytes);
  const entries = [
    { path: 'z', mode: '100644', type: 'blob', sha: blob },
    { path: 'a', mode: '040000', type: 'tree', sha: blob },
    { path: 'a.txt', mode: '100644', type: 'blob', sha: blob },
  ];
  const tree = encodeTree(entries);
  const actual = execFileSync('git', ['hash-object', '--stdin', '-t', 'tree'], { cwd: dir, input: tree, encoding: 'utf8' }).trim();
  assert.equal(actual, gitHash('tree', tree));
  assert.throws(() => encodeTree([{ ...entries[0], path: 'nested/file' }]), /Invalid tree entry/);
});

test('commit reconstruction verifies UTC, non-UTC and signed payload hashes', () => {
  const commit = {
    tree: { sha: '1'.repeat(40) }, parents: [{ sha: '2'.repeat(40) }], message: 'test commit',
    author: { name: 'A', email: 'a@example.com', date: '2026-11-25T08:00:00Z' },
    committer: { name: 'B', email: 'b@example.com', date: '2026-11-25T08:01:00Z' },
  };
  const prefix = `tree ${commit.tree.sha}\nparent ${commit.parents[0].sha}\n`;
  for (const [az, cz] of [['+0000', '+0000'], ['+0530', '+0800']]) {
    const raw = Buffer.from(`${prefix}author A <a@example.com> 1795593600 ${az}\ncommitter B <b@example.com> 1795593660 ${cz}\n\ntest commit\n`);
    assert.deepEqual(encodeCommit({ ...commit, sha: gitHash('commit', raw) }), raw);
  }
  const payload = `${prefix}author A <a@example.com> 1795593600 +0000\ncommitter B <b@example.com> 1795593660 +0000\n\ntest commit\n`;
  const signature = '-----BEGIN PGP SIGNATURE-----\nsynthetic signature\n-----END PGP SIGNATURE-----\n';
  const raw = Buffer.from(payload.replace('\n\ntest', `\ngpgsig ${signature.trimEnd().replaceAll('\n', '\n ')}\n\ntest`));
  assert.deepEqual(encodeCommit({ ...commit, sha: gitHash('commit', raw), verification: { payload, signature } }), raw);
});

test('API import depth one verifies complete tip and reports boundary without refs/index', async t => {
  const dir = temp(t), blob = Buffer.from('README\n'), blobSha = gitHash('blob', blob);
  const tree = encodeTree([{ path: 'README.md', mode: '100644', type: 'blob', sha: blobSha }]);
  const treeSha = gitHash('tree', tree);
  const raw = Buffer.from(`tree ${treeSha}\nparent ${'3'.repeat(40)}\nauthor A <a@example.com> 1795593600 +0000\ncommitter A <a@example.com> 1795593600 +0000\n\ninitial\n`);
  const sha = gitHash('commit', raw), calls = [];
  const api = async endpoint => {
    calls.push(endpoint);
    if (endpoint === `git/commits/${sha}`) return { sha, tree: { sha: treeSha }, parents: [{ sha: '3'.repeat(40) }], author: { name: 'A', email: 'a@example.com', date: '2026-11-25T08:00:00Z' }, committer: { name: 'A', email: 'a@example.com', date: '2026-11-25T08:00:00Z' }, message: 'initial' };
    if (endpoint === `git/trees/${treeSha}`) return { tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blobSha }] };
    if (endpoint === `git/blobs/${blobSha}`) return { content: blob.toString('base64'), encoding: 'base64' };
    throw new Error('Unexpected parent fetch');
  };
  const imported = await importHistory({ repo, sha, gitDir: dir, api, depth: 1 });
  assert.equal(imported.objects, 3);
  assert.equal(imported.requests, 3);
  assert.deepEqual(imported.shallow, [sha]);
  assert.deepEqual(fs.readdirSync(dir), ['objects']);
  assert.equal(calls.length, 3);
  const offline = await importHistory({ repo, sha, gitDir: dir, api: () => { throw new Error('Network forbidden'); }, depth: 1 });
  assert.equal(offline.requests, 0);
  const other = temp(t);
  const reused = await importHistory({ repo, sha, gitDir: other, alternateGitDir: dir, api: () => { throw new Error('Network forbidden'); } });
  assert.equal(reused.requests, 0);
  assert.throws(() => writeObject(other, 'blob', 'corrupt', blobSha), /hash mismatch/);
  fs.writeFileSync(path.join(other, 'objects', blobSha.slice(0, 2), blobSha.slice(2)), 'corrupt compressed object');
  assert.throws(() => writeObject(other, 'blob', blob, blobSha));
});

test('GitHub API error output omits response bodies and credential values', async () => {
  const value = 'never-log-this-value';
  let request;
  const api = githubClient(repo, { token: value, fetchImpl: async (url, options) => { request = { url, options }; return { ok: false, status: 403, json: () => { throw new Error(value); } }; } });
  await assert.rejects(api('git/ref/heads/main'), error => error.status === 403 && !error.message.includes(value));
  assert.equal(request.options.headers.Authorization, `Bearer ${value}`);
  assert.equal(request.options.redirect, 'error');
});

function apiFixture({ unchanged = false, race = false, wrongBlob = false, empty = false, wrongTree = false } = {}) {
  const bytes = wrongBlob ? Buffer.from([255, 0, 1, 2]) : Buffer.from('# Public source\n'), sha = gitHash('blob', bytes);
  const files = [{ path: 'README.md', mode: '100644', sha, bytes }];
  const expectedTree = buildTree(files, entries => gitHash('tree', encodeTree(entries)));
  const parent = '1'.repeat(40), commit = '2'.repeat(40), calls = [];
  let reads = 0;
  const api = async (endpoint, method = 'GET', body) => {
    calls.push({ endpoint, method, body });
    if (endpoint === 'git/ref/heads/main') {
      if (empty) { const error = new Error('Empty'); error.status = 404; throw error; }
      return { object: { sha: race && ++reads > 1 ? '3'.repeat(40) : parent } };
    }
    if (endpoint === 'commits?per_page=1') { const error = new Error('Empty'); error.status = 409; throw error; }
    if (endpoint === `git/commits/${parent}`) return { tree: { sha: unchanged ? expectedTree : '4'.repeat(40) } };
    if (endpoint.startsWith('git/trees/') && method === 'GET') return { tree: [] };
    if (endpoint === 'git/blobs') return { sha: wrongBlob ? '0'.repeat(40) : sha };
    if (endpoint === 'git/trees') return { sha: wrongTree ? '0'.repeat(40) : expectedTree };
    if (endpoint === 'git/commits') return { sha: commit };
    if (endpoint === 'git/refs/heads/main' || endpoint === 'git/refs') return { object: { sha: commit } };
    throw new Error(`Unexpected API fixture endpoint ${endpoint}`);
  };
  return { files, parent, commit, calls, api };
}

test('API source publication preserves current main as parent and refuses force', async () => {
  const fixture = apiFixture();
  const result = await syncViaApi({ repo, branch: 'main', message: 'sync', token: 'unit-token', ...fixture });
  assert.equal(result, fixture.commit);
  assert(!fixture.calls.some(call => call.endpoint === 'git/blobs'));
  assert.equal(fixture.calls.find(call => call.endpoint === 'git/trees').body.tree[0].content, '# Public source\n');
  assert.deepEqual(fixture.calls.find(call => call.endpoint === 'git/commits').body.parents, [fixture.parent]);
  const update = fixture.calls.at(-1);
  assert.equal(update.method, 'PATCH');
  assert.deepEqual(update.body, { sha: fixture.commit, force: false });
});

test('unchanged API source publication is read only and missing auth never calls API', async () => {
  const fixture = apiFixture({ unchanged: true });
  assert.equal(await syncViaApi({ repo, branch: 'main', message: 'sync', token: 'unit-token', ...fixture }), fixture.parent);
  assert(fixture.calls.every(call => call.method === 'GET'));
  fixture.calls.length = 0;
  await assert.rejects(syncViaApi({ repo, branch: 'main', message: 'sync', token: '', ...fixture }), /needs GITHUB_TOKEN/);
  assert.equal(fixture.calls.length, 0);
});

test('API source publication aborts races and hash mismatches before updating branch', async () => {
  for (const options of [{ race: true }, { wrongBlob: true }, { wrongTree: true }]) {
    const fixture = apiFixture(options);
    await assert.rejects(syncViaApi({ repo, branch: 'main', message: 'sync', token: 'unit-token', ...fixture }), /changed|mismatch/);
    assert(!fixture.calls.some(call => call.method === 'PATCH'));
  }
});

test('proven empty repository receives a source root commit and new ref', async () => {
  const fixture = apiFixture({ empty: true });
  await syncViaApi({ repo, branch: 'main', message: 'sync', token: 'unit-token', ...fixture });
  assert.deepEqual(fixture.calls.find(call => call.endpoint === 'git/commits').body.parents, []);
  assert.deepEqual(fixture.calls.at(-1), { endpoint: 'git/refs', method: 'POST', body: { ref: 'refs/heads/main', sha: fixture.commit } });
});

const psQuote = value => "'" + value.replaceAll("'", "''") + "'";
function runRelease(t, { verify = true, repoMissing = false, sourceFails = false, tagMismatch = false, runtimeFails = false, anonymous = false } = {}) {
  const dir = temp(t);
  const releaseScript = fs.readFileSync(path.join(root, 'tooling/publish-release.ps1'));
  put(dir, 'tooling/publish-release.ps1', releaseScript);
  const sourceSha = 'a'.repeat(40);
  put(dir, 'tooling/publish-source.ps1', '\ufeff' + (sourceFails ? "throw 'synthetic sync failed'\n" : `$global:LASTEXITCODE=0\nreturn '${sourceSha}'\n`));
  put(dir, 'tooling/upload-runtime-curl.ps1', '\ufeff$global:LASTEXITCODE=0\n');
  const apk = put(dir, 'dist/Codex-Pocket-9.9.9-arm64.apk', 'unit apk');
  const tar = put(dir, 'dist/runtime-arm64-v8a.tar.xz', 'unit runtime');
  const manifest = put(dir, 'dist/latest.json', 'existing manifest must survive verification');
  const script = `
$ErrorActionPreference='Stop'
$env:GITHUB_TOKEN=${anonymous ? "''" : "'unit-token'"}
$env:GH_TOKEN=''
$global:calls=New-Object 'System.Collections.Generic.List[object]'
$global:apkHash=(Get-FileHash ${psQuote(apk)} -Algorithm SHA256).Hash.ToLower()
$global:runtimeHash=(Get-FileHash ${psQuote(tar)} -Algorithm SHA256).Hash.ToLower()
$global:release=@{id=10; tag_name='v9.9.9'; assets=@(
 @{id=1;name='Codex-Pocket-9.9.9-arm64.apk';digest="sha256:$global:apkHash"},
 @{id=2;name='latest.json'}, @{id=3;name='runtime-arm64-v8a.json'}
)}
function global:Invoke-RestMethod {
 param($Method,$Uri,$Headers,$ErrorAction,$Body,$ContentType)
 $call=@{method="$Method";url="$Uri"}
 if ($Body) { $call.body=$Body|ConvertFrom-Json }
 $global:calls.Add($call)
 if (${verify ? '$true' : '$false'} -and $Method -ne 'GET') { throw 'VerifyOnly attempted a write' }
 if ($Uri -eq 'https://api.github.com/repos/cjosn/codex-phone') {
  if (${repoMissing ? '$true' : '$false'}) { throw 'synthetic inaccessible repo' }
  return @{full_name='cjosn/codex-phone';visibility='public'}
 }
 if ($Uri -like '*/git/matching-refs/tags/*') {
  if (${tagMismatch ? '$true' : '$false'}) { return @{ref='refs/tags/v9.9.9';object=@{type='commit';sha=('b'*40)}} }
  return @()
 }
 if ($Uri -like '*/commits/v9.9.9') { return @{sha='${sourceSha}'} }
 if ($Uri -like '*/releases/latest' -or $Uri -like '*/releases/tags/*') {
  if (-not ${verify ? '$true' : '$false'} -and $Uri -like '*/releases/tags/*') { throw 'synthetic missing release' }
  return $global:release
 }
 if ($Method -eq 'POST' -and $Uri -like '*/releases') { return $global:release }
 if ($Method -eq 'DELETE' -and $Uri -like '*/releases/assets/*') { return $null }
 throw "Unexpected API call $Method $Uri"
}
function global:Invoke-WebRequest {
 param($Uri,$Headers,[switch]$UseBasicParsing)
 $global:calls.Add(@{method='GET';url="$Uri"})
 if ($Uri -like '*/assets/2') { return @{Content=(@{version='9.9.9';sha256=$global:apkHash}|ConvertTo-Json -Compress)} }
 if ($Uri -like '*/assets/3') { return @{Content=(@{sha256=$global:runtimeHash;url='https://api.github.com/repos/cjosn/codex-phone/releases/assets/4'}|ConvertTo-Json -Compress)} }
 throw 'Unexpected asset JSON'
}
function global:curl.exe {
 $global:LASTEXITCODE=0
 if ($args -contains '-X') { return '{"id":999}' }
 $global:calls.Add(@{method='GET';url='runtime-range-probe'})
 return '${runtimeFails ? '403' : '206'}'
}
$failed=$false; $message=''
try { & ${psQuote(path.join(dir, 'tooling/publish-release.ps1'))} -Repo cjosn/codex-phone -Version 9.9.9 -CreateRepo ${verify ? '-VerifyOnly' : ''} }
catch { $failed=$true; $message=$_.Exception.Message }
Write-Output ('RESULT='+(@{failed=$failed;message=$message;calls=$global:calls.ToArray()}|ConvertTo-Json -Depth 12 -Compress))
`;
  const driver = put(dir, 'release-test-driver.ps1', '\ufeff' + script);
  const before = inventory(dir);
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver], { encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_USE_ENV_PROXY: '0' } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split(/\r?\n/).find(line => line.startsWith('RESULT='));
  assert(line, result.stdout + '\n' + result.stderr);
  return { ...JSON.parse(line.slice(7)), before, after: inventory(dir), stdout: result.stdout, manifest, sourceSha };
}

test('VerifyOnly executes all seven checks, only reads API and preserves every local byte', { skip: process.platform !== 'win32' }, t => {
  const result = runRelease(t);
  assert.equal(result.failed, false, result.message);
  assert.deepEqual(result.after, result.before);
  assert(result.calls.every(call => call.method === 'GET'));
  assert.equal((result.stdout.match(/  OK\s/g) || []).length, 7);
  assert(result.calls.some(call => call.url === 'runtime-range-probe'));
});

test('VerifyOnly works anonymously for public releases without credential lookup', { skip: process.platform !== 'win32' }, t => {
  const result = runRelease(t, { anonymous: true });
  assert.equal(result.failed, false, result.message);
  assert.deepEqual(result.after, result.before);
  assert(result.calls.every(call => call.method === 'GET'));
  assert.equal((result.stdout.match(/  OK\s/g) || []).length, 7);
});

test('VerifyOnly with CreateRepo cannot create an inaccessible repository', { skip: process.platform !== 'win32' }, t => {
  const result = runRelease(t, { repoMissing: true });
  assert.equal(result.failed, true);
  assert.deepEqual(result.after, result.before);
  assert.equal(result.calls.length, 1);
  assert(result.calls.every(call => call.method === 'GET'));
});

test('failed source synchronization blocks manifest writes and release creation', { skip: process.platform !== 'win32' }, t => {
  const result = runRelease(t, { verify: false, sourceFails: true });
  assert.equal(result.failed, true);
  assert.match(result.message, /synthetic sync failed/);
  assert.deepEqual(result.after, result.before);
  assert(result.calls.every(call => call.method === 'GET'));
  assert(!result.calls.some(call => call.url.includes('/releases')));
});

test('release creation targets the synchronized commit and preserves seven runtime checks', { skip: process.platform !== 'win32' }, t => {
  const result = runRelease(t, { verify: false });
  assert.equal(result.failed, false, result.message);
  const create = result.calls.find(call => call.method === 'POST' && call.url.endsWith('/releases'));
  assert.equal(create.body.target_commitish, result.sourceSha);
  assert.equal((result.stdout.match(/  OK\s/g) || []).length, 7);
  const bytes = fs.readFileSync(result.manifest);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
  assert.equal(JSON.parse(bytes).version, '9.9.9');
});

test('existing tag on another commit blocks release and manifest writes', { skip: process.platform !== 'win32' }, t => {
  const result = runRelease(t, { verify: false, tagMismatch: true });
  assert.equal(result.failed, true);
  assert.deepEqual(result.after, result.before);
  assert(!result.calls.some(call => call.method !== 'GET'));
});

test('VerifyOnly still fails the runtime range-download check when it is inaccessible', { skip: process.platform !== 'win32' }, t => {
  const result = runRelease(t, { runtimeFails: true });
  assert.equal(result.failed, true);
  assert.deepEqual(result.after, result.before);
  assert(result.calls.every(call => call.method === 'GET'));
  assert.equal((result.stdout.match(/  OK\s/g) || []).length, 6);
});

test('publish-source forwards arguments and distinguishes Node warnings from failures', { skip: process.platform !== 'win32' }, t => {
  for (const fail of [false, true]) {
    const dir = temp(t), expectedSha = 'c'.repeat(40);
    put(dir, 'tooling/publish-source.ps1', fs.readFileSync(path.join(root, 'tooling/publish-source.ps1')));
    put(dir, 'tooling/source-control.mjs', `
const args=process.argv.slice(2);
if(args[0] !== 'sync' || args[args.indexOf('--repo')+1] !== 'cjosn/codex-phone' || args[args.indexOf('--message')+1] !== 'chore: synchronize source for v9.9.9') process.exit(3);
process.stderr.write('synthetic harmless Node warning\\n');
${fail ? 'process.exit(8);' : `console.log(JSON.stringify({sha:'${expectedSha}',transport:'api',files:1}));`}
`);
    const driver = put(dir, 'source-test-driver.ps1', '\ufeff' + `
$failed=$false;$value='';$message=''
try { $value=& ${psQuote(path.join(dir, 'tooling/publish-source.ps1'))} -Repo cjosn/codex-phone -Version 9.9.9 -Transport api }
catch { $failed=$true;$message=$_.Exception.Message }
Write-Output ('RESULT='+(@{failed=$failed;value=$value;message=$message}|ConvertTo-Json -Compress))
`);
    const before = inventory(dir);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', driver], { encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_USE_ENV_PROXY: '0' } });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const line = result.stdout.split(/\r?\n/).find(line => line.startsWith('RESULT='));
    assert(line, result.stdout + result.stderr);
    const body = JSON.parse(line.slice(7));
    assert.equal(body.failed, fail, body.message);
    if (!fail) assert.equal(body.value, expectedSha);
    else assert.match(body.message, /Source operation failed/);
    assert.deepEqual(inventory(dir), before);
  }
});

test('PowerShell deliverables retain UTF-8 BOM', () => {
  for (const file of ['tooling/publish-source.ps1', 'tooling/publish-release.ps1']) {
    assert.deepEqual([...fs.readFileSync(path.join(root, file)).subarray(0, 3)], [239, 187, 191], file);
  }
});
