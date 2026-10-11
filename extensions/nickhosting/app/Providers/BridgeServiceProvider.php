<?php
namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Providers;

use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Facades\Event;
use Illuminate\Console\Scheduling\Schedule;
use Pterodactyl\Events\Server\Updated;
use Pterodactyl\Events\Server\Deleted;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\ChangeFeed;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Jobs\DeliverChanges;

final class BridgeServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        Event::listen(Updated::class, static fn (Updated $event) => app(ChangeFeed::class)->capture($event->server));
        Event::listen(Deleted::class, static fn (Deleted $event) => app(ChangeFeed::class)->capture($event->server, true));
        $this->callAfterResolving(Schedule::class, static function (Schedule $schedule) {
            $schedule->job(new DeliverChanges(), 'standard')->everyMinute()->withoutOverlapping();
        });
    }
}
