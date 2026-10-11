<?php

use Illuminate\Support\Facades\Route;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\CapabilitiesController;

Route::get('/capabilities', CapabilitiesController::class);

use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\BridgeController;
Route::pattern('instance', '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}');
Route::pattern('uuid', '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}');
Route::pattern('nickUser', '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}');
Route::pattern('keyIdentifier', 'ptlc_[a-zA-Z0-9]{11}');
Route::post('/instances/{instance}', [BridgeController::class, 'register']);
Route::get('/instances/{instance}/health', [BridgeController::class, 'health']);
Route::match(['put', 'get'], '/instances/{instance}/servers/{uuid}', [BridgeController::class, 'snapshot']);
Route::put('/instances/{instance}/users/{nickUser}', [BridgeController::class, 'linkUser']);
Route::post('/instances/{instance}/users/{nickUser}/keys', [BridgeController::class, 'issueKey']);
Route::post('/instances/{instance}/users/{nickUser}/keys/{keyIdentifier}/rotate', [BridgeController::class, 'issueKey']);
Route::delete('/instances/{instance}/users/{nickUser}/keys/{keyIdentifier}', [BridgeController::class, 'revokeKey']);

Route::post('/instances/{instance}/users/{nickUser}/provision', [BridgeController::class, 'provisionUser']);
