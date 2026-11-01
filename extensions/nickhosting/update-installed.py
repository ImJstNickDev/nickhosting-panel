"""Plan/apply a hash-pinned, extension-only update of an existing Blueprint installation.

Never runs Blueprint/install.sh/configure.php, edits Panel configuration, walks
/app/var, clears global caches or restarts services. Default is read-only.
"""
import argparse
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('nickhosting_packager', HERE / 'package.py')
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)
PREFIX = '.blueprint/extensions/nickhosting/'
ADMIN_VIEW = 'resources/views/admin/extensions/nickhosting/index.blade.php'
ADMIN_CONTROLLER = 'app/Http/Controllers/Admin/Extensions/nickhosting/nickhostingExtensionController.php'
STORE = PREFIX + 'private/.store/conf.yml'
CAPABILITIES = PREFIX + 'app/Http/Controllers/CapabilitiesController.php'
CLIENT_ROUTES = PREFIX + 'routers/client.php'
MIGRATION = PREFIX + 'private/migrations/2026_10_18_000005_nickhosting_file_operations.php'
LINKS = {
    'app/BlueprintFramework/Extensions/nickhosting': '../../../.blueprint/extensions/nickhosting/app',
    'routes/blueprint/client/nickhosting.php': '../../../.blueprint/extensions/nickhosting/routers/client.php',
    'routes/blueprint/application/nickhosting.php': '../../../.blueprint/extensions/nickhosting/routers/application.php',
}
ACTIVATE_LAST = {CAPABILITIES, CLIENT_ROUTES, ADMIN_VIEW, ADMIN_CONTROLLER, STORE}
PATCH_FILES = {'conf.yml', 'admin/view.blade.php',
               'app/Http/Controllers/CapabilitiesController.php',
               'app/Services/FileOperationRepository.php',
               'app/Http/Controllers/ArchiveCommitController.php',
               'app/Http/Requests/ArchiveCommitRequest.php'}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def compact(data):
    return json.dumps(data, sort_keys=True, separators=(',', ':')).encode()


def destination(source):
    if source == 'conf.yml':
        return STORE
    if source == 'admin/view.blade.php':
        return ADMIN_VIEW
    if source == 'admin/controller.php':
        return ADMIN_CONTROLLER
    if source.startswith('routes/'):
        return PREFIX + 'routers/' + source.split('/')[-1]
    if source.startswith(('app/', 'private/')):
        return PREFIX + source
    raise ValueError('Unsupported package path: ' + source)


def read_archive(path, expected_hash):
    data = Path(path).read_bytes()
    if sha(data) != expected_hash:
        raise ValueError('Archive SHA-256 mismatch')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or not set(names).issubset(packager.FILES):
            raise ValueError('Archive contains unknown or duplicate paths')
        result = {}
        for entry in archive.infolist():
            if entry.file_size > 1048576 or (entry.external_attr >> 16) & 0o170000 != 0o100000:
                raise ValueError('Archive entry is not bounded regular code')
            result[entry.filename] = archive.read(entry)
    if len(data) > 5 * 1048576 or sum(map(len, result.values())) > 5 * 1048576:
        raise ValueError('Archive too large')
    config = result['conf.yml'].decode()
    if '  identifier: nickhosting\n' not in config or '  target: beta-2025-09\n' not in config:
        raise ValueError('Unsupported extension/framework')
    version = re.search(r'^  version: (\S+)$', config, re.M)
    if not version:
        raise ValueError('Missing version')
    return result, version[1]


def expand(data):
    return data.replace(b'{identifier}', b'nickhosting')


def view_prefix(installed, previous_body, version):
    suffix = expand(previous_body).rstrip(b'\n') + b'\n@endsection\n'
    if not installed.endswith(suffix):
        raise ValueError('Installed generated admin view does not match baseline body')
    prefix = installed[:-len(suffix)]
    if not prefix.startswith(b"@extends('layouts.admin')") or prefix.count(b'$EXTENSION_VERSION = "' + version.encode() + b'";') != 1:
        raise ValueError('Unknown generated admin wrapper')
    if b'$EXTENSION_ID = "nickhosting";' not in prefix or not prefix.endswith(b"@yield('extension.description')"):
        raise ValueError('Unknown generated admin wrapper boundary')
    return prefix


