<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Http\Requests\Api\Client\Servers\Files\ListFilesRequest;

final class DirectorySettingsRequest extends ListFilesRequest
{
    use ClientDirectorySettings;
    public const MAX_BODY_BYTES = 2048;

    public function rules(): array { return []; }
}
