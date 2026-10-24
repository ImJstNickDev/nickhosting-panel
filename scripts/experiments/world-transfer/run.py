#!/usr/bin/env python3
"""Run a source-version-pinned local probe; no Docker, API, credentials or live files.

Toolchain, modules, fixtures and results stay in gitignored project test state.
Only this script's generated rename fixture is removed by the Go program.
"""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

REPOSITORY = Path(__file__).resolve().parents[3]
STORAGE_ROOT = Path(subprocess.check_output(
    ["node", str(REPOSITORY / "deploy/storage-root.mjs"), "--workspace",
     str(REPOSITORY), "--require-existing"], text=True
).strip())
STATE = STORAGE_ROOT / "test-assets/world-transfer-feasibility"
TOOLCHAIN = "go1.21.13.linux-amd64.tar.gz"
TOOLCHAIN_SHA256 = "502fc16d5910562461e6a6631fb6377de2322aad7304bf2bcd23500ba9dab4a7"


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    archive = STATE / TOOLCHAIN
    if not archive.exists():
        with urllib.request.urlopen("https://go.dev/dl/" + TOOLCHAIN) as response:
            with archive.open("xb") as output:
                shutil.copyfileobj(response, output)
    digest = hashlib.file_digest(archive.open("rb"), "sha256").hexdigest()
    if digest != TOOLCHAIN_SHA256:
        raise RuntimeError("Go toolchain checksum mismatch; preserve file for inspection")
    toolchain = STATE / "go"
    if not toolchain.exists():
        with tarfile.open(archive) as source:
            for entry in source.getmembers():
                path = Path(entry.name)
                if path.is_absolute() or ".." in path.parts or not (entry.isfile() or entry.isdir()):
                    raise RuntimeError("Unexpected Go toolchain archive member")
            source.extractall(STATE)
    workspace = STATE / "workspace"
    workspace.mkdir(exist_ok=True)
    (workspace / "go.mod").write_text(
        "module nickhosting-world-transfer-feasibility\n\ngo 1.21\n\n"
        "require (\n"
        " github.com/mholt/archiver/v4 v4.0.0-alpha.8\n"
        " github.com/klauspost/compress v1.17.8\n"
        " github.com/klauspost/pgzip v1.2.6\n"
        ")\n"
    )
    shutil.copyfile(Path(__file__).with_name("integrity-probe.go"), workspace / "main.go")
    environment = dict(os.environ, GOPATH=str(STATE / "gopath"),
                       GOCACHE=str(STATE / "build-cache"), GOTOOLCHAIN="local")
    command = [str(toolchain / "bin/go"), "run", "-mod=mod", "."]
    run = subprocess.run(command, cwd=workspace, env=environment,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    (STATE / "results.json").write_text(run.stdout)
    (STATE / "run.stderr").write_text(run.stderr)
    print(run.stdout, end="")
    if run.returncode:
        print(run.stderr, end="")
        raise SystemExit(run.returncode)
    print(f"Evidence: {STATE / 'results.json'}")


if __name__ == "__main__":
    main()
