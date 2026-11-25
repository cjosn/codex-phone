import fs from 'node:fs';
import path from 'node:path';
const disk=fs.statfsSync(process.cwd());
console.log(JSON.stringify({node:process.version,freeGiB:Number(disk.bavail)*Number(disk.bsize)/2**30}));
for(const base of ['https://storage.flutter-io.cn','https://storage.googleapis.com']){
  try{
    const r=await fetch(`${base}/flutter_infra_release/releases/releases_windows.json`,{signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw Error(`HTTP ${r.status}`);
    const data=await r.json();
    const release=data.releases.find(x=>x.version==='3.47.7'&&x.channel==='stable');
    console.log(JSON.stringify({base,requested:release??null,currentStable:data.releases.find(x=>x.hash===data.current_release.stable)}));
    if(release){fs.mkdirSync('codex-go/tooling/cache',{recursive:true});fs.writeFileSync('codex-go/tooling/cache/flutter-release.json',JSON.stringify({base,...release},null,2));break;}
  }catch(e){console.log(JSON.stringify({base,error:e.message}));}
}
