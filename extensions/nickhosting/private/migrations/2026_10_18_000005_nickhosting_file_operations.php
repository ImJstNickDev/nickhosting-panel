<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
return new class extends Migration {
    public function up(): void {
        Schema::create('nickhosting_file_operations', function (Blueprint $t) {
            $t->uuid('operation_id')->primary();
            $t->uuid('server_uuid')->index(); $t->unsignedBigInteger('owner_id');
            $t->char('fingerprint', 64); $t->string('state', 16);
            $t->unsignedSmallInteger('rejection_status')->nullable();
            $t->timestamps();
        });
    }
    public function down(): void { throw new RuntimeException('Explicit backed-up data retirement is required.'); }
};
