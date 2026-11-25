import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('./sdk/gradle-cache/caches/modules-2/files-2.1/', import.meta.url));
const repositories = {central: 'https://repo.maven.apache.org/maven2/', google: 'https://dl.google.com/dl/android/maven2/'};
async function cache(arg) {
  const [repo,g,a,v,classifier] = arg.split(':');
  if (!repositories[repo] || ![g,a,v,...(classifier ? [classifier] : [])].every(x => /^[\w.-]+$/.test(x) && x !== '.' && x !== '..')) throw Error(`Invalid coordinate: ${arg}`);
  const name = `${a}-${v}${classifier ? `-${classifier}` : ''}.jar`;
  const url = `${repositories[repo]}${g.replaceAll('.', '/')}/${a}/${v}/${name}`;
  async function request(suffix = '', headers = {}, method = 'GET') {
    const r = await fetch(url + suffix, {method, redirect:'error', headers:{'Accept-Encoding':'identity', ...headers}, signal:AbortSignal.timeout(90000)});
    if (!r.ok) throw Error(`${url+suffix} HTTP ${r.status}`);
    return r;
  }
  const digest = (await (await request('.sha1')).text()).trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(digest)) throw Error('Invalid upstream SHA-1');
  const dir = path.join(root,g,a,v,digest), target = path.join(dir,name);
  const sha1 = data => createHash('sha1').update(data).digest('hex');
  const existing = await readFile(target).catch(e => { if (e.code !== 'ENOENT') throw e; });
  if (existing && sha1(existing) === digest) { console.log(`Verified cache hit: ${name}`); return; }
  const total = Number((await request('',{},'HEAD')).headers.get('content-length'));
  if (!Number.isSafeInteger(total) || total < 1 || total > 256*1024*1024) throw Error(`Unexpected length: ${total}`);
  const data = Buffer.alloc(total);
  const block = 1024*1024;
  const offsets = Array.from({length: Math.ceil(total/block)}, (_,i)=>i*block);
  await Promise.all(Array.from({length: Math.min(4,offsets.length)}, async () => {
    while (offsets.length) {
      const start = offsets.shift(), end = Math.min(start+block,total)-1;
      for (let attempt=0;;attempt++) {
        try {
          const r=await request('',{Range:`bytes=${start}-${end}`});
          if (r.status!==206 || r.headers.get('content-range')!==`bytes ${start}-${end}/${total}` || r.headers.has('content-encoding')) throw Error(`Unexpected range response for ${name}`);
          const bytes=Buffer.from(await r.arrayBuffer());
          if (bytes.length!==end-start+1) throw Error(`Unexpected range length for ${name}`);
          bytes.copy(data,start);
          break;
        } catch(e) { if (attempt>=2) throw e; }
      }
    }
  }));
  if (sha1(data)!==digest) throw Error(`Checksum mismatch: ${name}`);
  await mkdir(dir,{recursive:true});
  const temporary = `${target}.${process.pid}.tmp`;
  try { await writeFile(temporary,data,{flag:'wx'}); await rename(temporary,target); }
  finally { await unlink(temporary).catch(e=>{if(e.code!=='ENOENT') throw e;}); }
  console.log(`Verified and cached: ${name} ${total} bytes ${digest}`);
}
const results = await Promise.allSettled(process.argv.slice(2).map(cache));
for (const result of results) if (result.status==='rejected') { console.error(result.reason); process.exitCode=1; }
