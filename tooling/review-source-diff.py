"""Compare the source fork to its provided ZIP baseline (there is no .git)."""
import hashlib
import json
from pathlib import Path
import zipfile
base=Path(__file__).resolve().parents[1]
repo=base/'dshgo-fork/dsh-Go-main'
archive=base.parent/'dshgo-src/main.zip'
skip={'.dart_tool','build','out','.gradle','node_modules','out-tawcroot','__pycache__','.cache','.work'}
changes=[]
seen=set()
with zipfile.ZipFile(archive) as z:
    entries={i.filename.removeprefix('dsh-Go-main/'):i for i in z.infolist() if not i.is_dir() and i.filename.startswith('dsh-Go-main/')}
    for relative,item in entries.items():
        if any(p in skip for p in Path(relative).parts):continue
        seen.add(relative);path=repo/relative
        if not path.is_file():changes.append({'path':relative,'change':'deleted'});continue
        if hashlib.sha256(path.read_bytes()).digest()!=hashlib.sha256(z.read(item)).digest():changes.append({'path':relative,'change':'modified','bytes':path.stat().st_size})
    for path in repo.rglob('*'):
        if not path.is_file():continue
        relative=path.relative_to(repo).as_posix()
        if any(p in skip for p in path.relative_to(repo).parts) or relative in seen:continue
        changes.append({'path':relative,'change':'added','bytes':path.stat().st_size})
report=base/'tooling/cache/source-diff.json'
report.write_text(json.dumps(changes,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'modified':sum(x['change']=='modified' for x in changes),'added':sum(x['change']=='added' for x in changes),'deleted':sum(x['change']=='deleted' for x in changes),'report':str(report)},ensure_ascii=False))
for x in changes:
    if x['path'].endswith(('.kt','.kts','.dart','.py','.mjs','.yml','.yaml')) and not '/l10n/gen/' in x['path']:print(x['change'],x['path'])
