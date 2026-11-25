import fs from 'node:fs';
const urls=['https://dl.google.com/android/repository/repository2-3.xml','https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTC/NotoSansCJK-Light.ttc'];
for(const url of urls){try{const r=await fetch(url,{signal:AbortSignal.timeout(30000)});console.log(url,r.status,r.headers.get('content-length'));if(url.endsWith('.xml')&&r.ok)fs.writeFileSync('codex-go/tooling/cache/android-repository.xml',await r.text());else await r.body?.cancel();}catch(e){console.log(url,e.message,e.cause?.message);}}
