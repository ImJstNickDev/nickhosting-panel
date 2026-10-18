<?php
// Vendor libraries plus SQLite :memory: and in-memory Guzzle handlers only. Never boots Panel.
use Illuminate\Support\Facades\DB;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\Protocol;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\FileOperationRepository;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\FileOperationController;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\ArchiveCommitController;

class MemoryFileOperationRepository extends FileOperationRepository
{
    public GuzzleHttp\Client $client;
    public int $clientCalls = 0;
    public ?float $clock = null;
    protected function now(): float { return $this->clock ?? parent::now(); }
    // Match native DaemonRepository: every acquisition creates a new client.
    public function getHttpClient(array $headers = []): GuzzleHttp\Client {
        $config = $this->client->getConfig();
        $config['headers']['X-Fixture-Client'] = (string) ++$this->clientCalls;
        $config['headers']['X-Fixture-Server'] = $this->server->uuid;
        return new GuzzleHttp\Client($config);
    }
}
function operationRepo(array $responses, array &$requests): MemoryFileOperationRepository {
    global $app, $uploadServer;
    $mock = new GuzzleHttp\Handler\MockHandler($responses);
    $repository = new MemoryFileOperationRepository($app);
    $repository->client = new GuzzleHttp\Client(['handler' => function ($request, $options) use ($mock, &$requests) {
        $requests[] = ['request' => $request, 'options' => $options];
        return $mock($request, $options);
    }]);
    $repository->setServer($uploadServer);
    return $repository;
}
function operationRequest(string $kind, array $body, $user = null, $server = null) {
    global $uploadServer, $uploadUser;
    return transferRequest($kind, $body, $server ?? $uploadServer, $user ?? $uploadUser);
}
function operationEntry(string $name, bool $file = false, int $size = 4096): array {
    return ['name' => $name, 'mode' => $file ? '-rw-r--r--' : 'drwxr-xr-x', 'mode_bits' => $file ? '0644' : '0755',
        'size' => $size, 'file' => $file, 'symlink' => false, 'mime' => $file ? 'application/octet-stream' : 'inode/directory',
        'created' => '2026-10-18T12:00:00Z', 'modified' => '2026-10-18T12:00:00Z'];
}
function operationListing(array $entries) { return new GuzzleHttp\Psr7\Response(200, [], json_encode($entries)); }
$operationGuard = "level-name=active\n";
$operationDirectory = operationEntry('unused');
$operationGuardEntry = operationEntry('server.properties',true,strlen($operationGuard));
$operationRequests = [];
$operationRepository = operationRepo([operationListing([$operationDirectory,$operationGuardEntry]), new GuzzleHttp\Psr7\Response(200, [], $operationGuard)], $operationRequests);
$operationController = new FileOperationController($operationRepository);
$inspection = $operationController->inspect(operationRequest('file-inspection', ['target' => 'unused', 'guardFile' => 'server.properties']), $uploadServer)->getData(true);
check($inspection['guard']['contents'] === $operationGuard && $inspection['guard']['sha256'] === hash('sha256', $operationGuard)
    && $inspection['identity'] === Protocol::identity($uploadServer) && strlen($inspection['target']['observation']) === 64,
    'file inspection returns exact guarded bytes, scoped identity and metadata observation');
check(count($operationRequests) === 2 && $operationRequests[0]['request']->getMethod() === 'GET'
    && $operationRequests[1]['request']->getMethod() === 'GET', 'one inspection uses only native listing and bounded contents');
check($operationRepository->clientCalls === 1, 'inspection acquires one native client for concurrent reads');
$operationInput = ['operationId' => '12345678-1234-4234-8234-123456789001', 'identity' => $inspection['identity'],
    'target' => $inspection['target'], 'guard' => ['path' => 'server.properties', 'sha256' => $inspection['guard']['sha256']]];
