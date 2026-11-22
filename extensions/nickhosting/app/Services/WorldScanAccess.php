<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use Illuminate\Http\Request;
use IPTools\IP;
use IPTools\Range;
use Illuminate\Support\Facades\DB;
use Pterodactyl\Models\ApiKey;
use Pterodactyl\Models\Permission;
use Pterodactyl\Models\Server;
use Pterodactyl\Models\User;
use Pterodactyl\Services\Acl\Api\AdminAcl;

final class WorldScanAccess
{
    // Only emitted by negotiated, authenticated Application discovery. Include the
    // encrypted native token and IP policy so rotation or policy changes revoke it.
    public static function principal(ApiKey $key): string
    {
        return hash('sha256', json_encode(['nickhosting.world-read.v1', $key->id, $key->user_id,
            $key->getRawOriginal('token'), $key->identifier, $key->getRawOriginal('allowed_ips')], JSON_THROW_ON_ERROR));
    }

    private static function sourceAllowed(Request $request, ApiKey $key): bool
    {
        if (empty($key->allowed_ips)) { return true; }
        // These are the same IP and range types used by native AuthenticateIPAccess.
        $address = new IP($request->ip());
        foreach ($key->allowed_ips as $range) {
            if (Range::parse($range)->contains($address)) { return true; }
        }
        return false;
    }

    public function authorize(Request $request, Server $server): User
    {
        return GatewayInventory::transaction(function () use ($request, $server) {
            $fresh = Server::query()->withoutEagerLoads()->find($server->id);
            abort_unless($fresh && $fresh->uuid === $server->uuid && $fresh->node_id === $server->node_id
                && $fresh->owner_id === $server->owner_id && $fresh->status === $server->status, 409);
            [$user, $link] = app(ManagedTransferAccess::class)->linkedOwner($request, $fresh);
            abort_unless($user->can(Permission::ACTION_FILE_READ_CONTENT, $server), 403);
            $proof = $request->input('worldScan');
            abort_unless(is_array($proof), 422);
            abort_unless($link->instance_id === ($proof['instanceId'] ?? null)
                && $link->nick_user_id === ($proof['nickUserId'] ?? null)
                && $link->provider_uuid === ($proof['ownerUuid'] ?? null)
                && $link->external_id === ($proof['ownerExternalId'] ?? null), 409);
            $client = $user->currentAccessToken();
            abort_unless($client instanceof ApiKey, 403);
            // Both native principals and their key rows must still be eligible at this instant.
            $keys = ApiKey::query()->from('api_keys as appkey')->select('appkey.*',
                'client.token as client_token', 'client.allowed_ips as client_ips',
                'client.identifier as client_identifier', 'owner.uuid as owner_uuid', 'owner.external_id as owner_external')
                ->join('nickhosting_instances as instance', 'instance.api_key_id', '=', 'appkey.id')
                ->join('users as admin', 'admin.id', '=', 'appkey.user_id')
                ->crossJoin('api_keys as client')->join('users as owner', 'owner.id', '=', 'client.user_id')
                ->where('instance.id', $link->instance_id)->where('admin.root_admin', true)
                ->where('owner.root_admin', false)->where('owner.id', $user->id)->where('client.id', $client->id)
                ->where('client.key_type', ApiKey::TYPE_ACCOUNT)
                ->where(fn($q) => $q->whereNull('client.expires_at')->orWhere('client.expires_at', '>', now()));
            $lifetime = config('sanctum.expiration');
            if ($lifetime) { $keys->where('client.created_at', '>', now()->subMinutes($lifetime)); }
            $key = $keys->first();
            abort_unless($key && $key->owner_uuid === $user->uuid && $key->owner_external === $user->external_id
                && $key->client_token === $client->getRawOriginal('token')
                && $key->client_ips === $client->getRawOriginal('allowed_ips')
                && $key->client_identifier === ($proof['clientKeyIdentifier'] ?? null)
                && $key->key_type === ApiKey::TYPE_APPLICATION
                && (!$key->expires_at || $key->expires_at->isFuture())
                && (!$lifetime || $key->created_at?->gt(now()->subMinutes($lifetime)))
                && AdminAcl::check($key, AdminAcl::RESOURCE_SERVERS, AdminAcl::READ)
                && AdminAcl::check($key, AdminAcl::RESOURCE_ALLOCATIONS, AdminAcl::READ)
                && is_string($proof['principal'] ?? null)
                && self::sourceAllowed($request, $key)
                && hash_equals(self::principal($key), $proof['principal']), 403);
            foreach (Protocol::identity($fresh) as $name => $value) {
                abort_unless($value === ($proof['server'][$name] ?? null), 409);
            }
            abort_unless([$fresh->owner_id, $fresh->nest_id, $fresh->egg_id, $fresh->allocation_id]
                === ($proof['placement'] ?? null), 409);
            $expected = $proof['allocations'] ?? null;
            abort_unless(is_array($expected) && array_is_list($expected) && count($expected) > 0
                && count($expected) <= 65536, 422);
            $rows = DB::table('allocations')->where('server_id', $fresh->id)->orderBy('id')
                ->limit(count($expected) + 1)->get(['id','node_id','ip','port']);
            abort_unless($rows->count() === count($expected), 409);
            $hasPrimary = false;
            foreach ($rows as $i => $allocation) {
                $claim = $expected[$i];
                abort_unless(is_array($claim) && count($claim) === 3 && $claim[0] === (int)$allocation->id
                    && $claim[2] === (int)$allocation->port && (int)$allocation->node_id === $fresh->node_id
                    && is_string($claim[1]) && filter_var($claim[1], FILTER_VALIDATE_IP) !== false
                    && inet_pton($claim[1]) === inet_pton($allocation->ip), 409);
                $hasPrimary = $hasPrimary || $claim[0] === $fresh->allocation_id;
            }
            abort_unless($hasPrimary, 409);
            // Explicitly linked legacy users keep the pre-existing Application detail path.
            abort_unless($link->technical, 412);
            return [$user];
        })[0];
    }
}
