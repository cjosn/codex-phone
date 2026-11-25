"""Verify the clean runtime without executing foreign-architecture binaries."""
from pathlib import Path
import hashlib
import json
import posixpath
import tarfile
base=Path(__file__).resolve().parents[1]/'dshgo-fork/dsh-Go-main/runtime/out/arm64-v8a/assets/runtime'
manifest=json.loads((base/'manifest.json').read_text())
archive=base/manifest['rootfs']
with archive.open('rb') as h:assert hashlib.file_digest(h,'sha256').hexdigest()==manifest['rootfsSha256']
seen=set();required={'opt/dsh-go/codex-go/auth/index.mjs','opt/dsh-go/codex-go/auth/auth.patch.yml','opt/dsh-go/codex-go/codex-profile/index.mjs','opt/dsh/node_modules/dsh-purge/package.json','opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js','etc/dsh-app/dsh-web.patch.yml','usr/local/bin/dsh'}
error_code=False;purge=False;web_files=0
with tarfile.open(archive,'r|xz') as tar:
    for m in tar:
        name=m.name.rstrip('/')
        assert name not in seen, f'duplicate tar path: {name}'
        seen.add(name)
        assert not name.startswith('/') and '..' not in name.split('/'),name
        if name.startswith('root/') or name.startswith('tmp/'):
            assert m.isdir(),f'preseeded user data: {name}'
        if m.issym():
            resolved=posixpath.normpath(posixpath.join(posixpath.dirname(name),m.linkname))
            assert not m.linkname.startswith('/') and not resolved.startswith('../'),name
        if name.endswith('dsh-llm-pi-ai/lib/index.js'):
            error_code=b'PI_AI_ERROR' in tar.extractfile(m).read()
        if name=='etc/dsh-app/dsh-web.patch.yml':
            text=tar.extractfile(m).read().decode();purge='id: dsh-purge' in text and 'autoApplyOnStart: false' in text
        if '/dsh-client-' in name and m.isfile():web_files+=1
assert not required-seen,required-seen
assert error_code and purge and web_files>0
print(json.dumps({'runtimeVersion':manifest['runtimeVersion'],'uniqueEntries':len(seen),'personalHomeFiles':0,'PI_AI_ERROR':error_code,'purgePackage':purge,'webUiFiles':web_files,'result':'PASS'}))
