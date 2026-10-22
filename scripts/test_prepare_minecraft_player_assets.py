"""Offline preparer checks using authored tiny fixtures, never Mojang test assets."""
import importlib.util
import io
import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from PIL import Image

spec = importlib.util.spec_from_file_location("player_assets", Path(__file__).with_name("prepare-minecraft-player-assets.py"))
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


def archive(entries):
    stream = io.BytesIO()
    with ZipFile(stream, "w") as target:
        for name, value in entries.items():
            target.writestr(name, json.dumps(value) if isinstance(value, dict) else value)
    return ZipFile(io.BytesIO(stream.getvalue()))


def generated_entries():
    return {
        "assets/minecraft/models/item/generated.json": {"parent": "builtin/generated"},
        "assets/minecraft/models/item/tool.json": {"parent": "item/generated", "textures": {"layer0": "#main", "main": "item/tool"}},
        "assets/minecraft/textures/item/tool.png": assets.png(Image.new("RGBA", (16, 16), "red")),
    }


class PlayerAssetsTests(unittest.TestCase):
    def test_inherited_flat_model_and_texture_references_use_original_pixels(self):
        with archive(generated_entries()) as jar:
            image, kind = assets.item_icon(assets.Resources(jar), {"model": {"type": "minecraft:model", "model": "item/tool"}})
        self.assertEqual(kind, "flat")
        self.assertEqual(image.getpixel((7, 9)), (255, 0, 0, 255))

    def test_model_and_texture_cycles_fail_without_recursion_or_guessing(self):
        entries = generated_entries()
        entries["assets/minecraft/models/item/loop.json"] = {"parent": "item/loop"}
        with archive(entries) as jar:
            resources = assets.Resources(jar)
            with self.assertRaisesRegex(assets.Unsupported, "cyclic"):
                resources.model("item/loop")
            with self.assertRaisesRegex(assets.Unsupported, "unresolved"):
                resources.texture("#a", {"a": "#b", "b": "#a"})

    def test_tinted_layered_special_and_modded_models_remain_unsupported(self):
        entries = generated_entries()
        entries["assets/minecraft/models/item/layers.json"] = {"parent": "item/generated", "textures": {"layer0": "item/tool", "layer1": "item/tool"}}
        with archive(entries) as jar:
            resources = assets.Resources(jar)
            for model in (
                {"type": "minecraft:model", "model": "item/tool", "tints": [{"type": "minecraft:constant", "value": 1}]},
                {"type": "minecraft:model", "model": "item/layers"},
                {"type": "minecraft:special", "model": "item/tool"},
                {"type": "minecraft:model", "model": "other:item/tool"},
            ):
                with self.subTest(model=model), self.assertRaises(assets.Unsupported):
                    assets.item_icon(resources, {"model": model})

    def test_cube_preserves_texture_colors_with_distinct_face_lighting(self):
        image = assets.cube_icon(*[Image.new("RGBA", (16, 16), color) for color in ("red", "green", "blue")])
        self.assertEqual(image.getpixel((16, 8)), (255, 0, 0, 255))
        self.assertEqual(image.getpixel((8, 20)), (0, 102, 0, 255))
        self.assertEqual(image.getpixel((24, 20)), (0, 0, 165, 255))
        self.assertEqual(image.getpixel((0, 0))[3], 0)

    def test_manifest_is_deterministic_and_records_source_output_and_omission(self):
        entries = generated_entries()
        entries["assets/minecraft/items/tool.json"] = {"model": {"type": "minecraft:model", "model": "item/tool"}}
        entries["assets/minecraft/items/unsupported.json"] = {"model": {"type": "minecraft:special"}}
        for source in assets.HUD.values():
            entries[f"assets/minecraft/textures/gui/sprites/hud/{source}.png"] = assets.png(Image.new("RGBA", (9, 9), "blue"))
        with archive(entries) as jar:
            first, counts = assets.prepare(jar)
            second, _ = assets.prepare(jar)
        self.assertEqual(first, second)
        self.assertEqual(counts, {"flat": 1, "cube": 0, "hud": 8, "omitted": 1})
        manifest = json.loads(first["players-provenance.json"])
        self.assertIn("player-items/tool.png", manifest["outputs"])
        self.assertIn("assets/minecraft/models/item/generated.json", manifest["sources"])
        self.assertIn("unsupported", manifest["omitted"])

    def test_write_collision_preflights_all_outputs_and_allows_identical_rerun(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            assets.write_outputs(root, {"player-items/exists.png": b"original"})
            assets.write_outputs(root, {"player-items/exists.png": b"original"})
            with self.assertRaisesRegex(ValueError, "different existing"):
                assets.write_outputs(root, {"player-items/new.png": b"new", "player-items/exists.png": b"changed"})
            self.assertFalse((root / "player-items/new.png").exists())
            self.assertEqual((root / "player-items/exists.png").read_bytes(), b"original")

    def test_refuses_symlinked_parent_leaf_and_unsafe_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "outside").mkdir()
            (root / "linked").symlink_to(root / "outside", target_is_directory=True)
            with self.assertRaisesRegex(ValueError, "symlink"):
                assets.write_outputs(root / "linked", {"item.png": b"bad"})
            (root / "leaf.png").symlink_to(root / "outside/missing.png")
            with self.assertRaisesRegex(ValueError, "symlink"):
                assets.write_outputs(root, {"leaf.png": b"bad"})
            with self.assertRaisesRegex(ValueError, "Unsafe"):
                assets.write_outputs(root, {"../escape.png": b"bad"})
            self.assertEqual(list((root / "outside").iterdir()), [])

    def test_atlas_has_named_views_and_embedded_pixels_not_external_references(self):
        import xml.etree.ElementTree as xml
        outputs = assets.make_atlas({
            "player-items/tool.png": assets.png(Image.new("RGBA", (16, 16), "red")),
            "player-hud/food_empty.png": assets.png(Image.new("RGBA", (9, 9), "blue")),
        })
        index = json.loads(outputs["player-atlas.json"])
        root = xml.fromstring(outputs["player-atlas.svg"])
        ns = "{http://www.w3.org/2000/svg}"
        self.assertEqual(index["items"]["tool"], "items-tool")
        self.assertEqual(len(root.findall(ns + "view")), 1)
        self.assertEqual(root.attrib["width"], root.attrib["height"])
        self.assertTrue(all(image.attrib["href"].startswith("data:image/png;base64,") for image in root.findall(ns + "image")))

    def test_provenance_upgrade_is_explicit_and_only_additive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old = {"version": "26.1", "sources": {"original": "hash"}, "outputs": {"player-items/tool.png": "hash"}}
            new = {**old, "outputs": {**old["outputs"], "player-atlas.svg": "new-hash"}}
            assets.write_outputs(root, {"players-provenance.json": json.dumps(old).encode()})
            with self.assertRaisesRegex(ValueError, "different existing"):
                assets.write_outputs(root, {"players-provenance.json": json.dumps(new).encode()})
            assets.write_outputs(root, {"players-provenance.json": json.dumps(new).encode()}, True)
            changed = {**new, "version": "other"}
            with self.assertRaisesRegex(ValueError, "metadata"):
                assets.write_outputs(root, {"players-provenance.json": json.dumps(changed).encode()}, True)
            changed = {**new, "sources": {"original": "changed"}}
            with self.assertRaisesRegex(ValueError, "hashes"):
                assets.write_outputs(root, {"players-provenance.json": json.dumps(changed).encode()}, True)

    def test_unverified_jar_is_rejected_before_reading_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "client.jar"
            source.write_bytes(b"unverified")
            with self.assertRaisesRegex(ValueError, "size"):
                assets.verified_client(source)
            with source.open("wb") as target:
                target.truncate(assets.CLIENT_SIZE)
            with self.assertRaisesRegex(ValueError, "hash"):
                assets.verified_client(source)


if __name__ == "__main__":
    unittest.main()
