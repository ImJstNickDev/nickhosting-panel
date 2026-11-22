<?php
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

Schema::table('servers', function ($table) {
    foreach (['allocation_id', 'nest_id', 'egg_id'] as $field) { $table->integer($field)->default(1); }
});
Schema::create('nodes', function ($table) { $table->integer('id')->primary(); $table->uuid('uuid'); });
Schema::create('allocations', function ($table) {
    $table->integer('id')->primary(); $table->integer('node_id'); $table->integer('server_id')->nullable();
    $table->string('ip'); $table->integer('port');
});
$discover = static function (string $query) {
    $request = \Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Requests\CapabilitiesRequest::create('/capabilities'.$query, 'GET');
    return (new \Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\CapabilitiesController())($request)->getData(true);
};
$legacy = $discover('');
check($legacy['capabilities'] === array_fill_keys(['clientKeyManagement', 'technicalAccounts', 'serverChangeEvents',
    'backupEvents', 'installationEvents', 'installationConsole', 'fileOperations',
    'bulkUploadUrls', 'bulkDownloadUrls', 'bulkDirectoryListings'], true),
    'capability discovery preserves the strict legacy property set');
check($discover('?inventory=0') === $legacy, 'capability discovery requires explicit inventory opt-in');
$negotiated = $discover('?inventory=1');
$expected = $legacy;
$expected['capabilities'] += ['gatewayInventory'=>true, 'linkedServerSnapshots'=>true];
check($negotiated === $expected, 'negotiated discovery adds exactly both new flags to the same envelope');

$controller = new \Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\BridgeController();
$fixtureUuid = static fn (int $i) => sprintf('10101010-2020-4030-8040-%012d', $i);
$inventoryRequest = static function (array $data, int $node = 1, int $allocation = 1) {
    $request = req($data, 'POST', 2, 1);
    $key = $request->user()->currentAccessToken();
    $key->r_nodes = $node;
    $key->r_allocations = $allocation;
    return $request;
};
$instanceId = $fixtureUuid(700);
DB::table('nickhosting_instances')->insert([
    'id'=>$instanceId, 'api_key_id'=>1, 'secret'=>'in-memory', 'callback_url'=>'https://review.example',
    'created_at'=>now(), 'updated_at'=>now(),
]);
$native = $links = $uuids = [];
for ($i = 1; $i <= 101; $i++) {
    $id = $i + 1000; $uuid = $fixtureUuid($id);
    $row = ['id'=>$id,'uuid'=>$uuid,'uuidShort'=>substr(md5((string) $id),0,8),'external_id'=>"fixture-$id",
        'node_id'=>10,'owner_id'=>1,'allocation_id'=>$id,'nest_id'=>2,'egg_id'=>4,
        'memory'=>2048,'swap'=>0,'disk'=>4096,'io'=>500,'cpu'=>100,'threads'=>null,'status'=>null];
    $native[] = $row;
    $links[] = ['uuid'=>$uuid, 'instance_id'=>$i <= 100 ? $instanceId : $fixtureUuid(701),
        'server_id'=>$id, 'owner_id'=>1, 'identity'=>json_encode(\Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\Protocol::identity((object) $row)),
        'limits'=>json_encode(\Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\Protocol::limits((object) $row)),
        'revision'=>1, 'valid'=>true, 'created_at'=>now(), 'updated_at'=>now()];
    if ($i <= 100) { $uuids[] = $uuid; }
}
DB::table('servers')->insert($native);
DB::table('nickhosting_servers')->insert($links);
DB::table('nodes')->insert(array_map(fn ($id) => ['id'=>$id, 'uuid'=>$fixtureUuid($id)], [10,20,30]));
$alloc = fn ($id,$node,$server) => ['id'=>$id,'node_id'=>$node,'server_id'=>$server,'ip'=>'127.0.0.1','port'=>24000+$id];
DB::table('allocations')->insert([$alloc(1001,10,1001),$alloc(2001,10,1001),$alloc(2002,10,null),
    $alloc(2003,10,1101),$alloc(2004,20,1101)]);

