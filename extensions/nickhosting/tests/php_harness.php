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

Schema::create('settings', function ($t) { $t->string('key')->primary(); $t->text('value'); });
$settings = new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\Settings();
$settings->save('https://review.example');
Schema::create('servers', function ($t) {
    $t->increments('id'); $t->string('uuid'); $t->string('uuidShort'); $t->string('external_id'); $t->integer('node_id'); $t->integer('owner_id')->default(1);
    foreach (['memory','swap','disk','io','cpu'] as $field) { $t->integer($field); }
    $t->string('threads')->nullable(); $t->timestamps();
});
Schema::create('users', function ($t) { $t->increments('id'); $t->string('uuid'); $t->string('external_id'); $t->boolean('root_admin'); $t->boolean('use_totp')->default(false); $t->string('totp_secret')->nullable(); foreach (['username','email','password','name_first','name_last','language'] as $field) { $t->string($field)->nullable(); } $t->timestamps(); });
Schema::create('api_keys', function ($t) { $t->increments('id'); $t->integer('user_id'); $t->integer('key_type'); $t->string('identifier'); $t->text('token'); $t->text('memo'); $t->text('allowed_ips'); $t->timestamps(); });
$technicalMigration->up();
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

$settingsClass = Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\Settings::class;
check($settingsClass::normalizeOrigin(' https://EXAMPLE.test:443/ ') === 'https://example.test', 'canonical HTTPS origin');
foreach (['http://example.test', 'https://user:pass@example.test', 'https://example.test/a', 'https://example.test?x=1', 'https://example.test#x', 'https://example.test\\evil', 'not-url'] as $invalid) {
    check($settingsClass::normalizeOrigin($invalid) === null, 'reject invalid origin ' . $invalid);
}
$settings->save('');
check($settings->origins() === [], 'blank disables delivery origins');
$settings->migrateLegacy(['https://review.example']);
check($settings->origin() === '', 'migration preserves explicitly disabled setting');
DB::table('settings')->delete();
$settings->migrateLegacy(['https://one.example', 'https://two.example']);
check($settings->origin() === '', 'ambiguous legacy origins not silently selected');
$settings->migrateLegacy(['https://review.example']);
check($settings->origin() === 'https://review.example', 'legacy origin migration');
$settings->save('https://other.example');
check(!Protocol::callbackAllowed($registration['callbackUrl'], $settings->origins()), 'old callback immediately blocked');
DB::table('nickhosting_outbox')->update(['delivered_at'=>null,'available_at'=>now()->subSecond()]);
$attemptedRequests=0;
$http = new Illuminate\Http\Client\Factory(); Illuminate\Support\Facades\Http::swap($http);
$http->fake(function () use (&$attemptedRequests) { $attemptedRequests++; return Illuminate\Support\Facades\Http::response('',204); });
(new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Jobs\DeliverChanges())->handle();
check($attemptedRequests===0 && DB::table('nickhosting_outbox')->whereNull('delivered_at')->count()>0,'changed origin prevents actual outbound delivery and preserves pending events');

