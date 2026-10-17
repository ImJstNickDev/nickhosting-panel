# Backups

M5 uses the Pterodactyl adapter and native Wings backup storage. Blueprint 1.5.0
reports committed completion; it does not implement a second backup engine.

## User flow and integration policy

The Backups tab lists names, dates, sizes, completion and protection. Creation
accepts an optional name, newline-separated native exclusion patterns, protection
and `auto`, `offline` or `live` mode. SDK `backupPolicy.offline` is `required`,
`recommended` or `none`; unknown integrations require offline operation. Auto
chooses offline for required/recommended and live for none. Required cannot be
weakened by a browser request. Minecraft currently requires offline backups.
Its implemented live hooks recognize modern command receipts; older supported
Minecraft versions use different responses. Until exact runtime/version capability
evidence is available, the integration does not advertise live backup for all
versions. This restriction is enforced in descriptors, enqueue and execution.

A temporary offline backup records prior running state and consent generation,
stops normally, waits for the stopped receipt, creates the backup, then attempts
normal admission/resumption. A manual stop, changed consent or explicit automatic-start pause suppresses resume.
An already stopped server stays stopped. Successful backup and failed/suppressed
resume are separate outcomes in Activity. Gateway process/readiness state is
cleared for the temporary stop and rebuilt for the admitted resumed process.

Minecraft live preparation sends `save-off` then `save-all flush`, waits for actual
server-thread acknowledgements, and journals the need for `save-on` before sending
any disabling command. Unsupported log formats fail rather than claim consistency.
Cleanup remains a durable obligation after failure; its outcome is exposed separately.
Only the compiled compensating hook may restore prior game settings after the
initiating user/schedule loses authority. It retains managed identity, active-job
and fresh host checks; it cannot authorize another backup or start. A stopped
process has no remaining in-memory autosave setting; clearing that obligation
requires trusted stopped-process evidence, never cached Panel status alone.

Restore requires explicit consent and selects preserve-extra-files or replace-all.
Preserve-extra-files still overwrites matching paths. An optional pre-restore backup
must finish successfully before restoration begins. Restoration success requires
provider completion and cleared native restoration state, not just HTTP acceptance.
This is recovery assistance, not an automatic rollback guarantee.

## Events, jobs and recovery

Native creation stays on the existing Client API. Blueprint subscribes to native
`ActivityLogged` for backup success/failure and restore success/failure. The event
fires before activity subjects are inserted: a source marker is saved in the same
transaction, then materialized after commit. S3 finalization failure rolls back the
marker. The existing persistent outbox signs and retries deliveries. Scheduler
recovery repairs the window between transaction commit and after-commit dispatch.
Only exact, linked NickHosting server identities produce notifications.

Core verifies the raw HMAC envelope, sender instance and managed provider identity,
deduplicates event IDs, stores receipts and wakes the matching durable operation.
Receiver and worker serialize on the job row so an early completion cannot be lost
when a worker enters waiting. Backup events never advance/invalidate the server
limits revision. One shared PostgreSQL LISTEN connection per API pool feeds
server-scoped, permission-checked SSE notifications. No provider request is made
for a heartbeat. The UI refreshes on events; disconnected SSE uses bounded fallback.

With completion events enabled, missing-event reconciliation waits 60 seconds
before the native completion read. This is a recovery interval, not a deliberate
backup completion delay. Providers without that capability retain existing polling.
Stop/resume receipt checks keep their existing shorter cadence.

Provider backup names retain `nickhosting-operation-<job UUID>` for crash recovery;
human names are local labels and do not destroy that identity. A restore records
its target and prior receipt separately from an optional safety backup. Occurrence
timestamps retain microseconds. The upstream restore callback has no attempt token:
a newly emitted duplicate callback from a previous attempt cannot be conclusively
distinguished from a current attempt solely from native metadata. Delayed delivery
of already recorded events is deduplicated and bounded by operation timestamps.

## Scheduling and retention

Schedules reuse durable jobs, admission and permissions. Backup mode is persisted
with the schedule. Retention is disabled by default; enabled retention keeps the
configured number of successful schedule-owned backups, never deleting protected
or unrelated backups. Cleanup follows successful creation; it never deletes the
last recovery point merely to make room for an unconfirmed backup.

Safe post-success retention needs one free slot: keepLast must be lower than the
mapped native backup limit. Protected/manual backups still occupy quota and can
require user action. Native creation rejects a full quota; no override/autodelete
flag is sent. Cleanup failures are reported separately and are not backup failures.

## API and deployment

- `POST /v1/servers/:id/operations`, action `backup`: extended options.
- Same operation endpoint, action `restore`: optional safety backup.
- `GET /v1/servers/:id/backups`: native metadata with local human labels.
- `PATCH /v1/servers/:id/backups/:backupId`: name/protection, existing manage permission.
- `GET /v1/servers/:id/backups/events`: authenticated SSE invalidation hints.
- Existing delete/download contracts remain; downloads include an archive filename.
- Transfer descriptors expose backup quota, SDK policy and event availability.
- Operation detail exposes sanitized `backupResult`, not internal plans/secrets.

Migration 037 adds event receipts, local labels, feed capability state, schedule
options and commit-only database notifications. It is explicit, never run by source
HMR. New backup effects require the migration; unrelated existing services remain
available before migration. Blueprint adds only its owned event-marker migration.
No Wings patch, public port, Docker network or new production service is required.

Activation and live backup/restore tests are separate approved operations. Retain
prior source/images/package and private database backup. Do not downgrade while
new-format backup/restore operations remain active. The previous application
can retain additive tables; do not drop tables or overwrite subsequent data during
routine rollback. SFTPGo issue #18 remains an independent release gate.

## Verified upstream contracts

- [Native backup creation and quota](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Services/Backups/InitiateBackupService.php).
- [Native completion, S3 finalization and restore activity](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Http/Controllers/Api/Remote/Backups/BackupStatusController.php).
- [Activity transaction and subject ordering](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Services/Activity/ActivityLogService.php).

Archive browsing and selective file restoration are not implemented by this change.
