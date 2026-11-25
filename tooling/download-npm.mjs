import fs from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createHash} from 'node:crypto';
const r=await fetch('https://registry.npmjs.org/npm/11.6.2');if(!r.ok)throw Error(r.status);const p=await r.json();
const response=await fetch(p.dist.tarball);if(!response.ok)throw Error(response.status);const hash=createHash('sha512');
await pipeline(Readable.fromWeb(response.body),async function*(chunks){for await(const c of chunks){hash.update(c);yield c;}},fs.createWriteStream('codex-go/tooling/cache/npm.tgz'));
if('sha512-'+hash.digest('base64')!==p.dist.integrity)throw Error('npm integrity mismatch');console.log('npm 11.6.2 integrity verified');
