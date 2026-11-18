#!/usr/bin/env python3
"""Prepare a private runtime resource bundle from an official Java Edition client.

Usage: python3 scripts/prepare-minecraft-vanilla-resources.py 1.16.5 client.jar ./mountdata
The mountdata root must already exist. No Mojang assets belong in Git. The two
known releases can be prepared offline. Other releases look up the expected
checksum in Mojang's official version manifest; the JAR itself is always local.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import tempfile
import urllib.request
from pathlib import Path
from zipfile import ZipFile

CLIENTS = {
    "1.16.5": ("37fd3c903861eeff3bc24b71eed48f828b5269c8", 17547153),
    "26.1": ("191771837687b766537a8c4607cb6fad79c533a1", 38113398),
}
ASSET = re.compile(r"assets/minecraft/(?:(?:items|models)/[a-z0-9_./-]+\.json|textures/[a-z0-9_./-]+\.png)")
MAX_SIZE = 16 * 1024**2


def expected_client(release):
    if release in CLIENTS:
        return CLIENTS[release]
    with urllib.request.urlopen("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", timeout=20) as result:
        versions = json.load(result)["versions"]
    version = next((item for item in versions if item["id"] == release), None)
    if not version or not version["url"].startswith("https://piston-meta.mojang.com/"):
        raise ValueError("unknown Java Edition release")
    with urllib.request.urlopen(version["url"], timeout=20) as result:
        metadata = result.read()
    if hashlib.sha1(metadata).hexdigest() != version["sha1"]:
        raise ValueError("release metadata checksum mismatch")
    client = json.loads(metadata)["downloads"]["client"]
    return client["sha1"], client["size"]


def prepare(release, client, root):
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,79}", release):
        raise ValueError("invalid release")
    root = root.absolute()
    if not root.is_dir() or root.resolve() != root:
        raise ValueError("expected an existing mountdata directory without symlinks")
    checksum, size = expected_client(release)
    assets = {}
    with client.open("rb") as source:
        if os.fstat(source.fileno()).st_size != size or hashlib.file_digest(source, "sha1").hexdigest() != checksum:
            raise ValueError("official client checksum/size mismatch")
        with ZipFile(source) as archive:
            for info in archive.infolist():
                path = info.filename
                if not ASSET.fullmatch(path) or any(part in ("", ".", "..") for part in path.split("/")):
                    continue
                if info.file_size > 512 * 1024:
                    continue  # Larger resources exceed the renderer's existing per-entry ceiling.
                if path in assets or len(assets) >= 32000:
                    raise ValueError("invalid resource index")
                assets[path] = base64.b64encode(archive.read(info)).decode("ascii")
    output = json.dumps({"format": 1, "release": release, "clientSha1": checksum, "assets": assets},
                        separators=(",", ":"), sort_keys=True).encode("ascii")
    if len(output) > MAX_SIZE:
        raise ValueError("vanilla bundle exceeds size limit")
    directory = root / "minecraft-vanilla-resources"
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.resolve() != directory:
        raise ValueError("resource directory must not be a symlink")
    target = directory / f"{release}.json"
    with tempfile.NamedTemporaryFile(dir=directory, delete=False) as temp:
        staging = Path(temp.name)
    try:
        staging.write_bytes(output)
        try:
            os.link(staging, target)
        except FileExistsError:
            if target.is_symlink() or not target.is_file() or target.read_bytes() != output:
                raise ValueError(f"existing bundle differs: {target}")
    finally:
        staging.unlink()
    print(f"{release}  {len(assets)} resources  {len(output)} bytes  {target}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release")
    parser.add_argument("client_jar", type=Path)
    parser.add_argument("mountdata_root", type=Path)
    args = parser.parse_args()
    prepare(args.release, args.client_jar, args.mountdata_root)
