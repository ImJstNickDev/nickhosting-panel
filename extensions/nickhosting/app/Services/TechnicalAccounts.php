<?php
namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use Illuminate\Support\Facades\DB;
use Pterodactyl\Models\User;
use Pterodactyl\Services\Users\UserCreationService;

final class TechnicalAccounts
{
    private ?string $creatingExternalId = null;

    public static function identity(string $instance, string $nickUser): array
    {
        $hash = hash('sha256', strtolower($instance . ':' . $nickUser));
        return ['external_id' => 'nh:' . strtolower($instance . ':' . $nickUser),
            'username' => 'nh-' . substr($hash, 0, 29), 'email' => $hash . '@accounts.nickhosting.invalid'];
    }

    public function managed(User $user): bool
    {
        // Durable ID/UUID ownership, never a username prefix or email-domain heuristic.
        return ($this->creatingExternalId !== null && $user->external_id === $this->creatingExternalId)
            || DB::table('nickhosting_users')->where('provider_id', $user->id)
                ->where('provider_uuid', $user->uuid)->where('technical', true)->exists();
    }

    public function byLogin(string $login): bool
    {
        $user = User::query()->where(str_contains($login, '@') ? 'email' : 'username', $login)->first();
        return $user && $this->managed($user);
    }

    public function provision(string $instance, string $nickUser): array
    {
        return DB::transaction(function () use ($instance, $nickUser) {
            // Existing row serializes even the first concurrent request for a new local user.
            abort_unless(DB::table('nickhosting_instances')->where('id', $instance)->lockForUpdate()->first(), 404);
            $identity = self::identity($instance, $nickUser);
            $link = DB::table('nickhosting_users')->where('instance_id', $instance)->where('nick_user_id', $nickUser)->first();
            if ($link) {
                $user = User::query()->where('id', $link->provider_id)->lockForUpdate()->first();
                abort_unless($link->technical && $user && !$user->root_admin
                    && $user->uuid === $link->provider_uuid && $user->external_id === $link->external_id
                    && $link->external_id === $identity['external_id'], 409);
            } else {
                // A collision without our durable link is not proof of ownership. Never adopt it.
                abort_if(User::query()->where('external_id', $identity['external_id'])
                    ->orWhere('email', $identity['email'])->orWhere('username', $identity['username'])->exists(), 409);
                $this->creatingExternalId = $identity['external_id'];
                $transactionLevel = DB::transactionLevel();
                try {
                    $user = app(UserCreationService::class)->handle($identity + ['name_first' => 'NickHosting',
                        'name_last' => 'Managed', 'root_admin' => false, 'language' => 'en',
                        'password' => bin2hex(random_bytes(48))]);
                    DB::table('nickhosting_users')->insert(['instance_id' => $instance, 'nick_user_id' => $nickUser,
                        'provider_id' => $user->id, 'provider_uuid' => $user->uuid,
                        'external_id' => $user->external_id, 'technical' => true,
                        'created_at' => now(), 'updated_at' => now()]);
                } catch (\Throwable $error) {
                    // Native creation opens a nested transaction but does not catch its
                    // own failure. Restore our savepoint level before outer rollback.
                    if (DB::transactionLevel() > $transactionLevel) { DB::rollBack($transactionLevel); }
                    throw $error;
                } finally { $this->creatingExternalId = null; }
                DB::table('nickhosting_audit')->insert(['instance_id' => $instance,
                    'action' => 'user.provisioned', 'subject' => $nickUser, 'created_at' => now()]);
            }
            return ['providerId' => $user->id, 'providerUuid' => $user->uuid, 'externalId' => $user->external_id];
        });
    }
}
