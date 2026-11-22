<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Pterodactyl\Models\Server;
use Pterodactyl\Models\User;

final class ManagedTransferAccess
{
    public function authorize(Request $request, Server $server): User
    {
        $user = $this->owner($request, $server);
        $link = DB::table('nickhosting_servers')->where('uuid', $server->uuid)->first();
        $this->checkServerLink($server, $link);
        $owner = DB::table('nickhosting_users')->where('instance_id', $link->instance_id)
            ->where('provider_id', $user->id)->first();
        $this->checkOwnerLink($user, $owner?->provider_uuid, $owner?->external_id);
        return $user;
    }

    /** Read both links and their additional world-scan claims in a single native query. */
    public function linkedOwner(Request $request, Server $server): array
    {
        $user = $this->owner($request, $server);
        $link = DB::table('nickhosting_servers as s')->where('s.uuid', $server->uuid)
            ->leftJoin('nickhosting_users as u', fn($j) => $j->on('u.instance_id', '=', 's.instance_id')
                ->where('u.provider_id', $user->id))
            ->first(['s.*', 'u.provider_uuid', 'u.external_id', 'u.nick_user_id', 'u.technical']);
        $this->checkServerLink($server, $link);
        $this->checkOwnerLink($user, $link->provider_uuid, $link->external_id);
        return [$user, $link];
    }

    private function owner(Request $request, Server $server): User
    {
        $user = $request->user();
        abort_unless($user && !$user->root_admin && $user->id === $server->owner_id, 403);
        return $user;
    }

    private function checkServerLink(Server $server, ?object $link): void
    {
        abort_unless($link, 403);
        abort_unless($link->valid && $link->server_id === $server->id
            && $link->owner_id === $server->owner_id
            && json_decode($link->identity, true, 512, JSON_THROW_ON_ERROR) === Protocol::identity($server), 409);
    }

    private function checkOwnerLink(User $user, ?string $uuid, ?string $externalId): void
    {
        abort_unless($uuid === $user->uuid && $externalId === $user->external_id, 409);
    }
}
