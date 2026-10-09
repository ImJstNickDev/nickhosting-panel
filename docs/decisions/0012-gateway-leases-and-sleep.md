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
