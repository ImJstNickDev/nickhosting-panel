<?php
// Included by the existing SQLite/vendor-only harness while its linked owner fixtures are valid.
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\DirectoryListingRepository;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\DirectoryListController;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\DirectorySettingsController;
use GuzzleHttp\Psr7\Response;
use GuzzleHttp\Promise\Promise;
use Illuminate\Support\Facades\DB;

class MemoryDirectoryRepository extends DirectoryListingRepository
{
    public ?float $clock = null;
    public GuzzleHttp\Client $client;
    public function getHttpClient(array $headers = []): GuzzleHttp\Client { return $this->client; }
    protected function now(): float { return $this->clock ?? parent::now(); }
}
function directoryRepo(array $responses, array &$seen): MemoryDirectoryRepository {
    global $app, $uploadServer;
    $mock = new GuzzleHttp\Handler\MockHandler($responses);
    $repo = new MemoryDirectoryRepository($app);
    $repo->client = new GuzzleHttp\Client(['handler' => function ($request,$options) use ($mock,&$seen) {
        $seen[] = ['request'=>$request, 'options'=>$options];
        return $mock($request,$options);
    }]);
    $repo->setServer($uploadServer);
    return $repo;
}
function directoryRequest(array $paths, $server = null, $user = null, mixed $token = 1) {
    global $uploadServer,$uploadUser;
    return transferRequest('directory-list',['directories'=>$paths],$server??$uploadServer,$user??$uploadUser,$token);
}
$directoryDefaults = ['directoryBatchLimit'=>48,'directoryConcurrency'=>2,'directoryTimeoutSeconds'=>8];
check($settings->directory()===$directoryDefaults,'directory settings have bounded stable defaults');
$directorySettings = new DirectorySettingsController();
$discoveryRequest=transferRequest('directory-settings',[],$uploadServer,$uploadUser);
check($discoveryRequest->authorize() && $directorySettings($discoveryRequest,$uploadServer)->getData(true)===$directoryDefaults,
    'directory settings require file-read and return exact defaults');
$directoryReq=directoryRequest(['','world',' leading and trailing ','città']);
check($directoryReq->authorize() && $directoryReq->validated()['directories']===['','world',' leading and trailing ','città'],
    'directory root and exact names survive native trim/null middleware');
foreach ([2,new Laravel\Sanctum\TransientToken(),null] as $token) {
    check(!directoryRequest([''],null,null,$token)->authorize(),'directory listing rejects nonaccount token');
    check(!transferRequest('directory-settings',[],$uploadServer,$uploadUser,$token)->authorize(),'directory settings reject nonaccount token');
}
check(!directoryRequest([''],null,$unrelatedUser)->authorize(),'directory listing rejects missing native file-read permission');
$subuser->setRawAttributes(['user_id'=>900,'permissions'=>'["file.read"]']);
$uploadServer->setRelation('subusers',collect([$subuser]));
check(directoryRequest([''],null,$unrelatedUser)->authorize(),'directory request uses native file-read rather than file-read-content');
$seen=[];$repo=directoryRepo([], $seen);$directoryController=new DirectoryListController($repo);
denied(fn()=>$directoryController(directoryRequest([''],null,$unrelatedUser),$uploadServer),403,'directory listing rejects subuser despite native permission');
denied(fn()=>$directoryController(directoryRequest([''],null,$adminUser),$uploadServer),403,'directory listing rejects administrator');
$uploadServer->setRelation('subusers',collect());
$foreign=clone $uploadServer;$foreign->uuid='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
denied(fn()=>$directoryController(directoryRequest([''],$foreign),$foreign),403,'directory listing rejects unmanaged server');
$foreign=clone $uploadServer;$foreign->external_id='foreign';
denied(fn()=>$directoryController(directoryRequest([''],$foreign),$foreign),409,'directory listing rejects changed provider identity');
check($seen===[],'all managed-identity denials occur before Wings access');
check($access->handle($directoryReq,fn()=>true)===true,'directory listing native state middleware passes');
$uploadServer->status=Pterodactyl\Models\Server::STATUS_SUSPENDED;
denied(fn()=>$access->handle($directoryReq,fn()=>true),409,'directory listing rejects suspended server');
$uploadServer->status=null;
foreach ([[],['',''],['a','a'],['named'=>'a'],[null],[1],[false],['/'],['/a'],['a/'],['a//b'],['.'],['..'],['a/../b'],['a/./b'],['a\\b'],['%2f'],["a\0b"],["a\nb"],[str_repeat('a',4097)],array_map(fn($n)=>'d'.$n,range(1,49))] as $paths) {
    try { directoryRequest($paths); throw new LogicException('expected invalid directories'); }
    catch (Illuminate\Validation\ValidationException $error) { check(true,'directory listing rejects invalid or excessive canonical paths'); }
}
$oversized=clone $directoryReq;$oversized->initialize([],[],[],[],[],[],str_repeat('x',512*1024+1));
denied(fn()=>$oversized->authorize(),413,'directory request bounds raw JSON');
$nonJson=clone $directoryReq;$nonJson->headers->set('Content-Type','text/plain');
denied(fn()=>(new ReflectionMethod($nonJson,'prepareForValidation'))->invoke($nonJson),415,'directory request requires JSON');

