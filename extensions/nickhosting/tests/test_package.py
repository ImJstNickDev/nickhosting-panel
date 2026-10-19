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

    def test_settings_controller_and_migration_packaged(self):
        self.assertIn('  controller: admin/controller.php', (self.source / 'conf.yml').read_text())
        packager.build(self.source, self.output)
        with zipfile.ZipFile(self.output) as archive:
            for name in ('admin/controller.php', 'app/Services/Settings.php', 'private/migrations/2026_10_11_000002_nickhosting_settings.php'):
                self.assertIn(name, archive.namelist())
        self.assertNotIn('config/nickhosting_bridge.php', packager.FILES)

    def test_blueprint_expansion_preserves_key_route_parameter(self):
        routes = (self.source / "routes/application.php").read_text().replace("{identifier}", "nickhosting")
        self.assertIn("/keys/{keyIdentifier}/rotate", routes)
        self.assertNotIn("/keys/nickhosting", routes)
        self.assertIn("Route::pattern('keyIdentifier'", routes)

    def test_technical_account_guards_and_version_packaged(self):
        packager.build(self.source, self.output)
        with zipfile.ZipFile(self.output) as archive:
            for name in ('app/Services/TechnicalAccounts.php', 'app/Http/Middleware/TechnicalAccountAccess.php', 'private/migrations/2026_10_12_000003_nickhosting_technical_users.php'):
                self.assertIn(name, archive.namelist())
            self.assertIn(b'version: 1.8.0\n', archive.read('conf.yml'))
            self.assertIn(b'target: beta-2026-08\n', archive.read('conf.yml'))
            self.assertIn(b"'extensionVersion' => '1.8.0'", archive.read('app/Http/Controllers/CapabilitiesController.php'))
            self.assertIn(b"'panel' => '1.15.1'", archive.read('app/Http/Controllers/CapabilitiesController.php'))
            self.assertIn(b'<small>1.8.0</small>', archive.read('admin/view.blade.php'))

    def test_client_upload_route_and_authorization_packaged(self):
        packager.build(self.source, self.output)
        with zipfile.ZipFile(self.output) as archive:
            self.assertIn(b'client: routes/client.php', archive.read('conf.yml'))
            route = archive.read('routes/client.php').decode().replace('{identifier}', 'nickhosting')
            self.assertIn('/servers/{server}/upload-urls', route)
            self.assertIn('AuthenticateServerAccess::class', route)
            self.assertIn('app/Http/Requests/UploadUrlsRequest.php', archive.namelist())
            self.assertIn('app/Http/Controllers/UploadUrlsController.php', archive.namelist())
            self.assertIn(b"'bulkUploadUrls' => true", archive.read('app/Http/Controllers/CapabilitiesController.php'))

    def test_client_download_and_settings_routes_packaged(self):
        packager.build(self.source, self.output)
        with zipfile.ZipFile(self.output) as archive:
            route = archive.read('routes/client.php').decode()
            self.assertIn('/servers/{server}/download-urls', route)
            self.assertIn('/servers/{server}/transfer-settings', route)
            self.assertEqual(route.count('->middleware(AuthenticateServerAccess::class)'), 10)
            self.assertIn("'/servers/{server}/upload-publication'", route)
            for name in ('app/Http/Requests/ClientTransferSettings.php', 'app/Http/Requests/DownloadUrlsRequest.php',
                         'app/Http/Requests/TransferSettingsRequest.php', 'app/Http/Controllers/DownloadUrlsController.php',
                         'app/Http/Controllers/TransferSettingsController.php', 'app/Services/ManagedTransferAccess.php', 'app/Services/NativeTokenScope.php'):
                self.assertIn(name, archive.namelist())
            self.assertIn(b"'bulkDownloadUrls' => true", archive.read('app/Http/Controllers/CapabilitiesController.php'))

    def test_backup_capability_and_durable_source_packaged(self):
        packager.build(self.source, self.output)
        with zipfile.ZipFile(self.output) as archive:
            self.assertIn('app/Services/BackupEvents.php', archive.namelist())
            self.assertIn('private/migrations/2026_10_17_000004_nickhosting_backup_events.php', archive.namelist())
            self.assertIn(b"'backupEvents' => true", archive.read('app/Http/Controllers/CapabilitiesController.php'))
            self.assertIn(b'ActivityLogged::class', archive.read('app/Providers/BridgeServiceProvider.php'))
            self.assertNotIn('/backups', archive.read('routes/client.php').decode())

    def test_installation_stream_and_native_status_events_packaged(self):
        packager.build(self.source, self.output)
        with zipfile.ZipFile(self.output) as archive:
            for name in ('app/Http/Requests/InstallationWebsocketRequest.php',
                         'app/Http/Controllers/InstallationWebsocketController.php',
                         'app/Services/InstallationEvents.php'):
                self.assertIn(name, archive.namelist())
            self.assertIn(b"'installationEvents' => true", archive.read('app/Http/Controllers/CapabilitiesController.php'))
            self.assertIn(b"'installationConsole' => true", archive.read('app/Http/Controllers/CapabilitiesController.php'))
            self.assertIn(b'/installation-websocket', archive.read('routes/client.php'))
            self.assertNotIn(b'Server\\Installed', archive.read('app/Providers/BridgeServiceProvider.php'))
            self.assertEqual(sum(name.startswith('private/migrations/') for name in archive.namelist()), 6)

    def test_scoped_file_operations_and_durable_receipts_packaged(self):
        packager.build(self.source, self.output)
        with zipfile.ZipFile(self.output) as archive:
            for name in ('app/Services/FileOperationPaths.php', 'app/Services/FileOperationRepository.php',
                         'app/Http/Requests/FileInspectionRequest.php', 'app/Http/Requests/GuardedDeleteRequest.php',
                         'app/Http/Requests/ArchiveCommitRequest.php', 'app/Http/Controllers/FileOperationController.php',
                         'app/Http/Controllers/ArchiveCommitController.php',
                         'app/Http/Requests/UploadPublicationRequest.php', 'app/Http/Controllers/UploadPublicationController.php',
                         'private/migrations/2026_10_18_000005_nickhosting_file_operations.php',
                         'private/migrations/2026_10_19_000006_nickhosting_file_operation_recovery.php'):
                self.assertIn(name, archive.namelist())
            routes = archive.read('routes/client.php').decode()
            for path in ('file-operation-capabilities', 'file-inspection', 'guarded-delete', 'archive-commit'):
                self.assertIn('/servers/{server}/' + path, routes)
            self.assertIn(b"'fileOperations' => true", archive.read('app/Http/Controllers/CapabilitiesController.php'))

    def test_does_not_overwrite(self):
        self.output.write_text("preserve")
        with self.assertRaises(FileExistsError):
            packager.build(self.source, self.output)
        self.assertEqual(self.output.read_text(), "preserve")

    def test_directory_routes_are_additive_and_packaged(self):
        packager.build(self.source, self.output)
        with zipfile.ZipFile(self.output) as archive:
            route = archive.read('routes/client.php').decode()
            self.assertIn('/servers/{server}/directory-list', route)
            self.assertIn('/servers/{server}/directory-settings', route)
            self.assertNotIn('/files/list', route)
            for name in ('Services/DirectoryListingRepository.php',
                         'Http/Requests/ClientDirectorySettings.php', 'Http/Requests/DirectoryListRequest.php',
                         'Http/Requests/DirectorySettingsRequest.php', 'Http/Controllers/DirectoryListController.php',
                         'Http/Controllers/DirectorySettingsController.php'):
                self.assertIn('app/' + name, archive.namelist())
            self.assertIn(b"'bulkDirectoryListings' => true", archive.read('app/Http/Controllers/CapabilitiesController.php'))
            self.assertEqual(sum(name.startswith('private/migrations/') for name in archive.namelist()), 6)

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
