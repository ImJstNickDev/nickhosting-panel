<?php
// Vendor libraries plus SQLite :memory: and Guzzle MockHandler only. Never boots Panel.
use Illuminate\Support\Facades\DB;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\Protocol;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\FileOperationRepository;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\FileOperationController;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\ArchiveCommitController;

class MemoryFileOperationRepository extends FileOperationRepository
{
    public GuzzleHttp\Client $client;
    public function getHttpClient(array $headers = []): GuzzleHttp\Client { return $this->client; }
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
$archiveController = new ArchiveCommitController(operationRepo(archiveResponses($archiveInput), $operationRequests));
$committed = $archiveController(operationRequest('archive-commit', $archiveInput), $uploadServer)->getData(true);
check($committed['state'] === 'confirmed' && $committed['archiveSha256'] === $archiveInput['archiveSha256'], 'archive commit verifies tree and publishes with durable receipt');
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
