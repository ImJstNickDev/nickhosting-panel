<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Http\Requests\Api\Client\Servers\Files\CreateFolderRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\FileOperationPaths;

final class ArchiveCommitRequest extends CreateFolderRequest
{
    use ClientTransferSettings;
    public const MAX_BODY_BYTES = 4194304;
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
            'archiveSha256' => ['required', 'regex:/^[a-f0-9]{64}$/'],
            'destinationRoot' => ['required', 'string', FileOperationPaths::rule(), static function ($a, $v, $fail) {
                if (!is_string($v) || str_contains($v, '/') || str_starts_with($v, '.nickhosting-import-')) { $fail('Invalid destination.'); }
            }],
            'files' => ['required', 'array', 'min:1', 'max:10000', function ($a, $files, $fail) {
                if (!is_array($files) || !array_is_list($files)) { $fail('Expected file list.'); return; }
                $seen = [];
                foreach ($files as $file) {
                    if (!is_array($file) || count($file) !== 2 || !FileOperationPaths::valid($file['path'] ?? null)
                        || !str_starts_with($file['path'], $this->input('destinationRoot') . '/')
                        || !is_int($file['size'] ?? null) || $file['size'] < 0 || $file['size'] > 9007199254740991
                        || isset($seen[$file['path']])) { $fail('Invalid archive manifest.'); return; }
                    $seen[$file['path']] = true;
                }
            }]];
    }
}
