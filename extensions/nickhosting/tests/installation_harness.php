<?php
use Illuminate\Support\Facades\DB;
use Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\Protocol;
// Native request policy/JWT and Eloquent update events, SQLite memory only.
$installationController = new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Http\Controllers\InstallationWebsocketController(new Pterodactyl\Services\Nodes\NodeJWTService());
$installationRequest = transferRequest('installation-websocket', [], $uploadServer, $uploadUser);
check($installationRequest->authorize(), 'installer socket permits linked Client account native websocket permission');
foreach ([2, new Laravel\Sanctum\TransientToken(), null] as $tokenType) {
    check(!transferRequest('installation-websocket', [], $uploadServer, $uploadUser, $tokenType)->authorize(), 'installer socket rejects nonaccount credentials');
}
$uploadServer->status = Pterodactyl\Models\Server::STATUS_INSTALLING;
$installResponse = $installationController($installationRequest, $uploadServer);
$installData = $installResponse->getData(true)['data'];
$installToken = $config->parser()->parse($installData['token']);
check($installResponse->headers->get('Cache-Control') === 'no-store, private'
    && $installData['socket'] === 'wss://wings.example:443/api/servers/'.$uploadServer->uuid.'/ws'
    && $config->validator()->validate($installToken, new Lcobucci\JWT\Validation\Constraint\SignedWith($config->signer(), $config->signingKey()))
    && $installToken->claims()->get('server_uuid') === $uploadServer->uuid
    && $installToken->claims()->get('user_uuid') === $uploadUser->uuid
    && $installToken->claims()->get('permissions') === ['websocket.connect', 'admin.websocket.install'],
    'installer token works while installing and carries only exact server read permissions');
$installTtl = $installToken->claims()->get('exp')->getTimestamp() - time();
check($installTtl >= 598 && $installTtl <= 600, 'installer token expires in native ten minutes');
denied(fn () => $installationController(transferRequest('installation-websocket', [], $uploadServer, $adminUser), $uploadServer), 403, 'installer socket refuses administrator credential');
denied(fn () => $installationController(transferRequest('installation-websocket', [], $uploadServer, $unrelatedUser), $uploadServer), 403, 'installer socket refuses foreign owner');
$uploadServer->status = Pterodactyl\Models\Server::STATUS_SUSPENDED;
denied(fn () => $installationController($installationRequest, $uploadServer), 409, 'installer socket preserves suspension restriction');
$uploadServer->status = Pterodactyl\Models\Server::STATUS_RESTORING_BACKUP;
denied(fn () => $installationController($installationRequest, $uploadServer), 409, 'installer socket preserves restore restriction');
$uploadServer->status = Pterodactyl\Models\Server::STATUS_INSTALLING;
$uploadNode->maintenance_mode = true;
denied(fn () => $installationController($installationRequest, $uploadServer), 409, 'installer socket preserves maintenance restriction');
$uploadNode->maintenance_mode = false;
$uploadServer->setRelation('transfer', new Pterodactyl\Models\ServerTransfer());
denied(fn () => $installationController($installationRequest, $uploadServer), 409, 'installer socket refuses transferring server');
$uploadServer->setRelation('transfer', null);
$uploadServer->external_id = 'foreign';
denied(fn () => $installationController($installationRequest, $uploadServer), 409, 'installer socket refuses drifted identity');
$uploadServer->external_id = 'owner-test';
DB::table('nickhosting_servers')->where('uuid', $uploadServer->uuid)->update(['valid' => false]);
denied(fn () => $installationController($installationRequest, $uploadServer), 409, 'installer socket refuses invalidated managed link');
DB::table('nickhosting_servers')->where('uuid', $uploadServer->uuid)->update(['valid' => true]);
$uploadServer->status = null;

// Exercise the actual native observer dispatch, without Installed or any email configuration.
// BridgeServiceProvider was already booted by the shared harness.
Pterodactyl\Models\Server::observe(Pterodactyl\Observers\ServerObserver::class);
$installationCount = static fn () => DB::table('nickhosting_outbox')->where('payload', 'like', '%"type":"installation.updated"%')->count();
$nativeInstall = Pterodactyl\Models\Server::query()->withoutEagerLoads()->find($uploadServer->id);
$beforeInstallation = $installationCount();
$beforeInstallRevision = DB::table('nickhosting_servers')->where('uuid', $uploadServer->uuid)->value('revision');
foreach (['installing' => 'installing', 'install_failed' => 'failed', 'reinstall_failed' => 'failed', '' => 'installed'] as $status => $state) {
    $nativeInstall->status = $status === '' ? null : $status;
    $nativeInstall->installed_at = now();
    $nativeInstall->skipValidation()->saveOrFail();
    $installPayload = json_decode(DB::table('nickhosting_outbox')->orderByDesc('rowid')->value('payload'), true);
    check($installPayload['type'] === 'installation.updated'
        && $installPayload['installation'] === ['state' => $state, 'status' => $nativeInstall->status]
        && $installPayload['server'] === Protocol::identity($nativeInstall), 'native install update captures '.$state.' in existing durable outbox');
}
check($installationCount() === $beforeInstallation + 4
    && DB::table('nickhosting_servers')->where('uuid', $uploadServer->uuid)->value('revision') === $beforeInstallRevision,
    'installation events are independent of resource-limit revision');
$beforeNoEvent = $installationCount();
$nativeInstall->memory++; $nativeInstall->skipValidation()->saveOrFail();
$nativeInstall->status = 'suspended'; $nativeInstall->skipValidation()->saveOrFail();
$nativeInstall->status = null; $nativeInstall->skipValidation()->saveOrFail();
check($installationCount() === $beforeNoEvent, 'unrelated update and unsuspend do not claim installation');
DB::beginTransaction();
$nativeInstall->status = 'installing'; $nativeInstall->skipValidation()->saveOrFail();
check($installationCount() === $beforeNoEvent + 1, 'install event participates in caller transaction');
DB::rollBack();
check($installationCount() === $beforeNoEvent, 'install update rollback removes notification');
$nativeInstall = Pterodactyl\Models\Server::query()->withoutEagerLoads()->find($uploadServer->id);
$nativeInstall->external_id = 'foreign'; $nativeInstall->status = 'installing'; $nativeInstall->skipValidation()->saveOrFail();
check($installationCount() === $beforeNoEvent, 'installation notification refuses foreign identity');
DB::table('servers')->where('id', $uploadServer->id)->update(['external_id' => 'owner-test', 'status' => null]);
DB::table('nickhosting_servers')->where('uuid', $uploadServer->uuid)->update(['valid' => true]);
