import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("packager", ROOT / "package.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        shutil.copytree(ROOT, self.source)
        self.output = self.root / "nickhosting.blueprint"

    def test_allowlist_and_deterministic_archive(self):
        (self.source / ".env").write_text("must not be packaged")
        packager.build(self.source, self.output)
        with zipfile.ZipFile(self.output) as archive:
            self.assertEqual(archive.namelist(), list(packager.FILES))
            self.assertIsNone(archive.testzip())
        other = self.root / "other.blueprint"
        packager.build(self.source, other)
        self.assertEqual(self.output.read_bytes(), other.read_bytes())

    def test_required_admin_view_is_declared_and_packaged(self):
        config = (self.source / "conf.yml").read_text()
        self.assertIn("admin:\n  view: admin/view.blade.php\n", config)
        packager.build(self.source, self.output)
        with zipfile.ZipFile(self.output) as archive:
            self.assertIn("admin/view.blade.php", archive.namelist())
        (self.source / "admin/view.blade.php").unlink()
        missing_output = self.root / "missing.blueprint"
        with self.assertRaises(FileNotFoundError):
            packager.build(self.source, missing_output)
        self.assertFalse(missing_output.exists())

    def test_does_not_overwrite(self):
        self.output.write_text("preserve")
        with self.assertRaises(FileExistsError):
            packager.build(self.source, self.output)
        self.assertEqual(self.output.read_text(), "preserve")

    def test_rejects_source_symlink(self):
        config = self.source / "conf.yml"
        config.unlink()
        config.symlink_to(ROOT / "conf.yml")
        with self.assertRaises(ValueError):
            packager.build(self.source, self.output)
        self.assertFalse(self.output.exists())

    def test_rejects_destination_symlink_parent(self):
        alias = self.root / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            packager.build(self.source, alias / "nickhosting.blueprint")

    def test_missing_source_leaves_no_partial_archive(self):
        (self.source / "conf.yml").unlink()
        with self.assertRaises(FileNotFoundError):
            packager.build(self.source, self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