$settings->migrateLegacy(['https://review.example']);
check($settings->origin() === 'https://other.example', 'migration preserves Owner update');
denied(fn () => $controller->register(req($registration),$instance),422,'registration uses changed origin immediately');
$adminClass = Pterodactyl\Http\Controllers\Admin\Extensions\nickhosting\nickhostingExtensionController::class;
$admin = (new ReflectionClass($adminClass))->newInstanceWithoutConstructor();
$property = new ReflectionProperty($adminClass, 'settings'); $property->setValue($admin, $settings);
$anonymous = Request::create('/', 'PATCH', ['origin' => 'https://evil.example']);
denied(fn () => $admin->update($anonymous),403,'anonymous admin save rejected');
$ordinary = clone $anonymous; $ordinary->setUserResolver(fn () => (object)['root_admin'=>false]);
denied(fn () => $admin->update($ordinary),403,'ordinary user admin save rejected');
$owner = clone $anonymous; $owner->setUserResolver(fn () => (object)['root_admin'=>true]);
$owner->replace(['origin'=>'https://example.test/path']);
$app->instance('translator', $translator); $app->setLocale('en');
try { $admin->update($owner); throw new LogicException('not rejected'); }
catch (Illuminate\Validation\ValidationException $e) { check($settings->origin()==='https://other.example','invalid admin URL leaves stored origin unchanged'); }
$router = new Illuminate\Routing\Router(new Illuminate\Events\Dispatcher($app), $app);
$url = new Illuminate\Routing\UrlGenerator($router->getRoutes(), Request::create('https://panel.example'));
$redirector = new Illuminate\Routing\Redirector($url); $redirector->setSession(new Illuminate\Session\Store('admin-save', new Illuminate\Session\ArraySessionHandler(120)));
$app->instance('redirect', $redirector);
$owner->replace(['origin'=>'https://NEW.example/']);
$redirect = $admin->update($owner);
check($settings->origin()==='https://new.example' && $redirect->getStatusCode()===302,'administrator saves canonical origin');
$defaults = ['downloadBatchLimit'=>2500, 'uploadBatchLimit'=>500, 'signedUrlTtlSeconds'=>900];
check($settings->transfer() === $defaults, 'absent transfer settings use bounded defaults');
$owner->replace(['downloadBatchLimit'=>100, 'uploadBatchLimit'=>40, 'signedUrlTtlSeconds'=>120]);
$admin->update($owner);
check($settings->origin()==='https://new.example' && $settings->transfer()===['downloadBatchLimit'=>100,'uploadBatchLimit'=>40,'signedUrlTtlSeconds'=>120], 'operational save preserves absent origin');
$owner->replace(['origin'=>'https://retained.example']); $admin->update($owner);
check($settings->transfer()['downloadBatchLimit']===100, 'older origin-only form preserves operational settings');
foreach (['downloadBatchLimit'=>2501,'uploadBatchLimit'=>501,'signedUrlTtlSeconds'=>901,'webhookBatchLimit'=>11,'webhookTimeoutSeconds'=>5,'webhookConnectTimeoutSeconds'=>3] as $name=>$invalid) {
    $owner->replace(['origin'=>'https://must-not-save.example',$name=>$invalid]);
    try { $admin->update($owner); throw new LogicException('expected settings rejection'); }
    catch (Illuminate\Validation\ValidationException $e) { check($settings->origin()==='https://retained.example', 'invalid setting rejected before origin changes '.$name); }
}
$settings->saveOperational($defaults);
DB::table('settings')->where('key','nickhosting::downloadBatchLimit')->update(['value'=>'invalid']);
check($settings->transfer()['downloadBatchLimit']===2500, 'invalid stored setting falls back to safe default');
$settings->saveOperational($defaults);
// Compile/render the actual Blade with framework directives, escaped input and both locales.
$files = new Illuminate\Filesystem\Filesystem();
$compiler = new Illuminate\View\Compilers\BladeCompiler($files, sys_get_temp_dir());
$engine = new Illuminate\View\Engines\EngineResolver();
$finder = new Illuminate\View\FileViewFinder($files, []);
$views = new Illuminate\View\Factory($engine, $finder, new Illuminate\Events\Dispatcher($app));
$session = new Illuminate\Session\Store('test', new Illuminate\Session\ArraySessionHandler(120));
$app->instance('session', $session); $session->start();
$renderRequest = Request::create('/'); $renderRequest->setLaravelSession($session); $app->instance('request', $renderRequest);
$errors = new Illuminate\Support\ViewErrorBag();
$operational = $settings->operational(); $operationalDefinitions = $settingsClass::OPERATIONAL;
$origin = 'https://review.example'; $root = '/admin/extensions/nickhosting';
$instances = collect([['callback'=>'https://review.example/v1/events','allowed'=>true,'pending'=>2,'lastDelivered'=>null]]);
$__env = $views;
foreach (['en','it'] as $locale) {
    $app->setLocale($locale);
    ob_start(); eval('?>' . $compiler->compileString($settingsView)); $html=ob_get_clean();
    check(str_contains($html, 'name="_token"') && str_contains($html, 'value="PATCH"'), 'Blade CSRF and method fields ' . $locale);
    check(str_contains($html, $locale==='it' ? 'Ultima consegna confermata' : 'Last acknowledged delivery'), 'Blade status localized ' . $locale);
    check(str_contains($html, 'https://review.example'), 'Blade origin visible ' . $locale);
    check(substr_count($html, '<li>') === 8 && str_contains($html, $locale==='it' ? 'più upload' : 'multiple uploads'), 'Blade concise feature bullets ' . $locale);
    check(str_contains($html, 'name="downloadBatchLimit"') && str_contains($html, 'value="2500"') && str_contains($html, $locale === 'it' ? 'Durata URL firmati' : 'Signed URL lifetime'), 'Blade operational settings localized ' . $locale);
}
$instance = '11111111-1111-4111-8111-111111111111';
// Technical-account tests use the installed native creation service with an isolated repository.
$accounts = new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\TechnicalAccounts();
$app->instance(get_class($accounts), $accounts);
$repository = new class($app) extends Pterodactyl\Repositories\Eloquent\UserRepository {
    public function create(array $fields, bool $validate=true, bool $force=false): Illuminate\Database\Eloquent\Model|bool {
        $user = Pterodactyl\Models\User::query()->newModelInstance()->forceFill($fields)->skipValidation(); $user->save(); return $user;
    }
};
$broker = new class implements Illuminate\Contracts\Auth\PasswordBroker {
    public function sendResetLink(array $credentials, Closure $callback=null) { throw new RuntimeException('Unexpected reset'); }
    public function reset(array $credentials, Closure $callback) { throw new RuntimeException('Unexpected reset'); }
    public function validator(Closure $callback) { return $this; }
    public function createToken($user) { throw new RuntimeException('Creation must always supply a random password'); }
};
$notifications = new class implements Illuminate\Contracts\Notifications\Dispatcher {
    public int $count=0;
    public bool $creationProtected=false;
    public function send($notifiables, $notification) {
        $this->count++;
        $this->creationProtected=app(Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\TechnicalAccounts::class)->managed($notifiables);
    }
    public function sendNow($notifiables, $notification, array $channels=null) { $this->count++; }
};
$app->instance(Illuminate\Contracts\Notifications\Dispatcher::class, $notifications);
$app->instance(Pterodactyl\Services\Users\UserCreationService::class, new Pterodactyl\Services\Users\UserCreationService(
    $capsule->getConnection(), new Illuminate\Hashing\BcryptHasher(['rounds'=>4]), $broker, $repository));
