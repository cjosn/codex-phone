"""Build a clean Codex Go runtime from a matching pinned ARM64 bundle.

The original archive is never edited. Rebuilds source-controlled overlay files,
removes all preseeded home/workspace/tmp contents, and keeps the DSH engine,
full WebUI, PRoot inputs, and installed dsh-purge package. No device data is read.
"""
import argparse
import copy
import hashlib
import importlib.util
import io
import json
import lzma
from pathlib import Path
import sys
import tarfile

BASE=Path(__file__).resolve().parents[1]
REPO=BASE/'dshgo-fork'/'dsh-Go-main'
parser=argparse.ArgumentParser()
parser.add_argument('--source',type=Path,default=BASE.parent/'build/apk/base/assets/runtime')
parser.add_argument('--out',type=Path,default=REPO/'runtime/out/arm64-v8a/assets/runtime')
args=parser.parse_args()
manifest=json.loads((args.source/'manifest.json').read_text(encoding='utf-8'))
if manifest['dshVersion']!='0.2.2-rc.1' or manifest['abi']!='arm64-v8a':raise ValueError('incompatible runtime version / ABI')
archive=args.source/manifest['rootfs']
with archive.open('rb') as handle:
    if hashlib.file_digest(handle,'sha256').hexdigest()!=manifest['rootfsSha256']:raise ValueError('source archive checksum mismatch')
spec=importlib.util.spec_from_file_location('rtbuild',REPO/'runtime/lib/rtbuild.py')
rt=importlib.util.module_from_spec(spec);sys.modules[spec.name]=rt;spec.loader.exec_module(rt)
# Same source-of-truth overlay as fresh Linux builds; no independently copied
# provider modules or plugin YAML in this rewriter.
overlay=rt.overlay_entries({'product':'Codex Go','dshVersion':manifest['dshVersion']},with_python=True,with_pnpm=True,with_bridge=True,with_codex=True)
purge='opt/dsh/node_modules/dsh-purge'
for name in ['root','root/.dsh','root/.l2s','root/workspace','tmp']:
    overlay[name]=rt.Entry('dir',0o1777 if name=='tmp' else (0o700 if name.startswith('root/.') else 0o755),origin='codex-source')
for name in list(overlay):
    if name.startswith('root/') and overlay[name].kind!='dir':del overlay[name]
# Build parent directories before their files. Keep source entries except paths
# replaced by the source overlay and anything from a previous user's home.
args.out.mkdir(parents=True,exist_ok=True)
out=args.out/manifest['rootfs'];partial=out.with_suffix(out.suffix+'.partial')
counts={'dir':0,'file':0,'symlink':0};file_bytes=0;purge_count=0;removed=0
seen_dirs=set()
class HashWriter:
    def __init__(self,sink):self.sink=sink;self.hash=hashlib.sha256();self.bytes=0
    def write(self,b):self.hash.update(b);self.bytes+=len(b);return self.sink.write(b)
    def flush(self):self.sink.flush()

def count(member):
    global file_bytes
    kind='dir' if member.isdir() else 'symlink' if member.issym() else 'file'
    counts[kind]+=1
    if member.isdir():seen_dirs.add(member.name.rstrip('/'))
    if member.isfile():file_bytes+=member.size

with lzma.open(partial,'wb',preset=3) as compressed:
    writer=HashWriter(compressed)
    with tarfile.open(archive,'r|xz') as src,tarfile.open(fileobj=writer,mode='w|',format=tarfile.GNU_FORMAT) as dst:
        # Overlay parents must precede files even when not in the baseline.
        for name in sorted(overlay,key=lambda n:n.split('/')):
            entry=overlay[name]
            if entry.kind!='dir':continue
            member=tarfile.TarInfo(name);member.type=tarfile.DIRTYPE;member.mode=entry.mode;member.mtime=1767225600;dst.addfile(member);count(member)
        for member in src:
            name=member.name.removeprefix('./').rstrip('/')
            if name in overlay or name=='root' or name.startswith('root/') or name.startswith('tmp/') or name.startswith('var/log/'):
                removed+=1;continue
            member=copy.copy(member);member.name=name
            dst.addfile(member,src.extractfile(member) if member.isfile() else None);count(member)
        for name,entry in sorted(overlay.items(),key=lambda x:x[0].split('/')):
            if entry.kind=='dir':continue
            parts=name.split('/')
            for i in range(1,len(parts)):
                parent='/'.join(parts[:i])
                if parent in seen_dirs:continue
                directory=tarfile.TarInfo(parent);directory.type=tarfile.DIRTYPE;directory.mode=0o755;directory.mtime=1767225600
                dst.addfile(directory);count(directory)
            member=tarfile.TarInfo(name);member.mode=entry.mode;member.mtime=1767225600
            if entry.kind=='symlink':member.type=tarfile.SYMTYPE;member.linkname=entry.link;dst.addfile(member)
            else:member.size=len(entry.data);dst.addfile(member,io.BytesIO(entry.data))
            count(member)
            if name.startswith(purge+'/') and entry.kind=='file':purge_count+=1
    tar_hash=writer.hash.hexdigest();tar_bytes=writer.bytes
if purge_count==0:raise ValueError('vendored dsh-purge files were not added to this runtime')
partial.replace(out)
with out.open('rb') as handle:digest=hashlib.file_digest(handle,'sha256').hexdigest()
manifest.update(runtimeVersion=f'codexgo1-dsh0.2.2-rc.1-{digest[:12]}',rootfsSha256=digest,rootfsBytes=out.stat().st_size,tarBytes=tar_bytes,tarSha256=tar_hash,uncompressedBytes=file_bytes,entries=counts)
manifest['codexGo']={'product':'Codex Go','engine':'DSH','unofficial':True,'homeSeeded':False,'purgePackagePreserved':True,'purgeAutoApply':False,'sourceRuntimeSha256':json.loads((args.source/'manifest.json').read_text())['rootfsSha256']}
(args.out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'runtimeVersion':manifest['runtimeVersion'],'rootfsSha256':digest,'bytes':out.stat().st_size,'removedOrRebuiltEntries':removed,'purgeFiles':purge_count,'homeSeeded':False},ensure_ascii=False))
