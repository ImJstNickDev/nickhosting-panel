<?php
namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Illuminate\Support\Str;
use Illuminate\Support\Facades\DB;
use Pterodactyl\Models\ApiKey;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\GatewayTopology;
use Pterodactyl\Models\Server;
use Pterodactyl\Models\User;
use Pterodactyl\Services\Acl\Api\AdminAcl;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Protocol;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\ChangeFeed;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\GatewayInventory;

final class BridgeController
{
    private function authorize(Request $request, string $resource, bool $write = true, int $maxBytes = 65536): ApiKey
    {
        $key = $request->user()?->currentAccessToken();
        abort_unless($key instanceof ApiKey && $key->key_type === ApiKey::TYPE_APPLICATION
            && AdminAcl::check($key, $resource, $write ? AdminAcl::WRITE : AdminAcl::READ), 403);
        abort_if(strlen($request->getContent()) > $maxBytes, 413);
        return $key;
    }

    private function instance(Request $request, string $instance, string $resource = 'servers', bool $write = true): object
    {
        $key = $this->authorize($request, $resource, $write);
        $row = DB::table('nickhosting_instances')->where('id', $instance)->first();
        abort_unless($row && $row->api_key_id === $key->id, 403);
        return $row;
    }

    private function reply(array $body): JsonResponse
    {
        return new JsonResponse($body, 200, ['Cache-Control' => 'no-store']);
    }

    private function audit(string $instance, string $action, string $subject): void
    {
        DB::table('nickhosting_audit')->insert(['instance_id' => $instance, 'action' => $action,
            'subject' => $subject, 'created_at' => now()]);
    }

    private function ids(Request $request, string $field, int $limit, bool $uuids): array
    {
        return $this->idList($request->input($field), $limit, $uuids);
    }

    private function idList(mixed $items, int $limit, bool $uuids): array
    {
        abort_unless(is_array($items) && array_is_list($items) && count($items) <= $limit, 422);
        $seen = [];
        foreach ($items as $item) {
            if ($uuids) {
                abort_unless(is_string($item) && strlen($item) === 36 && Str::isUuid($item), 422);
                $item = strtolower($item);
            } else {
                abort_unless(is_int($item) && $item >= 1 && $item <= 4294967295, 422);
            }
            abort_if(isset($seen[$item]), 422);
            $seen[$item] = true;
        }
        return array_keys($seen);
    }

    private function inventoryKey(Request $request): ApiKey
    {
        $key = $this->authorize($request, 'servers', false, 524288);
        abort_unless(AdminAcl::check($key, AdminAcl::RESOURCE_NODES, AdminAcl::READ)
            && AdminAcl::check($key, AdminAcl::RESOURCE_ALLOCATIONS, AdminAcl::READ), 403);
        return $key;
    }

    private function recheckInventoryKey(ApiKey $key): void
    {
        $fresh = ApiKey::query()->useWritePdo()->whereHas('user', static fn ($user) => $user->where('root_admin', true))->find($key->id);
        $lifetime = config('sanctum.expiration');
        abort_unless($fresh && $fresh->key_type === ApiKey::TYPE_APPLICATION
            && (!$fresh->expires_at || !$fresh->expires_at->isPast())
            && (!$lifetime || $fresh->created_at?->gt(now()->subMinutes($lifetime)))
            && $fresh->getRawOriginal('token') === $key->getRawOriginal('token')
            && $fresh->getRawOriginal('identifier') === $key->getRawOriginal('identifier')
            && $fresh->getRawOriginal('allowed_ips') === $key->getRawOriginal('allowed_ips')
            && $fresh->user_id === $key->user_id && AdminAcl::check($fresh, 'servers', AdminAcl::READ)
            && AdminAcl::check($fresh, AdminAcl::RESOURCE_NODES, AdminAcl::READ)
            && AdminAcl::check($fresh, AdminAcl::RESOURCE_ALLOCATIONS, AdminAcl::READ), 403);
    }

    private function instanceReadError(mixed $instance, ApiKey $key): ?int
    {
        if (!is_string($instance) || strlen($instance) !== 36 || !Str::isUuid($instance)) { return 422; }
        try {
            $query = DB::table('nickhosting_instances')->where('id', $instance)->where('api_key_id', $key->id)
                ->select('id');
            return GatewayTopology::sectionRows($query) ? null : 403;
        } catch (\Throwable $error) { return 503; }
    }

