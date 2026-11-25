import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {stageLargeTextAttachments} from '../bridge/attachment-store.mjs';
import {buildCodexAttachmentInput} from '../bridge/attachments.mjs';

test('large documents are staged in the workspace and referenced, not dumped into the prompt', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-attachment-store-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const marker = 'LARGE_DOCUMENT_MARKER_93A';
  const text = `# Fixture\n${marker}\n${'x'.repeat(220 * 1024)}`;
  const body = await stageLargeTextAttachments({files: [{name: 'large.md', mime: 'text/markdown', text}]}, {cwd});
  const file = body.files[0];
  assert(file.stagedPath.startsWith(cwd));
  assert.equal(await readFile(file.stagedPath, 'utf8'), text);
  const {input} = buildCodexAttachmentInput(body, {input: []});
  assert.equal(input.length, 1);
  assert.match(input[0].text, /file-reading tools/);
  assert.match(input[0].text, /large\.md/);
  assert(!input[0].text.includes(marker), 'large document contents must not be repeated in the prompt');
  assert(!input[0].text.includes('part="1/'), 'large files are not split into context-busting prompt segments');
});

test('small documents remain inline and client paths are never read', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'codex-attachment-small-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const small = await stageLargeTextAttachments({files: [{name: 'small.txt', mime: 'text/plain', text: 'original'}]}, {cwd});
  assert.equal(small.files[0].stagedPath, undefined);
  assert.equal(buildCodexAttachmentInput(small, {input: []}).input[0].text.includes('original'), true);
  const data = Buffer.from('data url document').toString('base64');
  const decoded = await stageLargeTextAttachments({files: [{name: 'data.txt', mime: 'text/plain', dataURL: `data:text/plain;base64,${data}`}]}, {cwd});
  assert.equal(decoded.files[0].text, 'data url document');
  for (const field of [{path: '/etc/passwd'}, {stagedPath: '/etc/passwd'}]) {
    await assert.rejects(stageLargeTextAttachments({files: [{name: 'bad.txt', mime: 'text/plain', text: 'x'.repeat(210 * 1024), ...field}]}, {cwd}), /paths are accepted only from the server staging step/);
  }
});
