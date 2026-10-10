# Permanent Game Gateway — v1 design contract

## Scope and placement

One long-running service **inside the `nickhosting-panel` deployment** (separate process from HTTP UI), on the same current physical host as existing Pterodactyl/Wings. Host addresses are supplied through configuration and local infrastructure notes, **not hardcoded**. No gateway-per-Wings-node topology in v1; multi-node evolution is future work.

**Only server UUIDs explicitly marked NickHosting-managed** can be registered with the gateway. A game server created directly in Pterodactyl remains direct and must never be intercepted or imported automatically.

## Optional per-server delivery

An integration may support installation and direct play without supporting the Gateway
protocol. The Owner-approved M5 amendment separates these capabilities. New servers
use a frozen `connection_mode`: `gateway` only when declared and enabled, otherwise
`direct` with explicit Owner-configured endpoints. Existing servers retain their mode.
Direct servers are excluded from route snapshots, policy, wake/idle observation and
queued Gateway effects. Their ordinary start/stop and authorized schedules continue
to use M2 admission; direct play does not imply automatic wake or readiness detection.

Compiled Minecraft declarations identify their own ID/version in service-only route
metadata. They are not relabeled local test attestations. The Gateway validates the
compiled declaration and exact supported release/protocol. Existing legacy attestation
DTOs remain readable with their expiry checks. Authenticated control-plane routing,
lease expiry, collision checks, process epochs and forwarding fences remain required.
The current declaration enables Vanilla 26.1/protocol 775 Gateway behavior; other
Vanilla versions can use direct access without a claim of protocol compatibility.

An explicit advertised direct hostname/port is a configuration fact, not proof of
external reachability. No fallback to a private allocation address, no automatic
public listener and no networking changes are authorized by direct mode.

## Automatic registration during creation

New Gateway-mode servers supplied by a trusted first-party module with a Gateway
protocol binding reserve their public routes together with their private allocation
claims. The node's Owner-configured pool must declare one unambiguous Gateway bind
address; public and backend endpoints use the same numerical port on different IPs.
Each allocation's declared TCP/UDP transports retain separate route identities.
No endpoint is guessed from a provider alias, host interface or Docker bridge.

The durable provisioning job activates its reserved routes only after provider
identity, egg installation and game configuration have been verified. Route intent
is pinned in the job: replay cannot choose another endpoint, duplicate registrations
or undo an Owner's later disable action. A configuration/collision error is reported
rather than treating a partially configured server as successfully connected.
Direct servers and existing servers without automatic route intent are unchanged.

Registration initializes the trusted protocol policy with inherited idle timing;
it does not grant automatic-start consent. Manual-stop and maintenance suppression
remain authoritative. The Gateway still validates fresh provider inventory, host
listeners, Docker bindings and actual backend reachability before opening a listener,
and requires game readiness before forwarding. Route configuration and a snapshot
lease are not evidence of successful listener binding or external connectivity.

## Bind/forward model

- Gateway takes a configured **public game endpoint** (bound interface/IP + port + TCP/UDP role).
- Wings runs managed backend container on a **different private bind IP** (often the Pterodactyl Docker bridge mapped from Pterodactyl allocation `127.0.0.1`).
- **Numeric port may be equal** on public and private endpoints: e.g. `PUBLIC_BIND_IP:25565 → PRIVATE_BACKEND_IP:25565`; uniqueness is the `(IP, protocol, port)` binding. Never assume a Docker bridge address; verify the authorized current Wings configuration before selecting a backend address.
- Wings maps `127.0.0.1` allocations to its Docker network interface in standard bridge configurations; verify installed Wings networking and possible `ISPN`/host mode before relying on it.
- Gateway in Docker must reach backend bridge correctly. Docker published ports/wildcard binds, network namespaces, host NAT and IPv6 require *real topology validation*. Do not change Docker networks, port forwarding or Wings bindings without Owner approval.
- Some games need multiple ports and both transports; route each declared role. Track UDP pseudo-sessions/timeouts appropriately.

## Data plane vs control plane

- **Data plane:** accept/proxy TCP connections and UDP datagrams for registered endpoints, minimizing overhead and avoiding database lookups per packet. Observability limited to operational metrics and necessary protocol framing, not unnecessarily storing player traffic.
- **Control plane:** authenticated IPC/API with NickHosting Core, mapping endpoint→server→backend, running/sleeping/starting modes, wake request, readiness signal, health, reconciliation. Use a persisted route registry and an in-memory hot cache.
- Gateway must start in a safe mode if API/Redis is down: do not accidentally bind unrelated Pterodactyl ports or allow unauthorized start loops.

## Game handler mode

1. `routing`: forward to a ready backend, or proxy protocol-aware connections where supported.
2. `sleeping`: reply to status probes and distinguish intentional joins; initiate wake once per server under idempotent coordination.
3. `waking`: show game-native progress/kick/hold behavior where supported; prevent a flood of duplicate wake jobs.
4. `blocked`: when admission rejects for insufficient compute, return immediate in-game explanation if supported; otherwise provide a stable failure behavior and actionable panel diagnostics.
5. `maintenance` or `manual-off`: do not auto-wake on join unless owner explicitly changes mode.

Backend readiness is game-specific (Pterodactyl process running alone is insufficient). Wake time estimate derived from recent measured times until **actual readiness**, rejecting stale/unrepresentative samples. If no reliable estimate exists, don't fabricate one.

## Future-only extension

An optional Minecraft virtual limbo (small world, limited interactions, wake button) could be explored after real launch, using a fully implemented Minecraft protocol/login backend or compatibility layers. It is deliberately **not in M3/M4 acceptance criteria**. Do not add a fake limbo server to meet this design exploration.

## Security and production boundary

Gateway only listens to endpoints in its own persisted registry. Validate bind collisions, route provenance, per-server membership and capacity admission in the Core. Do not create or change existing Docker network configurations; report required work with exact approval request. Test network routing in an isolated mock port range before production binds.

## M3 verification

- TCP and UDP echo/fixture game servers, multi-port forwarding, multiple endpoints sharing different IPs/ports.
- Sleeping vs manual-off behavior; one wake per first intentional join, never on normal status polling unless required.
- Route switch before/after readiness, worker/API outages, gateway restart/recovery.
- Same port on distinct bound IPs; no interference with a pre-existing unrelated Pterodactyl server.
- Runtime route lookup and telemetry. No permanent modification to live Docker or DNS without approval.

## M3 implementation

The standalone `apps/game-gateway` executable, `packages/gateway-safety`, SDK
protocol contracts and Core/worker orchestration implement this boundary. See
[M3 APIs/configuration](M3-API.md) and [ADR 0012](decisions/0012-gateway-leases-and-sleep.md)
for route leases, multiport evidence, forwarding fences and restart behavior.
[Validation](M3-VALIDATION.md) distinguishes isolated fixture evidence from
unverified production deployment prerequisites. No Minecraft/Satisfactory
compatibility or production Gateway listener is claimed by M3.