# Runs as a standalone PHP process; never bootstraps Panel or loads its environment.
# The only write targets are the exact code paths supplied from the package allowlist.
REMOTE = r'''<?php
$p=json_decode(base64_decode('__PAYLOAD__'),true,32,JSON_THROW_ON_ERROR);
$root='/app';
function fail($message){throw new RuntimeException($message);}
function safe($relative){global $root; if(!is_string($relative)||str_starts_with($relative,'/')||str_contains($relative,'..')||str_contains($relative,'\\'))fail('Unsafe path');
 $parts=explode('/',$relative);$path=$root;foreach($parts as $index=>$part){$path.='/'.$part;if(is_link($path))fail('Unexpected symlink: '.$relative);if($index<count($parts)-1&&!is_dir($path))fail('Missing parent: '.$relative);}return $path;}
function state($relative){$path=safe($relative);clearstatcache(true,$path);if(!file_exists($path))return null;$st=lstat($path);if(!is_file($path)||$st['nlink']!==1||$st['size']>1048576)fail('Unexpected file: '.$relative);$data=file_get_contents($path);return ['sha256'=>hash('sha256',$data),'mode'=>$st['mode']&0777,'uid'=>$st['uid'],'gid'=>$st['gid'],'contents'=>base64_encode($data)];}
function sameState($left,$right){if($left===null||$right===null)return $left===$right;if(count($left)!==5||count($right)!==5)return false;foreach(['sha256','mode','uid','gid','contents'] as $key){if(!array_key_exists($key,$left)||!array_key_exists($key,$right)||$left[$key]!==$right[$key])return false;}return true;}
foreach($p['links'] as $path=>$target){if(!is_link($root.'/'.$path)||readlink($root.'/'.$path)!==$target)fail('Unexpected installed link');}
$app='.blueprint/extensions/nickhosting/app';$count=0;
$entries=new RecursiveIteratorIterator(new RecursiveDirectoryIterator(safe($app),FilesystemIterator::SKIP_DOTS));
foreach($entries as $entry){if(++$count>200)fail('Unexpected extension code tree size');$relative=substr($entry->getPathname(),strlen($root)+1);if($entry->isLink()||!$entry->isFile()||!in_array($relative,$p['paths'],true))fail('Unknown extension code: '.$relative);}
if(extension_loaded('Zend OPcache'))fail('OPcache requires a separately reviewed invalidation procedure');
foreach(glob($root.'/bootstrap/cache/routes*.php') as $cache){fail('Shared route cache is active; no global invalidation authorized');}
$config=safe('config/app.php');if(!str_contains(file_get_contents($config),'Extensions\\nickhosting\\Providers\\BridgeServiceProvider::class'))fail('Existing provider registration absent');
$installed=file_get_contents(safe('.blueprint/extensions/blueprint/private/db/installed_extensions'));
if(!str_contains($installed,'|nickhosting,'))fail('Extension is not already installed');
$out=[];foreach($p['paths'] as $path){$out[$path]=state($path);}
if($p['action']==='inspect'){echo json_encode($out,JSON_THROW_ON_ERROR);exit;}
foreach($p['expected'] as $path=>$expected){if(!array_key_exists($path,$out)||!sameState($out[$path],$expected))fail('Installed file changed: '.$path);}
foreach($p['writes'] as $write){$path=$write['path'];$desired=$write['desired'];
 if(!in_array($path,$p['paths'],true)||!array_key_exists($path,$p['expected']))fail('Unknown target');
 $target=safe($path);$current=state($path);if(!sameState($current,$p['expected'][$path]))fail('Concurrent code change');
 if($desired===null){if($current!==null&&!unlink($target))fail('Cannot remove scoped new code');continue;}
 $bytes=base64_decode($desired['contents'],true);if($bytes===false||hash('sha256',$bytes)!==$desired['sha256'])fail('Invalid write digest');
 $temporary=dirname($target).'/.nickhosting-update-'.bin2hex(random_bytes(12));$handle=fopen($temporary,'x');if(!$handle)fail('Cannot stage code');
 try {if(fwrite($handle,$bytes)!==strlen($bytes)||!fflush($handle))fail('Cannot write code');if(function_exists('fsync')&&!fsync($handle))fail('Cannot sync code');
 if(!chmod($temporary,$desired['mode']))fail('Cannot set file mode');if(fileowner($temporary)!==$desired['uid']&&!chown($temporary,$desired['uid']))fail('Cannot preserve owner');if(filegroup($temporary)!==$desired['gid']&&!chgrp($temporary,$desired['gid']))fail('Cannot preserve group');
 if(!sameState(state($path),$current))fail('Concurrent replacement');if(!rename($temporary,$target))fail('Cannot publish code');
 } finally {fclose($handle);if(file_exists($temporary))unlink($temporary);}
}
echo json_encode(['written'=>array_column($p['writes'],'path')],JSON_THROW_ON_ERROR);
'''


