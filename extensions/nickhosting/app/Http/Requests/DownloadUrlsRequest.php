<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Http\Requests\Api\Client\Servers\Files\GetFileContentsRequest;

final class DownloadUrlsRequest extends GetFileContentsRequest
{
    use ClientTransferSettings;
    public const MAX_BODY_BYTES = 12 * 1024 * 1024;

    protected function prepareForValidation(): void
    {
        if (!$this->is('*/world-download-urls')) { return; }
        abort_if(strlen($this->getContent()) > self::MAX_BODY_BYTES, 413);
        abort_unless($this->isJson(), 415);
        try { $body = json_decode($this->getContent(), true, 32, JSON_THROW_ON_ERROR); }
        catch (\JsonException $error) { abort(422); }
        // Native TrimStrings may have changed a legitimate world directory component.
        $this->replace(['paths' => $body['paths'] ?? null, 'worldScan' => $body['worldScan'] ?? null]);
    }

    public function rules(): array
    {
        return ['paths' => ['required', 'array', 'min:1', 'max:' . $this->transferSettings()['downloadBatchLimit'],
            static function ($attribute, $value, $fail) {
                if (!is_array($value) || !array_is_list($value)) { $fail('The paths must be a list.'); return; }
                // A single linear pass avoids wildcard/distinct validation's quadratic expansion.
                $seen = [];
                foreach ($value as $path) {
                    if (!is_string($path) || $path === '' || strlen($path) > 4096
                        || preg_match('//u', $path) !== 1 || preg_match('/[\\\\%\\p{C}]/u', $path)
                        || str_starts_with($path, '/') || str_ends_with($path, '/')) {
                        $fail('Invalid file path.'); return;
                    }
                    foreach (explode('/', $path) as $part) {
                        if ($part === '' || $part === '.' || $part === '..') { $fail('Invalid file path.'); return; }
                    }
                    if (isset($seen[$path])) { $fail('File paths must be unique.'); return; }
                    $seen[$path] = true;
                }
            }]];
    }
}
