#!/usr/bin/env python3
"""Verify Codex app-server runtime identity and clean ARM64 archive contents."""
import hashlib
import json
from pathlib import Path
import posixpath
import struct
import tarfile


def elf_machine(data: bytes) -> int:
    if len(data) < 20 or data[:4] != b'\x7fELF' or data[5] not in (1, 2):
        raise AssertionError('Codex executable is not ELF')
    return struct.unpack(('<' if data[5] == 1 else '>') + 'H', data[18:20])[0]


def verify(manifest_path: Path) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    assert manifest['abi'] == 'arm64-v8a'
    assert manifest['codexGo']['engine'] == 'codex-app-server'
    assert manifest['codexGo']['version'] == '0.170.0'
    assert isinstance(manifest.get('final'), bool)
    assert manifest['buildStatus'] == ('final-frozen-inputs' if manifest['final'] else 'stage-inputs-not-frozen')
    assert manifest['launch']['guestEnv']['CODEX_HOME'] == '/root/.codex'
    assert manifest['launch']['argv'][-1] == '{PORT}'
    archive = manifest_path.parent / manifest['rootfs']
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    assert digest == manifest['rootfsSha256']
    names = set()
    archive_files = {}
    expected_source_files = manifest.get('sourceFiles', {})
    assert expected_source_files, 'manifest is missing sourceFiles hashes'
    executable = None
    dsh_forbidden = ('opt/dsh', 'opt/dsh-go', 'opt/dsh-app', 'etc/dsh-app')
    forbidden_files = {'usr/local/bin/dsh', 'usr/local/bin/dsh-go', 'etc/profile.d/dsh-app.sh'}
    with tarfile.open(archive, 'r:xz') as tar:
        for member in tar:
            name = member.name.rstrip('/')
            assert name not in names, f'duplicate tar path: {name}'
            names.add(name)
            assert not name.startswith('/') and '..' not in name.split('/'), name
            assert name not in forbidden_files, f'legacy DSH shim: {name}'
            assert not any(name == root or name.startswith(root + '/') for root in dsh_forbidden), f'legacy DSH tree: {name}'
            if name.startswith('root/') and member.isfile():
                assert name.startswith('root/.codex/') or name.startswith('root/workspace/'), name
            if member.issym():
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname))
                assert not member.linkname.startswith('/') and not target.startswith('../'), name
            if name == 'opt/codex/bin/codex':
                executable = tar.extractfile(member).read()
            if name in expected_source_files and member.isfile():
                archive_files[name] = hashlib.sha256(tar.extractfile(member).read()).hexdigest()
    assert archive_files == expected_source_files, f'sourceFiles hash mismatch: expected {expected_source_files}, got {archive_files}'
    assert executable is not None, 'missing /opt/codex/bin/codex'
    assert elf_machine(executable) == 183, 'Codex binary is not AArch64'
    assert archive.stat().st_size == manifest['rootfsBytes']
    with archive.open('rb') as source:
        import lzma
        stream = lzma.LZMAFile(source)
        tar_hash = hashlib.sha256()
        tar_bytes = 0
        while chunk := stream.read(1024 * 1024):
            tar_hash.update(chunk)
            tar_bytes += len(chunk)
    assert tar_hash.hexdigest() == manifest['tarSha256']
    assert tar_bytes == manifest['tarBytes']
    return {'runtimeVersion': manifest['runtimeVersion'], 'rootfsSha256': digest,
            'uniqueEntries': len(names), 'codexElfMachine': 'aarch64', 'engine': manifest['codexGo']['engine']}


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('manifest', type=Path)
    print(json.dumps(verify(parser.parse_args().manifest), indent=2))
