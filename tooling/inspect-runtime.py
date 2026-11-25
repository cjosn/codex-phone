"""Print bounded implementation evidence from the immutable bundled runtime only."""
import json
from pathlib import Path
import tarfile
archive=Path('build/apk/base/assets/runtime/rootfs-arm64-v8a.tar.xz')
wanted={
 'opt/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js',
 'opt/dsh/node_modules/@deepseek-ai/dsh-agent-default-model/lib/index.js',
 'opt/dsh/node_modules/@deepseek-ai/dsh-agent-default-model/README.md',
 'etc/dsh-app/dsh-web.patch.yml',
}
with tarfile.open(archive,'r|xz') as tar:
    for m in tar:
        name=m.name.removeprefix('./')
        if name not in wanted or m.size>1024*1024:continue
        data=tar.extractfile(m).read().decode('utf-8')
        if 'llm-pi-ai/lib/index' in name:
            for i,line in enumerate(data.splitlines(),1):
                if 'PI_AI_ERROR' in line or 'classifyPiAiError' in line:print(f'{name}:{i}: {line[:250]}')
        else:
            lines=data.splitlines()
            for i,line in enumerate(lines,1):
                if name.endswith('.yml') or any(k in line for k in ['saveSelection','currentSelection','async ', 'static inject','settings.register']):print(f'{name}:{i}: {line[:250]}')
