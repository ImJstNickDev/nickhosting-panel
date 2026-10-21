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

The development worker has a **2 CPU / 512 MiB** limit; API and other service
limits are unchanged. On 2026-10-18 the Owner approved raising only that worker
from 1 to 2 CPU for archive preparation. `docker update --cpus 2
nickhosting-dev-worker-1` applied the limit without restarting the container;
`compose.dev.yaml` preserves it on recreation. Rollback is the corresponding
`cpus: 1` setting and `docker update --cpus 1 nickhosting-dev-worker-1`. Neither
operation changes mounts, networks, ports or application data. Production
resource configuration is independent and was not changed.

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

`NH_MOUNTDATA_ROOT` selects the **host** persistence root for every Compose
environment and the SFTP state overlays; it defaults to `./mountdata`, relative
to the repository. For example, an approved external root still contains
`dev/`, `prod/`, `m1-tests/`, `m2-tests/` and `test-assets/`. Container targets
such as `/app/mountdata`, `/var/lib/postgresql` and `/var/lib/sftpgo` do not change.
Keep the value in the private Compose interpolation file and pass that same
root to host tooling. The shared host resolver reads the explicit environment
first, then only this field from `.env.dev.local`; it never loads its secrets
into a host command. Production tooling must explicitly select its production
environment/root.

Missing roots or service directories are errors, including for M1/M2 test
stacks. Preparation is a separate operation for new environments; never run it
to activate a copied environment or repair existing permissions. The dev helper
can create the default local root, but an external root must already exist.
SFTP helpers preserve their refusal to reuse existing state. The test helper
creates missing known paths and leaves existing ownership, modes and data alone:
`bash scripts/prepare-m2-test-directories.sh --owner-approved` (or `--m1` for M1).
It requires the storage root to exist and does not start test services.

Changing the variable alone is **not a storage migration**. Copy and validate
the offline state, verify the destination filesystem UUID in preflight, then
change references and recreate the approved consumers. The migration adds a
required read-only sentinel file bind with `create_host_path: false` to those
consumers. This prevents startup when that file is absent; it does not itself
verify a disk UUID. No systemd mount dependency is installed.
See [persistent storage relocation](STORAGE-MIGRATION.md) for the cutover and
rollback boundaries.

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

### Optional Cloudflare access in development

Real-provider mode keeps Cloudflare disabled by default. Set
`NH_DEV_CLOUDFLARE_ENABLED=true` in the private `.env.dev.local` to remove the
entrypoint's `development-disabled` token override. This opt-in requires real
provider mode; sandbox and invalid values are rejected. Save the actual API token
in **Owner settings → Credentials → Cloudflare API token** (`cloudflareApiToken`),
using the existing encrypted, write-only store. Do not put it in the environment
file or copy production credentials automatically. Other provider opt-ins and
production configuration remain unchanged.

Configure `cloudflareZoneId`, `dnsBaseDomain`, `dnsTarget` and a stable, independent
`dnsInstanceId` through Owner settings. The token should have DNS Edit permission
limited to the intended zone. Enabling access alone does not create records;
requested DNS operations use the real Cloudflare adapter, not a simulator. Check
existing pending assignments before activation. Real DNS writes require their
own explicit authorization.

After the configuration change, the scoped activation commands (requiring Owner
approval) are `docker compose --env-file .env.dev.local build api` followed by
`docker compose --env-file .env.dev.local up -d --no-deps --wait api worker`.
Preserve the complete running overlay chain and all of its private interpolation
files. In the current development stack, `COMPOSE_FILE` also includes
`compose.dev.viewers.yaml:compose.dev.sftp.yaml`; both commands above must additionally
include `--env-file .env.dev.viewer.local --env-file .env.dev.sftp.local` after the
main env-file argument. Omitting the SFTP overlay would restore the disabled SFTP
credential override in API/worker. Never remove the existing SFTP containers as
orphans. The deployment entrypoint is baked into the image; HMR alone cannot apply it.
Preserve the previous image ID and private environment file for rollback. Disable
the opt-in and recreate only API/worker to restore the credential lock; this does
not delete saved secrets or undo previously created DNS records.

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
   physical host, managed node and validated backend allocation pool. Configure the
   Vanilla runtime/egg mapping in `/owner/integrations/minecraft/runtime`, including
   the actual image policy, startup and egg variables.
   Configure the required metadata user-agent and exact trusted Wings WebSocket,
   upload and download origins through Owner settings where applicable.