    private function section(callable $read): array
    {
        $started = hrtime(true);
        try {
            $value = $read();
            return hrtime(true) - $started > 250000000 ? ['error' => 503] : ['value' => $value];
        } catch (HttpExceptionInterface $error) { return ['error' => $error->getStatusCode()]; }
        catch (\Throwable $error) { return ['error' => 503]; }
    }

    private function coordinated(Request $request, ApiKey $key, array $wanted): array
    {
        $sections = [];
        if (array_key_exists('capabilities', $wanted)) {
            $sections['capabilities'] = $this->section(function () use ($request, $wanted) {
                abort_unless($wanted['capabilities'] === true, 422);
                return ['checkedAt' => now()->toISOString(), 'extension' => CapabilitiesController::discovery($request, true, true)];
            });
        }
        if (!array_key_exists('health', $wanted) && !array_key_exists('snapshots', $wanted)) { return $sections; }
        $instance = $wanted['instanceId'] ?? null;
        $error = $this->instanceReadError($instance, $key);
        foreach (['health', 'snapshots'] as $name) {
            if (!array_key_exists($name, $wanted)) { continue; }
            $sections[$name] = $error ? ['error' => $error] : $this->section(function () use ($name, $wanted, $instance) {
                $uuids = $this->idList($wanted[$name], 100, true);
                abort_unless($uuids, 422);
                $result = ['schemaVersion' => 1, 'instanceId' => $instance];
                if ($name === 'health') {
                    $result['checkedAt'] = now()->toISOString();
                    return $result + ['scopes' => $this->scopeHealth($instance, $uuids, true)];
                }
                return $result + ['servers' => app(ChangeFeed::class)->verifiedSnapshots($instance, $uuids)];
            });
        }
        return $sections;
    }

    public function gatewayRevision(Request $request): JsonResponse
    {
        $key = $this->inventoryKey($request);
        $input = $request->all();
        abort_unless(!array_diff(array_keys($input), ['epoch', 'revision', 'waitMs', 'nodeIds', 'serverUuids', 'coordinated'])
            && is_string($input['epoch'] ?? null) && Str::isUuid($input['epoch'])
            && is_string($input['revision'] ?? null) && preg_match('/^[1-9][0-9]{0,19}$/D', $input['revision'])
            && is_int($input['waitMs'] ?? null) && $input['waitMs'] >= 0 && $input['waitMs'] <= 7500, 422);
        $nodes = $this->ids($request, 'nodeIds', 256, false);
        $servers = $this->ids($request, 'serverUuids', 10000, true);
        $started = hrtime(true);
        $wanted = $input['coordinated'] ?? null;
        $sections = is_array($wanted) ? $this->coordinated($request, $key, $wanted) : [];
        $receipt = GatewayTopology::wait($input['epoch'], $input['revision'], $input['waitMs'], $nodes, $servers, $started);
        if (isset($sections['health']['value']) || isset($sections['snapshots']['value'])) {
            $error = $this->instanceReadError($wanted['instanceId'], $key);
            if ($error) {
                foreach (['health', 'snapshots'] as $name) {
                    if (isset($sections[$name])) { $sections[$name] = ['error' => $error]; }
                }
            }
        }
        $this->recheckInventoryKey($key);
        return $this->reply($sections ? $receipt + ['coordinated' => $sections] : $receipt);
    }

    public function gatewayTopologySnapshot(Request $request): JsonResponse
    {
        return $this->gatewayInventory($request, true);
    }

    public function gatewayInventory(Request $request, bool $versioned = false): JsonResponse
    {
        $key = $this->inventoryKey($request);
        abort_if(array_diff(array_keys($request->all()), ['nodeIds', 'serverUuids']), 422);
        $result = app(GatewayInventory::class)->read(
            $this->ids($request, 'nodeIds', 256, false),
            $this->ids($request, 'serverUuids', 10000, true), $versioned
        );
        if ($versioned) { $this->recheckInventoryKey($key); }
        $response = $this->reply($result);
        // The consumer's transport reads at most 4 MiB. Never send a partial catalog.
        abort_if(strlen($response->getContent()) > 4194304, 413);
        return $response;
    }

    public function serverSnapshots(Request $request, string $instance): JsonResponse
    {
        $this->instance($request, $instance, 'servers', false);
        abort_if(array_diff(array_keys($request->all()), ['serverUuids']), 422);
        $uuids = $this->ids($request, 'serverUuids', 100, true);
        abort_if(!$uuids, 422);
        return $this->reply(['schemaVersion' => 1, 'instanceId' => $instance,
            'servers' => app(ChangeFeed::class)->snapshots($instance, $uuids)]);
    }

