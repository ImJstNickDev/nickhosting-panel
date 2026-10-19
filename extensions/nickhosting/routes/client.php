<?php

use Illuminate\Support\Facades\Route;
use Pterodactyl\Http\Middleware\Api\Client\Server\AuthenticateServerAccess;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\UploadUrlsController;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\DownloadUrlsController;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\TransferSettingsController;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\DirectoryListController;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\DirectorySettingsController;

// Blueprint supplies native Client authentication, IP restrictions, binding and rate limits.
// Exact technical-owner access is checked in the controller. Native server middleware
// intentionally blocks non-admins while installing, so this read-only route omits it.
Route::get('/servers/{server}/installation-websocket', \Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\InstallationWebsocketController::class);

Route::post('/servers/{server}/upload-urls', UploadUrlsController::class)
    ->middleware(AuthenticateServerAccess::class);

Route::post('/servers/{server}/download-urls', DownloadUrlsController::class)
    ->middleware(AuthenticateServerAccess::class);
Route::get('/servers/{server}/transfer-settings', TransferSettingsController::class)
    ->middleware(AuthenticateServerAccess::class);

Route::post('/servers/{server}/directory-list', DirectoryListController::class)
    ->middleware(AuthenticateServerAccess::class);
Route::get('/servers/{server}/directory-settings', DirectorySettingsController::class)
    ->middleware(AuthenticateServerAccess::class);

Route::get('/servers/{server}/file-operation-capabilities', [\Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\FileOperationController::class, 'capabilities'])
    ->middleware(AuthenticateServerAccess::class);
Route::post('/servers/{server}/file-inspection', [\Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\FileOperationController::class, 'inspect'])
    ->middleware(AuthenticateServerAccess::class);
Route::post('/servers/{server}/guarded-delete', [\Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\FileOperationController::class, 'delete'])
    ->middleware(AuthenticateServerAccess::class);
Route::post('/servers/{server}/archive-commit', \Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\ArchiveCommitController::class)
    ->middleware(AuthenticateServerAccess::class);
Route::post('/servers/{server}/upload-publication', \Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\UploadPublicationController::class)
    ->middleware(AuthenticateServerAccess::class);
