"""Build an allowlisted Blueprint ZIP locally; never run the Panel installer."""

import argparse
from pathlib import Path
import stat
import zipfile

FILES = (
    "conf.yml",
    "app/Http/Controllers/CapabilitiesController.php",
    "app/Http/Requests/CapabilitiesRequest.php",
    "routes/application.php",
)
ROOT = Path(__file__).absolute().parent


def no_symlinks(path):
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError(f"Symlink is not allowed: {part}")


def build(source, output):
    source = Path(source).absolute()
    output = Path(output).absolute()
    no_symlinks(source)
    no_symlinks(output)
    if output.suffix != ".blueprint":
        raise ValueError("Output must end in .blueprint")
    if output.exists():
        raise FileExistsError(output)
    contents = []
    for name in FILES:
        path = source / name
        no_symlinks(path)
        if not stat.S_ISREG(path.stat().st_mode):
            raise ValueError(f"Not a regular file: {name}")
        contents.append((name, path.read_bytes()))
    output.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation prevents overwriting a concurrently created artifact.
    with output.open("xb") as target:
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, content in contents:
                info = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, content)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output", type=Path,
        default=ROOT.parent.parent / "mountdata/build/blueprint/0.1.0-dev/nickhosting.blueprint",
    )
    print(build(ROOT, parser.parse_args().output))
