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
| `GET /v1/web/session` | Current `context`, safe `actor` and `subject` profiles. Actor and effective subject are displayed separately in assisted mode. |
| `POST /v1/web/support` | Existing regular-Owner step-up/reason/grant requirements; sets `nh.support` as HttpOnly, SameSite Strict, path `/`, HTTPS Secure when configured. Returns grant metadata/expiry, never its token. |
| `POST /v1/web/support/exit` | Revokes the exact grant when the parent session authorizes it and clears the browser cookie. Expired/invalid parent authority still permits local cookie removal; this does not claim durable revocation of an unauthenticated grant. Storage failures remain errors. |

Existing header clients can still send `X-NH-Support-Token`. Header/cookie disagreement
is rejected. Regular-only identity/admin endpoints reject either assisted transport.
Native file/backup downloads carry the same HttpOnly cookie and authorization as
API calls, without returning privileged upstream URLs. Original user sessions are
unchanged by assisted access or Exit.

## Scoped platform queries

[Platform routes](../apps/api/src/platform.ts) delegate to
[typed queries](../packages/server-management/src/platform-queries.ts). Paginated
collections return `{items,nextCursor}`. Common page size is 1–100 (default 30),
with validated opaque descending timestamp/identity cursors. Search text is a
literal substring, not a user-supplied SQL wildcard. User/audit identities may be
text; server/project/job identities are UUIDs. Invalid cursors are domain errors.

| Method/path | Filters/body and contract |
| --- | --- |
| `GET /v1/platform/servers` | `limit`, `cursor`, `q`, `state`, `gameId`, `ownerId`, `projectId` (UUID or `none`). Only managed, undeleted servers in current owner/project scope; regular Owner can discover all. |
| `GET /v1/platform/servers/:id` | Existing public server fields plus `gameId`, `runtimeId`, `gameNameKey`, `capabilities`, `permissions`, `availableActions`, `sleepState`, `firstStart`. |
| `PATCH /v1/platform/servers/:id` | Strict `{name?,projectId?}`. Manage permission for rename; resource owner or regular Owner for regrouping. Destination project belongs to the same resource owner. Runtime mapping, provider identity and allocation claims are immutable here. |
| `GET /v1/platform/projects` | Paginated `q` search; current membership and effective management role. |
| `GET /v1/platform/projects/:id` | Project metadata, safe owner and member profiles/roles. |
| `PATCH /v1/platform/projects/:id` | `{name}`; project owner or regular platform Owner, under the resource lock. |
| `DELETE /v1/platform/projects/:id` | `{confirm:true}` with project-owner or regular-Owner authority; returns detached-server count. Deletes grouping/memberships, retains servers and their owner/resource charges. |
| `POST /v1/platform/projects/:id/collaborator` | Exact verified-email lookup, available only to the project owner or regular platform Owner; `{user: safeProfile|null}`. No ordinary global account directory. |
| `GET /v1/platform/quotas` | Effective subject's current quota, commitments, measurements and override state. |
| `GET /v1/platform/activity` | Paginated `state`, `action`, `serverId` filters; current server/project scope. |
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
| `PUT /automation-consent` | Strict `{allowed,expectedIntent}` with current regular manage authority. Does not implicitly start a server or deploy/enable a Gateway. |
| `GET /schedules` | Current schedules with revision, timing, zone, action, next run and timestamps. |
| `POST /schedules` | `{name,action,timing,timeZone,enabled}`; 201 on durable creation. |
| `PUT /schedules/:scheduleId` | Same fields plus current `revision`; stale updates conflict. |
| `DELETE /schedules/:scheduleId` | `{revision}`; soft deletion retains occurrence history, returns 204. |
| `GET /schedules/:scheduleId/outcomes` | Bounded cursor-paginated occurrence history and associated job/effect outcome. |

Actions are `start`, `stop`, `restart`, `backup`. Timing is either
`{kind:'once',at: ISO}` or `{kind:'interval',firstAt: ISO,everySeconds}` (300 through
31,536,000 seconds). `timeZone` must be an IANA zone recognized by `Intl`; execution
uses UTC instants and elapsed intervals, not a hidden DST/cron interpretation.
Missed interval runs collapse to the latest due occurrence; more than five minutes
late is recorded as skipped. No capacity waiting queue or retrospective burst.

Occurrence claim, admission, operation and outbox are one PostgreSQL transaction.
Duplicate workers cannot dispatch the same occurrence twice. Before each **new**
provider effect, the lifecycle authorizer rechecks creator identity/verification,
current manage permission, schedule revision/enabled/deleted state, occurrence/job
identity, regular actor=subject authority and manual-stop/Gateway generation.
Unknown prepared effects continue conservative reconciliation, not blind replay.

Manual stop/maintenance suppress automatic starts. Granting automatic-start
consent is explicit, compares the current intent and is blocked until unfinished
operations, uploads, installation and uncertain reservations settle. Revocation
is immediate and rotates existing Gateway generation/readiness without cancelling
history or releasing resources prematurely. Scheduled stop also revokes future
start consent even when an operation conflict prevents that stop dispatch. An
Owner must deliberately permit automatic starts again; a schedule cannot grant
itself consent.

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
  Create requests may omit `limits.disk` only with `GLOBAL_POOL`. Core resolves
  the Owner default under the existing resource transaction and freezes it with
  the request. Retrying the same omitted-disk request after a setting change returns
  the original operation. Configure/resize requests still require explicit limits.
- `defaultServerStorageMiB` defaults to the former wizard value, 4096 MiB; normal
  defaults < Owner DB < environment precedence applies. This is a finite allowance,
  not unlimited disk. No actual Owner settings are seeded or changed by the update.

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

The current Owner UI uses
`GET /v1/owner/minecraft/compatibility?view=summary&page=1&pageSize=25`.
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

| Route | Request/result |
| --- | --- |
| `GET /editor?path=...` | Bounded strict UTF-8 text and SHA-256 `revision`; known binary extensions rejected before reading, actual bytes validated afterward. Reuses the directory identity proof with fresh local authorization; one direct provider content request, no ancestor listings. Wings contains the path and rejects final symlinks. |
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
Planning reuses directory indexes only inside that request; copy's subsequent
source/destination checks remain fresh before writes.
There is no delete-before-move. Destination names appearing after browser preflight
are checked again by the API. Provider filesystem changes can still race the final
preflight/rename interval: the current Client API contract has no atomic no-clobber
flag and multi-file renames are not transactional. No rollback or automatic retry
is claimed after an ambiguous/partial provider failure.

Copy uses the same exact-path consent semantics, with approvals scoped to the
selected top-level files and validated before any writes. It rechecks source and
destination metadata before each streamed upload and checks the destination again
after download negotiation. Existing files are never deleted first. Replacements
reserve full upload capacity without crediting the destination's size. Authorization, protected
paths, upload admission and durable claims remain enforced; approved paths are
audited. Concurrent external Wings writes can still race the final check/upload
interval because the provider exposes no atomic compare-and-swap.

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
