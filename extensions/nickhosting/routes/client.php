<?php

use Illuminate\Support\Facades\Route;
use Pterodactyl\Http\Middleware\Api\Client\Server\AuthenticateServerAccess;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\UploadUrlsController;

// Blueprint supplies native Client authentication, IP restrictions, binding and rate limits.
Route::post('/servers/{server}/upload-urls', UploadUrlsController::class)
    ->middleware(AuthenticateServerAccess::class);