    public function register(Request $request, string $instance): JsonResponse
    {
        $key = $this->authorize($request, 'servers');
        $input = $request->validate(['callbackUrl' => 'required|string|max:2048',
            'webhookSecret' => ['required','string','regex:/^[a-f0-9]{64}$/']]);
        abort_unless(Protocol::callbackAllowed($input['callbackUrl'], app(\Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Settings::class)->origins()), 422);
        DB::transaction(function () use ($instance, $key, $input) {
            $old = DB::table('nickhosting_instances')->where('id', $instance)->lockForUpdate()->first();
            abort_if($old && $old->api_key_id !== $key->id, 403);
            DB::table('nickhosting_instances')->updateOrInsert(['id' => $instance], [
                'api_key_id' => $key->id, 'callback_url' => $input['callbackUrl'],
                'secret' => encrypt($input['webhookSecret']), 'created_at' => $old?->created_at ?? now(), 'updated_at' => now()]);
            $this->audit($instance, 'instance.registered', $instance);
        });
        return $this->reply(['instanceId' => $instance]);
    }

    public function snapshot(Request $request, string $instance, string $uuid): JsonResponse
    {
        $this->instance($request, $instance, 'servers', $request->isMethod('put'));
        $identity = $request->isMethod('put') ? $request->validate([
            'providerId' => 'required|integer|min:1', 'providerUuid' => 'required|uuid',
            'identifier' => 'required|string|max:16', 'externalId' => 'required|string|max:191',
            'nodeId' => 'required|integer|min:1', 'expectedOwnerId' => 'sometimes|integer|min:1',
        ]) : null;
        $expectedOwnerId = $identity['expectedOwnerId'] ?? null;
        if ($identity !== null) { unset($identity['expectedOwnerId']); }
        $feed = app(ChangeFeed::class);
        $payload = DB::transaction(function () use ($instance, $uuid, $identity, $feed, $expectedOwnerId) {
            // Same lock order as Panel updates: server, then extension link.
            $server = Server::query()->withoutEagerLoads()->where('uuid', $uuid)->lockForUpdate()->first();
            $link = DB::table('nickhosting_servers')->where('uuid', $uuid)->lockForUpdate()->first();
            abort_if($link && $link->instance_id !== $instance, 403);
            if ($identity !== null) {
                abort_unless($server && $identity === Protocol::identity($server), 409);
                abort_if($expectedOwnerId !== null && $server->owner_id !== $expectedOwnerId, 409);
                if (!$link) {
                    DB::table('nickhosting_servers')->insert(['uuid' => $uuid, 'instance_id' => $instance,
                        'server_id' => $server->id, 'owner_id' => $server->owner_id, 'identity' => json_encode($identity, JSON_THROW_ON_ERROR),
                        'limits' => json_encode(Protocol::limits($server), JSON_THROW_ON_ERROR),
                        'revision' => 1, 'valid' => true, 'created_at' => now(), 'updated_at' => now()]);
                    $this->audit($instance, 'server.linked', $uuid);
                    $feed->enqueue(DB::table('nickhosting_servers')->where('uuid', $uuid)->first(), 'limits.updated');
                } else {
                    // Explicit, identity-checked owner handoff only. No GET/ordinary PUT repair.
                    abort_unless(json_decode($link->identity, true) === $identity, 409);
                    if ($expectedOwnerId !== null && $link->owner_id !== $expectedOwnerId) {
                        DB::table('nickhosting_servers')->where('uuid', $uuid)->update([
                            'owner_id'=>$expectedOwnerId, 'valid'=>true, 'revision'=>$link->revision + 1,
                            'limits'=>json_encode(Protocol::limits($server), JSON_THROW_ON_ERROR), 'updated_at'=>now()]);
                        $this->audit($instance, 'server.owner_relinked', $uuid);
                        $feed->enqueue(DB::table('nickhosting_servers')->where('uuid', $uuid)->first(), 'limits.updated');
                    } else { abort_unless($link->valid && $link->owner_id === $server->owner_id, 409); }
                }
            }
            $link = DB::table('nickhosting_servers')->where('uuid', $uuid)->first();
            abort_unless($link, 404);
            if ($server) { $feed->capture($server); }
            elseif ($link->valid) {
                DB::table('nickhosting_servers')->where('uuid', $uuid)->update(['valid' => false, 'revision' => $link->revision + 1]);
                $link->valid = false; $link->revision++;
                $feed->enqueue($link, 'identity.invalidated');
            }
            return $feed->payload(DB::table('nickhosting_servers')->where('uuid', $uuid)->first());
        });
        return $this->reply($payload);
    }

