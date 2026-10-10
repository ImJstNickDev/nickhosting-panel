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

## M3 Gateway deployment prerequisite

[M3 configuration](M3-API.md) defines the disabled-by-default standalone Gateway,
its dedicated control secret, verified namespace/Docker observer, complete node
policy, private node challenge and typed connection bounds. The initial supported
placement shares the independently verified game-host network namespace;
arbitrary Docker bridge ingress is not assumed reachable. The separate
[user-service template](../deploy/game-gateway.service.example) is prepared only.
No service installation, Docker socket permission/mount, network/resolver change,
node-probe deployment or public listener is authorized by that file.

The [isolated fixture proposal](M3-TEST-INFRASTRUCTURE.md) has its own narrowly
approved resources and rollback. It does not establish production reachability
or authorize changes to the existing external frontend network. The SFTPGo 2.7.6
exception remains tracked by issue #18 before production release.

## M5 WebPanel build and development

`apps/web` is the React application. `scripts/dev.sh pnpm dev:web` binds Vite to
loopback. Set `NH_WEB_API_PROXY` in the development command environment to the
local Core API origin when using separate development processes; `/api` and
`/v1` are forwarded with the original Origin header. Add the exact development
origin to the existing API trusted-origin configuration. Never use a wildcard
origin or disable the existing CSRF/invitation checks to make development work.

`scripts/dev.sh pnpm build` compiles catalogs and writes static assets to
`apps/web/dist/`. `scripts/dev.sh pnpm --filter @nickhosting/web preview` provides
a loopback review server. A production host must serve these assets with SPA
fallback for browser routes and proxy `/api/auth/*` and `/v1/*` to Core on the
same public HTTPS origin. Preserve streaming/backpressure for uploads, downloads
and console SSE, and do not impose an arbitrary small transfer-body limit.
Assets are not a new Pterodactyl proxy, Gateway listener or separately deployed
authentication service. Applying reverse-proxy/host/container configuration
requires the existing operation-specific approval; M5 does not deploy it.

Only public presentation is compiled into the browser. Runtime configuration and
secrets remain server-side with defaults → Owner DB → environment precedence.
The new `NH_SFTP_PUBLIC_HOSTNAME` and `NH_SFTP_PUBLIC_PORT` declare the public SFTP
endpoint. The UI never derives it from a private SFTPGo administrative URL.
Absent endpoint/provider configuration is shown as unavailable. Revocation's
retained-SSH-transport limitation remains the separate issue #18 release gate.

Apply the existing migration command before running changed services. M5 adds
schedule/run tables and internal service-contact records. Run API and worker
from the same reviewed revision. Worker polling uses PostgreSQL due claims and
existing durable jobs; Redis delivery alone is not the source of truth. Health
marks missing/stale worker or Gateway contact unknown; merely loading the Owner
page does not prove those services healthy or deploy them.

## Isolated browser verification

`scripts/dev.sh pnpm test:browser` uses the verified isolated M2 service wrapper,
a disposable PostgreSQL schema per suite, and fresh loopback HTTP ports. The
actual React/Vite app, Hono API, Better Auth, migrations, authorization and job
processor run together. External Pterodactyl, DNS, identity/content metadata and
Discord boundaries use documented fixtures. No test route replaces a NickHosting
API handler. Browser suites never create users by seeding database identities.

Playwright's pinned Chromium is installed in the current user's cache. On this
validation host, missing Chromium shared libraries were obtained using
`apt-get download` and extracted with `dpkg-deb -x` under the user's cache;
`LD_LIBRARY_PATH` is scoped to the spawned browser. No OS package was installed or
upgraded. Other development hosts can use their approved compatible browser
installation; installing OS dependencies is a separate infrastructure decision.
The harness closes its browser/listener and drops only its test schema. It does
not start, restart or clean Docker services.

Raw screenshots remain ignored under `.codex/local/m5-browser/`. Only reviewed,
sanitized browser screenshots may be copied to `docs/screenshots/m5/`. Governance
accepts PNG files only in that directory, validates their envelope/checksums and
rejects embedded metadata and trailing payloads. Pixel privacy still requires
manual review. Original artworks and dependency notices remain separate from
screenshot evidence.

Install the pinned user-local test browser with
`scripts/dev.sh pnpm exec playwright install chromium` if absent. Do not append
`--with-deps` or install OS packages without their own approval. The production
build includes `THIRD-PARTY-NOTICES.md` and `THIRD-PARTY-WORKER-NOTICES.txt`; retain
both alongside static assets. See [M5 dependency provenance](M5-DEPENDENCIES.md).

## Persistent development and separate production configuration

The Owner-approved M5 architecture is specified in [M5 environments](M5-ENVIRONMENTS.md):
`compose.dev.yaml` provides HTTPS-proxied Vite HMR and isolated persistent review
state; `compose.prod.yaml` uses compiled immutable artifacts and independent
credentials/storage. The development hostname and external network in those
configuration examples were explicitly supplied for this task; other private
infrastructure notes remain unpublished. Read the exact activation proposal and
rollback before any Docker operation. The prepared configuration does not grant
activation, NPM/DNS mutation or production deployment approval.
