<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Pterodactyl\Models\Server;
use Pterodactyl\Services\Nodes\NodeJWTService;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\UploadUrlsRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\ManagedTransferAccess;

final class UploadUrlsController
{
    public function __construct(private NodeJWTService $jwtService) {}

    public function __invoke(UploadUrlsRequest $request, Server $server): JsonResponse
    {
        $user = app(ManagedTransferAccess::class)->authorize($request, $server);
        $count = $request->validated()['count'];
        $expiresAt = CarbonImmutable::now()->addSeconds($request->transferSettings()['signedUrlTtlSeconds']);
        $node = $server->node;
        $address = $node->getConnectionAddress();
        $urls = [];
        for ($i = 0; $i < $count; $i++) {
            // Native signing supplies a distinct unique_id consumed once by Wings.
            $token = $this->jwtService->setExpiresAt($expiresAt)->setUser($user)
                ->setClaims(['server_uuid' => $server->uuid])->handle($node, $user->id . $server->uuid);
            $urls[] = sprintf('%s/upload/file?token=%s', $address, $token->toString());
        }

        return new JsonResponse(['expiresAt' => $expiresAt->toIso8601String(), 'urls' => $urls],
            200, ['Cache-Control' => 'no-store']);
    }
}
