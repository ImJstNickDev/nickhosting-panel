# Permanent Game Gateway — v1 design contract

## Scope and placement

One long-running service **inside the `nickhosting-panel` deployment** (separate process from HTTP UI), on the same current physical host as existing Pterodactyl/Wings. Host addresses are supplied through configuration and local infrastructure notes, **not hardcoded**. No gateway-per-Wings-node topology in v1; multi-node evolution is future work.

**Only server UUIDs explicitly marked NickHosting-managed** can be registered with the gateway. A game server created directly in Pterodactyl remains direct and must never be intercepted or imported automatically.

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
