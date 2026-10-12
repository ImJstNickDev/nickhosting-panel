<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Pterodactyl\Models\Server;
use Pterodactyl\Services\Nodes\NodeJWTService;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\UploadUrlsRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Protocol;

final class UploadUrlsController
{
    public function __construct(private NodeJWTService $jwtService) {}

    public function __invoke(UploadUrlsRequest $request, Server $server): JsonResponse
    {
        $user = $request->user();
        // NickHosting dispatches Client operations through the registered server owner's key.
        abort_unless($user && !$user->root_admin && $user->id === $server->owner_id, 403);
        $link = DB::table('nickhosting_servers')->where('uuid', $server->uuid)->first();
        abort_unless($link, 403);
        abort_unless($link->valid && $link->server_id === $server->id
            && $link->owner_id === $server->owner_id
            && json_decode($link->identity, true, 512, JSON_THROW_ON_ERROR) === Protocol::identity($server), 409);
        $owner = DB::table('nickhosting_users')->where('instance_id', $link->instance_id)
            ->where('provider_id', $user->id)->first();
        abort_unless($owner && $owner->provider_uuid === $user->uuid
            && $owner->external_id === $user->external_id, 409);

        $count = $request->validated()['count'];
        $expiresAt = CarbonImmutable::now()->addMinutes(15);
        $node = $server->node;
        $urls = [];
        for ($i = 0; $i < $count; $i++) {
            // Native signing supplies a distinct unique_id consumed once by Wings.
            $token = $this->jwtService->setExpiresAt($expiresAt)->setUser($user)
                ->setClaims(['server_uuid' => $server->uuid])->handle($node, $user->id . $server->uuid);
            $urls[] = sprintf('%s/upload/file?token=%s', $node->getConnectionAddress(), $token->toString());
        }

        return new JsonResponse(['expiresAt' => $expiresAt->toIso8601String(), 'urls' => $urls],
            200, ['Cache-Control' => 'no-store']);
    }
}
