# M3 Gateway and sleep/wake contracts

M3 provides reusable backend contracts and synthetic protocol fixtures. Minecraft,
Satisfactory and their protocol compatibility belong to M4/M6. See
[Gateway design](GAME-GATEWAY.md), [ADR 0012](decisions/0012-gateway-leases-and-sleep.md)
and [validation](M3-VALIDATION.md). M1 identity and M2 lifecycle/admission remain
authoritative; no new user identity, provider key or resource scheduler is introduced.

## Interactive Core APIs

Normal Better Auth sessions, existing resource authorization and mutation-origin
checks apply. Temporary support sessions cannot configure lasting automation or
Gateway routes. Sessions and roles are refreshed after database lock waits.

| Method and path | Contract |
|---|---|
| `GET /v1/owner/gateway/routes` | Regular Owner; explicit registered route metadata only. |
| `PUT /v1/owner/gateway/routes` | Regular Owner; `{id?,serverId,allocationId,publicAddress,publicPort,transport,enabled?}`. A new route requires an installed managed server, its stable claim, allowed transport, configured physical host and Owner pool's declared public address. Existing identity is immutable; use `id` to enable/disable. Active operations prevent changes. |
| `GET /v1/servers/:id/gateway` | Existing `server:read` authorization; current state, consent generation, job IDs, process/readiness timestamps, message key and optional measured startup estimate. |
| `PUT /v1/servers/:id/gateway` | Regular session with `server:manage`; policy below. Operational changes create a new consent generation; timeout-only edits preserve it. All edits are audited and enforce the Owner's user-control policy. |

Policy fields: `enabled`, `protocolId`, `gameVersion`, optional `idleTimeoutSeconds`
(nullable, disabling automatic sleep for an explicit server override), optional
`idleTimeoutInherited` (inherit game/runtime defaults rather than use the server
value), Owner-only optional `idleTimeoutUserAccess` (null to inherit),
`readinessTimeoutSeconds` (1–86400),
`readinessMaxAgeSeconds` (1–300), `estimateMaxAgeSeconds` (60–2592000),
`wakeRetrySeconds` (1–300), and optional `mode` (`auto`, `maintenance`,
`manually_stopped`). Changing policy does not start a server. The existing M2
manual stop immediately revokes automatic-wake consent, even when another
operation prevents enqueueing a stop. An explicit manual start can rearm manual
suppression; maintenance requires an explicit policy change.

Owner timeout resolution is **server override → runtime override → game override →
global default**. Global `defaultIdleTimeoutSeconds` defaults to -1. Global/game/runtime
settings use seconds (`-1` disables, positive values up to 604800); absent runtime
overrides and a null game value inherit. The server policy retains legacy nullable
disabled representation; the WebPanel translates a -1 minute input into that value.
UI inputs are minutes with an explicit inheritance choice. Disabling idle sleep
does not disable Gateway forwarding or intentional-join wake. Migration 020 adds
the inheritance flag; 021 separates Owner baselines/access from user preferences,
preserving old explicit timeouts (including disabled) as Owner policy. Newly
initialized policies inherit while leaving wake disabled and manual-stop protection
intact.

`idleTimeoutUserAccess` defaults to `hidden`; game `userAccess`, runtime
`runtimeUserAccess`, and Owner per-server `idleTimeoutUserAccess` can override it.
Modes are `hidden`, `editable`, `shorten-only`. User preferences are separate from
the Owner baseline. Hidden ignores user preferences and refuses their edits.
Shorten-only refuses a higher timeout or disabled preference against a finite Owner
baseline, and clamps a formerly valid preference when the Owner later tightens it.
With an Owner-disabled baseline, a finite user timeout is earlier and allowed.
Limited users cannot bypass a finite Owner timeout by changing operational fields
through the policy endpoint. Existing explicit manual-stop/maintenance and automatic
start consent remain independent safety controls, not forced always-on behavior.

