# M5 WebPanel and common-platform contracts

Implementation checkpoint: 2026-10-09. This supplements the [M1](M1-API.md),
[M2](M2-API.md), [M3](M3-API.md) and [M4](M4-API.md) contracts; their existing
routes and list shapes remain supported. See [common integration acceptance](M5-COMMON-INTEGRATION.md)
for implementation/test traceability. The backend is authoritative: UI capability
and availability hints never grant permission, admission or compatibility.

## Requests, authority and browser transport

The same-origin application uses the existing verified Better Auth session,
mutation Origin/CSRF checks and structured errors (`code`, `messageKey`, request
identity where supplied). JSON mutations require `application/json` and validated
bodies. TypeScript return types are shared through erased type imports; dates
become ISO strings on the wire. Ordinary users, project collaborators, regular
Owners and assisted sessions retain their existing distinct authority. Sensitive
writes refresh interactive authorization under the relevant resource lock.

The client disables automatic mutation retries. An explicitly retried logical
request retains its idempotency key; accepting a job displays its identity/state,
not completion. The application never stores Pterodactyl tokens or support tokens
in JavaScript-readable storage. Locale preference is not an authentication token.

| Method/path | Result or behavior |
| --- | --- |
| `GET /v1/web/config` | Safe instance name/default locale, email/Discord configuration availability, supported passkey/TOTP flows and whether a support cookie is present. Presence is not proof of authorization. |
| `GET /v1/web/session` | Current `context`, safe `actor` and `subject` profiles, including nullable same-origin `avatarUrl` for their uploaded photo. Actor and effective subject are displayed separately in assisted mode. No image bytes or OAuth image URLs are projected. |
| `GET /v1/web/account/sessions` | Regular session; all of the caller's unexpired persisted browser sessions, newest first. Array of `id`, `createdAt`, `expiresAt`, nullable `userAgent`/`ipAddress`, and `current`. No tokens or user IDs. Closing a browser does not remove a session; no five-minute freshness requirement applies. |
| `DELETE /v1/web/account/sessions/:id` | Regular session and Origin protection; resolves only the caller's session ID, then uses Better Auth revocation and its audit hooks. Returns 204; unknown/foreign IDs return 404. Revoking the current session signs out this browser. |
| `PUT /v1/web/profile-photo` | Regular session; `image/png` body, at most 300 KiB, exactly 256×256 pixels. Validates and re-encodes a static, non-interlaced PNG, atomically replaces the caller's thumbnail and audits the change; returns `{avatarUrl}`. |
| `DELETE /v1/web/profile-photo` | Regular session; removes only the caller's photo, idempotently, with audit. Returns 204. |
| `GET /v1/web/profile-photo/:userId?v=:revision` | Authenticated image read, restricted to current actor/effective subject and exact content revision. Returns `image/png`, `nosniff`, no public caching. Foreign/missing/old revisions return 404. |
| `POST /v1/web/support` | Existing regular-Owner step-up/reason/grant requirements; sets `nh.support` as HttpOnly, SameSite Strict, path `/`, HTTPS Secure when configured. Returns grant metadata/expiry, never its token. |
| `POST /v1/web/support/exit` | Revokes the exact grant when the parent session authorizes it and clears the browser cookie. Expired/invalid parent authority still permits local cookie removal; this does not claim durable revocation of an unauthenticated grant. Storage failures remain errors. |

Existing header clients can still send `X-NH-Support-Token`. Header/cookie disagreement
is rejected. Regular-only identity/admin endpoints reject either assisted transport.
Native file/backup downloads carry the same HttpOnly cookie and authorization as
API calls, without returning privileged upstream URLs. Original user sessions are
unchanged by assisted access or Exit.

Profile photos use the dedicated `user_profile_photos` table (migration036), with
one bounded thumbnail per user and cascading deletion. They never populate Better
Auth's provider-controlled `user.image` field or pass through the game-provider
file APIs. Existing Origin/session checks apply, including assisted-write denial.
No public avatar URL, remote URL import, extra volume or image service is required.
Browser originals are decoded/cropped locally; the server accepts only the small
PNG representation, discards metadata and stores its SHA-256 revision. Replacing
or deleting a photo invalidates its old URL. Schema migration precedes activation.

## Scoped platform queries

[Platform routes](../apps/api/src/platform.ts) delegate to
[typed queries](../packages/server-management/src/platform-queries.ts). Paginated
collections return `{items,nextCursor}`. Common page size is 1–100 (default 30),
with validated opaque descending timestamp/identity cursors. Search text is a
literal substring, not a user-supplied SQL wildcard. User/audit identities may be
text; server/project/job identities are UUIDs. Invalid cursors are domain errors.

| Method/path | Filters/body and contract |
| --- | --- |
| `GET /v1/platform/servers` | `limit`, `cursor` or 1-based `page` (mutually exclusive), `q`, `state`, `gameId`, `runtimeId`, `version`, legacy `ownerId` or repeated `ownerIds=id&ownerIds=id` (mutually exclusive, 1–100 nonempty IDs up to 128 characters each, deduplicated; OR between owners and AND with other filters), `projectId` (UUID or `none`), optional `scope=mine|others`. Default preserves owner/project visibility; `mine` restricts to subject-owned servers; `others` excludes subject-owned servers and requires a regular Owner. Adds `total`, `page`, `totalPages` (minimum 1; excessive pages clamp to last) and `filterOptions={games:[{id,nameKey}],runtimes:string[],versions:string[],projects:[{id,name}],owners:[{id,name}]}`. Facets use the scoped inventory independently of text/status filters; runtime choices narrow by game, versions by game/runtime. Owner choices appear only in Owner `others` scope, without emails. Version is installed Minecraft profile combination release with matching mapping; integrations without persisted installed releases expose no version choices. Legacy cursor order and `nextCursor` remain supported; totals precede cursor filtering. |
| `GET /v1/platform/servers/:id` | Existing public server fields plus `gameId`, `runtimeId`, `gameNameKey`, `capabilities`, `permissions`, `availableActions`, `sleepState`, `wakeEnabled`, `firstStart`. `wakeEnabled` is a configuration hint: effective global Gateway enabled with ID/host, per-server policy enabled, Gateway connection, supported wake capability (including manual base manifests whose enabled policy validates the installed protocol), and neither manual-stop nor maintenance intent. It does not certify routes, process readiness, provider health or live admission; temporary blocked states remain separate in `sleepState`. |
| `PATCH /v1/platform/servers/:id` | Strict `{name?,projectId?}`. Manage permission for rename; resource owner or regular Owner for regrouping. Destination project belongs to the same resource owner. Runtime mapping, provider identity and allocation claims are immutable here. |
| `GET /v1/platform/projects` | Paginated `q` search; current membership and effective management role. |
| `GET /v1/platform/projects/:id` | Project metadata, safe owner and member profiles/roles. |
| `PATCH /v1/platform/projects/:id` | `{name}`; project owner or regular platform Owner, under the resource lock. |
| `DELETE /v1/platform/projects/:id` | `{confirm:true}` with project-owner or regular-Owner authority; returns detached-server count. Deletes grouping/memberships, retains servers and their owner/resource charges. |
| `POST /v1/platform/projects/:id/collaborator` | Exact verified-email lookup, available only to the project owner or regular platform Owner; `{user: safeProfile|null}`. No ordinary global account directory. |
| `GET /v1/platform/quotas` | Effective subject's current quota, commitments, measurements and override state. Home `storageUsage={bytes,expiresAt}` uses a 30-second display lifetime, independently of strict admission freshness. Complete valid totals expire at the oldest contributing sample plus 30 seconds; missing, future, expired or unsafe totals return null fields. Empty inventories return zero with no expiry. Clients honor `expiresAt` without displaying a timestamp. Worker cadence and safety checks are unchanged. |
| `GET /v1/platform/activity` | Unified jobs/audit timeline; cursor, `state`, `action`, `serverId`, `category`, `source`, `actorId`, `q`, `from`/`to` filters; current server/project scope. See [Activity](ACTIVITY.md). |
| `GET /v1/platform/jobs/:id` | Scoped operation detail, current effect/phase, up to 200 associated events, `retry`, `ownerRecovery`. |
| `POST /v1/platform/jobs/:id/retry` | `{idempotencyKey}`; returns 202 for an authorized safe new operation intent. Never resets the historical job. |
| `GET /v1/platform/owner/users` | Regular Owner; paginated search/role filtering of NickHosting identities. |
| `GET /v1/platform/owner/users/:id` | Safe identity profile and quota summary; historical quota actions remain available through audit. |
| `GET /v1/platform/owner/audit` | Regular session with `audit:read` (Owner or platform operator); cursor pagination and action/actor/subject/user filters. Preserves actor/subject attribution. |
| `GET /v1/platform/owner/games` | Stored manifests, rollout policies and tester IDs; not a public compatibility catalog. |

Project creation and membership mutation reuse `POST /v1/projects` and
`PUT /v1/projects/:id/members` with `{userId,role}`; `role:null` revokes access.
Revocation applies on subsequent requests and existing live-authority checks.

Server `permissions` separates `read`, `operate`, `manage` and `sharing`.
`availableActions` additionally considers installation, process state, pending
operation/upload, provider identity and resource reservations. It is advisory:
lifecycle handlers recheck permissions, configuration, declared capabilities, immutable runtime identity and admission; undeclared runtime profiles retain their evidence gates.
`availableActions.stop` is false while offline. `availableActions.kill` is a
permission/configuration hint for an active stop with a valid physical-process
baseline and no pending/uncertain escalation. The Console additionally requires
current stopping state, closes obsolete confirmation dialogs, and sends
`{action:'kill',confirm:true,operationId,idempotencyKey}` through M2's operations
endpoint. Status transitions refresh the shared server descriptor; repeated
identical status samples do not trigger repeated descriptor requests. Kill keys
are scoped to the actor and exact parent stop operation; old rejected receipts
remain replay-safe, while a new explicit authorized request may replace them.
Prepared/unknown effects cannot be replayed. Old in-flight stop jobs without a
process baseline cannot be force-stopped through this new control.
Readiness, process state and sleep state must not be collapsed into one badge.
`firstStart` reports the historical durable `denied` event/message/timestamp when
creation succeeded but initial compute admission failed. It is not a new start
request or a declaration that a later successful start failed.

Quota results separate `limits`, `committed`, `remaining`, `override`, `measured`,
`missingMeasurements` and `observedAt`. Active reservations count RAM/CPU;
storage includes configured server and backup allowance. Unlimited count/global
storage allowances are `null`, not zero. Expired overrides remain visible but
inactive. Measurements retain timestamps/staleness and units; absent samples are
not fabricated as zero. Regular Owner quota/role/invitation writes reuse M1/M2
routes and their audit rules.

## Transfer, network, telemetry and sleep descriptors

| Path suffix under `/v1/platform/servers/:id` | Contract |
| --- | --- |
| `/transfers` | `files`, bounded text-editor capacity, upload availability/reason/provider byte ceiling/server disk allowance, streaming download support, public SFTP endpoint/configuration/issuance hints and backup permissions. Download total-size limit is `null`; real provider/storage limits still apply. |
| `/connections` | Domain `mode` plus frozen `connectionMode: gateway/direct`, configured hostname/SRV metadata, DNS states and every allocation role/transport. Gateway ports report `unconfigured`, `disabled`, `unavailable` or `configured`. An issued snapshot lease is configuration delivery, not proof that live collision/reachability checks and listener binding succeeded. Direct ports use only frozen `direct_endpoint` and report `configured`/`unconfigured`, with `reachability: unverified`. Configuration never claims an externally tested connection. |
| `/metrics` | `limit` 1–500 (default 100), `from`, `to`, `before` ISO timestamps; `{items,nextBefore}` in descending observation order. Missing intervals remain gaps. |
| `/sleep-policy` | `{policy,state,proposedPolicy,idleTimeout,policyControlsEditable}`; policy/state remain null when unconfigured or direct. A trusted installed integration may supply a validated initial proposal for Gateway-mode servers. GET never saves it. Permission-aware enabled/protocol/version, idle/readiness/estimate/wake-retry fields and intent-derived mode; hidden timeout fields are omitted for ordinary users; state reuses M3 readiness and startup estimates. |

