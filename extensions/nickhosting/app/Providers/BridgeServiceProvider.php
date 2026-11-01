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
    public function register(): void
    {
        $this->app->singleton(\Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\TechnicalAccounts::class);
    }

    public function boot(): void
    {
        $accounts = fn () => app(\Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\TechnicalAccounts::class);
        // Append after session/Sanctum resolution, but before controllers and login actions.
        foreach (['web', 'blueprint', 'api', 'blueprint/api'] as $group) {
            $this->app['router']->pushMiddlewareToGroup($group,
                \Pterodactyl\BlueprintFramework\Extensions\{identifier}\Http\Middleware\TechnicalAccountAccess::class);
        }
        Event::listen(\Illuminate\Auth\Events\Login::class, static function ($event) use ($accounts) {
            abort_if($event->user instanceof \Pterodactyl\Models\User && $accounts()->managed($event->user), 403);
        });
        Event::listen(\Illuminate\Notifications\Events\NotificationSending::class, static function ($event) use ($accounts) {
            if ($event->channel === 'mail' && $event->notifiable instanceof \Pterodactyl\Models\User
                && $accounts()->managed($event->notifiable)) { return false; }
        });
        Event::listen(\Illuminate\Mail\Events\MessageSending::class, static function ($event) use ($accounts) {
            foreach (array_merge($event->message->getTo(), $event->message->getCc(), $event->message->getBcc()) as $address) {
                if ($accounts()->byLogin($address->getAddress())) { return false; }
            }
        });
        Event::listen(\Pterodactyl\Events\ActivityLogged::class, static fn ($event) =>
            app(\Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\BackupEvents::class)->capture($event));
        Event::listen(Updated::class, static fn (Updated $event) => app(ChangeFeed::class)->capture($event->server));
        Event::listen(Updated::class, static fn (Updated $event) =>
            app(\Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\InstallationEvents::class)->capture($event->server));
        Event::listen(Deleted::class, static fn (Deleted $event) => app(ChangeFeed::class)->capture($event->server, true));
        $this->callAfterResolving(Schedule::class, static function (Schedule $schedule) {
            $schedule->job(new DeliverChanges(), 'standard')->everyMinute()->withoutOverlapping();
        });
    }
}
