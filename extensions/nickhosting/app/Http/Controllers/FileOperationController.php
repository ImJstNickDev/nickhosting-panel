<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Pterodactyl\Models\Server;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\FileInspectionRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\GuardedDeleteRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\TransferSettingsRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\FileOperationRepository;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\ManagedTransferAccess;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Protocol;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

final class FileOperationController
{
    public function __construct(private FileOperationRepository $files) {}

    public function capabilities(TransferSettingsRequest $request, Server $server): JsonResponse
    {
        app(ManagedTransferAccess::class)->authorize($request, $server);
        return $this->response(['inspection' => true, 'guardedDelete' => true, 'archiveCommit' => true]);
    }

    public function inspect(FileInspectionRequest $request, Server $server): JsonResponse
    {
        app(ManagedTransferAccess::class)->authorize($request, $server);
        $input = $request->validated();
        $snapshot = $this->files->setServer($server)->inspect($input['target'], $input['guardFile']);
        return $this->response(['identity' => Protocol::identity($server)] + $snapshot);
    }

    public function delete(GuardedDeleteRequest $request, Server $server): JsonResponse
    {
        $owner = app(ManagedTransferAccess::class)->authorize($request, $server);
        $input = $request->validated();
        $identity = Protocol::identity($server);
        foreach ($identity as $key => $value) { abort_unless(($input['identity'][$key] ?? null) === $value, 409); }
        $target = ['path' => $input['target']['path'], 'observation' => $input['target']['observation']];
        $guard = ['path' => $input['guard']['path'], 'sha256' => $input['guard']['sha256']];
        abort_if($guard['path'] === $target['path'] || str_starts_with($guard['path'], $target['path'] . '/'), 422);
        $fingerprint = hash('sha256', json_encode(['delete', $identity, $target, $guard], JSON_THROW_ON_ERROR));
        $operation = DB::table('nickhosting_file_operations')->where('operation_id', $input['operationId']);
        $created = DB::table('nickhosting_file_operations')->insertOrIgnore([
            'operation_id' => $input['operationId'], 'server_uuid' => $server->uuid, 'owner_id' => $owner->id,
            'fingerprint' => $fingerprint, 'state' => 'prepared', 'created_at' => now(), 'updated_at' => now(),
        ]);
        $receipt = ['operationId' => $input['operationId'], 'state' => 'uncertain', 'identity' => $identity, 'target' => $target];
        if (!$created) {
            $row = $operation->first();
            abort_unless($row && $row->server_uuid === $server->uuid && $row->owner_id === $owner->id
                && hash_equals($row->fingerprint, $fingerprint), 409);
            if ($row->state === 'rejected') { abort($row->rejection_status ?? 409); }
            if ($row->state === 'confirmed') { $receipt['state'] = 'confirmed'; }
            // Prepared/sent/uncertain all fail closed: never repeat an external deletion.
            return $this->response($receipt);
        }
        try {
            $observed = $this->files->setServer($server)->inspect($target['path'], $guard['path']);
            abort_unless(hash_equals($target['observation'], $observed['target']['observation'])
                && hash_equals($guard['sha256'], $observed['guard']['sha256']), 409);
        } catch (\Throwable $error) {
            $status = $error instanceof HttpExceptionInterface ? $error->getStatusCode() : 502;
            $operation->update(['state' => 'rejected', 'rejection_status' => $status, 'updated_at' => now()]);
            abort($status);
        }
        // Commit dispatch intent before the request. No remote I/O holds a DB transaction open.
        $operation->update(['state' => 'sent', 'updated_at' => now()]);
        try {
            $this->files->deleteDirectory($target['path']);
        } catch (\Throwable $error) {
            $operation->update(['state' => 'uncertain', 'updated_at' => now()]);
            return $this->response($receipt);
        }
        $operation->update(['state' => 'confirmed', 'updated_at' => now()]);
        $receipt['state'] = 'confirmed';
        return $this->response($receipt);
    }

    private function response(array $data): JsonResponse
    {
        return new JsonResponse($data, 200, ['Cache-Control' => 'no-store']);
    }
}
