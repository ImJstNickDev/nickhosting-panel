<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Http\Requests\Api\Client\Servers\Files\GetFileContentsRequest;

final class DownloadUrlsRequest extends GetFileContentsRequest
{
    use ClientTransferSettings;
    public const MAX_BODY_BYTES = 12 * 1024 * 1024;

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
