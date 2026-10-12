<?php

use Illuminate\Support\Facades\Route;
use Pterodactyl\Http\Middleware\Api\Client\Server\AuthenticateServerAccess;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\UploadUrlsController;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\DownloadUrlsController;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\TransferSettingsController;

// Blueprint supplies native Client authentication, IP restrictions, binding and rate limits.
Route::post('/servers/{server}/upload-urls', UploadUrlsController::class)
    ->middleware(AuthenticateServerAccess::class);

Route::post('/servers/{server}/download-urls', DownloadUrlsController::class)
    ->middleware(AuthenticateServerAccess::class);
Route::get('/servers/{server}/transfer-settings', TransferSettingsController::class)
    ->middleware(AuthenticateServerAccess::class);
