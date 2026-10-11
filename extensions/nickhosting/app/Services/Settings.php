<?php
namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use Pterodactyl\BlueprintFramework\Libraries\ExtensionLibrary\Admin\BlueprintAdminLibrary;

final class Settings
{
    public static function normalizeOrigin(string $value): ?string
    {
        $value = trim($value);
        if ($value === '') { return ''; }
        if (!filter_var($value, FILTER_VALIDATE_URL) || preg_match('/[\\\\\s]/', $value)) { return null; }
        $parts = parse_url($value);
        if (!$parts || ($parts['scheme'] ?? '') !== 'https' || empty($parts['host'])
            || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])
            || !in_array($parts['path'] ?? '', ['', '/'], true)) { return null; }
        return 'https://' . strtolower($parts['host']) . (isset($parts['port']) && $parts['port'] !== 443 ? ':' . $parts['port'] : '');
    }

    public function origin(): string
    {
        $value = app(BlueprintAdminLibrary::class)->dbGet('nickhosting', 'origin', '');
        return is_string($value) ? (self::normalizeOrigin($value) ?? '') : '';
    }

    public function origins(): array
    {
        $origin = $this->origin();
        return $origin === '' ? [] : [$origin];
    }

    public function save(string $value): void
    {
        $origin = self::normalizeOrigin($value);
        if ($origin === null) { throw new \InvalidArgumentException('Invalid HTTPS origin'); }
        app(BlueprintAdminLibrary::class)->dbSet('nickhosting', 'origin', $origin);
    }

    public function migrateLegacy(array $origins): void
    {
        $library = app(BlueprintAdminLibrary::class);
        if ($library->dbGet('nickhosting', 'origin') !== null) { return; }
        // Never arbitrarily select one destination from a multi-origin deployment.
        if (count($origins) !== 1 || !is_string($origins[0])) { return; }
        $origin = self::normalizeOrigin($origins[0]);
        if ($origin !== null && $origin !== '') { $library->dbSet('nickhosting', 'origin', $origin); }
    }
}