Regular Owners read/write a game's defaults with
`GET/PUT /v1/owner/integrations/:gameId/sleep-policy`. Writes contain
`{gameTimeoutSeconds, runtimeTimeouts, userAccess?, runtimeUserAccess?}`; runtime keys must belong to the trusted
integration. These settings are stored separately from compiled manifests and
rollout configuration. `gameIdleTimeouts` follows normal defaults → Owner settings
→ `NH_GAME_IDLE_TIMEOUTS` precedence; environment overrides lock Owner edits. Global
values use existing Owner settings GET/PATCH and `NH_DEFAULT_IDLE_TIMEOUT_SECONDS`
and `NH_IDLE_TIMEOUT_USER_ACCESS` overrides.
Per-server `/v1/platform/servers/:id/sleep-policy` also returns `idleTimeout` with
`overrideSeconds` (null means inherit; -1 means disabled), `effectiveSeconds`,
`source` (`server`, `runtime`, `game`, `default` for global) and `inheritedSeconds`.
Owner reads include the Owner baseline/access override separately; ordinary reads
show only the permitted preference. Hidden ordinary reads return `idleTimeout:null`
and omit timeout configuration fields from the returned policy/proposal.
`policyControlsEditable` separately governs operational controls so hiding a timer
does not accidentally disable wake when the Owner timeout is disabled. Operational
state and upcoming sleep deadlines remain truthful; hiding a setting is not a claim
that its effect is secret.

Timeout-only changes preserve generation, readiness and in-flight wake jobs. User
saves do not reset idle time; repeatedly saving cannot postpone an Owner limit.

Resolved timeouts govern both Gateway sleep eligibility and the final idle
observation. Queued automatic stops revalidate current policy before external
effects, so disabling sleep or raising its timeout cannot silently execute an old
stop. Fresh zero-player observations, quiescence, authorization, manual suppression
and resource/identity fences still apply; missing player counts never mean zero.

State is `sleeping`, `waking`, `online`, `blocked`, `maintenance` or
`manually_stopped`. `online` requires fresh game-protocol readiness correlated
with the exact running Docker process, not just a Panel running status. State
includes `sleepEligibleAt` only when an enabled idle window is progressing.
English/Italian `gateway.states.*` message keys are provided.

## Dedicated service authentication

`/internal/gateway/:gatewayId/*` requires the exact configured Gateway UUID and
`Authorization: Bearer <gatewayControlToken>`. Generate an independent base64url
secret of at least 32 random bytes; browser cookies and support tokens do not
substitute for it. The token may be stored in the protected M1 secret store or
`NH_GATEWAY_CONTROL_TOKEN`; the Gateway bootstrap receives it through its own
protected environment. It grants only the routes below, never interactive Owner
APIs. Rotate it by updating Core and the protected service environment.

The client requires HTTPS except for numeric loopback HTTP, refuses redirects,
and bounds request time and response size. Core's ordinary JSON body limit and
structured errors apply. No Pterodactyl Application/Client key enters the Gateway
or browsers. A compromised Gateway token still grants sensitive network metadata
and managed wake authority; keep its service and configuration protected.

| Method and suffix | Response / behavior |
|---|---|
| `GET configuration` | Resolved `gateway*` settings only; no secrets. |
| `GET snapshot` | Complete leased route snapshot with durable content revisions. |
| `POST wake` | `{routeId,routeRevision,requestId}`; fresh managed route, current consent and M2 atomic admission. Returns mode, optional operation UUID and error message key. |
| `POST observations` | Complete per-server role evidence below; Core independently corroborates process identity and rechecks membership under the resource lock. |
| `POST context` | `{routeId,routeRevision?}`; narrow managed provider/node/allocation identity for safety validation. |
| `POST inventory` | `{operation:'nodes'}`, `{operation:'allocations',nodeId}` or `{operation:'server',routeId}`. Complete allocation inventory includes direct servers; server detail is restricted to verified managed identity. Responses strip names, startup/environment, aliases and secrets. |
| `POST proof-read` | `{routeId,routeRevision?}`; persisted exact topology/reachability proof or null. |
| `POST proof-write` | `{routeId,routeRevision,proof}`; exact route/server/allocation identity and a recent proof. |