SFTP connection details require explicit `sftpPublicHostname` and `sftpPublicPort`;
the private SFTPGo API URL is never used as a public fallback. These settings follow
defaults → Owner database settings → environment overrides. Both service configuration
and actual handler permission are still required. `retainedTransportRevocationLimited`
remains true while [issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18)
is unresolved; credential deletion is not an assurance that an established SSH
transport has closed.

File, backup, console, metrics and DNS actions reuse M2 endpoints. Browser uploads
prepare a bounded group with `POST /v1/servers/:id/files/upload-batches`, then send
independent binary XHR requests to `/files/upload?batchId=…&entryId=…&path=…`.
Preparation accepts `{id: UUID,files:[{id,path,bytes,overwrite}]}` (maximum 500
entries per group). Its private durable manifest binds the exact files, actor,
subject, session and managed provider identity. The reply includes `id`,
`concurrency`, `files` with states, and per-entry `rejected` collision results;
`id:null` means no entry was admitted. Repeating preparation with the same ID and
manifest reuses that reservation. A completed ID cannot create another group.
No signed URL or provider credential is returned to the browser.

The Owner setting `uploadConcurrency` defaults to 2, accepts 1–6 and follows
normal settings precedence (`NH_UPLOAD_CONCURRENCY`). Transfer descriptors expose
`concurrency`, `batchMaxFiles` and `batchMaxBytes`; the browser partitions larger
queues by the configured storage budget. This does not impose a fixed total-size
cap on the user's selection. One slot starts the largest pending file (large
means at least 16 MiB); other slots take small files first. All-small queues keep
selection order; all-large queues fill available slots largest first. Each free
slot refills immediately. There is no artificial bandwidth split or promised
network bandwidth allocation.

Preparation reads each distinct destination/ancestor once, shares those reads
with the game guard, and overlaps them with one resource snapshot. It rejects
unsafe/protected paths, checks aggregate disk growth without credit from future
shrinking overwrites, and reserves physical/staging space for the whole group.
**Path/collision observations are made at preparation only.** The Owner explicitly
accepted removing repeated remote path checks: an external SFTP/game/provider
change during the group can race these observations. This is neither an atomic
no-clobber filesystem operation nor continuous protection against externally
introduced in-root aliases. Current local authorization, managed identity proof,
exact entry binding, streaming byte limits and native Wings filesystem policy
remain enforced. Generic non-upload mutations retain their existing checks.

Each transfer takes shared lifecycle/claim locks, so disjoint group entries can
run together while ordinary mutations, lifecycle work and Owner recovery remain
excluded. SQL entry claims enforce the configured concurrency across requests/API
instances. Blueprint 1.2 issues distinct one-use URLs for the group in one Client
API request during preparation, overlapping path/resource checks. Each credential
is bound to one file in a private, disposable API-memory cache (maximum 32 groups);
URLs never enter the durable manifest, browser, audit or logs. The cache key
includes the managed identity and current owner's credential revision. Close,
eviction, expiry (30-second safety margin), API restart or a changed credential
binding discards this optimization, not durable admission. Remaining queued/active
entries can receive fresh unused tokens together; completed/uncertain effects are
never replayed. Shared issuance is independent of any individual file's abort.
An older extension returning 404 selects the stock per-file signing endpoint;
other errors remain errors. Concurrent files never share a Wings upload token.
The actual Wings POST waits for admission. Binary bytes stream with bounded
buffers; XHR100% is not completion. Only the successful provider response and
local settlement mark an entry complete. No per-file post-upload listing/hash
verification is added.

Batch admission and intermediate settlement lock the existing claim row, without
the global resource lock: reserved capacity does not change between files. Before
deleting the final claim, settlement rolls back its decision-only transaction and
revalidates once in a fresh transaction with global resource lock → claim row lock.
This preserves serialization with filesystem observations and outstanding-capacity
sums, without reversing lock order or replaying an external upload. Preparation,
cancel/close and Owner recovery retain their existing locking. Admission commits
before dispatch; settlement commits only after the provider outcome. Successful
settlement inserts both `server.upload.confirmed` and `server.files.uploaded` in
one statement inside that transaction, preserving attribution and avoiding a
separate post-settlement audit commit.

Only binary batch transfers defer the second access-authorization read to the
existing mandatory pre-POST transfer check. That check compares the full current
managed identity and upload binding against the initially verified server. Initial
access checks, all three stream checkpoints and periodic authorization during long
transfers remain active; preparation/cancel/close retain their immediate recheck.
The `/v1` middleware no longer pre-reads a session solely for localization:
authenticated handlers already obtain it through the identity service. Errors
before authentication resolve stored locale lazily; no session result is cached
across requests or reused instead of a fresh transfer check.

The existing host ingestion claim stores batch metadata; no migration is needed.
Conservative reservation is twice total declared bytes plus 65,536 bytes per
possible concurrent multipart request. It remains charged until all entries are
complete/cancelled. Browser groups are bounded to this budget. Successful files
are not replayed. `POST /files/upload-batches/:batchId/cancel` with `{entryId}`
cancels only an unstarted entry; `DELETE /files/upload-batches/:batchId` abandons
queued entries. An active/uncertain entry retains its reservation and consumes a
slot; other entries can use remaining slots. For cancellation before the terminal
multipart boundary, the adapter stops consuming browser bytes and closes the
chunked provider request without that boundary. Only Wings' exact, bounded native
multipart-parser rejection confirms cancellation before final file writes and
settles `server.upload.cancelled`. An arbitrary HTTP 400, timeout, lost response
or cancellation after the complete multipart remains insufficient evidence of
rollback; confirmed successful writes remain successful. Byte limits and stream
authorization still apply, without buffering whole files or modifying Wings.

`GET /files/upload-batches/:batchId` returns `{closed,files:[{id,state}]}` under
current server authorization, batch actor/session/binding checks and the existing
upload-slot gate. Only cancelled browser transfers poll it (150 ms, at most five
seconds, retrying `operation_busy`); their scheduler slots stay occupied until
settlement. Unresolved cancellation blocks another batch, while already admitted
siblings remain independent. Successful transfers add no status polling.
`closed:true` means the reservation ended, not proof that a late-cancelled file is
absent: the final entry could already have succeeded before the browser aborted.

Provider failure/cancellation after dispatch is not an atomic rollback.
Owner recovery retains its existing explicit
external-completion evidence requirements. Process loss is conservative, not an
automatic retry. The previous non-batch binary route remains available for older
clients and uses its original per-request checks.

The queue retries only definitive pre-effect `409 operation_busy`, with bounded
250/500/1000/2000 ms backoff. Other failures are shown per entry; queued siblings
within the admitted group remain independent. Browser navigation/identity changes
abort active transfers and close unstarted entries. A lost preparation response
retains the original ID for retry rather than inventing a second reservation.
Pending file bodies remain only in the browser tab.

Upload timing diagnostics require the effective API `logLevel=debug`
(`NH_LOG_LEVEL=debug` for an explicit environment override). At the default
`info` level, no upload stage/atomic times are collected and these diagnostic
payloads are not built or emitted. Durable audit records and request errors are
unchanged. The API reads its logger level at startup; applying a new level needs
the normal API process reload.

Privacy-safe `server.files_upload_prepared` debug traces count files/bytes and
preparation duration. `server.files_upload` reports access, entry admission, signed-URL lookup,
provider streaming/response and settlement separately. A warm group's signed-URL
phase measures local credential/cache lookup, without another Panel request.
Signed-URL/admission times
overlap and must not be summed. Trace fields contain no paths, content, keys or
URLs; these are backend timings, not browser byte-progress measurements. Legacy
uploads retain their earlier path/resource timing fields.

Prepared-file debug traces also include request-local `atomic` aggregates:
`{label:{count,totalMs,maxMs}}`, maximum 64 code-defined labels.
They separate principal/runtime lookup, pinned connection acquisition/release,
server lock, session and permission reads, identity proof, owner/key
lookup and decryption, cached handoff, claim lock, transaction entry, resource
lock, row `FOR UPDATE`, transition checks, serialization/hash, update/delete,
audit, transaction tail and unlock. `transfer.*` measures the repeated local
session/permission checks within the provider phase. No SQL, query arguments,
paths, secrets, errors or per-operation log lines are emitted; all aggregates join
the existing final `server.files_upload` event. Instrumentation adds no SQL or
changes to the authorization/locking/transfer sequence. With the scoped batch
optimization, `access.sessionSecond`, `access.permissionSecond`, ordinary
`admission.resourceLock`/`settlement.resourceLock` and `completion.audit` are absent.
The last entry has `settlementRelease.*` spans for its fresh global-lock transaction;
its preceding `settlement.*` spans include the decision-only rollback, not a commit.

These are monotonic elapsed spans, not database-engine CPU timings. Connection
acquisition includes driver setup; a lock/query span includes its round trip and
any wait. Transaction entry includes BEGIN; transaction tail includes COMMIT or
ROLLBACK and release. `transactionBody` includes its children and must not be
summed with them. `url.*` overlaps admission; `transfer.*` is already included in
`providerMs`. Server unlock/connection release occur after the callback and belong
to the outer duration's remainder, not `accessMs`. Snapshot/redaction/log output
occur after the outer duration is captured. Middleware before this route and
browser delivery/render time remain outside these timers.

Downloads use a native same-origin link, without creating a whole-file browser
JavaScript blob. The CodeMirror editor alone caps UTF-8 content at 1 MiB, including
its provider read. Binary transfers have no such editor cap. Legacy text routes
retain their original limits; the new revision-aware editor uses separate routes.
Console display retains at most 300 lines, each truncated to 8,192 characters;
the API independently bounds outstanding SSE output (256 KiB/64 events with a
five-second slow-consumer timeout). Reconnecting does not promise replay of missed
console output. Authorization remains live; stale data is not current telemetry.
Console command POST reuses a matching API-local authenticated Wings relay when
available. The bounded registry binds the exact session/actor/subject/support
context, full managed provider identity and effective provider URL/credentials.
Fresh write authorization, managed identity, lifecycle locking and audit still
precede dispatch. Closed or unmatched sessions select the existing REST path
before dispatch; an attempted WebSocket send is never replayed over REST. HTTP
204 acknowledges dispatch, not game execution. Multi-instance deployments can
fall back to REST when the POST reaches a different API process; no browser
provider token or cross-session relay reuse is introduced.


## Durable schedules and explicit automation consent

[Schedule routes](../apps/api/src/schedules.ts) use
[the existing resource lock and lifecycle jobs](../packages/server-management/src/schedules.ts).
Migrations 014 and 015 add schedule/occurrence and service-heartbeat state without
instance seeds. Redis remains delivery infrastructure; PostgreSQL owns execution
intent and occurrence history.

| Method/path under `/v1/servers/:id` | Contract |
| --- | --- |
| `GET /automation-consent` | `allowed`, `expectedIntent`, Gateway configured/enabled flags and nullable `grantBlockedReason`. |
| `PUT /automation-consent` | Strict `{allowed,expectedIntent,expectedAllowed}` with current regular manage authority. The expected fields must match the latest GET. Pausing changes only automatic-start permission, preserving running readiness and idle sleep. Does not implicitly start a server or deploy/enable a Gateway. |
| `GET /schedules` | Current schedules with revision, timing, zone, action, next run and timestamps. |
| `POST /schedules` | `{name,action,timing,timeZone,enabled}`; 201 on durable creation. |
| `PUT /schedules/:scheduleId` | Same fields plus current `revision`; stale updates conflict. |
| `DELETE /schedules/:scheduleId` | `{revision}`; soft deletion retains occurrence history, returns 204. |
| `POST /schedules/preview` | `{timing,timeZone}` returns upcoming `nextRuns`. |
| `POST /schedules/:scheduleId/run` | `{revision,idempotencyKey}` dispatches a separate authorized occurrence without changing recurrence. |
| `GET /schedules/:scheduleId/outcomes` | Bounded cursor-paginated occurrence history and associated job/effect outcome. |

