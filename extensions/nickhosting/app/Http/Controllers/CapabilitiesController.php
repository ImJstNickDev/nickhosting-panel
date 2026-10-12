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
            'extensionVersion' => '1.4.0',
            'target' => [
                'panel' => '1.11.11',
                'blueprint' => 'beta-2025-09',
            ],
            'capabilities' => [
                'clientKeyManagement' => true,
                'technicalAccounts' => true,
                'serverChangeEvents' => true,
                'bulkUploadUrls' => true,
                'bulkDownloadUrls' => true,
                'bulkDirectoryListings' => true,
            ],
        ], 200, ['Cache-Control' => 'no-store']);
    }
}
