<?php
function nickhostingProviderConfig(string $source, bool $remove): string
{
$marker = "        // nickhosting-provider-begin\n        Pterodactyl\\BlueprintFramework\\Extensions\\nickhosting\\Providers\\BridgeServiceProvider::class,\n        // nickhosting-provider-end\n";
if ($remove) {
    $new = str_replace($marker, '', $source, $count);
    if (str_contains($new, 'nickhosting-provider-')) { throw new RuntimeException('Unexpected provider marker.'); }
} elseif (str_contains($source, $marker)) {
    return $source;
} else {
    if (str_contains($source, 'nickhosting-provider-') || str_contains($source, 'Extensions\\nickhosting\\Providers')) {
        throw new RuntimeException('Unrecognized existing provider registration.');
    }
    $anchor = '        Pterodactyl\\Providers\\AppServiceProvider::class,';
    if (substr_count($source, $anchor) !== 1) { throw new RuntimeException('Unsupported application provider layout.'); }
    $new = str_replace($anchor, $marker . $anchor, $source);
}
    return $new;
}
function nickhostingWriteConfig(string $path, string $source, string $new): void
{
    if (is_link($path) || !is_file($path)) { throw new RuntimeException('Invalid configuration file.'); }
    $stat = stat($path);
    token_get_all($new, TOKEN_PARSE);
    $temporary = dirname($path) . '/.nickhosting-' . bin2hex(random_bytes(16)) . '.tmp';
    $handle = fopen($temporary, 'x');
    if (!$handle) { throw new RuntimeException('Cannot create configuration staging file.'); }
    try {
        if (fwrite($handle, $new) !== strlen($new) || !fflush($handle)) {
            throw new RuntimeException('Cannot stage provider registration.');
        }
        if (function_exists('fsync') && !fsync($handle)) { throw new RuntimeException('Cannot sync configuration.'); }
        if (!chmod($temporary, $stat['mode'] & 0777)) { throw new RuntimeException('Cannot preserve configuration mode.'); }
        if (fileowner($temporary) !== $stat['uid'] && !chown($temporary, $stat['uid'])) { throw new RuntimeException('Cannot preserve configuration owner.'); }
        if (filegroup($temporary) !== $stat['gid'] && !chgrp($temporary, $stat['gid'])) { throw new RuntimeException('Cannot preserve configuration group.'); }
        clearstatcache(true, $path);
        $current = stat($path);
        if (is_link($path) || $current['ino'] !== $stat['ino'] || $current['dev'] !== $stat['dev']
            || file_get_contents($path) !== $source) {
            throw new RuntimeException('Configuration changed concurrently.');
        }
        if (!rename($temporary, $path)) { throw new RuntimeException('Cannot commit provider registration.'); }
    } finally {
        fclose($handle);
        if (file_exists($temporary)) { unlink($temporary); }
    }
}
if (defined('NICKHOSTING_TEST_CONFIGURE')) { return; }
// This hook changes only our marked service-provider registration. No Panel bootstrap.
$root = getenv('PTERODACTYL_DIRECTORY');
if (!$root || !is_file($root . '/artisan') || is_link($root . '/config/app.php')) {
    throw new RuntimeException('Invalid Panel root or configuration symlink.');
}
$path = $root . '/config/app.php';
$source = file_get_contents($path);
$new = nickhostingProviderConfig($source, ($argv[1] ?? '') === 'remove');
if ($new === $source) { exit(0); }
$backup = $root . '/storage/app/nickhosting-config-app-' . hash('sha256', $source) . '.php';
if (!file_exists($backup)) {
    $handle = fopen($backup, 'x');
    if (!$handle) { throw new RuntimeException('Cannot create configuration backup.'); }
    fwrite($handle, $source); fclose($handle); chmod($backup, 0600);
}
nickhostingWriteConfig($path, $source, $new);