$scope = ['nodeIds'=>[10,30], 'serverUuids'=>[$uuids[0]]];
denied(fn () => $controller->gatewayInventory(req($scope, 'POST', 1)),403,'inventory disallows Client token');
denied(fn () => $controller->gatewayInventory($inventoryRequest($scope,0)),403,'inventory requires nodes READ');
denied(fn () => $controller->gatewayInventory($inventoryRequest($scope,1,0)),403,'inventory requires allocations READ');
denied(fn () => $controller->gatewayInventory($inventoryRequest($scope + ['extra'=>true])),422,'inventory rejects unrelated selectors');
denied(fn () => $controller->gatewayInventory($inventoryRequest(['nodeIds'=>[10,10], 'serverUuids'=>[]])),422,'inventory rejects duplicate policy nodes');
denied(fn () => $controller->gatewayInventory($inventoryRequest(['nodeIds'=>[], 'serverUuids'=>[$uuids[0],$uuids[0]]])),422,'inventory rejects duplicate identities');
denied(fn () => $controller->gatewayInventory($inventoryRequest(['nodeIds'=>range(1,257),'serverUuids'=>[]])),422,'inventory rejects excessive node scope');
denied(fn () => $controller->gatewayInventory($inventoryRequest(['nodeIds'=>[40],'serverUuids'=>[]])),409,'missing policy node rejects entire inventory');
denied(fn () => $controller->gatewayInventory($inventoryRequest(['nodeIds'=>[10],'serverUuids'=>[$uuids[0],$fixtureUuid(99)]])),409,'missing requested identity rejects entire inventory');
DB::enableQueryLog();
DB::flushQueryLog();
$result = $controller->gatewayInventory($inventoryRequest($scope));
$oneReads = count(DB::getQueryLog());
check($oneReads === 3, 'inventory uses three SQL statements');
$wire = $result->getData(true);
check(str_contains($result->headers->get('Cache-Control'),'no-store'), 'inventory cannot be cached');
check(array_column($wire['nodes'],'id') === [10,20,30], 'inventory includes nodes outside policy');
check(array_column($wire['allocations'],'nodeId') === [10,30] && $wire['allocations'][1]['allocations'] === [],
    'inventory scopes allocation lists and includes empty policy nodes');
check(array_column($wire['allocations'][0]['allocations'],'assigned','id') === [1001=>true,2001=>true,2002=>false,2003=>true],
    'inventory includes assigned, foreign and available allocations');
$remote = $wire['servers'][0];
check($remote['uuid'] === $uuids[0] && $remote['allocation'] === 1001 && $remote['identifier'] === $native[0]['uuidShort']
    && !array_key_exists('limits',$remote) && !$remote['suspended'], 'only required server identity is projected');
check(array_column(array_column($remote['relationships']['allocations']['data'],'attributes'),'id') === [1001,2001],
    'inventory includes every allocation of the requested server only');
DB::flushQueryLog();
$many = $controller->gatewayInventory($inventoryRequest(['nodeIds'=>[10],'serverUuids'=>$uuids]))->getData(true);
check(count($many['servers']) === 100 && count(DB::getQueryLog()) === $oneReads, '100 server inventory still uses three SQL reads');
DB::table('servers')->where('id',1001)->update(['status'=>'suspended']);
$wire = $controller->gatewayInventory($inventoryRequest(['nodeIds'=>[], 'serverUuids'=>[$uuids[0]]]))->getData(true);
check($wire['servers'][0]['suspended'] && count($wire['servers'][0]['relationships']['allocations']['data']) === 2 && !$wire['allocations'],
    'fresh independent server claims include suspension even outside policy');
DB::table('allocations')->where('id',2001)->update(['node_id'=>20]);
denied(fn () => $controller->gatewayInventory($inventoryRequest($scope)),409,'cross-node server allocation fails closed');
DB::table('allocations')->where('id',2001)->update(['node_id'=>10]);

denied(fn () => $controller->gatewayTopologySnapshot($inventoryRequest($scope)),501,'missing topology migration offers v1 fallback');
$topologyMigration->up();
Schema::table('api_keys', function ($table) {
    foreach (['r_servers','r_nodes','r_allocations'] as $col) { $table->integer($col)->default(0); }
});
$keyId=79001;
DB::table('api_keys')->insert(['id'=>$keyId, 'user_id'=>1, 'key_type'=>2, 'identifier'=>'testreceipt1',
    'token'=>'test', 'memo'=>'', 'allowed_ips'=>'[]', 'r_nodes'=>1, 'r_allocations'=>1, 'r_servers'=>1]);
