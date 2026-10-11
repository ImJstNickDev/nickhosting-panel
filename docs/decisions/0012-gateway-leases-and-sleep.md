# ADR 0012 — Gateway leases, verified topology and bounded sleep authority

**Status:** Implemented and independently reviewed in M3; pending Owner/ChatGPT PR review.

## Decision

Run one permanent Gateway process separately from Core and the worker. PostgreSQL
owns explicit routes, consent generations, startup samples and reachability
proofs. The authenticated Gateway caches short complete snapshots; TCP/UDP packet
forwarding uses memory and bounded sockets, never a database query per packet.
No real game protocol is bundled in M3.

Before each listener opens or its authority renews, verify fresh complete provider
allocation inventory, provider and NickHosting identity, actual sockets/interfaces,
Docker configured/effective bindings, namespace/daemon identity and supported
bridge/NAT semantics. Both transports reserve a provider allocation even when its
server is stopped. Exact socket inode ownership exempts only this Gateway's own
listener. Validate immediately before each bind, including staged listeners.
Inventory and socket inspection cannot make independent Docker/provider writers
atomic; subsequent OS bind conflicts fail and stale leases close safely.

Provider and effective backend addresses remain distinct per ADR 0005/0011.
An Owner declaration cannot prove reachability. Actual game-protocol response
establishes a proof tied to exact container, bindings and namespace. A stopped
backend needs an unchanged stored proof plus a fresh nonce challenge at its actual
backend address. Unknown topology refuses listeners. The production host namespace
and persistent responder remain separately verified deployment prerequisites.

Aggregate readiness and idle evidence across every current server route. Stamp
evidence with the oldest included probe time. Core verifies the complete set,
current consent, independent process identity and freshness; a running container
or one successful query port cannot mark a whole game playable. Startup estimates
require at least five recent, representative measurements for the same runtime,
limits, protocol and version. Missing estimates remain null.

Reuse M2 atomic admission, operation jobs, outbox and conservative power recovery.
No automatic capacity queue or shutdown of other servers is introduced. Manual
stop revokes automation before operation conflict resolution. Interactive changes
refresh their session and role after lock waits. Automation jobs recheck current
consent and resource authorization before external effects.

An idle window alone does not authorize stop. Core publishes `sleepEligibleAt`
after continuous affirmative idle observations. When that time arrives, the
Gateway atomically checks zero sessions and fences **all** new forwarding for the
server before sending bounded `quiescenceUntil` evidence. Core rechecks routes,
generation, deadline and idle window under its resource lock. The worker checks
the fence immediately before a new power effect; expiry cannot discard an already
issued/uncertain effect or release its reservation. The fence remains locally
until a snapshot fetched after its deadline and skew establishes the current safe
state. A lost response or deadline alone cannot reopen forwarding.

A new executable/runtime waits the maximum supported lease plus skew (31 seconds)
using elapsed time before game listeners or idle reports. This covers old-process
in-flight evidence on restart. Unknown state stays blocked. The authenticated
Unix diagnostics socket can report startup/outage status during that interval
without introducing a public listener outside collision validation.

Deletion withdraws routes first and persists the greatest issued expiry. The
worker defers provider deletion/allocation release until that bound has elapsed;
there is no blind fixed sleep or lock held across waiting. Retired/invalid Gateway
records cannot prevent reconciliation of other servers or M2 external services.

## Consequences

Safe startup/recovery may delay play, and the first proof requires a deliberate
admitted start. A sleep decision briefly refuses new joins while its bounded
state resolves; it never forwards a newly admitted session into a stop based on
an earlier zero-session observation. Worker/control outages preserve uncertainty
instead of manufacturing readiness or available capacity. Later game milestones
supply protocol-native status/join responses and verified graceful-save semantics.

Public deployment, additional node-probe services, permissions, network/socket
mounts and real ingress remain subject to operation-specific Owner approval.
M2's temporary SFTPGo exception and issue #18 are unchanged.

## 2026-10-11 amendment — Status continuity during backend recreation

The v2 reachability proof identifies stable provider identity, allocation/binding
shape and namespace/topology, rather than a replaceable Docker container ID.
Wings may recreate that container during a normal start. An already-owned
`waking` or `sleeping` listener may retain its status-only responder across an
absent backend container or temporarily absent effective bindings. It requires
the same consent generation/public endpoint, previously validated backend metadata,
an unchanged current v2 proof, fresh complete provider/topology/socket/collision
checks and a successful nonce challenge at the backend node. Retained metadata
is bounded, process-local and conveys no permission independently of those checks.

This exception cannot bootstrap a listener, authorize forwarding, validate an
online backend, cover contradictory bindings/identity, or survive unknown topology
or an aggregate validation timeout. Forwarding still requires complete current
backend proof and game readiness. Restart loses retained metadata and keeps the
existing bootstrap rules. Fixed diagnostic reason codes distinguish recreation,
binding conflicts, topology/proof failures and validation timeouts without leaking
provider payloads or credentials. A single validation pass may share its fresh
Core context with the node challenge; it is not reused across validation passes.


## 2026-10-11 amendment — Early release after exact completed sleep

The original deadline-only local fence remains the fallback. A negotiated Core
snapshot may additionally acknowledge the exact durable completed sleep operation.
Only succeeded, confirmed, terminal stop with offline state, no active operation
and no reservation supplies this proof. Gateway matches the original generation,
promised deadline, observation time and complete unchanged route identities, and
requires a new fully validated post-completion snapshot before releasing early.
A generic sleeping response or expired/lost report cannot substitute for proof.

This removes unnecessary remaining lease wait after a stop has conclusively
finished while preserving the promise during any unresolved stop. Route revision
checks under Core's resource lock continue rejecting delayed old idle reports.
Restart still drains the maximum old lease because local fence context is lost;
this change does not introduce multi-active-Gateway support. Feature negotiation
allows Core-first deployment with older strict Gateway clients. See the exact
[M3 control contract](../M3-API.md) and targeted M5 regression evidence.
