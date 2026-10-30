#!/usr/bin/env python3
"""Check the Git index before publication; heuristic scans are not a secret audit."""

import hashlib
import ipaddress
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import struct
import zlib
import sys
import tempfile
import tomllib
from urllib.parse import unquote, urlsplit


def git(*args, cwd=None, input=None):
    return subprocess.run(["git", *args], cwd=cwd, input=input, capture_output=True)


# Reviewed official provider marks; exact paths and hashes, never arbitrary binaries.
PROVIDER_MARKS = {
    "apps/web/src/integrations/minecraft/provider-logos/curseforge.ico": "b1c9f08adaa8f91957bcd20e2796814557683ed051173ae31779752632efc5b9",
    "apps/web/src/integrations/minecraft/provider-logos/ftb.png": "40ecb82b09c672c9220f17ff770e8b4394c1b4b022faa1854c9b8bb22ba13f14",
    "apps/web/src/integrations/minecraft/provider-logos/modrinth.png": "893398804334d69eb89d0d3748a454e6ea530df62cf1894b4f50535dc4a4ae86",
    "apps/web/src/integrations/minecraft/provider-logos/technic.ico": "80707aa58b73ff234d13c8d5242bcb2f5804d984190ec40d44cdc12a48cd867d",
    "apps/web/src/integrations/minecraft/provider-logos/voidswrath.png": "c006fccc62d1bcc560d3bd015ca930a534f7abd35e6485575719d8716bba634f",
}


# Owner-supplied Minecraft runtime logos, pinned after image inspection.
RUNTIME_MARKS = {
    "games/minecraft/src/ui/assets/runtime-logos/arclight.jpeg": "1a2d8daacb07511f33b95b7c312460fc7dafde1c201367c1a72ca387b6c1d971",
    "games/minecraft/src/ui/assets/runtime-logos/fabric.png": "a41878c3c4c5790cfc920eabf98d3404103a74a6f3df69d632ceb220c9ec9dc7",
    "games/minecraft/src/ui/assets/runtime-logos/folia.png": "3d1756e0cd952d067826de6e38de073a01b83a9b23791917d87fbaea6ad46180",
    "games/minecraft/src/ui/assets/runtime-logos/forge.png": "fe0d6e109bbc2437c269d3b5f8f329b19a9193be935c380a466f24631cfbe1bb",
    "games/minecraft/src/ui/assets/runtime-logos/neoforge.png": "3d1b1c1ed65721672c3bcf36a9b8fa0bfc7ff0890ca886961e1009f9a2574bd1",
    "games/minecraft/src/ui/assets/runtime-logos/paper.png": "6eff7892a29d00b698a952388777d42233c154ba836f4d73617e66adba542241",
    "games/minecraft/src/ui/assets/runtime-logos/purpur.png": "2df195e596dbc11778fd40b4703f311b48793f4a73f6ed61586cb5538a7706d9",
    "games/minecraft/src/ui/assets/runtime-logos/vanilla.png": "c50baf7daa929eaf5e7d3c5322059e23319e0e76f6114dfe7e4c8be2b75b9b4b",
}


def safe_provider_mark(path, blob):
    return (PROVIDER_MARKS | RUNTIME_MARKS).get(path) == hashlib.sha256(blob).hexdigest()


def safe_review_png(path, blob):
    """Only browser review PNGs, without embedded text/metadata or trailing data.

    Pixel content still requires a human privacy review; this is not redaction.
    """
    if not re.fullmatch(r"docs/screenshots/m5/[a-z0-9-]+\.png", path):
        return False
    if not 33 <= len(blob) <= 5 * 1024 * 1024 or blob[:8] != b"\x89PNG\r\n\x1a\n":
        return False
    offset, kinds = 8, []
    while offset + 12 <= len(blob):
        size = struct.unpack(">I", blob[offset:offset + 4])[0]
        kind = blob[offset + 4:offset + 8]
        end = offset + size + 12
        if end > len(blob) or kind not in (b"IHDR", b"IDAT", b"IEND"):
            return False
        data = blob[offset + 8:end - 4]
        if zlib.crc32(kind + data) != struct.unpack(">I", blob[end - 4:end])[0]:
            return False
        if kind == b"IHDR":
            if kinds or size != 13:
                return False
            width, height = struct.unpack(">II", data[:8])
            if not 1 <= width <= 4000 or not 1 <= height <= 12000:
                return False
        if kind == b"IEND" and (size or end != len(blob)):
            return False
        kinds.append(kind)
        offset = end
    return offset == len(blob) and kinds[:1] == [b"IHDR"] and kinds[-1:] == [b"IEND"] and b"IDAT" in kinds