$item=['name'=>'server.properties','mode'=>'-rw-r--r--','mode_bits'=>'0644','size'=>128,'file'=>true,'symlink'=>false,
    'mime'=>'text/plain','created'=>'2026-01-01T00:00:00Z','modified'=>'2026-01-02T00:00:00Z'];
$seen=[];$repo=directoryRepo([new Response(200,[],json_encode([$item])),new Response(404,[],'secret upstream message'),new Response(403),new Response(500),new Response(200,[],'[]')],$seen);
$directoryController=new DirectoryListController($repo);
$body=$directoryController(directoryRequest(['','missing','private','failed','empty']),$uploadServer);
$results=$body->getData(true)['results'];
check($body->headers->get('Cache-Control')==='no-store, private' && array_column($results,'directory')===['','missing','private','failed','empty'],
    'directory response is private and preserves requested order');
check($results[0]['files']===[(new Pterodactyl\Transformers\Api\Client\FileObjectTransformer())->transform($item)]
    && $results[1]['error']==='not_found' && $results[2]['error']==='forbidden' && $results[3]['error']==='unavailable'
    && $results[4]['files']===[], 'native transformation and explicit ordered partial results');
check(!str_contains($body->getContent(),'secret') && !str_contains($body->getContent(),'wings.example'),'directory results never disclose upstream errors or endpoints');
parse_str($seen[0]['request']->getUri()->getQuery(),$query);
check($query===['directory'=>'/'] && $seen[0]['request']->getUri()->getPath()==='/api/servers/'.$uploadServer->uuid.'/files/list-directory',
    'directory root uses native Wings route and exact registered UUID');
check($seen[0]['options']['timeout']<=8 && $seen[0]['options']['connect_timeout']<=2 && !$seen[0]['options']['allow_redirects'],
    'directory reads override native long timeout and disable redirects');

DB::connection()->enableQueryLog();DB::connection()->flushQueryLog();
$seen=[];$repo=directoryRepo(array_fill(0,48,new Response(200,[],'[]')),$seen);
(new DirectoryListController($repo))(directoryRequest(array_map(fn($n)=>'d'.$n,range(1,48))),$uploadServer);
$queries=DB::connection()->getQueryLog();DB::connection()->disableQueryLog();
check(count($seen)===48 && count($queries)===5,'48 listings use three setting reads and two managed-identity reads total');

// Native Guzzle promises with deferred fake responses, never a network socket.
$repo=new MemoryDirectoryRepository($app);$repo->setServer($uploadServer);
$active=0;$peak=0;$calls=0;$timeouts=[];
$repo->client=new GuzzleHttp\Client(['handler'=>function($request,$options)use(&$active,&$peak,&$calls,&$timeouts){
    $active++;$calls++;$peak=max($peak,$active);$timeouts[]=$options['timeout'];
    $promise=null;
    $promise=new Promise(function()use(&$promise,&$active,$options){
        $response=new Response(200,[],'[]');$options['on_headers']($response);$options['sink']->write('[]');
        $active--;$promise->resolve($response);
    });return $promise;
}]);
foreach([1,2,4]as$concurrency){
    $peak=0;$calls=0;
    $results=$repo->listDirectories(['a','b','c','d','e'],array_replace($directoryDefaults,['directoryConcurrency'=>$concurrency]));
    check($peak===$concurrency && $active===0 && $calls===5 && count(array_filter($results,fn($r)=>isset($r['files'])))===5,
        'bounded native async batches enforce configured concurrency '.$concurrency);
}