def docker(container, args, stdin=None):
    completed = subprocess.run(['docker', 'exec', '-i', '--workdir', '/app', container, *args], input=stdin, capture_output=True, check=True)
    return completed.stdout


def check_container(container, expected_working_dir):
    template = '[{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},{{json .State.Running}}]'
    topology = json.loads(subprocess.check_output(['docker', 'inspect', '--format', template, container]))
    if topology[0] != expected_working_dir:
        raise ValueError('Container does not belong to the explicitly selected installation')
    if not topology[1]:
        raise ValueError('Selected Panel container is not running')
    if b'Zend OPcache' in docker(container, ['php-fpm', '-m']):
        raise ValueError('FPM OPcache requires a separately reviewed invalidation procedure')


def remote(container, paths, action='inspect', expected=None, writes=None):
    payload = {'paths': sorted(paths), 'links': LINKS, 'action': action, 'expected': expected or {}, 'writes': [{'path': path, 'desired': value} for path, value in (writes or {}).items()]}
    source = REMOTE.replace('__PAYLOAD__', base64.b64encode(compact(payload)).decode()).encode()
    return json.loads(docker(container, ['php'], source))


def next_state(contents, existing, owner):
    metadata = existing or owner
    return {'contents': base64.b64encode(contents).decode(), 'sha256': sha(contents),
            'uid': metadata['uid'], 'gid': metadata['gid'], 'mode': existing['mode'] if existing else 0o644}


def make_plan(baseline, baseline_version, new, new_version, installed):
    if (baseline_version, new_version) not in {('1.5.0', '1.6.0'), ('1.6.0', '1.6.1')}:
        raise ValueError('Only reviewed 1.5.0 -> 1.6.0 and 1.6.0 -> 1.6.1 layouts are supported')
    if set(new) != set(packager.FILES) or not set(baseline).issubset(new):
        raise ValueError('Unexpected package inventory')
    if new_version == '1.6.1' and (set(baseline) != set(new) or
            any(baseline[path] != new[path] for path in new if path not in PATCH_FILES)):
        raise ValueError('Patch changes files outside reviewed import transport scope')
    previous_view = base64.b64decode(installed[ADMIN_VIEW]['contents'])
    prefix = view_prefix(previous_view, baseline['admin/view.blade.php'], baseline_version)
    for source, old in baseline.items():
        target = destination(source)
        expected = previous_view if target == ADMIN_VIEW else expand(old)
        if installed.get(target) is None or installed[target]['sha256'] != sha(expected):
            raise ValueError('Installed extension differs from baseline: ' + target)
    for source in set(new) - set(baseline):
        if installed[destination(source)] is not None:
            raise ValueError('New code path already exists')
    updated = {}
    for source, content in new.items():
        path = destination(source)
        body = expand(content)
        if path == ADMIN_VIEW:
            prefix_new = prefix.replace(b'$EXTENSION_VERSION = "' + baseline_version.encode() + b'";',
                                        b'$EXTENSION_VERSION = "' + new_version.encode() + b'";')
            body = prefix_new + body.rstrip(b'\n') + b'\n@endsection\n'
        updated[path] = next_state(body, installed[path], installed[CAPABILITIES])
    changes = {path: value for path, value in updated.items() if value != installed[path]}
    return {'installedSha256': sha(compact(installed)), 'before': installed, 'after': updated, 'changes': changes}


