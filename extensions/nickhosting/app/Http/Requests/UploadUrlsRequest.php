<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Models\ApiKey;
use Pterodactyl\Http\Requests\Api\Client\Servers\Files\UploadFileRequest;

final class UploadUrlsRequest extends UploadFileRequest
{
    public function authorize(): bool
    {
        $token = $this->user()?->currentAccessToken();
        abort_if(strlen($this->getContent()) > 2048, 413);

        return $token instanceof ApiKey
            && $token->key_type === ApiKey::TYPE_ACCOUNT
            && parent::authorize();
    }

    public function rules(): array
    {
        return ['count' => ['required', 'integer', 'min:1', 'max:500',
            static function ($attribute, $value, $fail) {
                if (!is_int($value)) { $fail('The count must be an integer.'); }
            }]];
    }
}
