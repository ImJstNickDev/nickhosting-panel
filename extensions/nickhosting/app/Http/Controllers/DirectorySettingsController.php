<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Pterodactyl\Models\Server;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\DirectorySettingsRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\ManagedTransferAccess;

final class DirectorySettingsController
{
    public function __invoke(DirectorySettingsRequest $request, Server $server): JsonResponse
    {
        app(ManagedTransferAccess::class)->authorize($request, $server);
        return new JsonResponse($request->directorySettings(), 200, ['Cache-Control' => 'no-store']);
    }
}
