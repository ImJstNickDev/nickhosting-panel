# M2 server and service contracts

These contracts extend [M1](M1-API.md). They describe the backend for the future
M5 WebPanel; game gateway behavior remains M3 and game-specific readiness remains
M4/M6. [M2 validation](M2-VALIDATION.md) records actual test results, unresolved
findings and live-test cleanup. This document is not a completion or deployment
approval. See also [ADR 0011](decisions/0011-server-lifecycle-and-service-boundaries.md).

## Authentication, errors and identifiers

Routes require a verified session. Mutations require the configured browser
`Origin` and JSON content type, including empty `{}` bodies where specified;
the binary upload route instead requires `application/octet-stream`.
Errors retain the M1 safe error code, message key, en/it message and request ID
contract. JSON requests are bounded to 65,536 bytes. Responses use `no-store`.
SSE and binary download routes are the exceptions to JSON response bodies.

`:id` is a NickHosting server UUID, never an arbitrary Pterodactyl identifier.
Only the managed registry can resolve it into a remote identity. Ordinary users
can read their own servers and project memberships; project viewers can read,
operators can operate, and managers can manage. `start`, `stop`, `kill`, `restart` and
`backup` require `server:operate`; configuration, destructive operations, file
mutations, console commands, SFTP and DNS changes require `server:manage`.
Platform operator status alone grants no access to somebody else's server.

The regular Owner can administer all registered servers. Temporary support
contexts preserve actor, subject and support-session attribution. Infrastructure,
policy and uncertain-operation resolution endpoints require a regular Owner
session. SFTP issue/rotation and DNS assignment/update also require regular
sessions so temporary support cannot create durable external access. Workers
recheck current roles, project membership and support-parent validity before new
external effects; a queued authorization snapshot is not a permanent grant.

## Registry and projects

| Method/path | Request and result |
| --- | --- |
| GET `/v1/servers` | Accessible, undeleted servers, newest first, maximum 1,000. |
| POST `/v1/servers` | `{idempotencyKey,mappingId,name,projectId?,limits,autoStart?}` → `202 {serverId,jobId}`. `autoStart` defaults to `true`. |
| GET `/v1/servers/:id` | Public server state and assigned `{role,port,protocols,is_primary}` entries. No backend address or provider credentials. |
| GET/POST `/v1/projects` | Accessible projects, or create `{name}` → `201`. |
| PUT `/v1/projects/:id/members` | `{userId,role:'manager'|'operator'|'viewer'|null}`; `null` removes membership. Project owner or platform Owner management; returns `204`. |

The public server shape is `{id,name,ownerId,projectId,mappingId,limits,
runtimeState,readiness,intent,installationState,activeOperationId,lastObservedAt,
createdAt}`. Runtime, installation, game readiness and user intent remain separate.
A running process is not a claim that its game is ready.

`limits` is `{memory,cpu,disk,swap?,io?}`: memory/disk are MiB, CPU uses
Pterodactyl percentage units (`100` means the equivalent limit of one logical
CPU, not a dedicated physical core). Minimums are 32 MiB RAM, 16 MiB disk and
1 CPU percent. Swap is fixed at `0`; I/O weight defaults to `500` and accepts
10–1,000. Unlimited resource values are rejected. Project association is optional;
creation into a project requires the current subject to own it. Budgets belong
to the server owner, not the member who clicked Start.

Idempotency keys contain 1–128 letters, digits, `_` or `-` and are scoped to the
actor. Repeating the same request returns its original server/job IDs; reusing
the key with different input or subject is a conflict. Registry, persistent disk
allowance, port claims, operation and outbox commit together before provisioning.
The adapter always provisions with `start_on_completion=false`; any requested
initial start subsequently passes through admission. Failed initial admission
leaves the created server available offline rather than deleting it.

## Lifecycle and activity

POST `/v1/servers/:id/operations` returns `202 {serverId,jobId}`. Accepted bodies:

| Action | Fields in addition to `action` and `idempotencyKey` |
| --- | --- |
| `start`, `stop`, `restart`, `backup` | None. |
| `kill` | `confirm:true`, `operationId` UUID of the active stop job. Escalates that stop; returns the same job ID. |
| `reinstall`, `wipe`, `delete` | `confirm:true`, optional `backupBefore` (default `false`). |
| `restore` | `confirm:true`, `backupId` UUID, optional `truncate` (default `true`). |
| `configure` | Complete `limits` object. Disk shrinking is rejected. |

Kill is a confirmed escalation of an active stop in its power phase, not a second
lifecycle job or an unrestricted force-stop endpoint. The browser offers it only
on a current `stopping` observation; the worker independently checks current
managed identity, requester permissions/session and provider state before using
Client API `POST /api/client/servers/{identifier}/power` with `{signal:"kill"}`.
The stop permission also covers Kill in Pterodactyl. Kill request keys are scoped
to the actor and exact parent stop operation. A safely rejected pre-effect request
can be replaced explicitly; prior keys do not revive it. The original stop keeps its
reservation and operation lock until physical stopped confirmation. A provider
acknowledgement alone never releases resources. Prepared/unknown force-stop
requests are never automatically replayed. No Kill escalation is offered for
unrelated start/install/restore work or a stop initiated only outside NickHosting.

Only one active lifecycle operation is allowed per server. Destructive/configure
operations require an offline server; the worker verifies remote state as well.
A requested pre-operation backup must complete successfully before destructive
work. Wipe explicitly deletes files; reinstall alone does not imply a clean
filesystem. Restore completion needs a correlated fresh provider activity result;
an HTTP acknowledgement or cleared installation status is insufficient evidence.

