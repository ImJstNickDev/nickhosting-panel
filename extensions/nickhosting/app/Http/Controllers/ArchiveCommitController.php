<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Pterodactyl\Models\Server;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\ArchiveCommitRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\FileOperationRepository;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\ManagedTransferAccess;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Protocol;

final class ArchiveCommitController
{
    public function __construct(private FileOperationRepository $files) {}
    public function __invoke(ArchiveCommitRequest $request, Server $server): JsonResponse
    {
        $owner = app(ManagedTransferAccess::class)->authorize($request, $server);
        $input = $request->validated();
        $identity = Protocol::identity($server);
        foreach ($identity as $key => $value) { abort_unless(($input['identity'][$key] ?? null) === $value, 409); }
        $manifest = array_map(fn ($file) => ['path' => $file['path'], 'size' => $file['size']], $input['files']);
        usort($manifest, fn ($a, $b) => strcmp($a['path'], $b['path']));
        $fingerprint = hash('sha256', json_encode(['archive', $identity, $input['destinationRoot'], $input['archiveSha256'], $manifest], JSON_THROW_ON_ERROR));
        $operation = DB::table('nickhosting_file_operations')->where('operation_id', $input['operationId']);
        $created = DB::table('nickhosting_file_operations')->insertOrIgnore([
            'operation_id' => $input['operationId'], 'server_uuid' => $server->uuid, 'owner_id' => $owner->id,
            'fingerprint' => $fingerprint, 'state' => 'prepared', 'created_at' => now(), 'updated_at' => now(),
        ]);
        $receipt = ['operationId' => $input['operationId'], 'state' => 'uncertain', 'identity' => $identity,
            'destinationRoot' => $input['destinationRoot'], 'archiveSha256' => $input['archiveSha256']];
        if (!$created) {
            $row = $operation->first();
            abort_unless($row && $row->server_uuid === $server->uuid && $row->owner_id === $owner->id
                && hash_equals($row->fingerprint, $fingerprint), 409);
            if ($row->state === 'rejected') { abort($row->rejection_status ?? 409); }
            if ($row->state === 'confirmed') { $receipt['state'] = 'confirmed'; }
            return new JsonResponse($receipt, 200, ['Cache-Control' => 'no-store']);
        }
        $dispatched = false;
        // Explicit backend diagnostics only; never part of the durable operation fingerprint.
        $timings = [];
        $trace = ($input['trace'] ?? false) === true ? static function (string $stage, float $durationMs) use (&$timings) {
            $timings[$stage] = round($durationMs, 3);
        } : null;
        try {
            $this->files->setServer($server)->commitArchive($input['operationId'], $input['destinationRoot'], $manifest, function () use ($operation, &$dispatched) {
                $operation->update(['state' => 'sent', 'updated_at' => now()]);
                $dispatched = true;
            }, $trace);
        } catch (\Throwable $error) {
            if (!$dispatched) {
                $status = $error instanceof \Symfony\Component\HttpKernel\Exception\HttpExceptionInterface ? $error->getStatusCode() : 502;
                $operation->update(['state' => 'rejected', 'rejection_status' => $status, 'updated_at' => now()]);
                abort($status);
            }
            $operation->update(['state' => 'uncertain', 'updated_at' => now()]);
            if ($trace !== null) { $receipt['timings'] = $timings; }
            return new JsonResponse($receipt, 200, ['Cache-Control' => 'no-store']);
        }
        $operation->update(['state' => 'confirmed', 'updated_at' => now()]);
        $receipt['state'] = 'confirmed';
        if ($trace !== null) { $receipt['timings'] = $timings; }
        return new JsonResponse($receipt, 200, ['Cache-Control' => 'no-store']);
    }
}