$nickTechnical='88888888-8888-4888-8888-888888888888';
denied(fn () => $controller->provisionUser(req([], 'POST',1), $instance,$nickTechnical),403,'Client token cannot provision accounts');
denied(fn () => $controller->provisionUser(req([], 'POST',2,1), $instance,$nickTechnical),403,'read-only Application key cannot provision accounts');
$created=$controller->provisionUser(req(),$instance,$nickTechnical)->getData(true);
$technical=Pterodactyl\Models\User::query()->find($created['providerId']);
check(str_starts_with($technical->username,'nh-') && strlen($technical->username)===32 && !$technical->root_admin,'technical username and nonadmin');
check(str_ends_with($technical->email,'@accounts.nickhosting.invalid') && !isset($created['password']),'opaque technical email and no password response');
check(str_starts_with($technical->password,'$2y$') && $notifications->count===1 && $notifications->creationProtected,'native creation hashes password and dispatches notification');
check($controller->provisionUser(req(),$instance,$nickTechnical)->getData(true)===$created && $notifications->count===1,'lost response retry returns same account without another notification');
check($accounts->managed($technical) && !$accounts->managed(Pterodactyl\Models\User::query()->find(1)),'exact technical ledger only');
$before=DB::table('users')->count();
DB::beginTransaction();
$controller->provisionUser(req(),$instance,'99999999-9999-4999-8999-999999999999');
DB::rollBack();
check(DB::table('users')->count()===$before && !DB::table('nickhosting_users')->where('nick_user_id','99999999-9999-4999-8999-999999999999')->exists(),'outer rollback removes account and durable link');
$middleware=new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Middleware\TechnicalAccountAccess($accounts);
foreach (['/auth/login','/auth/password','/auth/password/reset'] as $path) {
    $r=Request::create($path,'POST',['user'=>$technical->username,'email'=>$technical->email]);
    denied(fn () => $middleware->handle($r,fn()=>true),403,'technical login/reset rejected '.$path);
}
$r=Request::create('/api/client','GET'); $r->setUserResolver(fn()=>$technical);
denied(fn () => $middleware->handle($r,fn()=>true),403,'browser session cannot use Client API');
$key=(new ReflectionClass(Pterodactyl\Models\ApiKey::class))->newInstanceWithoutConstructor(); $key->setRawAttributes(['key_type'=>1]);
$technical->withAccessToken($key);
check($middleware->handle($r,fn()=>true)===true,'real account API token permitted');
$r=Request::create('/'); $r->setUserResolver(fn()=>$technical);
denied(fn () => $middleware->handle($r,fn()=>true),403,'API token does not grant browser access');
$router=new Illuminate\Routing\Router(new Illuminate\Events\Dispatcher($app),$app); $app->instance('router',$router);
$app->instance('events',new Illuminate\Events\Dispatcher($app));
$provider=new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Providers\BridgeServiceProvider($app); $provider->boot();
$event=new Illuminate\Notifications\Events\NotificationSending($technical,new Pterodactyl\Notifications\AccountCreated($technical),'mail');
check($app['events']->until($event)===false,'queued technical account email suppressed');
$event=new Illuminate\Notifications\Events\NotificationSending(Pterodactyl\Models\User::query()->find(1),new Pterodactyl\Notifications\AccountCreated($technical),'mail');
check($app['events']->until($event)===null,'unrelated account email unchanged');
$mail=(new Symfony\Component\Mime\Email())->to($technical->email);
check($app['events']->until(new Illuminate\Mail\Events\MessageSending($mail))===false,'direct mail to technical account suppressed');
denied(fn () => $app['events']->dispatch(new Illuminate\Auth\Events\Login('web',$technical,false)),403,'authentication event rejects technical login');
check(in_array(get_class($middleware),$router->getMiddlewareGroups()['api'],true),'middleware registered for stateful API requests');
// Foreign collisions cannot be adopted, even if their names resemble technical accounts.
$collisionId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
$collisionIdentity=Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\TechnicalAccounts::identity($instance,$collisionId);
DB::table('users')->insert($collisionIdentity+['uuid'=>'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','root_admin'=>false]);
denied(fn () => $controller->provisionUser(req(),$instance,$collisionId),409,'unlinked deterministic collision rejected');
$foreign=Pterodactyl\Models\User::query()->where('external_id',$collisionIdentity['external_id'])->first();
check(!$accounts->managed($foreign),'nh prefix and reserved email alone do not block unrelated user');
$r=Request::create('/auth/login','POST',['user'=>$foreign->username]);
check($middleware->handle($r,fn()=>true)===true,'unrelated login preserved despite nh prefix');
denied(fn () => $controller->provisionUser(req([], 'POST',2,3,2),$instance,$nickTechnical),403,'different Application key cannot provision or recover');
DB::table('users')->where('id',$technical->id)->update(['root_admin'=>true]);
denied(fn () => $controller->provisionUser(req(),$instance,$nickTechnical),409,'promoted account cannot be recovered as technical');
DB::table('users')->where('id',$technical->id)->update(['root_admin'=>false]);
$r=Request::create('/auth/login/checkpoint','POST'); $session->put('auth_confirmation_token.user_id',$technical->id); $r->setLaravelSession($session);
denied(fn () => $middleware->handle($r,fn()=>true),403,'pending two factor session rejected');
$ownerServer='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
$ownerIdentity=['providerId'=>2,'providerUuid'=>$ownerServer,'identifier'=>'cccccccc','externalId'=>'owner-test','nodeId'=>1];
DB::table('servers')->insert(['id'=>2,'uuid'=>$ownerServer,'uuidShort'=>'cccccccc','external_id'=>'owner-test','node_id'=>1,'owner_id'=>1,'memory'=>1024,'swap'=>0,'disk'=>4096,'io'=>500,'cpu'=>100]);
$controller->snapshot(req($ownerIdentity+['expectedOwnerId'=>1],'PUT'),$instance,$ownerServer);
DB::table('servers')->where('id',2)->update(['owner_id'=>2]);
$feed->capture(Pterodactyl\Models\Server::query()->withoutEagerLoads()->find(2));
check(!DB::table('nickhosting_servers')->where('server_id',2)->value('valid'),'provider ownership change invalidates projection');
denied(fn () => $controller->snapshot(req($ownerIdentity,'PUT'),$instance,$ownerServer),409,'ordinary PUT cannot repair changed ownership');
denied(fn () => $controller->snapshot(req($ownerIdentity+['expectedOwnerId'=>1],'PUT'),$instance,$ownerServer),409,'wrong expected owner rejected');
$relinked=$controller->snapshot(req($ownerIdentity+['expectedOwnerId'=>2],'PUT'),$instance,$ownerServer)->getData(true);
check($relinked['type']==='snapshot' && $relinked['revision']===3,'explicit owner handoff advances revision and restores exact link');
$service=$app->make(Pterodactyl\Services\Users\UserCreationService::class);
$failingRepository=new class($app) extends Pterodactyl\Repositories\Eloquent\UserRepository {
    public function create(array $fields, bool $validate=true, bool $force=false): Illuminate\Database\Eloquent\Model|bool {
        throw new RuntimeException('isolated repository failure');
    }
};
$app->instance(Pterodactyl\Services\Users\UserCreationService::class,new Pterodactyl\Services\Users\UserCreationService(
    $capsule->getConnection(),new Illuminate\Hashing\BcryptHasher(['rounds'=>4]),$broker,$failingRepository));