Actions are `start`, `stop`, `restart`, `backup`. Timing supports
`{kind:'once',at: ISO}`, `{kind:'interval',firstAt: ISO,everySeconds}` (300 through
31,536,000 seconds), `{kind:'daily',localTime:'HH:mm'}` and
`{kind:'weekly',localTime:'HH:mm',weekdays:[1,3,5]}` (ISO Monday=1).
`timeZone` must be an IANA zone recognized by `Intl`. Daily/weekly timing resolves
repeated local times earlier and timezone gaps forward; interval timing remains
elapsed time. See [Automation](AUTOMATION.md) for precedence, recovery and UI.
Missed interval runs collapse to the latest due occurrence; more than five minutes
late is recorded as skipped. No capacity waiting queue or retrospective burst.

Occurrence claim, admission, operation and outbox are one PostgreSQL transaction.
Duplicate workers cannot dispatch the same occurrence twice. Before each **new**
provider effect, the lifecycle authorizer rechecks current authorizer identity/verification,
current manage permission, schedule revision/enabled/deleted state, occurrence/job
identity, regular actor=subject authority and manual-stop/Gateway generation.
Unknown prepared effects continue conservative reconciliation, not blind replay.

Manual stop/maintenance suppress automatic starts. Granting automatic-start
consent is explicit, compares the current intent and is blocked until unfinished
operations, uploads, installation and uncertain reservations settle. Revocation
is immediate and rotates existing Gateway generation/readiness without cancelling
history or releasing resources prematurely. Scheduled stop preserves existing
automatic-start consent, independently of autowake preferences; a conflicting
stop does not revoke it. A schedule cannot clear manual-stop or maintenance
suppression. Migration040 separates original creator and latest authorizer and
adds manual occurrences/calendar timing without rewriting prior history.

Migration039 adds independent autowake policy and revisioned per-state Gateway
message overrides. GET/PUT `/v1/platform/servers/:id/auto-wake-policy` and
`/v1/owner/integrations/:gameId/auto-wake-policy` expose the Owner hierarchy.
GET/PUT `/v1/servers/:id/gateway-messages` reads defaults/capabilities and writes
`{revision,overrides}` with regular manage authority, CSRF and audit. GET returns
`{available,editable,revision,overrides,definition?}`: `definition` is the trusted
SDK `GatewayMessageDefinition` (version, channels, states, variables), replacing
the previous fixed state/default/variable response. State defaults and preview
variables have EN/IT maps. Revisions include the resolved descriptor, so stale
edits after a default change also conflict. Only declared state/channel pairs and
template variables are accepted; transport bounds remain independent of game text
limits. Existing stored `{stateId:{channelId:text}}` overrides need no migration.
Optional
`presentation` and `wakeEnabled` fields on leased SDK routes carry these settings
without changing readiness or forwarding. See [Automation](AUTOMATION.md).

## Retry, recovery and reconciliation

`retry.allowed` is true only for authorized failed start/stop/restart/backup jobs
whose durable evidence proves no provider effect was started (`effect_state=none`,
no effect timestamp, not Owner-resolved). Retrying creates a new operation through
existing admission/idempotency. It never resubmits unknown external side effects.

`ownerRecovery` is null except for an eligible regular Owner inspecting the active,
queued/running, prepared/uncertain non-power operation. Otherwise it contains
`{available,availableAt}` after the existing minimum 120-second effect age. This is
an eligibility/timing hint, not proof that resolving is safe. The existing
`POST /v1/owner/servers/:id/resolve` still requires `{jobId,confirm:true,reason}`,
current Owner authority under the lock, corroborated managed provider identity
and installed/offline state. It records `owner_resolved_failed`, preserves the
unknown outcome and audit, and never claims rollback, success or permission to
replay. Power/initial-start uncertainty does not use this manual path.

`POST /v1/owner/reconcile` returns `observed`, `deferred` (server IDs),
`unavailable` (server IDs) and external recovery counts. Only applied observations
count as observed; a busy server or superseded observation is deferred without
refreshing timestamps. Provider collection holds no lifecycle server lock; a
short guarded transaction applies accepted results atomically. Partial provider
failure must not be rendered as “all checked.” Upload recovery remains a separate
existing Owner operation with its own remote-write settlement proof; it is not a
shortcut around active upload claims.

## Owner health, configuration and trusted integrations

`GET /v1/owner/health` is regular-Owner-only, even for a cached result. Read-only
provider probes coalesce for five seconds and retain one in-flight probe when slow.
The response is `no-store` and includes `checkedAt`, API/database, Redis, worker,
Gateway, provider read scopes, physical-host observations, operation counts and
SFTP/DNS configuration indicators. Status values distinguish `healthy`, `degraded`,
`unavailable`, `stale`, `unknown`, `unconfigured`, `disabled`.

Worker health is fresh polling progress scoped to the job prefix (30-second
freshness); it is not inferred merely from Redis availability. Authenticated
Gateway contact proves control-plane contact only. `listenerReadiness` remains
unknown here; route leases, topology/reachability and actual game readiness use M3
proofs. Host health checks observer identity, timestamp and snapshot validity.
Provider write scopes, SFTP connectivity and DNS writes are explicitly unverified
by this read-only health request. No restart/deployment action is performed.

Owner-only `GET /v1/owner/servers/:id/allocations` returns stored managed allocation
claims, including provider and effective backend addresses. `GET /v1/owner/provider-users`
returns safe provider identifiers for mapping, not the NickHosting account directory.

Regular platform operators retain `audit:read` and `settings:read`. Their
Administration navigation exposes only `/owner/audit` and `/owner/settings`;
settings show values, sources and secret configuration presence without mutation
controls. Owner health/users/infrastructure and writes remain forbidden. Changes
to the role take effect through the existing current-session authorization.

Existing `/v1/owner/settings` reads expose resolved values, source provenance,
environment locks and secret configuration status. New `GET /v1/owner/settings/schema`
uses the same typed configuration schema as backend validation.
`DELETE /v1/owner/settings/:key` removes a permitted database override; it does not edit the
environment. PATCH retains validation/audit. `PUT /v1/owner/secrets/:name` is
write-only and respects environment precedence; raw secrets never enter read DTOs.

`GET /v1/owner/game-modules` returns compiled trusted `{id,manifest}` modules.
Existing `PUT /v1/owner/games` persists manifests/rollout/tester policy; public
`GET /v1/games` dispatches filtering through the trusted backend registry.
Database JSON cannot import executable code. Dispatch requires managed identity
and matching runtime/profile integrity. Minecraft hooks preserve image, launch,
protected-file and process-epoch checks. Compiled Vanilla capability declarations
supply installation authority without a per-mapping signed report/key. Exact runtime
observations and diagnostic reports remain distinguishable; other profiles retain
existing evidence policy. Existing registration/runtime aliases remain compatible.

## Trusted browser SDK and Minecraft management

[`@nickhosting/game-sdk/ui`](../packages/game-sdk/src/ui.ts) is browser-safe;
server SDK imports/secrets are not bundled. Static first-party modules provide
validated descriptors, EN/IT catalogs, bundled artwork and named executable
handlers. Registry validation rejects missing/duplicate handlers, invalid field
bounds/dependencies and missing translation keys. API/Owner JSON cannot register
code or arbitrary asset URLs.

Optional `fileIcons` rules pair bounded lowercase filename extensions with
registered bundled asset IDs. They are decorative metadata only; the shared file
manager falls back to its generic type icons for unknown games/extensions. No rule
registers a binary editor, grants a permission or changes the API's text policy.

The shared shell owns identity, resources, projects, lifecycle, Activity, services,
network and automation. Generic wizard/section renderers consume typed field
constraints, conditional visibility, asynchronous choices, commands and capability
requirements. Every availability decision combines actual permissions, declared
capabilities, locally validated runtime, rollout/provider configuration and current state; declarations alone do
not authorize an action. Isolated multiport/conditional-form fixtures prove the
extension mechanism without offering Satisfactory or unsupported runtimes.

`GET /v1/servers/:id/minecraft` retains its M4 fields and adds
`effectiveProperties`, parsed from the actual provider `server.properties` with a
1 MiB read bound under current managed-server access. Only safe editable keys are
returned. `supportedProperties` is intersected with those keys; declared Vanilla
uses properties actually present in the installed server file, while existing
report-backed runtime paths retain their diagnostic property evidence. The form initializes from effective file values, not the
old provisioning configuration; writes still use existing durable verification.
Unavailable/malformed provider files produce real errors, not invented defaults.

Vanilla remains the only M4 real-server-verified runtime. Minecraft UI exposes
eligible choices and safe world/player/content operations; it does not present
ordinary mod/plugin installation on Vanilla. Owner evidence administration is
separate from normal creation. The browser fixture's signed synthetic reports,
server artifacts and provider adapters exercise integration only and cannot
certify another runtime, protocol or egg. Egg installation remains Pterodactyl/
Wings responsibility.

## 2026-10-10 — Creation discovery and resource defaults

- Owner-only `POST /v1/owner/minecraft/catalog/sync` accepts `{mappingId, all?, cursor?, limit?, enableSupported?}`
  (limit at most 20), returns per-version registration/unavailability and next cursor.
  It writes only local immutable combination records; no remote installation,
  verification claim occurs. `enableSupported: true` explicitly requests Owner
  availability for declared candidates; rollout policy still applies. No local
  signed report is required for Vanilla installation/direct support. Recognized
  Vanilla bindings are optional input to the existing registration API.
- Minecraft public choices add `releaseType` for stable versus snapshot/historical
  presentation. Compiled Vanilla installation capability is separate from diagnostic
  evidence; Owner rollout/availability and local provider validation still apply.
- Quota responses add `creationStorage: {mode: 'shared'|'limited', defaultDiskMiB}`.
  Create requests may omit `limits.disk` with `GLOBAL_POOL` or a per-user unlimited
  exception (`storageBudgetMiB=0`). As of the storage
  reconciliation change below, shared storage always resolves to provider disk `0`
  (unlimited); finite personal storage requires an explicit positive allowance. Retrying
  the same request after a setting change returns the original operation.
  Configure/resize requests still require explicit limits.
- `defaultServerStorageMiB` defaults to the former wizard value, 4096 MiB; normal
  defaults < Owner DB < environment precedence applies. It is the initial proposal
  for personal storage and the physical working-space reservation for new shared
  servers, not a shared server's provider cap.

## 2026-10-13 — Unlimited shared storage and guided limit reconciliation

| Owner route | Contract |
| --- | --- |
| `GET /v1/owner/storage-policy` | Effective policy, default personal budget, environment locks and latest durable transition. |
| `POST /v1/owner/storage-policy/preview` | `{policy, defaultUserStorageMiB}`; persists a draft with users, measured occupied bytes, current/proposed server caps, minimum safe caps and backup reservations. No provider writes. |
| `GET /v1/owner/storage-policy/:id` | Durable per-server progress and errors, including incomplete changes. |
| `POST /v1/owner/storage-policy/:id/apply` | `{users:[{userId,quotaMiB,servers:[{serverId,diskMiB}]}]}`; validates the complete inventory and queues the explicitly confirmed plan. Returns 202. |
| `POST /v1/owner/storage-policy/:id/retry` | Requeues a blocked plan with the same allocations. A corrected allocation uses `apply` on the existing blocked plan. |
| `POST /v1/owner/storage-policy/:id/refresh` | Remeasures a blocked plan without effects; retains the transition ID, targets and uncertain-effect ledger so cleanup can be followed by an explicit corrected application. |

All routes require a verified regular Owner; writes retain origin/CSRF checks and
environment precedence. Generic settings cannot change policy or default user
storage while servers exist: the guided flow is mandatory. Migration `026` adds
storage-only permanent user exceptions and durable transition records without
changing any existing server limits or initiating provider effects.
Migration `027` adds nullable backup occupancy to metrics and permits an explicit
follow-default budget marker. Missing legacy markers still resolve existing user
overrides; default-following users track later default changes, while positive
exceptions remain independent of compute override expiry.

Migration `028` permits the persistent personal budget `0` (unlimited), while null
continues to follow the positive platform default. Public transition users include
`quotaSource: 'default'|'override'`, including reconstructed legacy plans. Under
`PER_USER_BUDGET`, applying a zero user quota requires all that user's server disks
to be zero. Provider/SFTP readback, unknown-measurement blocking and physical
pool/headroom accounting still apply; a zero quota never means zero occupied space.
Finite/unlimited changes use the same durable reconciliation in both directions.
Quota responses expose null effective storage limit/remaining values and
`creationStorage: {mode:'shared', defaultDiskMiB:0}` for the exempt user, retaining
`storageBudgetMiB=0` and `storageBudgetOverrideMiB=0` distinctly from inheritance.

