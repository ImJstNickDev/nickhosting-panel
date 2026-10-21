# NickHosting Blueprint bridge

Version **1.8.1**, targeting Pterodactyl **1.15.1** and Blueprint
**beta-2026-08**. Native PHP contracts retain compatibility with Panel **1.11.11**
for coordinated rollback; the framework target and live deployment evidence are
separate from that library-level compatibility. The monorepo is the source of truth; `.blueprint/dev` is optional
Blueprint build staging. Do not use `-build` on production as a development loop.
Actual deployment evidence is recorded in [the extension report](../../docs/BLUEPRINT-EXTENSION.md).

## API contract

Administrative paths below are relative to `/api/application/extensions/nickhosting`.
Every request requires an Application token; browser sessions and Client tokens
are rejected. Blueprint's existing Application rate limiter remains in force.
All responses use `Cache-Control: no-store`.

| Method/path | Permission | Behavior |
| --- | --- | --- |
| GET `/capabilities` | servers READ | Schema/version/features |
| POST `/instances/{instance}` | servers WRITE | Register or rotate callback secret for exact instance UUID |
| GET `/instances/{instance}/health` | servers READ | Pending delivery count, last delivery and checked time |
| PUT `/instances/{instance}/servers/{uuid}` | servers WRITE | Explicit exact-identity link and authoritative snapshot |
| GET `/instances/{instance}/servers/{uuid}` | servers READ | Fresh authoritative snapshot, detect bypassed model events |
| POST `/instances/{instance}/users/{nickUser}/provision` | users WRITE | Idempotent nonadministrator technical-account creation |
| PUT `/instances/{instance}/users/{nickUser}` | users WRITE | Explicit nonadministrator account link |
| POST `/instances/{instance}/users/{nickUser}/keys` | users WRITE | Idempotent native Client key issuance |
| POST `/instances/{instance}/users/{nickUser}/keys/{identifier}/rotate` | users WRITE | Issue replacement, retain original until explicit acknowledgement/revoke |
| DELETE `/instances/{instance}/users/{nickUser}/keys/{identifier}` | users WRITE | Revoke only this extension's exact linked-account key |

### Bulk upload URLs — Client API

`POST /api/client/extensions/nickhosting/servers/{server}/upload-urls` accepts
`{count:1..uploadBatchLimit}` (default/maximum 500) and returns `{expiresAt:ISO8601,urls:string[]}`. `{server}` is the
native short identifier or UUID. Capability discovery reports `bulkUploadUrls:true`.
This route uses Blueprint's native Client authentication, IP restrictions and
rate limiter, plus Pterodactyl's server-state middleware and `file.create`
permission. Only a real account API token is accepted; browser sessions and
Application tokens are rejected.

The exact server must have a valid extension link, unchanged provider identity
and owner, and a matching linked non-admin owner account in the same instance.
Subusers and unrelated or invalidated resources cannot obtain bulk URLs.
Native `NodeJWTService` generates a different `unique_id` for each upload, all
with the same configured expiry (default/maximum 15 minutes). There are no Wings calls or file mutations during
issuance. The backend keeps these bearer URLs private; do not log, persist in
public state or return them to browsers. Each URL is consumed once by Wings.
Issue replacements for unused expired URLs; never replay an uncertain upload
simply because a fresh token can be generated. A lost issuance response may be
retried because issuance itself does not write files.

Bulk issuance reduces repeated Panel HTTP/auth/bootstrap overhead without
changing Wings transfer semantics, file overwrite behavior or transactional
guarantees. Native signed upload URLs remain server-scoped, not filename-scoped;
NickHosting's existing upload admission and manifest checks remain responsible
for per-file access. As with native upload URLs, revoking the Client key does not
revoke an already-issued Wings token before its expiry.

### Bulk download URLs and transfer settings — Client API

