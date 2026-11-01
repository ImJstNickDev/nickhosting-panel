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
        $user = $request->user();
        // Client operations must use the exact linked non-admin owner's credential.
        abort_unless($user && !$user->root_admin && $user->id === $server->owner_id, 403);
        $link = DB::table('nickhosting_servers')->where('uuid', $server->uuid)->first();
        abort_unless($link, 403);
        abort_unless($link->valid && $link->server_id === $server->id
            && $link->owner_id === $server->owner_id
            && json_decode($link->identity, true, 512, JSON_THROW_ON_ERROR) === Protocol::identity($server), 409);
        $owner = DB::table('nickhosting_users')->where('instance_id', $link->instance_id)
            ->where('provider_id', $user->id)->first();
        abort_unless($owner && $owner->provider_uuid === $user->uuid
            && $owner->external_id === $user->external_id, 409);
        return $user;
    }
}
