<?php
use Illuminate\Database\Migrations\Migration;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Settings;

return new class extends Migration {
    public function up(): void
    {
        $path = config_path('nickhosting_bridge.php');
        // Read the original file directly: config cache may predate its configuration.
        if (!is_file($path) || is_link($path)) { return; }
        $legacy = require $path;
        $origins = is_array($legacy) ? ($legacy['callback_origins'] ?? []) : [];
        if (is_array($origins)) { app(Settings::class)->migrateLegacy($origins); }
    }
    public function down(): void
    {
        // Preserve Owner settings on rollback; old releases use the retained legacy file.
    }
};
