<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

final class FileOperationPaths
{
    public static function valid(mixed $path): bool
    {
        if (!is_string($path) || $path === '' || strlen($path) > 4096 || preg_match('//u', $path) !== 1
            || preg_match('/[\\\\%\p{C}]/u', $path) || str_starts_with($path, '/') || str_ends_with($path, '/')) { return false; }
        foreach (explode('/', $path) as $part) {
            if ($part === '' || $part === '.' || $part === '..') { return false; }
        }
        return true;
    }

    public static function rule(): \Closure
    {
        return static function ($attribute, $value, $fail) {
            if (!self::valid($value)) { $fail('Invalid relative path.'); }
        };
    }
}