`GET /api/client/extensions/nickhosting/servers/{server}/transfer-settings`
returns `{downloadBatchLimit,uploadBatchLimit,signedUrlTtlSeconds}` with no cache.
`POST /api/client/extensions/nickhosting/servers/{server}/download-urls` accepts
`{paths:string[]}` and returns `{expiresAt:ISO8601,urls:string[]}` in exactly the
requested order. Capability discovery reports `bulkDownloadUrls:true`.
Both routes require a real account Client token, native `file.read-content`
permission, native server-state middleware and the same exact managed owner/link
checks as bulk uploads. They do not permit subusers, administrators or unrelated
resources, even if native file permissions would allow them.

Paths must be unique, relative, canonical UTF-8 strings of at most 4096 bytes.
Leading/trailing slashes, empty/`.`/`..` components, backslashes, percent signs and
Unicode control/format characters are rejected. The request body is bounded to
12 MiB and the count to `downloadBatchLimit` (default/maximum 2500). The response
contains bearer URLs, not file metadata. Each native Wings token permits only its
exact server and file path, with a unique one-use ID. The leading slash is added
only to the signed claim; no URL decoding or pathname rewriting occurs.

Signing does not list directories, read files, contact Wings or establish that a
file exists. NickHosting can reuse its directory listing, prepare URLs in the
background and replenish only the URL consumed by a read. Transfer settings and
managed identity are resolved once per request, never inside the token loop.
The native signer is retained unchanged. URLs must remain backend-only and
memory-only; cache scoping, consumption and local authorization belong to
NickHosting. Signature issuance is not evidence that a download occurred, so
prefetch does not emit misleading per-file download events in the Panel.
Client-key revocation does not revoke already-issued native Wings URLs before
expiry; the NickHosting backend must recheck local authorization before use.

### Directory batches — Client API

`POST /api/client/extensions/nickhosting/servers/{server}/directory-list` accepts
JSON `{directories:string[]}` and returns `{results:[{directory,files}|{directory,error}]}`
in exactly the requested order. Each directory appears once. `files` contains the
native Panel `FileObjectTransformer` fields, not Fractal envelopes. An empty
directory returns `files:[]`; a failed directory never becomes an empty success.
Errors are `not_found`, `forbidden`, `unavailable`, `too_large` or
`deadline_exceeded`, without upstream messages, tokens or node addresses.
Capability discovery reports `bulkDirectoryListings:true`.

`GET /api/client/extensions/nickhosting/servers/{server}/directory-settings`
returns `{directoryBatchLimit,directoryConcurrency,directoryTimeoutSeconds}`.
Both routes require a real account Client token, native `file.read`, native
server-state middleware and the exact linked nonadministrator owner and server
identity. These checks and settings reads happen once per batch. Native listing
routes are unchanged; callers can use batches without replacing ordinary
directory reads.

Paths use the download batch's canonical UTF-8 rules, except `''` identifies the
root directory. The request restores the exact names from its bounded JSON body
after native trim/null middleware, so root and names containing edge spaces are
preserved. Bodies are limited to 512 KiB, with at most 64 unique paths of 4096
bytes each. No recursion, retries, signed URL generation or file downloads occur.
Wings itself may read file prefixes while computing its native MIME metadata.

The extension reuses the native daemon HTTP client and node authentication
inside the Panel. A Guzzle pool dispatches at most the configured number of reads;
each uses the remaining monotonic whole-batch deadline, not the native 60-second
timeout. Redirects are disabled. A Wings 429 stops dispatching pending directories.
Each response is bounded while streaming, even without Content-Length: 4 MiB per
directory, 8 MiB aggregate input, 10,000 entries per directory, and 8 MiB aggregate
serialized output. A limit yields an explicit per-path error, never a truncated
successful list. Metadata is held only for the request; no recursive cache is added.

Live measurements supporting the stable defaults are recorded in the extension
report. Rollback to the retained 1.3.0 artifact removes the new routes/capability without a schema migration,
data reset or change to existing uploads/downloads/account links. The new optional
settings may remain stored and are ignored by 1.3.0. Installation or rollback on
the real Panel still follows the Owner-approved Blueprint workflow.

### Scoped file operations — Client API (1.6.0)

Capability discovery adds `fileOperations:true`. Per-server
`GET /api/client/extensions/nickhosting/servers/{server}/file-operation-capabilities`
returns `{inspection:true,guardedDelete:true,archiveCommit:true,uploadPublication:true}`. Older versions
return 404; callers choose their existing stock-provider fallback before starting
an operation, never after an uncertain effect.

