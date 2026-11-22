<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Pterodactyl\Models\Server;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\DirectoryListRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\DirectoryListingRepository;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\ManagedTransferAccess;

use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\WorldScanAccess;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Settings;

final class DirectoryListController
{
    public function __construct(private DirectoryListingRepository $directories) {}

    public function __invoke(DirectoryListRequest $request, Server $server): JsonResponse
    {
        app(ManagedTransferAccess::class)->authorize($request, $server);
        return new JsonResponse(['results' => $this->directories->setServer($server)
            ->listDirectories($request->validated()['directories'], $request->directorySettings())],
            200, ['Cache-Control' => 'no-store']);
    }

    public function worlds(DirectoryListRequest $request, Server $server): JsonResponse
    {
        $guard = app(WorldScanAccess::class);
        $guard->authorize($request, $server);
        $paths = $request->validated()['directories'];
        foreach ($paths as $path) { abort_if(str_contains($path, '/'), 422); }
        $results = $this->directories->setServer($server)->listDirectories($paths, $request->directorySettings());
        $user = $guard->authorize($request, $server);
        $body = ['schemaVersion' => 1, 'results' => $results];
        if ($paths === [''] && isset($results[0]['files'])) {
            $body['propertiesGrant'] = app(DownloadUrlsController::class)->sign($user, $server,
                ['server.properties'], app(Settings::class)->transfer()['signedUrlTtlSeconds']);
        }
        return new JsonResponse($body, 200, ['Cache-Control' => 'no-store']);
    }
}
