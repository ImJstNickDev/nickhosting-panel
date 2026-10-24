#!/usr/bin/env python3
"""Prepare optional player UI textures from an entitled, official Minecraft 26.1 jar.

Offline only. Requires Python >=3.11 and Pillow==12.1.1. The pinned client SHA1
is the same official release verified by prepare-minecraft-ui-assets.py.
No automatic build hooks or downloads. Outputs stay in the ignored local asset
tree; this tool grants no permission to redistribute Mojang resources.

Supported models: untinted, single-layer generated/handheld items and unrotated,
full cubes. Complex, tinted, conditional and modded models deliberately fall back
to their textual item ID in the app. Cube previews use three original textures
with fixed isometric projection and lighting, not a complete Minecraft renderer.
Animated textures use their first frame. Source/output hashes and omissions are
recorded separately in players-provenance.json. A single square SVG atlas plus
identifier index serves item icons; eight HUD PNGs retain their native aspect.
Ten XP digit PNGs use the client bitmap font, green fill and cardinal black outline.
Existing differing artwork and symlink paths are rejected before any write.
--update-provenance permits only a verified additive metadata upgrade.
"""

import argparse
import base64
import hashlib
import io
import json
import re
from pathlib import Path
from zipfile import ZipFile

from PIL import Image, ImageDraw, ImageEnhance

CLIENT_SHA1 = "191771837687b766537a8c4607cb6fad79c533a1"
CLIENT_SIZE = 38113398
OUTPUT = Path(__file__).resolve().parents[1] / "games/minecraft/src/ui/assets/local-26.1"
HUD = {
    "heart_container": "heart/container",
    "heart_full": "heart/full",
    "heart_half": "heart/half",
    "food_empty": "food_empty",
    "food_full": "food_full",
    "food_half": "food_half",
    "experience_bar_background": "experience_bar_background",
    "experience_bar_progress": "experience_bar_progress",
}


class Unsupported(ValueError):
    """A model requiring a renderer this focused preparer does not implement."""


def resource(value):
    if not isinstance(value, str):
        raise Unsupported("invalid resource identifier")
    name = value.removeprefix("minecraft:")
    if ":" in name or not re.fullmatch(r"[a-z0-9_]+(?:/[a-z0-9_]+)*", name):
        raise Unsupported("unsupported resource identifier")
    return name


class Resources:
    def __init__(self, archive):
        self.archive = archive
        self.sources = {}

    def read(self, path):
        try:
            data = self.archive.read(path)
        except KeyError as error:
            raise Unsupported("missing model resource") from error
        self.sources[path] = data
        return data

    def json(self, path):
        return json.loads(self.read(path))

    def model(self, name, stack=()):
        name = resource(name)
        if name in stack or len(stack) >= 32:
            raise Unsupported("cyclic or excessive model ancestry")
        if name == "builtin/generated":
            return {"generated": True, "textures": {}}
        own = self.json(f"assets/minecraft/models/{name}.json")
        inherited = self.model(own["parent"], (*stack, name)) if "parent" in own else {}
        return {**inherited, **own, "textures": {**inherited.get("textures", {}), **own.get("textures", {})}}

    def texture(self, reference, textures):
        seen = set()
        while True:
            if not isinstance(reference, str):
                raise Unsupported("non-string texture resource")
            if not reference.startswith("#"):
                break
            key = reference[1:]
            if key in seen or key not in textures:
                raise Unsupported("unresolved texture reference")
            seen.add(key)
            reference = textures[key]
        data = self.read(f"assets/minecraft/textures/{resource(reference)}.png")
        with Image.open(io.BytesIO(data)) as source:
            image = source.convert("RGBA")
        if image.width > 256 or image.height > 4096 or image.height % image.width:
            raise Unsupported("unsupported texture dimensions")
        return image.crop((0, 0, image.width, image.width))


def png(image):
    output = io.BytesIO()
    image.save(output, format="PNG", optimize=False, compress_level=9)
    return output.getvalue()


