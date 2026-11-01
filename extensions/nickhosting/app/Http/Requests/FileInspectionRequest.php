<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Http\Requests\Api\Client\Servers\Files\GetFileContentsRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\FileOperationPaths;

final class FileInspectionRequest extends GetFileContentsRequest
{
    use ClientTransferSettings;
    public const MAX_BODY_BYTES = 32768;

    protected function prepareForValidation(): void
    {
        abort_if(strlen($this->getContent()) > self::MAX_BODY_BYTES, 413);
        abort_unless($this->isJson(), 415);
        try { $body = json_decode($this->getContent(), true, 16, JSON_THROW_ON_ERROR); }
        catch (\JsonException $error) { abort(422); }
        $this->replace(is_array($body) ? $body : []);
    }

    public function rules(): array
    {
        return ['target' => ['required', 'string', FileOperationPaths::rule()],
            'guardFile' => ['required', 'string', FileOperationPaths::rule()]];
    }
}
