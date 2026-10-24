<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use Pterodactyl\Enum\JwtScope;
use Pterodactyl\Services\Nodes\NodeJWTService;

final class NativeTokenScope
{
    /** Keep the native signer on both Panel generations; never manufacture JWT claims. */
    public static function apply(NodeJWTService $service, string $operation): NodeJWTService
    {
        // Panel 1.11 has neither setScopes nor JwtScope. Its paired Wings accepts
        // the original tokens; do not resolve the newer enum on that generation.
        if (!method_exists($service, 'setScopes')) {
            return $service;
        }

        return $service->setScopes(match ($operation) {
            'upload' => JwtScope::FileUpload,
            'download' => JwtScope::FileDownload,
            'installation' => JwtScope::Websocket,
            default => throw new \LogicException('Unknown native token operation.'),
        });
    }
}
