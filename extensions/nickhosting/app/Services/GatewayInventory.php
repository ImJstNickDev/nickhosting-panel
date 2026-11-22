<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use Illuminate\Support\Facades\DB;
use Pterodactyl\Models\Server;

final class GatewayInventory
{
    public static function transaction(callable $read): array
    {
        // The three sets of rows must describe one instant, even when the Panel's
        // connection default is READ COMMITTED. SET TRANSACTION is one-shot.
        $connection = DB::connection();
        if (in_array($connection->getDriverName(), ['mysql', 'mariadb'], true)) {
            abort_if($connection->transactionLevel() !== 0, 503);
            $connection->statement('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        } else {
            abort_unless($connection->getDriverName() === 'sqlite', 503);
        }

        return $connection->transaction($read);
    }

    public function read(array $nodeIds, array $serverUuids, bool $versioned = false, bool $receiptOnly = false): array
    {
        return self::transaction(function () use ($nodeIds, $serverUuids, $versioned, $receiptOnly) {
            $receipt = $versioned ? GatewayTopology::receipt() : null;
            $hash = $versioned ? hash_init('sha256') : null;
            if ($hash) {
                sort($nodeIds, SORT_NUMERIC);
                sort($serverUuids, SORT_STRING);
                hash_update($hash, json_encode([$nodeIds, $serverUuids], JSON_THROW_ON_ERROR)."\n");
            }
            $nodes = DB::table('nodes')->orderBy('id')->limit(10001)->get(['id', 'uuid']);
            abort_if($nodes->count() > 10000, 413);
            abort_if(array_diff($nodeIds, $nodes->pluck('id')->all()), 409);
            if ($hash) { foreach ($nodes as $node) { hash_update($hash, json_encode($node, JSON_THROW_ON_ERROR)."\n"); } }
            $groups = [];
            foreach ($nodeIds as $id) {
                $groups[$id] = ['nodeId' => $id, 'allocations' => []];
            }

            $servers = [];
            $rows = DB::table('servers')->whereIn('uuid', $serverUuids)->orderBy('id')
                ->limit(count($serverUuids) + 1)
                ->get(['id', 'uuid', 'uuidShort', 'external_id', 'node_id', 'owner_id',
                    'nest_id', 'egg_id', 'allocation_id', 'status']);
            abort_if($rows->count() !== count($serverUuids)
                || array_diff($serverUuids, $rows->pluck('uuid')->all()), 409);
            foreach ($rows as $row) {
                if ($hash) { hash_update($hash, json_encode($row, JSON_THROW_ON_ERROR)."\n"); }
                if ($receiptOnly) { $servers[$row->id] = true; continue; }
                $servers[$row->id] = ['id' => (int) $row->id, 'uuid' => $row->uuid,
                    'identifier' => $row->uuidShort, 'external_id' => $row->external_id,
                    'user' => (int) $row->owner_id, 'node' => (int) $row->node_id,
                    'nest' => (int) $row->nest_id, 'egg' => (int) $row->egg_id,
                    'allocation' => (int) $row->allocation_id,
                    'suspended' => $row->status === Server::STATUS_SUSPENDED,
                    'relationships' => ['allocations' => ['object' => 'list', 'data' => []]]];
            }

            // All claims on selected servers, even outside the policy. All
            // allocations on policy nodes, even if occupied by another tenant.
            $allocations = DB::table('allocations')->whereIn('node_id', $nodeIds)
                ->orWhereIn('server_id', array_keys($servers))->orderBy('id')->limit(65537)
                ->select(['id', 'ip', 'port', 'node_id', 'server_id'])->cursor();
            foreach ($allocations as $offset => $row) {
                abort_if($offset >= 65536, 413);
                if ($hash) { hash_update($hash, json_encode($row, JSON_THROW_ON_ERROR)."\n"); }
                if ($receiptOnly) { continue; }
                $entry = ['id' => (int) $row->id, 'ip' => $row->ip,
                    'port' => (int) $row->port, 'assigned' => $row->server_id !== null];
                if (isset($groups[$row->node_id])) {
                    $groups[$row->node_id]['allocations'][] = $entry;
                }
                if (isset($servers[$row->server_id])) {
                    abort_if($servers[$row->server_id]['node'] !== (int) $row->node_id, 409);
                    $servers[$row->server_id]['relationships']['allocations']['data'][] = ['attributes' => $entry];
                }
            }
            if ($hash) { $receipt['digest'] = hash_final($hash); }
            if ($receiptOnly) { return $receipt; }
            return ($receipt ? ['receipt'=>$receipt] : []) + ['schemaVersion' => 1, 'nodes' => $nodes->map(static fn ($row) =>
                ['id' => (int) $row->id, 'uuid' => $row->uuid])->all(),
                'allocations' => array_values($groups), 'servers' => array_values($servers)];
        });
    }
}
