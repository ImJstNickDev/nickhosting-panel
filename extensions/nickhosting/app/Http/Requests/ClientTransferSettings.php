<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Models\ApiKey;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Settings;

trait ClientTransferSettings
{
    private ?array $resolvedTransferSettings = null;

    public function authorize(): bool
    {
        abort_if(strlen($this->getContent()) > static::MAX_BODY_BYTES, 413);
        $token = $this->user()?->currentAccessToken();
        return $token instanceof ApiKey && $token->key_type === ApiKey::TYPE_ACCOUNT && parent::authorize();
    }

    public function transferSettings(): array
    {
        // The validator and controller share one snapshot; never query inside token loops.
        return $this->resolvedTransferSettings ??= app(Settings::class)->transfer();
    }
}
