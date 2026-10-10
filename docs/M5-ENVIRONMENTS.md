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
SFTPGo/Cloudflare/CurseForge authority and leave Gateway disabled. The simulator
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