`PUT /v1/owner/user-limits` now accepts omitted `storageMiB` for compute-only edits.
This preserves an existing independent storage policy, including unlimited. An
active temporary legacy storage exception without an independent marker requires
explicit storage input; omission cannot silently extend its expiry. Direct quota
edits cannot convert an unlimited user to finite caps without reconciliation.
The legacy positive `resource_user_limits.storage_mib` column stays unchanged.

The UI automatically requests previews after edits, serializing and coalescing
persistent preview requests. Cached totals and default-following quotas update
immediately; explicit drafts survive fresh measurements and failures. Application
requires the current verified revision. Blocked refresh retains its original ID
and effect ledger and is triggered automatically on return from cleanup.

New `GLOBAL_POOL` servers use `limits.disk=0`, including when an older client sends
a positive disk value. Existing finite servers are converted only by an explicit
guided application. Finite/unlimited crossings cannot use ordinary server resize.
`GET /v1/platform/quotas` returns `creationStorage.defaultDiskMiB=0` for shared
storage, `storageBudgetOverrideMiB`, and `storageUsage.bytes` (30-second display freshness, null when any current
measurement is missing, invalid or stale). Home cards use the same resources
endpoint and `resources.disk_bytes` as Console, with a 30-second freshness window;
they never present an allowance as occupied space or unavailable data as zero.

For unbounded storage, quotas also return `sharedStorageAvailableBytes`: actual
filesystem free space from the worker's cached host observations. Enabled managed
hosts with enabled nodes contribute once each, honoring environment host overrides.
Missing, invalid or stale observations make the whole total null; no filesystem
scan or provider request occurs on the quota read. Home formats this quantity in
the disk card's Available row, including for accounts without servers. The total
is platform-wide physical free space, not a personal allowance or a guarantee that
one server can use capacity on another host. Limited users retain their remaining
quota calculation. Host paths, identities and fingerprints are not exposed.

Preview reads the managed provider identity, live resources and backup inventory.
Personal caps cover observed usage plus the greater of 128 MiB or 10% growth
headroom, as well as existing backup capacity; a user's reservations include each
server cap multiplied by one plus its backup slots. Missing measurements prevent
application. The Owner can clean up data and refresh the draft, or edit the user
budget and server allocations. No file deletion, automatic shutdown or cap below
the verified minimum is part of this flow.

The worker rechecks identity, usage, host pool/headroom and unfinished operations
before applying absolute provider caps and scoped SFTP quotas. Writes that could
invalidate the plan are fenced during application or an unresolved partial change.
Provider and SFTP readback must confirm before local caps are saved; the global
policy changes only after all servers confirm. Uncertain responses remain durable
and require explicit retry/correction, which checks what already took effect.
SFTP finite reductions also use corroborated Wings occupancy because unlimited
SFTP quota counters may be absent. Existing SFTP credentials retain identity,
password and expiry; the separate issue #18 release gate remains applicable.

Disk `0` means no per-server disk ceiling throughout uploads, copy/extraction,
Minecraft content and SFTP. Transfer descriptors express this as
`upload.serverDiskBytes=null`; declared-byte, temporary staging, host free-space,
maximum-file and queue limits still apply. Physical admission charges unlimited
servers against fresh occupied-space observations, never against a zero allowance.
Retained backups are counted at their observed size even after live files shrink.
Creation and resize refresh unlimited-server measurements before the physical-host
sample and admission transaction; missing/incomplete backup inventories prevent
new commitments. Blocked transitions permit only authorized file/backup deletion,
followed by the same plan's refresh and explicit resume. Other writes remain fenced.

## 2026-10-10 — Declared capabilities and optional Gateway

Minecraft choice DTOs include declared per-combination capabilities and their
support authority; Owner diagnostics retain actual evidence separately. Vanilla
installation/direct connection is not contingent on `minecraftEvidenceKey` or a
new report for each Owner mapping. A declaration does not promote undeclared
profiles or manufacture a tested client/server result.

Managed server descriptions expose frozen `connectionMode`. Direct descriptions
set protocol readiness/idle/wake capabilities unavailable; process `running` is
reported separately from unknown/unavailable game readiness. `/sleep-policy`
returns nulls for direct servers. Network UI identifies configured direct addresses
and their unverified external reachability. Automatic scheduled starts remain a
separate explicit consent; stale Gateway policies cannot grant direct wake behavior.

Owner allocation pools may specify `directEndpoint: {hostname, port}`. An explicitly
`delivery: direct` allocation may use a validated unicast provider binding rather
than a private Gateway backend. Provisioning freezes the endpoint and delivery mode;
no hostname is guessed from a private backend or provider alias. All claimed ports,
provider identities and allocation ownership are still checked. DNS planning for
direct servers uses the frozen hostname/port; this task performs no real DNS writes.

The Owner node editor supports explicit allocation address/port-range selection,
search, selected-only filtering and 25-row pages in a bounded scroll region.
Assigned foreign allocations are not included by range selection. Selected pins
and edited direct endpoints remain in draft state across filters/pages; a single
endpoint editor replaces one form per selected allocation. Saving validates that
every selected identity is still present rather than silently dropping hidden or
missing pins. Changing the provider node resets the selection. Inclusion/removal
only changes the draft until the Owner saves; it never creates provider allocations.
The complete-inventory and bounded request contracts are documented in
[M2 API](M2-API.md).

Gateway service metadata has an explicit authority union: compiled integration
`supportSource: integration`, `declarationId`, `declarationVersion`, or the legacy
signed-report fields. The integration currently declares Vanilla 26.1/protocol 775
Gateway behavior. Compiled declaration validation, bounded route leases and all M3
safety fences remain mandatory. Direct servers are rejected by route/policy/wake
handlers and queued Gateway-effect authorization.

## 2026-10-10 — Inherited idle sleep timeouts

Owner administration separates the global idle timeout, a game's override,
per-runtime overrides and a per-server override. The effective Owner order is
server → runtime → game → global (disabled by default). UI values are minutes,
`-1` disables only automatic idle sleep, and inheritance is an explicit choice.
Ordinary users cannot edit Owner defaults. Temporary support sessions cannot leave
automation grants.

User control follows the same hierarchy: **hidden** by default, **editable**, or
**shorten-only**. Hidden settings do not render for ordinary users and cannot be
edited through the API. Shorten-only users can choose an earlier idle timeout but
cannot increase the effective Owner timeout or use `-1` to disable a finite limit.
An Owner-disabled timeout permits any finite shorter timeout. A stored user choice
cannot exceed a subsequently tightened Owner limit; hidden mode ignores stored
user overrides. The Owner baseline and user preference use separate authority
fields. Owner administration remains editable regardless of ordinary-user mode.
Runtime declarations come from trusted integration manifests; no Minecraft-specific
condition is introduced in the shared editor.

See [M3 contracts](M3-API.md) for seconds-based API values, environment locking,
legacy-disabled preservation, effective policy metadata and queued-stop checks.
Changing an idle timeout does not create a Gateway route, grant wake consent,
resume manual stops, start a server or certify an unsupported game/version.

## 2026-10-10 — Runtime-first wizard and complete discovery

Trusted UI creation pages support `kind: "choice-list"`,
`position: "before-name" | "configuration"` and validated `resetFields`.
Minecraft supplies its runtime page before Name; choices derive from authorized
`/v1/minecraft/choices`, not a hardcoded list of unavailable runtimes. Version
options depend on the selected runtime and display release names only. Changing
runtime clears dependent version/player/whitelist/EULA state. Shared Core remains
game-agnostic. Snapshot-only results have an explicit stable-filter empty state.

Owner discovery now consumes the existing bounded catalog endpoint sequentially
until `nextCursor: null`, with actual checked counts, cancellation and retry from
the last acknowledged cursor. It runs only after an Owner action. Cancellation
may leave the submitted page saved; it does not claim rollback. Existing disabled
versions require the explicit “Also enable previously disabled supported versions”
option. No endpoint, authorization or availability default was relaxed.

## 2026-10-10 — Bounded Owner catalogs and measured scans

The Owner Minecraft compatibility list accepts `pageSize` (1–100) and `after`
(UUID) for keyset pagination, returning `{items, nextCursor}`. Owner authorization
is unchanged. Calls without query parameters retain the legacy array response
and its 1,000-row limit; the WebPanel now consumes the paginated contract, with an
explicit failure rather than silent truncation beyond its 20,000-entry guard.

Rows include presentation-only `releaseTime` and `releaseTimeStatus`
(`available`, `unknown`, `unavailable`). Dates come from the official Mojang
manifest through the existing metadata client, with a three-second request timeout
and a five-minute coalesced cache. Metadata outages leave the catalog readable.
Unknown dates stay last; database insertion dates are never substituted. Frozen
runtime identities, compatibility declarations and evidence are unchanged.

The reusable catalog browser provides search, integration-supplied filters,
date/name ordering, 25-row pages and a keyboard-scrollable bounded viewport.
Minecraft supplies runtime, release-type and availability filters. The default
order is actual newest release first, including snapshots in the same chronology.

The reusable scan view shows acknowledged cursor progress and a bounded log.
Before the first response the progress indicator is indeterminate. Remaining time
is an approximate measured estimate available after two completed batch requests
in the current run; resume excludes earlier downtime. Paused, failed and complete
runs do not display a remaining-time estimate. Existing explicit enabling,
cancellation and retry semantics are unchanged.

## 2026-10-10 — Aggregated catalogs, local manifest and shared creation cache

This checkpoint supersedes the earlier all-pages WebPanel loading and request-time
Mojang date lookup. Legacy no-query array and `pageSize`/`after` cursor responses
remain supported, now with bulk related-data reads.

The original summary view uses
`GET /v1/owner/minecraft/compatibility?view=summary&page=1&pageSize=25`.
The contextual workspace introduced on 2026-10-16 adds grouped release pagination
while retaining this summary contract.
Optional `search`, `runtime`, `releaseType`, `availability=enabled|disabled` and
`order=newest|oldest|name-asc|name-desc` are applied before pagination. Response:
`{items,total,page,pageSize,runtimes,metadataStatus}`. Runtime facets span the full
catalog. Search is a literal case-insensitive substring, not SQL wildcard syntax;
unknown dates sort last with deterministic ties. Summary rows omit full runtime
bindings, digests and evidence. `GET /v1/owner/minecraft/compatibility/:id` loads the
protected full detail when selected. Both endpoints remain Owner-only.

The ordinary catalog loads rollout once, combinations/dates together, and mappings
in bulk: three queries for integration-declared choices. Undeclared runtimes add
one bulk evidence query when necessary. The same eligibility assertion used by
single-choice operations still checks enabled mappings, frozen mapping identity,
rollout/tester access and required signed evidence. Mutating operations continue
to reauthorize current state. Public choices add `releaseTime: string | null`;
release families are interleaved by real chronology, unknown dates last.

Migration 019 stores validated official manifest metadata and durable refresh
state. List endpoints read local data only. The worker independently polls due
state every 30 seconds; successful external refreshes are spaced 15 minutes apart.
A 60-second cross-worker lease fences late writers, a 10-second HTTP timeout bounds
work, and failures retry after 60 seconds while preserving last-good data. Identical
manifest hashes do not rewrite release rows; changed manifests upsert only new or
modified rows. Upstream omissions retain known chronology. No automatic mapping,
combination registration, enablement or evidence promotion occurs. Explicit Owner
discovery also reuses the local manifest, while still fetching required per-version
metadata and provider egg information for the requested registration operation.

Trusted Game SDK UI modules can declare optional `creationCatalog` with `handlers`,
`load`, synchronous `options`, and optional `applies` projections. Registry validation
checks handler references; executable modules remain first-party imports. The
application supplies an optional same-origin `catalogRequest` backed by the existing
identity-cleared QueryClient. Creation cache keys share the `creation` namespace
and a 60-second freshness window. Servers asynchronously prefetches games; selecting
an integration prefetches its choices. Runtime/version steps reuse those choices,
including Back and Show all, without separate HTTP requests during freshness.

