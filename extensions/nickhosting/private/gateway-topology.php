<?php

use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\Schema;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\GatewayTopology;

// The package hooks run from the identified Panel directory. Reinstalling after a
// removal creates a new epoch even though Blueprint retains extension migrations.
$operation = $argv[1] ?? null;
if (!in_array($operation, ['install', 'remove'], true)) { exit(2); }
$root = getenv('PTERODACTYL_DIRECTORY');
if (!$root || !is_file($root . '/artisan')) { exit(2); }
require $root . '/vendor/autoload.php';
$app = require $root . '/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
if (!Schema::hasTable(GatewayTopology::TABLE)) { return; }
if ($operation === 'remove') {
    GatewayTopology::uninstall();
} else {
    try { GatewayTopology::install(); }
    catch (\Throwable $error) { GatewayTopology::uninstall(); report($error); }
}
