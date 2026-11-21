import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import install


class InstallTest(unittest.TestCase):
    def test_rolls_back_partial_replacement_then_retries(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            stage = root / 'attempt' / 'new'
            stage.mkdir(parents=True)
            (root / 'assets').mkdir()
            (root / 'assets' / 'old').touch()
            (root / 'openworld-server').write_text('old')
            (root / 'owserver_data').mkdir()
            (root / 'owserver_data' / 'world.cfg').write_text('preserve')
            (stage / 'assets').mkdir()
            (stage / 'assets' / 'new').touch()
            (stage / 'README.txt').write_text('new')
            (stage / 'openworld-server').write_text('new')
            names = ['README.txt', 'assets', 'openworld-server']
            replace = install.os.replace

            def fail_late(src, dst):
                if src == stage / 'openworld-server' and dst == root / 'openworld-server':
                    raise OSError('simulated late write failure')
                replace(src, dst)

            with patch.object(install, 'ROOT', root):
                with patch.object(install.os, 'replace', fail_late), self.assertRaises(OSError):
                    install.publish(stage, names)
                self.assertEqual((root / 'openworld-server').read_text(), 'old')
                self.assertTrue((root / 'assets' / 'old').exists())
                self.assertFalse((root / 'README.txt').exists())
                (stage.parent / 'previous').rmdir()
                install.publish(stage, names)
                self.assertEqual((root / 'openworld-server').read_text(), 'new')
                self.assertTrue((root / 'assets' / 'new').exists())
                self.assertEqual((root / 'owserver_data' / 'world.cfg').read_text(), 'preserve')

    def test_refuses_a_directory_collision_before_replacing_anything(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            stage = root / 'attempt' / 'new'
            stage.mkdir(parents=True)
            (root / 'README.txt').mkdir()
            (root / 'README.txt' / 'mine').touch()
            (root / 'assets').mkdir()
            (root / 'assets' / 'old').touch()
            with patch.object(install, 'ROOT', root), self.assertRaises(ValueError):
                install.publish(stage, ['assets', 'README.txt'])
            self.assertTrue((root / 'README.txt' / 'mine').exists())
            self.assertTrue((root / 'assets' / 'old').exists())


if __name__ == '__main__':
    unittest.main()