Successful Owner writes invalidate creation caches in that browser. Existing
identity/support transitions cancel and clear/reset the same keys. Other browsers
refresh according to query freshness; cached options never authorize creation.
First access without cached data may still show loading. Owner paging keeps prior
rows during a refresh with `aria-busy`; filters/order remain controlled by the
request after errors/retry rather than resetting to misleading defaults.

### Initial sleep/wake configuration

The trusted first-party module's optional `gatewayPolicyBinding` resolves protocol
and game version from the installed server. Minecraft validates its installed
combination through the same capability/identity contract used by route registration;
the shared UI has no game-specific branching. Direct, uninstalled, unsupported or
actively changing servers receive no proposal. Suggested defaults have wake off,
idle sleep disabled, 600-second readiness timeout, 30-second readiness freshness,
seven-day estimate freshness and 10-second wake retry; these are editable policy
defaults, not readiness evidence. Manual-stop/maintenance intent is preserved.

The explicit initial Configure action sends the proposal to the existing
`PUT /v1/servers/:id/gateway` with `If-None-Match: *`. Under the resource lock,
initialization rejects an existing policy, an active operation, changed maintenance
intent, automatic-mode/wake/idle grants, or invalid installed protocol binding.
A stale initialization cannot overwrite another manager's policy or reset its
observations. Ordinary policy editing retains its existing contract. Regular-session
`server:manage` authorization, CSRF and resource safety remain mandatory. Merely
configuring a disabled policy does not register a listener or start a server.

### Clean Start dispatch (2026-10-11)

The operations API still returns acceptance, not successful process startup. A
new Start uses the stored managed target, local authorization, one remote limits
snapshot and atomic physical admission. Wings decides whether its current state
permits power. The dispatch path no longer pre-reads Client resources or repeats
remote identity/image/launch validation. Provider refusals and uncertain results
remain durable operation outcomes. Existing reservation, recovery and readiness
rules remain authoritative; UI acceptance must not manufacture completion. See
ADR 0011's dated amendment for the explicit boundary and external-change caveat.


### File manager contracts (2026-10-12)

All routes below are under `/v1/servers/:id/files`. They reuse managed-server
identity, project permissions, active-operation locks, protected-runtime-path
checks, the existing adapter and live transfer authorization. No provider URL or
credential is returned to the browser.

The browser retains the current folder across a page reload, scoped to the server
and authenticated actor/subject. Leaving Files clears that folder preference;
returning through a tab or browser Back starts at root. Cancelling navigation
because of unsaved edits preserves the current folder and draft. Explicit
background-save recovery still opens the saved file's folder.
One tab-local snapshot of the most recent folder listing also survives reload.
It contains schema-approved metadata only (maximum 5000 entries / 1 MiB), scoped
to the actor/subject/support session, server and folder. It is observer-only
placeholder data while a fresh request runs, not fresh query data or authority
for a mutation. Normal keyed row reconciliation preserves unchanged DOM rows.
Identity changes and listing authorization/not-found failures clear the snapshot;
unavailable storage or oversized listings fall back to the normal skeleton.
In-memory listing keys carry the same identity boundary; mutation invalidation
targets the folder prefix so all scoped variants become stale.

| Route | Request/result |
| --- | --- |
| `GET /editor?path=...` | Bounded strict UTF-8 text and SHA-256 `revision`; known binary extensions rejected before reading, actual bytes validated afterward. Reuses the directory identity proof with fresh local authorization; a private one-use signed Wings URL (prepared from the listing when available), no ancestor listings. Wings contains the path and rejects final symlinks. |
| `PUT /editor` | `{path, content, expectedRevision}`. Existing file requires its revision; new file requires `null` and absence. Changed content returns409 without intentionally overwriting it. Read-back verifies the result. |
| `POST /archive` (preferred); `GET /archive?root=...&files=...` (compatible) | POST uses URL-encoded `root` and `files` (JSON array of selected basenames), avoiding long URLs. Actual streamed ZIP, including folders/empty directories; 10,000 enumerated entries including selected roots, 64 directory levels. File bodies open lazily, one at a time; cancellation closes upstream. No whole-download browser buffer or fixed aggregate byte cap. |
| `GET /capabilities` | `{copy,extract,extractFormats,zipDownload,reason}` gated by permissions and configured upload admission. Supported extraction formats: ZIP,TAR,TAR.GZ,TGZ. |
| `POST /copy` | `{root,files,destination,overwrite?}`; copies selections recursively into an existing directory, preserving originals. Limits apply to actual work: 20,000 total entries (including roots), 16 GiB copied bytes, depth 64. Optional `overwrite: string[]` authorizes exact server-root-relative regular-file destinations; omission rejects collisions. Links, directory replacement/merging, ambiguous casing, overlapping paths and protected targets remain rejected. |
| `POST /extract` | `{root,file,destination,confirm:true}`; destination is one new child directory. Validate/stage the entire archive before remote writes, then use existing upload admission and adapter streams. |

ZIP attachments use `nhpanel-<server-name>-YYYY-MM-DD_HH_mm_ss.zip`, with the
request timestamp in UTC. The managed server name becomes lowercase ASCII:
diacritics are removed, spaces/symbols become single hyphens, and the stem is
trimmed/bounded to 100 characters (fallback `server`). Naming reuses the authorized
server row and adds no provider request. Archive contents/paths are unchanged.

The WebPanel submits ZIP manifests as native same-origin form POSTs so large
selections do not overflow browser/proxy URL limits or buffer an entire ZIP in
JavaScript. HttpOnly session/support cookies and the existing Origin check apply.
The document referrer policy is `same-origin`: native POST supplies its Origin,
while cross-origin referrers remain suppressed. The form is removed immediately;
attachment responses use the browser download manager, and error responses open
in a separate tab without replacing the workspace. Legacy GET remains supported.
Only POST `/files`, `/files/copy` and `/files/archive` have a 4 MiB selection-body
limit; unrelated JSON routes keep their previous limit. This is a manifest bound,
not an upload/download byte limit or a cap of 100 selected items.

`POST /v1/servers/:id/files` with `action:"rename"` also handles moves. Its optional
`overwrite: string[]` identifies exact root-relative destination paths from the
same `files:[{from,to}]` request. Omission retains no-overwrite preflight. Consent
permits only regular-file to regular-file replacement with an exact matching name;
directories, symlinks, case ambiguity, duplicate/unrelated approvals and overlapping
batch paths remain rejected. The entire selection is checked before any adapter
mutation, with existing protected-path guards and audited approvals. Delete and
rename requests dispatch sequential provider batches of up to 1,000 entries,
reauthorizing before each batch. Unknown/partial dispatch failure stops the sequence
with `operation_uncertain`; confirmed prior-entry counts are only a lower bound,
not proof that the failed batch had no effects. No batch is automatically replayed.
Pre-dispatch authorization failures retain their normal error when nothing ran.
Planning, protected-path validation and collision checks share one fresh,
request-local directory snapshot. Blueprint batches read each directory once;
only a missing optional extension permits the bounded native-listing fallback.
The existing 60-second identity proof is reused with fresh local permissions and
exclusive lifecycle locking; expired or changed bindings cannot authorize access.
There is no delete-before-move. Destination names appearing after browser preflight
are checked again by the API. Provider filesystem changes can still race the final
preflight/rename interval: the current Client API contract has no atomic no-clobber
flag and multi-file renames are not transactional. No rollback or automatic retry
is claimed after an ambiguous/partial provider failure.

Copy uses the same exact-path consent semantics, with approvals scoped to the
selected top-level files and validated before any writes. Source/destination
metadata and runtime guards use that same snapshot, without repeated listings
per file or after download negotiation. Wings opens the source; a returned content
length inconsistent with the plan rejects the copy, and streaming retains its
bounds. Existing files are never deleted first. Replacements reserve full upload
capacity without crediting the destination's size. Recent authenticated Wings
console disk samples may replace the resources API lookup; missing/stale samples
fall back to REST. Authorization, protected paths, upload admission and durable
claims remain enforced; approved paths are audited. Concurrent external Wings
writes after preflight can still race the upload because the provider exposes no
atomic compare-and-swap. Native Wings copy cannot target another directory or
implement explicit overwrite consent; the backend-streamed relay remains.
See [file access and copy contracts](M2-API.md) for cache bounds
and observation invalidation.

The WebPanel Move/Copy tree and drag/drop share a client-side decision flow over
their respective APIs. Per-file Skip removes that item and its overwrite path;
Overwrite all approves only current eligible collisions, and Skip all skips current unresolved
collisions. All decisions precede one batch; an all-skipped operation sends no
POST. Metadata is refreshed before submission, so new collisions need consent.
Session/support identity changes invalidate pending choices. Ambiguous failures
require inspection rather than automatic replay. Copy checks capability again
before submission and refreshes transfer/capability queries after the response;
its own active upload claim cannot discard a successful result.

The editor serializes NickHosting writes and rechecks authorization before writing.
Wings does not expose atomic compare-and-swap against external Panel/game writes:
a write in the comparison/write interval remains possible. A post-write mismatch
is a conflict, not a claim of rollback. Browser drafts remain available on failure.
JSON,YAML,TOML validation is local; scripts are highlighted, never executed.

PUT preflight shares directory observations between the trusted game-specific
protected-path guard and generic path inspection. The promise map is created
inside the authorized request, bound to its provider identifier, and discarded
afterward; there is no persistent metadata cache or reuse for post-write checks.
Both guards retain their own validations. For a two-component Minecraft path,
this removes two duplicate directory GETs (four become two). Identity and content
revision/read-back checks remain unchanged; this is a request-count reduction,
not a measured live-provider latency guarantee. The browser may continue editing
or navigate while PUT completes, retaining submitted and newer drafts separately.

The browser uses listing metadata for early exclusion. API reads reject known
binary extensions without fetching metadata; writes retain metadata/path guards.
Both reject known binary extensions, including JARs, archives, images and Minecraft
world data. Unknown extensions or `application/octet-stream` alone do not prove a file
binary: contents still undergo the 1 MiB bound, strict UTF-8 decoding, binary control
character and signature checks. PUT validates submitted and existing bytes, so
renaming a binary to `.txt` does not make it editable. Valid text keeps its Unicode,
line endings and BOM. No binary-specific editors are supported today. Streaming
downloads/uploads remain independent of this text-editor limit and policy.

