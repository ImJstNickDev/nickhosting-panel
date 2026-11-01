<?php
namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Pterodactyl\Events\ActivityLogged;
use Pterodactyl\Models\Backup;
use Pterodactyl\Models\Server;

final class BackupEvents
{
    private const EVENTS = [
        'server:backup.complete' => ['backup.completed', true],
        'server:backup.fail' => ['backup.completed', false],
        'server:backup.restore-complete' => ['backup.restore-completed', true],
        // This dot is the native Panel 1.11.11 failure event spelling.
        'server.backup.restore-failed' => ['backup.restore-completed', false],
    ];

    public function capture(ActivityLogged $event): void
    {
        if (!isset(self::EVENTS[$event->model->event])) { return; }
        // ActivityLogged fires before subjects are inserted. Persist the source inside
        // that same native transaction; resolving it now would lose those subjects.
        DB::table('nickhosting_backup_events')->insertOrIgnore([
            'activity_id' => $event->model->id, 'event_id' => (string) Str::uuid(),
            'event' => $event->model->event, 'occurred_at' => now()->format('Y-m-d H:i:s.u'), 'created_at' => now(), 'available_at' => now(),
        ]);
        DB::afterCommit(static function () use ($event) {
            try {
                app(self::class)->materialize($event->model->id);
            } catch (\Throwable $error) {
                // Durable source remains for the existing scheduled recovery job.
                // Do not leak provider details or turn a committed operation into an HTTP error.
            }
        });
    }

    public function recover(int $limit): void
    {
        $ids = DB::table('nickhosting_backup_events')->whereNull('processed_at')
            ->where('available_at', '<=', now())->orderBy('available_at')->orderBy('activity_id')->limit($limit)->pluck('activity_id');
        foreach ($ids as $id) {
            try { $this->materialize((int) $id); }
            catch (\Throwable $error) {
                // One unresolved source must not block unrelated existing notifications.
                DB::table('nickhosting_backup_events')->where('activity_id', $id)
                    ->update(['available_at' => now()->addMinutes(15)]);
            }
        }
    }

    public function materialize(int $activityId): void
    {
        // Only call after the provider transaction committed. The marker and outbox
        // share a new transaction, so a crash cannot consume a source without its event.
        DB::transaction(function () use ($activityId) {
            $source = DB::table('nickhosting_backup_events')->where('activity_id', $activityId)->lockForUpdate()->first();
            if (!$source || $source->processed_at !== null) { return; }
            // Uncertain/pruned native subjects remain pending for diagnostics, with
            // bounded retries so they cannot starve other source materialization.
            DB::table('nickhosting_backup_events')->where('activity_id', $activityId)
                ->update(['available_at' => now()->addMinutes(15)]);
            $subjects = DB::table('activity_log_subjects')->where('activity_log_id', $activityId)->get();
            $backupIds = $subjects->where('subject_type', (new Backup())->getMorphClass())->pluck('subject_id');
            $serverIds = $subjects->where('subject_type', (new Server())->getMorphClass())->pluck('subject_id');
            if ($backupIds->count() !== 1 || $serverIds->count() !== 1) {
                // A missing/pruned native subject is uncertain, never a success.
                return;
            }
            $backup = Backup::withTrashed()->find($backupIds->first());
            $server = Server::query()->withoutEagerLoads()->find($serverIds->first());
            if (!$backup || !$server || (int) $backup->server_id !== (int) $server->id) { return; }
            $link = DB::table('nickhosting_servers')->where('server_id', $server->id)->lockForUpdate()->first();
            if (!$link || !$link->valid || (int) $link->owner_id !== (int) $server->owner_id
                || json_decode($link->identity, true) !== Protocol::identity($server)
                || $link->created_at > $source->created_at) {
                DB::table('nickhosting_backup_events')->where('activity_id', $activityId)->update(['processed_at' => now()]);
                return;
            }
            [$type, $successful] = self::EVENTS[$source->event];
            // Completion is unique per backup; repeated failed callback activity must
            // not manufacture notifications. Restores can legitimately repeat.
            $key = $type === 'backup.completed' ? $type . ':' . $backup->uuid : $type . ':' . $activityId;
            if (DB::table('nickhosting_backup_events')->where('dedup_key', $key)->exists()) {
                DB::table('nickhosting_backup_events')->where('activity_id', $activityId)->update(['processed_at' => now()]);
                return;
            }
            $occurredAt = \Carbon\CarbonImmutable::parse($source->occurred_at)->toISOString();
            $payload = ['schemaVersion' => 1, 'eventId' => $source->event_id,
                'instanceId' => $link->instance_id, 'server' => json_decode($link->identity, true),
                'occurredAt' => $occurredAt, 'type' => $type,
                'backup' => ['uuid' => $backup->uuid, 'name' => $backup->name,
                    'isSuccessful' => $successful, 'checksum' => $backup->checksum,
                    'bytes' => max(0, (int) $backup->bytes),
                    'completedAt' => $type === 'backup.completed' && $backup->completed_at
                        ? $backup->completed_at->toIso8601String() : $occurredAt]];
            app(ChangeFeed::class)->persist($link, $payload);
            DB::table('nickhosting_backup_events')->where('activity_id', $activityId)->update([
                'dedup_key' => $key, 'processed_at' => now(),
            ]);
        });
    }
}
