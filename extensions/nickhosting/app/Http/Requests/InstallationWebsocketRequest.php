<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Models\ApiKey;
use Pterodactyl\Models\Permission;
use Pterodactyl\Http\Requests\Api\Client\ClientApiRequest;

final class InstallationWebsocketRequest extends ClientApiRequest
{
    public function authorize(): bool
    {
        $token = $this->user()?->currentAccessToken();
        return $token instanceof ApiKey && $token->key_type === ApiKey::TYPE_ACCOUNT && parent::authorize();
    }

    public function permission(): string { return Permission::ACTION_WEBSOCKET_CONNECT; }
    public function rules(): array { return []; }
}
