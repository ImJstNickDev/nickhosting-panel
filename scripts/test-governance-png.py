#!/usr/bin/env python3
"""Narrow publication allowlist: synthetic PNG envelopes, no file mutations."""
import importlib.util
from pathlib import Path
import struct
import unittest
import zlib
spec = importlib.util.spec_from_file_location('governance', Path(__file__).with_name('check-governance.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
def chunk(kind,data):
    return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data))
def png(extra=b''):
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',1,1,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\0\0\0\0'))+extra+chunk(b'IEND',b'')
class ReviewPng(unittest.TestCase):
    def test_scoped_image(self):
        self.assertTrue(module.safe_review_png('docs/screenshots/m5/login-en.png',png()))
    def test_rejects_other_paths_metadata_and_trailing_bytes(self):
        for path in ['.codex/local/private.png','docs/screenshots/m5/../secret.png','docs/screenshots/m6/login.png']:
            self.assertFalse(module.safe_review_png(path,png()))
        for image in [png()+b'secret',png(chunk(b'tEXt',b'private')),png()[:-4],png().replace(b'IHDR',b'IDAT',1)]:
            self.assertFalse(module.safe_review_png('docs/screenshots/m5/login.png',image))
if __name__=='__main__': unittest.main()
