<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\CapabilitiesRequest;

class CapabilitiesController
{
    public function __invoke(CapabilitiesRequest $request): JsonResponse
    {
        return new JsonResponse([
            'schemaVersion' => 1,
            'extension' => 'nickhosting',
            'extensionVersion' => '0.1.0-dev',
            'target' => [
                'panel' => '1.11.11',
                'blueprint' => 'beta-2025-09',
            ],
            'capabilities' => [
                'clientKeyManagement' => false,
                'serverChangeEvents' => false,
            ],
        ], 200, ['Cache-Control' => 'no-store']);
    }
}
