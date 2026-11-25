// Populate the official sqlite3 hook cache with SHA256-verified upstream assets.
// Node's TLS path avoids the Dart/Windows handshake failure without disabling TLS.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve('codex-go/dshgo-fork/dsh-Go-main/app/.dart_tool/hooks_runner/shared/sqlite3/build');
const source=fs.readFileSync('codex-go/tooling/sdk/pub-cache/hosted/pub.flutter-io.cn/sqlite3-3.9.1/lib/src/hook/asset_hashes.dart','utf8');
for(const name of ['sqlite3.x64.windows.dll','libsqlite3.arm64.android.so']){
 const digest=source.match(new RegExp("'"+name.replaceAll('.','\\.')+"': '([a-f0-9]{64})'"))?.[1];if(!digest)throw Error(`hash not found: ${name}`);
 const filename=name.endsWith('.dll')?'sqlite3.dll':'libsqlite3.so';const dir=path.join(root,'download-'+digest.slice(0,8));fs.mkdirSync(dir,{recursive:true});const target=path.join(dir,filename);
 if(fs.existsSync(target)&&createHash('sha256').update(fs.readFileSync(target)).digest('hex')===digest){console.log(`verified cache ${name}`);continue;}
 const response=await fetch(`https://github.com/simolus3/sqlite3.dart/releases/download/sqlite3-3.9.1/${name}`,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error(`HTTP ${response.status}`);const bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==digest)throw Error('hash mismatch');fs.writeFileSync(target,bytes);console.log(`cached ${name} ${bytes.length} bytes`);
}
