<?php
namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Pterodactyl\Models\Server;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Jobs\DeliverChanges;

final class ChangeFeed
{
    // The caller holds the link lock. An invalidated identity is sticky until
    // the explicit, owner-checked relink operation.
    private function reconcile(object $link, ?object $server, bool $deleted = false): bool
    {
        if (!$link->valid) { return false; }
        $valid = $server !== null && !$deleted && (int) $link->owner_id === (int) $server->owner_id
            && json_decode($link->identity, true) === Protocol::identity($server);
        // Preserve the last known limits if identity or ownership no longer matches.
        $limits = $valid ? Protocol::limits($server) : json_decode($link->limits, true);
        if ($valid && json_decode($link->limits, true) === $limits) { return false; }
        $link->limits = json_encode($limits, JSON_THROW_ON_ERROR);
        $link->valid = $valid;
        $link->revision++;
        $link->updated_at = now();
        return true;
    }

    public function capture(Server $server, bool $deleted = false): void
    {
        DB::transaction(function () use ($server, $deleted) {
            $link = DB::table('nickhosting_servers')->where('server_id', $server->id)->lockForUpdate()->first();
            if (!$link || !$this->reconcile($link, $server, $deleted)) { return; }
            DB::table('nickhosting_servers')->where('uuid', $link->uuid)->update([
                'limits' => $link->limits, 'valid' => $link->valid,
                'revision' => $link->revision, 'updated_at' => $link->updated_at,
            ]);
            $this->enqueue($link, $link->valid ? 'limits.updated' : 'identity.invalidated');
        });
    }

    public function snapshots(string $instance, array $uuids): array
    {
        return DB::transaction(function () use ($instance, $uuids) {
            $selected = DB::table('nickhosting_servers')->where('instance_id', $instance)
                ->whereIn('uuid', $uuids)->pluck('server_id', 'uuid');
            if ($selected->isEmpty()) { return []; }
            // Native server updates acquire server, then link. Select only
            // already-owned rows; a concurrently created link waits for next time.
            $servers = DB::table('servers')->whereIntegerInRaw('id', $selected->values()->all())
                ->orderBy('id')->lockForUpdate()->get(['id', 'uuid', 'uuidShort', 'external_id',
                    'node_id', 'owner_id', 'memory', 'swap', 'disk', 'io', 'cpu', 'threads'])->keyBy('id');
            $links = DB::table('nickhosting_servers')->where('instance_id', $instance)
                ->whereIn('uuid', $selected->keys()->all())->orderBy('uuid')->lockForUpdate()->get();
            $updated = $events = $results = [];
            foreach ($links as $link) {
                abort_if((int) $selected[$link->uuid] !== (int) $link->server_id, 409);
                if ($this->reconcile($link, $servers->get($link->server_id))) {
                    $updated[] = (array) $link;
                    $events[] = $this->outboxRow($link, $this->payload($link, 'limits.updated'));
                }
                $results[] = $this->payload($link);
            }
            if ($updated) {
                // Every input row came from the scoped, locked selection above.
                // Update only the revisioned projection columns, in a single write.
                DB::table('nickhosting_servers')->upsert($updated, ['uuid'],
                    ['limits', 'valid', 'revision', 'updated_at']);
                $this->appendOutbox($events);
            }
            return $results;
        }, 3);
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
        $this->persist($link, $payload);
        return $payload;
    }

    public function persist(object $link, array $payload): void
    {
        $this->appendOutbox([$this->outboxRow($link, $payload)]);
    }

    private function outboxRow(object $link, array $payload): array
    {
        $now = now();
        return ['id' => $payload['eventId'], 'instance_id' => $link->instance_id,
            'server_uuid' => $link->uuid, 'payload' => json_encode($payload, JSON_THROW_ON_ERROR),
            'available_at' => $now, 'created_at' => $now, 'updated_at' => $now];
    }

    private function appendOutbox(array $rows): void
    {
        DB::table('nickhosting_outbox')->insert($rows);
        DB::afterCommit(static function () {
            try { DeliverChanges::dispatch()->onQueue('standard'); }
            catch (\Throwable $error) { /* Durable outbox remains available to scheduled recovery. */ }
        });
    }
}
