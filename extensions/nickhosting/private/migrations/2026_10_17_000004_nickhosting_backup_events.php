<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
return new class extends Migration {
    public function up(): void {
        Schema::create('nickhosting_backup_events', function (Blueprint $t) {
            $t->unsignedBigInteger('activity_id')->primary();
            $t->uuid('event_id')->unique(); $t->string('event', 64);
            $t->string('dedup_key', 128)->nullable()->unique();
            $t->timestamp('available_at')->index(); $t->timestamp('occurred_at', 6); $t->timestamp('created_at');
            $t->timestamp('processed_at')->nullable()->index();
        });
    }
    public function down(): void { throw new RuntimeException('Explicit backed-up data retirement is required.'); }
};
