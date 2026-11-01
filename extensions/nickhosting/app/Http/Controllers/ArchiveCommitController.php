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
        // Serialize the original request and every reconciliation on this exact
        // connection. A transaction spanning Wings could roll back 'sent' after
        // a process crash and incorrectly authorize extraction for a second time.
        $connection = DB::connection();
        $pdo = $connection->getPdo();
        $table = $connection->getQueryGrammar()->wrapTable('nickhosting_file_operations');
        $lockName = 'nickhosting-archive-' . strtolower($input['operationId']);
        $lock = $pdo->prepare('SELECT GET_LOCK(?, 0)');
        $lock->execute([$lockName]);
        abort_unless((int) $lock->fetchColumn() === 1, 409);
        try {
            $assertLock = function () use ($pdo, $lockName) {
                // Laravel may reconnect a lost DB connection. Never let that
                // silently replace the connection that owns our provider lock.
                $owned = $pdo->prepare('SELECT IS_USED_LOCK(?) = CONNECTION_ID()');
                $owned->execute([$lockName]);
                abort_unless((int) $owned->fetchColumn() === 1, 409);
            };
            $save = function (array $values) use ($pdo, $table, $lockName, $input, $assertLock) {
                $assertLock();
                $columns = array_keys($values);
                foreach ($columns as $column) { abort_unless(in_array($column, ['state', 'updated_at', 'rejection_status', 'recovery_context'], true), 500); }
                // Use the pinned PDO: Laravel's automatic reconnect must not
                // write a receipt on a replacement connection without its lock.
                $statement = $pdo->prepare('UPDATE ' . $table . ' SET '
                    . implode(', ', array_map(fn ($column) => '`' . $column . '` = ?', $columns))
                    . ' WHERE operation_id = ? AND IS_USED_LOCK(?) = CONNECTION_ID()');
                $statement->execute([...array_values($values), $input['operationId'], $lockName]);
                if ($statement->rowCount() !== 1) {
                    // MySQL reports changed rows: an identical dispatch marker
                    // in the same second can legitimately update zero rows.
                    $verify = $pdo->prepare('SELECT ' . implode(', ', array_map(fn ($column) => '`' . $column . '`', $columns))
                        . ' FROM ' . $table . ' WHERE operation_id = ? AND IS_USED_LOCK(?) = CONNECTION_ID()');
                    $verify->execute([$input['operationId'], $lockName]);
                    $stored = $verify->fetch(\PDO::FETCH_ASSOC);
                    abort_unless(is_array($stored), 409);
                    foreach ($values as $column => $value) {
                        abort_unless($column === 'recovery_context'
                            ? json_decode($stored[$column], true, 16, JSON_THROW_ON_ERROR) == json_decode($value, true, 16, JSON_THROW_ON_ERROR)
                            : (string) $stored[$column] === (string) $value, 409);
                    }
                }
            };
            return $this->commit($request, $server, $owner->id, $input, $identity, $manifest, $fingerprint, $assertLock, $save);
        } finally {
            try {
                $release = $pdo->prepare('SELECT RELEASE_LOCK(?)');
                $release->execute([$lockName]);
            } catch (\Throwable $error) { /* A lost connection releases its own advisory locks. */ }
        }
    }

    private function commit(ArchiveCommitRequest $request, Server $server, int $ownerId, array $input, array $identity, array $manifest, string $fingerprint, callable $assertLock, callable $save): JsonResponse
    {
        $operation = DB::table('nickhosting_file_operations')->where('operation_id', $input['operationId']);
        $created = DB::table('nickhosting_file_operations')->insertOrIgnore([
            'operation_id' => $input['operationId'], 'server_uuid' => $server->uuid, 'owner_id' => $ownerId,
            'fingerprint' => $fingerprint, 'state' => 'prepared', 'created_at' => now(), 'updated_at' => now(),
        ]);
        $receipt = ['operationId' => $input['operationId'], 'state' => 'uncertain', 'identity' => $identity,
            'destinationRoot' => $input['destinationRoot'], 'archiveSha256' => $input['archiveSha256']];
        if (!$created) {
            $row = $operation->first();
            abort_unless($row && $row->server_uuid === $server->uuid && $row->owner_id === $ownerId
                && hash_equals($row->fingerprint, $fingerprint), 409);
            if ($row->state === 'rejected') { abort($row->rejection_status ?? 409); }
            if ($row->state === 'confirmed') { $receipt['state'] = 'confirmed'; }
            if (!in_array($row->state, ['sent', 'uncertain'], true)) {
                return new JsonResponse($receipt, 200, ['Cache-Control' => 'no-store']);
            }
        }
        $dispatched = !$created;
        // Explicit backend diagnostics only; never part of the durable operation fingerprint.
        $timings = [];
        $trace = ($input['trace'] ?? false) === true ? static function (string $stage, float $durationMs) use (&$timings) {
            $timings[$stage] = round($durationMs, 3);
        } : null;
        try {
            $beforeWrite = function (string $phase, array $payload) use ($save, &$dispatched, $assertLock, $request, $server) {
                $assertLock();
                app(ManagedTransferAccess::class)->authorize($request, $server);
                $save(['state' => 'sent', 'updated_at' => now()->toDateTimeString(), 'recovery_context' => json_encode([
                    'schemaVersion' => 1, 'kind' => 'archive', 'phase' => $phase, 'payload' => $payload,
                ], JSON_THROW_ON_ERROR)]);
                $assertLock();
                $dispatched = true;
            };
            if ($created) {
                $this->files->setServer($server)->commitArchive($input['operationId'], $input['destinationRoot'], $manifest, $beforeWrite, $trace);
            } else {
                $recovery = $row->recovery_context === null ? null : json_decode($row->recovery_context, true, 16, JSON_THROW_ON_ERROR);
                $this->files->setServer($server)->recoverArchive($input['operationId'], $input['destinationRoot'], $manifest, $recovery, $beforeWrite, $trace);
            }
            $assertLock();
        } catch (\Throwable $error) {
            if (!$dispatched) {
                $status = $error instanceof \Symfony\Component\HttpKernel\Exception\HttpExceptionInterface ? $error->getStatusCode() : 502;
                try { $save(['state' => 'rejected', 'rejection_status' => $status, 'updated_at' => now()->toDateTimeString()]); }
                catch (\Throwable $lostLock) { /* Preserve a receipt owned by a newer request. */ }
                abort($status);
            }
            try { $save(['state' => 'uncertain', 'updated_at' => now()->toDateTimeString()]); }
            catch (\Throwable $lostLock) { /* Preserve a receipt owned by a newer request. */ }
            if ($trace !== null) { $receipt['timings'] = $timings; }
            return new JsonResponse($receipt, 200, ['Cache-Control' => 'no-store']);
        }
        $save(['state' => 'confirmed', 'updated_at' => now()->toDateTimeString()]);
        $receipt['state'] = 'confirmed';
        if ($trace !== null) { $receipt['timings'] = $timings; }
        return new JsonResponse($receipt, 200, ['Cache-Control' => 'no-store']);
    }
}