foreach ([2, new Laravel\Sanctum\TransientToken(), null] as $badToken) {
    check(!transferRequest('guarded-delete', $operationInput, $uploadServer, $uploadUser, $badToken)->authorize(), 'guarded delete rejects nonaccount tokens');
}
$operationRequests = [];
$operationController = new FileOperationController(operationRepo([], $operationRequests));
denied(fn () => $operationController->inspect(operationRequest('file-inspection', ['target'=>'unused','guardFile'=>'server.properties'], $adminUser), $uploadServer), 403, 'file inspection rejects admin credential');
denied(fn () => $operationController->delete(operationRequest('guarded-delete', $operationInput, $unrelatedUser), $uploadServer), 403, 'guarded delete rejects unrelated user');
$foreignOperation = $operationInput; $foreignOperation['identity']['externalId'] = 'foreign';
denied(fn () => $operationController->delete(operationRequest('guarded-delete', $foreignOperation), $uploadServer), 409, 'guarded delete rejects mismatched expected identity before dispatch');
check($operationRequests === [] && DB::table('nickhosting_file_operations')->count() === 0, 'identity denials do not read Wings or reserve receipts');
foreach (['../world', '/world', 'world/', 'a//b', 'world\\a', 'x%2fworld', "a\0b", str_repeat('é', 2049)] as $path) {
    try { operationRequest('file-inspection', ['target' => $path, 'guardFile' => 'server.properties']); throw new LogicException('Expected path rejection'); }
    catch (Illuminate\Validation\ValidationException $error) { check(true, 'file inspection rejects noncanonical path'); }
}
$operationRequests = [];
$operationController = new FileOperationController(operationRepo([operationListing([$operationDirectory,$operationGuardEntry]), new GuzzleHttp\Psr7\Response(200, [], $operationGuard), new GuzzleHttp\Psr7\Response(204)], $operationRequests));
$deleted = $operationController->delete(operationRequest('guarded-delete', $operationInput), $uploadServer)->getData(true);
check($deleted['state'] === 'confirmed' && DB::table('nickhosting_file_operations')->where('operation_id', $operationInput['operationId'])->value('state') === 'confirmed', 'guarded deletion persists confirmed receipt');
check(count($operationRequests) === 3 && json_decode((string)$operationRequests[2]['request']->getBody(), true) === ['root'=>'/', 'files'=>['unused']], 'guarded deletion sends one native delete with exact path');
$deleteReplay = $operationController->delete(operationRequest('guarded-delete', $operationInput), $uploadServer)->getData(true);
check($deleteReplay === $deleted && count($operationRequests) === 3, 'confirmed receipt retry never deletes a recreated directory');
$changedRetry = $operationInput; $changedRetry['guard']['sha256'] = str_repeat('a', 64);
denied(fn () => $operationController->delete(operationRequest('guarded-delete', $changedRetry), $uploadServer), 409, 'operation UUID cannot be reused for altered input');

