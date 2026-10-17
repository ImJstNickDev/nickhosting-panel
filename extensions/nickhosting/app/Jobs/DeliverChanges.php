<?php
namespace Pterodactyl\BlueprintFramework\Extensions\{identifier}\Jobs;

use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Queue\SerializesModels;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Protocol;
use Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Settings;

final class DeliverChanges implements ShouldQueue
{
    use Dispatchable, InteractsWithQueue, Queueable, SerializesModels;
    public int $tries = 1;
    public int $timeout = 60;

    public function handle(): void
    {
        $settings = app(Settings::class)->operational(['webhookBatchLimit', 'webhookConnectTimeoutSeconds', 'webhookTimeoutSeconds']);
        app(\Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\BackupEvents::class)->recover($settings['webhookBatchLimit']);
        // Claim each event transactionally before I/O; expired claims are retried by scheduler.
        for ($i = 0; $i < $settings['webhookBatchLimit']; $i++) {
            $row = DB::transaction(function () {
                $row = DB::table('nickhosting_outbox')->whereNull('delivered_at')
                    ->where('available_at', '<=', now())->orderBy('created_at')->lockForUpdate()->first();
                if ($row) {
                    DB::table('nickhosting_outbox')->where('id', $row->id)->update([
                        'available_at' => now()->addSeconds(120), 'attempts' => $row->attempts + 1]);
                }
                return $row;
            });
            if (!$row) { return; }
            $instance = DB::table('nickhosting_instances')->where('id', $row->instance_id)->first();
            if (!$instance) { continue; }
            try {
                $origins = app(\Pterodactyl\BlueprintFramework\Extensions\{identifier}\Services\Settings::class)->origins();
                if (!Protocol::callbackAllowed($instance->callback_url, $origins)) { throw new \RuntimeException('Destination not allowed'); }
                $timestamp = (string) time();
                $response = Http::connectTimeout(min($settings['webhookConnectTimeoutSeconds'], $settings['webhookTimeoutSeconds']))
                    ->timeout($settings['webhookTimeoutSeconds'])->withoutRedirecting()->withHeaders([
                    'X-NickHosting-Timestamp' => $timestamp,
                    'X-NickHosting-Event-Id' => $row->id,
                    'X-NickHosting-Signature' => Protocol::signature(decrypt($instance->secret), $timestamp, $row->payload),
                ])->withBody($row->payload, 'application/json')->post($instance->callback_url);
                if (!$response->successful()) { throw new \RuntimeException('Delivery not acknowledged'); }
                DB::table('nickhosting_outbox')->where('id', $row->id)->update(['delivered_at' => now(), 'updated_at' => now()]);
            } catch (\Throwable $error) {
                // Never persist or log exception details: HTTP exceptions can contain URLs/secrets.
                DB::table('nickhosting_outbox')->where('id', $row->id)->update([
                    'available_at' => now()->addSeconds(min(900, 2 ** min(9, $row->attempts + 1))), 'updated_at' => now()]);
            }
        }
    }
}