def experience_digits(resources):
    """Extract the native 5x7 digits with the HUD's one-pixel cardinal outline."""
    definition = resources.json("assets/minecraft/font/include/default.json")
    provider = next((entry for entry in definition["providers"]
                     if entry.get("type") == "bitmap" and entry.get("file") == "minecraft:font/ascii.png"), None)
    if provider is None or provider.get("ascent") != 7:
        raise Unsupported("unsupported XP bitmap font provider")
    rows = provider["chars"]
    if len(rows) != 16 or any(len(row) != 16 for row in rows):
        raise Unsupported("unsupported XP bitmap font grid")
    with Image.open(io.BytesIO(resources.read("assets/minecraft/textures/font/ascii.png"))) as source:
        atlas = source.convert("RGBA")
    if atlas.size != (128, 128):
        raise Unsupported("unsupported XP bitmap font dimensions")
    outputs = {}
    for digit in "0123456789":
        positions = [(column, row) for row, text in enumerate(rows) for column, character in enumerate(text) if character == digit]
        if len(positions) != 1:
            raise Unsupported("missing or ambiguous XP digit")
        column, row = positions[0]
        cell = atlas.crop((column * 8, row * 8, column * 8 + 8, row * 8 + 8))
        if cell.getchannel("A").getbbox() != (0, 0, 5, 7):
            raise Unsupported("unsupported XP digit bounds")
        mask = cell.crop((0, 0, 5, 7)).getchannel("A")
        glyph = Image.new("RGBA", (5, 7), "black")
        glyph.putalpha(mask)
        result = Image.new("RGBA", (7, 9))
        for offset in ((0, 1), (2, 1), (1, 0), (1, 2)):
            result.alpha_composite(glyph, offset)
        glyph = Image.new("RGBA", (5, 7), "#80ff20")
        glyph.putalpha(mask)
        result.alpha_composite(glyph, (1, 1))
        outputs[f"player-hud/experience_digit_{digit}.png"] = png(result)
    return outputs


def cube_icon(top, left, right):
    """Project source texels onto three parallelograms, with fixed face lighting."""
    result = Image.new("RGBA", (32, 32))
    faces = (
        (top, (0.5, 1, -8, -0.5, 1, 8), ((16, 0), (32, 8), (16, 16), (0, 8)), 1),
        (left, (1, 0, 0, -0.5, 1, -8), ((0, 8), (16, 16), (16, 32), (0, 24)), 0.8),
        (right, (1, 0, -16, 0.5, 1, -24), ((16, 16), (32, 8), (32, 24), (16, 32)), 0.65),
    )
    for texture, matrix, polygon, brightness in faces:
        source = texture.resize((16, 16), Image.Resampling.NEAREST)
        source = ImageEnhance.Brightness(source).enhance(brightness)
        projected = source.transform((32, 32), Image.Transform.AFFINE, matrix, Image.Resampling.NEAREST)
        mask = Image.new("L", (32, 32))
        ImageDraw.Draw(mask).polygon(polygon, fill=255)
        # Preserve transparent pixels rather than filling glass/leaves faces.
        projected.putalpha(Image.frombytes("L", mask.size, bytes(
            a * m // 255 for a, m in zip(projected.getchannel("A").tobytes(), mask.tobytes())
        )))
        result.alpha_composite(projected)
    return result


def item_icon(resources, definition):
    node = definition.get("model", {})
    if node.get("type") != "minecraft:model" or node.get("tints"):
        raise Unsupported("conditional, special, composite or tinted item")
    model = resources.model(node["model"])
    textures = model.get("textures", {})
    if model.get("generated") and not model.get("elements"):
        if "layer0" not in textures or any(key.startswith("layer") and key != "layer0" for key in textures):
            raise Unsupported("layered item")
        return resources.texture("#layer0", textures), "flat"
    elements = model.get("elements", [])
    if len(elements) != 1:
        raise Unsupported("complex block geometry")
    element = elements[0]
    if element.get("from") != [0, 0, 0] or element.get("to") != [16, 16, 16] or element.get("rotation"):
        raise Unsupported("non-cube geometry")
    faces = element.get("faces", {})
    if len(faces) != 6 or any(
        face.get("rotation", 0) or "tintindex" in face or face.get("uv", [0, 0, 16, 16]) != [0, 0, 16, 16]
        for face in faces.values()
    ):
        raise Unsupported("partial, tinted or transformed cube")
    return cube_icon(*(resources.texture(faces[face]["texture"], textures) for face in ("up", "south", "east"))), "cube"


def make_atlas(outputs):
    """One square SVG resource; named views select each original item PNG rectangle."""
    images, views, index = [], [], {"items": {}}
    x = y = row_height = 0
    for name, data in sorted(outputs.items()):
        if not name.startswith("player-items/") or not name.endswith(".png"):
            continue
        group, identifier = name.removesuffix(".png").split("/", 1)
        category = "items" if group == "player-items" else "hud"
        fragment = category + "-" + identifier.replace("/", "--")
        with Image.open(io.BytesIO(data)) as image:
            width, height = image.size
        if x + width > 1024:
            x, y, row_height = 0, y + row_height, 0
        views.append(f'<view id="{fragment}" viewBox="{x} {y} {width} {height}"/>')
        encoded = base64.b64encode(data).decode("ascii")
        images.append(f'<image x="{x}" y="{y}" width="{width}" height="{height}" href="data:image/png;base64,{encoded}"/>')
        index[category][identifier] = fragment
        x += width
        row_height = max(row_height, height)
    height = max(1, y + row_height)
    # A square intrinsic viewport is required: a wide root causes neighboring
    # sprites to bleed into the letterbox even when the named view is correct.
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 1024 {height}">' + "".join(views + images) + '</svg>\n'
    return {
        "player-atlas.svg": svg.encode(),
        "player-atlas.json": (json.dumps(index, sort_keys=True, separators=(",", ":")) + "\n").encode(),
    }


