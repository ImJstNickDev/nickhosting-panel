<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Http\Requests\Api\Client\Servers\Files\UploadFileRequest;

final class UploadUrlsRequest extends UploadFileRequest
{
    use ClientTransferSettings;
    public const MAX_BODY_BYTES = 2048;

    public function rules(): array
    {
        return ['count' => ['required', 'integer', 'min:1', 'max:' . $this->transferSettings()['uploadBatchLimit'],
            static function ($attribute, $value, $fail) {
                if (!is_int($value)) { $fail('The count must be an integer.'); }
            }]];
    }
}
