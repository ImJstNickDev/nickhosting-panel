# Configuration, deployment and real host environment

## Configuration precedence

At runtime: **compiled defaults < Owner settings (PostgreSQL) < explicitly defined `.env` overrides**. A field overridden by environment must appear read-only in Owner Settings with a reason. Do not automatically copy unset example values into the database.

There is **no server-specific IP/domain/nest ID hardcoded into product logic**. Names of environment variables and schema defaults are stable; actual IPs, domain zones, bind targets, credentials, Pterodactyl endpoints, Docker network service names and paths are set through first-run Owner wizard/admin or `.env`.

Secrets (Better Auth session secret, encryption key, Discord secret, Pterodactyl Application/Client API keys, Cloudflare token, SMTP password, SFTPGo credential master secrets) are environment variables or encrypted in a separated protected secrets store backed by an **environment-provided encryption key**. An Owner first-run wizard may collect Pterodactyl keys, so store encrypted and never expose them through GET settings/logs.

Do not use database seeding to create accounts or default live instance data. Migrations create schema only; initial Owner and Pterodactyl connection are created by a one-time protected setup wizard.

## Local environment context (never published)

Keep machine-specific observations in `.codex/local/INFRASTRUCTURE.md`, excluded from Git. AGENTS.md directs Codex to read it before authorized infrastructure work. The local notes preserve the actual host, resolver, external network, current/stale installation paths and deployment hostnames; none are product defaults or approval to change infrastructure. A fresh clone needs Owner-supplied local context before infrastructure access. Never store credentials in documentation.

Public examples use localhost or reserved example addresses/domains. Keep the public website, web app and Pterodactyl ingress separate. Existing frontend networks are external; never recreate them or silently change DNS/proxy routing. Prefer internal Docker hostnames. Where external-name access requires a specific resolver, use the Owner-supplied value and verify resolution without changing DNS infrastructure.

## Compose and bind mounts

- Project-owned Docker Compose files can be authored in the repo but **not deployed to live host without approval** if they change live services/ports/networks/configuration.
- Use project-local persistent bind mounts exclusively under `./mountdata/`: e.g. `./mountdata/postgres/`, `./mountdata/redis/`, `./mountdata/sftpgo/`, `./mountdata/uploads/`, `./mountdata/test-assets/` and project logs if needed. `mountdata/` is gitignored, never initialize it with real secrets in Git.
- Redis should use AOF persistence. Postgres backups and recovery procedure must be documented, with volumes isolated from existing Pterodactyl data.
- The existing external frontend network specified in local notes is joined by appropriate ingress-facing project services; internal DB/Redis need not be published on that network. Do not automatically attach Wings or existing Panel to any network.
- If API calls Pterodactyl through the Docker-internal hostname, require confirmed DNS/network reachability. If using an external hostname, configure the Owner-specified container resolver, test name resolution first, and verify the distinct Pterodactyl and NickHosting hostnames route to the intended services.
- Carefully map SFTPGo to actual Wings-managed per-server data paths only after inspecting permissions and seeking Owner authorization for any live mounts/UID/GID/Compose changes. Do not accidentally expose entire host filesystem or another server's files.
- Game gateway binds must be explicitly configured per registered endpoint; never listen wildcard on the host in a way that steals ports used by Pterodactyl-owned direct servers.

## One-time onboarding fields

The protected setup flow should ask for Owner identity/auth, display name/branding, Pterodactyl base URL, API credentials, available node(s) and network/endpoints, game allocation strategy, and optional integrations (Cloudflare token/zone, Discord OAuth, email SMTP, SFTPGo) through progressive setup steps. Keep optional services genuinely optional until their feature is enabled.

Connectivity checks must be read-only unless an explicit test action is approved. A simple test call must not secretly write Pterodactyl settings or Cloudflare DNS.

## M2 backend allocation and transfer prerequisites

New provisioning requires an Owner-configured exact private backend allocation
pool and disjoint declared gateway bind addresses for each managed node. Migration
007 leaves existing nodes unconfigured; it does not select public allocations or
seed host-specific values. `NH_BACKEND_ALLOCATION_POOLS` can explicitly override
stored pools. The [M2 API contract](M2-API.md) defines validation and environment
locking. Do not create allocations or change host networking merely to satisfy
this prerequisite without an operation-specific Owner approval.

Allocation `address` is the exact provider IP; `backendAddress` is its effective
private Docker binding. Direct RFC1918/ULA bindings retain their address. Exact
`127.0.0.1` requires an explicit Wings 1.11.13 bridge/NAT declaration, configured
private IPv4 interface, ISPN disabled and an Owner-verified egg allowlist with
`force_outgoing_ip=false`. The Application API does not expose that flag: verify
it read-only before attesting; never change an egg to satisfy the prerequisite.
Do not infer the interface from IPAM's gateway or assume container loopback is
reachable. Unsupported modes fail closed. Migration 009 backfills old direct
claims and stores both immutable addresses. These declarations do not establish
Gateway reachability: M3 must check the actual container bindings and its own
network namespace, plus public-listener collisions against unrelated direct
allocations, before any listener bind. No existing network is changed by M2.

Browser uploads require a separate trusted Wings origin allowlist
(`NH_PTERODACTYL_UPLOAD_ORIGINS`) and a verified per-host `uploadPolicy`.
Migration 008 leaves uploads disabled until the Owner supplies the provider's
maximum file size and actual disk-backed multipart staging path, budget and
headroom. `NH_UPLOAD_POLICIES` overrides stored policies; `NH_OBSERVER_ID` must
identify the correct host. Do not assume that server data and temporary uploads
share a filesystem. Any observation mount requires separate infrastructure
approval. Ambiguous uploads retain a PostgreSQL claim until audited Owner
recovery using external completion/cleanup evidence; see [M2 API](M2-API.md).

Files and backups stream through the backend. The current Wings setting permits
**500 MiB per uploaded file**; larger uploads require a separate provider-limit
decision. That limit is checked after native multipart spooling, so NickHosting
checks its verified mirror before forwarding. No reverse-proxy, Panel/Wings upload
limit, host mount or service setting is changed automatically. Node allows
progressing binary uploads without a total body deadline while retaining idle
and header protection. Total server-count limits default to disabled;
`NH_MAX_SERVERS_PER_USER=null` explicitly disables a stored cap. The separate
`NH_MAX_CONCURRENT_PROVISIONS_PER_USER` guard limits pending work, not retained
offline servers.

## Approval handoff for infrastructure tasks

Whenever new operational settings are necessary, Codex must produce:

1. Current read-only observations and exact change proposed (file/network/service/port).
2. Why required, affected existing systems and test dependencies.
3. Proposed commands or config diff, dry-run checks where possible.
4. Risk, rollback, verification and cleanup plan.
5. Explicit question asking the Owner for approval. **Do not execute before approval.**

## Public-repo hygiene

The repo is public, but secrets, auth tokens, `.env` runtime files, screenshots with session cookies, private logs, Pterodactyl config secrets, real player data and closed-source Blueprint plugin source stay private. Sanitize PR evidence. A public GitHub repository does not by itself grant permission to redistribute closed-source extensions. Do not add a LICENSE unless the Owner chooses one.