def prepare(archive):
    resources = Resources(archive)
    outputs, omitted, counts = {}, {}, {"flat": 0, "cube": 0}
    prefix = "assets/minecraft/items/"
    items = sorted(name for name in archive.namelist() if name.startswith(prefix) and name.endswith(".json"))
    for path in items:
        identifier = resource(path[len(prefix):-5])
        try:
            image, kind = item_icon(resources, resources.json(path))
        except Unsupported as error:
            omitted[identifier] = str(error)
            continue
        outputs[f"player-items/{identifier}.png"] = png(image)
        counts[kind] += 1
    for name, source in HUD.items():
        outputs[f"player-hud/{name}.png"] = resources.read(f"assets/minecraft/textures/gui/sprites/hud/{source}.png")
    outputs.update(experience_digits(resources))
    outputs.update(make_atlas(outputs))
    manifest = {
        "version": "26.1", "clientSha1": CLIENT_SHA1,
        "clientUrl": f"https://piston-data.mojang.com/v1/objects/{CLIENT_SHA1}/client.jar",
        "usageGuidelines": "https://www.minecraft.net/en-us/usage-guidelines",
        "redistributionLicense": None,
        "notice": "Local optional resources; no redistribution permission granted.",
        "rendering": "Single-layer items; first texture frame; fixed three-face isometric full cubes, not the client renderer.",
        "coverage": {**counts, "omitted": len(omitted), "hud": len(HUD)},
        "experienceDigits": {"count": 10, "size": [7, 9], "fill": "#80ff20", "outline": "one-pixel cardinal black"},
        "omitted": omitted,
        "sources": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(resources.sources.items())},
        "outputs": {name: hashlib.sha256(data).hexdigest() for name, data in sorted(outputs.items())},
    }
    outputs["players-provenance.json"] = (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode()
    return outputs, manifest["coverage"]


def write_outputs(output, outputs, update_provenance=False):
    upgrade = False
    previous_path = output / "players-provenance.json"
    if update_provenance and previous_path.exists():
        if any(path.is_symlink() for path in [previous_path, *previous_path.parents]):
            raise ValueError("Refusing a symlinked provenance path")
        previous = json.loads(previous_path.read_bytes())
        current = json.loads(outputs["players-provenance.json"])
        for key, value in previous.items():
            if key in ("sources", "outputs"):
                if any(current.get(key, {}).get(name) != digest for name, digest in value.items()):
                    raise ValueError("Provenance upgrade changed existing source/output hashes")
            elif current.get(key) != value:
                raise ValueError("Provenance upgrade changed existing metadata")
        upgrade = True
    # Preflight all targets before writing: a collision cannot partially upgrade
    # another known asset set. Exclusive file creation rejects races at leaf paths.
    for name, content in outputs.items():
        if not re.fullmatch(r"[a-z0-9_/-]+\.(?:png|json|svg)", name) or ".." in name:
            raise ValueError("Unsafe output name")
        path = output / name
        if any(parent.is_symlink() for parent in [path, *path.parents]):
            raise ValueError("Refusing a symlinked output or ancestor")
        if upgrade and name == "players-provenance.json":
            continue
        if path.exists() and (not path.is_file() or path.read_bytes() != content):
            raise ValueError(f"Refusing different existing output: {name}")
    for name, content in outputs.items():
        path = output / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if upgrade and name == "players-provenance.json":
            path.write_bytes(content)
        elif not path.exists():
            with path.open("xb") as target:
                target.write(content)


def verified_client(path):
    if path.stat().st_size != CLIENT_SIZE:
        raise ValueError("Client jar size does not match official Minecraft 26.1")
    data = path.read_bytes()
    if hashlib.sha1(data).hexdigest() != CLIENT_SHA1:
        raise ValueError("Client jar hash does not match official Minecraft 26.1")
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("client_jar", type=Path)
    parser.add_argument("--update-provenance", action="store_true", help="Allow only verified additive provenance metadata upgrades; artwork remains immutable.")
    args = parser.parse_args()
    try:
        data = verified_client(args.client_jar)
        with ZipFile(io.BytesIO(data)) as archive:
            outputs, counts = prepare(archive)
        write_outputs(OUTPUT, outputs, args.update_provenance)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(counts, sort_keys=True))


if __name__ == "__main__":
    main()