def main():
    root_result = git("rev-parse", "--show-toplevel")
    if root_result.returncode:
        print("FAIL: run inside the initialized project Git repository")
        return 1
    root = Path(os.fsdecode(root_result.stdout.strip()))
    failures, files, images, marks = [], {}, set(), set()
    entries = git("ls-files", "--stage", "-z", cwd=root)
    if entries.returncode:
        print("FAIL: cannot read Git index")
        return 1
    for entry in entries.stdout.split(b"\0"):
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        mode, _, stage = metadata.split()
        path = os.fsdecode(raw_path)
        if stage != b"0" or mode not in (b"100644", b"100755"):
            failures.append(f"{path}: unresolved, symlink or non-regular index entry")
            continue
        blob = git("show", f":{path}", cwd=root)
        if not blob.returncode and safe_review_png(path, blob.stdout):
            images.add(path)
            continue
        if not blob.returncode and safe_provider_mark(path, blob.stdout):
            marks.add(path)
            continue
        try:
            if blob.returncode or b"\0" in blob.stdout:
                raise ValueError()
            files[path] = blob.stdout.decode("utf-8")
        except (UnicodeDecodeError, ValueError):
            failures.append(f"{path}: indexed content is not UTF-8 text")
    if not files:
        failures.append("Git index contains no regular text files")

    forbidden = re.compile(
        r"(?:^|/)(?:mountdata|secrets|\.secrets|credentials|backups|dumps|"
        r"\.ssh|node_modules|\.pnpm-store)(?:/|$)|"
        r"(?:^|/)(?:\.envrc|\.netrc|\.npmrc\.local)$|"
        r"\.(?:zip|tar(?:\..*)?|tgz|7z|rar|bak|pem|key|p12|pfx|db(?:-.*)?|"
        r"sqlite3?(?:-.*)?)$|(?:^|/)(?:license|licence)(?:[./-]|$)|"
        r"^\.github/workflows(?:/|$)|^\.codex/(?:local|auth\.json|history\.jsonl|"
        r"sessions|archived_sessions|log|tmp)(?:/|$)", re.I)
    secrets = re.compile(
        r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----|"
        r"\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b|"
        r"\bAKIA[A-Z0-9]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{20,}\b|"
        r"\bptl[ac]_[A-Za-z0-9]{30,}\b")
    private_nets = tuple(ipaddress.ip_network(net) for net in
                         ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
    for path, content in files.items():
        name = PurePosixPath(path).name
        real_env = (name == ".env" or name.startswith(".env.")) and name != ".env.example"
        if forbidden.search(path) or real_env:
            failures.append(f"{path}: prohibited publication path")
        if secrets.search(content):
            failures.append(f"{path}: possible credential signature (value redacted)")
        if path.endswith((".md", ".toml", ".example")):
            if re.search(r"/(?:home|Users)/[^\s/\"'`<>]+", content):
                failures.append(f"{path}: private home-directory path")
            for candidate in re.findall(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", content):
                try:
                    address = ipaddress.ip_address(candidate)
                except ValueError:
                    continue
                if any(address in network for network in private_nets):
                    failures.append(f"{path}: private-network IP address")
                    break

    directories = {str(parent) for path in set(files) | images
                   for parent in PurePosixPath(path).parents}
    links = 0
    for path, content in files.items():
        if not path.endswith(".md"):
            continue
        targets = re.findall(r"!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)", content)
        targets += re.findall(r"^\s{0,3}\[[^\]\n]+\]:\s*(<[^>]+>|\S+)", content, re.M)
        for target in targets:
            try:
                parsed = urlsplit(target.strip("<>"))
            except ValueError:
                failures.append(f"{path}: malformed link destination")
                continue
            if parsed.scheme or parsed.netloc or not parsed.path:
                continue
            resolved = posixpath.normpath(posixpath.join(
                str(PurePosixPath(path).parent), unquote(parsed.path)))
            links += 1
            if resolved not in files and resolved not in images and resolved not in directories:
                failures.append(f"{path}: missing indexed link target {target}")

    tomls = {}
    for path, content in files.items():
        if path.endswith(".toml"):
            try:
                tomls[path] = tomllib.loads(content)
            except tomllib.TOMLDecodeError:
                failures.append(f"{path}: invalid TOML")
    agents = tomls.get(".codex/config.toml", {}).get("agents", {})
    if agents.get("enabled") is not True or agents.get("max_concurrent_threads_per_session") != 3:
        failures.append(".codex/config.toml: expected enabled agents and three subagent slots")
    roles = {"researcher", "implementer", "reviewer"}
    actual = {PurePosixPath(path).stem for path in tomls if path.startswith(".codex/agents/")}
    if actual != roles:
        failures.append(".codex/agents/: expected exactly researcher, implementer and reviewer")
    for role in sorted(roles):
        profile = tomls.get(f".codex/agents/{role}.toml", {})
        if profile.get("name") != role or not profile.get("description") or not profile.get("developer_instructions"):
            failures.append(f"{role}: missing name, description or developer instructions")
        if role != "implementer" and profile.get("sandbox_mode") != "read-only":
            failures.append(f"{role}: profile must request read-only sandbox")

    excluded = [".env", ".env.production", "app/.env.local", "mountdata/test-assets/run.json",
                ".codex/local/INFRASTRUCTURE.md", ".codex/auth.json", ".codex/sessions/run.json",
                "secret.pem", "secret.key", "cert.p12", "cert.pfx", ".envrc", ".netrc",
                ".npmrc.local", ".ssh/id_ed25519", "secrets/token", "credentials/token",
                ".secrets/token", "starter.zip", "starter.ZIP", "archive.tar.gz", "archive.tgz",
                "archive.7z", "archive.rar", "copy.bak", "backups/export.sql", "dumps/db.sql",
                "local.db", "local.db-wal", "local.sqlite", "local.sqlite3-shm", "node_modules/a.js"]
    allowed = [".env.example", "app/.env.example", ".codex/config.toml",
               *[f".codex/agents/{role}.toml" for role in sorted(roles)],
               "migrations/001_init.sql", "README.md", "AGENTS.md", "docs/MILESTONES.md",
               ".github/ISSUE_TEMPLATE/bug.yml", "scripts/check-governance.py"]
    with tempfile.TemporaryDirectory(prefix="nickhosting-ignore-check-") as scratch:
        if git("-c", "init.templateDir=", "init", "--quiet", cwd=scratch).returncode:
            failures.append("could not initialize disposable ignore fixture")
        Path(scratch, ".gitignore").write_text(files.get(".gitignore", ""), encoding="utf-8")
        for path in excluded + allowed:
            result = git("-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-q", path, cwd=scratch)
            if result.returncode not in (0, 1) or (result.returncode == 0) != (path in excluded):
                failures.append(f".gitignore: unexpected result for {path}")
    whitespace = git("diff", "--cached", "--check", cwd=root)
    if whitespace.returncode:
        failures.append("git diff --cached --check failed; inspect locally before publishing")
    print(f"Checked {len(files)} indexed text files, {len(images)} review PNGs, {len(marks)} pinned brand marks, {links} relative links, "
          f"{len(tomls)} TOML files and {len(excluded) + len(allowed)} ignore cases.")
    for failure in failures:
        print(f"FAIL: {failure}")
    print("FAIL" if failures else "PASS: index governance checks (secret scan is heuristic).")
    return int(bool(failures))


if __name__ == "__main__":
    sys.exit(main())