$confirmRequest = static function (array $receipt) use ($keyId,$scope) {
    $r = req($scope + ['epoch'=>$receipt['epoch'], 'revision'=>$receipt['revision'], 'waitMs'=>0]);
    $key = Pterodactyl\Models\ApiKey::findOrFail($keyId);
    $r->setUserResolver(fn () => new class($key) {
        public function __construct(private $key) {}
        public function currentAccessToken() { return $this->key; }
    });
    return $r;
};
$topologyRead = static function () use ($controller, $inventoryRequest, $scope, $keyId) {
    $r=$inventoryRequest($scope);
    $key=Pterodactyl\Models\ApiKey::findOrFail($keyId);
    $r->setUserResolver(fn () => new class($key) {
        public function __construct(private $key) {}
        public function currentAccessToken() { return $this->key; }
    });
    return $controller->gatewayTopologySnapshot($r)->getData(true);
};
$first=$topologyRead();
$confirm = fn ($receipt) => array_diff_key($controller->gatewayRevision($confirmRequest($receipt))->getData(true), ['waitedMs'=>true]);
check($first['receipt'] === $confirm($first['receipt']), 'unchanged topology returns compact epoch/revision');
DB::beginTransaction();
DB::table('allocations')->whereBetween('id',[2001,2004])->update(['server_id'=>null]);
DB::rollBack();
check($confirm($first['receipt']) === $first['receipt'], 'rolled back bulk allocation edits do not move watermark');
DB::table('allocations')->whereBetween('id',[2002,2004])->update(['server_id'=>1101]);
$advanced = $confirm($first['receipt']);
check((int)$advanced['revision'] === (int)$first['receipt']['revision'] + 1
    && $topologyRead()['receipt'] === $advanced, 'committed foreign bulk assignments invalidate exact-snapshot receipt');
DB::table('servers')->whereBetween('id',[1001,1002])->update(['owner_id'=>12]);
DB::table('nodes')->where('id',30)->update(['uuid'=>$fixtureUuid(300)]);
DB::table('nodes')->where('id',20)->delete();
$advancedAgain = $confirm($advanced);
check((int)$advancedAgain['revision'] === (int)$advanced['revision'] + 4, 'bulk owner and node update/delete change the revision');
DB::table('servers')->whereBetween('id',[1001,1002])->update(['owner_id'=>1]);
$authorizedAtStart = $confirmRequest($advancedAgain);
DB::table('api_keys')->where('id',$keyId)->update(['r_allocations'=>0]);
denied(fn () => $controller->gatewayRevision($authorizedAtStart),403,'receipt rechecks revoked allocation permission at delivery');
$trigger = DB::table('sqlite_master')->where('type','trigger')->where('tbl_name','allocations')->value('name');
DB::statement('DROP TRIGGER "' . $trigger . '"');
DB::table('api_keys')->where('id',$keyId)->update(['r_allocations'=>1]);
denied($topologyRead,501,'incomplete trigger coverage refuses revisioned snapshot');
check(!isset($controller->gatewayInventory($inventoryRequest($scope))->getData(true)['receipt']), 'unversioned inventory remains available after trigger loss');
DB::statement('CREATE TRIGGER "' . $trigger . '" AFTER INSERT ON allocations BEGIN SELECT 1; END');
$topologyMigration->down();
check(DB::table('sqlite_master')->where('name',$trigger)->exists(), 'uninstall preserves externally replaced trigger with same name');
DB::statement('DROP TRIGGER "' . $trigger . '"');
DB::table('api_keys')->where('id',$keyId)->delete();

