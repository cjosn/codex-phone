"""Stage the verified toolchain archives in this workspace without changing PATH globally."""
import hashlib
import json
from pathlib import Path
import shutil
import zipfile
import time

BASE = Path(__file__).resolve().parent
CACHE = BASE / 'cache'
OUT = BASE / 'sdk'
OUT.mkdir(exist_ok=True)

def unpack(name, dest, prefix=None, expected=None):
    archive = CACHE / name
    if not archive.is_file():
        print(f'pending: {name}', flush=True)
        return
    if expected:
        with archive.open('rb') as handle:
            actual = hashlib.file_digest(handle, 'sha256').hexdigest()
        if actual != expected:
            raise ValueError(f'{name}: SHA256 mismatch')
    if (dest / '.codex-extracted').is_file():
        print(f'already extracted: {name}', flush=True)
        return
    print(f'extracting {name}', flush=True)
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for entry in z.infolist():
            pieces = Path(entry.filename).parts
            if entry.filename.startswith(('/', '\\')) or '..' in pieces:
                raise ValueError('archive path escapes destination')
            # Python's ZIP API needs the Windows extended path prefix for Flutter's sources.
            extraction_root = '\\\\?\\' + str(dest.resolve()) if __import__('os').name == 'nt' else str(dest)
            z.extract(entry, extraction_root)
    (dest / '.codex-extracted').write_text(name, encoding='utf-8')
    print(f'extracted {name}', flush=True)

release=json.loads((CACHE/'flutter-release.json').read_text(encoding='utf-8'))
unpack('flutter.zip', OUT, expected=release['sha256'])
unpack('git.zip', OUT/'git')
unpack('jdk.zip', OUT/'java')
unpack('android-tools.zip', OUT/'android-sdk'/'cmdline-tools'/'stage', expected='98b565cb657b012dae6794cefc0f66ae1efb4690c699b78a614b4a6a3505b003')
stage=OUT/'android-sdk'/'cmdline-tools'/'stage'/'cmdline-tools'
latest=OUT/'android-sdk'/'cmdline-tools'/'latest'
if stage.is_dir() and not latest.exists():
    stage.rename(latest)
