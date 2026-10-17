<?php
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Facades\DB;
// Native Eloquent ActivityLogged + ActivityLogService::save ordering, SQLite only.
Schema::create('backups', function ($t) {
    $t->increments('id'); $t->integer('server_id'); $t->uuid('uuid'); $t->string('name');
    $t->boolean('is_successful'); $t->boolean('is_locked')->default(false); $t->string('checksum')->nullable();
    $t->unsignedBigInteger('bytes')->default(0); $t->timestamp('completed_at')->nullable();
    $t->timestamps(); $t->softDeletes();
});
Schema::create('activity_logs', function ($t) {
    $t->bigIncrements('id'); $t->string('event'); $t->string('ip'); $t->text('properties');
    $t->timestamp('timestamp')->useCurrent();
});
Schema::create('activity_log_subjects', function ($t) {
    $t->bigIncrements('id'); $t->unsignedBigInteger('activity_log_id');
    $t->unsignedInteger('subject_id'); $t->string('subject_type');
});
$app->instance('events', $capsule->getEventDispatcher());
$backupFeed = new Pterodactyl\BlueprintFramework\Extensions\nickhosting\Services\BackupEvents();
Illuminate\Support\Facades\Event::listen(Pterodactyl\Events\ActivityLogged::class, fn ($event) => $backupFeed->capture($event));
$backupServer = Pterodactyl\Models\Server::query()->withoutEagerLoads()->find($uploadServer->id);
$backupUuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
DB::table('backups')->insert(['id'=>1,'server_id'=>$backupServer->id,'uuid'=>$backupUuid,
    'name'=>'Native backup', 'is_successful'=>true, 'checksum'=>'sha256:abcd','bytes'=>4096,
    'completed_at'=>'2026-01-01 00:00:00']);
$nativeBackup = Pterodactyl\Models\Backup::find(1);
function nativeBackupActivity(string $event, $backup, $server) {
    // Exercise the upstream save method itself: ActivityLogged is dispatched before
    // ActivityLogSubject::insert, inside its nested transaction.
    $service = (new ReflectionClass(Pterodactyl\Services\Activity\ActivityLogService::class))->newInstanceWithoutConstructor();
    foreach (['connection'=>DB::connection(), 'activity'=>new Pterodactyl\Models\ActivityLog([
        'event'=>$event, 'ip'=>'127.0.0.1', 'properties'=>[]]), 'subjects'=>[$backup,$server]] as $key=>$value) {
        $property = new ReflectionProperty($service,$key); $property->setAccessible(true); $property->setValue($service,$value);
    }
    $method = new ReflectionMethod($service,'save'); $method->setAccessible(true);
    return $method->invoke($service);
}
$beforeBackupCount = DB::table('nickhosting_outbox')->count();
$beforeRevision = DB::table('nickhosting_servers')->where('uuid',$backupServer->uuid)->value('revision');
DB::beginTransaction();
$activity = nativeBackupActivity('server:backup.complete', $nativeBackup, $backupServer);
check(DB::table('nickhosting_backup_events')->count()===1 && DB::table('nickhosting_outbox')->count()===$beforeBackupCount,
    'backup source durable in native transaction; no event before outer commit');
DB::rollBack();
check(DB::table('nickhosting_backup_events')->count()===0 && DB::table('nickhosting_outbox')->count()===$beforeBackupCount,
    'S3/finalization rollback leaves no backup source or delivery');
Illuminate\Support\Carbon::setTestNow(Illuminate\Support\Carbon::parse('2026-10-17T10:11:12.654321Z'));
DB::beginTransaction();
$activity = nativeBackupActivity('server:backup.complete', $nativeBackup, $backupServer);
DB::commit();
Illuminate\Support\Carbon::setTestNow();
$source = DB::table('nickhosting_backup_events')->where('activity_id',$activity->id)->first();
$backupPayload = json_decode(DB::table('nickhosting_outbox')->where('id',$source->event_id)->value('payload'),true);
check($source->processed_at !== null && $backupPayload['type']==='backup.completed'
    && $backupPayload['backup']===['uuid'=>$backupUuid,'name'=>'Native backup','isSuccessful'=>true,
        'checksum'=>'sha256:abcd','bytes'=>4096,'completedAt'=>'2026-01-01T00:00:00+00:00'],
    'committed native completion resolves subjects and carries backup metadata');
check($backupPayload['occurredAt']==='2026-10-17T10:11:12.654321Z', 'native event occurrence preserves microseconds across durable marker and payload');
check(!isset($backupPayload['revision']) && !isset($backupPayload['limits'])
    && DB::table('nickhosting_servers')->where('uuid',$backupServer->uuid)->value('revision')===$beforeRevision,
    'backup notifications independent of limit revision');
