<?php
namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Illuminate\Http\Request;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Pterodactyl\Models\ApiKey;
use Pterodactyl\Models\Server;
use Pterodactyl\Models\User;
use Pterodactyl\Services\Acl\Api\AdminAcl;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Protocol;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\ChangeFeed;

final class BridgeController
{
    private function authorize(Request $request, string $resource, bool $write = true): ApiKey
    {
        $key = $request->user()?->currentAccessToken();
        abort_unless($key instanceof ApiKey && $key->key_type === ApiKey::TYPE_APPLICATION
            && AdminAcl::check($key, $resource, $write ? AdminAcl::WRITE : AdminAcl::READ), 403);
        abort_if(strlen($request->getContent()) > 65536, 413);
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
            'nodeId' => 'required|integer|min:1',
        ]) : null;
        $feed = app(ChangeFeed::class);
        $payload = DB::transaction(function () use ($instance, $uuid, $identity, $feed) {
            // Same lock order as Panel updates: server, then extension link.
            $server = Server::query()->withoutEagerLoads()->where('uuid', $uuid)->lockForUpdate()->first();
            $link = DB::table('nickhosting_servers')->where('uuid', $uuid)->lockForUpdate()->first();
            abort_if($link && $link->instance_id !== $instance, 403);
            if ($identity !== null) {
                abort_unless($server && $identity === Protocol::identity($server), 409);
                if (!$link) {
                    DB::table('nickhosting_servers')->insert(['uuid' => $uuid, 'instance_id' => $instance,
                        'server_id' => $server->id, 'identity' => json_encode($identity, JSON_THROW_ON_ERROR),
                        'limits' => json_encode(Protocol::limits($server), JSON_THROW_ON_ERROR),
                        'revision' => 1, 'valid' => true, 'created_at' => now(), 'updated_at' => now()]);
                    $this->audit($instance, 'server.linked', $uuid);
                    $feed->enqueue(DB::table('nickhosting_servers')->where('uuid', $uuid)->first(), 'limits.updated');
                } else {
                    // Identity drift is never repaired implicitly by retrying registration.
                    abort_unless($link->valid && json_decode($link->identity, true) === $identity, 409);
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
        return $this->reply(['schemaVersion' => 1, 'instanceId' => $instance,
            'pendingEvents' => DB::table('nickhosting_outbox')->where('instance_id', $instance)->whereNull('delivered_at')->count(),
            'lastDeliveredAt' => ($date = DB::table('nickhosting_outbox')->where('instance_id', $instance)->max('delivered_at'))
                ? \Illuminate\Support\Carbon::parse($date)->toIso8601String() : null,
            'checkedAt' => now()->toIso8601String()]);
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