$operationRequests = [];
$changedInput = $operationInput; $changedInput['operationId'] = '12345678-1234-4234-8234-123456789002';
$operationController = new FileOperationController(operationRepo([operationListing([$operationDirectory,$operationGuardEntry]), new GuzzleHttp\Psr7\Response(200, [], 'level-name=unused')], $operationRequests));
denied(fn () => $operationController->delete(operationRequest('guarded-delete', $changedInput), $uploadServer), 409, 'changed guard rejects before native mutation');
check(count($operationRequests) === 2 && DB::table('nickhosting_file_operations')->where('operation_id',$changedInput['operationId'])->value('state') === 'rejected', 'pre-effect rejection has no uncertain deletion');
denied(fn () => $operationController->delete(operationRequest('guarded-delete', $changedInput), $uploadServer), 409, 'rejected operation retry remains rejected without I/O');
$changedDirectory = $operationDirectory; $changedDirectory['modified'] = '2026-10-18T13:00:00Z';
$changedInput['operationId'] = '12345678-1234-4234-8234-123456789003'; $operationRequests = [];
$operationController = new FileOperationController(operationRepo([operationListing([$changedDirectory,$operationGuardEntry]), new GuzzleHttp\Psr7\Response(200, [], $operationGuard)], $operationRequests));
denied(fn () => $operationController->delete(operationRequest('guarded-delete', $changedInput), $uploadServer), 409, 'changed target observation rejects before delete');
$uncertainInput = $operationInput; $uncertainInput['operationId'] = '12345678-1234-4234-8234-123456789004'; $operationRequests = [];
$operationController = new FileOperationController(operationRepo([operationListing([$operationDirectory,$operationGuardEntry]), new GuzzleHttp\Psr7\Response(200, [], $operationGuard), new GuzzleHttp\Psr7\Response(500)], $operationRequests));
check($operationController->delete(operationRequest('guarded-delete', $uncertainInput), $uploadServer)->getData(true)['state'] === 'uncertain', 'failed native response remains uncertain');
check($operationController->delete(operationRequest('guarded-delete', $uncertainInput), $uploadServer)->getData(true)['state'] === 'uncertain' && count($operationRequests) === 3, 'uncertain native deletion never replays');
DB::table('nickhosting_file_operations')->where('operation_id', $uncertainInput['operationId'])->update(['state'=>'prepared']);
check($operationController->delete(operationRequest('guarded-delete', $uncertainInput), $uploadServer)->getData(true)['state'] === 'uncertain' && count($operationRequests) === 3, 'crashed prepared receipt fails closed without another delete');
foreach ([new GuzzleHttp\Psr7\Response(200, ['Content-Length'=>1048577], ''), new GuzzleHttp\Psr7\Response(200, [], str_repeat('x',1048577))] as $large) {
    $operationRequests = []; $operationRepository = operationRepo([operationListing([$operationDirectory,$operationGuardEntry]), $large], $operationRequests);
    denied(fn () => $operationRepository->inspect('unused', 'server.properties'), 413, 'guard response bounded with and without declared length');
}
$symlinkOperation = $operationDirectory; $symlinkOperation['symlink'] = true; $operationRequests = [];
$operationRepository = operationRepo([operationListing([$symlinkOperation,$operationGuardEntry]), new GuzzleHttp\Psr7\Response(200, [], $operationGuard)], $operationRequests);
denied(fn () => $operationRepository->inspect('unused','server.properties'), 409, 'guarded target must be a real directory');

foreach ([
    [$operationDirectory,$operationGuardEntry,array_replace($operationGuardEntry,['name'=>'SERVER.PROPERTIES'])],
    [$operationDirectory,array_replace($operationGuardEntry,['symlink'=>true])],
    [$operationDirectory,array_replace($operationGuardEntry,['file'=>false])],
    [$operationDirectory,$operationGuardEntry,array_replace($operationDirectory,['name'=>'UNUSED'])],
] as $invalidEntries) {
    $operationRequests=[]; $operationRepository=operationRepo([operationListing($invalidEntries),new GuzzleHttp\Psr7\Response(200,[],$operationGuard)],$operationRequests);
    denied(fn()=>$operationRepository->inspect('unused','server.properties'),409,'guard inspection rejects aliases and nonregular or symlink guards');
}

$archiveInput = ['operationId'=>'12345678-1234-4234-8234-123456789101', 'identity'=>Protocol::identity($uploadServer),
    'destinationRoot'=>'imported', 'archiveSha256'=>str_repeat('b',64), 'files'=>[['path'=>'imported/level.dat','size'=>123]]];
