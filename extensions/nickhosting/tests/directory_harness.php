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

// Real Guzzle Pool with deferred fake promises, never a network socket.
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
        'native async Pool enforces configured concurrency '.$concurrency);
}

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
