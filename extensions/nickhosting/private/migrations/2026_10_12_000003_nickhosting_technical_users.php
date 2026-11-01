<?php
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;
return new class extends Migration {
    public function up(): void {
        Schema::table('nickhosting_users', function (Blueprint $table) {
            $table->boolean('technical')->default(false);
        });
        Schema::table('nickhosting_servers', function (Blueprint $table) {
            $table->unsignedInteger('owner_id')->nullable();
        });
        // Existing links are explicit ownership records. Snapshot the current owner once;
        // deleted links remain null and cannot yield a valid snapshot.
        \Illuminate\Support\Facades\DB::table('nickhosting_servers')->orderBy('server_id')->chunk(100, function ($links) {
            foreach ($links as $link) {
                $owner = \Illuminate\Support\Facades\DB::table('servers')->where('id', $link->server_id)->value('owner_id');
                if ($owner !== null) { \Illuminate\Support\Facades\DB::table('nickhosting_servers')->where('uuid', $link->uuid)->update(['owner_id'=>$owner]); }
            }
        });
    }
    public function down(): void { throw new RuntimeException('Technical-account access protection must not be removed implicitly.'); }
};
