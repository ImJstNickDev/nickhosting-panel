<?php
// Vendor libraries plus SQLite :memory: and in-memory Guzzle handlers only. Never boots Panel.
use Illuminate\Support\Facades\DB;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\Protocol;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\FileOperationRepository;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\FileOperationController;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\ArchiveCommitController;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\UploadPublicationController;

// Model separate HTTP workers contending for one connection-scoped MySQL lock.
// Only this SQLite :memory: connection is touched; no Panel DB is bootstrapped.
$archiveLocks = [];
$archivePdo = DB::connection()->getPdo();
$archivePdo->sqliteCreateFunction('GET_LOCK', function ($key, $timeout) use (&$archiveLocks) {
    if (isset($archiveLocks[$key])) { return 0; }
    $archiveLocks[$key] = 1;
    return 1;
}, 2);
$archivePdo->sqliteCreateFunction('IS_USED_LOCK', function ($key) use (&$archiveLocks) { return $archiveLocks[$key] ?? null; }, 1);
$archivePdo->sqliteCreateFunction('CONNECTION_ID', fn () => 1, 0);
$archivePdo->sqliteCreateFunction('RELEASE_LOCK', function ($key) use (&$archiveLocks) {
    if (($archiveLocks[$key] ?? null) !== 1) { return 0; }
    unset($archiveLocks[$key]); return 1;
}, 1);

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
function operationRepo(array $responses, array &$requests, ?callable $observe = null): MemoryFileOperationRepository {
    global $app, $uploadServer;
    $mock = new GuzzleHttp\Handler\MockHandler($responses);
    $repository = new MemoryFileOperationRepository($app);
    $repository->client = new GuzzleHttp\Client(['handler' => function ($request, $options) use ($mock, &$requests, $observe) {
        $requests[] = ['request' => $request, 'options' => $options];
        if ($observe !== null) { $observe($request); }
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
function archiveResponses(array $input, bool $failedExtraction = false, bool $missingPublish = false): array {
    $scratch = operationEntry('.nickhosting-import-'.$input['operationId']); $payload=operationEntry('payload.zip',true,42);
    $destination = operationEntry($input['destinationRoot']);
    return [operationListing([$scratch]), operationListing([$payload]), new GuzzleHttp\Psr7\Response($failedExtraction ? 500 : 204),
        operationListing([$scratch]), new GuzzleHttp\Psr7\Response(204), operationListing($missingPublish ? [$scratch] : [$scratch,$destination]),
        operationListing([$payload]), new GuzzleHttp\Psr7\Response(204)];
}
$operationRequests = [];
$archiveRepository = operationRepo(archiveResponses($archiveInput), $operationRequests);
$archiveController = new ArchiveCommitController($archiveRepository);
$committed = $archiveController(operationRequest('archive-commit', $archiveInput), $uploadServer)->getData(true);
check($committed['state'] === 'confirmed' && $committed['archiveSha256'] === $archiveInput['archiveSha256'], 'archive commit trusts synchronous extraction and publishes with durable receipt');
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
    check($archiveController(operationRequest('archive-commit',$archiveInput),$uploadServer)->getData(true)['state'] === 'uncertain', 'unconfirmed extraction or missing rename readback cannot succeed');
    $beforeReplay=count(array_filter($operationRequests,fn($call)=>$call['request']->getMethod()!=='GET'));
    check($archiveController(operationRequest('archive-commit',$archiveInput),$uploadServer)->getData(true)['state'] === 'uncertain'
        && count(array_filter($operationRequests,fn($call)=>$call['request']->getMethod()!=='GET'))===$beforeReplay,
        'partial archive reconciliation reads remnants without repeating mutation or cleanup');
}
$archiveInput['operationId']='12345678-1234-4234-8234-123456789104'; $operationRequests=[];
$archiveController = new ArchiveCommitController(operationRepo([operationListing([operationEntry('imported')]), operationListing([operationEntry('payload.zip',true,42)])],$operationRequests));
denied(fn()=>$archiveController(operationRequest('archive-commit',$archiveInput),$uploadServer),409,'existing destination is rejected before extraction');
check(count($operationRequests)===2 && DB::table('nickhosting_file_operations')->where('operation_id',$archiveInput['operationId'])->value('state')==='rejected','collision has no uncertain publication and no native write');
$collisionInput=$archiveInput; $collisionInput['operationId']='12345678-1234-4234-8234-123456789105';
$collisionInput['files']=[['path'=>'imported/data','size'=>1],['path'=>'imported/data/child','size'=>1]];
$operationRequests=[];
$archiveController=new ArchiveCommitController(operationRepo(array_slice(archiveResponses($collisionInput),0,2),$operationRequests));
denied(fn()=>$archiveController(operationRequest('archive-commit',$collisionInput),$uploadServer),422,'file/directory manifest collision is rejected before extraction');
check(count(array_filter($operationRequests,fn($call)=>$call['request']->getMethod()!=='GET'))===0,'manifest collision admission dispatches no native mutation');

$archiveRecoveryNumber = 400;
function archiveRecoveryInput(): array {
    global $archiveRecoveryNumber, $uploadServer;
    return ['operationId'=>'12345678-1234-4234-8234-'.str_pad((string)++$archiveRecoveryNumber,12,'0',STR_PAD_LEFT),
        'identity'=>Protocol::identity($uploadServer), 'destinationRoot'=>'imported', 'archiveSha256'=>str_repeat('b',64),
        'files'=>[['path'=>'imported/level.dat','size'=>123]]];
}
function seedArchiveRecovery(array $input, string $state='uncertain', ?array $context=null): void {
    global $uploadServer, $uploadUser;
    $manifest=$input['files']; usort($manifest,fn($a,$b)=>strcmp($a['path'],$b['path']));
    DB::table('nickhosting_file_operations')->insert(['operation_id'=>$input['operationId'], 'server_uuid'=>$uploadServer->uuid,
        'owner_id'=>$uploadUser->id, 'fingerprint'=>hash('sha256',json_encode(['archive',$input['identity'],$input['destinationRoot'],$input['archiveSha256'],$manifest],JSON_THROW_ON_ERROR)),
        'state'=>$state,'recovery_context'=>$context===null?null:json_encode($context,JSON_THROW_ON_ERROR),'created_at'=>now(),'updated_at'=>now()]);
}
function archiveRecoveryContext(string $phase): array {
    return ['schemaVersion'=>1,'kind'=>'archive','phase'=>$phase,'payload'=>['size'=>42,'modified'=>'2026-10-18T12:00:00Z']];
}
function archiveRecoveryResponses(array $input): array {
    $scratch=operationEntry('.nickhosting-import-'.$input['operationId']);
    $payload=operationEntry('payload.zip',true,42); $destination=operationEntry($input['destinationRoot']);
    return [operationListing([$scratch]),operationListing([$payload,$destination]),
        operationListing([$payload,$destination]),operationListing([operationEntry('level.dat',true,$input['files'][0]['size'])]),
        operationListing([$scratch]),new GuzzleHttp\Psr7\Response(204),operationListing([$scratch,$destination]),
        operationListing([$payload]),new GuzzleHttp\Psr7\Response(204)];
}
foreach ([null,'extracting','publishing'] as $phase) {
    $input=archiveRecoveryInput(); seedArchiveRecovery($input,'uncertain',$phase===null?null:archiveRecoveryContext($phase));
    $operationRequests=[]; $states=[]; $contexts=[];
    $repo=operationRepo(archiveRecoveryResponses($input),$operationRequests,function($request)use($input,&$states,&$contexts){
        if($request->getMethod()!=='GET') {
            $row=DB::table('nickhosting_file_operations')->where('operation_id',$input['operationId'])->first();
            $states[]=$row->state; $contexts[]=json_decode($row->recovery_context,true);
        }
    });
    $controller=new ArchiveCommitController($repo);
    $receipt=$controller(operationRequest('archive-commit',$input),$uploadServer)->getData(true);
    $mutations=array_values(array_filter($operationRequests,fn($call)=>$call['request']->getMethod()!=='GET'));
    check($receipt['state']==='confirmed' && count($mutations)===2
        && str_ends_with((string)$mutations[0]['request']->getUri(),'/rename')
        && str_ends_with((string)$mutations[1]['request']->getUri(),'/delete'),
        'exact extracted archive recovery publishes without upload or decompression '.($phase??'legacy'));
    check($states===['sent','sent'] && array_column($contexts,'phase')===['publishing','cleaning'],
        'archive recovery records each exact dispatch before provider effect '.($phase??'legacy'));
    $countBefore=count($operationRequests);
    check($controller(operationRequest('archive-commit',$input),$uploadServer)->getData(true)===$receipt && count($operationRequests)===$countBefore,
        'recovered archive confirmed replay never repeats an effect '.($phase??'legacy'));
}
foreach (['payload-only','missing-file','extra-file','extra-directory','symlink','size','both-present','missing-payload','root-symlink','legacy-published','payload-changed'] as $failure) {
    $input=archiveRecoveryInput();
    $context=$failure==='legacy-published'?null:archiveRecoveryContext('extracting');
    seedArchiveRecovery($input,'uncertain',$context);
    $responses=archiveRecoveryResponses($input);
    $scratch=operationEntry('.nickhosting-import-'.$input['operationId']); $payload=operationEntry('payload.zip',true,42); $destination=operationEntry('imported');
    if($failure==='payload-only') { $responses[1]=$responses[2]=operationListing([$payload]); }
    if($failure==='missing-file') { $responses[3]=operationListing([]); }
    if($failure==='extra-file') { $responses[3]=operationListing([operationEntry('level.dat',true,123),operationEntry('unexpected',true,0)]); }
    if($failure==='extra-directory') { $responses[3]=operationListing([operationEntry('level.dat',true,123),operationEntry('empty')]); }
    if($failure==='symlink') { $responses[3]=operationListing([array_replace(operationEntry('level.dat',true,123),['symlink'=>true])]); }
    if($failure==='size') { $responses[3]=operationListing([operationEntry('level.dat',true,124)]); }
    if($failure==='both-present') { $responses[0]=operationListing([$scratch,$destination]); }
    if($failure==='missing-payload') { $responses[1]=operationListing([$destination]); }
    if($failure==='root-symlink') { $responses[0]=operationListing([array_replace($scratch,['symlink'=>true])]); }
    if($failure==='legacy-published') { $responses[0]=operationListing([$scratch,$destination]); $responses[1]=operationListing([$payload]); }
    if($failure==='payload-changed') { $responses[1]=operationListing([array_replace($payload,['modified'=>'2026-10-19T12:00:00Z']),$destination]); }
    $operationRequests=[]; $controller=new ArchiveCommitController(operationRepo($responses,$operationRequests));
    check($controller(operationRequest('archive-commit',$input),$uploadServer)->getData(true)['state']==='uncertain'
        && count(array_filter($operationRequests,fn($call)=>$call['request']->getMethod()!=='GET'))===0,
        'archive recovery preserves every remnant on ambiguous proof '.$failure);
}
foreach ([true,false] as $scratchPresent) {
    $input=archiveRecoveryInput(); seedArchiveRecovery($input,'sent',archiveRecoveryContext('publishing'));
    $scratch=operationEntry('.nickhosting-import-'.$input['operationId']); $payload=operationEntry('payload.zip',true,42);
    $responses=[operationListing($scratchPresent?[$scratch,operationEntry('imported')]:[operationEntry('imported')])];
    if($scratchPresent) { $responses[]=operationListing([$payload]); }
    $responses[]=operationListing([operationEntry('level.dat',true,123)]);
    if($scratchPresent) { $responses[]=new GuzzleHttp\Psr7\Response(204); }
    $operationRequests=[]; $controller=new ArchiveCommitController(operationRepo($responses,$operationRequests));
    check($controller(operationRequest('archive-commit',$input),$uploadServer)->getData(true)['state']==='confirmed'
        && count(array_filter($operationRequests,fn($call)=>$call['request']->getMethod()!=='GET'))===($scratchPresent?1:0),
        'archive recovery confirms exact already-published tree and only cleans matching scratch '.($scratchPresent?'retained':'absent'));
}
$input=archiveRecoveryInput(); $input['destinationRoot']='.nickhosting-pack-stage';
$input['files']=[['path'=>$input['destinationRoot'].'/level.dat','size'=>0]]; seedArchiveRecovery($input);
$operationRequests=[]; $controller=new ArchiveCommitController(operationRepo(archiveRecoveryResponses($input),$operationRequests));
check($controller(operationRequest('archive-commit',$input),$uploadServer)->getData(true)['state']==='confirmed',
    'archive recovery supports an exact hidden staging destination and zero-byte file');

$input=archiveRecoveryInput(); seedArchiveRecovery($input,'prepared'); $operationRequests=[];
$controller=new ArchiveCommitController(operationRepo([],$operationRequests));
check($controller(operationRequest('archive-commit',$input),$uploadServer)->getData(true)['state']==='uncertain' && $operationRequests===[],
    'prepared archive receipt never authorizes decompression replay');
foreach (['archiveSha256','destinationRoot','identity','files'] as $field) {
    $changed=$input;
    if($field==='archiveSha256') { $changed[$field]=str_repeat('a',64); }
    if($field==='destinationRoot') { $changed[$field]='other'; $changed['files'][0]['path']='other/level.dat'; }
    if($field==='identity') { $changed[$field]['externalId']='foreign'; }
    if($field==='files') { $changed[$field][0]['size']++; }
    denied(fn()=>$controller(operationRequest('archive-commit',$changed),$uploadServer),409,'archive recovery rejects changed exact receipt '.$field);
}
check($operationRequests===[],'mismatched recovery receipts have no provider access');

// Nested invocation models a second HTTP worker while the original holds the lock.
$input=archiveRecoveryInput(); $operationRequests=[]; $nested=0; $controller=null;
$repo=operationRepo(archiveResponses($input),$operationRequests,function($request)use($input,&$controller,&$nested){
    if($nested>=2) { return; }
    if($nested===0 || str_ends_with((string)$request->getUri(),'/decompress')) {
        global $uploadServer;
        $row=DB::table('nickhosting_file_operations')->where('operation_id',$input['operationId'])->first();
        check($row->state===($nested===0?'prepared':'sent'),'archive receipt intent is durable before native dispatch '.$nested);
        $nested++;
        denied(fn()=>$controller(operationRequest('archive-commit',$input),$uploadServer),409,'concurrent archive request cannot enter the locked receipt');
    }
});
$controller=new ArchiveCommitController($repo);
check($controller(operationRequest('archive-commit',$input),$uploadServer)->getData(true)['state']==='confirmed' && $nested===2,
    'original archive request retains the receipt lock across preflight and effects');
check($archiveLocks===[],'all archive receipt locks release after success and denial');
$input=archiveRecoveryInput(); $input['operationId']='ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF';
$caseLock='nickhosting-archive-'.strtolower($input['operationId']); $archiveLocks[$caseLock]=2; $operationRequests=[];
$controller=new ArchiveCommitController(operationRepo([],$operationRequests));
denied(fn()=>$controller(operationRequest('archive-commit',$input),$uploadServer),409,'UUID case aliases share the same archive receipt lock');
check($operationRequests===[] && $archiveLocks[$caseLock]===2,'busy alias cannot read provider or release another request lock');
unset($archiveLocks[$caseLock]);

foreach (['preflight','decompress','delete'] as $lostAt) {
    $input=archiveRecoveryInput(); $operationRequests=[]; $lost=false;
    $lockKey='nickhosting-archive-'.$input['operationId'];
    $repo=operationRepo(archiveResponses($input),$operationRequests,function($request)use($input,$lostAt,$lockKey,&$lost,&$archiveLocks){
        if(!$lost && ($lostAt==='preflight' || str_ends_with((string)$request->getUri(),'/'.$lostAt))) {
            $lost=true;
            // The old connection loses its lock; a newer request confirms the receipt.
            $archiveLocks[$lockKey]=2;
            DB::table('nickhosting_file_operations')->where('operation_id',$input['operationId'])->update(['state'=>'confirmed']);
        }
    });
    $controller=new ArchiveCommitController($repo);
    if($lostAt==='preflight') {
        denied(fn()=>$controller(operationRequest('archive-commit',$input),$uploadServer),409,'lost receipt lock refuses first archive effect');
    } else {
        check($controller(operationRequest('archive-commit',$input),$uploadServer)->getData(true)['state']==='uncertain',
            'lost receipt lock returns uncertainty after dispatch '.$lostAt);
    }
    check(DB::table('nickhosting_file_operations')->where('operation_id',$input['operationId'])->value('state')==='confirmed'
        && $archiveLocks[$lockKey]===2,'stale archive request never overwrites confirmation or releases newer lock '.$lostAt);
    unset($archiveLocks[$lockKey]);
}

class ArchiveUnchangedStatement extends PDOStatement {
    protected function __construct() {}
    public function rowCount(): int { return str_starts_with($this->queryString,'UPDATE ') && str_contains($this->queryString,'nickhosting_file_operations') ? 0 : parent::rowCount(); }
}
$statementClass=$archivePdo->getAttribute(PDO::ATTR_STATEMENT_CLASS);
$archivePdo->setAttribute(PDO::ATTR_STATEMENT_CLASS,[ArchiveUnchangedStatement::class]);
try {
    $input=archiveRecoveryInput(); seedArchiveRecovery($input,'sent',archiveRecoveryContext('publishing')); $operationRequests=[];
    $controller=new ArchiveCommitController(operationRepo(archiveRecoveryResponses($input),$operationRequests));
    check($controller(operationRequest('archive-commit',$input),$uploadServer)->getData(true)['state']==='confirmed',
        'MySQL zero changed-row receipt updates verify exact retained values on the pinned connection');
} finally { $archivePdo->setAttribute(PDO::ATTR_STATEMENT_CLASS,$statementClass); }

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

// Real Guzzle promises with one event-loop handler. Each wait advances pending
// work so sequential recovery and deadline accounting remain observable.
class FileOperationAsyncHandler
{
    public array $pending=[];
    public array $requests=[];
    public array $events=[];
    public int $active=0;
    public int $peak=0;
    public int $verificationActive=0;
    public int $verificationPeak=0;
    public int $verificationCalls=0;
    public bool $extracted=false;
    public bool $skipStagePreflight=false;
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
        if($verification && $this->skipStagePreflight) { $verification=false; $this->skipStagePreflight=false; }
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
        $this->peak=max($this->peak,$this->active);
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
        if($entry['verification'] && $this->failure==='invalid' && $relative==='') { return operationListing([]); }
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

foreach([4,160] as $children) {
    $id='12345678-1234-4234-8234-'.str_pad((string)(200+$children),12,'0',STR_PAD_LEFT);
    [$repository,$handler]=asyncArchiveFixture($id,$children);
    $stages=[];
    $repository->commitArchive($id,'imported',$handler->files,null,function($name,$duration)use(&$stages){$stages[$name]=$duration;});
    check($handler->verificationCalls===0 && $handler->peak===1
        && $handler->active===0 && $handler->pending===[] && $handler->published && $handler->cleaned,
        'confirmed extraction never lists extracted directories or creates a promise pool: '.$children.' files');
    check($repository->clientCalls===1 && count($handler->requests)===8 && !isset($stages['verify_tree']),
        'normal archive uses eight shallow requests independent of tree size: '.$children.' files');
    check(count(array_filter($handler->requests,fn($call)=>($call['options']['stream']??false)||($call['options']['synchronous']??false)))===0,
        'all archive reads and mutations reuse asynchronous nonstreaming transport: '.$children.' files');
}

foreach([4,160] as $children) {
    $id='12345678-1234-4234-8234-'.str_pad((string)(700+$children),12,'0',STR_PAD_LEFT);
    [$repository,$handler]=asyncArchiveFixture($id,$children);
    $handler->extracted=true; $handler->skipStagePreflight=true; $handler->verificationDelay=0.01;
    $repository->recoverArchive($id,'imported',$handler->files,null,static function(){});
    check($handler->verificationPeak===1 && $handler->verificationCalls===$children+2
        && $handler->active===0 && $handler->pending===[] && $handler->published && $handler->cleaned,
        'uncertain archive recovery sequentially checks every manifest directory: '.$children.' files');
    check(count(array_filter($handler->requests,fn($call)=>str_ends_with($call['request']->getUri()->getPath(),'/decompress')))===0,
        'uncertain tree recovery never repeats decompression: '.$children.' files');
}

foreach(['invalid','deadline'] as $failure) {
    $id=$failure==='invalid'?'12345678-1234-4234-8234-123456789211':'12345678-1234-4234-8234-123456789212';
    [$repository,$handler]=asyncArchiveFixture($id);
    $handler->failure=$failure; $handler->extracted=true; $handler->skipStagePreflight=true;
    $stages=[];
    $onStage=function($name,$duration)use(&$stages){$stages[$name]=$duration;};
    denied(fn()=>$repository->recoverArchive($id,'imported',$handler->files,null,static function(){},$onStage),
        $failure==='invalid'?409:504,'invalid or expired manifest verification fails closed: '.$failure);
    check($handler->verificationCalls===1 && $handler->active===0 && $handler->pending===[]
        && !$handler->published && !$handler->cleaned,
        'first recovery verification failure stops reads with nothing pending and preserves stage: '.$failure);
    check(array_keys($stages)===['preflight','verify_tree'], 'failed recovery records only actual attempted stages: '.$failure);
}

$id='12345678-1234-4234-8234-123456789213';
[$repository,$handler]=asyncArchiveFixture($id,6);
$handler->verificationDelay=4.9; $handler->extracted=true; $handler->skipStagePreflight=true;
denied(fn()=>$repository->recoverArchive($id,'imported',$handler->files,null,static function(){}),504,'whole recovery verification deadline bounds queued directories');
$verificationCalls=array_values(array_filter($handler->requests,fn($call)=>$call['verification']));
$lastOptions=$verificationCalls[array_key_last($verificationCalls)]['options'];
check(count($verificationCalls)===7 && $lastOptions['timeout']<1 && $lastOptions['connect_timeout']===$lastOptions['timeout']
    && $handler->pending===[] && !$handler->published && !$handler->cleaned,
    'last admitted directory uses only remaining deadline and the eighth is never sent');

$traceInput=$archiveInput;
$traceInput['operationId']='12345678-1234-4234-8234-123456789220';
$traceInput['trace']=true;
$operationRequests=[];
$traceController=new ArchiveCommitController(operationRepo(archiveResponses($traceInput),$operationRequests));
$traceReceipt=$traceController(operationRequest('archive-commit',$traceInput),$uploadServer)->getData(true);
check($traceReceipt['state']==='confirmed' && array_keys($traceReceipt['timings'])===
    ['preflight','decompress','destination_check','rename','readback','cleanup']
    && count(array_filter($traceReceipt['timings'],fn($duration)=>is_numeric($duration)&&$duration>=0))===6,
    'requested archive trace returns six actual phases without a redundant full tree scan');
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
check($traceFailed['state']==='uncertain' && array_keys($traceFailed['timings'])===['preflight','decompress'],
    'failed trace includes failed stage duration without publish or cleanup timings');
$traceCount=count($operationRequests);
$traceReplay=$traceController(operationRequest('archive-commit',$traceInput),$uploadServer)->getData(true);
check($traceReplay['state']==='uncertain' && !isset($traceReplay['timings']['decompress']) && !isset($traceReplay['timings']['rename']),
    'uncertain trace reconciliation preserves stage and never repeats decompression or invents historical timing');

// Native Wings rename refuses overwrites. Publication keeps the old file until
// both rename sides have been observed, and persists intent before the first write.
$publicationNumber = 300;
function publicationInput(string $destination = 'world/level.dat'): array {
    global $uploadServer, $publicationNumber;
    $operationId = '12345678-1234-4234-8234-' . str_pad((string) ++$publicationNumber, 12, '0', STR_PAD_LEFT);
    return ['operationId' => $operationId, 'identity' => Protocol::identity($uploadServer),
        'source' => (dirname($destination) === '.' ? '' : dirname($destination) . '/') . '.nh-upload-' . $operationId . '.pending',
        'destination' => $destination];
}
function publicationEntries(array $input, bool $published = false): array {
    $stage = array_replace(operationEntry(basename($input['source']), true, 100), ['mode'=>'-r--------','mode_bits'=>'0400']);
    $old = array_replace(operationEntry(basename($input['destination']), true, 40), ['mode'=>'-r--------','mode_bits'=>'400']);
    return $published ? [array_replace($stage, ['name'=>basename($input['destination']), 'created'=>'2026-10-19T12:00:00Z']),
        array_replace($old, ['name'=>'.nh-upload-'.$input['operationId'].'.previous','created'=>'2026-10-19T12:00:00Z'])] : [$stage,$old];
}
function publicationResponses(array $input): array {
    return [operationListing(publicationEntries($input)), new GuzzleHttp\Psr7\Response(204),
        new GuzzleHttp\Psr7\Response(204), operationListing(publicationEntries($input,true)), new GuzzleHttp\Psr7\Response(204)];
}
$publishInput=publicationInput(); $operationRequests=[];
$publishController=new UploadPublicationController(operationRepo([], $operationRequests));
foreach ([2,new Laravel\Sanctum\TransientToken(),null] as $badToken) {
    check(!transferRequest('upload-publication',$publishInput,$uploadServer,$uploadUser,$badToken)->authorize(), 'publication rejects nonaccount token');
}
denied(fn()=>$publishController(operationRequest('upload-publication',$publishInput,$adminUser),$uploadServer),403,'publication refuses admin credential');
denied(fn()=>$publishController(operationRequest('upload-publication',$publishInput,$unrelatedUser),$uploadServer),403,'publication refuses unrelated owner');
$foreignPublication=$publishInput; $foreignPublication['identity']['providerId']++;
denied(fn()=>$publishController(operationRequest('upload-publication',$foreignPublication),$uploadServer),409,'publication refuses mismatched managed identity');
check($operationRequests===[] && !DB::table('nickhosting_file_operations')->where('operation_id',$publishInput['operationId'])->exists(), 'publication denial has no I/O or receipt');
foreach ([['source'=>'world/ordinary-file'],['source'=>'elsewhere/'.basename($publishInput['source'])],['destination'=>'../file'],
    ['destination'=>'world/.nh-upload-'.$publishInput['operationId'].'.previous'],['source'=>'/world/'.basename($publishInput['source'])]] as $invalid) {
    try { operationRequest('upload-publication',array_replace($publishInput,$invalid)); throw new LogicException('Expected publication path rejection'); }
    catch (Illuminate\Validation\ValidationException $error) { check(true,'publication requires unique canonical sibling staging'); }
}
$operationRequests=[]; $publicationStates=[]; $publicationContexts=[];
$publishRepo=operationRepo(publicationResponses($publishInput),$operationRequests,function ($request) use ($publishInput,&$publicationStates,&$publicationContexts) {
    if ($request->getMethod()!=='GET') {
        $publicationStates[]=DB::table('nickhosting_file_operations')->where('operation_id',$publishInput['operationId'])->value('state');
        $publicationContexts[]=json_decode(DB::table('nickhosting_file_operations')->where('operation_id',$publishInput['operationId'])->value('recovery_context'),true);
    }
});
$publishController=new UploadPublicationController($publishRepo);
$published=$publishController(operationRequest('upload-publication',$publishInput),$uploadServer)->getData(true);
check($publicationStates===['sent','sent','confirmed'],'publication persists intent before each rename and confirmation before cleanup');
check(count(array_filter($publicationContexts,fn($context)=>$context['schemaVersion']===1 && $context['kind']==='upload-publication'
    && $context['source']===$publishInput['source'] && $context['destination']===$publishInput['destination']
    && $context['backup']==='world/.nh-upload-'.$publishInput['operationId'].'.previous'
    && $context['originalMetadata']['size']===40 && $context['stagedMetadata']['size']===100
    && $context['originalMetadata']['mode']===0400 && $context['stagedMetadata']['mode']===0400))===3,
    'durable exact paths and preflight metadata precede all publication effects');
check($published===['operationId'=>$publishInput['operationId'],'state'=>'confirmed','identity'=>$publishInput['identity'],'destination'=>$publishInput['destination']], 'publication returns exact confirmed identity and destination');
check(DB::table('nickhosting_file_operations')->where('operation_id',$publishInput['operationId'])->value('state')==='confirmed', 'publication stores confirmed receipt');
check($publishRepo->clientCalls===1 && count($operationRequests)===5, 'publication reuses one client for two reads and three mutations');
$publishBodies=array_map(fn($item)=>json_decode((string)$item['request']->getBody(),true),$operationRequests);
$backup='world/.nh-upload-'.$publishInput['operationId'].'.previous';
check($publishBodies[1]===['root'=>'/','files'=>[['from'=>'world/level.dat','to'=>$backup]]]
    && $publishBodies[2]===['root'=>'/','files'=>[['from'=>$publishInput['source'],'to'=>'world/level.dat']]]
    && $publishBodies[4]===['root'=>'/','files'=>[$backup]], 'publication saves original then stages final and deletes only its backup');
check($publishController(operationRequest('upload-publication',$publishInput),$uploadServer)->getData(true)===$published && count($operationRequests)===5,
    'confirmed publication receipt never repeats renames or cleanup');
$changedPublication=$publishInput; $changedPublication['destination']='world/other.dat';
denied(fn()=>$publishController(operationRequest('upload-publication',$changedPublication),$uploadServer),409,'publication UUID cannot change destination');

foreach (['mode','backup','symlink','directory','alias','missing-stage','missing-destination'] as $invalid) {
    $input=publicationInput(); $entries=publicationEntries($input);
    if ($invalid==='mode') { $entries[0]['mode_bits']='644'; }
    if ($invalid==='backup') { $entries[]=operationEntry('.nh-upload-'.$input['operationId'].'.previous',true); }
    if ($invalid==='symlink') { $entries[1]['symlink']=true; }
    if ($invalid==='directory') { $entries[0]['file']=false; }
    if ($invalid==='alias') { $entries[]=array_replace($entries[1],['name'=>'LEVEL.DAT']); }
    if ($invalid==='missing-stage') { array_shift($entries); }
    if ($invalid==='missing-destination') { array_pop($entries); }
    $operationRequests=[]; $controller=new UploadPublicationController(operationRepo([operationListing($entries)],$operationRequests));
    denied(fn()=>$controller(operationRequest('upload-publication',$input),$uploadServer),409,'publication rejects unsafe preflight '.$invalid);
    check(count($operationRequests)===1 && DB::table('nickhosting_file_operations')->where('operation_id',$input['operationId'])->value('state')==='rejected',
        'preflight rejection preserves original without any mutation '.$invalid);
    denied(fn()=>$controller(operationRequest('upload-publication',$input),$uploadServer),409,'publication rejected replay stays rejected');
    check(count($operationRequests)===1,'rejected publication does no replay I/O');
}
foreach (['original-rename','stage-rename','readback','missing-stage-rename','wrong-final','lost-backup'] as $failure) {
    $input=publicationInput(); $responses=publicationResponses($input);
    if ($failure==='original-rename') { $responses[1]=new GuzzleHttp\Psr7\Response(500); }
    if ($failure==='stage-rename') { $responses[2]=new GuzzleHttp\Psr7\Response(409); }
    if ($failure==='readback') { $responses[3]=new GuzzleHttp\Psr7\Response(500); }
    if ($failure==='missing-stage-rename') { $responses[3]=operationListing(publicationEntries($input)); }
    if ($failure==='wrong-final') { $entries=publicationEntries($input,true); $entries[0]['size']++; $responses[3]=operationListing($entries); }
    if ($failure==='lost-backup') { $responses[3]=operationListing([publicationEntries($input,true)[0]]); }
    $operationRequests=[]; $controller=new UploadPublicationController(operationRepo($responses,$operationRequests));
    check($controller(operationRequest('upload-publication',$input),$uploadServer)->getData(true)['state']==='uncertain','publication preserves uncertain '.$failure);
    check(count(array_filter($operationRequests,fn($r)=>$r['request']->getMethod()==='POST'))===0, 'uncertain publication never deletes old bytes '.$failure);
    $publicationRequestCount=count($operationRequests);
    check($controller(operationRequest('upload-publication',$input),$uploadServer)->getData(true)['state']==='uncertain' && count($operationRequests)===$publicationRequestCount,
        'uncertain publication is never blindly repeated '.$failure);
    foreach (['prepared','sent'] as $crashed) {
        DB::table('nickhosting_file_operations')->where('operation_id',$input['operationId'])->update(['state'=>$crashed]);
        check($controller(operationRequest('upload-publication',$input),$uploadServer)->getData(true)['state']==='uncertain' && count($operationRequests)===$publicationRequestCount,
            'crashed publication preserves remnants without replay '.$crashed);
    }
}
$input=publicationInput('root-file'); $responses=publicationResponses($input); $responses[4]=new GuzzleHttp\Psr7\Response(500);
$operationRequests=[]; $controller=new UploadPublicationController(operationRepo($responses,$operationRequests));
check($controller(operationRequest('upload-publication',$input),$uploadServer)->getData(true)['state']==='confirmed'
    && DB::table('nickhosting_file_operations')->where('operation_id',$input['operationId'])->value('state')==='confirmed',
    'failed backup cleanup keeps confirmed publication and recoverable original');
