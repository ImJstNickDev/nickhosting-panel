"""Build an allowlisted Blueprint ZIP locally; never run the Panel installer."""

import argparse
from pathlib import Path
import stat
import zipfile

FILES = (
    'conf.yml',
    'app/Services/TechnicalAccounts.php',
    'app/Http/Middleware/TechnicalAccountAccess.php',
    'private/migrations/2026_10_12_000003_nickhosting_technical_users.php',
    'admin/view.blade.php',
    'admin/controller.php',
    'app/Http/Controllers/BridgeController.php',
    'app/Http/Controllers/CapabilitiesController.php',
    'app/Http/Requests/CapabilitiesRequest.php',
    'app/Http/Requests/UploadUrlsRequest.php',
    'app/Http/Requests/ClientTransferSettings.php',
    'app/Http/Requests/DownloadUrlsRequest.php',
    'app/Http/Requests/TransferSettingsRequest.php',
    'app/Http/Controllers/DownloadUrlsController.php',
    'app/Http/Controllers/TransferSettingsController.php',
    'app/Services/ManagedTransferAccess.php',
    'app/Http/Requests/InstallationWebsocketRequest.php',
    'app/Http/Controllers/InstallationWebsocketController.php',
    'app/Services/InstallationEvents.php',
    'app/Services/FileOperationPaths.php',
    'app/Services/FileOperationRepository.php',
    'app/Http/Requests/FileInspectionRequest.php',
    'app/Http/Requests/GuardedDeleteRequest.php',
    'app/Http/Requests/ArchiveCommitRequest.php',
    'app/Http/Controllers/FileOperationController.php',
    'app/Http/Controllers/ArchiveCommitController.php',
    'private/migrations/2026_10_18_000005_nickhosting_file_operations.php',
    'app/Services/DirectoryListingRepository.php',
    'app/Http/Requests/ClientDirectorySettings.php',
    'app/Http/Requests/DirectoryListRequest.php',
    'app/Http/Requests/DirectorySettingsRequest.php',
    'app/Http/Controllers/DirectoryListController.php',
    'app/Http/Controllers/DirectorySettingsController.php',
    'app/Http/Controllers/UploadUrlsController.php',
    'app/Jobs/DeliverChanges.php',
    'app/Providers/BridgeServiceProvider.php',
    'app/Services/ChangeFeed.php',
    'app/Services/BackupEvents.php',
    'private/migrations/2026_10_17_000004_nickhosting_backup_events.php',
    'app/Services/Protocol.php',
    'app/Services/Settings.php',
    'private/configure.php',
    'private/install.sh',
    'private/migrations/2026_10_11_000001_nickhosting_bridge.php',
    'private/remove.sh',
    'private/migrations/2026_10_11_000002_nickhosting_settings.php',
    'routes/application.php',
    'routes/client.php',
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
        default=ROOT.parent.parent / "build/blueprint/1.7.0/nickhosting.blueprint",
    )
    print(build(ROOT, parser.parse_args().output))