`context`, `proof-read` and `proof-write` return HTTP 412 with the ordinary
`conflict` error only when an explicitly supplied route revision has changed.
The authenticated Gateway retries this precondition failure once, fetching a new
snapshot and repeating all topology, ownership and reachability checks. No stale
candidate may open a listener or extend a committed or observation lease. Existing
connections retain only their original lease during that bounded retry; route
revocation, actual safety failures and lease expiry still close them. Other errors,
including ordinary HTTP 409 conflicts, do not receive this special handling.

Equivalent lease renewals do not discard an in-flight readiness/idle probe when
Gateway identity, revision and complete route contents remain identical. The
captured observation time, original lease expiry and original quiescence deadline
still bound the report; changed authority or either lease expiring discards it.
`observationsDiscarded` counts these invalidated probes separately from errors.

A snapshot is `{gatewayId,revision,issuedAt,expiresAt,routes}`. Each strict route
has managed UUIDs (`id`, `serverId`, `nodeId`, `allocationId`), monotonic revision,
consent `generation`, optional `wakeJobId`, `public:{address,port,transport}`,
`backend:{allocationAddress,address,port}`, `protocol:{handlerId,gameVersion,role}`,
mode, locale, and optional `sleepEligibleAt`. `allocationAddress` is the immutable
provider address; `address` is its explicitly verified effective private endpoint.
One claim may have TCP and UDP routes. Same-number ports on disjoint IPs are valid.
No route is inferred from provider inventory.

Observations contain an anchor `routeId/routeRevision`, the **complete** unique
`routes:[{routeId,routeRevision}]` set for that server, generation, optional wake
job, oldest included `observedAt`, `ready`, optional `idle/playerCount`,
`activeSessions` and optional `quiescenceUntil`. Every current role must be ready;
every idle hook must affirm zero players, with no live Gateway sessions, before
sleep evidence can be affirmative. Missing/failing/busy roles cannot be omitted.
A client cannot supply the Docker process timestamp. Ordinary idle reports measure
the window; only a bounded, validated forwarding fence can authorize automatic
stop after the window expires. See ADR 0012 for timeout/restart behavior.

## Configuration and deployment prerequisites

Settings resolve defaults < Owner database values < explicit environment values.
Nested JSON policies are complete objects, not implicit partial merges. Defaults
leave the Gateway disabled, with 15-second route leases (3–30 supported).

| Setting / environment | Purpose |
|---|---|
| `gatewayEnabled` / `NH_GATEWAY_ENABLED` | Explicit enable switch, default false. |
| `gatewayId` / `NH_GATEWAY_ID` | One stable generated Gateway UUID; bootstrap environment required. |
| `gatewayPhysicalHostId` / `NH_GATEWAY_PHYSICAL_HOST_ID` | Existing NickHosting physical-host UUID, never a guessed provider node ID. |
| `gatewayCoreUrl` / `NH_GATEWAY_CORE_URL` | Core service base URL; bootstrap environment required. |
| `gatewayLeaseSeconds` / `NH_GATEWAY_LEASE_SECONDS` | Short authority lifetime; expiry closes sessions/listeners. |
| `gatewayNetworkPolicy` / `NH_GATEWAY_NETWORK_POLICY` | All provider node IDs/UUIDs, verified bridge network modes and optional exact Wings loopback attestations. |
| `gatewayObserver` / `NH_GATEWAY_OBSERVER` | Explicit Docker socket, readable host-proc directory, pinned host namespace and Docker daemon identity. |
| `gatewayNodeProbes` / `NH_GATEWAY_NODE_PROBES` | Provider-node ID → `{port,transport}` for a persistent nonce responder on the **same effective backend IP**. No alternative host is accepted. |
| `gatewayDataPolicy` / `NH_GATEWAY_DATA_POLICY` | Typed connection/session/buffer/time limits; defaults in `packages/core/src/gateway-config.ts`. |
| `gatewayDiagnosticsSocket` / `NH_GATEWAY_DIAGNOSTICS_SOCKET` | Optional private Unix socket for bearer-authenticated `/healthz`, `/readyz`, `/metrics`; supply its approved path in bootstrap environment. No diagnostic TCP bind. |