    public function health(Request $request, string $instance): JsonResponse
    {
        $this->instance($request, $instance, 'servers', false);
        $observedAt = now()->toIso8601String();
        $outbox = DB::table('nickhosting_outbox')->where('instance_id', $instance);
        $health = ['schemaVersion' => 1, 'instanceId' => $instance,
            // Old receivers require a fully drained outbox, including quarantined events.
            'pendingEvents' => (clone $outbox)->whereNull('delivered_at')->count(),
            'lastDeliveredAt' => ($date = (clone $outbox)->max('delivered_at'))
                ? \Illuminate\Support\Carbon::parse($date)->toIso8601String() : null];
        if ($request->query->has('scopes')) {
            $raw = $request->query('scopes');
            abort_unless(is_string($raw) && strlen($raw) <= 3699, 422);
            $uuids = explode(',', $raw);
            abort_if(count($uuids) > 100 || count(array_unique($uuids)) !== count($uuids), 422);
            foreach ($uuids as $uuid) { abort_unless(strlen($uuid) === 36 && Str::isUuid($uuid), 422); }
            $health['scopes'] = $this->scopeHealth($instance, $uuids);
        }
        return $this->reply($health + ['checkedAt' => $observedAt]);
    }

    private function scopeHealth(string $instance, array $uuids, bool $coordinated = false): array
    {
        // Links and pending outbox claims must be observed in the same primary database statement.
        $query = DB::table('nickhosting_servers as s')->useWritePdo()->where('s.instance_id', $instance)
            ->leftJoin('servers as native', 'native.id', '=', 's.server_id')
            ->whereIn('s.uuid', $uuids)->whereNotNull('s.owner_id')->select(['s.uuid', 's.revision', 's.valid', 's.owner_id',
                'native.owner_id as current_owner', 'native.uuid as current_uuid'])
            ->selectRaw('EXISTS(SELECT 1 FROM nickhosting_outbox o WHERE o.instance_id = s.instance_id
                AND o.server_uuid = s.uuid AND o.delivered_at IS NULL AND o.quarantined_at IS NULL) AS pending');
        $rows = $coordinated ? GatewayTopology::sectionRows($query) : $query->get()->all();
        return array_map(static fn ($s) => ['providerUuid' => $s->uuid,
            'revision' => (int) $s->revision, 'ownerId' => (int) $s->owner_id,
            'valid' => (bool) $s->valid && $s->current_uuid === $s->uuid && (int)$s->current_owner === (int)$s->owner_id,
            'pending' => (bool) $s->pending], $rows);
    }

    public function provisionUser(Request $request, string $instance, string $nickUser): JsonResponse
    {
        $this->instance($request, $instance, 'users');
        abort_if(count($request->all()) !== 0, 422);
        return $this->reply(app(\Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\TechnicalAccounts::class)->provision($instance, $nickUser));
    }

    public function linkUser(Request $request, string $instance, string $nickUser): JsonResponse
    {
        $this->instance($request, $instance, 'users');
        $identity = $request->validate(['providerId' => 'required|integer|min:1',
            'providerUuid' => 'required|uuid', 'externalId' => 'required|string|max:191']);
        DB::transaction(function () use ($instance, $nickUser, $identity) {
            $user = User::query()->where('id', $identity['providerId'])->lockForUpdate()->first();
            abort_unless($user && !$user->root_admin && $user->uuid === $identity['providerUuid']
                && $user->external_id === $identity['externalId'], 409);
            $old = DB::table('nickhosting_users')->where('instance_id', $instance)->where('nick_user_id', $nickUser)->lockForUpdate()->first();
            if ($old) {
                abort_unless($old->provider_id === $user->id && $old->provider_uuid === $user->uuid
                    && $old->external_id === $user->external_id, 409);
                return;
            }
            abort_if(DB::table('nickhosting_users')->where('provider_id', $user->id)->exists(), 409);
            DB::table('nickhosting_users')->insert(['instance_id' => $instance, 'nick_user_id' => $nickUser,
                'provider_id' => $user->id, 'provider_uuid' => $user->uuid, 'external_id' => $user->external_id,
                'created_at' => now(), 'updated_at' => now()]);
            $this->audit($instance, 'user.linked', $nickUser);
        });
        return $this->reply($identity);
    }

