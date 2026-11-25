#!/usr/bin/env python3
"""Install the official Codex app-server ARM64 runtime from a Codex Go APK.

Usage: python termux-install.py /path/to/Codex-Go.apk
Requires Termux packages: python proot tar xz-utils termux-api (optional wake lock).
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import sys
import tarfile
import tempfile
import zipfile


def main():
    if 'com.termux' not in os.environ.get('PREFIX', ''):
        raise SystemExit('Run this installer inside Termux, not in Android shared storage.')
    if platform.machine() not in ('aarch64', 'arm64'):
        raise SystemExit('This installer requires an ARM64 device and ARM64 Codex Go APK.')
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python termux-install.py /path/to/Codex-Go.apk')
    proot = shutil.which('proot')
    if not proot:
        raise SystemExit('Install dependencies first: pkg install python proot tar xz-utils')

    base = Path.home() / '.local/share/codex-go'
    root = base / 'rootfs'
    if root.exists():
        raise SystemExit(f'{root} already exists. Back up your sessions before replacing this installation.')
    base.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(sys.argv[1]) as apk:
        manifest = json.loads(apk.read('assets/runtime/manifest.json'))
        engine = manifest.get('codexGo', {}).get('engine')
        if manifest.get('abi') != 'arm64-v8a' or engine != 'codex-app-server':
            raise SystemExit('Use a Codex Go ARM64 APK with engine codex-app-server.')
        if not manifest.get('launch', {}).get('argv'):
            raise SystemExit('Runtime manifest is missing launch.argv.')
        archive = base / 'rootfs.tar.xz'
        with apk.open('assets/runtime/' + manifest['rootfs']) as source, archive.open('wb') as output:
            shutil.copyfileobj(source, output)
        with archive.open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != manifest['rootfsSha256']:
                raise SystemExit('Runtime SHA256 mismatch')
    staging = Path(tempfile.mkdtemp(prefix='install-', dir=base))
    try:
        with tarfile.open(archive, 'r:xz') as tar:
            tar.extractall(staging, filter='data')
        staging.rename(root)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    (base / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

    bindir = Path.home() / '.local/bin'
    bindir.mkdir(parents=True, exist_ok=True)
    start = bindir / 'codex-go'
    start.write_text('''#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
ROOTFS="$HOME/.local/share/codex-go/rootfs"
TMP="$HOME/.local/share/codex-go/tmp"
NATIVE="$(dirname "$(realpath "$(command -v proot)")")"
PORT="${CODEX_GO_PORT:-3080}"
mkdir -p "$TMP" "$ROOTFS/tmp" "$ROOTFS/root/workspace" "$ROOTFS/root/.codex"
export PROOT_TMP_DIR="$TMP"
if command -v termux-wake-lock >/dev/null; then termux-wake-lock; fi
cleanup() { if command -v termux-wake-unlock >/dev/null; then termux-wake-unlock; fi; }
trap cleanup EXIT INT TERM
proot --link2symlink --kill-on-exit -0 -r "$ROOTFS" \\
  -b /dev -b /proc -b /sys -w /root/workspace \\
  /usr/bin/env -i HOME=/root USER=root LANG=C.UTF-8 TERM=xterm-256color \\
  PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp CODEX_HOME=/root/.codex \\
  NODE_OPTIONS=--dns-result-order=ipv4first UV_USE_IO_URING=0 \\
  /opt/node/bin/node /opt/codex-go/bridge/server.mjs \\
  --mode app-server --codex /opt/codex/bin/codex \\
  --host 127.0.0.1 --port "$PORT" "$@"
''')
    start.chmod(0o700)
    print('Installed Codex app-server runtime. Run ~/.local/bin/codex-go and open its codex-go URL.')
    print('The runtime uses CODEX_HOME=/root/.codex; sign in through Codex on this device.')
    print('For persistent Termux sessions: use tmux, disable battery restrictions, and configure Termux:Boot if desired.')


if __name__ == '__main__':
    main()