PostgreSQL owns jobs and phase/effect state; BullMQ delivers job IDs with
at-least-once semantics. The worker records intent before remote effects and
reconciles lost replies before deciding whether to repeat an operation. A stable
external ID supports provisioning recovery. Ambiguous start/restart, reinstall
and restore outcomes remain uncertain instead of being blindly replayed.
Uncertainty must retain compute reservations: a stop request, cached `offline`
sample or timeout is not proof that all delayed process starts have finished.
Runtime mapping admission validates supported egg stop configuration (a nonempty
command not beginning with `^`, or native Docker stop `^C`, case-insensitive).
The stop operation does not fetch or reinterpret the egg again: Wings executes
its configured stop semantics. Completion requires a fresh, ordered `stopping` → `offline`
transition from the authenticated backend WebSocket, an independent exact-container
Docker observation proving the process is no longer running, and no earlier
unresolved power effect. Wings can emit offline after a failed output stream while
the process still runs; the WebSocket transition alone cannot release capacity.
After that durable stop receipt, a fresh host-bound check of the exact container
can complete the stop without waiting for the provider's resource cache to expire.
Offline state, job completion and reservation release commit together. Running or
unverifiable container evidence retains the reservation; this path never
issues another power request. The conservative cached-resource path remains when
independent confirmation is unavailable.
Mapping admission continues to reject unsupported caret signal profiles. At
execution time, a signal or changed egg which leaves the process running cannot
confirm a stop or release its reservation; missing terminal evidence remains
uncertain. Restart completion requires a verified running Docker
process whose start
timestamp is after the durable effect intent, differs from the recorded prior
process when present, and is not in the future. Cached uptime may miss a fast
restart; the worker recovers from physical evidence without replaying power.
Missing or invalid physical evidence cannot fall back to cached telemetry. These
capability gates do not change egg or Wings configuration. Their actual
implementation and test status are recorded in the [validation report](M2-VALIDATION.md).

An interactive stop/kill performed directly in the provider can also be reconciled
without sending another power command. This requires the latest authenticated Panel
power activity to be an interactive stop/kill (no later or tied start/restart), plus
two matching fresh observations of the exact exited Docker process and managed
provider identity. An interrupted pending start/restart must additionally prove
that this process started after that operation's effect intent. The operation ends
as failed with an external-stop receipt, the server becomes manually stopped, and
capacity is released atomically. An already-online server uses the same corroborated
stop evidence; stale resource-cache samples cannot recreate its reservation.

This does not infer Owner intent from a crash, an absent container, a preboot state
or an API-origin power action. Missing activity permission, hidden/incomplete
history, ambiguous event ordering or changed process identity retain conservative
uncertainty. Existing external-start accounting does not revoke manual-stop
suppression. A new explicit NickHosting start is needed to resume automatic wake.

A stop requested for an already-offline server may complete without sending power
only when the backend verifies its current host/provider identity and exact
container is non-running, and rechecks that no compute or installation reservation
exists under the global resource lock. This records a no-effect completion and
releases no capacity. Repeated stops therefore remain usable without inventing a
transition; any held or uncertain reservation still requires the strict proof
above. Unavailable physical evidence leaves the operation pending and uncertain.

| Method/path | Result |
| --- | --- |
| GET `/v1/servers/:id/operations` | Latest 100 operations: ID, action, phase, effect state, job state, safe error code, attempts, timestamps and `messageKey`. No internal plan. |
| GET `/v1/servers/:id/events?after=0` | Up to 200 durable events after a numeric cursor. |
| GET `/v1/servers/:id/events/stream?after=0` | SSE `activity` events with IDs usable as the next `after` cursor. Rechecks authorization every poll; reconnect after the bounded stream duration. |
| GET `/v1/servers/:id/metrics` | Latest 500 stored observations; worker retains 30 days. |
| GET `/v1/servers/:id/resources` | Current adapter telemetry, subject to upstream sampling/cache behavior. |
| POST `/v1/owner/reconcile` | `{}` → observation/failure summary plus external-service recovery counts. Only registered servers are considered. |
| POST `/v1/owner/servers/:id/resolve` | `{jobId,confirm:true,reason}` acknowledges an eligible uncertain operation as failed, never successful. Requires at least 120 seconds since its effect began and verified remote identity/state. Power/initial-start uncertainty cannot be cleared through this endpoint. |

Owner resolution does not replay a remote effect or clear its reservation.
It records actor/reason and the unknown outcome. An ambiguous create without a
confirmed remote identity cannot be administratively treated as absent merely
because a lookup returns no result. `/v1/jobs/:id` retains its M1 scope; shared
project clients should use the authorized per-server operation view above.

## Console, files and backups

| Method/path | Contract |
| --- | --- |
| GET `/v1/servers/:id/console` | SSE relay of allowlisted console/daemon/status/stat events. Backend obtains and refreshes the privileged WebSocket token; authorization is rechecked during the stream. Requests bounded provider log replay on an empty console; `history=0` skips replay when retaining a browser buffer. Errors use a typed, sanitized SSE envelope. A bounded `heartbeat` every 10 seconds keeps an otherwise silent stream alive without polling the provider; it never replaces authorization checks. |
| POST `/v1/servers/:id/console` | `{command}` (1–4,096 characters) → `204`. Audit records the request, not raw command text. |
| GET `/v1/servers/:id/files?path=` | Directory listing under the server root. |
| GET `/v1/servers/:id/files/content?path=...` | Backend-streamed binary attachment; `Content-Disposition` provides the validated basename via an ASCII fallback and UTF-8 `filename*`. No fixed total byte limit; signed URL remains private. |
| PUT `/v1/servers/:id/files/upload?path=...` | Raw `application/octet-stream` body and exact `X-NH-Upload-Length` header; optional `overwrite=false` refuses an existing destination name during preflight (`409 file_exists`); default `true`. `204` only after a complete provider upload. |
| POST `/v1/servers/:id/files` | `write`: `{action,path,content}` (text ≤60,000 characters); `mkdir`: `{action,root,name}`; `rename`: `{action,root,files:[{from,to}]}`; `delete`: `{action,root,files:[name],confirm:true}`. Nonempty rename/delete selections are bounded by the 4 MiB request body, fully validated before dispatch and sent in sequential provider batches of up to 1,000 entries. No automatic replay after uncertain/partial failure. Returns `204` only after every batch succeeds. |
| GET `/v1/servers/:id/backups` | Provider backup metadata. Create and restore use durable lifecycle operations. |
| DELETE `/v1/servers/:id/backups/:backupId` | `{confirm:true}` → `204`. |
| GET `/v1/servers/:id/backups/:backupId/download` | Backend-streamed attachment with no fixed total byte limit; no signed provider URL is returned. |

