<?php
namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Pterodactyl\Models\Server;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Jobs\DeliverChanges;

final class ChangeFeed
{
    public function capture(Server $server, bool $deleted = false): void
    {
        // Runs synchronously inside the caller's transaction; delivery only after commit.
        DB::transaction(function () use ($server, $deleted) {
            $link = DB::table('nickhosting_servers')->where('server_id', $server->id)->lockForUpdate()->first();
            if (!$link || !$link->valid) { return; }
            $valid = !$deleted && json_decode($link->identity, true) === Protocol::identity($server);
            $limits = Protocol::limits($server);
            if ($valid && json_decode($link->limits, true) === $limits) { return; }
            DB::table('nickhosting_servers')->where('uuid', $link->uuid)->update([
                'limits' => json_encode($limits, JSON_THROW_ON_ERROR), 'valid' => $valid,
                'revision' => $link->revision + 1, 'updated_at' => now(),
            ]);
            $link->revision++; $link->limits = json_encode($limits, JSON_THROW_ON_ERROR); $link->valid = $valid;
            $this->enqueue($link, $valid ? 'limits.updated' : 'identity.invalidated');
        });
    }

    public function payload(object $link, string $type = 'snapshot'): array
    {
        return ['schemaVersion' => 1, 'eventId' => (string) Str::uuid(),
            'instanceId' => $link->instance_id, 'server' => json_decode($link->identity, true),
            'revision' => (int) $link->revision, 'type' => $link->valid ? $type : 'identity.invalidated',
            'limits' => json_decode($link->limits, true), 'occurredAt' => now()->toIso8601String()];
    }

    public function enqueue(object $link, string $type): array
    {
        $payload = $this->payload($link, $type);
        DB::table('nickhosting_outbox')->insert(['id' => $payload['eventId'], 'instance_id' => $link->instance_id,
            'server_uuid' => $link->uuid, 'payload' => json_encode($payload, JSON_THROW_ON_ERROR),
            'available_at' => now(), 'created_at' => now(), 'updated_at' => now()]);
        DB::afterCommit(static function () {
            try { DeliverChanges::dispatch()->onQueue('standard'); }
            catch (\Throwable $error) { /* Durable outbox remains available to scheduled recovery. */ }
        });
        return $payload;
    }
}