try { $controller->provisionUser(req(),$instance,'dddddddd-dddd-4ddd-8ddd-dddddddddddd'); throw new RuntimeException('expected creation failure'); }
catch (RuntimeException $error) { check($error->getMessage()==='isolated repository failure','native creation error propagated'); }
check(DB::transactionLevel()===0 && !DB::table('nickhosting_users')->where('nick_user_id','dddddddd-dddd-4ddd-8ddd-dddddddddddd')->exists(),'native nested transaction failure fully rolled back');
$app->instance(Pterodactyl\Services\Users\UserCreationService::class,$service);
check($controller->provisionUser(req(),$instance,'dddddddd-dddd-4ddd-8ddd-dddddddddddd')->getStatusCode()===200,'retry after native creation failure succeeds');

// Native Client permissions, server-state middleware and native JWT signing are exercised
// against in-memory models. No production bootstrap, Wings call or secret is used.
$app['config']->set('app.url', 'https://panel.example');
$gate = new Illuminate\Auth\Access\Gate($app, fn () => null);
$gate->policy(Pterodactyl\Models\Server::class, Pterodactyl\Policies\ServerPolicy::class);
$app->instance(Illuminate\Contracts\Auth\Access\Gate::class, $gate);
$uploadServer = Pterodactyl\Models\Server::query()->withoutEagerLoads()->find(2);
$uploadUser = Pterodactyl\Models\User::query()->find(2);
$nodeSecret = random_bytes(32);
$uploadNode = new Pterodactyl\Models\Node();
$uploadNode->setRawAttributes(['id'=>1, 'scheme'=>'https', 'fqdn'=>'wings.example', 'daemonListen'=>443,
    'daemon_token'=>encrypt($nodeSecret), 'maintenance_mode'=>false]);