All routes retain native Client authentication and server-state middleware and
require the exact linked nonadministrator owner credential. Inspection requires
native `file.read-content`, deletion `file.delete`, archive commit `file.create`.
Managed provider identity is checked inside the same request; no separate
Application API identity round trip is required.

`POST .../file-inspection` accepts `{target,guardFile}` and returns
`{identity,target:{path,observation},guard:{path,sha256,contents}}`. Paths are
canonical relative UTF-8. The target must be a non-symlink directory. One bounded
native Wings parent listing and one bounded guard-file read run concurrently.
The guard must be an exact regular, non-symlink file without case aliases. Its parent metadata reuses the target listing when possible. The guard is UTF-8 text, at most 1 MiB; directory responses are limited to 4 MiB /
10,000 entries. Native Wings has no individual stat endpoint, so a parent listing
is necessary. The endpoint does not inspect JARs, game versions or other files.

`POST .../guarded-delete` accepts
`{operationId,identity,target:{path,observation},guard:{path,sha256}}`. The guard
must lie outside the removed subtree. The endpoint compares fresh target metadata
and guard SHA-256, then sends exactly one native Wings deletion. It returns
`{operationId,identity,target,state:"confirmed"|"uncertain"}`. Core interprets the
guard content and owns active-world rules and local authorization.

`POST .../archive-commit` accepts
`{operationId,identity,destinationRoot,archiveSha256,files:[{path,size}]}`. Every
manifest file is under the single-component `destinationRoot`; at most 10,000
files / 4 MiB JSON. Core first streams its validated, CRC-checked, sanitized ZIP
to `.nickhosting-import-<operationId>/payload.zip`. The SHA-256 binds the request
and receipt, without downloading the archive again. This is a trusted backend
contract, not an endpoint accepting arbitrary browser-provided ZIP manifests.

In one Panel request the extension extracts through native Wings, verifies the
exact extracted tree and file sizes with two concurrent bounded metadata reads,
checks the final destination is absent, publishes via native rename, checks both
source and destination, and deletes only that operation's scratch directory. Any
missing/ignored/extra entry prevents publication. The response is
`{operationId,identity,destinationRoot,archiveSha256,state:"confirmed"|"uncertain"}`.
The adapter gives archive commit a bounded 90-second deadline while ordinary requests keep their existing timeout. The stock decompression/rename endpoints are unchanged. No SFTP permissions,
Wings code, node configuration or filesystem mounts are changed.

The additive `nickhosting_file_operations` table persists dispatch intent and
confirmed receipts. Repeating an operation UUID with the same parameters returns
its receipt without repeating filesystem mutations; changed parameters return
409. A response lost after dispatch, partial native failure or process crash
remains uncertain. Recovery must inspect and resolve it; neither method blindly
replays. A pre-dispatch validation rejection is preserved as a rejection. No DB
transaction stays open during node I/O. Receipts must not be pruned while Core
can still retry the operation; rollback preserves this table.

Version 1.8.0 adds `POST .../upload-publication` for replacement uploads. It accepts
`{operationId,identity,source,destination}` and returns
`{operationId,identity,destination,state:"confirmed"|"uncertain"}`. Native
`file.update`, account-token and managed-owner checks remain required. Source is
the unique sibling `.nh-upload-<operationId>.pending`; destination is an existing
regular file. Core finishes the upload and preserves the original permission
mode on the stage before publication. New files still use native rename directly.

Wings refuses rename over an existing destination. The extension therefore checks
one bounded parent listing, records dispatch intent in the existing receipt table,
renames the original to `.nh-upload-<operationId>.previous`, then renames the stage
to its destination. One readback must show the stage absent, the new file present
with its staged metadata and the backup with the old metadata. Only then does it
persist confirmation and delete that one backup. Failed cleanup leaves recoverable
old bytes without repeating publication. Migration
`2026_10_19_000006_nickhosting_file_operation_recovery` adds one nullable JSON
column to the existing receipt table. It retains the exact source, destination,
backup and observed original/staged metadata before the first rename, allowing
an administrator to identify the recoverable files after process loss. Existing
receipts remain valid with NULL context; preserve the column on code rollback.

