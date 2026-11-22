<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Pterodactyl\Models\Server;
use Pterodactyl\Models\User;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\WorldScanAccess;
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
        return new JsonResponse($this->sign($user, $server, $request->validated()['paths'],
            $request->transferSettings()['signedUrlTtlSeconds']), 200, ['Cache-Control' => 'no-store']);
    }

    public function worlds(DownloadUrlsRequest $request, Server $server): JsonResponse
    {
        $user = app(WorldScanAccess::class)->authorize($request, $server);
        $paths = $request->validated()['paths'];
        foreach ($paths as $path) { abort_unless(preg_match('~^[^/]+/level[.]dat$~D', $path), 422); }
        return new JsonResponse($this->sign($user, $server, $paths, $request->transferSettings()['signedUrlTtlSeconds']),
            200, ['Cache-Control' => 'no-store']);
    }

    public function sign(User $user, Server $server, array $paths, int $seconds): array
    {
        $expiresAt = CarbonImmutable::now()->addSeconds($seconds);
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
        return ['expiresAt' => $expiresAt->toIso8601String(), 'urls' => $urls];
    }
}
