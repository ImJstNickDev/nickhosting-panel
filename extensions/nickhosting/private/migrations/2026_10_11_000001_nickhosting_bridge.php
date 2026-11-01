<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
return new class extends Migration {
    public function up(): void {
        Schema::create('nickhosting_instances', function (Blueprint $t) {
            $t->uuid('id')->primary(); $t->unsignedInteger('api_key_id');
            $t->string('callback_url', 2048); $t->text('secret'); $t->timestamps();
        });
        Schema::create('nickhosting_servers', function (Blueprint $t) {
            $t->uuid('uuid')->primary(); $t->uuid('instance_id')->index();
            $t->unsignedInteger('server_id')->unique(); $t->text('identity');
            $t->text('limits'); $t->unsignedBigInteger('revision')->default(1);
            $t->boolean('valid')->default(true); $t->timestamps();
        });
        Schema::create('nickhosting_outbox', function (Blueprint $t) {
            $t->uuid('id')->primary(); $t->uuid('instance_id')->index();
            $t->uuid('server_uuid')->index(); $t->text('payload');
            $t->unsignedInteger('attempts')->default(0); $t->timestamp('available_at')->index();
            $t->timestamp('delivered_at')->nullable(); $t->timestamps();
        });
        Schema::create('nickhosting_users', function (Blueprint $t) {
            $t->uuid('nick_user_id'); $t->uuid('instance_id');
            $t->unsignedInteger('provider_id')->unique(); $t->uuid('provider_uuid')->unique();
            $t->string('external_id'); $t->timestamps();
            $t->primary(['instance_id', 'nick_user_id']);
        });
        Schema::create('nickhosting_keys', function (Blueprint $t) {
            $t->uuid('operation_id')->primary(); $t->uuid('instance_id')->index();
            $t->uuid('nick_user_id'); $t->string('identifier',16)->unique();
            $t->text('encrypted_response')->nullable(); $t->string('request_hash',64);
            $t->timestamp('revoked_at')->nullable(); $t->timestamps();
        });
        Schema::create('nickhosting_audit', function (Blueprint $t) {
            $t->bigIncrements('id'); $t->uuid('instance_id'); $t->string('action',64);
            $t->string('subject',64); $t->timestamp('created_at');
        });
    }
    // Deliberately retain identities/outbox/key ownership on uninstall and rollback.
    public function down(): void { throw new RuntimeException('Explicit backed-up data retirement is required.'); }
};
