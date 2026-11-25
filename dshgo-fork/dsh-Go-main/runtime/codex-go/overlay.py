#!/usr/bin/env python3
"""Codex Go runtime overlay inputs shared by the clean-runtime rewriter.

Only source-controlled plugin assets are emitted. User home, credentials and
profile state are deliberately not part of this overlay.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VENDOR = Path(__file__).resolve().parent / "vendor" / "dsh-purge-1.1.71"
PURGE_DEST = "opt/dsh/node_modules/dsh-purge"
CODEX_ASSET_ROOT = "opt/dsh-go/codex-go"
PURGE_VERSION = "1.1.71"

PURGE_ROW = """# Codex Go: retain dsh-purge without auto-applying or updating user prompt rules.
- insert:
    - id: dsh-purge
      name: /opt/dsh/node_modules/dsh-purge/lib/index.js
      inject: [systemPrompt, tools]
      config:
        enabled: true
        autoApplyOnStart: false
        autoUpdateOnStart: false
        autoRevertOnMissing: false
        autoRetry: false
        autoContinue: false
        capabilityProtocol: true
        hooksDenyBypass: false
"""

AUTH_PATCH_PATH = f"{CODEX_ASSET_ROOT}/auth/auth.patch.yml"
AUTH_ROW = """# Codex Go: DSH-native subscription auth and OpenAI-compatible model profile.
- insert:
    - id: dsh-app-auth
      name: /opt/dsh-go/codex-go/auth/index.mjs
    - id: codex-go-profile
      name: /opt/dsh-go/codex-go/codex-profile/index.mjs
"""


def source_files():
    """Return the explicit, source-controlled module files needed at runtime."""
    result = {}
    for directory in ("auth", "codex-profile"):
        source = ROOT / "app" / "assets" / "engine" / directory
        for path in sorted(source.glob("*.mjs")):
            result[f"{CODEX_ASSET_ROOT}/{directory}/{path.name}"] = path.read_bytes()
    if not result:
        raise ValueError("Codex auth/profile source assets are missing")
    if set(result) != {
        f"{CODEX_ASSET_ROOT}/auth/bridge.mjs",
        f"{CODEX_ASSET_ROOT}/auth/index.mjs",
        f"{CODEX_ASSET_ROOT}/codex-profile/profile.mjs",
        f"{CODEX_ASSET_ROOT}/codex-profile/index.mjs",
    }:
        raise ValueError("unexpected Codex auth/profile source asset set")
    result[AUTH_PATCH_PATH] = AUTH_ROW.encode("utf-8")
    return result


def purge_files():
    """Return the allowlisted runtime package files, rejecting links/special files."""
    package = VENDOR / "package.json"
    import json
    metadata = json.loads(package.read_text(encoding="utf-8"))
    if metadata.get("name") != "dsh-purge" or metadata.get("version") != PURGE_VERSION or metadata.get("license") != "MIT":
        raise ValueError("unexpected vendored dsh-purge package metadata")
    result = {}
    for path in sorted(VENDOR.rglob("*")):
        if path.is_dir():
            continue
        relative = path.relative_to(VENDOR)
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"unsupported vendored dsh-purge entry: {relative}")
        result[f"{PURGE_DEST}/{relative.as_posix()}"] = path.read_bytes()
    if f"{PURGE_DEST}/LICENSE" not in result or f"{PURGE_DEST}/package.json" not in result or f"{PURGE_DEST}/lib/index.js" not in result:
        raise ValueError("vendored dsh-purge runtime inputs are incomplete")
    return result


def entries(rtbuild):
    """Build rtbuild Entry objects for source assets and the purge package."""
    assets = {**source_files(), **purge_files()}
    return {name: rtbuild.Entry("file", 0o644, data=data, origin="codex-source")
            for name, data in assets.items()}


def extend_web_patch(existing):
    """Append the purge plugin row once; auth/profile use their own launch overlay."""
    text = existing.decode("utf-8") if isinstance(existing, bytes) else existing
    if text.count("id: dsh-purge\n") > 1:
        raise ValueError("duplicate dsh-purge overlay row")
    if "id: dsh-purge\n" in text:
        return text.encode("utf-8")
    if text and not text.endswith("\n"):
        text += "\n"
    return (text + PURGE_ROW).encode("utf-8")


def personal_home_paths(paths):
    """Identify user-state archive paths, excluding intentional empty home dirs."""
    for path in paths:
        name = path.lstrip("./").rstrip("/")
        if name == "root" or name.startswith("root/"):
            if name not in {"root/.dsh", "root/.l2s", "root/workspace"}:
                yield name
        if name.startswith("tmp/") or name.startswith("var/log/"):
            yield name
