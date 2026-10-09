# ADR 0005 — Single permanent Game Gateway for managed servers only

**Status:** Accepted; topology to verify before binding live traffic

## Decision

One Game Gateway process in the `nickhosting-panel` deployment on the same configured physical host as the existing Pterodactyl/Wings installation. Managed servers receive public gateway endpoints and private Wings backend endpoints; the same port number can be used on different bound IPs. Gateway handles TCP/UDP, multi-port games, routing and plugin-specific sleep/wake. Pterodactyl servers created directly by Owner remain direct, never proxied.

The provider allocation address and effective backend address are separate. M2
supports direct private bindings and verified Wings 1.11.13 exact `127.0.0.1`
remapping to the configured private bridge interface. The Gateway must use the
effective address, not its own loopback or an inferred Docker IPAM gateway.
Owner declarations in [the M2 contract](../M2-API.md) establish configuration,
not proof that a future container can reach that endpoint.

**M3 acceptance gate, before any listener bind:** refresh the inventory of all
existing direct Pterodactyl allocations on the relevant physical host, including
assigned allocations of stopped servers. Translate their effective Wings bindings
using verified node/network behavior. Compare every proposed public Gateway
address, port and transport with that inventory and actual host listeners/Docker
published ports, not merely NickHosting pools. Wings publishes each allocation
for both TCP and UDP; SDK role declarations cannot narrow this conflict check.
Account for wildcard, IPv4-mapped and IPv6 dual-stack overlaps, and fail closed
on unknown binding semantics, topology or ownership. Refuse conflicts without
mutating/importing unrelated servers or allocations. Independently verify actual
container PortBindings and backend reachability from the Gateway's own network
namespace before routing. Test this in isolated fixtures; live binding or network
changes still require operation-specific Owner approval. M2 creates no listener.

## Consequences

Need safe binding and route ownership, live network verification, readiness and graceful fallback. Do not patch Wings/Pterodactyl; do not modify Docker network/ingress without specific approval. Distributed per-node gateways and a Minecraft interactive limbo are future ideas, not v1 deliverables.
