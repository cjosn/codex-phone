// Provision Google's exact SDK archives using Node TLS, retaining Google's
// repository checksums and package metadata. sdkmanager then recognizes them.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
const xml=fs.readFileSync('codex-go/tooling/cache/android-repository.xml','utf8');
const packages=['platform-tools','platforms;android-36','build-tools;36.0.0','ndk;28.2.13676358','cmake;3.22.1'];
const cache=path.resolve('codex-go/tooling/cache');
const plan=[];
for(const id of packages){
 const text=[...xml.matchAll(/<remotePackage\b[^>]*\bpath="([^"]+)"[^>]*>[\s\S]*?<\/remotePackage>/g)].find(m=>m[1]===id)?.[0];if(!text)throw Error(`SDK package not in repository: ${id}`);
 const archives=[...text.matchAll(/<archive(?:\s[^>]*)?>[\s\S]*?<\/archive>/g)].map(m=>m[0]);
 const archive=archives.find(t=>/<host-os>windows<\/host-os>/.test(t))??archives.find(t=>!t.includes('<host-os>'));if(!archive)throw Error(`no Windows archive ${id}`);
 const url=archive.match(/<url>([^<]+)<\/url>/)?.[1];
 const checksum=archive.match(/<checksum\s+type="([^"]+)"[^>]*>([^<]+)<\/checksum>/);if(!checksum)throw Error('no checksum');
 const filename=url.split('/').pop();const target=path.join(cache,filename);const algo=checksum[1].replace('-','').toLowerCase(),digest=checksum[2];
 plan.push({id,url:'https://dl.google.com/android/repository/'+url,file:target,algorithm:algo,digest,metadata:text});
}
fs.writeFileSync(path.join(cache,'android-packages.json'),JSON.stringify(plan,null,2));
for(const p of plan){
 if(fs.existsSync(p.file)){const h=createHash(p.algorithm);for await(const c of fs.createReadStream(p.file))h.update(c);if(h.digest('hex')===p.digest){console.log(`verified ${p.id}`);continue;}}
 console.log(`download ${p.id}`);const response=await fetch(p.url,{signal:AbortSignal.timeout(3600000)});if(!response.ok)throw Error(`HTTP ${response.status} ${p.url}`);
 const h=createHash(p.algorithm);let bytes=0,last=Date.now();await pipeline(Readable.fromWeb(response.body),async function*(chunks){for await(const c of chunks){h.update(c);bytes+=c.length;if(Date.now()-last>15000){console.log(`${p.id}: ${(bytes/2**20).toFixed(0)} MiB`);last=Date.now();}yield c;}},fs.createWriteStream(p.file+'.part'));
 if(h.digest('hex')!==p.digest)throw Error(`SDK checksum mismatch: ${p.id}`);fs.renameSync(p.file+'.part',p.file);console.log(`verified ${p.id}: ${bytes}`);
}
