<?php

use Illuminate\Support\Facades\Route;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Controllers\CapabilitiesController;

Route::get('/capabilities', CapabilitiesController::class);