def private_save(path, data):
    with open(path, 'xb') as handle:
        os.chmod(path, 0o600)
        handle.write(compact(data)); handle.flush(); os.fsync(handle.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', required=True)
    parser.add_argument('--expected-working-dir', required=True)
    parser.add_argument('--baseline'); parser.add_argument('--baseline-sha256')
    parser.add_argument('--archive'); parser.add_argument('--archive-sha256')
    parser.add_argument('--expected-installed-version', default='1.5.0')
    parser.add_argument('--expected-installed-sha256')
    parser.add_argument('--backup-dir', type=Path)
    parser.add_argument('--expected-backup-sha256')
    parser.add_argument('--rollback', type=Path, help='Previously created private backup manifest')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    check_container(args.container, args.expected_working_dir)
    allowed = {destination(path) for path in packager.FILES}
    if args.rollback:
        packager.no_symlinks(args.rollback)
        backup_bytes = args.rollback.read_bytes()
        if args.apply and (not args.expected_backup_sha256 or sha(backup_bytes) != args.expected_backup_sha256):
            raise ValueError('Rollback apply requires the exact reviewed backup SHA-256')
        backup = json.loads(backup_bytes)
        if backup['container'] != args.container or backup['workingDir'] != args.expected_working_dir or set(backup['before']) != allowed or set(backup['after']) != allowed:
            raise ValueError('Rollback does not match the selected installation or code allowlist')
        current = remote(args.container, allowed)
        for path, value in current.items():
            if value not in (backup['before'][path], backup['after'][path]):
                raise ValueError('Refusing to overwrite unrelated change during rollback: ' + path)
        changes = {path: value for path, value in backup['before'].items() if current[path] != value}
        print(json.dumps({'mode':'rollback' if args.apply else 'rollback-dry-run', 'files':list(changes), 'schema':'retained'}, indent=2))
        if args.apply:
            # Disable routes/capabilities first; restore code last. No rollback/down migration.
            ordered = {path: changes[path] for path in sorted(changes, key=lambda p: (p not in ACTIVATE_LAST,p))}
            remote(args.container, allowed, 'write', current, ordered)
        return
    if not all([args.baseline,args.baseline_sha256,args.archive,args.archive_sha256]):
        parser.error('Supply both hash-pinned baseline and new archives')
    baseline, before_version = read_archive(args.baseline,args.baseline_sha256)
    new, after_version = read_archive(args.archive,args.archive_sha256)
    if args.expected_installed_version != before_version:
        raise ValueError('Expected installed version differs from reviewed baseline')
    installed = remote(args.container, allowed)
    plan = make_plan(baseline,before_version,new,after_version,installed)
    if args.expected_installed_sha256 and args.expected_installed_sha256 != plan['installedSha256']:
        raise ValueError('Installed content/metadata fingerprint changed since review')
    report = {'mode':'apply' if args.apply else 'dry-run','from':before_version,'to':after_version,
              'installedSha256':plan['installedSha256'],'files':list(plan['changes']),
              'migration':['php','artisan','migrate','--force','--path='+MIGRATION] if before_version == '1.5.0' else None,
              'globalCacheClear':False,'restarts':False,'nativeInstaller':False}
    print(json.dumps(report, indent=2),flush=True)
    if not args.apply:
        return
    if not args.expected_installed_sha256 or not args.backup_dir:
        parser.error('--apply requires reviewed installed fingerprint and a new private --backup-dir')
    packager.no_symlinks(args.backup_dir)
    args.backup_dir.mkdir(mode=0o700,parents=False,exist_ok=False)
    backup = {'container':args.container,'workingDir':args.expected_working_dir,**plan}
    private_save(args.backup_dir/'manifest.json',backup)
    print('Rollback manifest SHA-256: ' + sha(compact(backup)), flush=True)
    staged = {p:v for p,v in plan['changes'].items() if p not in ACTIVATE_LAST}
    remote(args.container, allowed, 'write', installed, staged)
    # Exactly this additive extension migration, never Panel migrations or install hooks.
    if report['migration']:
        try:
            result = docker(args.container,report['migration'])
        except subprocess.CalledProcessError as error:
            private_save(args.backup_dir/'migration-failed.json', {
                'exitCode': error.returncode,
                'output': (error.stdout or b'').decode(errors='replace'),
                'error': (error.stderr or b'').decode(errors='replace'),
            })
            raise
        private_save(args.backup_dir/'migration.json',{'output':result.decode()})
    expected = {**installed,**staged}
    activated = {p:v for p,v in plan['changes'].items() if p in ACTIVATE_LAST}
    remote(args.container, allowed, 'write', expected, activated)
    final = remote(args.container, allowed)
    if final != plan['after']:
        raise RuntimeError('Post-update verification failed; retain backup and use scoped rollback')
    private_save(args.backup_dir/'complete.json',{'installedSha256':sha(compact(final))})
    print('Extension-only update verified. Additive receipt table retained on any later rollback.')


if __name__ == '__main__':
    main()
