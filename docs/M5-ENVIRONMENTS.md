# Persistent development and production configuration

Decision and configuration review: **2026-10-10**, M5 [PR #21](https://github.com/ImJstNickDev/nickhosting-panel/pull/21).
The Owner approved this architecture, **not activation**. No containers, volumes,
networks, proxy hosts, DNS records or production services have been created or
changed by this configuration pass. Commands that build images, prepare persistent
state or run Compose require the separate activation approval below.

The later Owner-authorized activation attempt, PostgreSQL permission blocker and
[successful internal activation](M5-VALIDATION.md#2026-10-10--approved-permission-correction-and-internal-development-readiness)
are recorded in M5 validation, preserving the initial failures. The eight dev
services were healthy at that handoff. The subsequent **Owner-authorized real
provider mode** below supersedes the simulator-only restriction. NPM is now
serving HTTPS; current focused evidence is in the latest M5 validation entry.
This supersedes the historical “not activated” status above;
production remains unapproved. Future preparation gives only the PostgreSQL mount parent
0711 for its image's UID transition, while actual PGDATA and other private
paths remain 0700. It never repairs existing state automatically.

## Files and service boundaries

| File | Purpose |
| --- | --- |
| `compose.dev.yaml` | Project `nickhosting-dev`; persistent review environment with source reload. |
| `compose.dev.gateway.yaml` | Optional host-network Gateway; prepared only, separate activation approval required. |
| `compose.dev.real.yaml` | Explicit real-provider overlay: API/worker egress and configured resolver, no simulator dependency. |
| `compose.prod.yaml` | Project `nickhosting-prod`; configuration-only immutable release deployment. |
| `Dockerfile` | Pinned Node 24.21.0, pnpm 10.33.0; development, compiled runtime and separate Nginx ingress stages. |
| `.dockerignore` | Build-input allowlist excluding local environments, Git/Codex state, persistence, archives and keys. |
| `deploy/dev/.env.example`, `deploy/prod/.env.example` | Nonfunctional placeholders for parsing/review; never actual credentials. |
| `deploy/container-{env,entry,health}.mjs` | Environment validation, scoped process startup and health probes. |
| `deploy/nginx/*` | Same-origin routing, SPA fallback, streaming and HTTPS-aware headers. |
| `deploy/dev-provider.mjs` | Empty-inventory, read-only provider simulator; every mutation is rejected. |
| `scripts/dev-watch.mjs` | Catalog recompilation and graceful, relevant-source backend restarts. |
| `scripts/build-runtime.mjs` | Compiled JS workspaces, production exports and immutable SQL migration assets. |
| `scripts/prepare-dev-environment.mjs` | Explicitly approved, nonroot, non-overwriting preparation of development secrets/storage/TLS. |

Sandbox development has eight long-running services: `web`, `vite`, `api`, `worker`,
`postgres`, `redis`, `provider`, `mailpit`. Real mode uses seven; the simulator is
profiled off and can remain stopped without deletion. The `migrate` tools-profile service is
an explicit one-shot operation. Production has `web`, `api`, `worker`, `postgres`,
`redis` and the separate one-shot migrator; it contains no Vite, source mounts,
provider simulator or captured-mail service.

Only `web` joins the existing **external** `prod-frontend` network. Its fixed
container name **`nickhosting-dev-web`** and network alias give NPM a stable
upstream at **HTTP port 8080**. Production uses `nickhosting-prod-web:8080`.
Fixed names deliberately prevent parallel copies/scaling on the same Docker host;
recheck both container names and network aliases before activation. Never rename,
remove or take over a conflicting existing container.

Dev `nickhosting-dev-edge` connects ingress, Vite and API. Dev
`nickhosting-dev-data` connects API, worker, database, Redis, provider and mail.
Both are new **internal** networks. Production has independently named internal
edge/data networks and an additional API/worker egress network for explicitly
configured external services. No service publishes a host port. PostgreSQL,
Redis, Mailpit and the simulator have no NPM/public route. No Docker socket,
Wings mount, host networking, privileged container or production data mount exists.

The opt-in real overlay adds only `nickhosting-dev-egress` for API/worker outbound
connections and the Owner-specified `NH_DEV_PROVIDER_DNS` resolver. It preserves
the existing internal networks and web's external attachment. PostgreSQL, Redis,
Mailpit, Vite and the simulator do not join egress. No proxy, second Panel, host
port or production-network attachment is introduced for API/worker.

An internal Docker network removes normal external routing; it is **not a
complete host firewall**. Host services listening on its bridge gateway may still
be reachable. In the default sandbox mode, provider credentials and URLs are
locked to the local simulator at process startup. Real mode deliberately uses
Owner-configured Panel credentials under the existing managed-server ownership
checks; it never imports existing Panel servers. The ingress alone has a direct
production-network attachment and implements
fixed upstream routes, not an arbitrary forwarding proxy. Its container receives
no application secrets. Network attachment grants no authority to inspect or
modify other services.

## Origin, cookies, HMR and reload

The deployment environment adapter derives both `NH_PUBLIC_URL` and `NH_API_URL`
from `NH_DEV_PUBLIC_URL=https://dev.hub.nickhost.ing`. Better Auth retains its exact
trusted origin, HTTPS Secure/HttpOnly session cookies, SameSite behavior, CSRF,
invite restrictions and validated redirects. No wildcard origin or TLS bypass is
introduced. Origin is passed unchanged through ingress. Current authentication
throttling deliberately uses the actual socket peer, not untrusted forwarded IP
headers; behind ingress users share that conservative peer bucket. Review expected
concurrency before production and do not disable throttling to compensate.

Vite listens on `0.0.0.0:5173` **only within its network**. External-mode settings
allow the exact public hostname and set the HMR URL to
`wss://dev.hub.nickhost.ing:443/__nickhosting_hmr`. Explicit `clientPort: 443`
prevents Vite's direct/internal-address fallback. React Fast Refresh and CSS HMR
use that WebSocket. Config loading avoids writing into read-only dependencies;
the optimizer cache lives in `/tmp/vite-cache`.

Workspace `src` directories are mounted separately, preserving image-installed
workspace dependencies. Backend/game/shared sources are read-only. Web source is
writable solely because catalog compilation updates `apps/web/src/app/messages.json`.
Initial compilation precedes Vite; English/Italian/game catalog changes trigger
recompilation and browser updates. API/worker source changes debounce, send SIGTERM
and wait for actual process closure before launching a replacement. CSS, ordinary
frontend code and game UI-only changes do not restart workers. A hung shutdown is
reported, never overlapped with a second worker. Image/lockfile/workspace changes
require a rebuild. SQL migrations are image-baked: rebuild the `api` image before
running the explicit migration command after a migration change.

Vite exposes development source to people allowed to reach the development host.
Use an Owner-managed NPM access list for reviewers if it should not be public.
This supplements application authentication; it does not replace it.

## Exact Nginx Proxy Manager proposal

The Owner configures this **new proxy host**; Codex does not edit NPM, DNS or
certificates during this task:

| NPM field | Proposed value |
| --- | --- |
| Domain names | `dev.hub.nickhost.ing` |
| Forward scheme / hostname / port | `http` / `nickhosting-dev-web` / `8080` |
| Websockets Support | Enabled |
| SSL certificate | Existing Owner-selected certificate covering this hostname |
| Force SSL | Enabled; browser entry point is HTTPS only |
| Cache Assets | Disabled for development |
| Access List | Owner-selected reviewers, if access should be restricted |

Advanced directives for **this host only**:

```nginx
client_max_body_size 0;
proxy_buffering off;
proxy_request_buffering off;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
send_timeout 3600s;
client_body_timeout 3600s;
access_log off;
```

In NPM's generated proxy location, verify HTTP/1.1, `Host $host`,
`X-Forwarded-Host $host`, `X-Forwarded-Proto $scheme` and WebSocket
Upgrade/Connection forwarding. NPM's WebSocket switch manages the latter; inspect
the **effective location configuration**, because server-level header directives
can be overridden by NPM's location directives. Do not paste a competing `location
/` block or change global NPM settings. The project ingress additionally sets the
canonical host and HTTPS protocol for Core and keeps the request Origin intact.

`/` reaches Vite; exact `/v1` and `/v1/*`, `/api/auth` and `/api/auth/*` reach Core.
Production serves compiled assets, returns 404 for missing fingerprinted assets,
and falls back to `index.html` for application navigation. Both configurations
stream API requests/responses without whole-body buffering or a proxy body-size
cap. Existing application/provider authorization, quotas and upload bounds remain
in force. Timeouts are inactivity bounds, not invented upload progress. Proxy
access logs are disabled to avoid recording invitation/OAuth query tokens;
application errors remain structured and redacted. No request headers/cookies or
mail verification links belong in public evidence.

## Credentials and durable state

| Concern | Development | Production |
| --- | --- | --- |
| Private environment | `.env.dev.local`, `NH_DEV_*` | `.env.prod.local`, `NH_PROD_*` |
| Database/user | `nickhosting_dev` | `nickhosting_prod` |
| Redis instance / job prefix | Dedicated / `nickhosting-dev` | Dedicated / `nickhosting-prod` |
| Persistence | `mountdata/dev/{postgres,redis,app,mail,mail-tls}` | `mountdata/prod/{postgres,redis,app}` |
| Auth/encryption/setup | Independent generated secrets | Independently generated production secrets |
| Provider | Default sandbox, or explicit real mode using protected Owner settings | Separately approved configuration/credentials |

App content/source staging lives under each environment's `app/`. Long bind
syntax uses `create_host_path: false`; starting Compose cannot silently create
missing host directories. Neither entrypoint runs migrations or seeds users,
Owner identities, instances or game servers. PostgreSQL's first initialization
creates only its dedicated empty database/user. Restarting services retains review
accounts and data; tests retain their own `nickhosting-m2-tests` database and
schema guards and must never run against this environment.

Dev runtime rejects production-prefixed and direct unscoped external-provider settings,
generic database/job overrides, placeholder/reused credentials and disabled TLS
verification. Sandbox pins Pterodactyl to `http://provider:9090`. Both modes disable
SFTPGo/Cloudflare/CurseForge authority and leave Gateway disabled unless the separately approved Gateway overlay is enabled. The simulator
supports connection validation and empty inventory only; game provisioning and
provider-specific operations correctly remain unavailable in sandbox. No sandbox UI action
can create/delete a production server through these pinned provider credentials.
For sandbox first-run use the local simulator URL and independently generated sandbox
token from the private dev file in both key fields; environment precedence remains
visible and authoritative. Real mode's deliberate credential reuse is described
below; independent database/auth/encryption secrets must never be replaced with
production values. No game support evidence is fabricated.

## Real-provider development: configuration and daily use

On 2026-10-10 the Owner explicitly authorized using the existing real Pterodactyl
Panel for interactive development, including entering its Application/Client keys
through protected NickHosting interfaces. This changes the earlier simulator-only
policy, not the production deployment or unrelated-server mutation boundaries.

The small mode selector is `NH_DEV_PROVIDER_MODE=sandbox|real`; omitted means
sandbox, unknown values fail. The real Compose overlay sets `real` for API,
worker and the explicit tools-profile migrator. The migrator retains only the
internal data network and gains no provider access. In real mode the entrypoint supplies **no Pterodactyl URL, keys or
transfer-origin overrides**. The regular settings/secret stores and adapter take
effect, with encrypted write-only keys and defaults < Owner DB < explicit env
precedence. Missing settings/keys fail unavailable rather than falling back to the
simulator. The original Minecraft download-origin defaults also become available;
the Owner can configure them normally. No provisioning/lifecycle implementation,
authorization, session, CSRF or Origin rule changes.

For this existing environment the private `.env.dev.local` records:

```dotenv
COMPOSE_FILE=compose.dev.yaml:compose.dev.real.yaml
NH_DEV_PROVIDER_DNS=OWNER_SPECIFIED_RESOLVER
```

Use the resolver from private infrastructure notes; never commit its actual
address. Compose reads the selected files from that environment file. **Do not
append `-f compose.dev.yaml` to daily commands: explicit `-f` overrides the saved
real-mode file selection.** The original activation commands below are historical.

```sh
docker compose --env-file .env.dev.local config --quiet
docker compose --env-file .env.dev.local up -d --wait
docker compose --env-file .env.dev.local stop
# After deployment-adapter/dependency changes, rebuild/recreate only what changed:
docker compose --env-file .env.dev.local build api
docker compose --env-file .env.dev.local up -d --no-deps --wait api worker
```

No preparation, migration, chmod or account reset is needed on ordinary restarts.
Review data, independent secrets, PostgreSQL/Redis state and source watching are
preserved. Existing provider simulator credentials may remain private for a later
return to sandbox; real mode never uses them.

### Owner connection and Minecraft eligibility

1. Sign in to the existing Owner account at `/owner/settings`. A completed sandbox
   setup does not need a reset or a second Owner. For a genuinely new instance,
   `/setup` accepts the same Panel URL and two keys through its protected flow.
2. In the **Pterodactyl** section above Credentials, expand **Panel API URL**
   (**URL API Panel** in Italian). Save `pterodactylBaseUrl` as the actual Panel
   **HTTPS URL**, without adding `/api`, then save the
   write-only `pterodactylApplicationKey` and `pterodactylClientKey` separately.
   Enter real keys only in those private form fields, never in chat, source,
   build arguments or frontend environment variables. An earlier sandbox bootstrap
   may have stored no provider values because they were environment-locked.
   If an old simulator URL is stored, replace it explicitly; there is no automatic
   configuration deletion. No restart is needed after these DB-backed saves.
3. Open `/owner/infrastructure` to discover actual nodes, nests, eggs and existing
   allocations through the standard adapter. Missing scopes remain errors; no
   automatic privilege increase or allocation/node/egg edit occurs. Configure
   physical host, managed node, validated backend allocation pool and the Vanilla
   runtime/egg mapping, including the actual image, startup and egg variables.
   Configure the required metadata user-agent and exact trusted Wings WebSocket,
   upload and download origins through Owner settings where applicable.
4. In `/owner/integrations`, enable the trusted `minecraft-java` module and choose
   its rollout. In `/owner/integrations/minecraft-java`, select the Vanilla mapping
   and synchronize the official version catalog. New supported Vanilla entries are
   enabled by default. Existing disabled entries stay disabled unless the Owner
   explicitly enables them. To include previously disabled catalog entries, select
   **Also enable previously disabled supported versions**, then **Discover Vanilla
   versions**. One action now processes every bounded page; leave historical versions
   unchecked for stable releases, or include them to discover snapshots as well.
   Progress distinguishes completed, partial and cancelled discovery.
   Integration declarations establish installation/direct-connect support; a local
   signed test report or verifier key is **not** required for declared Vanilla.
   The Owner capability view distinguishes installation, direct connection,
   Gateway, readiness, sleep/wake and player management from historical test evidence.
   Other runtimes and Satisfactory are not automatically enabled.
5. With Gateway disabled or unsupported for the chosen version, creation uses direct
   connections. In the managed node's allocation pool, explicitly declare the player
   hostname and port for each usable allocation. They must already reach that
   allocation through the Owner's network. Public provider bindings require the
   direct-only option. Saving does not create forwarding, DNS or listeners, or claim
   verified external reachability. Backend-only allocations stay reserved for Gateway
   use. Missing direct endpoints refuse creation before any remote effect.

**Policy amendment, 2026-10-10:** the Owner replaced the original per-mapping
certification prerequisite with trusted integration declarations. The compiled
Vanilla declaration offers protocol-aware Gateway support for the real-tested
26.1/protocol 775 pair; other installable Vanilla combinations use direct access.
Existing M4 reports remain truthful, identity-bound historical diagnostics; no
report is copied, re-signed or represented as a new live test. Optional
`NH_DEV_MINECRAFT_EVIDENCE_KEY` remains available for importing authentic reports,
not as a prerequisite for ordinary declared Vanilla creation. Existing Owner
mappings, disabled choices and rollout settings are preserved.

**Provider connectivity is not execution readiness.** Current provisioning/start
also requires approved host/container observer access, a matching observer ID and
fresh resource/image evidence. The original provider switch did not include observer access. The later
Owner-approved direct-socket overlay supplies it; see the operational readiness
follow-up below. Configuration, actual installation integrity and resource checks still apply. Gateway deployment/listeners, SFTPGo, DNS writes and other
production-release prerequisites remain separate. No real test server is created
to prove this configuration change.

To return to sandbox, stop only dev API/worker, change private `COMPOSE_FILE` back
to `compose.dev.yaml`, remove any optional dev evidence-key setting, then run
`docker compose --env-file .env.dev.local up -d --wait provider api worker`.
This restores sandbox environment precedence without deleting the Owner's encrypted
real-provider settings or accounts. Do not reset the DB, run prune/orphan removal,
delete persistent paths or alter the external network. Any unused dev egress network
can remain until separately scoped cleanup.

Mailpit captures development mail privately. SMTP requires authenticated STARTTLS;
the generated certificate names `mailpit`, and only its certificate is added to
Node's trust store. There is no TLS verification bypass, public mail UI, SMTP
relay or forwarding. The private mail database retains up to 1,000 messages
(oldest mail expires); this does not expire application accounts. Retrieve
verification mail through an authorized private terminal using the Mailpit API
from `docker compose ... exec api`; never publish its contents. Discord and
internet-dependent providers remain unavailable until a separately reviewed
configuration/network decision. The SMTP certificate expires after its 365-day
validity period and needs an explicitly scoped renewal, not a blanket TLS bypass.

Production needs its own SMTP/OAuth/provider configuration and resolver/reachability
verification. Never copy development/test credentials, fixtures or compatibility
evidence into it. The base Compose stack does **not** deploy a Game Gateway or SFTPGo/Wings
mount; the approved observation overlay supplies direct Docker access, while existing M3 topology/lease checks and separate
infrastructure approvals still apply. SFTPGo [issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18)
remains an independent production-release blocker.

## Validation without activation

From the workspace, these parse placeholders without starting services:

```sh
docker compose --env-file deploy/dev/.env.example -f compose.dev.yaml --profile tools config --quiet
docker compose --env-file deploy/prod/.env.example -f compose.prod.yaml --profile tools config --quiet
scripts/dev.sh pnpm build
scripts/dev.sh pnpm build:runtime
scripts/dev.sh pnpm exec vitest run scripts/deployment-config.test.ts scripts/dev-provider.test.ts scripts/dev-watch.test.ts scripts/prepare-dev-environment.test.ts apps/web/vite-network.test.ts
```

Use `config --quiet` with real private environment files; full interpolation output
contains secrets. The original configuration-only pass inspected Dockerfile
base-image manifests without pulling/building and checked compiled-runtime imports
without `tsx`, databases or provider calls. The subsequent authorized activation
verified dev image builds, actual Nginx `-t`, all eight container health checks,
internal routing and schema persistence across a scoped restart. Nginx module
scratch directories all use its existing writable `/tmp`; the worker heartbeat
probe explicitly closes its direct PostgreSQL pool before exiting. Neither fix
weakens health predicates or container isolation. Production's matching Nginx
template correction remains configuration-only. A later real-browser probe
confirmed the initial HMR WSS connection through NPM. Source-edit/refresh
propagation, mail delivery, cookie/CSRF behavior through HTTPS and account/session
persistence have not been reverified through this persistent environment.

## Original development activation request (subsequently approved)

Recheck free memory/disk, names/aliases and network identity immediately beforehand.
Read-only inspection on 2026-10-10 found ~25 GiB available RAM, ~79 GiB available
disk, no `nickhosting-dev*`/`nickhosting-prod*` container/network names and no
conflicting stable aliases on the existing bridge `prod-frontend`. These are
point-in-time checks, not reserved resources. `mountdata/` is root-owned and
`mountdata/dev` does not exist.

The Owner subsequently approved this bounded sequence. It is retained for audit
and future review, **not permission to rerun preparation or reset existing state**:

1. Build/pull the pinned development application, ingress, PostgreSQL, Redis and
   Mailpit images; downloads/build cache consume disk. No existing image/service
   is replaced by the build. Prepare **only** the new dev child directory with a
   temporary pinned Node container, no network, no host ports, read-only rootfs:

   ```sh
   docker run --rm --network none --read-only --cap-drop ALL --cap-add CHOWN \
     --mount type=bind,src="$PWD/mountdata",dst=/state \
     -e DEV_UID="$(id -u)" -e DEV_GID="$(id -g)" \
     node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 \
     node -e 'const f=require("node:fs"); const u=Number(process.env.DEV_UID),g=Number(process.env.DEV_GID); if(!Number.isSafeInteger(u)||u<=0||!Number.isSafeInteger(g)||g<=0)throw Error("Nonroot UID/GID required"); f.mkdirSync("/state/dev",{mode:0o700}); f.chownSync("/state/dev",u,g);'
   scripts/dev.sh node scripts/prepare-dev-environment.mjs --owner-approved --public-url https://dev.hub.nickhost.ing
   ```

   The helper aborts if the child already exists. It does not chown the parent,
   touch other mountdata children, read credentials or retain a container. The
   nonroot preparation script rejects existing environment/state or symlinks;
   it creates dedicated random secrets and local SMTP certificate/auth files.
   Never rerun it to reset an established review environment.

2. Build and start only the new project, migrating explicitly **before** API/worker:

   ```sh
   docker compose --env-file .env.dev.local -f compose.dev.yaml config --quiet
   docker compose --env-file .env.dev.local -f compose.dev.yaml build api web
   docker compose --env-file .env.dev.local -f compose.dev.yaml up -d --wait postgres redis provider mailpit
   docker compose --env-file .env.dev.local -f compose.dev.yaml --profile tools run --rm migrate
   docker compose --env-file .env.dev.local -f compose.dev.yaml up -d --wait api worker vite web
   ```

   This creates only `nickhosting-dev-edge` and `nickhosting-dev-data`, attaches
   **only `nickhosting-dev-web`** to existing `prod-frontend`, mounts the source
   paths enumerated in Compose and `mountdata/dev/`, and publishes **zero host
   ports**. Persistent services have an aggregate memory ceiling about 2.6 GiB;
   the one-shot migrator may add 512 MiB temporarily. Docker's normal bridge rules
   accompany its new networks; there are no manual firewall edits. No test stack,
   production provider, existing Compose stack or network is modified.

3. The Owner separately adds the NPM proxy host above using their certificate/DNS
   setup. No NPM/DNS/certificate write by Codex is included. After that, verify
   HTTPS/HMR, first-run and captured mail, auth/CSRF, same-origin API/SSE, EN/IT and
   CSS updates, graceful backend restarts, and data persistence across a **scoped
   dev restart**. Read-only provider inventory must stay empty and mutations denied.
   Approval should include these new dev-service restarts and scoped rollback.

Risks: source exposure to authorized dev-host visitors, new-network connectivity
from ingress, image/build disk use, local dev credential material and accidental
loss of unsaved edits/in-flight operations during restart. No production game
operation is needed. If a collision/topology/permission check fails, stop rather
than repair existing infrastructure.

Rollback/stop (only after the approved activation):

```sh
docker compose --env-file .env.dev.local -f compose.dev.yaml stop
# To remove only this project's containers and internal networks, retain all data:
docker compose --env-file .env.dev.local -f compose.dev.yaml down
```

`down` retains bind-mounted review data and cannot remove the external network.
Do not use `-v`, prune, orphan removal or delete `mountdata/dev`. The Owner can
disable the new NPM host separately. Dependency changes rebuild `api` and `web`
with the command above, then `up -d --wait api worker vite provider web`; changes
only to source need no image rebuild. Never use production Compose for dev cleanup.

## Production release procedure (configuration only)

A production deployment requires a new exact approval, directory/secret preparation,
provider and Gateway topology verification, release gates, backup/restore proof
and reviewed immutable image digests. The production sample is deliberately
nonfunctional. No production preparation or command below has been executed.

Build `runtime` and `prod-web` from the same reviewed commit, tag/publish through
the Owner-approved registry workflow, then set `NH_PROD_APP_IMAGE` and
`NH_PROD_WEB_IMAGE` to `repository@sha256:...` digests, never mutable tags:

```sh
docker build --target runtime -t nickhosting-app:REVIEWED_SHA .
docker build --target prod-web -t nickhosting-web:REVIEWED_SHA .
docker compose --env-file .env.prod.local -f compose.prod.yaml config --quiet
# After release approval and a verified database/persistent-data backup:
docker compose --env-file .env.prod.local -f compose.prod.yaml up -d --wait postgres redis
docker compose --env-file .env.prod.local -f compose.prod.yaml --profile tools run --rm migrate
docker compose --env-file .env.prod.local -f compose.prod.yaml up -d --wait api worker web
# Scoped shutdown, when approved:
docker compose --env-file .env.prod.local -f compose.prod.yaml stop
```

API readiness checks database reachability; it is not proof of complete provider
configuration. Worker health requires a fresh PostgreSQL heartbeat in its own job
scope; stale/degraded workers fail health. Redis uses AOF/noeviction. Container
restart policies do not automatically restart a merely unhealthy process; inspect
logs and recover with the durable job contracts. Worker grace periods permit active jobs to drain. The existing API shutdown closes
HTTP connections immediately, so SSE clients must reconnect and interrupted uploads
must follow their recorded operation/recovery state. A restart does not guarantee
that an in-flight transfer completes; forced shutdown still requires reconciliation.

There is no automatic migration on application startup or development activation
against production. Retain previous image digests and configuration. Image-only
rollback is allowed only when the previous release supports the current schema.
Otherwise stop affected services and obtain approval for restoring the **verified**
database and matching persistent-data backup. No migration downgrade or recovery
claim is invented; do not roll back only one half of an incompatible release.

## Upstream references

- [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/),
  [network attributes](https://docs.docker.com/reference/compose-file/networks/)
  and [bind/service attributes](https://docs.docker.com/reference/compose-file/services/).
- [Docker bridge gateway behavior](https://docs.docker.com/engine/network/port-publishing/#gateway-modes).
- [Vite server/WebSocket options](https://vite.dev/config/server-options#server-ws).
- [Nginx proxy streaming directives](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)
  and [NPM advanced configuration](https://nginxproxymanager.com/advanced-config/).
- [Mailpit SMTP/TLS](https://mailpit.axllent.org/docs/configuration/smtp/)
  and [runtime options](https://mailpit.axllent.org/docs/configuration/runtime-options/).

## Operational readiness follow-up

The Owner approved direct Docker socket observation for dev and future production,
with dev/prod never active simultaneously. The optional direct-socket overlays and
actual activation evidence supersede the earlier missing-observer/host-helper
proposal. See [development operational prerequisites](M5-DEV-READINESS.md).
The helper was never activated; no systemd service or lingering change is needed.
[Issue #22](https://github.com/ImJstNickDev/nickhosting-panel/issues/22) records the
accepted Docker authority and future hardening. Production stays configuration-only.
Host/node/mapping registration remains exclusively the Owner's responsibility.

## 2026-10-10 — Local Minecraft manifest and catalog optimization

The existing development database now includes additive migration
`019_minecraft_metadata.sql`: release metadata and durable synchronization state.
It was applied explicitly to `nickhosting_dev` using the exact migration SQL,
standard transaction/advisory lock and checksum record through an existing dev
container process. No users, settings, mappings, combinations or servers were reset.
The running worker completed its initial official-manifest synchronization (918
metadata entries); the 693 existing enabled combinations were unchanged.

No Compose/network changes or container recreation were needed. Existing source
watchers reload API/worker code and compile translations. For later image builds or
production preparation, migration 019 must be included in the image and explicitly
applied before updated services start, following the migration/rebuild procedure
above. Starting development still does not apply migrations automatically.

The worker checks due state every 30 seconds, downloads the official manifest at
most once per 15-minute successful cycle, and retains persistent last-good data
across restarts/outages. It needs the existing configured metadata User-Agent and
outbound HTTPS to the trusted official metadata endpoint. A failed attempt retries
after 60 seconds. The Owner page shows absent/stale metadata and last-success time;
list reads never fall back to upstream HTTP. This synchronization does not register
or enable combinations, download server artifacts or touch Pterodactyl resources.

Rollback: revert application code if necessary and leave the additive metadata
tables/data and recorded migration intact. Do not drop tables, reset dev data or
edit migration history as routine rollback. Existing provider ownership boundaries,
SFTPGo #18 and direct Docker-socket #22 are unchanged. Production was not deployed.


## Development Gateway — prepared, activation pending (2026-10-10)

The default stack still disables Gateway. `compose.dev.gateway.yaml` adds an
explicit opt-in to the **existing** M3/M4 implementation, not another proxy.
`NH_DEV_GATEWAY_ENABLED=true` is passed only to Core/worker by the overlay;
production and sandbox defaults remain disabled. Gateway gets a dedicated UUID
and independent random control token, never the application env file, database,
authentication or provider credentials. Host/node/network/probe policies remain
Owner settings; enabling the overlay does not create them, routes or servers.

The proposed `nickhosting-dev-gateway-1` service uses the existing development
application image, UID/GID from the dev configuration, 256 MiB/1 CPU, read-only
source mounts, no capabilities, and `no-new-privileges`. It runs in the **host
network namespace**, required by current collision/reachability verification.
It joins no Docker bridge and creates no network. This is a new, explicit
exception to the base dev network isolation and requires operation-specific
approval. The Docker socket has host-equivalent authority even mounted read-only
(issue #22). Host networking also permits reaching host-local services; it is not
an egress security boundary.

Independent namespace proof is mounted read-only at `/run/nickhosting-host-proc`.
Choose an independently verified long-lived host process readable by the service
UID (for example the existing host user service manager), not `/proc/self` or the
Gateway's own process. Before activation record the host process UID, executable,
parent, start time and namespace; recheck before mounting. `/proc/1/ns/net` is
not readable by the current dev UID. Do not change permissions or add privileges
as a workaround. Reboot/process replacement requires re-verification, updated
private path/namespace pin and service recreation; a stale proof fails closed.
Container access to the proposed proof is **not yet tested**.

Control communication uses the existing dev HTTPS origin and the narrowly routed
`/internal/gateway/` prefix in dev ingress. Core requires the exact Gateway UUID
and dedicated bearer; browser cookies/support sessions do not authorize it.
Other `/internal/` paths return 404. No NPM/DNS/certificate change is proposed.
Diagnostics use an authenticated Unix socket in service-owned tmpfs, with no
HTTP health port. `/readyz` checks the control-plane lease; zero-route readiness
must never be reported as proof that forwarding or sleep/wake works.

### Proposed activation, not executed

Private `.env.dev.local` additions (do not print values or replace existing keys):

- `NH_DEV_GATEWAY_ID`: one persistent UUID, generated once.
- `NH_DEV_GATEWAY_CONTROL_TOKEN`: independently generated 32 random bytes encoded
  base64url; separate from all application/provider secrets.
- `NH_DEV_GATEWAY_HOST_PROC`: independently verified host process directory.
- Append `compose.dev.gateway.yaml` to the existing `COMPOSE_FILE` chain, preserving
  the base, real-provider and observer overlays.

Owner settings still required: `gatewayPhysicalHostId` referencing the existing
host, `gatewayObserver` with container path `/run/nickhosting-host-proc`, socket
`/var/run/docker.sock`, pinned host namespace and Docker daemon identity;
`gatewayNetworkPolicy` for every actual provider node; `gatewayNodeProbes` for
approved responders. No host, node, egg mapping or allocation is created by this
preparation. Never fill policy values by guessing. Read-only inspection found
zero routes, no Owner Gateway settings and no backend allocation pool on the
configured managed node. The Owner must select eligible backend allocations and
public addresses before any route can become useful.

After exact Owner approval and verified policy prerequisites:

```sh
# Parse privately; never dump interpolated secrets.
docker compose --env-file .env.dev.local --profile gateway config --quiet
# Refresh app/ingress images only; no dependency upgrades or migrations.
docker compose --env-file .env.dev.local build api web
# First verify namespace access using the same nonroot service, before runtime:
docker compose --env-file .env.dev.local --profile gateway run --rm --no-deps \
  --entrypoint node gateway -e 'const f=require("node:fs");const a=f.readlinkSync("/proc/self/ns/net");const b=f.readlinkSync("/run/nickhosting-host-proc/ns/net");if(a!==b)process.exit(1);for(const n of ["tcp","tcp6","udp","udp6"])f.readFileSync("/run/nickhosting-host-proc/net/"+n);'
# Recreate only the explicitly approved dev processes. Preserve DB/Redis/Vite/mail.
docker compose --env-file .env.dev.local up -d --no-deps --wait api worker web
docker compose --env-file .env.dev.local --profile gateway up -d --no-deps --wait gateway
```

The read-only one-off preflight creates a temporary dev container with the same
host-network/socket/proc exposure; it also requires approval. It opens no listener.
The full network observer additionally validates the pinned namespace/daemon and
fresh inventories before each game listener. If the preflight fails, stop; no
root/capability escalation or permission repair is authorized by these commands.
Gateway changes require a scoped service restart; source mounts alone do not add
auto-reload to it. Existing API/worker/Vite reload remains unchanged.

**No game-listener or nonce endpoint is included in this first activation proposal.**
It can establish control-plane health with zero routes only after valid Owner
configuration. Each actual public/nonce address, port and transport needs a
separate exact endpoint approval and fresh collision/reachability evidence before
binding. Initial game/backend readiness requires an admitted manual start; a running container
alone does not suffice. Existing direct servers remain direct. The compiled
Vanilla declaration currently enables Gateway only for the tested 26.1 combination;
other usable Vanilla versions remain direct unless the integration declares support.

Rollback: stop only `gateway`, remove the Gateway overlay from the private
`COMPOSE_FILE` chain, then recreate only dev API/worker with the previous overlays.
Core returns to disabled; wait at least 31 seconds for old leases to expire before
any replacement Gateway authority. Preserve private token/UUID, DB, Redis and
review data. The dedicated ingress path remains service-authenticated and rejects
access when disabled; rebuild the previous web image if removing the path is
required. No `down -v`, prune, orphan removal, host process changes or production
resource cleanup.


### Approved attempt — namespace permission blocker (2026-10-10)

The Owner approved the service-only proposal above at reviewed HEAD
`4b6e1a60b2f716d47e348faa262cbb5c583560a4`. Git was clean; the recorded independent
host process UID, executable, parent, start time, namespace and Docker daemon
identity were reverified. Private independent UUID/token were generated without
printing them; existing dev configuration and data were preserved. The approved
application and web image builds succeeded.

The exact nonroot namespace preflight failed at
`readlink('/run/nickhosting-host-proc/ns/net')` with **EACCES**. The one-off
container was automatically removed by `--rm`. As the approved procedure requires,
execution stopped before API/worker/web recreation and before starting Gateway.
No root/capability escalation, permissions changes, game listeners or node probes
were attempted. The previous private `COMPOSE_FILE` chain was restored; the new
UUID/token remain private for reuse. Seven existing dev services remain healthy;
HTTPS returned 200. The older stopped sandbox provider was preserved unchanged.

Docker reports AppArmor enabled and the existing application uses `docker-default`.
The exact cause of the cross-container namespace read denial is **not yet proven**.
Reading the same host process metadata works as the development user on the host.
New images remain available locally; existing running containers keep their
previous images. No prune or persistent-state cleanup was performed.

### Next diagnostic proposal — NOT approved or executed

`compose.dev.gateway-diagnostic.yaml` changes only the temporary Gateway service's
AppArmor setting to `unconfined`, retaining UID/GID, no capabilities,
`no-new-privileges`, default seccomp, read-only mounts and resource limits. This
removes one mandatory confinement layer for a disposable process which already
has the explicitly described host-network/Docker-socket exposure. It must never
be added to private `COMPOSE_FILE`, used with `up`, or applied to the permanent
Gateway without a separate reviewed decision.

Exact proposed command (namespace read only; no Gateway main, TCP/UDP listener,
Core request, Docker API command, database access or source modification):

```sh
docker compose --env-file .env.dev.local \
  -f compose.dev.yaml -f compose.dev.real.yaml -f compose.dev.observer.yaml \
  -f compose.dev.gateway.yaml -f compose.dev.gateway-diagnostic.yaml \
  --profile gateway run --rm --no-deps --entrypoint node gateway -e \
  'const f=require("node:fs");const a=f.readlinkSync("/proc/self/ns/net");const b=f.readlinkSync("/run/nickhosting-host-proc/ns/net");if(a!==b)process.exit(1);for(const n of ["tcp","tcp6","udp","udp6"])f.readFileSync("/run/nickhosting-host-proc/net/"+n);console.log("Independent namespace preflight passed");'
```

Reverify the private recorded host-process identity before the command and verify
the one-off container is gone afterwards. Rollback is its automatic `--rm` removal;
the running dev project and private Compose selection are unchanged. Stop and
report either result. A successful diagnostic does not approve relaxing permanent
Gateway confinement or prove routing, full observer access, or sleep/wake.
Missing Owner Gateway policy and backend pool remain separate prerequisites.


### Approved AppArmor diagnostic — passed (2026-10-10)

The Owner approved the exact one-off command above on condition that the existing
Pterodactyl stack remain unchanged. Reviewed starting HEAD:
`bef135d764885b49b21d9cf847470fd55d82b1aa`. Host-process identity, namespace, daemon,
clean worktree and unchanged private Compose selection were reverified.

The documented command completed with exit **0** and
`Independent namespace preflight passed`. Only the temporary diagnostic used
`apparmor:unconfined`; nonroot UID, dropped capabilities, seccomp and other
controls were retained. This supports AppArmor confinement as the cause of the
previous namespace-read denial under the same anchor and service configuration.
It does not establish full observer readiness, routing or sleep/wake.

The temporary container was automatically removed. Panel and Wings container
IDs/images/start times/restart counters/network attachments matched the read-only
baseline. No Pterodactyl API request, server operation, existing-container restart,
network configuration or production file change was performed. Existing dev
services remained healthy; HTTPS returned 200. No permanent Gateway was started,
no game/nonce listener opened and the diagnostic overlay was not added to the
private Compose selection.

A permanent confinement change is **not authorized** by this diagnostic approval.
Keep the default Gateway profile unchanged pending a separately reviewed choice
of confinement. Owner Gateway settings, pool/route selection and actual endpoint
approval remain necessary for operational routing.

### Mixed direct/Gateway allocation pools and next activation proposal

One managed provider node can now retain explicit direct allocations on the
Gateway ingress IP at different ports, alongside private Gateway backend
allocations. This removes a NickHosting address-wide restriction; it does not
change Wings, allocate provider ports, open listeners, or authorize such actions.
The exact current private endpoint proposal is recorded in
`.codex/local/gateway-live-plan.json` (gitignored). Both pin-to-route and
route-to-pin collision checks cover durable claims, disabled entries and both
Wings transports. Live allocation/listener/namespace checks remain mandatory.

`compose.dev.gateway-live.yaml` is a **prepared, unapplied** overlay for the next
separately approved step. It changes AppArmor only for the permanent development
Gateway, preserving nonroot execution, dropped capabilities, seccomp and
`no-new-privileges`. It also defines `nickhosting-dev-node-probe-1`, a 128 MiB,
0.25 CPU, unprivileged TCP nonce responder on an explicitly configured private
backend address. The responder has no credentials, Docker socket, host-proc or
persistent mounts, retains default AppArmor, and refuses wildcard, loopback,
public, ambiguous or privileged-port configuration. It reuses the M3 bounded
nonce protocol and has a round-trip health check and signal-driven shutdown.
Neither overlay is selected automatically; the previous diagnostic overlay must
not be used with `up`.

This proposed responder is necessary to prove that the exact backend address is
reachable while a game server sleeps. It is not a replacement proxy or provider.
The first backend still requires actual game readiness and binding evidence.
The permanent AppArmor exception removes one confinement layer and needs explicit
Owner approval; the successful one-off diagnostic did not grant it. Existing
Docker socket issue #22 and SFTPGo release gate #18 remain open.

After approval of the private exact plan, recheck process-anchor identity,
container-name availability, free RAM/disk and fresh provider/Docker/host port
inventories. Preserve the existing private environment and append the normal
Gateway and live overlays, with approved `NH_DEV_NODE_PROBE_ADDRESS` and
`NH_DEV_NODE_PROBE_PORT`. Configure only the existing development Gateway settings
using the protected Owner API; preserve hosts, nodes, runtime mappings, accounts
and data. The Owner still selects the pool and subsequent server/route settings.

```sh
# Only after the new operation-specific approval and private setting preparation.
docker compose --env-file .env.dev.local --profile gateway config --quiet
docker compose --env-file .env.dev.local build api web
docker compose --env-file .env.dev.local --profile gateway run --rm --no-deps \
  --entrypoint node gateway -e 'const f=require("node:fs");if(f.readlinkSync("/proc/self/ns/net")!==f.readlinkSync("/run/nickhosting-host-proc/ns/net"))process.exit(1);for(const n of ["tcp","tcp6","udp","udp6"])f.readFileSync("/run/nickhosting-host-proc/net/"+n);'
docker compose --env-file .env.dev.local up -d --no-deps --wait api worker web
docker compose --env-file .env.dev.local --profile gateway up -d --no-deps --wait node-probe
docker compose --env-file .env.dev.local --profile gateway up -d --no-deps --wait gateway
```

Start with zero routes; verify the authenticated control plane and private nonce
round trip. This establishes service readiness only, **not game forwarding or
sleep/wake acceptance**. A later explicitly selected pilot route needs its exact
public bind approval, a ledger-proven new managed server, resource admission,
real installation/readiness, retained-listener/status-without-wake and intentional
join tests. No unrelated/direct server may be imported or changed. Do not add a
whole range of listeners: each listener belongs to a registered managed route.

Rollback stops only `gateway` and `node-probe`, removes the two Gateway overlays
from the private Compose chain, and recreates only dev API/worker with the previous
settings. Wait at least 31 seconds for leases to expire. Restore changed Owner
Gateway settings from their private pre-change record. Preserve all data, tokens,
allocation inventory and other containers. No prune, volume deletion, database
reset, or change to Pterodactyl/Wings/network/firewall/NPM is part of this proposal.

### Approved persistent Gateway activation — 2026-10-10

The Owner explicitly approved the permanent development Gateway AppArmor exception,
private TCP responder and scoped API/worker/web recreation at reviewed HEAD
`d5234ff31b97289e68eaa742984ad8c66c68e570`. The clean worktree, independent process
anchor/namespace, Docker daemon identity, provider node identity, free resources,
zero routes and absent endpoint/name collisions were reverified before activation.

The private Compose chain now includes the normal Gateway and live overlays.
Application and web image builds completed; the nonroot namespace preflight passed.
Only dev API/worker/web were recreated. PostgreSQL, Redis, Vite, mail and all
review data were preserved. The Owner saved the four Gateway settings through an
authenticated browser PATCH (HTTP 200); their exact values were verified before
starting Gateway. No Owner session was extracted or synthesized. Hosts, managed
nodes, runtime mappings, managed servers and users matched their pre-activation
hashes. Gateway/probe are persistent services with restart policies.

An actual Compose creation failure exposed an unquoted flow-list `tmpfs` value:
commas produced separate mount entries and Docker rejected `noexec` as a path.
Quoting the intended single mount fixed it, without changing resource/permission
scope. A focused regression checks the parsed `tmpfs` exactly. The first ad-hoc
observer diagnostic also used a package alias from the workspace root, where it
was not resolvable; rerunning with the absolute module path passed. Neither failed
attempt changed Pterodactyl or created a game listener; temporary diagnostic
containers were removed automatically.

Persistent Gateway checks passed: authenticated configuration/snapshot HTTP 200,
zero routes, unauthenticated HTTP 401, private Unix readiness, full Docker/host
observer and nonce round trip from its actual namespace. The responder retained
default AppArmor; only Gateway uses the approved unconfined profile. Both services
were restarted individually to check clean shutdown and recovery; Gateway correctly
reported not-ready during its lease-drain period. The actual private responder
endpoint remains in the ignored plan. No production network, Pterodactyl/Wings,
NPM, DNS, router, firewall or game-server resource was changed.

**Scope of success:** service/control-plane and private reachability readiness.
There are still no Gateway game routes/listeners and no new provider allocations.
The Owner still selects the allocation pool. A separately approved exact public
pilot and proven test-owned server are required to establish real forwarding and
Minecraft sleep/wake on this deployment. The existing service approval remains
valid; this is not a request to reapprove the completed activation.

Final check: all nine active dev services healthy, HTTPS and configured WSS HMR
working after recreation/restarts. The existing Wings container reports an
unhealthy Docker healthcheck (prior health not captured); its identity, start time,
restart counter and networks are unchanged. This requires read-only diagnosis
before relying on a live game pilot, not an unapproved production restart.

Read-only follow-up: the Wings Docker healthcheck targets a different port from
its configured API. The configured API returns HTTP 401 without credentials;
Wings is responding. Its healthcheck mismatch is documented privately and left
unchanged, outside this dev activation's mutation scope.

## 2026-10-10 — Inherited sleep timeout configuration

The independent development database has migrations
`020_sleep_policy_inheritance.sql` and `021_sleep_policy_owner_controls.sql`.
The first adds a boolean inheritance flag. The second separates Owner timeout/access
authority from ordinary-user preferences, preserving old explicit timeouts and
disabled policies as Owner baselines. The exact SQL and checksums were applied
transactionally through the existing dev
API container to `nickhosting_dev`, using the standard migration advisory lock.
Counts/content hashes of users, hosts, nodes, mappings, servers, Gateway routes,
Gateway states and platform settings were unchanged. No account reset, Owner
configuration write, provider call, container recreation or network change.

Before future image-based migration runs, rebuild the application image so its
baked migrations include 020 and 021, as required by the existing procedure. Ordinary dev
stop/start still uses persistent data and never automatically migrates or resets
it. Retain both migrations and review data on rollback; do not rewrite migration
history. Once policies use the new Owner controls, older application code cannot
enforce them: prefer a reviewed forward fix, or plan an explicit policy conversion
before running an older release. There is no automatic policy/schema downgrade.

Owner → Settings exposes global time and user control. Owner → Integrations exposes
game/runtime overrides. Server → Automation exposes Owner server overrides, or the
permitted ordinary-user preference; hidden is the default user mode. Inputs are
minutes: `-1` disables automatic idle sleep, while an explicit inheritance control
falls back to runtime/game/global defaults. `NH_GAME_IDLE_TIMEOUTS`,
`NH_DEFAULT_IDLE_TIMEOUT_SECONDS` and `NH_IDLE_TIMEOUT_USER_ACCESS` can lock defaults
using normal typed configuration precedence; real instance values should normally
be edited through Owner administration. Shorten-only users cannot disable or extend
a finite Owner timeout.

This feature does not create a game server, activate a public Gateway route,
certify an additional runtime/version or alter wake/manual-stop consent. At the
read-only pre-change check the Owner had saved a 2,000-pin pool; no managed server,
route or Gateway server state existed. A real pilot still needs an installed
Gateway-mode server with declared support, an explicitly configured route and the
existing collision/reachability/approval checks before a public bind.

## M5 follow-up — Automatic Gateway registration for new servers

This supersedes the manual-route prerequisite for **new eligible creations** in
prior activation notes; those historical zero-route observations remain unchanged.
A trusted integration's Gateway-mode creation now reserves immutable public routes
from the Owner-configured node pool and completes registration as part of the
existing durable provisioning job. The current deployment's one-address pool can
use this path without another per-server Owner route form. Multiple bind addresses
are deliberately rejected as ambiguous; there is no inferred interface or hostname.

The Owner creates the server in the WebPanel. Installation and any requested initial
start continue through Pterodactyl and M2 admission. The protocol policy is initialized
without granting automatic-start consent. Sleep/wake controls and consent remain in
Server → Automation; inherited timeout/access settings remain under Owner settings
and integration administration. Direct servers receive no Gateway routes.

Implementation validation uses disposable test schemas and provider fixtures only.
It does not authorize this agent to create a live test server, configure a real route
or open a public listener. The existing Gateway continues applying fresh collision,
identity, topology, reachability and game-readiness checks to registrations. A stored
route or delivered snapshot is reported as configured, not proof of external reachability.
No migrations, container recreation, network edits, DNS writes or Owner setting
changes are needed for this source update in the existing watched dev API/worker.