$uploadServer->setRelation('node', $uploadNode)->setRelation('transfer', null)->setRelation('subusers', collect());
function transferRequest(string $kind, array $data, $server, $user, mixed $tokenType = 1) {
    global $validator, $app;
    $class = match ($kind) {
        'upload-urls' => Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Requests\UploadUrlsRequest::class,
        'download-urls' => Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Requests\DownloadUrlsRequest::class,
        'transfer-settings' => Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Requests\TransferSettingsRequest::class,
        'directory-list' => Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Requests\DirectoryListRequest::class,
        'directory-settings' => Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Requests\DirectorySettingsRequest::class,
    };
    $method=str_ends_with($kind,'settings') ? 'GET' : 'POST';
    $r=$class::create('/api/client/extensions/nickhosting/servers/'.$server->uuidShort.'/'.$kind, $method, $data);
    if ($kind === 'directory-list') {
        $r=$class::create($r->getUri(),$method,[],[],[],['CONTENT_TYPE'=>'application/json'],json_encode($data,JSON_THROW_ON_ERROR));
        (new Pterodactyl\Http\Middleware\TrimStrings())->handle($r,fn()=>null);
        (new Illuminate\Foundation\Http\Middleware\ConvertEmptyStringsToNull())->handle($r,fn()=>null);
        (new ReflectionMethod($class,'prepareForValidation'))->invoke($r);
        $data=$r->all();
    }
    $key = is_int($tokenType) ? new Pterodactyl\Models\ApiKey() : $tokenType;
    if ($key instanceof Pterodactyl\Models\ApiKey) { $key->setRawAttributes(['key_type'=>$tokenType, 'user_id'=>$user->id]); }
    $user=clone $user; $user->withAccessToken($key); $r->setUserResolver(fn () => $user);
    $route = new Illuminate\Routing\Route($method, '/api/client/extensions/nickhosting/servers/{server}/'.$kind, fn () => null);
    $route->bind($r); $route->setParameter('server', $server); $r->setRouteResolver(fn () => $route);
    $v=$validator->make($data, $r->rules()); $v->validate();
    $r->setContainer($app); $r->setValidator($v);
    return $r;
}
function uploadRequest(array $data, $server, $user, mixed $tokenType = 1) {
    return transferRequest('upload-urls', $data, $server, $user, $tokenType);
}
function downloadRequest(array $data, $server, $user, mixed $tokenType = 1) {
    return transferRequest('download-urls', $data, $server, $user, $tokenType);
}
$uploads = new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\UploadUrlsController(new Pterodactyl\Services\Nodes\NodeJWTService());
$uploadReq = uploadRequest(['count'=>49], $uploadServer, $uploadUser);
check($uploadReq->authorize(), 'bulk upload authorizes native account token and file-create permission');
check(!uploadRequest(['count'=>1], $uploadServer, $uploadUser, 2)->authorize(), 'bulk upload rejects Application token');
check(!uploadRequest(['count'=>1], $uploadServer, $uploadUser, new Laravel\Sanctum\TransientToken())->authorize(), 'bulk upload rejects cookie token');
check(!uploadRequest(['count'=>1], $uploadServer, $uploadUser, null)->authorize(), 'bulk upload rejects missing token');
$unrelatedUser=clone $uploadUser; $unrelatedUser->id=900;
check(!uploadRequest(['count'=>1], $uploadServer, $unrelatedUser)->authorize(), 'bulk upload denies missing native file-create permission');
$subuser=new Pterodactyl\Models\Subuser(); $subuser->setRawAttributes(['user_id'=>900,'permissions'=>'["file.create"]']);
$uploadServer->setRelation('subusers', collect([$subuser]));
$subRequest=uploadRequest(['count'=>1], $uploadServer, $unrelatedUser);
check($subRequest->authorize(), 'bulk upload applies native subuser file-create permission');
denied(fn () => $uploads($subRequest,$uploadServer),403,'bulk upload requires exact registered owner credential');
$uploadServer->setRelation('subusers', collect());
$adminUser=clone $uploadUser; $adminUser->root_admin=true;
denied(fn () => $uploads(uploadRequest(['count'=>1],$uploadServer,$adminUser),$uploadServer),403,'bulk upload rejects provider administrator');
$access = new Pterodactyl\Http\Middleware\Api\Client\Server\AuthenticateServerAccess();
check($access->handle($uploadReq, fn () => true)===true, 'bulk upload native current-server-state check passes');
$uploadServer->status=Pterodactyl\Models\Server::STATUS_SUSPENDED;
denied(fn () => $access->handle($uploadReq,fn () => true),409,'bulk upload rejects suspended server via native middleware');
$uploadServer->status=null;
$uploadNode->maintenance_mode=true;
denied(fn () => $access->handle($uploadReq,fn () => true),409,'bulk upload rejects node maintenance via native middleware');
$uploadNode->maintenance_mode=false;
foreach ([[],['count'=>0],['count'=>501],['count'=>1.5],['count'=>'2'],['count'=>true]] as $invalid) {
    try { $uploads(uploadRequest($invalid,$uploadServer,$uploadUser),$uploadServer); throw new LogicException('expected validation'); }
    catch (Illuminate\Validation\ValidationException $e) { check(true,'bulk upload rejects invalid bounded count'); }
}
$response=$uploads($uploadReq,$uploadServer);
$body=$response->getData(true);
check($response->getStatusCode()===200 && $response->headers->get('Cache-Control')==='no-store, private'
    && count($body['urls'])===49, 'bulk upload returns 49 private URLs in one response');