`gatewayNetworkPolicy` is `{nodes,maximumObservationAgeMs}` (100–15000 ms).
Each node is `{nodeId,nodeUuid,networkMode,loopbackRemap?}`; loopback remapping
requires Wings `1.11.13`, explicit private `interfaceAddress`, `ispn:false`, and
`verifiedEggs:[{nestId,eggId,forceOutgoingIp:false}]`. This declares verified
semantics; actual container bindings and network-namespace reachability are still
required. Direct RFC1918/ULA claims remain supported, including equivalent
canonical IPv6 provider spellings.

The initial supported deployment runs in the verified game-host network namespace,
with standard local bridge/NAT backend containers. Unknown remote/bridged Gateway,
Wings host/overlay/routed modes, missing node policy, inaccessible observations,
wildcard conflicts and ambiguous ownership fail closed. This deliberately makes
no compatibility claim for those topologies. The current development user's
inability to read the host PID 1 namespace is an **unverified production
prerequisite**, not permission to change permissions or to treat `/proc/self` as
independent production proof.

Trusted game protocol modules load only from absolute local paths in
`NH_GATEWAY_PROTOCOL_MODULES` (JSON array), exporting `gatewayProtocols`. No remote
module download or Owner HTTP request can load executable code. M3 ships no real
game handler. The service does not need PostgreSQL/Redis/provider credentials.
Configuration changes invalidate renewal and restart the local runtime after a
conservative lease drain. Startup waits 31 seconds before opening game listeners
or reporting idle evidence, covering an old process's maximum lease and skew.

A first-ever backend needs one explicit admitted/manual start and protocol proof
before a sleeping listener can be established. Later sleeping restarts require
the same container/network/binding proof and a fresh nonce challenge to a persistent
responder on the effective backend IP. `startNodeProbe` is an explicit helper,
never an automatic listener. Its deployment needs its own reviewed endpoint and
Owner approval; M3's responder exists only in the approved isolated fixture.

[`deploy/game-gateway.service.example`](../deploy/game-gateway.service.example)
is an unapplied user-service template, separate from API/worker. Replace its
placeholders, supply Node 24 and the read-only Docker CLI access, and protect the
service environment. Persistent runtime paths belong under `./mountdata/`.
Do not install/start this template, mount sockets, create networks, modify the
external frontend network, or bind public endpoints without exact Owner approval.

## Recovery and rollback

PostgreSQL migrations 010/011 contain no instance seeds. Redis only delivers the
existing M2 operation jobs. Duplicate joins retain one wake operation/reservation;
insufficient fresh resources return blocked immediately, without a waiting queue
or stopping another server. A later intentional join can retry after Core's
cooldown; passive polling and manual/maintenance states cannot wake.

Expired/missing snapshots close the data plane. API/worker outages do not grant
new wake authority; Redis loss does not affect packet forwarding while a current
route lease remains valid. Reconciliation never imports unrelated servers.
Deleting a managed server disables its routes and waits for all issued route
leases plus skew before provider deletion/allocation release. This protects a
backend port from being reassigned while cached routes could still forward.

Rollback: stop the Gateway, disable it in Core and wait the maximum issued lease
before touching its own endpoint configuration. Preserve database/provenance and
uncertain operation/reservation records; do not drop migrations with active jobs,
reverse a provider effect blindly or delete production data. Revert the milestone
only after the existing M2 worker can safely recover pending operations. The
isolated fixture has separate approved, provenance-verified `down` cleanup.

### Explicit development responder launcher (M5)

`apps/game-gateway/src/node-probe-main.ts` runs the existing bounded TCP nonce
protocol as a separately approved service. It requires `NH_NODE_PROBE_ADDRESS`
(exact RFC1918/ULA private backend IP, no wildcard/loopback/hostname/scoped address)
and `NH_NODE_PROBE_PORT` (1024–65535). `--health` performs a nonce round trip without
opening a second listener; SIGTERM/SIGINT close current sockets and the listener.
No provider/database credentials are required. This proves endpoint reachability,
not game readiness, player idleness or external connectivity. The development
Compose live overlay is unapplied until its specific approval; see
[M5 environments](M5-ENVIRONMENTS.md#mixed-directgateway-allocation-pools-and-next-activation-proposal).
