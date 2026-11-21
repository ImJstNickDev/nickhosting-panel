"""Install the game distribution in /mnt/server, leaving instance data in place."""
import hashlib
import json
import os
import shutil
import time
import stat
import tempfile
from pathlib import Path, PurePosixPath
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import urlopen
from zipfile import ZipFile

ROOT = Path('/mnt/server')
MAX_BYTES = 512 * 1024 * 1024
OFFICIAL_MANIFEST = 'https://core.openworld.pascard.com/manifest.json'
FILES = {'openworld-server', 'README.txt', 'THIRD-PARTY-NOTICES.txt'}


def manifest(url):
    with urlopen(url, timeout=30) as source:
        data = source.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError('Release catalog too large')
    return json.loads(data)


def artifact():
    version = os.getenv('OW_VERSION') or 'latest'
    ticket = os.getenv('OW_DOWNLOAD_URL')
    if ticket:
        return ticket, int(os.environ['OW_ARCHIVE_SIZE']), os.environ['OW_SHA256']
    catalog = manifest(OFFICIAL_MANIFEST)['client']
    if version == 'latest':
        version = catalog['latest']
    releases = catalog['recent']
    for channel in ('alpha', 'snapshot'):
        if any(item['version'] == version for item in releases):
            break
        pages = catalog['channels'].get(channel, {}).get('pages', 0)
        for page in range(1, min(int(pages), 100) + 1):
            data = manifest(f'https://core.openworld.pascard.com/c/manifest/client/{channel}-{page}.json')
            releases = data['versions']
            if any(item['version'] == version for item in releases):
                break
    release = next((item for item in releases if item['version'] == version and not item.get('hidden') and not item.get('below_floor')), None)
    if not release:
        raise ValueError('No published server package for selected version')
    file = release['server']['linux-x64']
    if os.getenv('OW_SHA256') and os.environ['OW_SHA256'] != file['sha256']:
        raise ValueError('Published release differs from the selected archive')
    return file['url'], file['size'], file['sha256']


def download(path):
    url, size, digest = artifact()
    if urlsplit(url).scheme != 'https' or not 0 < size <= MAX_BYTES or len(digest) != 64:
        raise ValueError('Invalid release metadata')
    for attempt in range(5):
        try:
            fetch_package(path, url, size, digest)
            return
        except HTTPError as err:
            if err.code not in (429, 502, 503, 504) or attempt == 4:
                raise RuntimeError(f'Package request failed (HTTP {err.code})') from None
            delay = err.headers.get('Retry-After', '')
            delay = min(int(delay), 30) if delay.isdecimal() else 2 ** attempt
        except (TimeoutError, URLError, ConnectionError):
            if attempt == 4:
                raise RuntimeError('Package request timed out or became unavailable') from None
            delay = 2 ** attempt
        time.sleep(delay)


def fetch_package(path, url, size, digest):
    received = 0
    checksum = hashlib.sha256()
    with urlopen(url, timeout=90) as source, path.open('wb') as target:
        while chunk := source.read(256 * 1024):
            received += len(chunk)
            if received > size:
                raise ValueError('Package exceeds declared size')
            checksum.update(chunk)
            target.write(chunk)
    if received != size or checksum.hexdigest() != digest:
        raise ValueError('Package did not match the selected release')


def unpack(archive, stage):
    seen = set()
    total = 0
    with ZipFile(archive) as package:
        if len(package.infolist()) > 50000:
            raise ValueError('Too many package entries')
        for entry in package.infolist():
            name = entry.filename.rstrip('/')
            path = PurePosixPath(name)
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if (not path.parts or str(path) != name or path.is_absolute() or '..' in path.parts
                    or '\\' in name or name in seen or kind not in (0, stat.S_IFREG, stat.S_IFDIR)
                    or not (path.parts[0] == 'assets' or name in FILES)):
                raise ValueError('Unexpected package entry')
            seen.add(name)
            dest = stage / name
            if entry.is_dir():
                dest.mkdir(exist_ok=True, parents=True)
                continue
            total += entry.file_size
            if total > MAX_BYTES * 3:
                raise ValueError('Unpacked package too large')
            dest.parent.mkdir(exist_ok=True, parents=True)
            with package.open(entry) as inp, dest.open('xb') as out:
                shutil.copyfileobj(inp, out)
    if not FILES <= seen or not (stage / 'assets').is_dir():
        raise ValueError('Incomplete dedicated server package')
    (stage / 'openworld-server').chmod(0o755)


def publish(stage, names):
    # Validate every destination before the first rename. A misplaced file or
    # user-created directory must never be discarded as an old distribution.
    previous = stage.parent / 'previous'
    previous.mkdir()
    for name in names:
        target = ROOT / name
        if not os.path.lexists(target):
            continue
        mode = target.lstat().st_mode
        if not (stat.S_ISDIR(mode) if name == 'assets' else stat.S_ISREG(mode)):
            raise ValueError(f'Unexpected existing installation entry: {name}')
    moved = []
    published = []
    try:
        for name in names:
            target = ROOT / name
            if os.path.lexists(target):
                os.replace(target, previous / name)
                moved.append(name)
            os.replace(stage / name, target)
            published.append(name)
    except BaseException:
        for name in reversed(published):
            os.replace(ROOT / name, stage / name)
        for name in reversed(moved):
            os.replace(previous / name, ROOT / name)
        raise


def install(launcher_name, launcher_source):
    with tempfile.TemporaryDirectory(dir=ROOT, prefix='.ow-install-') as temp:
        work = Path(temp)
        stage = work / 'distribution'
        stage.mkdir()
        archive = work / 'server.zip'
        download(archive)
        unpack(archive, stage)
        (stage / launcher_name).write_text(launcher_source, encoding='utf-8')
        names = sorted(FILES | {'assets', launcher_name})
        config = ROOT / 'server.json'
        if not os.path.lexists(config):
            with (stage / 'server.json').open('x', encoding='utf-8') as document:
                json.dump({'name': os.getenv('OW_SERVER_NAME') or 'Openworld', 'web': {'enabled': False}}, document, ensure_ascii=False)
                document.write('\n')
            names.append('server.json')
        elif not stat.S_ISREG(config.lstat().st_mode):
            raise ValueError('Expected a regular server.json')
        publish(stage, names)
