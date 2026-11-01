<?php
namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

final class Protocol
{
    public static function identity(object $server): array
    {
        return ['providerId' => (int) $server->id, 'providerUuid' => $server->uuid,
            'identifier' => $server->uuidShort, 'externalId' => $server->external_id,
            'nodeId' => (int) $server->node_id];
    }

    public static function limits(object $server): array
    {
        return ['memory' => (int) $server->memory, 'swap' => (int) $server->swap,
            'disk' => (int) $server->disk, 'io' => (int) $server->io,
            'cpu' => (int) $server->cpu, 'threads' => $server->threads];
    }

    public static function signature(string $secret, string $timestamp, string $body): string
    {
        return hash_hmac('sha256', $timestamp . '.' . $body, $secret);
    }

    public static function callbackAllowed(string $url, array $origins): bool
    {
        $p = parse_url($url);
        if (!$p || ($p['scheme'] ?? '') !== 'https' || !isset($p['host'])
            || isset($p['user']) || isset($p['pass']) || isset($p['fragment']) || isset($p['query'])) {
            return false;
        }
        $origin = 'https://' . strtolower($p['host']) . (isset($p['port']) && $p['port'] !== 443 ? ':' . $p['port'] : '');
        return in_array($origin, $origins, true);
    }
}
