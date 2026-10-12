<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Pterodactyl\Models\Server;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\DirectoryListRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\DirectoryListingRepository;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\ManagedTransferAccess;

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
}
