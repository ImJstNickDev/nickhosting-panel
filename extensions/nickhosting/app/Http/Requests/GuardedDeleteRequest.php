<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Http\Requests\Api\Client\Servers\Files\DeleteFileRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\FileOperationPaths;

final class GuardedDeleteRequest extends DeleteFileRequest
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
            'target' => ['required', 'array:path,observation'], 'target.path' => ['required', 'string', FileOperationPaths::rule()],
            'target.observation' => ['required', 'regex:/^[a-f0-9]{64}$/'],
            'guard' => ['required', 'array:path,sha256'], 'guard.path' => ['required', 'string', FileOperationPaths::rule()],
            'guard.sha256' => ['required', 'regex:/^[a-f0-9]{64}$/']];
    }
}
