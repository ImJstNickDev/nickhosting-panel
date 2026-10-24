#!/usr/bin/env python3
"""Prepare optional local Minecraft 26.1 preview resources from an official client jar.

No network requests, automatic build hooks, credentials, or server changes. Outputs
stay gitignored: original/derived Mojang assets are not repository-licensed files.
Use only a client jar you are entitled to use, subject to the Minecraft EULA and
Usage Guidelines. This tool does not grant permission to redistribute its outputs.

Run with Python >=3.11 and fonttools==4.61.1, Pillow==12.1.1 installed in a local
virtual environment, then pass the path to the official 26.1 client.jar. Example:
  python scripts/prepare-minecraft-ui-assets.py /path/to/26.1/client.jar

The actual panorama is in Mojang's external asset index, not the 1-pixel
placeholders in the client jar. Optionally pass --asset-index /path/to/30.json
and --asset-objects /path/to/assets/objects from a local 26.1 installation.
Both the index and referenced objects are checked against official SHA1 values.
No downloads are performed. --update-provenance permits a verified, additive
manifest upgrade; existing artwork and font files are never overwritten.

The exact release SHA1 is pinned to Mojang's official version metadata. Bitmap
pixels become vector contours (no invented artwork), preserving glyph advances,
baseline and accented-character providers. Browser rasterization and synthetic
bold/italic can still differ slightly from Minecraft's bitmap renderer.
"""

import argparse
import hashlib
import io
import json
from pathlib import Path
from zipfile import ZipFile

CLIENT_SHA1 = "191771837687b766537a8c4607cb6fad79c533a1"
CLIENT_URL = f"https://piston-data.mojang.com/v1/objects/{CLIENT_SHA1}/client.jar"
ASSET_INDEX_SHA1 = "191104515165d806db18f954694a4407a1b0ccd9"
ASSET_INDEX_URL = f"https://piston-meta.mojang.com/v1/packages/{ASSET_INDEX_SHA1}/30.json"
OUTPUT = Path(__file__).resolve().parents[1] / "games/minecraft/src/ui/assets/local-26.1"
TEXTURES = {
    "menu-background.png": "gui/menu_background.png",
    "server-icon.png": "misc/unknown_server.png",
    "ping.png": "gui/sprites/server_list/ping_5.png",
    "button.png": "gui/sprites/widget/button.png",
    "button-highlighted.png": "gui/sprites/widget/button_highlighted.png",
    "button-disabled.png": "gui/sprites/widget/button_disabled.png",
    "menu-list-background.png": "gui/menu_list_background.png",
    "header-separator.png": "gui/header_separator.png",
    "footer-separator.png": "gui/footer_separator.png",
}


