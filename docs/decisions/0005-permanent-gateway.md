# ADR 0005 — Single permanent Game Gateway for managed servers only

**Status:** Accepted; topology to verify before binding live traffic

## Decision

One Game Gateway process in the `nickhosting-panel` deployment on the same configured physical host as the existing Pterodactyl/Wings installation. Managed servers receive public gateway endpoints and private Wings backend endpoints; the same port number can be used on different bound IPs. Gateway handles TCP/UDP, multi-port games, routing and plugin-specific sleep/wake. Pterodactyl servers created directly by Owner remain direct, never proxied.

## Consequences

Need safe binding and route ownership, live network verification, readiness and graceful fallback. Do not patch Wings/Pterodactyl; do not modify Docker network/ingress without specific approval. Distributed per-node gateways and a Minecraft interactive limbo are future ideas, not v1 deliverables.
