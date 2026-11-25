import {randomUUID} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {decodeTextDataUrl, ATTACHMENT_LIMITS} from './attachments.mjs';

const INLINE_LIMIT = 200 * 1024;

// Large documents belong in the workspace, not in a context-busting prompt.
// Only server-generated stagedPath values reach the input builder; clients can
// never supply a filesystem path for the bridge to read.
export async function stageLargeTextAttachments(body, {cwd}) {
  const files = body.files ?? [];
  if (!files.length) return body;
  const staged = [];
  let totalBytes = 0;
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw Object.assign(new Error('Invalid text attachment'), {code: 'attachments/invalid', status: 400});
    if (Object.hasOwn(file, 'path') || Object.hasOwn(file, 'stagedPath')) {
      throw Object.assign(new Error('Attachment paths are accepted only from the server staging step'), {code: 'attachments/invalid', status: 400});
    }
    const text = typeof file.text === 'string' ? file.text : typeof file.dataURL === 'string' ? decodeTextDataUrl(file.dataURL, file.mime) : null;
    if (text === null) {
      staged.push(file); // The input builder reports the malformed field.
      continue;
    }
    if (typeof file.name !== 'string' || !file.name || Buffer.byteLength(file.name) > 255 || /[\u0000-\u001f\u007f/\\]/.test(file.name) || !/\.(md|txt)$/i.test(file.name) || !['text/plain', 'text/markdown', 'text/x-markdown'].includes(file.mime)) {
      throw Object.assign(new Error('Only named .md and .txt files are accepted'), {code: 'attachments/invalid', status: 400});
    }
    if (text.includes('\0')) throw Object.assign(new Error('Binary data is not a text attachment'), {code: 'attachments/invalid', status: 400});
    const bytes = Buffer.byteLength(text);
    if (bytes > ATTACHMENT_LIMITS.fileBytes) throw Object.assign(new Error('Text attachment exceeds its 20 MiB byte limit'), {code: 'attachments/too-large', status: 400});
    totalBytes += bytes;
    if (totalBytes > ATTACHMENT_LIMITS.totalFileBytes) throw Object.assign(new Error('Text attachments exceed their 64 MiB aggregate byte limit'), {code: 'attachments/too-large', status: 400});
    if (bytes <= INLINE_LIMIT) {
      staged.push({...file, text});
      continue;
    }
    const directory = path.join(cwd, '.codex-attachments', randomUUID());
    await mkdir(directory, {recursive: true, mode: 0o700});
    const target = path.join(directory, path.basename(file.name));
    await writeFile(target, text, {encoding: 'utf8', mode: 0o600});
    staged.push({name: file.name, mime: file.mime, stagedPath: target});
  }
  return {...body, files: staged};
}
