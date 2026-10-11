<?php
// Evaluated by run_php_tests.py after vendor autoload and extension source loading.
// No Panel bootstrap, network requests or disk database: SQLite :memory: only.
use Illuminate\Database\Capsule\Manager;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\Facade;
use Illuminate\Http\Request;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\Protocol;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\ChangeFeed;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\BridgeController;

$app = new Illuminate\Foundation\Application('/tmp/nickhosting-memory-tests');
$app->instance('config', new Illuminate\Config\Repository([
    'nickhosting_bridge' => ['callback_origins' => ['https://review.example']],
]));
$app->instance('encrypter', new Illuminate\Encryption\Encrypter(random_bytes(32), 'AES-256-CBC'));
$translator = new Illuminate\Translation\Translator(new Illuminate\Translation\ArrayLoader(), 'en');
$validator = new Illuminate\Validation\Factory($translator, $app);
$app->instance(Illuminate\Contracts\Validation\Factory::class, $validator);
$app->instance('validator', $validator);
$capsule = new Manager($app);
$capsule->addConnection(['driver' => 'sqlite', 'database' => ':memory:', 'prefix' => '']);
$capsule->setEventDispatcher(new Illuminate\Events\Dispatcher($app));
$capsule->setAsGlobal(); $capsule->bootEloquent();
$app->instance('db', $capsule->getDatabaseManager());
$app->instance('db.schema', $capsule->schema());
$capsule->getConnection()->setTransactionManager(new Illuminate\Database\DatabaseTransactionsManager());
Facade::setFacadeApplication($app);
$presence = new Illuminate\Validation\DatabasePresenceVerifier($capsule->getDatabaseManager());
$validator->setPresenceVerifier($presence);
Request::macro('validate', function (array $rules) use ($validator) { return $validator->make($this->all(), $rules)->validate(); });
\Laravel\Sanctum\Sanctum::usePersonalAccessTokenModel(\Pterodactyl\Models\ApiKey::class);
$schemaMigration->up();
Schema::create('servers', function ($t) {
    $t->increments('id'); $t->string('uuid'); $t->string('uuidShort'); $t->string('external_id'); $t->integer('node_id');
    foreach (['memory','swap','disk','io','cpu'] as $field) { $t->integer($field); }
    $t->string('threads')->nullable(); $t->timestamps();
});
Schema::create('users', function ($t) { $t->increments('id'); $t->string('uuid'); $t->string('external_id'); $t->boolean('root_admin'); $t->timestamps(); });
Schema::create('api_keys', function ($t) { $t->increments('id'); $t->integer('user_id'); $t->integer('key_type'); $t->string('identifier'); $t->text('token'); $t->text('memo'); $t->text('allowed_ips'); $t->timestamps(); });
$count = 0;
function check(bool $value, string $name): void { global $count; if (!$value) { throw new RuntimeException('FAIL ' . $name); } $count++; echo 'PASS ' . $name . "\n"; }
function denied(callable $fn, int $code, string $name): void { try { $fn(); } catch (Symfony\Component\HttpKernel\Exception\HttpException $e) { check($e->getStatusCode() === $code, $name); return; } throw new RuntimeException('Expected denial ' . $name); }
function req(array $data = [], string $method = 'POST', int $type = 2, int $permissions = 3, int $keyId = 1): Request {
    $request = Request::create('/', $method, $data);
    $key = (new ReflectionClass(Pterodactyl\Models\ApiKey::class))->newInstanceWithoutConstructor();
    $key->setRawAttributes(['id' => $keyId, 'key_type' => $type, 'r_servers' => $permissions, 'r_users' => $permissions]);
    $request->setUserResolver(fn () => new class($key) { public function __construct(private $key) {} public function currentAccessToken() { return $this->key; } });
    return $request;
}
$controller = new BridgeController();
$instance = '11111111-1111-4111-8111-111111111111';
$uuid = '22222222-2222-4222-8222-222222222222';
$userUuid = '33333333-3333-4333-8333-333333333333';
$identity = ['providerId' => 1,'providerUuid' => $uuid,'identifier' => '22222222','externalId' => 'test-server','nodeId' => 1];
check(Protocol::callbackAllowed('https://review.example/v1/events', ['https://review.example']), 'allow configured origin');
foreach (['http://review.example/v1','https://evil.example/v1','https://review.example@evil.example/v1','https://review.example/v1?secret=x','https://review.example/v1#x'] as $url) {
    check(!Protocol::callbackAllowed($url, ['https://review.example']), 'reject callback ' . $url);
}
check(Protocol::signature('secret','123','body') === hash_hmac('sha256','123.body','secret'), 'HMAC exact body');
$registration = ['callbackUrl' => 'https://review.example/v1/events','webhookSecret' => str_repeat('a',64)];
denied(fn () => $controller->register(req($registration, 'POST',1), $instance),403,'Client token rejected');
denied(fn () => $controller->register(req($registration, 'POST',2,1), $instance),403,'READ token mutation rejected');
$controller->register(req($registration),$instance);
check(DB::table('nickhosting_instances')->value('secret') !== str_repeat('a',64),'webhook secret encrypted');
denied(fn () => $controller->health(req([], 'GET',2,3,2),$instance),403,'other Application key rejected');
DB::table('servers')->insert(['id'=>1,'uuid'=>$uuid,'uuidShort'=>'22222222','external_id'=>'test-server','node_id'=>1,'memory'=>2048,'swap'=>0,'disk'=>4096,'io'=>500,'cpu'=>100]);
$snapshot = $controller->snapshot(req($identity,'PUT'),$instance,$uuid)->getData(true);
check($snapshot['revision']===1 && $snapshot['limits']['memory']===2048,'register authoritative snapshot');
check(DB::table('nickhosting_outbox')->count()===1,'initial signed-delivery event durable');
$feed = new ChangeFeed();
$server = Pterodactyl\Models\Server::query()->withoutEagerLoads()->find(1);
$feed->capture($server);
check(DB::table('nickhosting_outbox')->count()===1,'unchanged update emits nothing');
DB::beginTransaction();
$server->memory = 3072;
$feed->capture($server);
check(DB::table('nickhosting_outbox')->count()===2,'change captured inside transaction');
DB::rollBack();
check(DB::table('nickhosting_outbox')->count()===1 && DB::table('nickhosting_servers')->value('revision')===1,'rollback removes revision and outbox');
DB::table('servers')->where('id',1)->update(['memory'=>3072]);
$server = Pterodactyl\Models\Server::query()->withoutEagerLoads()->find(1); $feed->capture($server);
check(DB::table('nickhosting_servers')->value('revision')===2,'limit update increments revision');
$snapshot=$controller->snapshot(req([],'GET'),$instance,$uuid)->getData(true);
check($snapshot['limits']['memory']===3072 && $snapshot['type']==='snapshot','fresh resnapshot');
$server->external_id='foreign'; $feed->capture($server);
check(!DB::table('nickhosting_servers')->value('valid'),'identity drift invalidates');
$payload=json_decode(DB::table('nickhosting_outbox')->orderByDesc('created_at')->orderByDesc('rowid')->value('payload'),true);
check($payload['type']==='identity.invalidated' && $payload['server']['externalId']==='test-server','invalidation retains original identity');
denied(fn () => $controller->snapshot(req($identity,'PUT'),$instance,$uuid),409,'invalid link cannot silently reactivate');
DB::table('users')->insert(['id'=>1,'uuid'=>$userUuid,'external_id'=>'test-user','root_admin'=>true]);
$userIdentity=['providerId'=>1,'providerUuid'=>$userUuid,'externalId'=>'test-user'];
denied(fn () => $controller->linkUser(req($userIdentity,'PUT'),$instance,$userUuid),409,'administrator link rejected');
DB::table('users')->where('id',1)->update(['root_admin'=>false]);
$controller->linkUser(req($userIdentity,'PUT'),$instance,$userUuid);
check(DB::table('nickhosting_users')->count()===1,'explicit user link');
$controller->linkUser(req($userIdentity,'PUT'),$instance,$userUuid);
check(DB::table('nickhosting_users')->count()===1,'idempotent link');
$operation=['operationId'=>'44444444-4444-4444-8444-444444444444'];
$issued=$controller->issueKey(req($operation),$instance,$userUuid)->getData(true);
check(str_starts_with($issued['key'],'ptlc_') && strlen($issued['key'])===48,'native Client token created');
$again=$controller->issueKey(req($operation),$instance,$userUuid)->getData(true);
check($again===$issued && DB::table('api_keys')->count()===1,'lost response issuance recovery');
check(!str_contains(DB::table('nickhosting_keys')->value('encrypted_response'),$issued['key']),'issued response encrypted');
denied(fn () => $controller->issueKey(req($operation+['allowedIps'=>['127.0.0.1']]),$instance,$userUuid),409,'idempotency parameter mismatch');
$replacement=$controller->issueKey(req(['operationId'=>'55555555-5555-4555-8555-555555555555']),$instance,$userUuid,$issued['identifier'])->getData(true);
check(DB::table('api_keys')->count()===2,'rotation preserves old key until acknowledgement');
$controller->revokeKey(req(),$instance,$userUuid,$issued['identifier']);
check(DB::table('api_keys')->count()===1 && DB::table('api_keys')->value('identifier')===$replacement['identifier'],'revoke only exact owned key');
$controller->revokeKey(req(),$instance,$userUuid,$issued['identifier']);
check(DB::table('api_keys')->count()===1,'idempotent revocation');
denied(fn () => $controller->issueKey(req($operation),$instance,$userUuid),409,'revoked issuance cannot recover secret');
denied(fn () => $controller->revokeKey(req(),$instance,$userUuid,'ptlc_aaaaaaaaaaa'),404,'foreign key rejected');
DB::table('users')->where('id',1)->update(['root_admin'=>true]);
denied(fn () => $controller->issueKey(req(['operationId'=>'66666666-6666-4666-8666-666666666666']),$instance,$userUuid),409,'later admin promotion rejected');
$http = new Illuminate\Http\Client\Factory();
$app->instance(Illuminate\Http\Client\Factory::class, $http);
Illuminate\Support\Facades\Http::swap($http);
$requests = [];
$http->fake(function ($request) use (&$requests) {
    $requests[] = $request;
    return Illuminate\Support\Facades\Http::response('', 503);
});
(new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Jobs\DeliverChanges())->handle();
check(DB::table('nickhosting_outbox')->whereNull('delivered_at')->count()===3, 'failed delivery retained');
check(DB::table('nickhosting_outbox')->min('attempts')===1, 'failed delivery attempts tracked');
check(count($requests)===3, 'bounded delivery sends each pending event once');
$r=$requests[0];
check($r->header('X-NickHosting-Signature')[0]===Protocol::signature(str_repeat('a',64),$r->header('X-NickHosting-Timestamp')[0],$r->body()),'delivery signature matches transmitted bytes');
DB::table('nickhosting_outbox')->update(['available_at'=>now()->subSecond()]);
$http = new Illuminate\Http\Client\Factory();
Illuminate\Support\Facades\Http::swap($http);
$http->fake(fn () => Illuminate\Support\Facades\Http::response('',204));
(new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Jobs\DeliverChanges())->handle();
check(DB::table('nickhosting_outbox')->whereNull('delivered_at')->count()===0, 'successful retry acknowledges durable delivery');
$health=$controller->health(req([],'GET'),$instance)->getData(true);
check($health['pendingEvents']===0 && $health['lastDeliveredAt']!==null,'health reports delivery recovery');
$configuration = "<?php return ['providers' => [\n        Pterodactyl\\Providers\\AppServiceProvider::class,\n    ]];\n";
$registered = nickhostingProviderConfig($configuration, false);
check(str_contains($registered, 'nickhosting-provider-begin'), 'provider registration added');
check(nickhostingProviderConfig($registered, false)===$registered,'provider registration idempotent');
check(nickhostingProviderConfig($registered,true)===$configuration,'provider removal preserves unrelated configuration');
try { nickhostingProviderConfig('<?php return [];',false); throw new LogicException('not rejected'); }
catch (RuntimeException $e) { check(true,'unknown configuration layout rejected'); }
$temporary = tempnam(sys_get_temp_dir(), 'nh-config-test-');
try {
    file_put_contents($temporary,$configuration); chmod($temporary,0640);
    nickhostingWriteConfig($temporary,$configuration,$registered);
    check(file_get_contents($temporary)===$registered && (fileperms($temporary)&0777)===0640,'configuration atomic replacement preserves mode');
    try { nickhostingWriteConfig($temporary,$configuration,$registered); throw new LogicException('not rejected'); }
    catch (RuntimeException $e) { check(file_get_contents($temporary)===$registered,'concurrent edit rejected without truncation'); }
} finally { unlink($temporary); }
echo "$count checks passed\n";
