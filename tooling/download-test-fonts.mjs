import fs from 'node:fs';
import path from 'node:path';
const out='codex-go/tooling/sdk/test-fonts';fs.mkdirSync(out,{recursive:true});
for(const weight of ['Light','Regular','Bold']){
 const name=`NotoSansCJK-${weight}.ttc`,target=path.join(out,name);
 if(fs.existsSync(target)&&fs.statSync(target).size>10000000){console.log(`existing ${name}`);continue;}
 const url=`https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTC/${name}`;
 const r=await fetch(url,{signal:AbortSignal.timeout(240000)});if(!r.ok)throw Error(`HTTP ${r.status} ${url}`);const bytes=Buffer.from(await r.arrayBuffer());fs.writeFileSync(target,bytes);console.log(`${name}: ${bytes.length}`);
}
