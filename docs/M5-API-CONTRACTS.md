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
| `/connections` | Domain `mode` plus frozen `connectionMode: gateway/direct`, configured hostname/SRV metadata, DNS states and every allocation role/transport. Gateway ports retain `unconfigured`, `disabled`, `unavailable` or `available` route status. Direct ports use only frozen `direct_endpoint` and report `configured`/`unconfigured`, with `reachability: unverified`. Configuration never claims an externally tested connection. |
| `/metrics` | `limit` 1–500 (default 100), `from`, `to`, `before` ISO timestamps; `{items,nextBefore}` in descending observation order. Missing intervals remain gaps. |
| `/sleep-policy` | `{policy,state,proposedPolicy}`; policy/state remain null when unconfigured or direct. A trusted installed integration may supply a validated initial proposal for Gateway-mode servers. GET never saves it. Complete editable enabled/protocol/version, idle/readiness/estimate/wake-retry fields and intent-derived mode; state reuses M3 readiness and startup estimates. |

SFTP connection details require explicit `sftpPublicHostname` and `sftpPublicPort`;
the private SFTPGo API URL is never used as a public fallback. These settings follow
defaults → Owner database settings → environment overrides. Both service configuration
and actual handler permission are still required. `retainedTransportRevocationLimited`
remains true while [issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18)
is unresolved; credential deletion is not an assurance that an established SSH
transport has closed.

File, backup, console, metrics and DNS actions reuse M2 endpoints. Browser uploads
send `Blob` through XHR with declared `X-NH-Upload-Length`, observable byte progress
and cancellation; server admission/stream verification remains authoritative.
Downloads use a native same-origin link, without creating a whole-file browser
JavaScript blob. The text editor alone caps input at 60,000 characters and bounds
its streaming read to 240,000 bytes. Binary transfers have no such editor cap.
Console display retains at most 300 lines, each truncated to 8,192 characters;
the API independently bounds outstanding SSE output (256 KiB/64 events with a
five-second slow-consumer timeout). Reconnecting does not promise replay of missed
console output. Authorization remains live; stale data is not current telemetry.

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

`POST /v1/owner/reconcile` returns actual checked/failed subsets. Partial provider
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