This is recoverable publication, not an atomic filesystem replacement. A timeout,
crash or failed readback keeps the stage/backup as observed and returns uncertainty;
the same operation UUID never replays a rename, deletes remnants or guesses a
rollback. Recovery must inspect the retained files and exact operation receipt.
Cancellation before publication removes only the private stage; after dispatch,
Core preserves uncertain artifacts. No operation truncates the old file first.

Native limitations remain explicit: directory observations are metadata hashes,
not inode identities; guard checks and deletion are not filesystem compare-and-
swap. Native rename is not promised atomic no-replace against external concurrent
filesystem changes. Core serializes its own mutations. The scratch namespace is
an operation convention, not an OS access-control boundary against the same
server's privileged user. Actual extraction and recursive deletion require disk
work; successful receipts represent confirmed effects, not optimistic UI removal.

### Administrator settings

The extension's administrator page stores these operational values through
Blueprint's `nickhosting` namespace. Defaults require no migration or reset.

| Setting | Default | Allowed range |
| --- | --- | --- |
| `directoryBatchLimit` | 48 | 1–64 |
| `directoryConcurrency` | 2 | 1–4 |
| `directoryTimeoutSeconds` | 8 | 1–10 seconds |
| `downloadBatchLimit` | 2500 | 1–2500 |
| `uploadBatchLimit` | 500 | 1–500 |
| `signedUrlTtlSeconds` | 900 | 60–900 seconds |
| `webhookBatchLimit` | 10 | 1–10 events/job |
| `webhookConnectTimeoutSeconds` | 2 | 1–2 seconds |
| `webhookTimeoutSeconds` | 4 | 1–4 seconds |

Lower batch limits can reduce individual PHP request work. New values apply to
subsequent requests/jobs; already-issued URLs retain their original expiry.
Missing fields in older forms preserve their current values, including `origin`;
an explicitly blank origin still disables notifications. Invalid stored numeric
values fall back to bounded defaults. The connection timeout is clamped to the
response timeout. The webhook bounds preserve the existing 60-second job timeout
and 120-second claim lease; retries, identity checks, permissions and signature
validation are not optional administrator settings.

Instance UUIDs must be unique per NickHosting environment/provider. An instance
is pinned to the registering Application token's database ID. Changing that
Application key requires a deliberate bridge migration, not silent takeover.
Registration body: `{callbackUrl, webhookSecret}`; secret is 64 lowercase hex
characters, used as its **literal string** in HMAC (not hex-decoded). Only HTTPS
origin selected in the extension's administrator page is accepted. Blueprint
stores it in the namespaced `nickhosting::origin` setting; registration and each
delivery read it dynamically. No userinfo, query, fragment or redirects.
Blank disables registrations and delivery. Saving an origin does not retarget
existing instance callbacks or prove connectivity; the page shows actual pending
notifications and last acknowledged delivery. The approved origin is a trusted
administrative destination, not an arbitrary-user URL.

The update migrates a single valid legacy `config/nickhosting_bridge.php` origin
only when the setting is absent. Existing values, including blank, are preserved;
multiple legacy origins require explicit Owner selection. The legacy file becomes
inert and may be removed after backup and migration verification. A rollback to
1.0.0 requires restoring that configuration. Hostname changes also require a
separately planned NickHosting instance migration; saving the new URL alone does
not silently retarget identities.

Server link identity: `{providerId, providerUuid, identifier, externalId, nodeId}`.
Every field must match the live Panel model. A name/prefix is never proof.
One server cannot be linked to another instance. Identity drift invalidates the
link until a deliberate administrative migration; retrying ordinary PUT does
not silently repair or retarget it. Provider owner changes also invalidate the link.
An explicit PUT with `expectedOwnerId` can revalidate an owner handoff only when
all original immutable fields still match and the live owner equals that exact ID.
It advances the revision and audits the handoff; GET never repairs ownership. Only limits are synchronized; allocation
inventory, ownership/admission and Gateway topology checks remain independent.