function archiveResponses(array $input, bool $missingFile = false, bool $missingPublish = false): array {
    $scratch = operationEntry('.nickhosting-import-'.$input['operationId']); $payload=operationEntry('payload.zip',true,42);
    $destination = operationEntry($input['destinationRoot']);
    return [operationListing([$scratch]), operationListing([$payload]), new GuzzleHttp\Psr7\Response(204),
        operationListing([$payload,$destination]), operationListing($missingFile ? [] : [operationEntry('level.dat',true,123)]),
        operationListing([$scratch]), new GuzzleHttp\Psr7\Response(204), operationListing($missingPublish ? [$scratch] : [$scratch,$destination]),
        operationListing([$payload]), new GuzzleHttp\Psr7\Response(204)];
}
$operationRequests = [];
$archiveRepository = operationRepo(archiveResponses($archiveInput), $operationRequests);
$archiveController = new ArchiveCommitController($archiveRepository);
$committed = $archiveController(operationRequest('archive-commit', $archiveInput), $uploadServer)->getData(true);
check($committed['state'] === 'confirmed' && $committed['archiveSha256'] === $archiveInput['archiveSha256'], 'archive commit verifies tree and publishes with durable receipt');
check($archiveRepository->clientCalls === 1 && count(array_unique(array_map(fn($call) => $call['request']->getHeaderLine('X-Fixture-Client'), $operationRequests))) === 1,
    'entire commit including cleanup reuses one native client');
check(!array_key_exists('timings', $committed), 'normal archive receipts have no profiling payload');
$archiveMutations = array_values(array_filter($operationRequests, fn($call)=>$call['request']->getMethod() !== 'GET'));
check(count($archiveMutations) === 3 && str_ends_with((string)$archiveMutations[0]['request']->getUri(), '/files/decompress')
    && str_ends_with((string)$archiveMutations[1]['request']->getUri(), '/files/rename')
    && str_ends_with((string)$archiveMutations[2]['request']->getUri(), '/files/delete'), 'archive executes one extract, one publish and one scoped cleanup');
$beforeReplay = count($operationRequests);
check($archiveController(operationRequest('archive-commit', $archiveInput), $uploadServer)->getData(true) === $committed && count($operationRequests) === $beforeReplay,
    'archive receipt replay performs no repeated extraction or publish');
$archiveChanged = $archiveInput; $archiveChanged['files'][0]['size']++;
denied(fn () => $archiveController(operationRequest('archive-commit', $archiveChanged),$uploadServer),409,'archive receipt refuses changed manifest');
foreach ([[true,false],[false,true]] as $failure) {
    $archiveInput['operationId'] = $failure[0] ? '12345678-1234-4234-8234-123456789102' : '12345678-1234-4234-8234-123456789103';
    $operationRequests = []; $archiveController = new ArchiveCommitController(operationRepo(archiveResponses($archiveInput,...$failure), $operationRequests));
    check($archiveController(operationRequest('archive-commit',$archiveInput),$uploadServer)->getData(true)['state'] === 'uncertain', 'missing extracted file or missing rename readback cannot succeed');
    $beforeReplay=count($operationRequests);
    check($archiveController(operationRequest('archive-commit',$archiveInput),$uploadServer)->getData(true)['state'] === 'uncertain' && count($operationRequests)===$beforeReplay,
        'partial archive operation preserves stage without replay or cleanup');
}
$archiveInput['operationId']='12345678-1234-4234-8234-123456789104'; $operationRequests=[];
$archiveController = new ArchiveCommitController(operationRepo([operationListing([operationEntry('imported')]), operationListing([operationEntry('payload.zip',true,42)])],$operationRequests));
denied(fn()=>$archiveController(operationRequest('archive-commit',$archiveInput),$uploadServer),409,'existing destination is rejected before extraction');
check(count($operationRequests)===2 && DB::table('nickhosting_file_operations')->where('operation_id',$archiveInput['operationId'])->value('state')==='rejected','collision has no uncertain publication and no native write');

