<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Pterodactyl\Models\Server;

final class InstallationEvents
{
    public function capture(Server $server): void
    {
        // Native Updated fires for the remote install callback, regardless of mail settings.
        // installed_at also changes when another attempt fails with the same status.
        if (!$server->wasChanged(['status', 'installed_at'])) { return; }
        $status = $server->status;
        $state = match ($status) {
            Server::STATUS_INSTALLING => 'installing',
            Server::STATUS_INSTALL_FAILED, Server::STATUS_REINSTALL_FAILED => 'failed',
            null => 'installed',
            default => null,
        };
        if ($state === null || ($status === null && !$server->wasChanged('installed_at')
            && !in_array($server->getOriginal('status'), [Server::STATUS_INSTALLING,
                Server::STATUS_INSTALL_FAILED, Server::STATUS_REINSTALL_FAILED], true))) { return; }
        DB::transaction(function () use ($server, $state, $status) {
            $link = DB::table('nickhosting_servers')->where('server_id', $server->id)->lockForUpdate()->first();
            if (!$link || !$link->valid || $link->owner_id !== $server->owner_id
                || json_decode($link->identity, true) !== Protocol::identity($server)) { return; }
            app(ChangeFeed::class)->persist($link, ['schemaVersion' => 1,
                'eventId' => (string) Str::uuid(), 'instanceId' => $link->instance_id,
                'server' => Protocol::identity($server), 'type' => 'installation.updated',
                'occurredAt' => now()->toIso8601String(),
                'installation' => ['state' => $state, 'status' => $status]]);
        });
    }
}
