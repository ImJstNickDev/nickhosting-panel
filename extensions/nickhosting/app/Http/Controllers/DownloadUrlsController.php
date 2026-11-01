<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Pterodactyl\Models\Server;
use Pterodactyl\Services\Nodes\NodeJWTService;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\DownloadUrlsRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\ManagedTransferAccess;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\NativeTokenScope;

final class DownloadUrlsController
{
    public function __construct(private NodeJWTService $jwtService) {}

    public function __invoke(DownloadUrlsRequest $request, Server $server): JsonResponse
    {
        $user = app(ManagedTransferAccess::class)->authorize($request, $server);
        $paths = $request->validated()['paths'];
        $expiresAt = CarbonImmutable::now()->addSeconds($request->transferSettings()['signedUrlTtlSeconds']);
        $node = $server->node;
        $address = $node->getConnectionAddress();
        $signer = NativeTokenScope::apply($this->jwtService, 'download');
        $urls = [];
        foreach ($paths as $path) {
            // Native path-specific claims and one-use unique_id; no filesystem or Wings reads.
            $token = $signer->setExpiresAt($expiresAt)->setUser($user)
                ->setClaims(['file_path' => '/' . $path, 'server_uuid' => $server->uuid])
                ->handle($node, $user->id . $server->uuid);
            $urls[] = sprintf('%s/download/file?token=%s', $address, $token->toString());
        }
        return new JsonResponse(['expiresAt' => $expiresAt->toIso8601String(), 'urls' => $urls],
            200, ['Cache-Control' => 'no-store']);
    }
}