    private function linkedUser(string $instance, string $nickUser): User
    {
        $link = DB::table('nickhosting_users')->where('instance_id', $instance)->where('nick_user_id', $nickUser)->first();
        abort_unless($link, 404);
        $user = User::query()->where('id', $link->provider_id)->lockForUpdate()->first();
        abort_unless($user && !$user->root_admin && $user->uuid === $link->provider_uuid && $user->external_id === $link->external_id, 409);
        return $user;
    }

    public function issueKey(Request $request, string $instance, string $nickUser, ?string $keyIdentifier = null): JsonResponse
    {
        $this->instance($request, $instance, 'users');
        $input = $request->validate(['operationId' => 'required|uuid', 'allowedIps' => 'sometimes|array|max:16',
            'allowedIps.*' => ['required','string','max:49', function ($attribute, $value, $fail) {
                [$ip, $mask] = array_pad(explode('/', $value, 2), 2, null);
                if (!filter_var($ip, FILTER_VALIDATE_IP) || ($mask !== null && (!ctype_digit($mask)
                    || (int) $mask > (str_contains($ip, ':') ? 128 : 32)))) { $fail('Invalid IP restriction.'); }
            }]]);
        $result = DB::transaction(function () use ($instance, $nickUser, $keyIdentifier, $input) {
            $user = $this->linkedUser($instance, $nickUser);
            $hash = hash('sha256', json_encode([$instance, $nickUser, $keyIdentifier, $input['allowedIps'] ?? []], JSON_THROW_ON_ERROR));
            $old = DB::table('nickhosting_keys')->where('operation_id', $input['operationId'])->lockForUpdate()->first();
            if ($old) {
                abort_unless($old->instance_id === $instance && $old->nick_user_id === $nickUser
                    && hash_equals($old->request_hash, $hash) && !$old->revoked_at, 409);
                abort_unless($user->tokens()->where('identifier', $old->identifier)->where('key_type', ApiKey::TYPE_ACCOUNT)->exists(), 409);
                return json_decode(decrypt($old->encrypted_response), true, 512, JSON_THROW_ON_ERROR);
            }
            if ($keyIdentifier !== null) {
                $previous = DB::table('nickhosting_keys')->where('instance_id', $instance)->where('nick_user_id', $nickUser)
                    ->where('identifier', $keyIdentifier)->whereNull('revoked_at')->first();
                abort_unless($previous && $user->tokens()->where('identifier', $keyIdentifier)->where('key_type', ApiKey::TYPE_ACCOUNT)->exists(), 409);
            }
            $issued = $user->createToken('NickHosting ' . $instance, $input['allowedIps'] ?? []);
            $result = ['operationId' => $input['operationId'], 'identifier' => $issued->accessToken->identifier,
                'key' => $issued->accessToken->identifier . $issued->plainTextToken];
            DB::table('nickhosting_keys')->insert(['operation_id' => $input['operationId'], 'instance_id' => $instance,
                'nick_user_id' => $nickUser, 'identifier' => $result['identifier'],
                'encrypted_response' => encrypt(json_encode($result, JSON_THROW_ON_ERROR)), 'request_hash' => $hash,
                'created_at' => now(), 'updated_at' => now()]);
            $this->audit($instance, $keyIdentifier ? 'key.rotation_issued' : 'key.issued', $nickUser);
            return $result;
        });
        return $this->reply($result);
    }

    public function revokeKey(Request $request, string $instance, string $nickUser, string $keyIdentifier): JsonResponse
    {
        $this->instance($request, $instance, 'users');
        DB::transaction(function () use ($instance, $nickUser, $keyIdentifier) {
            $user = $this->linkedUser($instance, $nickUser);
            $key = DB::table('nickhosting_keys')->where('instance_id', $instance)->where('nick_user_id', $nickUser)
                ->where('identifier', $keyIdentifier)->lockForUpdate()->first();
            abort_unless($key, 404);
            if ($key->revoked_at) { return; }
            $user->tokens()->where('identifier', $keyIdentifier)->where('key_type', ApiKey::TYPE_ACCOUNT)->delete();
            DB::table('nickhosting_keys')->where('operation_id', $key->operation_id)->update([
                'encrypted_response' => null, 'revoked_at' => now(), 'updated_at' => now()]);
            $this->audit($instance, 'key.revoked', $nickUser);
        });
        return new JsonResponse(null, 204, ['Cache-Control' => 'no-store']);
    }
}