$backupFeed->capture(new Pterodactyl\Events\ActivityLogged($activity));
$backupFeed->recover(10);
nativeBackupActivity('server:backup.complete',$nativeBackup,$backupServer);
check(DB::table('nickhosting_outbox')->count()===$beforeBackupCount+1,'repeated source and completion callback produce one event');
foreach (['server:backup.restore-complete'=>true,'server.backup.restore-failed'=>false] as $event=>$successful) {
    $activity = nativeBackupActivity($event,$nativeBackup,$backupServer);
    $eventId = DB::table('nickhosting_backup_events')->where('activity_id',$activity->id)->value('event_id');
    $payload = json_decode(DB::table('nickhosting_outbox')->where('id',$eventId)->value('payload'),true);
    check($payload['type']==='backup.restore-completed' && $payload['backup']['isSuccessful']===$successful
        && $payload['backup']['completedAt']===$payload['occurredAt']
        && $payload['backup']['completedAt']!==$backupPayload['backup']['completedAt'],
        'native restore outcome and occurrence timestamp '.($successful?'success':'failure'));
}
$beforeSkipped = DB::table('nickhosting_outbox')->count();
DB::table('nickhosting_servers')->where('uuid',$backupServer->uuid)->update(['valid'=>false]);
nativeBackupActivity('server:backup.restore-complete',$nativeBackup,$backupServer);
DB::table('nickhosting_servers')->where('uuid',$backupServer->uuid)->update(['valid'=>true]);
DB::table('servers')->where('id',$backupServer->id)->update(['external_id'=>'foreign']);
nativeBackupActivity('server:backup.restore-complete',$nativeBackup,$backupServer);
DB::table('servers')->where('id',$backupServer->id)->update(['external_id'=>$backupServer->external_id]);
DB::table('servers')->where('id',$backupServer->id)->update(['owner_id'=>999]);
nativeBackupActivity('server:backup.restore-complete',$nativeBackup,$backupServer);
DB::table('servers')->where('id',$backupServer->id)->update(['owner_id'=>$backupServer->owner_id]);
nativeBackupActivity('server:backup.start',$nativeBackup,$backupServer);
check(DB::table('nickhosting_outbox')->count()===$beforeSkipped,'unrelated activity, invalid link, identity drift and owner drift produce no notification');
// Simulate process death before the after-commit callback by disabling dispatch
// only while creating the native activity, then inserting its durable marker.
Illuminate\Support\Facades\Event::forget(Pterodactyl\Events\ActivityLogged::class);
$activity = nativeBackupActivity('server.backup.restore-failed',$nativeBackup,$backupServer);
$recoveredEventId = (string) Illuminate\Support\Str::uuid();
DB::table('nickhosting_backup_events')->insert(['activity_id'=>$activity->id,'event_id'=>$recoveredEventId,
    'event'=>$activity->event,'occurred_at'=>now(),'created_at'=>now(),'available_at'=>now()]);
$backupFeed->recover(10);
check(DB::table('nickhosting_outbox')->where('id',$recoveredEventId)->exists(), 'scheduler recovery materializes committed durable source after callback crash');
$backupFeed->recover(10);
check(DB::table('nickhosting_outbox')->where('id',$recoveredEventId)->count()===1,'recovery retains event id and deduplicates');

// A failed native creation is distinct from the already completed backup.
DB::table('backups')->insert(['id'=>2,'server_id'=>$backupServer->id,
    'uuid'=>'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee','name'=>'Failed backup','is_successful'=>false,
    'checksum'=>null,'bytes'=>0,'completed_at'=>now()]);
Illuminate\Support\Facades\Event::listen(Pterodactyl\Events\ActivityLogged::class, fn ($event) => $backupFeed->capture($event));
$activity = nativeBackupActivity('server:backup.fail',Pterodactyl\Models\Backup::find(2),$backupServer);
$eventId = DB::table('nickhosting_backup_events')->where('activity_id',$activity->id)->value('event_id');
$payload = json_decode(DB::table('nickhosting_outbox')->where('id',$eventId)->value('payload'),true);
check($payload['type']==='backup.completed' && !$payload['backup']['isSuccessful']
    && $payload['backup']['checksum']===null && $payload['backup']['bytes']===0,'native failed backup emits authoritative failure metadata');
$link = DB::table('nickhosting_servers')->where('uuid',$backupServer->uuid)->first();
DB::table('nickhosting_servers')->where('uuid',$backupServer->uuid)->delete();
$beforeUnlinked = DB::table('nickhosting_outbox')->count();
nativeBackupActivity('server:backup.restore-complete',$nativeBackup,$backupServer);
check(DB::table('nickhosting_outbox')->count()===$beforeUnlinked,'unlinked provider server produces no backup notification');
DB::table('nickhosting_servers')->insert((array) $link);
// Missing subjects are uncertain and must not block a later valid source.
DB::table('nickhosting_backup_events')->insert(['activity_id'=>99999,'event_id'=>(string) Illuminate\Support\Str::uuid(),
    'event'=>'server:backup.restore-complete','occurred_at'=>now(),'created_at'=>now(),'available_at'=>now()]);
$backupFeed->recover(1);
$uncertain = DB::table('nickhosting_backup_events')->where('activity_id',99999)->first();
check($uncertain->processed_at===null && strtotime($uncertain->available_at)>time(), 'missing native subjects stay uncertain with bounded recovery delay');