// A native multi handler may settle other requests while waiting on one promise.
// Complete each admitted batch in reverse order, including rejected requests, to
// prove every slot is joined before admitting more work and results remain ordered.
foreach ([1,2,4] as $concurrency) {
    $active=0;$peak=0;$calls=0;$pending=[];$completed=[];$overlap=false;
    $repo->client=new GuzzleHttp\Client(['handler'=>function($request,$options)use(&$active,&$peak,&$calls,&$pending,&$completed,&$overlap,$concurrency,$item){
        if ($calls % $concurrency === 0 && $active !== 0) { $overlap=true; }
        $index=$calls++;$active++;$peak=max($peak,$active);
        $promise=new Promise(function()use(&$pending,&$active,&$completed,$item){
            foreach (array_reverse(array_keys($pending)) as $index) {
                [$promise,$options]=$pending[$index];unset($pending[$index]);$active--;$completed[]=$index;
                if ($index===2) { $promise->reject(new RuntimeException('Read failed'));continue; }
                $body=$index===7?'invalid-json':json_encode([array_replace($item,['name'=>'entry'.$index])]);
                $response=new Response($index===1?404:200,[],$body);
                try { $options['on_headers']($response);$options['sink']->write($body);$promise->resolve($response); }
                catch (Throwable $error) { $promise->reject($error); }
            }
        });
        $pending[$index]=[$promise,$options];return $promise;
    }]);
    $paths=array_map(fn($index)=>'directory'.$index,range(0,47));
    $results=$repo->listDirectories($paths,array_replace($directoryDefaults,['directoryConcurrency'=>$concurrency]));
    check($calls===48 && $peak===$concurrency && $active===0 && $pending===[] && !$overlap,
        '48 native promises drain each bounded batch despite out-of-order failures at concurrency '.$concurrency);
    check(array_column($results,'directory')===$paths && $results[1]['error']==='not_found'
        && $results[2]['error']==='unavailable' && $results[7]['error']==='unavailable'
        && count(array_filter($results,fn($result)=>isset($result['files'])))===45
        && $results[47]['files'][0]['name']==='entry47',
        'out-of-order completion preserves all successful and failed result slots at concurrency '.$concurrency);
}

$active=0;$calls=0;
$repo->client=new GuzzleHttp\Client(['handler'=>function($request,$options)use(&$active,&$calls){
    $index=$calls++;$active++;$promise=null;
    $promise=new Promise(function()use(&$promise,&$active,$index,$options){
        $active--;$response=new Response($index===0?429:200,[],'[]');
        try { $options['on_headers']($response);$options['sink']->write('[]');$promise->resolve($response); }
        catch (Throwable $error) { $promise->reject($error); }
    });return $promise;
}]);
$results=$repo->listDirectories(['limited','already-admitted','queued-a','queued-b'],$directoryDefaults);
check($calls===2 && $active===0 && $results[1]['files']===[]
    && $results[0]['error']==='unavailable' && $results[2]['error']==='unavailable' && $results[3]['error']==='unavailable',
    '429 drains the other admitted request and stops the next concurrent batch');

// A whole-batch deadline includes paths still waiting for a concurrency slot.
$repo->clock=0;$calls=0;
$repo->client=new GuzzleHttp\Client(['handler'=>function($request,$options)use($repo,&$calls){
    $calls++;$promise=null;
    $promise=new Promise(function()use(&$promise,$repo,$options){$repo->clock=9;$options['sink']->write('[]');$promise->resolve(new Response(200,[],'[]'));});
    return $promise;
}]);
$results=$repo->listDirectories(['a','b','c','d'],$directoryDefaults);
check($calls===2 && array_column($results,'error')===array_fill(0,4,'deadline_exceeded'),'deadline aborts inflight body and does not dispatch queued directories');
$seen=[];$repo=directoryRepo([new Response(429,[],'secret'),new Response(200,[],'[]')],$seen);
$results=$repo->listDirectories(['a','b','c'],array_replace($directoryDefaults,['directoryConcurrency'=>1]));
check(count($seen)===1 && array_column($results,'error')===array_fill(0,3,'unavailable'),'429 stops new Wings requests without retry or fallback');

