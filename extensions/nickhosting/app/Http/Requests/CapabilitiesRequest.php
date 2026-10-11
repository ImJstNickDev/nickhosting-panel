<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Http\Requests\Api\Application\ApplicationApiRequest;
use Pterodactyl\Models\ApiKey;
use Pterodactyl\Services\Acl\Api\AdminAcl;

class CapabilitiesRequest extends ApplicationApiRequest
{
    protected ?string $resource = AdminAcl::RESOURCE_SERVERS;

    protected int $permission = AdminAcl::READ;

    public function authorize(): bool
    {
        $token = $this->user()?->currentAccessToken();

        return $token instanceof ApiKey
            && $token->key_type === ApiKey::TYPE_APPLICATION
            && AdminAcl::check($token, $this->resource, $this->permission);
    }
}