// Public invocations acquire fresh node-bound clients; no persistent client may
// survive a later setServer(), including after an unsuccessful inspection.
$operationRequests=[];
$operationRepository=operationRepo([
    operationListing([$operationDirectory,$operationGuardEntry]), new GuzzleHttp\Psr7\Response(200,[],$operationGuard),
    new GuzzleHttp\Psr7\Response(204),
    operationListing([$operationDirectory,$operationGuardEntry]), new GuzzleHttp\Psr7\Response(200,[],$operationGuard),
],$operationRequests);
$operationRepository->inspect('unused','server.properties');
$operationRepository->deleteDirectory('unused');
$anotherServer=clone $uploadServer; $anotherServer->uuid='12345678-1234-4234-8234-123456789999';
$operationRepository->setServer($anotherServer)->inspect('unused','server.properties');
check($operationRepository->clientCalls===3
    && array_map(fn($call)=>$call['request']->getHeaderLine('X-Fixture-Client'),$operationRequests)===['1','1','2','3','3']
    && $operationRequests[4]['request']->getHeaderLine('X-Fixture-Server')===$anotherServer->uuid,
    'public inspect/delete calls refresh native clients and cannot retain another server binding');

// Real Guzzle promises with one event-loop handler. Each wait advances the next
// due request and runs Guzzle's callback queue, so rolling refill and draining
// are observable rather than hidden behind eager MockHandler responses.
class FileOperationAsyncHandler
{
    public array $pending=[];
    public array $requests=[];
    public array $events=[];
    public int $active=0;
    public int $verificationActive=0;
    public int $verificationPeak=0;
    public int $verificationCalls=0;
    public bool $extracted=false;
    public bool $published=false;
    public bool $cleaned=false;
    public string $failure='';
    public ?float $verificationDelay=null;
    public array $files=[];
    private array $tree=[];
    private string $scratch;

    public function __construct(private MemoryFileOperationRepository $repository, string $operationId, int $children=4) {
        $repository->clock=0;
        $this->scratch='.nickhosting-import-'.$operationId;
        $this->tree['']=[operationEntry('payload.zip',true,42),operationEntry('imported')];
        $this->tree['imported']=[];
        for($index=0;$index<$children;$index++) {
            $directory='part'.$index;
            $this->tree['imported'][]=operationEntry($directory);
            $this->tree['imported/'.$directory]=[operationEntry('data.bin',true,123)];
            $this->files[]=['path'=>'imported/'.$directory.'/data.bin','size'=>123];
        }
    }

    public function __invoke($request,array $options): GuzzleHttp\Promise\PromiseInterface {
        parse_str($request->getUri()->getQuery(),$query);
        $directory=$query['directory']??null;
        $verification=$this->extracted && !$this->published && $directory!==null && str_starts_with($directory,'/'.$this->scratch);
        $sequence=count($this->requests);
        $delay=0.01;
        if($verification) {
            $delay=$this->verificationDelay??($this->verificationCalls===0?7:1);
            if($this->failure==='invalid' && $this->verificationCalls===0) { $delay=0.5; }
            $this->verificationCalls++;
            $this->verificationActive++;
            $this->verificationPeak=max($this->verificationPeak,$this->verificationActive);
        }
        $this->active++;
        $this->requests[]=['request'=>$request,'options'=>$options,'verification'=>$verification];
        $this->events[]=['event'=>'start','sequence'=>$sequence,'verification'=>$verification,'at'=>$this->repository->clock];
        $promise=new GuzzleHttp\Promise\Promise(function()use($sequence){ $this->waitFor($sequence); });
        $this->pending[$sequence]=[
            'promise'=>$promise,'request'=>$request,'options'=>$options,'directory'=>$directory,
            'verification'=>$verification,'due'=>$this->repository->clock+min($delay,$options['timeout']),
            'timeout'=>$delay>$options['timeout'],
        ];
        return $promise;
    }

