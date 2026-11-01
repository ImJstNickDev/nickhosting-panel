<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Http\Requests\Api\Client\Servers\Files\GetFileContentsRequest;

final class TransferSettingsRequest extends GetFileContentsRequest
{
    use ClientTransferSettings;
    public const MAX_BODY_BYTES = 2048;

    public function rules(): array { return []; }
}