$config=Lcobucci\JWT\Configuration::forSymmetricSigner(new Lcobucci\JWT\Signer\Hmac\Sha256(),Lcobucci\JWT\Signer\Key\InMemory::plainText($nodeSecret));
$unique=[];
foreach ($body['urls'] as $url) {
    parse_str(parse_url($url,PHP_URL_QUERY),$query);
    $jwt=$config->parser()->parse($query['token']);
    if (!$config->validator()->validate($jwt,new Lcobucci\JWT\Validation\Constraint\SignedWith($config->signer(),$config->signingKey()))
        || $jwt->claims()->get('server_uuid')!==$uploadServer->uuid
        || $jwt->claims()->get('user_uuid')!==$uploadUser->uuid
        || $jwt->claims()->get('exp')->getTimestamp()!==strtotime($body['expiresAt'])
        || !str_starts_with($url,'https://wings.example:443/upload/file?token=')) { throw new RuntimeException('invalid native upload token'); }
    $unique[]=$jwt->claims()->get('unique_id');
}
check(count(array_unique($unique))===49, 'bulk upload native signatures claims expiry and unique token consumption IDs');
$ttl=strtotime($body['expiresAt'])-time();
check($ttl>=898 && $ttl<=900, 'bulk upload URLs expire after native 15 minutes');
check(count($uploads(uploadRequest(['count'=>500],$uploadServer,$uploadUser),$uploadServer)->getData(true)['urls'])===500,'bulk upload supports bounded 500-file group');
$downloads = new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\DownloadUrlsController(new Pterodactyl\Services\Nodes\NodeJWTService());
$transferSettingsController = new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\TransferSettingsController();
$paths=['world/level.dat','server.properties','config/hello world.json','config/città.json'];
$downloadReq=downloadRequest(['paths'=>$paths],$uploadServer,$uploadUser);
check($downloadReq->authorize(), 'bulk download authorizes native file-read-content permission');
foreach ([2, new Laravel\Sanctum\TransientToken(), null] as $tokenType) {
    check(!downloadRequest(['paths'=>['a']],$uploadServer,$uploadUser,$tokenType)->authorize(), 'bulk download rejects nonaccount token');
    check(!transferRequest('transfer-settings',[],$uploadServer,$uploadUser,$tokenType)->authorize(), 'transfer settings reject nonaccount token');
}
check(!downloadRequest(['paths'=>['a']],$uploadServer,$unrelatedUser)->authorize(), 'bulk download rejects missing native permission');
$subuser->setRawAttributes(['user_id'=>900,'permissions'=>'["file.read-content"]']);
$uploadServer->setRelation('subusers',collect([$subuser]));
$subDownload=downloadRequest(['paths'=>['a']],$uploadServer,$unrelatedUser);
check($subDownload->authorize(), 'native file-read-content subuser permission recognized');
denied(fn () => $downloads($subDownload,$uploadServer),403,'bulk download still requires exact linked owner');
$uploadServer->setRelation('subusers',collect());
denied(fn () => $downloads(downloadRequest(['paths'=>['a']],$uploadServer,$adminUser),$uploadServer),403,'bulk download rejects administrator');
check($access->handle($downloadReq,fn()=>true)===true, 'bulk download native state middleware passes');
$uploadServer->status=Pterodactyl\Models\Server::STATUS_SUSPENDED;
denied(fn () => $access->handle($downloadReq,fn()=>true),409,'bulk download native suspended state denied');
$uploadServer->status=null;
foreach ([[],['paths'=>[]],['paths'=>'a'],['paths'=>['a','a']],['paths'=>['named'=>'a']],['paths'=>[null]],['paths'=>[12]],['paths'=>[true]],['paths'=>['']],['paths'=>['/absolute']],['paths'=>['a/']],['paths'=>['a//b']],['paths'=>['..']],['paths'=>['a/../b']],['paths'=>['a/./b']],['paths'=>['a\\b']],['paths'=>['%2e%2e/a']],['paths'=>["a\0b"]],['paths'=>["a\nb"]],['paths'=>[str_repeat('a',4097)]],['paths'=>array_map(fn($n)=>'file-'.$n,range(1,2501))]] as $invalid) {
    try { downloadRequest($invalid,$uploadServer,$uploadUser); throw new LogicException('expected invalid paths'); }
    catch (Illuminate\Validation\ValidationException $e) { check(true,'bulk download rejects invalid bounded canonical paths'); }
}
$oversized=clone $downloadReq;
$oversized->initialize([],[],[],[],[],[],str_repeat('x',12*1024*1024+1));
denied(fn () => $oversized->authorize(),413,'bulk download bounds raw request body');
$downloadResponse=$downloads($downloadReq,$uploadServer);
$downloadBody=$downloadResponse->getData(true); $downloadUnique=[];
check($downloadResponse->headers->get('Cache-Control')==='no-store, private' && count($downloadBody['urls'])===count($paths), 'bulk download response private and ordered');
foreach ($downloadBody['urls'] as $index=>$url) {
    parse_str(parse_url($url,PHP_URL_QUERY),$query); $jwt=$config->parser()->parse($query['token']);
    check($config->validator()->validate($jwt,new Lcobucci\JWT\Validation\Constraint\SignedWith($config->signer(),$config->signingKey()))
        && $jwt->claims()->get('file_path')==='/'.$paths[$index]
        && $jwt->claims()->get('server_uuid')===$uploadServer->uuid
        && $jwt->claims()->get('user_uuid')===$uploadUser->uuid
        && $jwt->claims()->get('exp')->getTimestamp()===strtotime($downloadBody['expiresAt'])
        && str_starts_with($url,'https://wings.example:443/download/file?token='), 'native file token signature exact path server owner expiry and ordering');
    $downloadUnique[]=$jwt->claims()->get('unique_id');
}
check(count(array_unique($downloadUnique))===count($paths), 'download signatures have distinct one-use IDs');
$settingsReq=transferRequest('transfer-settings',[],$uploadServer,$uploadUser);
check($settingsReq->authorize() && $transferSettingsController($settingsReq,$uploadServer)->getData(true)===$defaults, 'transfer discovery returns exact defaults for authorized linked owner');
DB::connection()->enableQueryLog(); DB::connection()->flushQueryLog();
$largeRequest=downloadRequest(['paths'=>array_map(fn($n)=>'file-'.$n,range(1,2500))],$uploadServer,$uploadUser);
$largeBody=$downloads($largeRequest,$uploadServer)->getData(true);
$queries=DB::connection()->getQueryLog(); DB::connection()->disableQueryLog();
check(count($largeBody['urls'])===2500 && count($queries)===5, '2500 signatures perform three setting reads and two identity reads only');
$settings->saveOperational(['downloadBatchLimit'=>2,'uploadBatchLimit'=>2,'signedUrlTtlSeconds'=>60]);
check($transferSettingsController(transferRequest('transfer-settings',[],$uploadServer,$uploadUser),$uploadServer)->getData(true)===['downloadBatchLimit'=>2,'uploadBatchLimit'=>2,'signedUrlTtlSeconds'=>60], 'fresh transfer discovery reflects configured lower limits');
foreach (['upload-urls'=>['count'=>3],'download-urls'=>['paths'=>['a','b','c']]] as $kind=>$input) {
    try { transferRequest($kind,$input,$uploadServer,$uploadUser); throw new LogicException('expected configured limit rejection'); }
    catch (Illuminate\Validation\ValidationException $e) { check(true,'configured lower limit applies '.$kind); }
}
$lowerDownload=downloadRequest(['paths'=>['a','b']],$uploadServer,$uploadUser);
$settings->saveOperational(['signedUrlTtlSeconds'=>120]);
$lowerBody=$downloads($lowerDownload,$uploadServer)->getData(true);
$ttl=strtotime($lowerBody['expiresAt'])-time();
check($ttl>=58 && $ttl<=60, 'validated request preserves one settings snapshot for signing');
$lowerUploadBody=$uploads(uploadRequest(['count'=>2],$uploadServer,$uploadUser),$uploadServer)->getData(true);
$ttl=strtotime($lowerUploadBody['expiresAt'])-time();
check($ttl>=118 && $ttl<=120, 'upload signing uses configurable lifetime');
$settings->saveOperational($defaults);
eval($directoryHarness);
DB::table('nickhosting_servers')->where('uuid',$uploadServer->uuid)->update(['valid'=>false]);
denied(fn () => $uploads($uploadReq,$uploadServer),409,'bulk upload rejects invalidated server link');
denied(fn () => $downloads($downloadReq,$uploadServer),409,'bulk download rejects invalidated server link');
denied(fn () => $transferSettingsController($settingsReq,$uploadServer),409,'settings discovery rejects invalidated server link');
DB::table('nickhosting_servers')->where('uuid',$uploadServer->uuid)->update(['valid'=>true]);
$uploadServer->external_id='foreign';
denied(fn () => $uploads($uploadReq,$uploadServer),409,'bulk upload rejects exact server identity drift');
denied(fn () => $downloads($downloadReq,$uploadServer),409,'bulk download rejects exact server identity drift');
denied(fn () => $transferSettingsController($settingsReq,$uploadServer),409,'settings discovery rejects exact server identity drift');
$uploadServer->external_id='owner-test';
DB::table('nickhosting_servers')->where('uuid',$uploadServer->uuid)->update(['owner_id'=>1]);
denied(fn () => $uploads($uploadReq,$uploadServer),409,'bulk upload rejects unacknowledged owner handoff');
denied(fn () => $downloads($downloadReq,$uploadServer),409,'bulk download rejects unacknowledged owner handoff');
denied(fn () => $transferSettingsController($settingsReq,$uploadServer),409,'settings discovery rejects unacknowledged owner handoff');
DB::table('nickhosting_servers')->where('uuid',$uploadServer->uuid)->update(['owner_id'=>2]);
DB::table('nickhosting_users')->where('provider_id',2)->update(['provider_uuid'=>'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']);
denied(fn () => $uploads($uploadReq,$uploadServer),409,'bulk upload rejects linked account identity drift');
denied(fn () => $downloads($downloadReq,$uploadServer),409,'bulk download rejects linked account identity drift');
denied(fn () => $transferSettingsController($settingsReq,$uploadServer),409,'settings discovery rejects linked account identity drift');
DB::table('nickhosting_users')->where('provider_id',2)->update(['provider_uuid'=>$uploadUser->uuid,'instance_id'=>'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']);
denied(fn () => $uploads($uploadReq,$uploadServer),409,'bulk upload rejects cross-instance owner link');
denied(fn () => $downloads($downloadReq,$uploadServer),409,'bulk download rejects cross-instance owner link');
denied(fn () => $transferSettingsController($settingsReq,$uploadServer),409,'settings discovery rejects cross-instance owner link');
DB::table('nickhosting_users')->where('provider_id',2)->update(['instance_id'=>$instance]);
DB::table('nickhosting_servers')->where('uuid',$uploadServer->uuid)->delete();
denied(fn () => $uploads($uploadReq,$uploadServer),403,'bulk upload rejects server outside managed registry');
denied(fn () => $downloads($downloadReq,$uploadServer),403,'bulk download rejects unmanaged server');
denied(fn () => $transferSettingsController($settingsReq,$uploadServer),403,'transfer discovery rejects unmanaged server');
// Delivery configuration remains bounded by the existing job and claim duration.
$settings->save('https://review.example');
$settings->saveOperational(['webhookBatchLimit'=>1,'webhookConnectTimeoutSeconds'=>2,'webhookTimeoutSeconds'=>1]);
DB::table('nickhosting_outbox')->update(['delivered_at'=>null,'available_at'=>now()->subSecond()]);
$beforePending=DB::table('nickhosting_outbox')->whereNull('delivered_at')->count();
$deliveryOptions=[];
$http = new Illuminate\Http\Client\Factory(); Illuminate\Support\Facades\Http::swap($http);
$http->fake(function ($request,$options) use (&$deliveryOptions) { $deliveryOptions[]=$options; return Illuminate\Support\Facades\Http::response('',204); });
(new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Jobs\DeliverChanges())->handle();
check(count($deliveryOptions)===1 && DB::table('nickhosting_outbox')->whereNull('delivered_at')->count()===$beforePending-1, 'delivery job honors lower event batch setting');
check($deliveryOptions[0]['connect_timeout']===1 && $deliveryOptions[0]['timeout']===1, 'delivery clamps connect timeout to configured response timeout');
echo "$count checks passed\n";
