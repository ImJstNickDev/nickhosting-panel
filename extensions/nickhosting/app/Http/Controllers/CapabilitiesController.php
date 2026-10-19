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
            'extensionVersion' => '1.8.0',
            'target' => [
                'panel' => '1.15.1',
                'blueprint' => 'beta-2026-08',
            ],
            'capabilities' => [
                'clientKeyManagement' => true,
                'technicalAccounts' => true,
                'serverChangeEvents' => true,
                'backupEvents' => true,
                'installationEvents' => true,
                'installationConsole' => true,
                'fileOperations' => true,
                'bulkUploadUrls' => true,
                'bulkDownloadUrls' => true,
                'bulkDirectoryListings' => true,
            ],
        ], 200, ['Cache-Control' => 'no-store']);
    }
}