$seen=[];$repo=directoryRepo([new Response(200,['Content-Length'=>DirectoryListingRepository::DIRECTORY_BYTES+1],'[]'),
    new Response(200,[],str_repeat(' ',DirectoryListingRepository::DIRECTORY_BYTES+1)),
    new Response(200,[],'{"not":"a list"}'),new Response(200,[],'invalid-json'),new Response(200,[],'[]')],$seen);
$results=$repo->listDirectories(['header','chunked','object','malformed','empty'],$directoryDefaults);
check(array_column(array_slice($results,0,4),'error')===['too_large','too_large','unavailable','unavailable'] && $results[4]['files']===[],
    'streaming and declared per-directory limits fail explicitly without poisoning later paths');
$seen=[];$repo=directoryRepo([new Response(200,[],json_encode(array_fill(0,10001,$item)))],$seen);
check($repo->listDirectories(['many'],$directoryDefaults)[0]['error']==='too_large','entry bound rejects whole directory rather than truncate');
$large=json_encode([array_replace($item,['name'=>str_repeat('a',3000000)])]);
$seen=[];$repo=directoryRepo(array_fill(0,4,new Response(200,[],$large)),$seen);
$results=$repo->listDirectories(['a','b','c','d'],array_replace($directoryDefaults,['directoryConcurrency'=>1]));
check(count($seen)===3 && isset($results[0]['files'],$results[1]['files']) && $results[2]['error']==='too_large' && $results[3]['error']==='too_large',
    'aggregate streamed body budget bounds the entire batch and stops pending reads');
// JSON escaping expands output independently of the raw input budget.
$expanding=json_encode([array_replace($item,['name'=>str_repeat('<',2200000)])],JSON_UNESCAPED_SLASHES);
$seen=[];$repo=directoryRepo([new Response(200,[],$expanding)],$seen);
check($repo->listDirectories(['expanded'],$directoryDefaults)[0]['error']==='too_large','serialized output has an independent bounded aggregate budget');
$settings->saveOperational(['directoryBatchLimit'=>1,'directoryConcurrency'=>1,'directoryTimeoutSeconds'=>1]);
check($directorySettings(transferRequest('directory-settings',[],$uploadServer,$uploadUser),$uploadServer)->getData(true)===
    ['directoryBatchLimit'=>1,'directoryConcurrency'=>1,'directoryTimeoutSeconds'=>1],'directory settings expose Owner overrides');
try{directoryRequest(['a','b']);throw new LogicException('expected limit');}catch(Illuminate\Validation\ValidationException $error){check(true,'directory validator applies configured count');}
$settings->saveOperational(['directoryBatchLimit'=>48,'directoryConcurrency'=>4,'directoryTimeoutSeconds'=>8]);
$settings->saveOperational(['downloadBatchLimit'=>$settings->transfer()['downloadBatchLimit']]);
check((new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\Settings())->directory()===
    ['directoryBatchLimit'=>48,'directoryConcurrency'=>4,'directoryTimeoutSeconds'=>8],
    'stable settings preserve an existing Owner concurrency override across reads and unrelated saves');
$settings->saveOperational($directoryDefaults);