4. In `/owner/integrations/minecraft/general`, enable the trusted `minecraft` module
   and choose its rollout. In `/owner/integrations/minecraft/versions`, select the Vanilla mapping
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
HTTP health port. `/readyz` checks the control-plane lease, control availability
and eligible listeners. Routes withheld for `backend_active_binding`, including
servers awaiting their first backend binding proof, are reported separately as
`withheldRoutes` alongside `configuredRoutes` and active `routes`; they do not make
the service unhealthy. Their safety checks and withheld listeners remain
unchanged. Zero-route readiness must never be reported as proof that forwarding or
sleep/wake works. See [Gateway diagnostics](M3-API.md#configuration-and-deployment-prerequisites).

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

### Physical observation cadence (2026-10-11)

The worker independently collects configured observer-owned hosts with a
one-second target cadence. Fresh database samples are shared by API/worker
admission, with a hard four-second age ceiling. No configured host is created
automatically. The collector does not require provider credentials. Failure leaves
no fabricated capacity; a request attempts a coordinated fresh observation and
rejects if no valid observation is available. The first collection uses a 250ms
CPU window; subsequent periodic ticks use counter deltas without that delay.
No new container, mount, service, migration or network attachment is introduced.

### Blueprint bridge 1.0 (2026-10-11)

The approved Blueprint extension is now connected to the existing real-provider
development environment. `docs/BLUEPRINT-EXTENSION.md` records activation,
rollback and validation. The webhook secret lives only in encrypted stores;
`POST /v1/provider-events/pterodactyl` uses signed machine authentication through
the existing same-origin ingress. No NPM, DNS, Compose or Gateway change is needed.
The worker maintains durable limits projections; Start falls back to the normal
provider API if synchronization is stale or invalid. No existing provider account
has been migrated to per-user keys: that consumer work remains in issue #25.
Rebuilding an image must include all current database migrations; starting the
stack still does not apply them automatically.

Blueprint 1.0.1 exposes the allowed NickHosting HTTPS origin under **Panel Admin →
Extensions → NickHosting**. Existing dev configuration migrates without re-entry;
subsequent saves use Blueprint database settings, not PHP configuration files or
worker restarts. Registered callback destinations are not automatically retargeted
when this field changes. The administration page displays actual pending events
and the last acknowledged delivery; saving a URL alone does not prove connection.

### Per-user provider credentials

See [ADR 0015](decisions/0015-provider-technical-accounts.md). The real-provider
runtime uses individual encrypted Client keys provisioned by Blueprint 1.1.0;
Owner settings retain the Application key but no longer request a shared Client
key. Only Pterodactyl technical usernames carry `nh-`; NickHosting profiles stay
unchanged. Apply migration 023 before activating the changed runtime. Enrollment
is recoverable and independent of the provider change-feed health loop.

An existing server is not automatically reassigned: its pinned previous provider
owner deliberately blocks use with a different technical identity until a scoped
handoff is approved and verified. Keep the old artifact and encrypted legacy
credential for reviewed recovery; do not reset development data or remove the
Blueprint browser/mail guards as a shortcut.

### Files editor dependency activation (2026-10-12)

The Files redesign adds CodeMirror dependencies to Web and `tar-stream`/`yazl`
to API. Source watchers do not install packages into existing development images.
A scoped development image rebuild and recreation of **only API and Vite** is
required for the complete editor/extractor. No migration, secret change, new
network/mount, upload policy or game-server operation is part of this change.

After operation-specific Owner approval, preserve each service's existing image
as separate local rollback tags, build the existing development target, then:

```sh
docker compose --env-file .env.dev.local config --quiet
docker image tag "$(docker inspect --format '{{.Image}}' nickhosting-dev-api-1)" nickhosting-dev-app:before-files-api
docker image tag "$(docker inspect --format '{{.Image}}' nickhosting-dev-vite-1)" nickhosting-dev-app:before-files-vite
docker compose --env-file .env.dev.local build api
docker compose --env-file .env.dev.local up -d --no-deps --wait api vite
```

Use the existing private Compose chain without dropping real-provider, observer
or Gateway overlays. `--no-deps` leaves worker, Gateway, web, PostgreSQL and Redis
running. The web ingress keeps its existing external network attachment. Expect
brief API/HMR disruption; game connections can be affected if Core is unavailable
long enough for Gateway leases to expire, although no power commands are sent.
Inspect API/Vite health, ingress HTTPS and dependency resolution after activation.
Do not use `down`, volume deletion, orphan removal or pruning.

Rollback requires restoring the previous source revision and recreating only
API/Vite with an ignored local override selecting their respective saved image
tags (API and Vite may have different old images). This is a scoped rollback,
not a database or provider rollback. Preserve private environment and all data.
Until approved and executed, report this activation as pending rather than
claiming the new dependencies are available in the running containers.

The Owner approved and completed this scoped activation on2026-10-12. API/Vite
are healthy; HTTPS and HMR were verified. Existing web/Gateway/worker/data-service
containers and network attachments were preserved. See the dated Files section
in [M5 validation](M5-VALIDATION.md) for results and remaining upload configuration.

### Concurrent file uploads (2026-10-12)

Owner **Settings → Resource policy → Simultaneous uploads** controls prepared
upload groups: default2, range1–6. `NH_UPLOAD_CONCURRENCY` is an optional explicit
environment override; leaving it unset keeps the Owner setting editable. This
limit applies per prepared group, with the existing API/database-pool and physical
storage admission limits still bounding total work. Upload origins and host
ingestion policy remain required; this setting does not replace them.

This change uses existing source watchers, dependencies and ingestion tables.
No image rebuild, migration, service restart, network change or data reset is
required. Preparation observes directories and storage once per group; individual
requests stream concurrently, with independent progress and cancellation. See
the [upload contract](M5-API-CONTRACTS.md) for scheduling and the accepted boundary
around external filesystem changes after preparation.

Before rolling back the API/browser change, let active transfers finish and close
unused groups. Preserve any uncertain ingestion claims for the existing reviewed
recovery process; do not delete claims or reset data merely to restore availability.
Restore matching API/browser source together. The original single-file endpoint
remains compatible, but older clients cannot resume a prepared group's entries.


### Bulk upload credentials (2026-10-12)

Blueprint 1.2.0 adds one Client API request for all signed URLs in a prepared
upload group. It uses the existing resource owner's technical account; no new
credential, setting, network, container or database migration is needed. The API
source watcher loads the matching private-cache code. An older extension's absent
endpoint retains the previous individual-URL behavior. Token expiry/API restart
refreshes unused credentials, not completed uploads. See the
[extension validation and rollback record](BLUEPRINT-EXTENSION.md#2026-10-12--120-bulk-upload-credentials).

## Optional private file viewers — 2026-10-13

The shared viewer engine uses a separate read-only SFTPGo account class and
transport configuration. It does not unlock external SFTP or reuse its secrets.
The [reviewable deployment proposal](M5-VIEWER-DEPLOYMENT.md) adds one private
service and an explicitly approved read-only Wings-data mount. It is not active
merely because the real Pterodactyl adapter is configured. No Blueprint update or
Panel/Wings configuration edit is required.

Until that transport is configured, existing text editing and downloads continue;
new preview dependencies load lazily and do not prevent API startup. New npm
packages require rebuilding/recreating API/Vite, and migration024 must be applied
explicitly to development before activating personal viewer preferences. No dev
database reset is needed. All activation steps, source permissions, risks and
rollback are documented in the linked proposal and require its exact approval.

The Owner approved and activated this proposal on2026-10-13. The dedicated
`nickhosting-dev-sftpgo-viewer-1` service is healthy, private and read-only; API/Vite
were rebuilt/recreated and additive migration024 applied without resetting dev
data. Use both environment files and the complete overlay chain in the
[activation record](M5-VIEWER-DEPLOYMENT.md#approved-activation-record--2026-10-13)
for subsequent lifecycle commands. Existing user-facing SFTP and issue18 are
unchanged; no production deployment is implied.

## Development Vite memory recovery — 2026-10-14

The development Vite service has a 1536 MiB memory ceiling. The previous 768 MiB
ceiling was reached during dependency optimization: the cgroup recorded one OOM
kill and the supervisor logged `web exited (SIGKILL)`. The container remained
running but unhealthy, with no Vite listener; ingress therefore returned HTTP502.
A running container or the ingress-only health endpoint does not prove frontend
readiness. Inspect Vite health and the actual HTTPS application response.

Applying this changed ceiling to an existing dev container requires specific
Owner approval. The reviewed recovery commands retain its identity, mounts,
network address and image, with no Compose recreation or provider operation:

```bash
docker update --memory 1536m --memory-swap 3g nickhosting-dev-vite-1
docker restart --time 20 nickhosting-dev-vite-1
```

The combined RAM/swap ceiling follows Docker's default relationship for this
Compose memory limit; it does not enable host swap. Verify available host memory,
the exact Compose project/service labels and current resource settings first.
Check Vite's health, child process, memory events and HTTPS after recovery.
Rollback of the resource change is `docker update --memory 768m --memory-swap
1536m nickhosting-dev-vite-1` (restoring the prior OOM risk); no database or image
rollback is involved. These commands were proposed before approval; the completed
activation is recorded below.

Preparation checks: independent configuration review found no must-fix issue;
`scripts/dev.sh pnpm exec vitest run scripts/deployment-config.test.ts -t
'development'` passed 11 tests (33 unrelated cases skipped). Compose parsing was
read-only. `git diff --check` passed. The source/limit change does not activate
itself; approval and activation were still pending at the preparation stage.

### Approved recovery completed

The Owner approved the exact update and Vite-only restart on2026-10-14. Both
commands above succeeded. Readback confirmed a 1610612736-byte RAM ceiling and
3221225472-byte combined RAM/swap ceiling; no host swap was enabled. Container ID,
image, sorted bind mounts, network membership and IP remained unchanged, with no
published ports. No other service was restarted or reconfigured.

Vite became healthy. HTTPS `/`, `/@vite/client`, `/src/main.tsx` and the shared
JSON/Datagrid document modules returned200. A fresh headless Firefox session
rendered `/login`, connected to the HMR WebSocket, and recorded no page JavaScript
errors or HTTP5xx responses. The browser required the existing user-local test
library path after an initial launch failed to find GTK; no packages were installed.
Post-check cgroup usage was about608MiB (peak628MiB), with zero OOM events since
restart. These are observed recovery readings, not a guarantee against all future
optimizer peaks. No authenticated provider action, game-file change, migration or
test asset creation was performed.

## User-facing development SFTP — activated 2026-10-14

The Owner selected `sftp.dev.hub.nickhost.ing`; production may later use
`sftp.hub.nickhost.ing`. [User-SFTP preparation](M5-SFTP-DEPLOYMENT.md) supplies
`compose.dev.sftp.yaml`, separate state/credentials and the exact activation
boundary and completed validation. After additional Owner approval, only API and
worker were rebuilt/recreated; the users-SFTP service and both application services
are healthy. The private read-only viewer service is unchanged. Real LAN SFTP
write/read/rename/cleanup and new-login revocation checks passed for the one
explicitly mounted managed server. TCP2023 is published on the approved host
address. The advertised hostname still does not resolve from this host; no DNS,
router or NPM changes were applied. Issue #18 remains a production-release gate.

## Minecraft identity/multiprotocol activation — 2026-10-14

Owner authorized the necessary development migrations and restarts for this task.
Only the existing dev application stack was changed. A private, permission0600
PostgreSQL custom-format backup was taken before migration031. API/worker were
stopped, the explicit one-off development migration applied031, then API/worker
were recreated using all seven existing real-provider/observer/Gateway/viewer/SFTP
overlays. The prior application image remains tagged
`nickhosting-dev-app:before-minecraft-multiprotocol`. Database/accounts, two managed
servers, one runtime mapping, signed history, mounts, networks and credentials were
preserved. The canonical integration is now `minecraft`; Java's Gateway handler
remains `minecraft-java`.

The first Compose invocation failed interpolation because the viewer overlay's
private environment file was omitted; it created no resources. The migration ran
with the documented base environment; recreation then explicitly included both
private viewer/SFTP environment files and all existing overlays. No orphan removal,
volume deletion, network change, production deployment or provider mutation occurred.
API/worker/Vite were healthy and development HTTPS returned200 after activation.
Vite used the existing source/catalog hot reload; no frontend image rebuild was needed.

Gateway restart exposed an existing second route with no reachability proof and a
manually stopped backend. This must not be promoted into a valid proof by migration.
Its refusal originally aborted the whole snapshot, including an independent proven
sleeping route. The narrow correction isolates `backend_active_binding` rejection
per server (all its port roles together), while retaining global snapshot/revision/
lease and other failure handling. The unproven server still requires a normal
Owner-initiated first start to establish its real backend proof; no game was started
by the agent. See [protocol validation](MINECRAFT-MULTIPROTOCOL.md) for final results.

Rollback of migration031 requires stopping the updated application processes and a
reviewed restore/reverse migration, together with the prior image/source. The private
backup is a recovery artifact, not permission to overwrite subsequent review data.
Never reset the database or rewrite signed evidence to reverse the display identity.


## Profile photo activation proposal — 2026-10-16

Prepared and tested before approval; completed activation is recorded below. The API adds a direct `pngjs` dependency and
migration 036 for uploaded thumbnails, so source hot reload alone is insufficient.
An isolated feature worktree keeps the running dev checkout unchanged until the
Owner approves activation. Vite needs no new dependency or image; source HMR
supplies the UI after activation. API and worker share the development image.

Read-only inspection found dev migrations only through 034. The ordinary migration
runner must therefore apply both pending files in order:

- 035 adds the integration identity to existing content-source/staging rows and
 indexes, and migrates old Minecraft content-setting keys to generic content keys,
 preserving any existing generic override. It belongs to the prior content-policy
 implementation; this is not silently treated as a photo-only migration.
- 036 adds `user_profile_photos` with a user FK, bounded thumbnail bytes, revision
 and timestamp. It does not replace Better Auth identity/provider fields.

Proposed activation, requiring specific Owner approval:

1. Recheck reviewed HEAD, clean live checkout, exact dev container labels, pending
   migration checksums, topology and free resources. Preserve the current API/worker
   image as `nickhosting-dev-app:before-profile-photo`.
2. Build the reviewed worktree's Docker `development` target as
   `nickhosting-dev-app:local`; running services remain unchanged during the build.
3. Stop only dev API/worker, then take a non-overwriting private custom-format
   `pg_dump` of the existing dev database. Retain all other services and data.
4. Run the explicit one-off `migrate` tool on existing dev networks, applying
   only 035/036. Fast-forward the live source checkout to the reviewed commit.
5. Recreate only API/worker with `up -d --no-deps --no-build --wait api worker`.
   Preserve all current overlays and all three private environment files in order:
   `.env.dev.local`, `.env.dev.viewer.local`, `.env.dev.sftp.local`.
6. Verify API/worker health, logs, applied migrations, unchanged mounts/networks,
   HTTPS and Vite HMR. The Owner uploads their own profile photo through Profile.

The exact host command plan and baseline fingerprints are kept in ignored local
state. No Vite/Gateway/SFTP/Pterodactyl/Wings restart, published port, DNS, network,
production deployment or user/game-data reset is part of this proposal. A temporary
migration container is the only additional container. API and worker can be briefly
unavailable during their replacement; no server power commands are requested.

If activation fails, stop the changed API/worker, retain logs and additive migration
history, restore the prior reviewed source/image, and recreate only those services
with the same private configuration. The pre-photo application is compatible with
retaining these added tables/columns. Do not restore the database snapshot over
subsequent data or delete uploaded photos as routine rollback; a data restore needs
separate review. Approval is not inferred from earlier feature deployments.


### Profile photo activation completed — 2026-10-16

The Owner approved the scoped procedure and rollback. The live clean checkout was
verified at `13d7938`, and reviewed feature `fad8e43` was built from its isolated
worktree before stopping any service. All seven existing Compose overlays and
three private environment files were retained. API/worker mounts, networks and
published-port configuration matched the preflight plan.

Only dev API/worker were stopped. A private, non-overwriting custom-format database
backup was created and verified with `pg_restore --list`. The explicit temporary
migration container applied exactly 035/036; all stored migration checksums matched
the reviewed SQL. User/account/encrypted-secret/rollout fingerprints and managed
server count were unchanged. Content settings matched precisely the 035 key
conversion, preserving existing generic values.

The live checkout fast-forwarded to `fad8e43`, then only API/worker were recreated
with the new development image. Both are healthy with zero automatic restarts and
no published host ports. Their mounts/networks and private configuration files
remain unchanged. The temporary migration container was removed by `--rm`; the
private backup and `nickhosting-dev-app:before-profile-photo` image are retained.
Vite received the source through HMR; no Vite image update/restart was needed.

A fresh Firefox session verified HTTPS login 200, safe web configuration 200,
anonymous photo access 401 and the HMR WebSocket over WSS. No page JavaScript errors
or HTTP 5xx responses were recorded. This read-only live smoke does not impersonate
the Owner or upload a photo; authenticated upload/crop/removal evidence remains the
six isolated Chromium/Firefox journeys, and the Owner can now use Profile directly.

Other container identities/images/mounts/networks/ports were preserved. Three
unrelated containers already in restart loops continued their existing automatic
restarts; no operation targeted them. Dev Gateway and the unused sandbox provider
already reported unhealthy at preflight and retain that status; they were not
restarted or reconfigured for this feature. No Pterodactyl/Wings, DNS, real game
files, production deployment or test-server creation/cleanup was involved. Issue18
remains unchanged. No rollback was required; the scoped recovery plan above remains
available without resetting the database.

## Backup workflow activation proposal — 2026-10-17

Prepared source and isolated evidence are described in [Backups](BACKUPS.md). This
section is a proposal, **not an activation record**. No live backup, restore or
server power action is included.

Required operation-specific activation:

1. Recheck reviewed HEAD and existing container identities/topology. Tag the current
   API/worker image `nickhosting-dev-app:before-backup-events`. Preserve a private,
   non-overwriting copy of the existing Blueprint extension/configuration and the
   verified 1.4.0 package. Existing settings/account links must survive the update.
2. Build only the dev API image (shared by worker). Stop only dev API/worker and
   make a private custom-format `pg_dump` of the dev database; verify its inventory.
3. Explicitly run the development migration tool, applying only 037. It adds tables,
   columns and notification triggers; it does not reset users, servers or job history.
4. Install reviewed `build/blueprint/1.5.0-reviewed/nickhosting.blueprint` using the
   existing native Blueprint installer in the existing Panel container. The sole
   extension migration creates its owned backup-event marker table. Native installer
   cache/ownership housekeeping affects the shared Panel, so use a suitable window.
5. Recreate only dev API/worker. Vite uses source HMR; no dependency/image update is
   required. Verify health, unchanged mounts/networks/ports, migration checksums,
   Blueprint capability discovery, callback delivery path and HTTPS. Read-only
   capability/list checks are sufficient; the Owner initiates any real backup test.

Core command sequence (execute only after approval, from the project directory):

```bash
docker image tag sha256:354193e0234c3dad5753f2b8cde5d1858ceddf49e3ed2523a77da38722aa8356 nickhosting-dev-app:before-backup-events
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local build api
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local stop api worker
# Private non-overwriting pg_dump, then inventory verification.
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local --profile tools run --rm --no-deps migrate
docker cp build/blueprint/1.5.0-reviewed/nickhosting.blueprint pterodactyl-panel-2:/app/nickhosting.blueprint
docker exec -w /app pterodactyl-panel-2 blueprint -install nickhosting
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local up -d --no-deps --no-build --wait api worker
```

All existing Compose overlays come from the private `COMPOSE_FILE`; do not replace
that chain with the base file alone. The temporary migration container is removed
by `--rm`; its existing project networks remain. Preserve prior packages/images
and all private backups. No Wings restart, NPM/DNS/network/port change, production
NickHosting deployment, database reset or game data mutation is authorized here.

If activation fails, retain logs and additive schema. Do not downgrade an active
new-format backup/restore job: first let recovery reach a terminal state or review
that exact operation. Drain pending backup notifications before downgrading the
receiver; older Core cannot consume that event family. With no active affected
jobs or pending backup deliveries, revert application source,
restore the tagged prior API/worker image and recreate only those services with the
same full configuration. Restore Blueprint 1.4.0 with the same native installer;
retain its added event table for later reviewed retirement. Do not overwrite the
database with the snapshot over newer changes as routine rollback. Installing
Blueprint can briefly affect Panel requests; replacing API/worker interrupts
NickHosting requests/jobs, whose durable state must be retained.

Read-only preflight observed the existing dev Gateway unhealthy before activation.
This proposal does not claim Gateway/live resume verification or repair that
separate health issue. API, worker, Vite and the remaining dev services were healthy.


## Backup workflow activation completed — 2026-10-17

The Owner approved the proposal above at source HEAD
`814e26fc116e2a4e3da90aba5d78d82e3869cd98`. The exact procedure completed:
API/worker were rebuilt and recreated with all three private environment files
and seven existing Compose overlays. New shared image:
`sha256:ab9f9f2495fa509463eab82b697634ec80adea0d76db0cf304be06ffa0e1a25a`.
Only `037_backup_events.sql` was applied to the development database; its recorded
checksum matches source. The temporary migration container was removed normally.

Blueprint 1.5.0 was installed through its native installer, which completed at
02:15:42 UTC and reloaded the native queue worker. Only its owned
`2026_10_17_000004_nickhosting_backup_events` migration was added. The reviewed
package hash matches the installed archive. Prior image/package, private extension
configuration archive and a non-overwriting database dump remain available. The
dump inventory was verified; no restore rehearsal or database reset was performed.

Both dev services are healthy with zero restarts. Comparison of all 112 containers
confirms that only API/worker were recreated; mounts, networks, published ports and
environment fingerprints were preserved. Three unrelated pre-existing crash loops
continued automatically; none was operated on. Dev users/accounts, encrypted
secrets, settings, rollouts and managed-server identities match the preflight
snapshot. Panel extension settings, technical accounts/keys and metadata of all
28 provider servers also match. The pre-existing unhealthy dev Gateway was not
restarted or repaired by this activation.

Authenticated discovery reports 1.5.0 and `backupEvents: true`; anonymous discovery
returns 401. A transient worker feed/reconciliation warning was recorded during
startup; subsequent read-only health returned zero pending events and the shared
feed recovered a fresh health timestamp. This proves discovery/feed health, not
an actual backup completion callback. No game backup, restore, power command or
file mutation was performed. Owner-triggered real backup/restore testing remains.

Fresh Firefox smoke: public HTTPS and web configuration returned 200, anonymous
protected-photo access returned 401, HMR used WSS, and there were no page exceptions
or HTTP 5xx failures. No rollback was needed. The scoped rollback conditions above
remain applicable, including draining new backup deliveries before downgrading.

## Unified Activity activation proposal — 2026-10-17

Implementation: [Activity](ACTIVITY.md) and [SFTP transport](SFTP-ACTIVITY.md).
This is a **pending proposal**, not an activation record. Source HMR already covers
the WebPanel and application handlers; no frontend image/dependency change is needed.

Read-only preflight verified `nickhosting-dev-api-1`, `nickhosting-dev-worker-1`,
`nickhosting-dev-vite-1` and `nickhosting-dev-sftpgo-users-1` healthy. The API and
user-SFTP service share `nickhosting-dev-data`. The existing Gateway is unhealthy,
as before this work; Activity does not change it. The three proposed Event Manager
names below returned 404; the dedicated event secret is absent. The configured
user-SFTP instance exists and its management origin is `http://sftpgo-users:8080`.

Operation-specific approval would authorize:

1. Tag the current API/worker image, build only `api`, stop only dev API/worker,
   save a private non-overwriting dev `pg_dump` and verify its inventory. Apply
   **migration 038 only** with the explicit migration tool (verify applied checksums
   and that 038 is the sole pending migration before execution; four additive indexes;
   no table data rewrite), then recreate only API/worker. Index creation can briefly
   lock writes, which is why the application processes are stopped. Preserve every
   current overlay, network, mount, account, secret and job.
2. Generate a dedicated random event secret and store it encrypted through the
   existing `storeSecret` contract as `sftpgoEventSecret`. Do not reuse the SFTP API
   key or reveal either secret in logs. Prepare the three JSON objects using
   `deploy/sftp-activity-config.ts`, with the configured instance UUID and callback
   **`http://api:3001/v1/provider-events/sftpgo`** on the existing internal network.
3. On the existing **user-SFTP** service only, POST the two actions
   `nickhosting-activity-http-v1` / `nickhosting-activity-retry-v1` and then the rule
   `nickhosting-activity-v1` through `/api/v2/eventactions` and `/api/v2/eventrules`.
   The exact generated configuration and rollback endpoints are documented in
   [SFTP Activity](SFTP-ACTIVITY.md#exact-activation-proposal--requires-owner-approval).
   Abort on a name collision. No service restart, users, mounts, ports, filesystem
   permissions or game-file mutations are part of installing these rules.
4. Verify health, index/migration checksums, unchanged topology and authenticated
   callback connectivity. Do not create artificial file operations on a live game
   server. The Owner can upload/rename a file through their SFTP client afterward
   to verify native event delivery in Activity. This live test is not yet claimed.

Commands for the reviewed application activation:

```bash
docker image tag sha256:ab9f9f2495fa509463eab82b697634ec80adea0d76db0cf304be06ffa0e1a25a nickhosting-dev-app:before-unified-activity
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local build api
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local stop api worker
# Private non-overwriting dev pg_dump and pg_restore --list verification.
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local --profile tools run --rm --no-deps migrate
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local up -d --no-deps --no-build --wait api worker
```

Risks: a brief API/worker interruption, bounded background notification traffic,
missed SFTP notifications if both HTTP attempts fail. The transport has no durable
outbox; it does not guarantee a complete audit history during outages. Rollback:
remove only the three newly created SFTP objects in rule-before-actions order,
remove the dedicated secret only if this activation created it, revert the Activity
application change and restore the tagged API/worker image with the same overlay
chain. Retain the additive indexes, database contents and audit history. No database
restore over newer data, broad cleanup or production mutation is authorized.

### Unified Activity activation completed — 2026-10-17

Owner approved the preceding exact plan at reviewed source
`ccac6824d45674918fc0799b67bc70241234d163`. Activation completed without rollback.

- Rechecked clean branch/HEAD, current Compose identities and complete overlay chain;
  all applied migration checksums matched and only 038 was pending. Saved the prior
  image as `nickhosting-dev-app:before-unified-activity`.
- Built the API image, stopped only API/worker, saved a private non-overwriting
  custom-format dev database dump (2,109,039 bytes) and verified its inventory.
  Applied exactly `038_unified_activity.sql`; the temporary migration container
  was removed normally. No restore or reset was performed.
- Recreated only API/worker on image
  `sha256:5d14e76c202683b95b193fc81f221a936be9b79004b823bc2ec39b9560ca43d7`.
  Both are healthy with restart count 0. Mounts, networks, published ports and
  environment values match the previous containers; no other container was replaced.
- Stored the dedicated callback secret encrypted and installed exactly the two
  named actions and one rule. Persisted readback matches generated configuration,
  normalizing SFTPGo's omitted `skip_tls_verify:false` field only. Private payloads
  and the creation/attempt ledger remain under the development application's
  `sftp-activity-config` directory. No secret was printed or committed.
- User-SFTP remains healthy in its original container without restart. From that
  container, callback HTTP received 403 with a wrong secret and 200 with the real
  secret; an unbound probe identity returned `ignored:true` and inserted no audit.
  This proves internal DNS/TCP/HTTP/authentication, not a native filesystem event.
- User accounts, settings, SFTP credential records and all prior encrypted secrets
  retain matching fingerprints. A full managed-server comparison initially detected
  changes; comparison against the saved dump isolated them to normal worker
  `last_observed_at`/`updated_at` timestamps. Provider identities and other fields
  are unchanged. Docker mount comparisons were normalized by destination because
  Docker returned a different array order; contents were identical.
- Fresh Firefox smoke: HTTPS 200, web configuration 200, anonymous Activity 401,
  secure HMR WebSocket, zero page exceptions or HTTP 5xx. Read-only scoped Activity
  query returned five records with pagination in 89 ms (single smoke, not a benchmark).
  Inspected warnings were expected preflight 404 and rejected-authentication 403;
  worker logs had no warnings/errors in the inspected activation interval.

No real game files, SFTP users, Pterodactyl/Wings, DNS/NPM, mounts or host networking
were changed. The pre-existing unhealthy dev Gateway was left untouched. The Owner
can now upload/rename/delete a chosen test file through SFTP and inspect server
Activity to verify native notifications. That filesystem-delivery test remains
pending; no fake success records were inserted. The earlier isolated test results
and SFTP transport/outage limitations remain unchanged.

## Automation activation — 2026-10-17

The Owner approved required development migrations/restarts for Automation.
Verified the exact `nickhosting-dev` API/worker/Gateway identities, current mounts,
networks and published ports. All 38 existing migration checksums matched; only
039/040 were pending. Preserved the old API/worker image as
`nickhosting-dev-app:before-automation` and private container inspection records.

Built the dev API image using the existing full Compose overlay chain and all
three private interpolation files. Stopped only API/worker, saved a non-overwriting
private custom-format development database dump (2,136,980 bytes), and verified
its inventory. Explicit tools-profile migration applied exactly
`039_gateway_automation_preferences.sql` and `040_schedule_calendar.sql`.
The one-off migration container exited and was removed normally. Recreated only
API/worker; restarted the existing dev Gateway under the same authorization.
Vite uses existing source/catalog hot reload; no frontend image rebuild required.

All 40 applied checksums match source. API and worker are healthy; HTTPS returns200.
Mounts, network memberships and published ports match pre-activation records.
No schedules were created in the live dev database by verification. No game power,
file, backup, Blueprint installation, Wings/Panel configuration, DNS or NPM
operation was performed. The backup and private records remain ignored.

Gateway was unhealthy before activation. Its initialization transiently failed
while API source was reloading, then recovered; the exact transient cause was not
logged. Read-only investigation shows Core communication working and three of
four routes listening. One stopped server has no retained backend-reachability
proof, so its listener is correctly withheld with `backend_active_binding`.
It needs its ordinary first manual startup to establish that proof. No startup
was performed and global Gateway health must not be reported green. Other stopped
routes retain their existing fake listeners. This operational prerequisite is
separate from Automation's isolated tests.

Lifecycle commands used:

```sh
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local config --quiet
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local build api
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local stop -t 20 api worker
# Verified private pg_dump; no restore/reset.
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local --profile tools run --rm --no-deps migrate
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local up -d --no-deps --wait api worker
docker restart --time 20 nickhosting-dev-gateway-1
```

Rollback requires inspecting/draining or reconciling current operations before
reverting application code/images. Additive columns can be retained; calendar
schedules/new manual occurrences must not be handed to an incompatible old worker.
Do not reset the database or restore over new review data. See
[Automation](AUTOMATION.md). SFTPGo #18 and the separately documented Blueprint
installer ownership problem remain unchanged release/deployment blockers.

## 2026-10-17 — Independent automatic-start pause

Migration `041_automatic_start_pause.sql` is applied to the existing development
DB using the standard migration runner and advisory lock. It adds a per-server
pause flag with conservative audit backfill; it does not reset accounts, modify
provider records or rewrite lifecycle state. Updated API/worker source loads via
the existing watcher. Future image-based deployments must include migration041
and apply it before updated services serve requests.

A separate, narrowly guarded development-state repair restored fresh observation
for the reported running server whose old Paused action had incorrectly written
manual-stop intent. The explicit pause stayed enabled; private before/after
receipts are retained. No direct provider power command was issued. Restored
idle tracking can perform the already configured automatic stop normally.

Rollback: keep the additive schema and receipts. Prefer a forward correction;
an older application does not honor the new pause flag, so do not roll back
code on a live stack without an explicit plan to preserve automatic-start
suppression. No production deployment was performed.


## 2026-10-18 — World transfer redesign: development preparation

The existing Owner authorization for Minecraft development migrations/restarts
covers the development preparation below. A private `pg_dump -Fc` backup was
validated with `pg_restore --list`; all 41 existing migration checksums matched
source, with only `042_content_source_seals.sql` pending. The explicit runner
applied exactly migration 042. It adds a nullable source-seal column and an object
constraint; accounts, configuration, jobs and existing uploads were not reset.

Commands executed, preserving every current environment overlay:

```sh
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local build api
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local --profile tools run --rm --no-deps migrate
```

The one-off migration container was removed normally. API/worker source loads
through the existing watchers; no explicit service restart/recreation was needed
for this preparation. API, worker, Vite and web are healthy, HTTPS returns 200,
and anonymous `/v1/me` returns 401. Existing networks and published ports remain
unchanged. Worker quota remains 2 CPU; no game files or provider records were
mutated. The old image and a private topology/database record are retained.

The Owner approved the reviewed
[extension-only update](../extensions/nickhosting/UPDATE-INSTALLED.md) and scoped
rollback. It applied the pinned 1.6.0 package to twelve extension-owned files and
ran only its additive receipt-table migration. The old files, owners and modes
are preserved in a private rollback manifest. No native installer, global cache
clearing, Panel/Wings restart or game-volume traversal ran. Unsupported bridge
installations still retain the prior staged Fileman path. A real latency result
requires an Owner import/delete test; fixture success and local streaming
throughput do not establish a provider latency bound. The existing native
installer remains blocked by its observed game-volume ownership bug.

Rollback keeps additive migration 042 and the extension receipt table. Reconcile
or finish new in-flight archive operations before reverting the application;
older workers do not understand their pinned receipts. Do not reset the database,
restore over new review data, or delete uncertain scratch automatically. The
extension updater can restore only its own verified files from its private
manifest. No production Compose deployment is included.

Post-activation read-only smoke: authenticated discovery reports version 1.6.0
and `fileOperations:true`; scoped capabilities report inspection, guarded delete
and archive commit. A real inspection of an existing directory and
`server.properties` matched the exact managed provider identity. Its first request
took 356 ms; this is inspection latency only, not a deletion benchmark, and is
additional evidence against claiming an already proven 300 ms end-to-end bound.
No game mutation or new test world was performed. Existing development services
remain healthy. The next Owner test can use the activated path immediately.

### Existing Panel mount correction — 2026-10-18

The Owner subsequently authorized separating Panel state from Wings data so
native Blueprint ownership housekeeping cannot reach game volumes through
`/app/var`. The [deployment record](BLUEPRINT-EXTENSION.md#panelwings-mount-separation--2026-10-18)
documents the dedicated Panel bind and controlled startup, including explicit
migrations for future image upgrades and safe rollback to the former mount.
Only the existing Panel service was recreated. The NickHosting development
environment, Wings, database/cache services, game containers, ports and networks
were preserved. Panel and development HTTPS, authenticated extension discovery
and read-only Wings-backed file inspection passed. No application deployment,
native extension update, game-data backup or database dump was performed.

## Worlds catalog activation proposal — 2026-10-18

The CurseForge world catalog reuses the protected `curseforgeApiKey`, shared
content-download settings and existing source/import transport. Development has
an explicit `NH_DEV_CURSEFORGE_ENABLED` opt-in, default `false`; `true` requires
`NH_DEV_PROVIDER_MODE=real` and removes only the disabled CurseForge credential
override. The Owner then enters the real key under **Owner → Settings →
Credentials → CurseForge API key**. Do not put it in chat or the frontend.
Production continues using the existing protected secret/environment precedence.

Read-only preflight found no stored CurseForge key in dev. Existing dev database
migrations 001–042 match the repository checksums; only
`043_world_catalog_sources.sql` is pending. It extends provenance constraints and
preserves source rows, hashes and reservations. The browser-safe catalog package
export also requires refreshing the image-baked workspace manifests: HMR alone
cannot activate a new `package.json` export. Until activation, the running Vite
reports a missing `./world-catalog` export for the changed Minecraft UI module.

The following is a **proposal, not an executed activation**. It requires specific
Owner approval under AGENTS.md. Verify exact dev project/service labels, image
IDs, private overlay chain and absence of active transfers immediately before
applying. Current identities:

- API/worker image: `sha256:82c27833ec05ff838f72a5ffe9007c9b29644d666c7e4fe0cf719e81ee7dbe79`.
- Vite image: `sha256:2826f15993d2904e0da636ef101b01774937896cef45ae0d5bfc1c800a22a350`.
- API: dev-data/dev-edge/dev-egress; worker: dev-data/dev-egress; Vite: dev-edge.
  None publishes a host port. The ingress container and its prod-frontend attachment
  are unchanged.

Save a non-overwriting private copy of `.env.dev.local` under
`.codex/local/world-catalog-activation/`, preserving mode0600, then change only:

```diff
+NH_DEV_CURSEFORGE_ENABLED=true
```

Preserve all existing private settings and the full overlay chain. Proposed commands:

```sh
docker image tag sha256:82c27833ec05ff838f72a5ffe9007c9b29644d666c7e4fe0cf719e81ee7dbe79 nickhosting-dev-app:before-world-catalog-api
docker image tag sha256:2826f15993d2904e0da636ef101b01774937896cef45ae0d5bfc1c800a22a350 nickhosting-dev-app:before-world-catalog-vite
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local build api
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local --profile tools run --rm --no-deps migrate
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local up -d --no-deps --wait api worker vite
```

The shared application build updates these three dev services. The migration
container is temporary and must apply only043. No image build, source download or
application startup may apply migrations implicitly. No Blueprint installation,
Pterodactyl/Wings operation, game-server mutation, DNS/NPM/network change or
production deployment is part of this proposal. Accounts, databases, secrets,
review data and persistent mounts stay intact. API/worker/Vite recreation briefly
interrupts web requests; do not run it during uploads or active application jobs.

Verify health, same mounts/networks/ports, HTTPS module delivery, migration
checksums and protected-setting editability afterward. Once the Owner supplies
its key, use read-only catalog search/files discovery to verify real CurseForge
access; do not download/import into a real server without a selected test scope.
MinecraftMaps remains an external link and Modrinth offers no world catalog.

Rollback: restore the exact private environment copy and scoped source commit,
then use a temporary Compose override assigning the saved API image to API/worker
and saved Vite image to Vite. Recreate only those services with `--no-deps --wait`.
Retain additive migration043, source rows and staging reservations; do not drop
constraints, reset data or rewrite migration history. Preserve failure logs.

### Worlds catalog activation completed — 2026-10-18

The Owner approved the above proposal and scoped rollback. Activation used source
`1b4415d37e6cf41ad28478c2e9aea06a9bf95915`. The private environment backup and
before/after evidence are retained under `.codex/local/world-catalog-activation/`;
previous API/worker and Vite images have the proposed rollback tags.

The shared development image was rebuilt as
`sha256:54f8e70e635c8ef56bb12879e696f3c5d32bd22cf68ade228ad9c15235e7c101`.
The explicit temporary migrator applied only043 and removed its container. API,
worker and Vite were recreated with `--no-deps --wait`; all three are healthy with
zero restart counts. The existing112-container inventory remains; only these
three container IDs/images changed. Canonical mount sets, networks and published
ports are unchanged for every recorded container. Existing unrelated restart loops
advanced their counters during the observation period; their identities and
configuration were not changed by this activation.

All43 migration checksums match. Existing dev counts remain:2 users,4 managed
servers,1 physical host,1 node,1 runtime mapping,1 source. No active jobs, receiving
sources or upload claims were present at activation. No credentials, accounts or
review data were reset. No game-server/Blueprint/Pterodactyl/Wings operation was
issued, and NPM/DNS/ingress/Gateway configuration was untouched.

`NH_DEV_CURSEFORGE_ENABLED=true` is active; the protected CurseForge setting now
reports database source, unlocked and unconfigured. The Owner must supply its API
key privately before real catalog access can be verified. The frontend homepage,
Vite client, Minecraft controller and Worlds catalog module all return HTTPS200;
the missing package-export error is resolved. API readiness returns200. No error
records appeared in the recreated API/worker/Vite startup logs. The prior proposal
is preserved as historical approval evidence; its pending-activation limitation
is superseded by this execution record.

A real Chromium smoke check through `https://dev.hub.nickhost.ing` also loaded the
login form without page errors and received Vite's connected message over WSS.
Independent review verified the before/after snapshots and found no activation
blockers. Existing SFTPGo#18 and the previously documented Gateway route condition
are not changed or reclassified by this activation.

### Worlds selection preparation — 2026-10-18

API and worker reuse the existing encrypted private-transfer Redis namespace for
opening-time stop observations, 60-second managed identity proofs, and exact-path
single-use text upload grants. No migration, extra service, setting, dependency or
Blueprint update is required. Opening Worlds prepares in parallel; Select uses
local offline/power-revision checks and the existing direct Wings upload transport.
Missing/expired stopped observations require refreshing Worlds. External Panel
power actions are not continuously observed by this cached proof; local known
state changes still reject selection. Missing upload grants retain the Panel write,
and a dispatched direct write never falls back or retries. See M5 API contracts.
Development activation uses the existing API/worker source watchers. Code rollback
is a revert; disposable preparation expires without persistent-data cleanup.

### Fabric discovery cache migration (2026-10-19)

Development now includes migration `045_fabric_catalog.sql`, adding a Fabric
snapshot to the existing Minecraft metadata cache. A rebuilt app image is required
for the explicit migrator because migration SQL is image-baked. With the existing
three env files (dev, viewer and SFTP), the Owner-authorized activation built `api`
and ran `--profile tools run --rm --no-deps migrate`; no services were recreated.
API/worker/Vite source hot reload remained healthy. Production has not been migrated.
Retain the additive cache row and migration history on source rollback; the prior
code ignores it. See [validation](M5-VALIDATION.md#fabric-catalog-discovery-2026-10-19)
for catalog, API, browser evidence and retained rollback image.

### Fabric association queue migration (2026-10-19)

Migration `046_fabric_catalog_requests.sql` adds a nullable manual-request timestamp
to the existing metadata table. No game, account, provider or mapping data changes.
The API can read the old catalog before migration; worker refresh skips until the
column is present. Run the explicit migrator from a newly built app image, using
all three existing dev interpolation files:

```sh
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local build api
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local --profile tools run --rm --no-deps migrate
```

Source-bound API/worker/Vite use their normal watchers. No new network, mount,
host port or production deployment is required. The first association refresh
reads the official Fabric per-game metadata with concurrency2 and bounded resource
use; subsequent unchanged refreshes only read three root catalogs. Catalog reads
remain local during refresh and on upstream errors. The Owner's Sync versions
button requests background work with HTTP202.

Rollback: revert this change's source and restart only a development watcher if
needed. Retain the additive column, cached snapshot and migration ledger.
Older code ignores the extra column and strips optional relation metadata on read.
The previous running image is retained locally as
`nickhosting-dev-app:before-fabric-associations-20261019`; source mounts must also
be reverted for image rollback to restore application behavior. Do not down/reset
the stack or drop persistent data. See the corresponding M5 validation entry.

### Fabric registered-combination bridge (2026-10-19)

This source-only update adds Owner registration routes and UI controls; it needs
no migration, package installation, image rebuild or new infrastructure. Existing
dev API/Vite watchers load the update. Catalog browsing remains local; explicit
registration can read official runtime metadata and the selected egg.

Rollback: revert this update’s source, preserving registered combinations and all
existing data. No schema downgrade or provider cleanup is needed. Valid old
combination identities remain reusable; new mapping-sensitive identities are
opaque to older readers. No provider servers are created by registration.

### Fabric catalog-based creation (2026-10-19)

Supersedes the association sweep and registration prerequisite above. No new
migration, dependency, image or persistent resource is required. API/worker/Vite
source watchers load the update. The next Fabric sync replaces the old optional
association snapshot with the three root catalogs; existing server runtime records
remain untouched. Owner-selected FabricUpdated mappings are reused, not created
or edited by this change. Installer latest is fixed to an exact version at creation.

Rollback the source together across API/worker/frontend and retain all data. The
prior version may hide Fabric creation again or require another association sync;
never delete server records or downgrade the database as part of rollback. Existing
Fabric installation receipts are persistent server state and must be preserved.

### Post-creation installation experience (2026-10-19)

The [installation experience](INSTALLATION-EXPERIENCE.md) uses the existing API,
worker, PostgreSQL and encrypted Redis cache. There is no new mount, public port,
service, dependency or NickHosting database migration. Source watchers load the
application changes. Blueprint 1.7 adds a narrowly scoped installer WebSocket
credential route and committed installation notifications. Its separately
approved native update completed on 2026-10-19, retaining the Panel/Wings mount
separation above. No container restart, image rebuild or new migration was needed.
Discovery and a read-only authenticated Wings installation relay passed; real
installer delivery remains for the Owner's subsequent creation test. See the
[activation evidence](M5-VALIDATION.md#native-blueprint-170-activation--2026-10-19).

Rollback application sources together, retaining operation history and all user
data. The previous UI can ignore the additive progress fields. Restore the saved
extension/configuration and staged artifact if an approved activation regresses;
no table deletion, game reinstall, provider cleanup or database downgrade is
part of rollback. A live creation is reserved for the Owner's subsequent test.

### Minecraft Mods preparation and publication (2026-10-20)

[Mods](M5-MINECRAFT-MODS.md) reuses the existing API, content staging budgets,
provider credentials and Fileman transfer path. It adds migration
`047_minecraft_mods.sql`; no service, network, game-volume mount, public port,
dependency or Blueprint update is required. Migration 047 extends the content
source kind and adds draft/publication/restart receipts. It does not install mods
or edit any game server.

The development migrator reads SQL from its built image. Prepare the image and
apply the migration explicitly using all three private environment overlays:

```sh
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local build api
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local --profile tools run --rm --no-deps migrate
```

These are activation commands, not permission to run them. First confirm the
reviewed code, current image tag, migration 046, Compose project and isolated
migrator mounts/network. Preserve the previous image under a rollback tag.
Existing source watchers can load the application changes; a manual restart
requires its applicable approval if a watcher does not recover.

Rollback preserves additive tables, pending files, publication receipts, provider
credentials and all game data. Restore the reviewed previous application/image
without dropping tables or automatically reversing a user's published mods.
No production activation is included.

Owner-approved Mods activation completed on 2026-10-20: rollback tag
`nickhosting-dev-app:before-mods-20261020` retained, shared development image built,
only migration 047 applied and checksum verified. No `up`, service recreation or
manual restart was needed. The one-off migrator was removed; all existing
container identities, networks, ports and mounts remained unchanged.
API/worker/Vite health, public HTTPS and Firefox WSS HMR checks pass.
Authenticated Mods inventory and both provider catalogs return 200. The
missing-directory Wings behavior found during the first read was corrected in
source with two regression tests; no game directory was created to hide it.
No Blueprint/Panel/Wings change or real mod installation was performed.

### World archive preflight recovery (2026-10-20)

The shared Fileman archive path now reuses its root collision check when preparing
an upload into its not-yet-created staging directory. It no longer asks Wings to
list that nonexistent directory. Lifecycle preflight failures have a persistent
retry budget; 429 cooldowns survive worker restarts and asynchronous notifications.
Existing uncertain effects retain their recovery semantics.

Activation stopped and started only the existing development worker, preserving
its image, identity, mounts, networks and data. No dependency, migration or
Blueprint update was needed. The original queued world import resumed from its
cached download and uploaded/extracted its archive. The extension subsequently
returned an uncertain receipt during tree verification, before publication.
A later read-only verification passed for all 853 files and 104 directories.
The Owner then explicitly approved the scoped recovery. After a fresh dry run,
the existing worker was stopped briefly, the verified world was renamed into
place through Wings, only this operation's temporary staging/archive was removed,
and its single Blueprint receipt was confirmed. The same worker resumed normal
recovery: the original job succeeded, its upload claim was settled, and the
server's active operation was cleared. Authenticated Worlds and Fileman reads
return the published world. No re-download, re-extraction or game power action
was performed. The initial verification exception was not retained by the
extension, so its precise cause is still not established.

No Panel/Wings code, permissions, scheduler or Compose configuration was changed.
All eleven development services are healthy; Panel/Wings container identities
and start times are unchanged. The independently observed Panel daily-log
ownership problem remains a separate, unapplied proposal. Keep the cached source,
published world, durable receipts and original storage-migration copies.
Rollback is a NickHosting code revert plus a scoped development worker restart;
never reset an uncertain operation, repeat extraction or delete staged game data
as part of code rollback.

### Paper runtime catalog

Paper discovery is a separate local snapshot refreshed by the worker every 15
minutes and by **Owner → Minecraft → Versions → Paper → Sync versions**. The
wizard selects Minecraft version; the newest Paper build is frozen automatically
at creation. Configure a PaperUpdated mapping with integration-defined images and
enable the existing Minecraft rollout. No mapping or game server is created by
activation. See [Paper catalog and creation](GAME-INTEGRATIONS.md#paper-catalog-and-creation).

Development activation requires the normal explicit migration command with the
full private Compose env-file chain after building the current app image. Migration
048 only adds a Paper metadata row and extends its ID constraint. Existing servers,
secrets, accounts and storage are preserved. The Gateway process must reload its
compiled Paper declaration before first Paper use. Reverting code should retain
the additive schema/catalog and any created Paper server records.

## Modpack catalogs and installation (M5)

The Minecraft Modpacks tab now has a provider catalog, preparation and reviewed
installation workflow. See [M5-MODPACKS.md](M5-MODPACKS.md) for provider limits,
preservation rules, APIs and recovery behavior. NeoForge runtime development
is deferred; Forge support is described below. ATLauncher is browse-only pending CDN permission.

Migration `050_minecraft_modpacks.sql` is additive. Activation needs the updated
dependency image for API/worker/Vite and the explicit migrator with the current
private Compose overlay chain. No Panel/Wings/Blueprint change is part of this
feature. The Owner-approved development activation completed on 2026-10-21:
only050 was applied and only API/worker/Vite were recreated. Existing data,
environment, mounts, networks and ports were preserved. Read-only Firefox checks
passed HTTPS, WSS HMR and all six provider catalogs; no real pack was installed.
Keep the database, applied migration and all operation receipts when rolling back
application code. Exact private preimages and commands remain in the local
activation record; [M5-MODPACKS.md](M5-MODPACKS.md) records the verification limits.

### Forge runtime catalog

Forge uses a durable local catalog containing exact Maven coordinates and the
official recommended/latest promotions. The worker refreshes it every 15 minutes;
Owner **Minecraft → Versions → Forge → Sync versions** requests the same background
job. The wizard offers Minecraft version followed by Forge build, with the
recommended build selected initially. Existing Minecraft settings, domain and
resource steps remain shared. Modpacks can resolve the exact required Forge build
through an enabled mapping on the same managed node.

Configure **Forge Enhanced** with integration-defined images in the Minecraft
runtime mappings. No mapping is automatically created. Supported versions and
installation formats are documented in [Forge catalog and creation](GAME-INTEGRATIONS.md#forge-catalog-and-creation).
No new dependency or Blueprint/Panel/Wings modification is required.

Migration `051_forge_catalog.sql` extends the existing metadata ID constraint and
inserts one Forge synchronization row. Apply it explicitly through the development
migrator using the full private Compose env-file chain and an image containing the
reviewed SQL. The source watchers load the API, worker and UI changes; the Gateway
must reload the Forge capability declaration before use. Preserve the current
image under a rollback tag and inspect health, local catalog and HTTPS/HMR afterward.

Rollback retains the additive row, all existing users, mappings, runtime records,
operation receipts and game data. If a Forge server or Modpack runtime transition
has been created, keep a Forge-capable application until a scoped recovery is
reviewed. Do not revert support underneath an installed Forge server.