Events/snapshots: `{schemaVersion:1,eventId,instanceId,server,revision,type,limits,occurredAt}`.
Types are `snapshot`, `limits.updated`, `identity.invalidated`. Limits contain
`memory,swap,disk,io,cpu,threads` (threads nullable). Revisions are per linked server;
invalidation retains the originally registered identity so the receiver can revoke
its exact projection. Snapshot reads set `occurredAt` to the actual read time.
Linking queues an initial `limits.updated` delivery as well as returning a snapshot.

Webhook headers: `X-NickHosting-Timestamp` Unix seconds,
`X-NickHosting-Event-Id`, `X-NickHosting-Signature` = HMAC-SHA256 of
`timestamp + '.' + exact JSON bytes`. Receiver must bound body size, verify the
signature/timestamp/event ID, persist before acknowledgement, deduplicate and
reject stale revisions. A 2xx response acknowledges delivery. No credentials,
startup environment or game files are serialized in events.

### Native backup outcomes — signed notifications

Version 1.5.0 advertises `backupEvents:true`. Native Client backup create, list,
lock, restore and delete routes remain unchanged. The extension listens to the
native `ActivityLogged` event for `server:backup.complete`, `server:backup.fail`,
`server:backup.restore-complete` and `server.backup.restore-failed` (the last
spelling is the native 1.11.11 failure event). It does not infer restore success
from the server returning to an ordinary status.

Envelope: `{schemaVersion:1,eventId,instanceId,server,occurredAt,type,backup}`.
`type` is `backup.completed` or `backup.restore-completed`. `backup` contains
`{uuid,name,isSuccessful,checksum,bytes,completedAt}`. Nullable checksum and byte
count describe the backup archive; `isSuccessful` describes the reported action.
For restores, both timestamps describe the restore occurrence, never the old
archive completion time. These events have no limits or revision and do not
advance the linked server's limits revision. Only exact, valid linked server
identities and unchanged owners can produce a notification.

Native backup completion saves its activity after S3 finalization. Activity events
fire inside the native transaction before activity subjects are inserted. A new
extension-owned `nickhosting_backup_events` table records a source marker in that
same transaction. After commit, the extension resolves the committed subjects and
atomically writes the event into the existing outbox while marking the source
processed. S3/native transaction rollback therefore removes the source too. A
process crash before the after-commit callback leaves a recoverable marker;
existing scheduled delivery jobs materialize pending markers before delivery.
Missing or pruned native subjects remain uncertain and retry at most every fifteen
minutes, without manufacturing success or starving later sources.

The same activity ID always retains the same event ID. Backup completion is also
deduplicated by backup UUID. Distinct native restore activity IDs are distinct
outcomes because the native callback has no restore-operation identifier; receivers
must deduplicate delivery by event ID and reconcile current provider state. The
existing exact-body HMAC, destination policy, retry and acknowledgement rules apply.
No Panel/Wings controller, model, route or core file is modified.

The migration is additive and retained on rollback. Rolling code back to 1.4.0
stops capturing new backup outcomes; pending generic outbox rows remain deliverable,
and source markers await a compatible version. Retain both extension tables and
native activity/backup subjects during recovery; this feature does not backfill
historical activities from before installation or replace native backup listing.
Production installation remains a separate Owner-approved operation.

## Delivery and recovery

The global Laravel service provider listens synchronously to server Updated and
Deleted events. Relevant changes write an extension outbox in the existing Panel
transaction. After commit, a normal `standard` queue job attempts delivery.
Queue publication failure leaves the outbox intact. The existing Panel scheduler
queues recovery every minute. Each job handles the configured event count (default/maximum ten), with bounded
configurable connect/response timeouts and retry backoff up to 15 minutes. Claims expire after
120 seconds; crashes can duplicate delivery but cannot erase an unacknowledged
event. Events can arrive out of order: consumers must use revisions and resnapshot.