// The identity fixture owns only SQLite memory state. Roll back its additional native columns.
DB::beginTransaction();
try {
    $schema = DB::connection()->getSchemaBuilder();
    $schema->table('servers', function ($t) {
        foreach (['allocation_id','nest_id','egg_id'] as $name) { $t->integer($name)->default(1); }
    });
    $schema->table('api_keys', function ($t) {
        foreach (['r_servers','r_allocations'] as $name) { $t->integer($name)->default(1); }
        $t->timestamp('expires_at')->nullable();
    });
    $schema->create('allocations', function ($t) {
        foreach (['id','server_id','node_id','port'] as $name) { $t->integer($name); }
        $t->string('ip');
    });
    DB::table('allocations')->insert(['id'=>1,'server_id'=>2,'node_id'=>$uploadServer->node_id,'port'=>25565,'ip'=>'2001:db8::1']);
    DB::table('users')->where('id',1)->update(['root_admin'=>true]);
    DB::table('nickhosting_users')->where('provider_id',$uploadUser->id)->update(['technical'=>true]);
    $linked = DB::table('nickhosting_users')->where('provider_id',$uploadUser->id)->first();
    $testKey = static function ($id, $type, $ownerId) {
        DB::table('api_keys')->insert(['id'=>$id,'identifier'=>'fixture-key-'.$id,'key_type'=>$type,
            'user_id'=>$ownerId,'token'=>'opaque-'.$id,'memo'=>'','allowed_ips'=>'[]']);
        return Pterodactyl\Models\ApiKey::query()->findOrFail($id);
    };
    $appKey = $testKey(8001,2,1);
    $clientKey = $testKey(8002,1,$uploadUser->id);
    DB::table('nickhosting_instances')->where('id',$instance)->update(['api_key_id'=>$appKey->id]);
    $proof = ['principal'=>Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\WorldScanAccess::principal($appKey),
        'clientKeyIdentifier'=>$clientKey->identifier,
        'instanceId'=>$instance,'nickUserId'=>$linked->nick_user_id,'ownerUuid'=>$uploadUser->uuid,
        'ownerExternalId'=>$uploadUser->external_id,'server'=>Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\Protocol::identity($uploadServer),
        'placement'=>[$uploadUser->id,1,1,1], 'allocations'=>[[1,'2001:db8:0:0::1',25565]]];
    $worldRequest = static function ($dirs, $claim) use ($clientKey,$uploadServer,$uploadUser) {
        $r=transferRequest('directory-list',['directories'=>$dirs,'worldScan'=>$claim],$uploadServer,$uploadUser);
        $r->user()->withAccessToken($clientKey);
        return $r;
    };
    $seen=[]; $controller = new DirectoryListController(directoryRepo([new Response(200,[],'[]')], $seen));
    $success=$controller->worlds($worldRequest([''],$proof),$uploadServer)->getData(true);
    $grant = $success['propertiesGrant']['urls'][0];
    parse_str(parse_url($grant, PHP_URL_QUERY),$q);
    $claims=$config->parser()->parse($q['token'])->claims();
    check($success['schemaVersion']===1 && $claims->get('file_path')==='/server.properties'
        && $claims->get('server_uuid')===$uploadServer->uuid && count($seen)===1,
        'guarded root returns exact properties grant with one authenticated Client operation');
    $exactPaths=[' world/level.dat','world/level.dat'];
    $r=Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Requests\DownloadUrlsRequest::create(
        '/api/client/extensions/nickhosting/servers/fixture/world-download-urls','POST',[],[],[],
        ['CONTENT_TYPE'=>'application/json'],json_encode(['paths'=>$exactPaths,'worldScan'=>$proof],JSON_THROW_ON_ERROR));
    $r->setUserResolver($worldRequest([''],$proof)->getUserResolver());
    (new Pterodactyl\Http\Middleware\TrimStrings())->handle($r,fn()=>null);
    (new Illuminate\Foundation\Http\Middleware\ConvertEmptyStringsToNull())->handle($r,fn()=>null);
    (new ReflectionMethod($r,'prepareForValidation'))->invoke($r);
    $v=$validator->make($r->all(),$r->rules()); $v->validate(); $r->setContainer($app); $r->setValidator($v);
    $worldTokens=$downloads->worlds($r,$uploadServer)->getData(true)['urls'];
    foreach ($exactPaths as $i => $path) {
        parse_str(parse_url($worldTokens[$i],PHP_URL_QUERY),$q);
        check($config->parser()->parse($q['token'])->claims()->get('file_path')==='/'.$path,
            'native guarded download signs exact untrimmed level.dat path at position '.$i);
    }
    foreach ([[''],['world','second-world']] as $samplePaths) {
        $counts=[];
        foreach (['ordinary', 'guarded'] as $kind) {
            $r=$worldRequest($samplePaths,$proof);
            $sampleSeen=[];
            $sampleController=new DirectoryListController(directoryRepo(array_fill(0,count($samplePaths),new Response(200,[],'[]')),$sampleSeen));
            DB::flushQueryLog(); DB::enableQueryLog();
            $kind === 'ordinary' ? $sampleController($r,$uploadServer) : $sampleController->worlds($r,$uploadServer);
            $counts[$kind]=count(DB::getQueryLog());
            DB::disableQueryLog();
            check(count($sampleSeen) === count($samplePaths), 'one Wings listing per sampled directory');
        }
        check($counts['guarded'] < 40, 'bounded native SQL for '.($samplePaths===['']?'root':'two-directory batch')
            .' (ordinary '.$counts['ordinary'].', guarded '.$counts['guarded'].', includes post-Wings recheck)');
    }
    DB::table('api_keys')->where('id',8001)->update(['allowed_ips'=>'["192.0.2.10", "192.0.2.16/28"]']);
    $restricted=$proof;
    $restricted['principal']=Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\WorldScanAccess::principal($appKey->fresh());
    foreach (['192.0.2.10','192.0.2.20','198.51.100.7'] as $ip) {
        $r=$worldRequest(['world'],$restricted);
        $r->server->set('REMOTE_ADDR',$ip);
        $checkSource=fn()=>(new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\WorldScanAccess())->authorize($r,$uploadServer);
        if ($ip === '198.51.100.7') { denied($checkSource,403,'excluded Worker source IP is rejected'); }
        else { check($checkSource()->id === $uploadUser->id,'shared discovery supports authorized Worker source '.$ip); }
    }
    DB::table('api_keys')->where('id',8001)->update(['allowed_ips'=>'[]']);
    $seen=[];$controller = new DirectoryListController(directoryRepo([], $seen));
    foreach (['instanceId'=>'wrong','ownerUuid'=>'wrong','server'=>array_replace($proof['server'],['nodeId'=>9]),
            'placement'=>[$uploadUser->id,1,2,1],'allocations'=>[[1,'2001:db8::2',25565]]] as $field=>$value) {
        denied(fn()=>$controller->worlds($worldRequest([''],array_replace($proof,[$field=>$value])),$uploadServer),
            409,'guarded reads reject drift in '.$field);
    }
    DB::table('allocations')->insert(['id'=>2,'server_id'=>2,'node_id'=>$uploadServer->node_id,'port'=>25566,'ip'=>'127.0.0.1']);
    denied(fn()=>$controller->worlds($worldRequest(['world'],$proof),$uploadServer),409,'guarded child listing rejects additional allocation');
    $filesRequest=downloadRequest(['paths'=>['world/level.dat'],'worldScan'=>$proof],$uploadServer,$uploadUser);
    $filesRequest->user()->withAccessToken($clientKey);
    denied(fn()=>$downloads->worlds($filesRequest,$uploadServer),409,'guarded level.dat grants reject allocation drift before signing');
    DB::table('allocations')->where('id',2)->delete();
    $afterAccess=directoryRepo([], $seen);
    $afterAccess->client=new GuzzleHttp\Client(['handler'=>function() {
        DB::table('allocations')->where('id',1)->update(['port'=>25566]);
        return GuzzleHttp\Promise\Create::promiseFor(new Response(200,[],'[]'));
    }]);
    denied(fn()=>(new DirectoryListController($afterAccess))->worlds($worldRequest([''],$proof),$uploadServer),
        409,'changed allocation during Wings listing withholds both metadata and properties grant');
    DB::table('allocations')->where('id',1)->update(['port'=>25565]);
    DB::table('api_keys')->where('id',8001)->update(['r_allocations'=>0]);
    denied(fn()=>$controller->worlds($worldRequest([''],$proof),$uploadServer),403,'revoked Application allocation ACL stops filesystem access');
    DB::table('api_keys')->where('id',8001)->update(['r_allocations'=>1,'token'=>'rotated']);
    denied(fn()=>$controller->worlds($worldRequest([''],$proof),$uploadServer),403,'rotated Application key revokes discovery principal');
    DB::table('api_keys')->where('id',8001)->update(['token'=>'opaque-8001']);
    DB::table('nickhosting_users')->where('provider_id',$uploadUser->id)->update(['technical'=>false]);
    denied(fn()=>$controller->worlds($worldRequest([''],$proof),$uploadServer),412,'verified legacy account advertises standalone detail path');
    check($seen===[],'world scan preconditions deny before Wings and properties grant');
} finally { DB::rollBack(); }
