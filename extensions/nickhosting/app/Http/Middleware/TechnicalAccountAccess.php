<?php
namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Pterodactyl\Models\ApiKey;
use Pterodactyl\Models\User;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\TechnicalAccounts;

final class TechnicalAccountAccess
{
    public function __construct(private TechnicalAccounts $accounts) {}

    public function handle(Request $request, Closure $next)
    {
        $user = $request->user();
        if ($user instanceof User && $this->accounts->managed($user)) {
            // Sanctum transient cookie tokens must not be mistaken for real API keys.
            abort_unless($request->is('api/client', 'api/client/*')
                && $user->currentAccessToken() instanceof ApiKey
                && $user->currentAccessToken()->key_type === ApiKey::TYPE_ACCOUNT, 403);
        }
        if ($request->is('auth/*')) {
            foreach (['user', 'email'] as $field) {
                $value = $request->input($field);
                abort_if(is_string($value) && $this->accounts->byLogin($value), 403);
            }
            $id = $request->hasSession() ? $request->session()->get('auth_confirmation_token.user_id') : null;
            if ($id && ($candidate = User::query()->find($id))) { abort_if($this->accounts->managed($candidate), 403); }
        }
        return $next($request);
    }
}