Editor GET delegates containment to Wings' descriptor-based file open, rather
than preliminary directory listings that can race filesystem changes. Pinned
[Panel 1.11.11 contents](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Http/Controllers/Api/Client/Servers/FileController.php)
also reads directly through Wings. [Wings 1.11.13 Unix filesystem](https://github.com/pterodactyl/wings/blob/v1.11.13/internal/ufs/fs_unix.go)
uses `O_NOFOLLOW` for the final component, `RESOLVE_BENEATH` with `openat2`, and
parent-descriptor containment on its fallback. Intermediate links contained in
the server root may be followed; the browser still excludes listed symlinks and
PUT still rejects symlink ancestry. This is pinned source evidence, not a live
adversarial symlink test. Do not infer read-denylist or comprehensive special-file
protection from it. Oversize responses abort their bounded read and return 413,
including when no Content-Length is supplied. A file removed after browsing
returns 404. No browser metadata is accepted as authorization or content proof.

Copy/extraction failures after effects may leave partial files. They record
`server.files.incomplete` and return `operation_uncertain`; inspect the destination
before retrying. No automatic deletion, rollback or overwrite is claimed.
Extraction rejects traversal, links, duplicate/case-conflicting paths, invalid
sizes/checksums and expansion bombs. Budgets:8GiB source archive,16GiB expanded,
20,000 entries,64 levels and500:1 expansion; TAR accounting includes raw padding
and metadata. Recursive copies also cap planned content at16GiB/20,000 entries.
RAR/7z and encrypted archives are not advertised as supported.

Temporary staging uses typed `fileOperationsRoot` (`./mountdata/file-operations`),
`fileOperationsFreeBytes` (512MiB) and `fileOperationsFreePercent` (0), following
normal defaults/Owner/environment precedence. Environment names are
`NH_FILE_OPERATIONS_ROOT`, `NH_FILE_OPERATIONS_FREE_BYTES` and
`NH_FILE_OPERATIONS_FREE_PERCENT`. Staging is cleaned in `finally`, including
cancel/failure. A process crash can leave a staging directory; never indiscriminately
prune persistent storage. Headroom is checked per staged file, not atomically
reserved across simultaneous extraction requests; existing global upload slots
bound concurrency. Remote upload admission remains authoritative.

Transfer availability now distinguishes `upload_policy_missing`,
`provider_account_unavailable` and `upload_observer_unavailable` from an active
operation/provider failure. The UI explains the applicable reason. Configuration
remains an Owner action; rendering Files never creates an upload policy.

### Prepared file download URLs (Blueprint 1.3)

Successful authenticated folder listing schedules background preparation for its
regular, non-symlink files. The listing is returned without awaiting issuance and
no directory is fetched again for this purpose. The trusted backend batches paths
through Blueprint; signed bearer URLs never enter browser responses or logs.
Editor GET uses the prepared Wings read; streamed file downloads share the same
pool. Editor PUT and other mutation-verification reads retain the native contents
path and existing revision/game-file checks.

A credential/provider/managed-identity-bound, bounded process cache retains at
most one available URL per file. Consumption removes it before any competing
await and starts replacement for that file only. Concurrent consumers receive
different tokens. Expiry uses a 30-second margin; unused URLs have no renewal
loop. Missing entries wait for issuance. Rename/delete/reinstall/restore
invalidate affected entries, including pending results; local authorization and
transfer revocation checks remain mandatory on every access. Recreating a runtime
preserves the pool, while credential/identity/origin changes select a new scope.
The cache is disposable: process restart loses only unused credentials.

The extension exposes authenticated Client `GET /transfer-settings` and
`POST /download-urls` under `/api/client/extensions/nickhosting/servers/{server}`.
The latter accepts `{paths:string[]}` and returns `{expiresAt,urls}` in the same
order. Its count limit defaults to 2500 and is Owner-configurable in Blueprint;
NickHosting also splits long-path batches by response byte budget. Upload batches
respect their separately configurable limit (default 500). Token lifetime defaults
to 900 seconds. Settings are refreshed at most every 60 seconds, with one early
refresh on a changed-limit rejection. Only a missing old endpoint permits native
fallback; denied/throttled/malformed responses do not bypass the extension.

Wings 1.11.13 download and contents handlers use the same contained filesystem
open and final-symlink rejection. Their response handlers are not identical:
contents additionally checks named pipes and uses its size-limited reader. The
editor signed-download path therefore retains a timeout, bounded bytes, declared
length verification and strict text decoding. These checks do not claim that all
possible provider filesystem types were tested live. Initial cold issuance and
HTTP latency remain real; the acceleration depends on background preparation
finishing before the read.

### Directory metadata batches (Blueprint 1.4.0)

The original prerelease added the provider-adapter contract; stable 1.4.0 is
also used by the bounded browser prefetch described below. `listFiles` and
opened-folder download preparation retain their existing behavior. See the
[extension contract](BLUEPRINT-EXTENSION.md#2026-10-13--140-dev-directory-list-experiment)
for Client endpoints, permissions and configurable limits.

`getDirectoryBatchSettings(identifier)` returns the current batch count,
concurrency and deadline. `listDirectoriesBatch(identifier, directories)` returns
an ordered array of `{directory,files}` or `{directory,error}`. It accepts unique
canonical relative directory paths, including `""` for root. Partial errors are
explicit, never equivalent to an empty listing. Missing, duplicate, unrequested
or reordered results are rejected. The adapter bounds this response to 8 MiB;
ordinary JSON responses retain their existing 4 MiB bound. Settings are not an
authorization grant. Callers must still resolve the managed server and authorized
user credential before invoking the adapter.

The provider adapter itself performs no implicit fallback, recursion or download issuance.
The read-only POST does not claim an uncertain filesystem mutation on transport
failure. Configure the caller timeout above the chosen whole-batch deadline plus
Panel/network overhead: defaults are 10 seconds at the adapter and 8 seconds in
the extension. Raising the extension deadline to 10 seconds also requires a
longer caller timeout if partial timeout results must be received.

`POST /v1/servers/:id/files/directories` accepts `{directories:string[]}` with
1–48 unique canonical paths and returns `{results:DirectoryBatchResult[]}`.
It is an authenticated, authorized metadata read, despite the POST method; normal
Origin validation applies. It uses the managed resource owner's Client key and
the existing directory identity proof. Lower extension batch limits are respected
with sequential chunks. It never requests file bodies or signed URLs and never
falls back to many native requests when the optional extension is unavailable.
Provider permissions and identity checks remain mandatory; cached listings grant
no authority to read or mutate files.

`GET /v1/servers/:id/files?path=...&prepareDownloads=false` supplies metadata
without background signing for path completion and destination-tree browsing.
The open Files listing keeps default download preparation. Prefetched descendants
are display hints; entering one revalidates that folder and prepares only its
listed regular files. Errors from optional background prefetch do not replace
the current listing or trigger notifications. Actual foreground failures retain
the existing actionable error states.

Download URL preparation remains best-effort: if opening a directory shares an
already-running metadata-only path/tree query, that response does not sign URLs.
The existing on-demand editor/download issuance handles a cold cache. No extra
directory request is made solely to warm signed URLs in this uncommon case.

### File viewer contracts (2026-10-13)

All routes below require the existing authenticated principal and `server:read`
on the managed server. They reuse the ordinary Origin/session restrictions. Viewer
preferences do not authorize bytes or make a game integration available. No SSH
credentials, signed provider URLs, host filesystem paths or management keys are
returned to the browser.

| Route under `/v1/servers/:id/files/viewer` | Contract |
| --- | --- |
| `GET /capabilities` | `available` and small image/ICO/JSON preview budgets. Optional transport can remain unconfigured without preventing ordinary text editing or downloads. `debugTiming: true` is included only when the API logger enables debug. |
| `GET /preferences` | Current actor's server/game/global extension preferences. Assisted access does not read or rewrite the subject's preferences. |
| `PUT /preferences` | `{scope, extension, viewerId}`; builtin or namespaced compiled first-party identifier. One preference per actor/scope/extension. |
| `DELETE /preferences` | `{scope, extension}` removes only that actor's preference. |
| `GET ?path=...` | Authorized file size, modification time and opaque `revision`; `Cache-Control: no-store`. |
| `GET /content?path=...` | Bounded stream with single HTTP Range/HEAD, 206/416 semantics, no-store, nosniff and sandboxed SVG response. `download=true` adds a safe filename. |
| `GET /archive?path=...&directory=...&offset=0&limit=200` | Retained virtual-folder index, total and next offset. Maximum page size 500. |
| `GET /archive/content?path=...&entry=...` | Chosen member only, with stream/range/download handling. Compressed-member seeking may decode preceding bytes. |
| `GET /subtitles?path=...&track=...&time=...` | Ordinary Matroska file caption window `{start,end,cues}` in seconds. Required numeric track ID and finite nonnegative time (default 0); bounded selective metadata reads over the existing SFTP handle, no audio/video payload transfer to the browser. Unsupported/over-budget parsing returns 422. |
| `POST /motion-timing` | Debug-only diagnostic intake: opaque UUID `traceId`, 1–48 fixed-vocabulary numeric milestone records; requires normal authentication, server read permission and Origin. Returns 204, or 404 with debug off. Browser records are untrusted diagnostics and cannot affect operations. No paths, URLs, captions or arbitrary messages. |
| `GET /sqlite?path=...&table=...&offset=0` | Datagrid table names, opaque source revision, snapshot consistency, column schema and 100 typed rows. Omitting `table` opens the first table in the same request. Optional `query` (literal substring, max 200 characters), `filterColumn`, `sort` and `direction=asc\|desc` operate on the snapshot, with deterministic tie ordering. No arbitrary SQL, live row count or provider query per row. |
| `GET /sqlite/cell?path=...&table=...&rowOffset=...&column=...&revision=...&start=0` | The chosen cell under the same search/sort parameters. Requires the displayed page's revision; changed sources are rejected. Text is read in 65,536-code-point chunks with `nextStart`/`totalCharacters`; integers remain exact and BLOBs expose byte counts only. No data writes. |

Migration `024_file_viewers.sql` adds personal preferences and encrypted private
SFTP credential intent/state. Settings `fileViewers` and write-only secret
`viewerSftpgoApiKey` are independent of external-user SFTP configuration and follow
existing Owner/environment precedence. Credential retirement retains its identity
record; changing transport identity never silently reuses an old account.

Quill adds `markdown` to the builtin preference identifiers. Its shared document
resource contract resolves local links, archive members and already-indexed wiki
candidates over these existing authorized endpoints; it adds no provider proxy,
public signed URLs or server-side Markdown execution. Text caches and pending reads
are bounded per mounted document and fenced by session identity. See
[Quill contracts](M5-QUILL.md) and ADR 0017 for syntax, embedding and editing limits.

Viewer reads optionally accept `If-Match: "<revision>"`. A different source revision
returns 412 before bytes are read; authorization still happens before comparison.
Archive reads use the root archive revision. Existing callers without this header
retain their current behavior. Folio uses this pin across its HTTP Range requests.
The fingerprint uses identity/configuration/path/size/mtime, not content hashing.

HTTP cancellation releases a subscriber; parsed archive/SQLite/subtitle sessions retain
shared source handles for bounded reuse. A shared local authorization watch checks
active session/server access and credential/configuration revocation each second,
not each chunk. Loss of authoritative permission checks aborts further reads.
Disk cache keys include the authorizing session so revoking one principal cannot
cancel another principal's cache population. There is no background game-file
crawl or preview download for unopened files.

See [format limits and evidence](M5-VIEWER-FORMATS.md) and
[deployment approval/rollback](M5-VIEWER-DEPLOYMENT.md). Browser fixtures and isolated
SFTP transport tests do not establish a live Wings mount or production readiness.

### Invitation management UI (2026-10-13)

The invitation UI is connected to the implemented Owner-only recovery/update
routes. Migration `025_invitation_token_ciphertext.sql` adds a nullable encrypted
token envelope alongside the existing hash. Creation encrypts tokens with the
protected `SecretCodec` master key and AAD bound to the invitation ID. Redemption
continues to use the hash; recovery verifies the decrypted token against that
hash. Lists and audit events never include the token, URL, hash or ciphertext.

| Route | Contract |
| --- | --- |
| `GET /v1/owner/invitations/:id/link` | Owner-only recovery of `{url:string}`; sensitive response with `Cache-Control: no-store`. Recovery requires an active invitation. Legacy tokens return `invitation_link_unavailable`; absent, expired, exhausted and revoked invitations return their specific errors. |
| `PATCH /v1/owner/invitations/:id` | Accepts `{expiresAt:ISO,maxUses:integer}` with `maxUses` from 1 to 100; returns the complete authoritative `Invitation`. Recipient email and role remain immutable. |

List and create responses may include an optional `linkAvailable:boolean`:
`true` means durable token recovery is supported for that invitation; `false`
identifies a legacy, non-recoverable link. Omission means the older API has not
declared recoverability, not that durable recovery is available. An original
create response can still expose its one-time URL for the current UI session.

Used invitations retain their consumed count, `maxUses - remainingUses`. A new
maximum cannot be lower than that count. The backend locks the invitation row and recomputes usage before updating it,
serializing with registration and revocation; client validation is only a
convenience. Expiration must be in the future and at most 365 days away. Revoked invitations cannot be edited. Expired or exhausted
invitations can be edited, and extending expiration or increasing uses may make
them usable again. Revocation discards the encrypted token; expiration/exhaustion retain it so
renewal preserves the original URL. Create, recovery and updates use the existing
Origin/support-session checks; all responses, including errors, are `no-store`.
Recovery and edits record only safe metadata in the audit log.

The migration does not delete or rewrite existing invitations. Legacy hash-only
invitations remain redeemable and report `linkAvailable:false`. Any Owner-requested
test-data reset is a separate, explicitly scoped operation. Retain encryption keys
for stored key IDs; losing a key makes its links unrecoverable, while their hashes
still support redemption. Code rollback can leave the nullable column in place;
do not drop ciphertext during rollback if links must remain recoverable.

### Username and primary/additional SFTP contracts (2026-10-14)

Account profiles expose immutable `username` separately from editable `name`.
Credential signup and Owner setup accept `^[a-z0-9][a-z0-9_-]{2,39}$`; omission
and OAuth signup generate a unique handle. Account updates cannot change it.
Duplicate username claims return a conflict without consuming the losing invite.

SFTP routes are relative to `/v1/platform/servers/:id`:

| Route | Contract |
| --- | --- |
| `GET /sftp` | Issuer-scoped credentials, with `kind`, nullable `label`, state, username and nullable `expiresAt`; never passwords. |
| `POST /sftp` | Strict `{credentialId, kind?, label?}`; kind defaults to `auxiliary`. Primary rejects labels, has no expiry and reuses the actor/server primary identity. Optional auxiliary labels contain 1–80 trimmed characters. |
| `POST /sftp/:credentialId/rotate` | `{rotationId}`; issuer-only idempotent rotation. Primary expiry stays null; auxiliary expiry is renewed. Initial response includes the new password once; explicit recovery is available below. |
| `POST /sftp/:credentialId/password` | Strict `{}`; fresh regular issuer session and current server-manage permission required. Returns the active, unexpired credential and its decrypted password with `Cache-Control: no-store`; never invokes SFTPGo. |
| `DELETE /sftp/:credentialId` | Issuer-only auxiliary revocation; primary deletion is forbidden. |
| `GET /transfers` | `sftp.auxiliaryLimit` exposes the configured per-actor/server additional-access limit. |

Primary usernames are `<account username>-<first eight characters of NickHosting
server UUID>`. New passwords have 16 characters. Regular-session/manage checks,
provider ownership and durable retries remain enforced. Permission loss revokes
both kinds in the background; issue #18 still applies to retained SSH transports.
Legacy credentials remain auxiliary, without changing their provider identity,
password or expiry. Additional-access limit defaults to 3 (0–32); revoked rows do
not consume it. Primary credentials do not consume the additional-access limit.


Password recovery (Owner-approved amendment, 2026-10-14) reuses the existing
context-bound encrypted credential intent. No additional plaintext storage or
schema migration is introduced; pre-existing active credentials remain recoverable
if their encrypted secret is intact. Reveals serialize with rotation/revocation,
reject inactive/uncertain/expired credentials and assisted sessions, and require
the issuing actor even when another actor is Owner. Each successful disclosure
records `server.sftp.password_revealed` with server/credential IDs only. Revocation
continues to clear the retained password. List GET responses remain secret-free.
No permission is inferred from frontend visibility; POST Origin/session checks
remain enforced. This replaces the earlier rotate-only recovery UX without
changing idempotent create/rotate responses or issue #18.

## Minecraft identity and protocol families — 2026-10-14

The canonical game ID and localization namespace are `minecraft` and `games.minecraft`.
The Java wire handler remains `minecraft-java`; no Bedrock runtime is introduced.
Migration031 preserves mapping IDs and signed evidence with an explicit historical
digest preimage alias. Existing API paths `/v1/owner/minecraft/...` are unchanged.
Public choice capabilities now separate `wake`, `playerIdle` and `sleepWake` from
`gateway`/`readiness`. Fake protocol counters are never actual player observations.
Route metadata accepts `family: legacy` as well as `netty`, current declaration
`minecraft/vanilla` v2 and optional `responses` presentation settings.
See [protocol contracts and evidence](MINECRAFT-MULTIPROTOCOL.md) and ADR0018.

### Retrying a failed installation

A terminal failed provision/reinstall remains failed; it does not silently become
installed after a manual provider reinstall. Normal reconciliation can release its
retained installer reservation once the exact reservation-owning job is terminal,
no operation is active, the provider reports installed or an explicit installation
failure, and the existing host observer confirms both installer and game stopped.
The local state becomes `failed`; an explicit Reinstall then uses ordinary
authorization, confirmation, fresh admission and the existing provider flow.

Pending/unknown installer state, unavailable observation, identity mismatch or a
concurrent operation retain the reservation. Reconciliation fences both the
reservation and its owning operation/job revisions, including older jobs. It never
replays a failed effect, runs an installer, promotes game verification or clears
another operation's reservation. No API/schema or UI confirmation changes.

### Completing initial Gateway registration after installation recovery

A successful explicit reinstall following failed initial provisioning can complete
that provisioning's reserved Gateway registration during normal reconciliation.
Recovery uses the original immutable route plan, current configuration and compiled
game binding. It does not create replacement routes or repeat provider operations.
Only untouched, never-activated reservations with no existing Gateway policy are
eligible. Owner edits, deleted routes, prior activation and concurrent operations
must be preserved. Recovered running servers still require normal Gateway readiness
observations; neither a successful reinstall nor recovery itself proves playability.

### Generated Gateway automation defaults

Automatically initialized Gateway policies enable supported automation and inherit
the configured idle timeout. There is no additional hidden per-server opt-in after
successful provisioning or recovery. Timeout `-1` disables automatic sleep without
disabling wake; manual stops/maintenance and missing player observations retain
their existing suppression rules. Explicit policy changes remain authoritative.
Older disabled generated defaults can be repaired through normal reconciliation
only with original activation provenance, unchanged default policy fields and no
explicit policy-update audit, including no-op disable requests.

### Automatic personal SFTP access — 2026-10-15

The worker prepares one persistent primary credential for each current
`server:manage` principal on a provider-bound eligible server: its creator/owner,
project managers and platform Owners under the existing permission model.
Project viewers/operators without that permission receive no SFTP access.
Creation completion, project membership/reassignment and role changes are discovered
from authoritative persisted state; opening the SFTP page is not an issuance trigger.
Existing servers are covered as well. Provisioning is asynchronous and retried when
SFTP configuration/provider availability or a server operation temporarily blocks it.

The same encrypted intent/provider lifecycle handles automatic and explicit issuance.
A service-issued primary records its subject without inventing an interactive session
or delivering a password to the worker/UI. Password reveal and rotation still require
the actual account's regular authorized session. Auxiliary creation remains manual.
The SFTP view shows preparation state until the credential is ready; list polling is
secret-free and does not create credentials. Permission loss/deletion revokes access;
a regrant waits for any old revocation before creating fresh credentials. Background
cleanup continues after deletion of the last managed server. Issue #18's retained
SSH transport limitation remains unchanged; this does not claim immediate transport
termination. No database schema change is required.

## Primary server addresses and Owner domain policies

`GET /v1/games/:id/connection-options` authorizes game creation rollout;
`GET /v1/servers/:id/connection-options` authorizes server read. They return
`{mode,customizable,domains:[{id,hostname}],defaultDomainId,defaultHostname,
supportsSrv,configured}`. They never expose provider keys or zone IDs to ordinary
users. Configuration readiness is separate from external reachability.

Creation accepts optional `connection:{domainId?,subdomain?}`. Omitted labels use
server-side automatic naming; the saved preference follows the idempotent creation
request. DNS preview/assignment/update accept `domainId` alongside the existing
label/port-role fields. Preview returns the chosen label/domain so saving the
preview cannot silently choose another random name. Existing servers activate a
primary address explicitly through the DNS endpoint. Background reconciliation
uses server-scoped service authority, not a fabricated Owner browser session.

`GET /v1/platform/servers/:id/connections` supplies per-port `displayAddress`, plus `addressState` and
`primaryDnsAssignmentId` for authoritative primary selection.
Consumers must not reconstruct hostname/port strings: SRV applies only to the
matching primary role and transport. Direct endpoints retain their explicit
configuration and unverified external-reachability status. Gateway DNS uses the
public route port, never an assumed backend port.

Owner settings add `dnsDomains`, `dnsDefaultDomainId`, `dnsGamePolicies`,
`dnsBlockedTerms`, and `dnsNameReuseDelaySeconds`. Corresponding environment keys
are `NH_DNS_DOMAINS`, `NH_DNS_DEFAULT_DOMAIN_ID`, `NH_DNS_GAME_POLICIES`,
`NH_DNS_BLOCKED_TERMS`, and `NH_DNS_NAME_REUSE_DELAY_SECONDS`; arrays/objects use
JSON. Blacklist/default domain list are empty and reuse delay is zero initially.
The existing protected settings write/reset and environment lock rules apply.

Migration032 adds per-server preferences, shared-host intents and hostname
reservations. It does not opt existing servers into publication. Durable DNS
intents retain zone/ownership and the last confirmed connection during replacement.
Preserve the new schema and intents during rollback: older code does not understand
shared ownership or v2 intents. Do not drop tables to undo an application rollout;
stop DNS reconciliation and restore compatible code after inspecting pending work.

Shared-host target changes reconcile in the original zone. Changing the zone ID of
an existing shared intent fails closed; retired shared names remain owned rather
than being removed from existing connections automatically. Removing a chosen
domain before a new server's initial DNS intent is prepared leaves its preference
pending until the configuration is restored or an explicit replacement address is
submitted. No record has been published in that pre-intent state.

### Wizard address availability and temporary reservation

Minecraft declares a dedicated SDK `address` page immediately after version choice;
the common wizard renders it instead of placing editable connection fields in the
final summary. An empty name retains automatic naming.

`POST /v1/games/:id/connection-availability` accepts `{domainId?,subdomain}` and
returns `{available,hostname}`. It requires a regular authorized session, CSRF,
game rollout access and an eligible/customizable domain; invalid/blocked labels
are rejected before provider access. Local claims are checked before cached
Cloudflare results. Presence queries use exact names, `per_page=1`, at most two
GETs for the hostname and declared SRV name. No record contents are disclosed.

The browser waits 600ms after valid nonempty input, ignores stale responses and
never retries/refetches on focus automatically. Server defaults are 30-second
bounded cache (512 names), coalesced concurrent requests, 60 upstream reads per
minute per credential scope and two concurrent lookup groups. Owner settings are
`dnsAvailabilityCacheSeconds`, `dnsAvailabilityRequestsPerMinute` and
`dnsAvailabilityConcurrency`, with corresponding `NH_DNS_AVAILABILITY_CACHE_SECONDS`,
`NH_DNS_AVAILABILITY_REQUESTS_PER_MINUTE` and `NH_DNS_AVAILABILITY_CONCURRENCY`
overrides. HTTP429 applies a shared cooldown respecting Retry-After; uncertainty
is never presented as availability. These budgets/cache are process-local, not a
distributed quota for every application using the same Cloudflare account.

Cloudflare documents 1,200 requests per five minutes cumulatively per user/account
token and 200 requests per second per IP. User dashboard and token requests share
the user quota; other apps/API replicas still consume it. Our preview budget leaves
headroom but cannot guarantee that external activity will not exhaust it.
Sources: [API limits](https://developers.cloudflare.com/fundamentals/api/reference/limits/),
[exact-name DNS queries](https://developers.cloudflare.com/api/typescript/resources/dns/subresources/records/methods/list/).

Next on a custom name calls `POST /v1/games/:id/connection-reservation` with
`{domainId?,subdomain,previousReservationId?}`. It returns
`{reservationId,hostname,expiresAt,domainId,subdomain}`. A 15-minute account/game-bound
hold is atomically stored in the existing hostname registry, with at most five
active holds per account. Replacing a prior choice releases only an owned wizard
hold, and only after the replacement succeeds. Abandoned holds expire; no temporary
Cloudflare record is created. The wizard passes `connection.reservationId` during
creation; the same transaction verifies ownership, exact choice and expiry and
transfers the claim to the new server. Transaction failure preserves the hold;
idempotent creation replay does not consume it twice. An expired hold returns the
wizard to address selection. Blank automatic names do not require a wizard hold.

A hold excludes other NickHosting assignments, including API calls omitting the
token; it cannot prevent manual/external Cloudflare changes. Existing owned-record
checks remain authoritative at publication. Consumed claims survive provisioning
retries and are released if the server is deleted before DNS intent preparation.

### Cloudflare Free ownership marker and address presentation correction

New/updated records use `nickhosting:v2:<sha256>` (79 ASCII characters), hashing the
validated instance/server/assignment UUID tuple. The original 122-character marker
exceeded Cloudflare Free's 100-character comment limit. Exact legacy markers remain
recognized for owned-record recovery/update/delete; identity, content and ledger
checks are unchanged. This does not adopt foreign records.

DNS-mode connection descriptors withhold raw public-IP fallbacks until an address
is confirmed. Pending/uncertain first publication shows address preparation/failure;
rename continues displaying the last confirmed hostname. Static-host integrations
retain their explicit configured address. Console consumes `displayAddress` rather
than reconstructing an IP/port pair when it is null.

## Owner integration policies (2026-10-16)

Regular Owner sessions only; unknown/uncompiled game IDs are rejected.

| Endpoint | Contract |
| --- | --- |
| `GET /v1/owner/integrations/:gameId/domain-policy` | `{gameId,policy,domains,inheritedDefaultDomainId,locked}`. Domain summaries expose only ID, hostname and enabled state. |
| `PUT /v1/owner/integrations/:gameId/domain-policy` | Body `{selection,domainIds,defaultDomainId?,sharedLabel?}`; validates existing domains and the integration's connection mode. Saves only that game's policy under the settings lock. |
| `GET /v1/owner/integrations/:gameId/content-policy` | `{gameId,policy,effective,locked}`; effective includes resolved values and per-field global/override/source/lock metadata. |
| `PUT /v1/owner/integrations/:gameId/content-policy` | Optional `sourceGlobalBytes`, `sourceUserBytes`, `sourceConcurrent`, `sourceUserConcurrent`, `sourceFreeBytes`, `sourceFreePercent`, `downloadOrigins`; `{}` restores inheritance. Resource lock precedes settings lock. Global ceilings still apply. |
| `GET /v1/owner/runtime-mappings` | Adds `inUse`: a nondeleted managed server references this mapping. Used mappings retain the existing immutable-field guards. |

Policy updates preserve other games and honor environment locks. Download-origin
overrides can only narrow global trust; empty explicit origins differ from
inheritance. Content source/work paths remain global. No provider call or DNS
mutation is performed while saving these policy objects. Global setting reads
expose the canonical `content*` names; legacy Minecraft names are accepted aliases
for PATCH and reset. [Migration/precedence details](CONFIGURATION-AND-DEPLOYMENT.md#shared-content-limits-and-integration-overrides-2026-10-16).

## 2026-10-16 — Contextual Minecraft Versions workspace

Owner Versions shares the selected `runtime` with Runtime administration and scopes
the catalog to an explicit `mappingId`. Friendly node/egg labels come from the
existing cached infrastructure discovery. They do not replace immutable mapping
or combination IDs.

`GET /v1/owner/minecraft/compatibility?view=workspace&runtime=vanilla&mappingId=<uuid>`
accepts the existing search/type/availability/order/page controls and returns
`{items,total,page,pageSize,metadataStatus}`. Pagination counts release groups.
Each group contains `release`, `releaseType`, `releaseTime`,
`releaseTimeStatus`, `variantCount`, and a summary `choice` only for a singleton.
Expanding a multiple-configuration release loads bounded summary pages with
`view=summary&mappingId=<uuid>&runtime=vanilla&release=<exact-release>`.
Distinct builds/bindings remain distinct configuration IDs. Existing summary,
cursor and unpaginated APIs remain available.

Summary and protected detail projections include the resolved container `image`,
`mappingEnabled` and `creation: {state,reason}`. `state` is `available`,
`private-testing` or `blocked`. Blocking reasons distinguish disabled choices,
disabled/changed mappings, disabled nodes, rollout state and missing required
evidence. This is static ordinary-user catalog eligibility using the existing rules and batched
related-data reads; it is not a promise of live provider connectivity, free
capacity or successful installation. Dynamic checks remain at creation/admission.
The `availability=enabled|disabled` filter is explicitly the Owner's stored choice,
not a second frontend implementation of eligibility.

`PUT /v1/owner/minecraft/compatibility/availability` takes
`{mappingId,ids,enabled}`, with 1–500 distinct combination UUIDs, and returns 204.
One transaction reauthorizes the current interactive Owner, validates every ID
against that mapping, changes availability and records the audit event. Missing or
foreign IDs fail the whole request. No provider mutation, runtime retargeting or
evidence promotion occurs. The UI selects concrete configurations; an unopened
multiple-configuration release does not silently select hidden IDs.

Scanning continues through the existing bounded catalog API. Normal discovery
preserves previously disabled choices. Reenabling is a separate explicit catalog
action. The scan panel retains measured progress and a bounded optional log while
switching integration tabs; leaving/reloading the workspace cancels this
browser-driven scan. Registered test reports remain separate from integration
capabilities and are fetched only with detail. No new migration is required.

## Backup events and recovery — 2026-10-17

[Backups](BACKUPS.md) documents the extended creation/restore options, game policy,
protected backups, local names, SSE invalidations, scheduling/retention and separate
backup/resumption outcomes. Core retains the existing adapter and durable operation
boundary; Blueprint 1.5.0 supplies committed native completion receipts.


### Unified Activity and SFTP callbacks

Activity preserves existing job fields and adds `kind`, nullable `jobId`, category,
source, outcome, actor/subject display identities and explicitly selected metadata.
Only job rows have an operation-detail link. Batch/operation snapshots become one
row, with stable chronology and current outcome. Console command text is restricted
to server managers; output, credentials, file contents and signed URLs are excluded.
Date query boundaries are ISO instants; the UI converts the user's local dates.

`POST /v1/provider-events/sftpgo` is a machine-only callback with a dedicated Bearer
secret, strict bounded payload and stable duplicate handling. It is the sole new
Origin exemption; browser sessions cannot authorize it. Durable provider bindings
map primary/auxiliary credentials to the issuing NickHosting account. The scoped
user-SFTP Event Manager rule must be explicitly activated; technical viewer accounts
are ignored. See [transport and delivery limitations](SFTP-ACTIVITY.md).

### Trusted Gateway message editor contribution — 2026-10-17

`TrustedGameUiModule.gatewayMessageEditor?: string` selects a bounded compiled
browser editor key. It is not part of API-supplied UI descriptors and cannot name
an import URL. The shared form supplies definition/state, locale, draft overrides,
read-only authority and change/reset callbacks. It owns the existing GET/PUT
contract, revision, errors and save lifecycle. Minecraft registers its Vanilla
26.1 preview; unknown keys or unsupported channel sets use the generic editor.
No database migration or Gateway packet change accompanies this UI extension.

### Minecraft player management — 2026-10-17

- `GET /v1/servers/:id/minecraft/players`: authorized server readers receive bounded
  authoritative operator, whitelist and player-ban lists, installed/support flags,
  and whitelist enabled/enforcement state. Missing list files are empty only for
  an explicit provider404; transport/permission/parse errors remain errors.
- `GET /v1/servers/:id/minecraft/players/online`: parsed names, observation time and
  `available|unavailable|offline` state. Unavailable does not mean an empty server.
  Readers can request only this fixed observation, never arbitrary console input.
- `POST /v1/servers/:id/minecraft/players/actions`: server managers only, installed
  supported running server, typed `op|deop|whitelist-add|whitelist-remove|whitelist-on|whitelist-off|kick|ban|pardon`.
  Named actions accept bounded Minecraft names and optional `expectedUuid`; only
  kick/ban accept a single-line reason. No arbitrary command, selectors or tempban.
  Returns202 with `outcome: dispatched`. Unknown post-send outcomes remain
  `operation_uncertain`; there is no transport fallback or automatic replay.
- Existing `/minecraft/operations` player commands retain offline jobs, including
  operator level and slot-limit bypass. Optional selected `expectedUuid` protects
  existing-row edits/removals; new additions still require verified identity.

Standard managed-server authorization, lifecycle locks, provider identity and
actor/subject audit apply. Typed commands appear in Activity through the existing
console audit model. No new provider keys, database tables or deployment settings.

### Minecraft Worlds inventory — 2026-10-17

`GET /v1/servers/:id/minecraft/worlds` now returns an object instead of the old
array: `{ installed, supported, selectedWorld, release, compatibility, worlds }`.
`selectedWorld` is the observed `server.properties` value (default `world` when
omitted); it can refer to a world not generated yet. `compatibility` is `available`
or `unavailable`; a missing expected DataVersion does not erase the inventory.
Each world retains `{ name, status, validation? }`, with `status` equal to
`verified`, `incompatible` or `unavailable`, and bounded version metadata when
readable. No arbitrary NBT or file content is exposed. The trusted script helper
`listMinecraftWorlds` keeps its array return contract.

Inventory uses `server:read`, current session/managed identity through the shared
Fileman access helper, no-store responses and reauthorization during/following
reads. At most two candidate readers run concurrently. Existing `world-import`,
`world-select` and `world-remove` durable command contracts are unchanged and
remain `server:manage` operations. As of 2026-10-18, additive world import may
run while running into a new folder other than the configured active world.
Selection/removal/replacement still require offline state. World DataVersion now
comes from the integration's bundled exact-release catalog, not signed installation
reports; unknown and historical pre-DataVersion releases remain unavailable. The frontend checks expected
eligibility but authoritative validation remains in the worker.

Downloads use the existing `/v1/servers/:id/files/archive` endpoint with root `''`
and the selected world directory; they retain file-transfer authorization and
streaming bounds. This is not a new backup or consistency guarantee. No new
settings, migrations, credentials or external API are required.

World directory selection (2026-10-18) is a browser input alternative, not a new
API contract: the worker prepares a ZIP source and uses the same authenticated
`/v1/minecraft/sources` upload and `world-import` durable command. No direct
per-file write or second installation path is exposed for directory input.

### Minecraft world catalog acquisition — 2026-10-18

- `GET /v1/servers/:id/minecraft/world-catalog` returns
  `{providers:[{id:'curseforge',available:boolean}]}` after local server-read
  authorization. It reveals neither credentials nor protected configuration.
- `GET /v1/servers/:id/minecraft/world-catalog/search` accepts
  `provider=curseforge`, `query` (up to 256 characters), `offset` (0–9980) and an
  optional `gameVersion`. Default search spans all world versions. No loader filter.
- `GET /v1/servers/:id/minecraft/world-catalog/curseforge/:projectId/files` accepts
  `offset` and lists published file identities, names, byte counts, declared game
  versions, publication times and automatic-download availability.
- Both lists return `{items,offset,limit:20,total}`. Read scope is checked on every
  request, even for cached metadata. Cache is bounded, coalesced and scoped to the
  effective protected provider configuration. Discovery does not request game files
  or Pterodactyl server identities.
- `POST /v1/minecraft/sources/world-catalog` accepts exactly
  `{provider:'curseforge',serverId,projectId,versionId,idempotencyKey}`. IDs are
  positive decimal provider IDs. Current `server:manage` authority is required.
  It returns HTTP201 with the existing safe source DTO only after `state:'ready'`.
  Arbitrary URLs, provider keys and filesystem paths are not accepted.

Acquisition resolves exact project/file metadata again, honors distribution denial,
then reuses source admission, quota/concurrency limits, authorized streaming,
integrity verification and immutable source sealing. It reuses the downloader's
verified digest instead of hashing the archive twice. Archive downloads follow at
most three HTTP 301/302/303/307/308 redirects, validating each HTTPS origin and
pinning newly validated public DNS before each connection. Loops, unapproved
origins and credential-bearing URLs are rejected; provider API keys and cookies
are never sent with downloads. Metadata requests still refuse all redirects.
The source is bound to the same server/owner; idempotent retries return ready
sources without a new download.
Uncertain transfers retain their reservation and existing Owner recovery controls.
Browser disconnect is not a claim that an external download completed or that its
staging was removed. The existing `world-import` command and its explicit overwrite
consent remain unchanged; catalog acquisition itself never changes game files.

Migration `043_world_catalog_sources.sql` extends the source origin/identity CHECK
constraints for `curseforge` world archives. It rewrites no source rows. Apply it
explicitly before acquisition; do not edit historical migrations. Rollback can
retain the additive schema and existing staged sources while reverting code.

Modrinth remains the existing mod/modpack provider, not a saved-world catalog.
MinecraftMaps is an external link plus manual ZIP/folder import; no scraper or
private endpoint was added. See [provider evidence](GAME-INTEGRATIONS.md#world-catalogs--m5-2026-10-18).
