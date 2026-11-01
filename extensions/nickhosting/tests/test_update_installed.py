"""Pure update planning tests; never connect to a Panel or Docker."""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('updater', Path(__file__).parents[1] / 'update-installed.py')
u = importlib.util.module_from_spec(spec)
spec.loader.exec_module(u)


class UpdateTests(unittest.TestCase):
    @unittest.skipUnless(os.environ.get('NH_BLUEPRINT_TEST_CONTAINER'), 'Optional read-only PHP probe')
    def test_php_state_comparison_is_order_independent_and_type_strict(self):
        function = re.search(r'function sameState\(.*?\n', u.REMOTE).group()
        source = '''<?php
FUNCTION
$a=['sha256'=>'x','mode'=>420,'uid'=>100,'gid'=>101,'contents'=>'a'];
$b=$a;ksort($b);if(!sameState($a,$b))exit(1);
$b['uid']='100';if(sameState($a,$b))exit(2);
if(!sameState(null,null)||sameState($a,null))exit(3);
echo 'passed';
'''.replace('FUNCTION', function).encode()
        self.assertEqual(u.docker(os.environ['NH_BLUEPRINT_TEST_CONTAINER'], ['php'], source), b'passed')

    def fixture(self, before='1.5.0', after='1.6.0'):
        new = {name: (u.HERE / name).read_bytes().replace(b'1.8.0',after.encode()).replace(b'beta-2026-08',b'beta-2025-09') for name in u.packager.FILES}
        baseline = dict(new)
        baseline['conf.yml'] = baseline['conf.yml'].replace(after.encode(),before.encode())
        prefix = b'@extends(\'layouts.admin\')\n$EXTENSION_ID = "nickhosting";\n$EXTENSION_VERSION = "'+before.encode()+b'";\n@yield(\'extension.description\')'
        installed = {}
        for source, body in baseline.items():
            body = u.expand(body)
            if source == 'admin/view.blade.php':
                body = prefix + body.rstrip(b'\n') + b'\n@endsection\n'
            installed[u.destination(source)] = u.next_state(body, None, {'uid':100,'gid':101})
        return baseline, new, installed

    def test_exact_baseline_changes_only_version_and_generated_view(self):
        old, new, installed = self.fixture()
        plan = u.make_plan(old, '1.5.0', new, '1.6.0', installed)
        self.assertEqual(set(plan['changes']), {u.STORE, u.ADMIN_VIEW})
        self.assertEqual(plan['after'][u.ADMIN_VIEW]['uid'], 100)

    def test_modified_existing_code_rejected(self):
        old, new, installed = self.fixture()
        installed[u.CAPABILITIES]['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'differs from baseline'):
            u.make_plan(old, '1.5.0', new, '1.6.0', installed)

    def test_unknown_generated_wrapper_rejected(self):
        old, new, installed = self.fixture()
        installed[u.ADMIN_VIEW]['contents'] = base64.b64encode(b'modified').decode()
        with self.assertRaisesRegex(ValueError, 'generated admin view'):
            u.make_plan(old, '1.5.0', new, '1.6.0', installed)

    def test_new_path_collision_rejected(self):
        old, new, installed = self.fixture()
        old.pop('app/Services/FileOperationPaths.php')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            u.make_plan(old, '1.5.0', new, '1.6.0', installed)

    def test_unknown_version_rejected(self):
        old, new, installed = self.fixture()
        with self.assertRaisesRegex(ValueError, 'Only reviewed'):
            u.make_plan(old, '1.4.0', new, '1.6.0', installed)

    def test_patch_preserves_metadata_and_limits_changed_files(self):
        old, new, installed = self.fixture('1.6.0','1.6.1')
        path='app/Services/FileOperationRepository.php'
        old[path]=b'<?php /* previous reviewed transport */'
        installed[u.destination(path)]=u.next_state(old[path],None,{'uid':100,'gid':101})
        plan=u.make_plan(old,'1.6.0',new,'1.6.1',installed)
        self.assertEqual(set(plan['changes']),{u.STORE,u.ADMIN_VIEW,u.destination(path)})
        self.assertEqual(plan['after'][u.destination(path)]['mode'],0o644)
        new['app/Services/TechnicalAccounts.php']+=b'\n// unrelated'
        with self.assertRaisesRegex(ValueError,'outside reviewed'):
            u.make_plan(old,'1.6.0',new,'1.6.1',installed)

    def test_patch_rejects_inventory_or_migration_changes(self):
        old,new,installed=self.fixture('1.6.0','1.6.1')
        migration='private/migrations/2026_10_18_000005_nickhosting_file_operations.php'
        new[migration]+=b'\n// changed'
        with self.assertRaisesRegex(ValueError,'outside reviewed'):
            u.make_plan(old,'1.6.0',new,'1.6.1',installed)
        new[migration]=old[migration]
        old.pop('app/Services/FileOperationPaths.php')
        with self.assertRaisesRegex(ValueError,'outside reviewed'):
            u.make_plan(old,'1.6.0',new,'1.6.1',installed)

    def test_new_paths_copy_only_owner_and_group(self):
        old, new, installed = self.fixture()
        source = 'app/Services/FileOperationPaths.php'
        old.pop(source); installed[u.destination(source)] = None
        plan = u.make_plan(old, '1.5.0', new, '1.6.0', installed)
        self.assertEqual(plan['after'][u.destination(source)]['mode'], 0o644)

    def test_rollback_write_order_survives_sorted_payload(self):
        captured = []
        def fake_docker(container, args, source):
            encoded = source.decode().split("base64_decode('")[1].split("'")[0]
            captured.append(json.loads(base64.b64decode(encoded)))
            return b'{}'
        writes = {u.CLIENT_ROUTES: {'test': 1}, u.PREFIX+'app/Services/FileOperationPaths.php': None}
        with patch.object(u, 'docker', fake_docker):
            u.remote('fixture', writes, 'write', writes, writes)
        self.assertEqual([item['path'] for item in captured[0]['writes']], list(writes))

    def test_archive_uses_verified_bytes_not_reopened_path(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as z:
            info = zipfile.ZipInfo('conf.yml'); info.external_attr = (stat.S_IFREG | 0o644) << 16
            z.writestr(info, b'info:\n  identifier: nickhosting\n  version: 1.6.0\n  target: beta-2025-09\n')
        content = archive.getvalue()
        with patch.object(Path, 'read_bytes', return_value=content):
            result, version = u.read_archive('/does-not-exist', u.sha(content))
        self.assertEqual(version, '1.6.0')

    def test_private_backup_is_non_overwriting_and_restricted(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'backup.json'
            u.private_save(path, {'fixture':True})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError): u.private_save(path, {})

    def test_no_native_install_cache_clear_or_broad_ownership_command(self):
        source = Path(u.__file__).read_text()
        self.assertNotIn("['blueprint'", source)
        self.assertNotIn("'config:clear'", source)
        self.assertNotIn("'view:clear'", source)
        self.assertNotIn("'chown','-R'", source)
        self.assertIn("'--path='+MIGRATION", source)
        self.assertIn("if report['migration']:", source)


if __name__ == '__main__': unittest.main()