Normal transactional Panel edits share commit/rollback with the outbox. Direct
SQL, bulk updates, disabled model events or custom nontransactional writes can
bypass that guarantee. Periodic authoritative snapshots are mandatory recovery;
no claim of instantaneous consistency is made. Delivered events and audit rows
are retained; operators must plan explicit retention before high-volume deployment.

## Technical accounts

`POST /instances/{instance}/users/{nickUser}/provision` accepts an empty JSON
object and returns `{providerId,providerUuid,externalId}`. It invokes the installed
native `UserCreationService` with a random password that is never returned or
retained. Username is `nh-` plus a deterministic 29-character digest; the opaque
email is under `accounts.nickhosting.invalid` and never uses the person's email.
The external ID includes the instance and NickHosting UUID. No email/username
matching adopts an existing account. Any unlinked identity collision fails closed.

The existing instance row is locked before creation; the native account and exact
technical link commit together. A lost response can be retried without a second
account. The technical marker is separate from legacy explicit user links, so
existing users do not acquire browser restrictions merely by linking a key.

Middleware on the web/Blueprint and authenticated API groups blocks technical
browser sessions, login, password recovery/reset and pending 2FA checkpoints.
A login event guard provides additional coverage. Only actual account API tokens
on Client API paths pass; cookie-based Sanctum tokens do not. Notifications and
direct mail addressed to exact technical accounts are suppressed. During native
creation an in-process exact external-ID scope covers synchronous mail before
the durable link is inserted. Queued mail checks the committed link when sent.
Neither an `nh-` name nor the email domain alone establishes managed identity.
Unrelated users, including existing Panel administrators, remain unaffected.

Keep these guards installed while technical accounts exist: uninstalling or
rolling back to 1.0 removes their browser/mail protection. Retire accounts/keys
or plan equivalent restrictions before removing the extension. The extension
does not automatically move existing servers or migrate ordinary linked accounts.

## Account keys

Link body `{providerId,providerUuid,externalId}` identifies an account explicitly
selected by authorized NickHosting administration. This legacy link endpoint performs no email matching, account
creation, ownership reassignment or migration. Root admins,
identity changes and cross-instance reuse are rejected. Mint/rotate bodies use
`{operationId,allowedIps?}` (UUID idempotency key, optional IP/CIDR restrictions).
Responses `{operationId,identifier,key}` are backend-only. Native Pterodactyl
`User::createToken` is used. An encrypted issuance response permits recovery after
a lost response; reuse with changed parameters or after revocation is rejected.
Rotation intentionally overlaps: store/verify the replacement, then explicitly
revoke the old key. Existing tokens not created by this extension are untouched.
Revocation deletes the exact key and encrypted recovery value, not users/servers.
It does not promise immediate termination of previously issued Wings WebSockets.
NickHosting account migration/credential selection must be enabled separately.

## Installation, update and removal

The standard Blueprint install command also updates an existing extension. The
new package's `private/install.sh` runs on install/update. It migrates **only** the
extension-owned migration path, then adds a marked provider entry in `config/app.php`.
The hook refuses unknown layouts and keeps a permission-restricted source backup
under `storage/app`. Installation migrates the legacy callback origin without overwriting Owner settings. No Panel core migration, account mutation or server operation is invoked.

The provider must load in HTTP, CLI and queue contexts even with route caching.
Standard Blueprint finalization rebuilds config/cache and signals queue restart;
its ordinary ownership/permission changes still apply. Verify those effects and
back up the Panel before an approved install. Hook exit failures must be checked
in output: do not assume Blueprint's final success banner proves migration success.

Uninstall removes only the exact marked provider entry. It deliberately retains
outbox, audit, instance links, Blueprint settings and issued keys for recovery and
accountability. Revoke keys explicitly before uninstall if intended. The migration
refuses destructive down: data retirement requires a separately reviewed backup
and scoped operation. Rolling back code is not rollback of Panel permissions or
extension data; restore the original config/metadata snapshot where necessary.