$batch = fn ($ids) => $controller->serverSnapshots(req(['serverUuids'=>$ids], 'POST', 2, 1),$instanceId)->getData(true);
denied(fn () => $controller->serverSnapshots(req(['serverUuids'=>$uuids], 'POST',2,1,2),$instanceId),403,'batch checks instance key ownership');
denied(fn () => $batch(array_merge($uuids, [$fixtureUuid(7000)])),422,'batch rejects more than 100 selectors');
denied(fn () => $batch([]),422,'batch rejects empty selectors');
$prior = DB::table('nickhosting_servers')->count();
$result = $batch([$uuids[0],$fixtureUuid(1101),$fixtureUuid(105687)]);
check(count($result['servers']) === 1 && $result['servers'][0]['server']['providerUuid'] === $uuids[0]
    && DB::table('nickhosting_servers')->count() === $prior, 'batch keeps foreign and unlinked identities separate');
DB::flushQueryLog();
$all = $batch($uuids);
check(count(DB::getQueryLog()) === 4 && count($all['servers']) === 100, '100 unchanged snapshots take four reads including authorization');
$pending = DB::table('nickhosting_outbox')->where('instance_id',$instanceId)->count();
DB::table('servers')->whereBetween('id',[1001,1098])->update(['memory'=>3072]);
DB::table('servers')->where('id',1099)->update(['owner_id'=>2, 'memory'=>12345]);
DB::table('servers')->where('id',1100)->delete();
DB::flushQueryLog();
$changed = $batch($uuids);
check(count(DB::getQueryLog()) === 6, '100 drifted snapshots repair links and outbox in two batched writes');
$indexed = [];
foreach ($changed['servers'] as $event) { $indexed[$event['server']['providerId']] = $event; }
check($indexed[1001]['revision'] === 2 && $indexed[1001]['limits']['memory'] === 3072
    && $indexed[1098]['limits']['memory'] === 3072 && $indexed[1099]['type'] === 'identity.invalidated'
    && $indexed[1099]['limits']['memory'] === 2048 && $indexed[1100]['type'] === 'identity.invalidated', 'batch reconciles limits, changed owner and deletion');
check(DB::table('nickhosting_outbox')->where('instance_id',$instanceId)->count() === $pending + 100, 'each changed link has its own durable event');
DB::table('servers')->where('id',1099)->update(['owner_id'=>1]);
$again = $batch([$uuids[98]])['servers'][0];
check($again['type'] === 'identity.invalidated' && $again['revision'] === 2, 'snapshot batch cannot silently relink');
DB::table('servers')->where('id',1001)->update(['cpu'=>150]);
DB::statement("CREATE TRIGGER fail_snapshot_outbox BEFORE INSERT ON nickhosting_outbox BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
try {
    $batch([$uuids[0]]);
    throw new RuntimeException('Expected isolated outbox failure');
} catch (Illuminate\Database\QueryException $error) {
    check(DB::table('nickhosting_servers')->where('server_id',1001)->value('revision') === 2,
        'failed batch outbox rolls back projection revision');
}
DB::statement('DROP TRIGGER fail_snapshot_outbox');
check($batch([$uuids[0]])['servers'][0]['revision'] === 3, 'retry after rollback advances exactly one revision');
DB::disableQueryLog();
// Build large, test-owned sets directly in the SQLite memory database.
DB::statement("WITH RECURSIVE seq(x) AS (VALUES(30000) UNION ALL SELECT x+1 FROM seq WHERE x<40000)
    INSERT INTO nodes (id,uuid) SELECT x, printf('10101010-2020-4030-8040-%012d',x) FROM seq");
denied(fn () => $controller->gatewayInventory($inventoryRequest($scope)),413,'node catalog overflow returns no partial inventory');
DB::table('nodes')->where('id','>=',30000)->delete();
DB::statement("WITH RECURSIVE seq(x) AS (VALUES(5001) UNION ALL SELECT x+1 FROM seq WHERE x<70537)
    INSERT INTO allocations (id,ip,port,node_id,server_id) SELECT x,'2001:db8:abcd:bad:dcde:ffff:eeee:aaaa',2000,10,null FROM seq");
denied(fn () => $controller->gatewayInventory($inventoryRequest($scope)),413,'allocation overflow rejects the whole inventory');
DB::table('allocations')->where('id','>',60000)->delete();
denied(fn () => $controller->gatewayInventory($inventoryRequest($scope)),413,'under row limit but over wire budget returns no partial inventory');