Directory listing continues through the authenticated per-user Client API to
Wings. Directory/editor GET, binary upload PUT, streamed copy and ordinary file
mutations reuse a successful Application API identity verification:
an API-process cache holds at most 1,024 proofs, with a fixed 60-second lifetime.
A background renewal starts at 55 seconds; the old proof remains usable until
its original deadline while the replacement is checked. Expired proofs never
authorize access. A failed background request does not extend that deadline;
the next request after expiry retries verification, or waits for a renewal still
in progress. An unused renewed proof does not keep polling. Timers stop on API
shutdown. Directory requests release DB connections between queries; upload
admission reserves pool capacity for renewal while holding its write connection.

Every directory request still checks the current session, role, project access
and managed registry, and performs a fresh Client API listing. The proof is
bound to provider URL/Application credentials, server/owner/provider identity,
node and allocation claims, current provider-account/key revision, and local
Blueprint projection identity/revision. Changes invalidate reuse; an explicit
identity-invalidated event rejects access. Failures never fall back to stale
proofs. Without a received event or changed local binding, out-of-band provider
identity changes may take up to the 60-second lifetime to be detected. Client API
authorization remains authoritative on each request. No directory contents,
permission decisions or credentials are returned from this cache. Uploads retain
fresh session/manage authorization, lifecycle/pending-claim checks, server locks,
path validation and storage admission for each file. Editor GET reads reuse the
same identity proof with fresh local session/read authorization and no pinned DB
connection while waiting for renewal. File writes, directory creation, renames,
deletes and streamed copies retain exclusive lifecycle locking, pending-upload
fences and fresh local authorization, while reusing the same identity proof.
The shared admission gate reserves DB pool capacity for proof renewal. Other
service operations retain their existing identity policies. Editor reads request contents directly:
Wings enforces path containment at open time; no ancestor directory listing is
made. Missing files remain errors, and the editor byte/text limits still apply.

Paths are validated and scoped through the adapter. Minecraft's file-mutation
preflight reads each distinct ancestor directory once per guard invocation and
reuses that listing for all selected paths. Independent listings run with at most
four requests in flight. All reads settle before validation returns; validation
retains original path order, so an unsafe ancestor takes precedence over a
speculative descendant failure. Every path still receives the protected
runtime, case-ambiguity and symlink checks; observations are discarded afterward
and never used as confirmation of a mutation. For one bulk request selecting 49
files directly inside a top-level folder, guard listings fall from 98 to 2.
Delete remains one provider request
containing the selected names; no deletion is dispatched until preflight passes.
Copy and move share one fresh, request-local directory plan across selection,
ancestor/runtime protection and collision checks. Distinct directories are read
once through Blueprint batches of up to 48 (further split for a lower Owner
extension limit); only a missing extension endpoint (404/405) falls back to two
concurrent Client API reads. Authorization, transient and individual path errors
never trigger a fallback. The plan is bounded to 20,000 directories and 32 MiB
of retained metadata, with an 8 MiB response budget per batch. It contains no file
contents, signed URLs or browser-cached observations. Primed reads settle before
a failed operation releases its access context.

Copy validates the whole selection before effects instead of relisting each
source/destination at each stage. Wings opens the source and enforces filesystem
containment; a returned source content length that differs from the planned size
rejects the copy before upload. Upload streaming remains bounded. This preflight
is not an atomic no-clobber operation: direct Panel, SFTP or game writes after the
snapshot can race it. Successful earlier effects are not rolled back or replayed
on a later failure, and uncertain outcomes remain explicit.

For copy quota preflight, authenticated disk statistics from the existing console
relay may be reused for at most 30 seconds. The process-local cache holds at most
1,024 samples scoped to the managed identity and provider credential binding;
unknown/offline status cannot establish a zero-usage sample. Actual file/restore/
reinstall mutations invalidate observations before and after their effects, and
samples received during writes are ignored. Missing/stale observations fall back
to the existing resources API. There is no extra WebSocket or polling loop. Wings
still enforces its quota, and NickHosting retains physical upload/staging capacity
reservations independently of this observation.

