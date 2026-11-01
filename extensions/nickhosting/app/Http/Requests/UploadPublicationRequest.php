<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Http\Requests\Api\Client\Servers\Files\RenameFileRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\FileOperationPaths;

final class UploadPublicationRequest extends RenameFileRequest
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
        return ['operationId' => ['required', 'uuid'], 'identity' => ['required', 'array:providerId,providerUuid,identifier,externalId,nodeId'],
            'identity.providerId' => ['required', 'integer', 'min:1'], 'identity.providerUuid' => ['required', 'uuid'],
            'identity.identifier' => ['required', 'string', 'max:191'], 'identity.externalId' => ['required', 'string', 'max:191'],
            'identity.nodeId' => ['required', 'integer', 'min:1'],
            'source' => ['required', 'string', FileOperationPaths::rule()],
            'destination' => ['required', 'string', FileOperationPaths::rule(), function ($attribute, $value, $fail) {
                if (!is_string($this->input('source')) || !is_string($value)
                    || dirname($value) !== dirname($this->input('source'))
                    || basename($this->input('source')) !== '.nh-upload-' . $this->input('operationId') . '.pending'
                    || str_starts_with(basename($value), '.nh-upload-')) { $fail('Invalid upload publication paths.'); }
            }]];
    }
}
