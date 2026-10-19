<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Pterodactyl\Models\Server;
use Pterodactyl\Services\Nodes\NodeJWTService;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\InstallationWebsocketRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\ManagedTransferAccess;

final class InstallationWebsocketController
{
    public function __construct(private NodeJWTService $jwtService) {}

    public function __invoke(InstallationWebsocketRequest $request, Server $server): JsonResponse
    {
        $user = app(ManagedTransferAccess::class)->authorize($request, $server);
        $node = $server->node;
        // Installation is the sole exception to the native current-state gate.
        // No command, power, files, transfer or wildcard permissions. websocket.connect
        // also allows ordinary output in Wings; the backend relay filters it out.
        abort_if($server->isSuspended() || $node->isUnderMaintenance()
            || $server->status === Server::STATUS_RESTORING_BACKUP || !is_null($server->transfer), 409);
        $token = $this->jwtService->setExpiresAt(CarbonImmutable::now()->addMinutes(10))
            ->setUser($user)->setClaims(['server_uuid' => $server->uuid,
                'permissions' => ['websocket.connect', 'admin.websocket.install']])
            ->handle($node, $user->id . $server->uuid);
        $socket = str_replace(['https://', 'http://'], ['wss://', 'ws://'], $node->getConnectionAddress());
        return new JsonResponse(['data' => ['token' => $token->toString(),
            'socket' => $socket . sprintf('/api/servers/%s/ws', $server->uuid)]],
            200, ['Cache-Control' => 'no-store']);
    }
}
