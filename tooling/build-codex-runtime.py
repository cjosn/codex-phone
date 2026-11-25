#!/usr/bin/env python3
"""Build the real Codex app-server ARM64 rootfs from pinned published inputs.

The DSH overlay builder remains available for historical source work, but this
builder never copies its engine, shim, auth state, or user home into the output.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import lzma
from pathlib import Path, PurePosixPath
import shutil
import struct
import subprocess
import tarfile
import tempfile
import urllib.request

WORKSPACE = Path(__file__).resolve().parents[2]
REPO = WORKSPACE / "codex-go/dshgo-fork/dsh-Go-main"
DEFAULT_BASE = WORKSPACE / "build/apk/base"
NPM = "https://registry.npmjs.org"


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "codex-go-runtime-builder"})
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def download_verified(node: str, url: str, integrity: str, destination: Path) -> str:
    script = r'''const fs = require('node:fs');
const crypto = require('node:crypto');
const { once } = require('node:events');
const [url, expected, destination] = process.argv.slice(1);
(async () => {
  const chunkSize = 4 * 1024 * 1024;
  const concurrency = 32;
  const urls = [url.replace('https://registry.npmjs.org/', 'https://registry.npmmirror.com/'), url];
  const probe = await fetch(urls[0], { headers: { range: 'bytes=0-0' } });
  const match = probe.headers.get('content-range')?.match(/^bytes 0-0\/(\d+)$/);
  if (probe.status !== 206 || !match) throw new Error('mirror did not honor range probe');
  const total = Number(match[1]);
  await probe.body.cancel();
  const ranges = [];
  for (let start = 0; start < total; start += chunkSize) ranges.push([start, Math.min(start + chunkSize - 1, total - 1)]);
  let next = 0, completed = 0, failed = null;
  const worker = async () => {
    while (next < ranges.length && !failed) {
      const index = next++, [start, end] = ranges[index];
      const chunkFile = `${destination}.part-${start}`;
      if (fs.existsSync(chunkFile) && fs.statSync(chunkFile).size === end - start + 1) { completed += end - start + 1; continue; }
      let lastError;
      for (const candidate of urls) {
        try {
          const response = await fetch(candidate, { headers: { range: `bytes=${start}-${end}`, 'user-agent': 'codex-go-runtime-builder' } });
          if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${total}`) throw new Error(`HTTP ${response.status} ${response.headers.get('content-range')}`);
          const output = fs.createWriteStream(chunkFile);
          let bytes = 0;
          for await (const chunk of response.body) { bytes += chunk.length; if (!output.write(chunk)) await once(output, 'drain'); }
          output.end(); await once(output, 'close');
          if (bytes !== end - start + 1) throw new Error(`short chunk ${bytes}`);
          completed += bytes;
          console.log(`download ${completed}/${total} bytes (${(completed * 100 / total).toFixed(1)}%)`);
          lastError = null; break;
        } catch (error) { lastError = error; }
      }
      if (lastError) failed = lastError;
    }
  };
  await Promise.all(Array.from({length: concurrency}, worker));
  if (failed) throw failed;
  const partial = `${destination}.part`;
  const merged = fs.createWriteStream(partial);
  for (let start = 0; start < total; start += chunkSize) {
    const chunkFile = `${destination}.part-${start}`;
    for await (const chunk of fs.createReadStream(chunkFile)) if (!merged.write(chunk)) await once(merged, 'drain');
  }
  merged.end(); await once(merged, 'close');
  const hash = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(partial)) hash.update(chunk);
  const actual = 'sha512-' + hash.digest('base64');
  if (actual !== expected) throw new Error(`npm SRI mismatch: expected ${expected}, got ${actual}`);
  fs.renameSync(partial, destination);
  for (let start = 0; start < total; start += chunkSize) fs.unlinkSync(`${destination}.part-${start}`);
  console.log(`verified ${total} bytes; SRI ${actual}`);
})().catch(error => { console.error(error); process.exitCode = 1; });'''
    result = subprocess.run([node, "-e", script, url, integrity, str(destination)], check=False)
    if result.returncode:
        raise ValueError("Node streaming download or npm SRI verification failed; .part retained for resume")
    return integrity


def safe_name(name: str) -> str:
    path = PurePosixPath(name.removeprefix("./"))
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe tar path: {name}")
    return path.as_posix().rstrip("/")


def load_tree(source: Path, prefix: str, mode: int = 0o644) -> dict[str, tuple[bytes, int]]:
    result = {}
    if not source.is_dir():
        raise ValueError(f"missing runtime input directory: {source}")
    for path in sorted(source.rglob("*")):
        if path.name == "fake-codex.mjs":
            continue
        if path.is_symlink():
            raise ValueError(f"runtime input must not contain symlinks: {path}")
        if path.is_file():
            relative = path.relative_to(source).as_posix()
            result[f"{prefix}/{relative}"] = (path.read_bytes(), mode)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_BASE / "assets/runtime")
    parser.add_argument("--native", type=Path, default=DEFAULT_BASE / "lib/arm64-v8a")
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--codex-version", required=True, help="Exact @openai/codex platform package version, e.g. 0.170.0")
    parser.add_argument("--codex-integrity", default="sha512-mJLm5eia/GcukCrRfVEnYVD5dOXGE7cmpd9dJ/ixkSiKifzDAPaGq83ZEmwVhk3PxbdTPUSLRpnXZQKbNS5HoA==", help="Expected SRI of the linux-arm64 optional artifact")
    parser.add_argument("--cli-integrity", default="sha512-dwoughgqjiik++CFaNkjQ5y6pJO6LUzu5P1z8Hy4LUeJ+aIYcX/QO1P5rOQnHmBG4agOM7Y+hc4LtVo/a4GFiw==", help="Expected SRI of the main @openai/codex CLI package")
    parser.add_argument("--bridge", type=Path, default=WORKSPACE / "codex-go/bridge")
    parser.add_argument("--web", type=Path, default=WORKSPACE / "codex-go/web")
    parser.add_argument("--node", default="node", help="Node.js executable used for streaming downloads")
    parser.add_argument("--codex-home", type=Path, help="Optional clean config template; credentials are rejected")
    parser.add_argument("--final", action="store_true", help="Mark frozen source inputs as the final runtime")
    args = parser.parse_args()
    if args.out is None:
        args.out = REPO / ("runtime/out/arm64-v8a" if args.final else "runtime/stage/codex-app-server/arm64-v8a")

    original = json.loads((args.source / "manifest.json").read_text(encoding="utf-8"))
    if original.get("abi") != "arm64-v8a" or original.get("rootfsFormat") != "tar.xz":
        raise ValueError("source must be the existing ARM64 tar.xz runtime")
    source_archive = args.source / original["rootfs"]
    source_hash = hashlib.sha256()
    with source_archive.open("rb") as source_stream:
        for chunk in iter(lambda: source_stream.read(1024 * 1024), b""):
            source_hash.update(chunk)
    source_sha = source_hash.hexdigest()
    if source_sha != original["rootfsSha256"]:
        raise ValueError("source rootfs SHA-256 mismatch")

    # Resolve the exact platform artifact from npm metadata; do not construct or
    # trust a package URL/hash without checking the registry-published SRI.
    cli_metadata = fetch_json(f"{NPM}/@openai%2Fcodex/{args.codex_version}")
    if cli_metadata.get("name") != "@openai/codex" or cli_metadata.get("version") != args.codex_version:
        raise ValueError("npm returned unexpected Codex CLI metadata")
    cli_dist = cli_metadata.get("dist", {})
    if cli_dist.get("integrity") != args.cli_integrity:
        raise ValueError(f"official Codex CLI integrity differs from the configured pin: {cli_dist.get('integrity')}")
    metadata = fetch_json(f"{NPM}/@openai%2Fcodex/{args.codex_version}-linux-arm64")
    if metadata.get("name") != "@openai/codex" or metadata.get("version") != f"{args.codex_version}-linux-arm64":
        raise ValueError("npm returned unexpected Codex package metadata")
    dist = metadata.get("dist", {})
    if not dist.get("tarball") or not dist.get("integrity", "").startswith("sha512-"):
        raise ValueError("npm metadata has no SHA-512 SRI for the ARM64 package")
    if dist["integrity"] != args.codex_integrity:
        raise ValueError(f"official ARM64 artifact integrity differs from the configured pin: {dist['integrity']}")

    args.out.mkdir(parents=True, exist_ok=True)
    cache = WORKSPACE / "codex-go/tooling/cache"
    cache.mkdir(parents=True, exist_ok=True)
    cli_tar = cache / f"codex-{args.codex_version}.tgz"
    platform_tar = cache / f"codex-{args.codex_version}-linux-arm64.tgz"
    for target, artifact in ((cli_tar, cli_dist), (platform_tar, dist)):
        expected = args.cli_integrity if target == cli_tar else args.codex_integrity
        if not target.is_file():
            download_verified(args.node, artifact["tarball"], artifact["integrity"], target)
        else:
            actual = "sha512-" + base64.b64encode(hashlib.sha512(target.read_bytes()).digest()).decode("ascii")
            if actual != expected:
                raise ValueError(f"cached Codex artifact SRI mismatch for {target.name}: {actual}")
    with tempfile.TemporaryDirectory(prefix="codex-runtime-") as temp_name:
        temp = Path(temp_name)
        codex_files: dict[str, tuple[bytes, int]] = {}
        cli_entry = None
        with tarfile.open(cli_tar, "r:gz") as package:
            for member in package:
                name = safe_name(member.name)
                if not name or member.isdir():
                    continue
                if not member.isfile():
                    raise ValueError(f"unexpected non-file in official Codex CLI package: {name}")
                source = package.extractfile(member)
                if source is None:
                    raise ValueError(f"cannot read Codex CLI package file: {name}")
                data = source.read()
                relative = name.removeprefix("package/")
                codex_files[f"opt/codex/{relative}"] = (data, 0o755 if member.mode & 0o111 else 0o644)
                if relative == cli_metadata.get("bin", {}).get("codex"):
                    cli_entry = relative
        platform_elfs = []
        with tarfile.open(platform_tar, "r:gz") as package:
            for member in package:
                name = safe_name(member.name)
                if not name or member.isdir():
                    continue
                if not member.isfile():
                    raise ValueError(f"unexpected non-file in official Codex platform package: {name}")
                source = package.extractfile(member)
                if source is None:
                    raise ValueError(f"cannot read Codex platform package file: {name}")
                data = source.read()
                relative = name.removeprefix("package/")
                vendor_prefix = "vendor/aarch64-unknown-linux-musl/"
                if relative.startswith(vendor_prefix):
                    relative = relative[len(vendor_prefix):]
                target = f"opt/codex/vendor/aarch64-unknown-linux-musl/{relative}"
                codex_files[target] = (data, 0o755 if member.mode & 0o111 else 0o644)
                if data.startswith(b"\x7fELF"):
                    machine, _elf_class = elf_machine_from_bytes(data)
                    if machine != 183:
                        raise ValueError(f"official Codex platform package has non-AArch64 ELF {name}")
                    platform_elfs.append((relative, data, member.mode))
        if cli_entry is None or not platform_elfs:
            raise ValueError("official npm artifacts are missing the CLI entry or AArch64 platform ELF")
        candidates = [(name, data, mode) for name, data, mode in platform_elfs
                      if name == "bin/codex"]
        if len(candidates) != 1:
            raise ValueError(f"expected vendor/bin/codex in platform package, found {[n for n, _, _ in candidates]}")
        executable_name, platform_executable, executable_mode = candidates[0]
        codex_files["opt/codex/bin/codex"] = (platform_executable, 0o755 if executable_mode & 0o111 else 0o644)
        native_files = [("opt/codex/bin/codex", platform_executable)]

    runtime_files = dict(codex_files)
    bridge_files = load_tree(args.bridge, "opt/codex-go/bridge", 0o644)
    web_files = load_tree(args.web, "opt/codex-go/web", 0o644)
    required_bridge = {"opt/codex-go/bridge/server.mjs"}
    if not required_bridge.issubset(bridge_files):
        raise ValueError("bridge input must include server.mjs (freeze current bridge files before final build)")
    if not web_files:
        raise ValueError("web input directory must contain the frozen Web UI assets")
    runtime_files.update(bridge_files)
    runtime_files.update(web_files)
    if args.codex_home:
        for path in args.codex_home.rglob("*"):
            if path.is_file() and path.name.lower() in {"auth.json", "credentials.json", "config.toml"}:
                text = path.read_text(encoding="utf-8", errors="ignore")
                if any(marker in text.lower() for marker in ("api_key", "access_token", "refresh_token", "authorization")):
                    raise ValueError(f"refusing credential-bearing CODEX_HOME input: {path}")
        runtime_files.update(load_tree(args.codex_home, "root/.codex", 0o600))

    archive_name = "rootfs-arm64-v8a.tar.xz"
    archive_out = args.out / "assets/runtime" / archive_name
    archive_out.parent.mkdir(parents=True, exist_ok=True)
    partial = archive_out.with_suffix(archive_out.suffix + ".partial")
    removed = 0
    entry_counts = {"dir": 0, "file": 0, "symlink": 0}
    seen_dirs: set[str] = set()
    base_file_bytes = 0
    tar_bytes = 0
    tar_digest = hashlib.sha256()
    seen_source_paths: set[str] = set()
    with lzma.open(partial, "wb", preset=3) as compressed:
        class HashWriter:
            def write(self, data):
                nonlocal tar_bytes
                tar_digest.update(data)
                tar_bytes += len(data)
                return compressed.write(data)
            def flush(self):
                compressed.flush()
        excluded_roots = ("opt/dsh", "opt/dsh-go", "opt/dsh-app", "etc/dsh-app")
        excluded_files = {"usr/local/bin/dsh", "usr/local/bin/dsh-go", "etc/profile.d/dsh-app.sh"}
        with tarfile.open(source_archive, "r|xz") as src, tarfile.open(fileobj=HashWriter(), mode="w|", format=tarfile.GNU_FORMAT) as dst:
            for member in src:
                name = safe_name(member.name)
                if name in seen_source_paths:
                    raise ValueError(f"duplicate source archive path: {name}")
                seen_source_paths.add(name)
                if not name or name == "root" or name.startswith("root/") or name == "tmp" or name.startswith("tmp/") or name.startswith("var/log/") or name in excluded_files or any(name == root or name.startswith(root + "/") for root in excluded_roots):
                    removed += 1
                    continue
                if name in runtime_files:
                    removed += 1
                    continue
                if member.issym():
                    link = PurePosixPath(member.linkname)
                    resolved = PurePosixPath(name).parent.joinpath(link)
                    depth = 0
                    for part in resolved.parts:
                        depth += -1 if part == ".." else 0 if part in ("", ".") else 1
                        if depth < 0:
                            raise ValueError(f"source archive symlink escapes rootfs: {name} -> {member.linkname}")
                member.name = name
                dst.addfile(member, src.extractfile(member) if member.isfile() else None)
                entry_counts["dir" if member.isdir() else "symlink" if member.issym() else "file"] += 1
                if member.isfile():
                    base_file_bytes += member.size
                if member.isdir():
                    seen_dirs.add(name)
            for dirname in ("opt", "opt/codex", "opt/codex-go", "root", "root/.codex", "root/workspace", "tmp"):
                if dirname not in seen_dirs:
                    member = tarfile.TarInfo(dirname + "/")
                    member.type = tarfile.DIRTYPE
                    member.mode = 0o700 if dirname.startswith("root") else 0o755
                    member.uid = member.gid = 0
                    member.mtime = 1767225600
                    dst.addfile(member)
                    entry_counts["dir"] += 1
                    seen_dirs.add(dirname)
            for name, (data, mode) in sorted(runtime_files.items()):
                parts = name.split("/")
                for i in range(1, len(parts)):
                    parent = "/".join(parts[:i])
                    if parent not in seen_dirs:
                        member = tarfile.TarInfo(parent + "/")
                        member.type = tarfile.DIRTYPE
                        member.mode = 0o755
                        member.uid = member.gid = 0
                        member.mtime = 1767225600
                        dst.addfile(member)
                        entry_counts["dir"] += 1
                        seen_dirs.add(parent)
                member = tarfile.TarInfo(name)
                member.mode = mode
                member.uid = member.gid = 0
                member.mtime = 1767225600
                member.size = len(data)
                dst.addfile(member, io.BytesIO(data))
                entry_counts["file"] += 1
    partial.replace(archive_out)
    rootfs_sha = hashlib.sha256(archive_out.read_bytes()).hexdigest()
    uncompressed_bytes = base_file_bytes + sum(len(data) for data, _ in runtime_files.values())

    native = {}
    for filename in ("libproot.so", "libproot-loader.so", "libtalloc.so", "libandroid-shmem.so"):
        source = args.native / filename
        if not source.is_file():
            raise ValueError(f"missing existing ARM64 JNI input: {source}")
        native[filename] = {"sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "bytes": source.stat().st_size}
    jni_out = args.out / "jniLibs/arm64-v8a"
    jni_out.mkdir(parents=True, exist_ok=True)
    for filename in native:
        shutil.copy2(args.native / filename, jni_out / filename)

    manifest = {
        "schema": 1,
        "runtimeVersion": f"codex-app-server-{args.codex_version}-arm64-{rootfs_sha[:12]}",
        "abi": "arm64-v8a",
        "rootfs": archive_name,
        "rootfsFormat": "tar.xz",
        "rootfsSha256": rootfs_sha,
        "rootfsBytes": archive_out.stat().st_size,
        "tarBytes": tar_bytes,
        "tarSha256": tar_digest.hexdigest(),
        "uncompressedBytes": uncompressed_bytes,
        "sourceRootfsSha256": source_sha,
        "sourceFiles": {name: hashlib.sha256(data).hexdigest()
                        for name, (data, _) in sorted({**bridge_files, **web_files}.items())},
        "buildStatus": "final-frozen-inputs" if args.final else "stage-inputs-not-frozen",
        "final": args.final,
        "removedDshEntries": removed,
        "entries": entry_counts,
        "nodeVersion": original.get("nodeVersion"),
        "ubuntuVersion": original.get("ubuntuVersion"),
        "jniLibs": native,
        "codexGo": {
            "engine": "codex-app-server",
            "version": args.codex_version,
            "package": "@openai/codex",
            "artifactVersion": metadata["version"],
            "artifactIntegrity": dist["integrity"],
            "artifactTarball": dist["tarball"],
            "cliArtifactIntegrity": cli_dist["integrity"],
            "cliArtifactTarball": cli_dist["tarball"],
            "platformExecutable": executable_name,
            "homeSeeded": False,
        },
        "launch": {
            "argv": ["/opt/node/bin/node", "/opt/codex-go/bridge/server.mjs", "--mode", "app-server",
                     "--codex", "/opt/codex/bin/codex", "--host", "127.0.0.1", "--port", "{PORT}"],
            "env": {"PROOT_LOADER": "{NATIVE_LIB_DIR}/libproot-loader.so",
                    "PROOT_TMP_DIR": "{CACHE_DIR}/proot-tmp"},
            "guestEnv": {"CODEX_HOME": "/root/.codex"},
            "tokenPolicy": "generated-per-launch",
            "healthPath": "/healthz",
            "stdoutUrlPrefix": "codex-go: ",
        },
    }
    manifest_path = args.out / "assets/runtime/manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    verifier = REPO / "runtime/codex-go/verify-runtime.py"
    subprocess_result = subprocess.run(["python", str(verifier), str(manifest_path)], check=True, capture_output=True, text=True)
    print(subprocess_result.stdout.strip())
    print(json.dumps({"engine": manifest["codexGo"]["engine"], "runtimeVersion": manifest["runtimeVersion"],
                      "rootfsSha256": rootfs_sha, "rootfsBytes": archive_out.stat().st_size,
                      "codexArtifactIntegrity": dist["integrity"], "elfAarch64Count": len(native_files),
                      "removedDshEntries": removed, "jniLibs": native}, indent=2))


def elf_machine_from_bytes(data: bytes) -> tuple[int, int]:
    if len(data) < 20 or data[:4] != b"\x7fELF" or data[5] not in (1, 2):
        raise ValueError("invalid ELF header in official Codex package")
    return struct.unpack(("<" if data[5] == 1 else ">") + "H", data[18:20])[0], data[4]


if __name__ == "__main__":
    main()