    private function waitFor(int $sequence): void {
        while(isset($this->pending[$sequence])) {
            $next=array_key_first($this->pending);
            foreach($this->pending as $index=>$candidate) {
                if($candidate['due']<$this->pending[$next]['due']) { $next=$index; }
            }
            $entry=$this->pending[$next]; unset($this->pending[$next]);
            $this->repository->clock=max($this->repository->clock,$entry['due']);
            $this->active--;
            if($entry['verification']) { $this->verificationActive--; }
            $this->events[]=['event'=>'finish','sequence'=>$next,'verification'=>$entry['verification'],'at'=>$this->repository->clock];
            try {
                if($entry['timeout']) { throw new RuntimeException('Fixture transport timeout'); }
                if($entry['verification'] && $this->failure==='deadline') { $this->repository->clock=31; }
                $response=$this->response($entry);
                $entry['options']['on_headers']($response);
                $body=(string)$response->getBody();
                if($body!=='' && $entry['options']['sink']->write($body)!==strlen($body)) {
                    throw new RuntimeException('Fixture body rejected');
                }
                $entry['promise']->resolve($response);
            } catch(Throwable $error) { $entry['promise']->reject($error); }
            GuzzleHttp\Promise\Utils::queue()->run();
        }
    }

    private function response(array $entry): GuzzleHttp\Psr7\Response {
        $endpoint=basename($entry['request']->getUri()->getPath());
        if($endpoint==='decompress') { $this->extracted=true; return new GuzzleHttp\Psr7\Response(204); }
        if($endpoint==='rename') { $this->published=true; return new GuzzleHttp\Psr7\Response(204); }
        if($endpoint==='delete') { $this->cleaned=true; return new GuzzleHttp\Psr7\Response(204); }
        if($entry['directory']==='/') {
            return operationListing($this->published?[operationEntry($this->scratch),operationEntry('imported')]:[operationEntry($this->scratch)]);
        }
        $relative=ltrim(substr($entry['directory'],strlen('/'.$this->scratch)),'/');
        if(!$this->extracted || $this->published) { return operationListing([operationEntry('payload.zip',true,42)]); }
        if($this->failure==='invalid' && $relative==='') { return operationListing([]); }
        return operationListing($this->tree[$relative]);
    }
}

function asyncArchiveFixture(string $operationId,int $children=4): array {
    global $app,$uploadServer;
    $repository=new MemoryFileOperationRepository($app);
    $handler=new FileOperationAsyncHandler($repository,$operationId,$children);
    $repository->client=new GuzzleHttp\Client(['handler'=>$handler]);
    $repository->setServer($uploadServer);
    return [$repository,$handler];
}

foreach([1,2,4] as $concurrency) {
    $settings->saveOperational(['directoryConcurrency'=>$concurrency]);
    $id='12345678-1234-4234-8234-12345678920'.$concurrency;
    [$repository,$handler]=asyncArchiveFixture($id);
    $stages=[];
    $repository->commitArchive($id,'imported',$handler->files,null,function($name,$duration)use(&$stages){$stages[$name]=$duration;});
    check($handler->verificationPeak===$concurrency && $handler->verificationCalls===6
        && $handler->active===0 && $handler->pending===[] && $handler->published && $handler->cleaned,
        'rolling archive verification enforces configured concurrency '.$concurrency.' and drains every promise');
    check($repository->clientCalls===1 && count($handler->requests)===14,
        'archive retains exact D+8 request count with one native client at concurrency '.$concurrency);
    check(count(array_filter($handler->requests,fn($call)=>($call['options']['stream']??false)||($call['options']['synchronous']??false)))===0,
        'all reads and mutations share asynchronous nonstreaming transport at concurrency '.$concurrency);
    if($concurrency===2) {
        $events=array_values(array_filter($handler->events,fn($event)=>$event['verification']));
        check($events[2]['event']==='finish' && $events[2]['sequence']!==$events[0]['sequence']
            && $events[3]['event']==='start' && abs($stages['verify_tree']-7000)<0.001,
            'rolling refill starts a third directory while the first is pending: 7s versus 9s paired or 12s serial');
    }
}
$settings->saveOperational(['directoryConcurrency'=>2]);