Native Wings 1.11.13 copy accepts only a source location, duplicates one regular
file in the same directory with a generated suffix, and returns no chosen name.
It cannot implement arbitrary-folder paste, recursive copy or explicit overwrite
consent. The existing backend-streamed relay remains for these operations; no
file contents pass through the browser during copy. See the verified
[Wings copy implementation](https://github.com/pterodactyl/wings/blob/v1.11.13/server/filesystem/filesystem.go)
and [Panel adapter](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Repositories/Wings/DaemonFileRepository.php).

File/command/backup-delete mutations share the lifecycle server lock and reject
an active lifecycle job.
Background reconciliation collects provider/host observations without holding
that lock. Only its brief database apply takes the lock, rejecting superseded
observations before any state/metric/reservation update. Collection does not
extend the previous observation's validity. Reconciliation waiting on resource
admission does not monopolize the server lock.
Initial server-lock contention returns `409 operation_busy` before the callback or
any provider effect, instead of waiting with a database connection. A shared
per-pool upload gate leaves connections available for authentication, authorization
refresh and logout; a one-connection pool cannot accept uploads. Saturated upload
slots also return `409 operation_busy` before dispatch. This explicit code is proof
that this attempt did not start an effect; generic `conflict`, lifecycle conflicts,
existing ingestion claims and unknown provider outcomes do not carry that proof.
The browser upload queue alone retries `operation_busy` with a bounded backoff;
there is no second retry/wait layer in the API.
Provider failures stay failures; no synthetic success response is produced.
The JSON text-edit action remains bounded; binary transfers use the separate raw
upload endpoint. `path` is a relative server path, with traversal, control
characters, separators/encoding tricks and root escapes rejected. The browser
must supply the exact file size in `X-NH-Upload-Length` (browsers cannot manually
set `Content-Length`); if `Content-Length` is present it must match. Zero-byte
files are supported. The API validates the server's configured disk allowance
and observed usage, accounting for an existing regular file when overwriting.
Native provider filesystem quotas remain authoritative against concurrent game
writes. Uploading onto a directory or symlink is refused.

The legacy non-batch upload preflight shares request-local directory observations between the game
guard and destination checks; it does not list the destination twice. Resource
usage is read concurrently with independent path checks. All started branches
settle before the server lock/database connection can be released on failure.
The optional `overwrite` query accepts only `true` or `false`; `false` rejects
case-insensitive name collisions before obtaining an upload URL or creating an
ingestion claim. Folder uploads use this server-side preflight instead of a
separate browser listing before each file. This is not an atomic no-clobber
filesystem operation: concurrent game/SFTP/provider writes can still race it.
Existing locking, storage admission and uncertain-outcome recovery are unchanged.

The WebPanel uses the [M5 prepared upload group contract](M5-API-CONTRACTS.md#transfer-network-telemetry-and-sleep-descriptors):
`POST /v1/servers/:id/files/upload-batches`, independent binary PUTs with
`batchId`/`entryId`, per-entry cancellation and group close. Common path/quota
preflight runs once for the bounded group; external filesystem changes may race
that observation. Per-file authorization and durable admission still apply.
`uploadConcurrency` defaults to 2 (Owner setting or `NH_UPLOAD_CONCURRENCY`, 1–6).
Group entries hold shared lifecycle and ingestion locks; generic writes keep
exclusive locks. The existing single host claim stores the group ledger and full
conservative reservation, with multipart overhead for every concurrent slot.
Uncertain entries retain space and a slot; already-admitted siblings may continue
in remaining slots. Other groups remain excluded until the claim is resolved.
There is no database migration or provider configuration change. Legacy single
uploads below retain their original behavior.

Uploads stream one generated multipart `files` part to the private Wings signed
upload URL; the body is never accumulated in `FormData` or a full-file buffer.
The server write lock remains held until completion/failure; actual bytes must
exactly match the declaration. A failed/aborted upload can leave a partial
provider file and is never reported as success or blindly deleted as rollback.
The installed Wings upload limit remains a provider policy. Read-only inspection
found **500 MiB per file** on the current installation. Wings checks this after
multipart parsing, so its native rejection alone does not protect temporary disk.
NickHosting must reject an upload above the configured provider bound before
fetching a signed URL or reading its body. Increasing that bound requires verified
provider support; this PR does not change or bypass Wings configuration.

Uploads also require a per-physical-host `uploadPolicy`, initially `null`:
`{providerMaxFileBytes,temporaryDiskPath,temporaryDiskBudgetBytes,
temporaryDiskHeadroomBytes}`. All byte values are safe integers. The Owner must
verify the provider bound against every Wings node on that physical host and
identify the actual disk-backed multipart staging filesystem; it is not inferred
from the server-data path. The API's `NH_OBSERVER_ID` must match that host's
observer. `NH_UPLOAD_POLICIES` maps host UUIDs to policies or `null` and overrides
stored settings. `NH_HOST_POLICIES` rejects nested `uploadPolicy`; the dedicated
override is the only environment upload-policy input. A container deployment may require a separately approved
read-only observation mount; merely storing a path is not proof of the correct
filesystem.

Migration 008 adds one durable upload-ingestion claim per physical host. Admission
checks fresh space on both the staging and server-data filesystems and reserves
twice the declared payload plus 65,536 bytes for bounded multipart framing, with
no overwrite credit. The multipart tempfile can coexist with the destination
copy. The temporary budget and both free-space observations minus headroom must
cover this conservative peak; destination headroom is at least the host disk
headroom. Known RAM-backed staging/data filesystems are rejected. Sibling
nodes share the host claim. Provider success after complete transfer releases it.
The direct upload route also releases its exact claim when the adapter proves the
Wings POST was never invoked (including cancellation during signed-URL lookup),
auditing `server.upload.not_dispatched` rather than success. The proof is internal
to the adapter, not inferred from HTTP status or browser cancellation. Once POST
is invoked, abort, timeout, crash or uncertain completion retains the claim without
a timer-based expiry. Further uploads on that host and mutations of the affected server fail
closed. Existing game/provider writes can still consume space concurrently;
the Owner's staging budget and headroom must account for these workloads.

Only the regular Owner can inspect `/v1/owner/uploads` and POST
`/v1/owner/uploads/:claimId/recover` with
`{confirm:true,remoteTransferFinished:true,temporaryFilesRemoved:true,scopeHash,
reason,evidence}`. The current claim hash must match. Recovery rejects a claim
held by an active upload and records the reason and external verification
evidence; it never removes provider files. Confirm actual provider completion and
temporary-file cleanup before using it. Host/policy identity changes cannot
silently retarget outstanding claims, and recovery does not declare an upload
successful.

File and backup downloads stream with backpressure, no 1 MiB/1 GiB cutoff and no
fixed total transfer deadline. Active transfers require progress within a 30-second
idle window; session/role/project/support authorization is refreshed at least once
per second, including while idle. Cancellation, revoked access, malformed sizes,
truncated responses or provider failures abort the stream. Buffers are bounded
independently of file size. Downloads do not hold a database connection for their
whole lifetime. API errors expose no raw provider body, privileged credentials or
signed URL. Upload destinations require the separate exact
`pterodactylUploadOrigins` allowlist, and redirects are refused. Console output
is streamed with bounded buffering, not persisted in ordinary audit records.

The executable Node listener removes the total request-body deadline only for the
canonical binary upload route. Ordinary request bodies retain a 300-second total
deadline, headers a 60-second deadline and sockets a 30-second inactivity timeout.
An early response closes an unread request body. Reverse-proxy limits remain
separate deployment settings and are not changed by the application.

## Owner infrastructure and resource configuration

| Method/path | Contract |
| --- | --- |
| GET `/v1/owner/infrastructure` | Read-only node/nest discovery and adapter capabilities. |
| GET `/v1/owner/nests/:id/eggs` | Eggs for a numeric provider nest ID. |
| GET `/v1/owner/nodes/:id/allocations` | Allocation inventory for a numeric provider node ID. |
| GET/PUT `/v1/owner/resource-hosts` | Stored/effective host policy and upload policy with environment locks, or validated host policy save. |
| GET `/v1/owner/uploads` | Outstanding durable upload claims with pinned scope/hash; regular Owner only. |
| POST `/v1/owner/uploads/:claimId/recover` | Audited release after externally verified completion/cleanup; cannot release an active transfer. |
| GET/PUT `/v1/owner/nodes` | Managed node mappings, or `{id?,physicalHostId,pterodactylNodeId,provisionUserId,installerMemoryMiB?,installerCpuPercent?,memoryOverheadPercent?,backendAllocationPool?,enabled?}`. |
| GET/PUT `/v1/owner/runtime-mappings` | Owner runtime mappings, or mapping request described below. |
| PUT `/v1/owner/user-limits` | `{userId,memoryMiB,cpuPercent,storageMiB,expiresAt?,reason}`; explicit audited limits, optional future expiry. Returns `204`. |

Allocation discovery uses one complete, bounded provider response rather than
combining unordered OFFSET pages. Installed Panel 1.x allocation pagination has
no guaranteed ordering: a multi-page read was observed to duplicate allocations
and omit others even when its row count matched the reported total. The adapter
requires consistent total/count/page metadata and unique allocation IDs, including
assigned allocations. It rejects truncated inventories, missing metadata, more
than 10,000 allocations per node, or responses over the existing 4 MiB transport
limit with `integration_unavailable`; it never deduplicates and accepts a partial
inventory. This applies to Owner discovery, provisioning and Gateway collision
checks alike. Nodes exceeding this explicit safety bound need an independently
verified complete-inventory strategy before use; no provider configuration is
changed by discovery.

`PUT /v1/owner/nodes` accepts at most 4 MiB of JSON so an explicit pool of thousands
of pins can be saved. The regular Owner/session and Origin checks, per-pin identity
validation and retained-claim protections still apply. Other ordinary JSON routes
retain their 64 KiB limit; this is not a general request-size increase.

Host policy fields are `{id?,name,memoryLimitMiB,cpuLimitPercent,storagePoolMiB,
memoryHeadroomMiB,cpuHeadroomPercent,diskHeadroomMiB,localDiskPath,observerId,
uploadPolicy?,enabled?}`. RAM/disk headroom must each be at least 256 MiB and less than their
policy capacity; these validation minimums are not recommended production sizes.
`localDiskPath` must be an absolute path on the filesystem whose capacity is being
admitted. Provisioning users/nodes must exist in discovered provider metadata.
Saving these mappings changes NickHosting data, not Panel node capacities.

`memoryOverheadPercent` defaults to 115 (range 100–400). It is an Owner-verified
upper bound for Wings memory overhead; custom Wings tiers require a matching
bound. `NH_NODE_MEMORY_OVERHEAD_PERCENT` explicitly overrides every stored node
bound. User quotas count requested memory; physical reservations round up
`requested × bound / 100` MiB, separately for game and installer containers.
Existing physical commitments never shrink merely because an override decreases.
Node overhead changes with outstanding reservations are refused. Owner node reads
include `effectiveMemoryOverheadPercent` and `memoryOverheadLocked`; an environment
override refuses conflicting Owner overhead edits while allowing unrelated node
fields to be changed.

Provisioning requires an explicitly configured `backendAllocationPool` on the
managed node. Its shape is `{allocations:[{allocationId,address,backendAddress?,port,delivery?,directEndpoint?}],
gatewayBindAddresses:[address,...],loopbackRemap?}`. There is **no inferred/default
pool**. `address` identifies the exact canonical Pterodactyl allocation IP;
`backendAddress` identifies the effective Wings/Docker binding for future Gateway
routing. Direct private RFC1918 IPv4 and IPv6 ULA pins default `backendAddress` to
`address`; an explicit value must equal it. Public, wildcard, mapped and scoped
backend addresses are rejected. Aliases do not establish binding identity.

Exact `127.0.0.1` is supported only with an explicit private IPv4 `backendAddress`
equal to `loopbackRemap.interfaceAddress`. This models Wings 1.11.13 replacing
that allocation IP with its configured Docker network interface, preserving the
port. It does **not** route the Gateway to its own loopback address. The required
declaration is:

```text
loopbackRemap: {
  wingsVersion: '1.11.13',
  networkMode: <verified Docker network name>,
  networkDriver: 'bridge',
  gatewayMode: 'nat',
  interfaceAddress: <verified private IPv4 Wings interface>,
  ispn: false,
  verifiedEggs: [{nestId, eggId, forceOutgoingIp: false}]
}
```

The Owner must verify the actual network driver/NAT behavior, configured Wings
interface and selected egg's `force_outgoing_ip=false` before declaring them.
The Application API does not expose that egg flag, so `verifiedEggs` is an Owner
attestation, not an automatically discovered fact. The configured interface is
not inferred from the Docker IPAM gateway. Host/container/shared, overlay/ISPN,
routed and unknown network configurations, other `127/8` addresses and `::1`
are unsupported for remapping. An unattested egg cannot use a loopback pin;
an eligible direct private pin in a mixed pool remains usable.

IDs, provider addresses and ports are checked against fresh inventory on the
selected provider node, both at reservation and before new remote creation.
Assigned inventory collisions are checked after effective binding translation;
unknown same-port loopback semantics fail closed. Gateway declarations must be
exact, non-wildcard and disjoint from effective **Gateway backend** bindings.
Explicit `delivery:'direct'` pins with a `directEndpoint:{hostname,port}` may share
a Gateway ingress IP on different ports. This allows one provider node to serve
both delivery modes; an IP alone does not reserve every port. Backend-only pins
still require a different IP, and existing claims retain their immutable connection
mode. On the same physical host, pool edits and route registration reject actual
overlapping address/port endpoints, including sibling nodes, environment overrides,
disabled routes/pools and retained allocation claims. Public route ports need not
equal backend ports, so collision checks use the actual registered public port.
Existing routes can still be disabled after a conflicting environment override;
creating or enabling a conflicting route remains blocked. Wings publishes both
TCP and UDP for each allocation, so a different SDK transport is not collision
protection. Migration 009 stores provider `address` and `backend_address`
separately, backfills existing direct claims and prevents identity retargeting.
Later provider identity checks compare its raw IP, port and assigned state to
the provider claim, never to the remapped address.

These declarations neither bind listeners nor create/change allocations, and
do not prove reachability from the future Gateway container. M3 must verify that
reachability and actual Docker bindings, and validate its public endpoints against
all existing direct Pterodactyl allocations and host listeners before binding;
see [ADR 0005](decisions/0005-permanent-gateway.md).

`NH_BACKEND_ALLOCATION_POOLS` is an optional JSON object keyed by managed-node
UUID; each value is the complete pool or `null` to disable new provisioning.
It overrides stored Owner pools. Node reads include `effectiveBackendAllocationPool`
and `backendAllocationPoolLocked`; conflicting Owner edits of environment-locked
pools are refused. A pool edit cannot silently retarget/remove existing claims.
Unconfigured, exhausted, reassigned or drifted pins fail closed at enqueue and
again before new provider creation. Recovery of an already-created, proven owned
server remains possible if the pool was subsequently disabled. Existing public
Pterodactyl allocations are never used as a fallback. Approving a pool is a
NickHosting configuration operation; any necessary real allocation/network changes
still require separate, exact Owner approval.

Runtime mappings require `{id?,gameId,runtimeId,nodeId,nestId,eggId,dockerImage,
startup,environment,portRoles,featureLimits,enabled?}`. `nodeId` is a NickHosting
managed-node UUID; numeric provider nest/egg IDs are selected through discovery.
Images must be declared by the actual egg. Do not place privileged provider
credentials in the ordinary game `environment` map. A used mapping cannot have
its identity/build/port contract silently retargeted; it can be disabled for new
creation. The supported stop capability above must be validated when enabling a
runtime; unsupported stop profiles must not silently weaken reservation safety.

Each `portRoles` entry is `{role,protocols:['tcp'|'udp',...],primary,
environmentVariable?}`. Exactly one is primary. Roles and optional environment
variable names must be unique and satisfy required SDK ports/transports.
`environmentVariable` receives that role's actual allocated port in the provision
environment, overriding a fixed mapped value. `featureLimits` is
`{databases:0,allocations,backups}`; allocation allowance must cover every role.
Claims remain assigned offline, with physical-host address/port and wildcard
collision checks. No gateway listener or host port binding is created by M2.

Admission uses a PostgreSQL lock for shared user/physical-host budgets. Stopped
servers have no active compute charge; starting, running, restarting, stopping
and uncertain reservations retain their full configured limits until eligible
release. A fresh host observation includes unrelated running servers, operating
system and other services. New starts conservatively charge full commitments
alongside measured use. A restart retaining the same reservation has zero new
RAM/CPU demand and does not re-charge existing commitments against sampled free
capacity. It still requires fresh host evidence, safety headroom, valid ownership,
user budgets and aggregate physical hard ceilings. Growth charges only the positive
resource delta plus other commitments when its prior commitment predates the host
sample; otherwise it conservatively charges the proposed full commitment to avoid
spending one stale sample repeatedly. RAM and CPU are evaluated independently;
reservations never shrink during restart. Cached provider telemetry creates no
capacity credits. CPU percentages are limits, not reserved dedicated cores.

There is no default total server-count limit. An Owner can opt into a numeric
`maxServersPerUser`; setting it to `null` disables it. Persistent storage, backend
allocation availability, invite-only access, idempotency and the separately
configurable pending-provision limit still apply. Completed offline servers do
not consume that pending limit; uncertain provisioning remains counted until its
outcome is safely resolved. Checks are atomic with server creation.

Persistent allowance is `disk MiB × (1 + permitted backup slots)` per undeleted
server, including stopped servers. Admission checks the Owner pool and actual
filesystem free space minus headroom. `GLOBAL_POOL` is the default;
`PER_USER_BUDGET` additionally enforces the owner's user allowance. Disk shrink
and policy reductions below existing reservations are rejected. These allowances
do not claim instantaneous shared-filesystem enforcement against external writers.
Administrative overrides change audited user limits; they do not bypass physical
capacity or mutate unrelated Pterodactyl servers.

## External services

| Method/path | Contract |
| --- | --- |
| GET `/v1/servers/:id/sftp` | Credential metadata only. |
| POST `/v1/servers/:id/sftp` | `{credentialId}` UUID idempotency key → `201`, new password returned once. |
| POST `/v1/servers/:id/sftp/:credentialId/rotate` | `{rotationId}` UUID idempotency key; replacement password returned once. |
| DELETE `/v1/servers/:id/sftp/:credentialId` | `{}`; disable/delete the proven provider account without deleting server files. |
| GET `/v1/servers/:id/dns` | Public assignment metadata and connection plans. |
| POST `/v1/servers/:id/dns/preview` | `{subdomain?,portRole?}`; pure connection/record planning, no DNS write. |
| POST `/v1/servers/:id/dns` | `{assignmentId,subdomain?,portRole?}`; UUID idempotency key. |
| PUT `/v1/servers/:id/dns/:assignmentId` | `{subdomain?,portRole?}`; reconcile an active owned assignment. |
| DELETE `/v1/servers/:id/dns/:assignmentId` | `{confirm:true}`; remove only proven owned records. |

SFTP intent/password is encrypted before provider calls. A lost one-time password
response requires a new rotation, not secret readback. A server may have up to
eight non-revoked credentials. Provider identity, ownership metadata and directory
mapping are checked; a username prefix is insufficient. Expiry and removed issuer
permission trigger bounded worker revocation. Credentials map only to the
configured data root plus the verified external server UUID. Real Wings mounts
remain a separate operation-specific approval.

**Temporary M2 exception — SFTPGo 2.7.6:** disabling/deleting or rotating a user
rejects new SSH logins and closes existing SFTP channels, but an already
authenticated SSH transport can open another channel and retain access. Explicit
connection deletion has the same limitation. Immediate revocation of those
transports is waived only for M2; it must be revisited before production release.
There is no SSH proxy, fork or compensating workaround. The three retained strict
regressions are **known expected failures**, never evidence that full revocation
passes. Setup, new-login rejection, expiry/rotation behavior and directory
isolation remain ordinary requirements. See the
[external-services test contract](../packages/external-services/README.md) for
the command that exposes the three strict failures directly.

DNS uses the SDK connection mode and a declared allocated port role. Static
hostname plus port generates no DNS records. Custom subdomains plan unproxied
A/AAAA/CNAME and optional SRV records, with ownership markers and a durable remote
ID ledger. Existing unrelated records are conflicts, never adopted or deleted.
Provider configuration changes invalidate old scopes instead of redirecting old
intents. M2 tests mock Cloudflare writes; the implementation of a write endpoint
does not authorize real DNS changes.

## Runtime settings and deployment prerequisites

Compiled defaults resolve below Owner database settings, below explicit
environment values. Environment-locked settings reject conflicting Owner writes.
Optional integrations remain unconfigured until their feature is requested.
The [environment example](../.env.example) lists only placeholders and commented
optional overrides; do not seed its example values into PostgreSQL.

| Setting | Environment override | Default |
| --- | --- | --- |
| `storagePolicy` | `NH_STORAGE_POLICY` | `GLOBAL_POOL` |
| `defaultUserMemoryMiB` | `NH_DEFAULT_USER_MEMORY_MIB` | `16384` |
| `defaultUserCpuPercent` | `NH_DEFAULT_USER_CPU_PERCENT` | `400` |
| `defaultUserStorageMiB` | `NH_DEFAULT_USER_STORAGE_MIB` | `32768` |
| `maxServersPerUser` | `NH_MAX_SERVERS_PER_USER` | `null` (no total-count cap); positive integer enables it, literal `null` overrides a stored cap |
| `maxConcurrentProvisionsPerUser` | `NH_MAX_CONCURRENT_PROVISIONS_PER_USER` | `4`; limits pending provisioning only, range 1–100 |
| `observationMaxAgeSeconds` | `NH_OBSERVATION_MAX_AGE_SECONDS` | `4`; admission caps effective age at `4` seconds (smaller configured values still apply) |
| `pterodactylWebSocketOrigins` | `NH_PTERODACTYL_WEBSOCKET_ORIGINS` | `[]`, JSON array of exact `ws`/`wss` origins |
| `pterodactylDownloadOrigins` | `NH_PTERODACTYL_DOWNLOAD_ORIGINS` | `[]`, JSON array of exact HTTP(S) origins |
| `uploadConcurrency` | `NH_UPLOAD_CONCURRENCY` | `2`, integer 1–6; bounded concurrent entries in a prepared upload group |
| `pterodactylUploadOrigins` | `NH_PTERODACTYL_UPLOAD_ORIGINS` | `[]`, separate exact HTTP(S) Wings upload origins |
| `sftpgoBaseUrl`, `sftpgoDataRoot`, `sftpgoInstanceId` | `NH_SFTPGO_BASE_URL`, `NH_SFTPGO_DATA_ROOT`, `NH_SFTPGO_INSTANCE_ID` | Unset; absolute provider-visible root, instance UUID |
| `sftpCredentialTtlSeconds` | `NH_SFTP_CREDENTIAL_TTL_SECONDS` | `3600`, range 60–86400 |
| `cloudflareZoneId`, `dnsInstanceId` | `NH_CLOUDFLARE_ZONE_ID`, `NH_DNS_INSTANCE_ID` | Unset; provider zone and stable instance UUID |
| `dnsBaseDomain`, `dnsTarget`, `staticGameHostname` | `NH_DNS_BASE_DOMAIN`, `NH_DNS_TARGET`, `NH_STATIC_GAME_HOSTNAME` | Unset; values selected through plugin connection settings |

Origins contain scheme/host/optional port only, without paths, credentials,
query, fragment or trailing slash. Empty allowlists do not authorize arbitrary
Wings or backup destinations. Application and Client Pterodactyl keys remain
separate; M2 management runtime requires both. SFTPGo and Cloudflare secrets are
`sftpgoApiKey` / `cloudflareApiToken` in the encrypted secret store, or explicit
`NH_SFTPGO_API_KEY` / `NH_CLOUDFLARE_API_TOKEN` overrides. Owner settings expose
presence/source only. Missing provider permissions must be fixed by an explicit
Owner decision, not automatic privilege escalation.

`NH_OBSERVER_ID` is an environment-only identity matching the configured host
policy. Only that observer samples local Linux memory, CPU and the configured
filesystem. An API/worker running elsewhere must not pretend its own host is the
game node. A container deployment needs an approved, accurate observation design;
M2 does not silently add host mounts or services. Missing, stale, future-dated or
mismatched observations fail admission closed.

Lifecycle execution also requires `dockerObserverSocket` (or
`NH_DOCKER_OBSERVER_SOCKET`), an explicit absolute Unix socket path on that same
physical game host. The backend invokes only bounded, read-only Docker CLI
`info`, exact-name `container ls` and filtered `container inspect` commands. It
checks the exact UUID (or UUID installer), container ID, Pterodactyl labels and
process state; Docker errors never count as absence. This independent check
corroborates terminal provider events and does not prove an unknown pending
operation cannot start later. A worker for a different host refuses the effect.
The user-local development process uses its already authorized Docker access; no
socket mount, Docker permission change or deployment has been applied. Approving
a future deployment must explicitly address socket access: the socket itself is
privileged even though these application commands are read-only.

`NH_HOST_POLICIES` is an optional JSON object keyed by existing physical-host
UUID. Each value uses the complete host-policy input shape above; it overrides
the policy fields and locks that host's Owner writes. It does not create hosts,
nodes or mappings. An empty `{}` applies no overrides.

The worker polls the PostgreSQL outbox through BullMQ and periodically reconciles
registered servers, external intents and expired credentials. No application
deployment, automatic game import, real DNS mutation, host networking or live
Wings volume mapping is implied by running local tests. Preserve PostgreSQL,
ignored provenance ledgers and encryption keys during recovery; dropping Redis
delivery state is not equivalent to cancelling a business operation.

Temporary delivery deferrals (for example a busy per-server advisory lock) re-arm
the existing PostgreSQL outbox entry after 500 ms, respecting the job's later
`next_attempt_at` and an already earlier valid dispatch deadline. This is distinct
from the unchanged 30-second lost-delivery recovery fallback. A consumer first
locks the outbox row by job ID, waiting for a concurrent publication to commit,
then checks the exact delivery generation; stale deliveries cannot reschedule a
new generation or recreate a removed outbox row. Terminal jobs are not rearmed.
Server operations that no longer own their server's active-operation slot or whose
server is deleted return internal `inactive`, rather than requesting prompt retries.
No job attempt, permission, provider effect or reservation is replayed by rearming;
the regular processor retains all authorization, locks and idempotency checks.
Worker delivery logs include processor/rearm `durationMs` and, on deferral,
`deferredRetryScheduled`. This duration is not pure queue latency. Polling and
external checks still add elapsed time; 500 ms is a retry delay, not an end-to-end
latency guarantee.

## Installer admission and completion

Managed node configuration accepts `installerMemoryMiB` and `installerCpuPercent`
(defaults 1024 MiB / 100%). The Owner must match the real Wings installer floors;
these fields do not change Wings. The worker atomically reserves the maximum of
those floors and the requested server limits, adjusted by the effective node
memory-overhead bound, at the physical-host level before
creation or reinstall. Installer reservations share host capacity with running
servers, but never count against the user's active-game budget. Reservations
survive unknown remote outcomes and missed completion evidence.

The generic installation confirmation path requires a fresh backend `install completed`
notification followed by successful current Panel installation state on the same
connection, plus independent observation that the exact installer container has
terminated. The notification occurs on failure too, and a daemon reset can clear
Panel status; neither signal alone is sufficient. A disconnected/missed event is
an uncertain result, not permission to repeat the remote installation.

**M5 initial-install recovery amendment:** a trusted game module may instead verify
the required outputs of the original provisioning operation. This is a separate
`required_outputs_verified` receipt, not a claim that a missed completion event was
observed. The initial Vanilla implementation verifies the resolved server artifact's
size and hashes, immutable runtime/egg/launch binding and observed runtime image.
The lifecycle also checks the original creation effect and managed identity, current
successful provider state, an offline game process, proof that the exact installer
is no longer running,
and authorization before and after verification. Only then can it release the
installation reservation and continue the existing game-configuration workflow.
Reinstall and wipe cannot use this recovery: old valid files cannot prove a new
installation succeeded. Unsupported modules retain the generic confirmation path.
Game readiness remains a separate requirement; successful output verification does
not prove the game has started or that Gateway traffic is ready.
