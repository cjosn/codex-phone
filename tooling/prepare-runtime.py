"""Reuse the matching, hash-verified upstream ARM runtime assets for a source build.

This copies only packaged immutable runtime files, never a device's credentials or home.
For a fresh Linux build use runtime/build-runtime.sh instead.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

parser=argparse.ArgumentParser()
parser.add_argument('--assets',type=Path,default=Path('build/apk/base/assets/runtime'))
parser.add_argument('--native',type=Path,default=Path('build/apk/base/lib/arm64-v8a'))
parser.add_argument('--out',type=Path,default=Path('codex-go/dshgo-fork/dsh-Go-main/runtime/out/arm64-v8a'))
args=parser.parse_args()
manifest=json.loads((args.assets/'manifest.json').read_text(encoding='utf-8'))
if manifest['abi']!='arm64-v8a' or manifest['dshVersion']!='0.2.2-rc.1':
    raise ValueError('runtime must match this fork DSH 0.2.2-rc.1 / ARM64 pins')
archive=args.assets/manifest['rootfs']
with archive.open('rb') as handle:
    digest=hashlib.file_digest(handle,'sha256').hexdigest()
if digest!=manifest['rootfsSha256']:
    raise ValueError('rootfs hash mismatch')
assets=args.out/'assets'/'runtime'
native=args.out/'jniLibs'/'arm64-v8a'
assets.mkdir(parents=True,exist_ok=True)
native.mkdir(parents=True,exist_ok=True)
for item in args.assets.iterdir():
    target=assets/item.name
    if item.is_dir(): shutil.copytree(item,target,dirs_exist_ok=True)
    else: shutil.copy2(item,target)
for name in ['libproot.so','libproot-loader.so','libtalloc.so','libandroid-shmem.so']:
    source=args.native/name
    if not source.is_file(): raise ValueError(f'missing native runtime input {source}')
    shutil.copy2(source,native/name)
print(json.dumps({'runtimeVersion':manifest['runtimeVersion'],'abi':manifest['abi'],'rootfsSha256':digest,'out':str(args.out),'note':'verified upstream runtime, source Flutter build; no user data copied'},ensure_ascii=False))
