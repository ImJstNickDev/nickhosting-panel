<?php

namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services;

use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** A global change counter: a foreign allocation can collide with a managed listener. */
final class GatewayTopology
{
    public const TABLE = 'nickhosting_gateway_topology';
    private const SOURCES = ['allocations', 'nodes', 'servers'];

    private static function mysql(): bool
    {
        return in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true);
    }

    /** InnoDB skips child triggers on cascading FKs. Watch the originating parents too. */
    private static function sources(): array
    {
        if (!self::mysql()) {
            abort_unless(DB::connection()->getDriverName() === 'sqlite', 501);
            // SQLite fires child row triggers for cascades.
            return self::SOURCES;
        }
        $tables = self::SOURCES;
        // Read FK edges once, even for a multi-level cascade.
        $edges = DB::select("SELECT TABLE_NAME AS child, REFERENCED_TABLE_NAME AS parent,
            UNIQUE_CONSTRAINT_SCHEMA AS parent_schema, DATABASE() AS local_schema
            FROM information_schema.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE()
            AND (DELETE_RULE IN ('CASCADE','SET NULL','SET DEFAULT') OR UPDATE_RULE IN ('CASCADE','SET NULL','SET DEFAULT'))");
        for ($i = 0; $i < count($tables); $i++) {
            foreach ($edges as $edge) {
                if ($edge->child !== $tables[$i]) { continue; }
                abort_unless($edge->parent_schema === $edge->local_schema
                    && preg_match('/^[a-zA-Z_][a-zA-Z_0-9]{0,63}$/D', $edge->parent), 501);
                if (!in_array($edge->parent, $tables, true)) { $tables[] = $edge->parent; }
            }
            abort_if(count($tables) > 16, 501);
        }
        sort($tables, SORT_STRING);
        return $tables;
    }

    private static function triggers(array $tables, string $epoch): array
    {
        $columns = ['allocations'=>['id','node_id','server_id','ip','port'],
            'servers'=>['id','uuid','uuidShort','external_id','node_id','owner_id','nest_id','egg_id','allocation_id','status'],
            'nodes'=>['id','uuid']];
        if (self::mysql()) {
            // Include every referenced unique key: the parent can indirectly change a tracked row.
            $references = DB::table('information_schema.KEY_COLUMN_USAGE')->whereRaw('REFERENCED_TABLE_SCHEMA = DATABASE()')
                ->whereIn('REFERENCED_TABLE_NAME',$tables)->whereIn('TABLE_NAME',$tables)
                ->get(['REFERENCED_TABLE_NAME as parent','REFERENCED_COLUMN_NAME as field']);
            foreach ($references as $ref) {
                abort_unless(preg_match('/^[a-zA-Z_][a-zA-Z_0-9]{0,63}$/D', $ref->field), 501);
                $columns[$ref->parent][] = $ref->field;
            }
        }
        $triggers = [];
        foreach ($tables as $table) {
            foreach (['INSERT','UPDATE','DELETE'] as $event) {
                if ($event === 'INSERT' && !in_array($table, self::SOURCES, true)) { continue; }
                $name = 'nh_gw_' . substr(hash('sha256', $epoch . ':' . $table . ':' . $event), 0, 24);
                $body = "UPDATE " . self::TABLE . " SET revision = revision + 1 WHERE id = 1 AND enabled = 1 AND epoch = '$epoch'";
                $when = '';
                if ($event === 'UPDATE') {
                    $fields = array_unique($columns[$table] ?? []);
                    sort($fields, SORT_STRING);
                    abort_unless($fields, 501);
                    $differences = array_map(static fn ($field) => self::mysql()
                        ? "NOT (BINARY OLD.`$field` <=> BINARY NEW.`$field`)" : "OLD.`$field` IS NOT NEW.`$field`", $fields);
                    $test = implode(' OR ', $differences);
                    if (self::mysql()) { $body = "BEGIN IF $test THEN $body; END IF; END"; }
                    else { $when = "WHEN $test "; }
                }
                $statement = self::mysql() ? $body : "BEGIN $body; END";
                $triggers[$name] = [$table, $event, $statement, "CREATE TRIGGER `$name` AFTER $event ON `$table` FOR EACH ROW $when$statement"];
            }
        }
        return $triggers;
    }

    /** Called only by the extension's migration. Disabled/partial installs serve the v1 full read. */
    public static function install(): void
    {
        $existing = DB::table(self::TABLE)->where('id', 1)->first();
        if ($existing?->enabled) { return; }
        if ($existing) { self::uninstall(); }
        $epoch = (string) Str::uuid();
        $tables = self::sources();
        $triggers = self::triggers($tables, $epoch);
        DB::table(self::TABLE)->updateOrInsert(['id'=>1], ['epoch'=>$epoch, 'revision'=>1, 'enabled'=>false,
            'sources'=>json_encode($tables, JSON_THROW_ON_ERROR), 'definitions'=>json_encode($triggers, JSON_THROW_ON_ERROR)]);
        foreach ($triggers as [, , , $sql]) { DB::unprepared($sql); }
        DB::table(self::TABLE)->where('id', 1)->update(['enabled'=>true]);
    }

    public static function uninstall(): void
    {
        $row = DB::table(self::TABLE)->where('id', 1)->first();
        if (!$row) { return; }
        DB::table(self::TABLE)->where('id', 1)->update(['enabled'=>false]);
        $expected = json_decode($row->definitions, true, 16, JSON_THROW_ON_ERROR);
        // A name alone does not prove ownership of a native trigger. In particular, a
        // failed CREATE or an administrator replacing one must not authorize its DROP.
        foreach (self::installed($expected) as $trigger) {
            if (self::owned($trigger, $expected)) {
                DB::unprepared("DROP TRIGGER IF EXISTS `$trigger->name`");
            }
        }
    }

    private static function installed(array $expected)
    {
        if (self::mysql()) {
            return DB::table('information_schema.TRIGGERS')->whereRaw('TRIGGER_SCHEMA = DATABASE()')
                ->whereIn('TRIGGER_NAME', array_keys($expected))->get(
                    ['TRIGGER_NAME as name', 'ACTION_TIMING as timing', 'EVENT_MANIPULATION as event',
                        'EVENT_OBJECT_TABLE as source', 'ACTION_STATEMENT as body']);
        }
        return DB::table('sqlite_master')->where('type','trigger')->whereIn('name', array_keys($expected))->get();
    }

    private static function owned(object $trigger, array $expected): bool
    {
        return self::mysql() ? $trigger->timing === 'AFTER'
            && array_slice($expected[$trigger->name], 0, 3) === [$trigger->source, $trigger->event, $trigger->body]
            : $trigger->sql === $expected[$trigger->name][3];
    }

    private static function row(bool $sources = false): object
    {
        $fields = $sources ? ['epoch','revision','enabled','sources'] : ['epoch','revision','enabled'];
        try {
            $row = DB::table(self::TABLE)->useWritePdo()->where('id', 1)->first($fields);
        } catch (\Illuminate\Database\QueryException $error) {
            // New PHP can precede its extension migration during a rolling update.
            if ($error->getCode() === '42S02' || (DB::connection()->getDriverName() === 'sqlite'
                && str_contains($error->getMessage(), 'no such table: ' . self::TABLE))) { abort(501); }
            throw $error;
        }
        abort_unless($row && $row->enabled && Str::isUuid($row->epoch), 501);
        return $row;
    }

    /** Must run inside the same repeatable-read transaction as the asserted inventory. */
    public static function receipt(): array
    {
        $row = self::row(true);
        $tables = self::sources();
        abort_unless($tables === json_decode($row->sources, true, 16, JSON_THROW_ON_ERROR), 501);
        $expected = self::triggers($tables, $row->epoch);
        if (self::mysql()) {
            $engines = DB::table('information_schema.TABLES')->whereRaw('TABLE_SCHEMA = DATABASE()')
                ->whereIn('TABLE_NAME', array_merge($tables, [self::TABLE]))->pluck('ENGINE');
            abort_unless(count($engines) === count($tables) + 1 && $engines->every(fn ($engine) => $engine === 'InnoDB'), 501);
        }
        $installed = self::installed($expected);
        foreach ($installed as $trigger) { abort_unless(self::owned($trigger, $expected), 501); }
        abort_unless(count($installed) === count($expected), 501);
        return ['epoch'=>$row->epoch, 'revision'=>(string)$row->revision];
    }

    /** A single primary-key read each tick. Recheck schema coverage and ACL before returning. */
    public static function wait(string $epoch, string $revision, int $waitMs, array $nodeIds, array $serverUuids): array
    {
        $started = hrtime(true);
        $deadline = $started + $waitMs * 1000000;
        if ($waitMs) {
            do {
                $row = self::row();
                if ($row->epoch !== $epoch || (string)$row->revision !== $revision || connection_aborted()) { return ['changed'=>true]; }
                $remaining = $deadline - hrtime(true);
                if ($remaining <= 0) { break; }
                usleep((int)min(350000, ceil($remaining / 1000)));
            } while (true);
        }
        $waitedMs = min($waitMs, intdiv(hrtime(true) - $started, 1000000));
        // Recompute the scoped digest even when the counter is identical. TRUNCATE,
        // restored databases and DDL bypass native row triggers on InnoDB.
        return (new GatewayInventory())->read($nodeIds, $serverUuids, true, true) + ['waitedMs'=>$waitedMs];
    }
}
