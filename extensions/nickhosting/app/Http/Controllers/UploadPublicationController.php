<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers;

use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;
use Pterodactyl\Models\Server;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Requests\UploadPublicationRequest;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\FileOperationRepository;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\ManagedTransferAccess;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Protocol;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;

final class UploadPublicationController
{
    public function __construct(private FileOperationRepository $files) {}

    public function __invoke(UploadPublicationRequest $request, Server $server): JsonResponse
    {
        $owner = app(ManagedTransferAccess::class)->authorize($request, $server);
        $input = $request->validated();
        $identity = Protocol::identity($server);
        foreach ($identity as $key => $value) { abort_unless(($input['identity'][$key] ?? null) === $value, 409); }
        $parent = dirname($input['source']);
        $recovery = ['schemaVersion' => 1, 'kind' => 'upload-publication', 'source' => $input['source'],
            'destination' => $input['destination'],
            'backup' => ($parent === '.' ? '' : $parent . '/') . '.nh-upload-' . $input['operationId'] . '.previous'];
        $fingerprint = hash('sha256', json_encode(['upload', $identity, $input['source'], $input['destination']], JSON_THROW_ON_ERROR));
        $operation = DB::table('nickhosting_file_operations')->where('operation_id', $input['operationId']);
        $created = DB::table('nickhosting_file_operations')->insertOrIgnore([
            'operation_id' => $input['operationId'], 'server_uuid' => $server->uuid, 'owner_id' => $owner->id,
            'fingerprint' => $fingerprint, 'state' => 'prepared', 'created_at' => now(), 'updated_at' => now(),
            'recovery_context' => json_encode($recovery, JSON_THROW_ON_ERROR),
        ]);
        $receipt = ['operationId' => $input['operationId'], 'state' => 'uncertain', 'identity' => $identity, 'destination' => $input['destination']];
        if (!$created) {
            $row = $operation->first();
            abort_unless($row && $row->server_uuid === $server->uuid && $row->owner_id === $owner->id
                && hash_equals($row->fingerprint, $fingerprint), 409);
            if ($row->state === 'rejected') { abort($row->rejection_status ?? 409); }
            if ($row->state === 'confirmed') { $receipt['state'] = 'confirmed'; }
            // A crashed or unknown publication is never repeated or rolled back blindly.
            return $this->response($receipt);
        }
        $dispatched = false;
        try {
            $this->files->setServer($server)->publishUpload($input['operationId'], $input['source'], $input['destination'],
                function (array $observations) use ($operation, $recovery, &$dispatched) {
                    $operation->update(['state' => 'sent', 'updated_at' => now(),
                        'recovery_context' => json_encode($recovery + $observations, JSON_THROW_ON_ERROR)]);
                    $dispatched = true;
                }, function () use ($operation, &$receipt) {
                    // Persist publication before best-effort backup cleanup. A crash may
                    // leave the old bytes, but must not turn a confirmed publish into retry.
                    $operation->update(['state' => 'confirmed', 'updated_at' => now()]);
                    $receipt['state'] = 'confirmed';
                });
        } catch (\Throwable $error) {
            if (!$dispatched) {
                $status = $error instanceof HttpExceptionInterface ? $error->getStatusCode() : 502;
                $operation->update(['state' => 'rejected', 'rejection_status' => $status, 'updated_at' => now()]);
                abort($status);
            }
            $operation->update(['state' => 'uncertain', 'updated_at' => now()]);
        }
        return $this->response($receipt);
    }

    private function response(array $receipt): JsonResponse
    {
        return new JsonResponse($receipt, 200, ['Cache-Control' => 'no-store']);
    }
}
