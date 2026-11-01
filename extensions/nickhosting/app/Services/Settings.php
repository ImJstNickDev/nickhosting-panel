<?php
namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use Pterodactyl\BlueprintFramework\Libraries\ExtensionLibrary\Admin\BlueprintAdminLibrary;

final class Settings
{
    // Upper bounds preserve the existing queue timeout/claim budget and token lifetime.
    public const OPERATIONAL = [
        'directoryBatchLimit' => ['default' => 48, 'min' => 1, 'max' => 64],
        'directoryConcurrency' => ['default' => 2, 'min' => 1, 'max' => 4],
        'directoryTimeoutSeconds' => ['default' => 8, 'min' => 1, 'max' => 10],
        'downloadBatchLimit' => ['default' => 2500, 'min' => 1, 'max' => 2500],
        'uploadBatchLimit' => ['default' => 500, 'min' => 1, 'max' => 500],
        'signedUrlTtlSeconds' => ['default' => 900, 'min' => 60, 'max' => 900],
        'webhookBatchLimit' => ['default' => 10, 'min' => 1, 'max' => 10],
        'webhookConnectTimeoutSeconds' => ['default' => 2, 'min' => 1, 'max' => 2],
        'webhookTimeoutSeconds' => ['default' => 4, 'min' => 1, 'max' => 4],
    ];

    public function operational(?array $names = null): array
    {
        $library = app(BlueprintAdminLibrary::class);
        $values = [];
        foreach ($names ?? array_keys(self::OPERATIONAL) as $name) {
            $definition = self::OPERATIONAL[$name];
            $value = $library->dbGet('nickhosting', $name, $definition['default']);
            $integer = filter_var($value, FILTER_VALIDATE_INT);
            $values[$name] = $integer !== false && $integer >= $definition['min'] && $integer <= $definition['max']
                ? $integer : $definition['default'];
        }
        return $values;
    }

    public function transfer(): array
    {
        return $this->operational(['downloadBatchLimit', 'uploadBatchLimit', 'signedUrlTtlSeconds']);
    }

    public function directory(): array
    {
        return $this->operational(['directoryBatchLimit', 'directoryConcurrency', 'directoryTimeoutSeconds']);
    }

    public function saveOperational(array $values): void
    {
        // Validate the whole update before writing anything. Omitted settings are preserved.
        foreach ($values as $name => $value) {
            $definition = self::OPERATIONAL[$name] ?? null;
            if (!$definition || !is_int($value) || $value < $definition['min'] || $value > $definition['max']) {
                throw new \InvalidArgumentException('Invalid operational setting');
            }
        }
        $library = app(BlueprintAdminLibrary::class);
        foreach ($values as $name => $value) { $library->dbSet('nickhosting', $name, $value); }
    }

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
