"""Extract checksum-verified Google SDK packages and write local metadata."""
from pathlib import Path
import hashlib
import json
import os
import zipfile
import xml.etree.ElementTree as ET
BASE=Path(__file__).resolve().parent
SDK=BASE/'sdk/android-sdk'
plan=json.loads((BASE/'cache/android-packages.json').read_text())
repo=(BASE/'cache/android-repository.xml').read_text()
import re
root_tag=re.search(r'<sdk:sdk-repository\b[^>]*>',repo).group(0)
for package in plan:
    source=Path(package['file'])
    with source.open('rb') as h:
        if hashlib.file_digest(h,package['algorithm']).hexdigest()!=package['digest']:raise ValueError('SDK checksum changed')
    dest=SDK.joinpath(*package['id'].split(';'))
    if (dest/'package.xml').exists():print('existing '+package['id'],flush=True);continue
    dest.mkdir(parents=True,exist_ok=True)
    print('extracting '+package['id'],flush=True)
    with zipfile.ZipFile(source) as z:
        entries=z.infolist()
        top={entry.filename.split('/')[0] for entry in entries if entry.filename}
        strip_root=len(top)==1
        for entry in entries:
            parts=entry.filename.split('/')[1:] if strip_root else entry.filename.split('/')
            if not parts or not parts[-1]:continue
            if any(p in ('..','') for p in parts):raise ValueError('unsafe SDK path')
            target=dest.joinpath(*parts)
            output=Path('\\\\?\\'+str(target.resolve())) if os.name=='nt' else target
            output.parent.mkdir(parents=True,exist_ok=True)
            with z.open(entry) as src,output.open('wb') as out:
                import shutil
                shutil.copyfileobj(src,out)
    metadata=package['metadata'].replace('<remotePackage','<localPackage',1).replace('</remotePackage>','</localPackage>')
    metadata=re.sub(r'<archives>[\s\S]*?</archives>','',metadata)
    metadata=re.sub(r'<channelRef[^>]*/>','',metadata)
    metadata=re.sub(r'<uses-license[^>]*/>','',metadata)
    (dest/'package.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n'+root_tag+metadata+'</sdk:sdk-repository>',encoding='utf-8')
    print('installed '+package['id'],flush=True)
# Store the hash of Google's actual license content, as sdkmanager does after
# acceptance. The project already invokes sdkmanager --licenses for acceptance.
licenses=SDK/'licenses';licenses.mkdir(exist_ok=True)
for lid,text in re.findall(r'<license\s+id="([^"]+)"[^>]*>([\s\S]*?)</license>',repo):
    import html
    decoded=html.unescape(text).strip()
    (licenses/lid).write_text(hashlib.sha1(decoded.encode()).hexdigest()+'\n',encoding='utf-8')
print('SDK package files and metadata verified.',flush=True)