def make_font(archive):
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen
    from PIL import Image

    empty = TTGlyphPen(None).glyph()
    glyphs = {".notdef": empty}
    metrics = {".notdef": (600, 0)}
    cmap = {}
    sources = {}

    def add_space(codepoint, width):
        name = f"uni{codepoint:04X}"
        cmap[codepoint] = name
        glyphs[name] = TTGlyphPen(None).glyph()
        metrics[name] = (round(width * 100), 0)

    space_path = "assets/minecraft/font/include/space.json"
    sources[space_path] = archive.read(space_path)
    for provider in json.loads(sources[space_path])["providers"]:
        for character, width in provider["advances"].items():
            add_space(ord(character), width)

    definition_path = "assets/minecraft/font/include/default.json"
    sources[definition_path] = archive.read(definition_path)
    for provider in json.loads(sources[definition_path])["providers"]:
        if provider["type"] != "bitmap":
            continue
        namespace, path = provider["file"].split(":", 1)
        texture_path = f"assets/{namespace}/textures/{path}"
        sources[texture_path] = archive.read(texture_path)
        image = Image.open(io.BytesIO(sources[texture_path])).convert("RGBA")
        rows = provider["chars"]
        cell_width = image.width // len(rows[0])
        cell_height = image.height // len(rows)
        ratio = provider.get("height", 8) / cell_height
        ascent = provider["ascent"]
        for row_index, row in enumerate(rows):
            for column_index, character in enumerate(row):
                codepoint = ord(character)
                if codepoint == 0 or codepoint in cmap:
                    continue
                pen = TTGlyphPen(None)
                rightmost = 0
                leftmost = cell_width
                for y in range(cell_height):
                    x = 0
                    while x < cell_width:
                        def opaque(column):
                            return image.getpixel((column_index * cell_width + column, row_index * cell_height + y))[3] != 0

                        if not opaque(x):
                            x += 1
                            continue
                        start = x
                        while x < cell_width and opaque(x):
                            x += 1
                        rightmost = max(rightmost, x)
                        leftmost = min(leftmost, start)
                        left = round(start * ratio * 100)
                        right = round(x * ratio * 100)
                        top = round((ascent - y * ratio) * 100)
                        bottom = round((ascent - (y + 1) * ratio) * 100)
                        pen.moveTo((left, bottom))
                        pen.lineTo((left, top))
                        pen.lineTo((right, top))
                        pen.lineTo((right, bottom))
                        pen.closePath()
                name = f"uni{codepoint:04X}"
                cmap[codepoint] = name
                glyphs[name] = pen.glyph()
                advance = int(0.5 + rightmost * ratio) + 1
                metrics[name] = (advance * 100, round(leftmost * ratio * 100) if rightmost else 0)

    builder = FontBuilder(900, isTTF=True)
    builder.setupGlyphOrder(list(glyphs))
    builder.setupCharacterMap(cmap)
    builder.setupGlyf(glyphs)
    builder.setupHorizontalMetrics(metrics)
    builder.setupHorizontalHeader(ascent=700, descent=-200, lineGap=0)
    builder.setupNameTable({
        "familyName": "Minecraft 26.1 Local Preview",
        "styleName": "Regular",
        "uniqueFontIdentifier": f"Minecraft-26.1-local-preview-{CLIENT_SHA1}",
        "fullName": "Minecraft 26.1 Local Preview Regular",
        "psName": "Minecraft261LocalPreview-Regular",
        "version": "Version 1.0",
        "copyright": "Derived locally from Mojang Minecraft 26.1 assets; Minecraft EULA applies.",
    })
    builder.setupOS2(version=4, sTypoAscender=700, sTypoDescender=-200, sTypoLineGap=0,
                    usWinAscent=1200, usWinDescent=400, fsSelection=64 | 128)
    builder.setupPost()
    builder.font.flavor = "woff"
    # Stable artifact hashes across repeated local preparation.
    builder.font["head"].created = builder.font["head"].modified = 3857212800
    builder.font.recalcTimestamp = False
    stream = io.BytesIO()
    builder.font.save(stream)
    return stream.getvalue(), sources, len(cmap)


