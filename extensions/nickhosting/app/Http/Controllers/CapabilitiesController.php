<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\WorldScanAccess;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\CapabilitiesRequest;

class CapabilitiesController
{
    public function __invoke(CapabilitiesRequest $request): JsonResponse
    {
        return new JsonResponse(self::discovery($request, $request->query('inventory') === '1', $request->query('worldRead') === '1'), 200, ['Cache-Control' => 'no-store']);
    }

    public static function discovery(Request $request, bool $inventory, bool $worldRead): array
    {
        return [
            'schemaVersion' => 1,
            'extension' => 'nickhosting',
            'extensionVersion' => '1.11.0',
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
            ] + ($inventory ? [
                'gatewayInventory' => true,
                'linkedServerSnapshots' => true,
            ] : []),
        ] + ($worldRead ? ['worldReadPrincipal' => WorldScanAccess::principal($request->user()->currentAccessToken())] : []);
    }
}
