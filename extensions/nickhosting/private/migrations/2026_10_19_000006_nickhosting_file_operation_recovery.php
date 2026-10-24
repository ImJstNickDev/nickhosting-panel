<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration {
    public function up(): void
    {
        Schema::table('nickhosting_file_operations', function (Blueprint $table) {
            // Nullable for existing receipts and older extension code. Retain on
            // code rollback: this describes preserved files after a lost reply.
            $table->json('recovery_context')->nullable();
        });
    }
};