def load_panorama(index_path, objects_path):
    """Use a static, unmodified 90-degree cubemap face, not invented scenery."""
    from PIL import Image

    index_bytes = index_path.read_bytes()
    if hashlib.sha1(index_bytes).hexdigest() != ASSET_INDEX_SHA1:
        raise ValueError("Asset index does not match the official Minecraft 26.1 release.")
    index = json.loads(index_bytes)["objects"]
    sources = {}
    outputs = {}
    for target, filename in (("panorama.png", "panorama_0.png"),
                             ("panorama-overlay.png", "panorama_overlay.png")):
        source = "minecraft/textures/gui/title/background/" + filename
        record = index[source]
        digest = record["hash"]
        data = (objects_path / digest[:2] / digest).read_bytes()
        if len(data) != record["size"] or hashlib.sha1(data).hexdigest() != digest:
            raise ValueError(f"Invalid official asset object: {source}")
        with Image.open(io.BytesIO(data)) as image:
            if target == "panorama.png" and (image.width < 256 or image.height < 256):
                raise ValueError("Panorama cannot be a placeholder texture.")
        sources[source] = data
        outputs[target] = data
    return outputs, sources


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("client_jar", type=Path)
    parser.add_argument("--asset-index", type=Path)
    parser.add_argument("--asset-objects", type=Path)
    parser.add_argument("--update-provenance", action="store_true",
                        help="Allow only a verified additive provenance manifest upgrade.")
    args = parser.parse_args()
    if bool(args.asset_index) != bool(args.asset_objects):
        parser.error("Pass --asset-index and --asset-objects together.")
    if args.client_jar.stat().st_size != 38113398:
        parser.error("The client jar size does not match the official Minecraft 26.1 release.")
    data = args.client_jar.read_bytes()
    if hashlib.sha1(data).hexdigest() != CLIENT_SHA1:
        parser.error("The client jar does not match the official Minecraft 26.1 release.")
    with ZipFile(io.BytesIO(data)) as archive:
        font, sources, glyph_count = make_font(archive)
        outputs = {"minecraft.woff": font}
        for target, source in TEXTURES.items():
            path = "assets/minecraft/textures/" + source
            outputs[target] = sources[path] = archive.read(path)
        outputs["MINECRAFT-LICENSE.txt"] = archive.read("META-INF/LICENSE")
    if args.asset_index:
        try:
            panorama_outputs, panorama_sources = load_panorama(args.asset_index, args.asset_objects)
        except (OSError, ValueError, KeyError) as error:
            parser.error(str(error))
        outputs.update(panorama_outputs)
        sources.update(panorama_sources)
    manifest = {
        "version": "26.1", "clientUrl": CLIENT_URL, "clientSha1": CLIENT_SHA1,
        "usageGuidelines": "https://www.minecraft.net/en-us/usage-guidelines",
        "redistributionLicense": None,
        "notice": "Local optional resources; this tool grants no redistribution permission.",
        "font": {"glyphCount": glyph_count, "emSize": 900, "baseLineHeight": 9,
                 "fallback": "Browser fallback for characters outside vanilla bitmap providers."},
        "sources": {name: hashlib.sha256(content).hexdigest() for name, content in sources.items()},
        "outputs": {name: hashlib.sha256(content).hexdigest() for name, content in outputs.items()},
    }
    if args.asset_index:
        manifest["panorama"] = {
            "assetIndexUrl": ASSET_INDEX_URL, "assetIndexSha1": ASSET_INDEX_SHA1,
            "view": "Unmodified panorama_0 cubemap face; static 90-degree perspective.",
            "presentation": "CSS may crop and blur this face; this is not the client's rotating cubemap renderer.",
        }
    outputs["provenance.json"] = (json.dumps(manifest, indent=2) + "\n").encode()
    # Refuse symlinked output paths; only touch this explicit ignored asset tree.
    if any(parent.is_symlink() for parent in [OUTPUT, *OUTPUT.parents]):
        parser.error("The output directory or an ancestor is a symlink.")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    previous_manifest_path = OUTPUT / "provenance.json"
    if args.update_provenance and previous_manifest_path.exists():
        if previous_manifest_path.is_symlink():
            parser.error("Refusing symlinked provenance manifest.")
        try:
            previous = json.loads(previous_manifest_path.read_bytes())
            for key in ("version", "clientUrl", "clientSha1", "font", "usageGuidelines", "redistributionLicense", "notice"):
                if previous[key] != manifest[key]:
                    raise ValueError(f"Changed provenance identity: {key}")
            for name, digest in previous["sources"].items():
                if manifest["sources"].get(name) != digest:
                    raise ValueError(f"Changed source: {name}")
            for name, digest in previous["outputs"].items():
                if manifest["outputs"].get(name) != digest:
                    raise ValueError(f"Changed output: {name}")
        except (ValueError, KeyError, TypeError) as error:
            parser.error(f"Refusing non-additive provenance update: {error}")
    for name in outputs:
        if (OUTPUT / name).is_symlink():
            parser.error(f"Refusing symlinked output: {name}")
        if name == "provenance.json" and args.update_provenance:
            continue
        if (OUTPUT / name).exists() and (OUTPUT / name).read_bytes() != outputs[name]:
            parser.error(f"Refusing to overwrite a different local resource: {name}")
    for name, content in outputs.items():
        (OUTPUT / name).write_bytes(content)
    print(f"Prepared {len(outputs)} local resources ({glyph_count} glyphs) in {OUTPUT}")


if __name__ == "__main__":
    main()
