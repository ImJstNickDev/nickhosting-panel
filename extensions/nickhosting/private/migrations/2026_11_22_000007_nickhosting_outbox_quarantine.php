<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void {
        Schema::table('nickhosting_outbox', function (Blueprint $t) {
            $t->timestamp('quarantined_at')->nullable();
            $t->index(['instance_id', 'server_uuid', 'delivered_at', 'quarantined_at'], 'nh_outbox_scope');
        });
    }
    public function down(): void { throw new RuntimeException('Retain quarantined event evidence.'); }
};
