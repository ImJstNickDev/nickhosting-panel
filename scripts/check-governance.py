#!/usr/bin/env python3
"""Check M0's Git index before publication; heuristic scans are not a secret audit."""

import ipaddress
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import sys
import tempfile
import tomllib
from urllib.parse import unquote, urlsplit


def git(*args, cwd=None, input=None):
    return subprocess.run(["git", *args], cwd=cwd, input=input, capture_output=True)


def main():
    root_result = git("rev-parse", "--show-toplevel")
    if root_result.returncode:
        print("FAIL: run inside the initialized project Git repository")
        return 1
    root = Path(os.fsdecode(root_result.stdout.strip()))
    failures, files = [], {}
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
            failures.append(f"{path}: prohibited M0 publication path")
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

    directories = {str(parent) for path in files
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
            if resolved not in files and resolved not in directories:
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
    print(f"Checked {len(files)} indexed text files, {links} relative links, "
          f"{len(tomls)} TOML files and {len(excluded) + len(allowed)} ignore cases.")
    for failure in failures:
        print(f"FAIL: {failure}")
    print("FAIL" if failures else "PASS: M0 index governance checks (secret scan is heuristic).")
    return int(bool(failures))


if __name__ == "__main__":
    sys.exit(main())