## Local checks and packaging

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s extensions/nickhosting/tests -v
python3 extensions/nickhosting/tests/run_php_tests.py --container <existing-panel-container>
python3 extensions/nickhosting/package.py
```

The PHP harness loads only Composer libraries and extension source via stdin;
it does not bootstrap the Panel. Database writes use SQLite `:memory:`, and HTTP
uses Laravel fakes. It exercises transaction rollback, idempotency, encryption,
authorization, identity invalidation, delivery retry and configuration transforms.
It is not a MySQL lock-concurrency or real HTTP middleware test. Packaging uses
an explicit file allowlist, excludes secrets/tests/docs, rejects symlinks and
existing output, and defaults to ignored `build/blueprint/1.8.1/nickhosting.blueprint`.

The [extension-only update procedure](UPDATE-INSTALLED.md) supports the reviewed
1.5.0 → 1.6.0 and 1.6.0 → 1.6.1 transitions. Its default is a read-only plan;
explicit approval is required to apply it. The original deployment's native
installer ownership hazard was removed by the approved Panel/Wings mount
separation; the original failure remains historical evidence, not a claim that
all future extension hooks are safe. The Owner-approved native update to 1.6.1
was subsequently verified on 2026-10-18: no game ownership or permission changes
were detected across 28 server roots. See the
[activation record](../../docs/M5-VALIDATION.md#native-blueprint-161-activation--2026-10-18).

Version 1.2.0 introduced bulk upload URLs. Version 1.3.0 adds bulk path-scoped
download URLs, transfer settings discovery and configurable operational bounds;
neither adds a database migration. The transfer tests use the installed native
permission policy, server-state middleware and JWT service with isolated model
data and an ephemeral signing key. They verify signatures, exact claims, expiry,
unique consumption IDs, response ordering, canonical paths, configured limits,
constant per-batch query count and settings preservation without contacting Wings.
Version 1.4.0 adds directory batches and three configurable bounds. The stable
defaults are 48 directories per request and two parallel Wings reads, with an
eight-second whole-batch deadline. Updating preserves all saved Owner settings;
the new defaults apply only when a setting is absent or invalid.
The admin view lists concise responsibilities in English and Italian.

Version 1.6.1 corrects unintended serialization in archive commits and guarded
file inspections: each operation shares one native Wings client, including
mutation requests. Directory verification uses a rolling bounded window with
the existing concurrency setting. Wings can silently skip denylisted archive
members, so a successful extraction response still requires the exact manifest
check before publication. Debug callers may request archive phase timings;
these are diagnostics, never completion evidence or part of the receipt identity.

## Upstream reference / licensing

- [Blueprint manifest](https://blueprint.zip/docs/configs/confyml)
- [Pinned installer](https://github.com/BlueprintFramework/framework/blob/beta-2025-09/scripts/commands/extensions/install.sh)
- [Pterodactyl token API](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Models/Traits/HasAccessTokens.php)
- [Pterodactyl events](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Observers/ServerObserver.php)
- [Native upload URL controller](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Http/Controllers/Api/Client/Servers/FileUploadController.php)
- [Native node JWT service](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Services/Nodes/NodeJWTService.php)
- [Scoped node JWT service](https://github.com/pterodactyl/panel/blob/v1.15.1/app/Services/Nodes/NodeJWTService.php)
- [Blueprint coordinated update guide](https://blueprint.zip/guides/admin/updatepanel)
- [Blueprint extension install/update command](https://blueprint.zip/docs/cli/commands)

Implementation independently uses existing public framework/model contracts.
No Blueprint/PteroCA/closed-source implementation is copied or bundled; no new
repository license decision is introduced.

### Provider compatibility — 1.8.0

The three token issuers use the native Panel signer with exactly one scope on
Panel 1.15.1: `FileUpload`, `FileDownload` or `Websocket`. Scope selection happens
once per batch and replaces the previous scope if a signer is reused. Path,
server/user identity, expiry, one-use identifiers and installation-only
permissions are unchanged. Panel 1.11.11 has no scope setter or enum: the helper
preserves its native signer and does not resolve the newer enum. If a scope setter
exists but its enum is incomplete, issuance fails rather than silently omitting scope.
This does not make an old Panel/new Wings pairing supported: all native Panel
token issuers must also match Wings.

The in-memory harness uses each Panel generation's actual native signer,
permission policies, account/key services and ActivityLogService. It checks
signed scopes and restricted claims, native account auditing, transaction
rollback and the existing directory/transfer/event contracts. Activity tables
are prepared before native account creation because the target Panel now emits
an account-creation activity. No live database or game data is used. Library
tests do not replace the coordinated HTTP/WebSocket/Wings smoke tests.

Compatibility validation on 2026-10-19: **379 checks passed on each native Panel
generation**, plus **28 packaging/update-planner tests**. The target image uses
PHP 8.3.33, Laravel 12.64.0, Sanctum 4.3.3, Carbon 3.13.1 and lcobucci/jwt 5.6.0.
The target harness ran without network access or live mounts; the legacy harness
loaded installed libraries without bootstrapping the Panel. Both exercised the
provider registration transform against the actual `config/app.php` text without
writing it. This evidence does not certify other installed Blueprint extensions.

No extension migration or custom installation path is added. Package normally
and update with `blueprint -install nickhosting` after preserving the existing
extension state and reviewing the coordinated provider rollback. The historical
`update-installed.py` remains limited to its already documented 1.5/1.6 layouts;
it is not an alternative installer for 1.8.0. The provider upgrade must separately
handle Wings streaming-upload cancellation, token invalidation and rate limits.


### Installation transport — 1.7.0

`GET /api/client/extensions/nickhosting/servers/{server}/installation-websocket`
returns native Wings `{data:{token,socket}}` with `Cache-Control: no-store`.
Only a real Client API account token with `websocket.connect` and the exact
linked non-admin technical owner is accepted. The managed server ID, UUID,
external ID, node and linked account identity must match. This one route omits
`AuthenticateServerAccess`, whose installing restriction would otherwise block
the feature; suspension, node maintenance, restore and transfer restrictions
remain enforced explicitly.

The native ten-minute JWT grants exactly `websocket.connect` and
`admin.websocket.install`, scoped to the server UUID and user UUID. It grants
no command, power or file permissions. Wings also permits ordinary console output
with `websocket.connect`; NickHosting's relay filters those frames out. It keeps the
JWT on the backend, validates the Wings origin/path and relays only installer
output and started/completed events. The ordinary console route is unchanged.
The native `send logs` command is not an installer-history endpoint: NickHosting
collects a bounded installer log from the live channel instead.

The existing native `Server\Updated` model event also records an
`installation.updated` event in the existing transactional signed outbox when
`status` or `installed_at` changes. Its envelope is
`{schemaVersion:1,eventId,instanceId,server,occurredAt,type,installation}`;
`installation` is one of `{state:"installing",status:"installing"}`,
`{state:"installed",status:null}`, or
`{state:"failed",status:"install_failed"|"reinstall_failed"}`.
It does not depend on the email-gated `Server\Installed` notification and does
not advance the independent resource-limit revision. Unchanged unrelated
updates, unsuspension and foreign/unlinked server changes do not report an
installation. A repeated callback can wake reconciliation again; the existing
signed event ID fences delivery replay. This event wakes the NickHosting job;
it does not replace managed-identity, installation receipt or resource checks.

Discovery advertises `installationConsole:true` and `installationEvents:true`.
No extension migration or Wings/Panel source patch is added. Installing 1.7.0
requires separate approval of the native Blueprint update and its rollback;
the legacy extension-only updater deliberately does not accept this layout.
The in-memory PHP tests exercise native JWT signing, policy, model observer,
transaction rollback and exact ownership using the installed framework vendor
libraries without bootstrapping the Panel or accessing its database.

### Archive receipt recovery (1.8.1)

An exact uncertain archive commit may reconcile a complete retained extraction or
published marked tree without uploading or extracting it again. Partial or changed
trees remain uncertain. MySQL connection-scoped locks serialize original requests
and retries, including receipt writes after external effects. No migration is added.

Use official Guzzle 7.15.3 with Promises 2.5.2 (or a later compatible fixed pair).
The 7.15.2 / 2.5.1 pair can reject completed parallel requests while verifying a
tree. Do not replace the native Pool with a separate scheduler to mask this bug.
