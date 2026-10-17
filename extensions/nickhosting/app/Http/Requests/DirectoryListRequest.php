<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests;

use Pterodactyl\Http\Requests\Api\Client\Servers\Files\ListFilesRequest;

final class DirectoryListRequest extends ListFilesRequest
{
    use ClientDirectorySettings;
    public const MAX_BODY_BYTES = 512 * 1024;

    protected function prepareForValidation(): void
    {
        abort_if(strlen($this->getContent()) > self::MAX_BODY_BYTES, 413);
        abort_unless($this->isJson(), 415);
        try { $body = json_decode($this->getContent(), true, 32, JSON_THROW_ON_ERROR); }
        catch (\JsonException $error) { abort(422); }
        // Global TrimStrings/ConvertEmptyStringsToNull must not change filesystem names or root ''.
        $this->replace(['directories' => is_array($body) ? ($body['directories'] ?? null) : null]);
    }

    public function rules(): array
    {
        return ['directories' => ['required', 'array', 'min:1', 'max:' . $this->directorySettings()['directoryBatchLimit'],
            static function ($attribute, $value, $fail) {
                if (!is_array($value) || !array_is_list($value)) { $fail('The directories must be a list.'); return; }
                $seen = [];
                foreach ($value as $path) {
                    if (!is_string($path) || strlen($path) > 4096 || preg_match('//u', $path) !== 1
                        || preg_match('/[\\\\%\p{C}]/u', $path) || str_starts_with($path, '/') || str_ends_with($path, '/')) {
                        $fail('Invalid directory path.'); return;
                    }
                    if ($path !== '') {
                        foreach (explode('/', $path) as $part) {
                            if ($part === '' || $part === '.' || $part === '..') { $fail('Invalid directory path.'); return; }
                        }
                    }
                    if (isset($seen[$path])) { $fail('Directory paths must be unique.'); return; }
                    $seen[$path] = true;
                }
            }]];
    }
}
