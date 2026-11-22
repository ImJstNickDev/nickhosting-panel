<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\GatewayTopology;

return new class extends Migration {
    public function up(): void
    {
        Schema::create(GatewayTopology::TABLE, function (Blueprint $table) {
            $table->unsignedTinyInteger('id')->primary();
            $table->uuid('epoch');
            $table->unsignedBigInteger('revision');
            $table->boolean('enabled');
            $table->text('sources');
            $table->text('definitions');
        });
        try {
            GatewayTopology::install();
        } catch (\Throwable $error) {
            // An installation without TRIGGER privileges keeps its existing full inventory path.
            // Stop incrementing any partial set. A failed cleanup is reported to the installer.
            GatewayTopology::uninstall();
            report($error);
        }
    }

    public function down(): void
    {
        GatewayTopology::uninstall();
        Schema::dropIfExists(GatewayTopology::TABLE);
    }
};
