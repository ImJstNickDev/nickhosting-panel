<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Pterodactyl\Models\Server;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\TransferSettingsRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\ManagedTransferAccess;

final class TransferSettingsController
{
    public function __invoke(TransferSettingsRequest $request, Server $server): JsonResponse
    {
        app(ManagedTransferAccess::class)->authorize($request, $server);
        return new JsonResponse($request->transferSettings(), 200, ['Cache-Control' => 'no-store']);
    }
}