foreach(['invalid','deadline'] as $failure) {
    $id=$failure==='invalid'?'12345678-1234-4234-8234-123456789211':'12345678-1234-4234-8234-123456789212';
    [$repository,$handler]=asyncArchiveFixture($id);
    $handler->failure=$failure;
    $stages=[];
    $onStage=function($name,$duration)use(&$stages){$stages[$name]=$duration;};
    denied(fn()=>$repository->commitArchive($id,'imported',$handler->files,null,$onStage),
        $failure==='invalid'?409:504,'invalid or expired manifest verification fails closed: '.$failure);
    check($handler->verificationCalls===2 && $handler->active===0 && $handler->pending===[]
        && !$handler->published && !$handler->cleaned,
        'first verification failure stops queued reads, drains in-flight reads and preserves stage: '.$failure);
    check(array_keys($stages)===['preflight','decompress','verify_tree'], 'failed verification records only actual attempted stages: '.$failure);
}

$settings->saveOperational(['directoryConcurrency'=>1]);
$id='12345678-1234-4234-8234-123456789213';
[$repository,$handler]=asyncArchiveFixture($id,6);
$handler->verificationDelay=4.9;
denied(fn()=>$repository->commitArchive($id,'imported',$handler->files),504,'whole verification deadline bounds queued directories');
$verificationCalls=array_values(array_filter($handler->requests,fn($call)=>$call['verification']));
$lastOptions=$verificationCalls[array_key_last($verificationCalls)]['options'];
check(count($verificationCalls)===7 && $lastOptions['timeout']<1 && $lastOptions['connect_timeout']===$lastOptions['timeout']
    && $handler->pending===[] && !$handler->published && !$handler->cleaned,
    'last admitted directory uses only remaining deadline and the eighth is never sent');
$settings->saveOperational(['directoryConcurrency'=>2]);

$traceInput=$archiveInput;
$traceInput['operationId']='12345678-1234-4234-8234-123456789220';
$traceInput['trace']=true;
$operationRequests=[];
$traceController=new ArchiveCommitController(operationRepo(archiveResponses($traceInput),$operationRequests));
$traceReceipt=$traceController(operationRequest('archive-commit',$traceInput),$uploadServer)->getData(true);
check($traceReceipt['state']==='confirmed' && array_keys($traceReceipt['timings'])===
    ['preflight','decompress','verify_tree','destination_check','rename','readback','cleanup']
    && count(array_filter($traceReceipt['timings'],fn($duration)=>is_numeric($duration)&&$duration>=0))===7,
    'requested archive trace returns seven actual phase durations in milliseconds');
$traceCount=count($operationRequests);
$traceReplay=$traceController(operationRequest('archive-commit',$traceInput),$uploadServer)->getData(true);
check($traceReplay['state']==='confirmed' && !isset($traceReplay['timings']) && count($operationRequests)===$traceCount,
    'confirmed trace replay invents no historical timing and performs no requests');
$traceInput['trace']=false;
check($traceController(operationRequest('archive-commit',$traceInput),$uploadServer)->getData(true)===$traceReplay,
    'trace preference does not change the durable operation fingerprint');
$traceInput['operationId']='12345678-1234-4234-8234-123456789221'; $traceInput['trace']=true;
$operationRequests=[];
$traceController=new ArchiveCommitController(operationRepo(archiveResponses($traceInput,true),$operationRequests));
$traceFailed=$traceController(operationRequest('archive-commit',$traceInput),$uploadServer)->getData(true);
check($traceFailed['state']==='uncertain' && array_keys($traceFailed['timings'])===['preflight','decompress','verify_tree'],
    'failed trace includes failed stage duration without publish or cleanup timings');
$traceCount=count($operationRequests);
$traceReplay=$traceController(operationRequest('archive-commit',$traceInput),$uploadServer)->getData(true);
check($traceReplay['state']==='uncertain' && !isset($traceReplay['timings']) && count($operationRequests)===$traceCount,
    'uncertain trace replay preserves stage and has no repeated work or historical timing');
