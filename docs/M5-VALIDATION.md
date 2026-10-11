# M5 validation and review

Date: 2026-10-09. Branch: `milestone/m5-webpanel`; [PR #21](https://github.com/ImJstNickDev/nickhosting-panel/pull/21).
This record distinguishes final consolidated runs from development failures and
affected reruns. It does not authorize deployment or a merge.

## Reviewed baseline and implementation

The Owner-authorized squash of M4 PR #20 checked the exact approved HEAD
`d07d432657e5409bd7eafbc1ebf08388a8956677`, authentication as `ImJstNickDev`, clean
worktree, open/mergeable status and `main` target. The resulting main commit is
`45fff047781899d0543a47f02dcb106487123ffe`; issues #10/#11 closed. Local main was
fast-forwarded before creating this milestone branch. M5 is not merged.

The [mandatory common integration checklist](M5-COMMON-INTEGRATION.md) maps every
surface to implementation and tests. [Task flows](M5-JOURNEYS.md),
[API contracts](M5-API-CONTRACTS.md) and
[ADR 0014](decisions/0014-webpanel-and-common-contracts.md) explain the boundaries.
PostgreSQL migrations 014/015 add durable schedule occurrences/consent and service
health observations. Existing jobs, admission, identity, Gateway and Minecraft
evidence remain authoritative. No parallel authentication or game proxy exists.

The React application includes account/setup, projects and sharing, server
creation/lifecycle, Activity/recovery, streaming services, automation, Minecraft
management and Owner administration. Trusted game modules supply typed fields,
sections, commands, translations and bundled artwork. Shared screens do not
select behavior using game-name conditions. The Minecraft landscape is original
integration-owned artwork, with [provenance](../games/minecraft/src/ui/assets/PROVENANCE.md).

## Environment and verification boundary

- Node **24.21.0**, pnpm **10.33.0**, TypeScript **7.0.2**; existing user-local
  Node installation selected by `scripts/dev.sh`. No system runtime changes.
- PostgreSQL 18.6, Redis 8 and SFTPGo 2.7.6: reused the already-running,
  explicitly approved `nickhosting-m2-tests` resources. `scripts/test-env.ts --m2`
  verifies Compose project/service labels, working directory, exact configuration,
  exclusive isolated network and endpoint exposure before supplying credentials.
  This pass created/restarted/removed no Docker resources or networks.
- Each database suite uses a generated `nh_test_*` schema and applies the actual
  migrations. Browser users go through first-run/invitation/verification/login;
  no users or instance configuration are seeded into the application.
- Chromium 156.0.8078.4 / Playwright 1.64.0 run the actual React application,
  Hono handlers, Better Auth, PostgreSQL and management jobs. Vite/API/HMR share
  one ephemeral loopback-only listener. No browser route interception replaces
  NickHosting APIs. Fixtures replace external Pterodactyl, Discord transport,
  Minecraft metadata/artifacts and mail delivery. Virtual WebAuthn exercises real
  browser/library flows without claiming hardware authenticator certification.
- Missing Chromium libraries were downloaded as Debian packages and extracted
  only under the user's cache; `LD_LIBRARY_PATH` applies only to the browser
  child. No `sudo`, OS installation or service changes. Reproduction is in
  [deployment documentation](CONFIGURATION-AND-DEPLOYMENT.md).
- M4 real-server evidence is preserved. No live Minecraft scenario was repeated,
  no new runtime was certified and no existing Pterodactyl server was accessed or
  changed by this M5 validation. Vanilla remains the only real-server-verified
  runtime. Fixture signatures and artifacts cannot establish production support.
- Cloudflare writes remain mocked. Browser SFTP credentials test API integration;
  they do not establish SSH transport revocation. The real isolated SFTPGo suite
  retains its three known expected failures and [issue #18](https://github.com/ImJstNickDev/nickhosting-panel/issues/18)
  remains open as an independent production-release blocker.

## Consolidated commands

Run from the repository root. Local logs are retained under `/tmp/m5-final-*`;
raw browser screenshots remain ignored until individually reviewed for publication.

| Command | Actual result |
| --- | --- |
| `scripts/dev.sh pnpm test` | 848 passed, 51 files, 28.71 seconds. |
| `scripts/dev.sh pnpm test:m3` | First final run: 654 passed, 1 failed, 3 expected failures; 40 files, 356.57 seconds. The failure and affected rerun are recorded below, not relabeled as an initial full pass. |
| `scripts/dev.sh pnpm typecheck` | Passed, including browser fixture/test TypeScript. |
| `scripts/dev.sh pnpm lint` | Passed with 33 warnings and 2 informational diagnostics; no errors. |
| `scripts/dev.sh pnpm format:check` | Passed. |
| `scripts/dev.sh pnpm i18n:check` | 943 matching English, Italian and pseudolocale keys compiled. |
| `scripts/dev.sh pnpm build` | Passed after review corrections. Main JS 815.75 kB / 231.49 kB gzip; Vite's >500 kB advisory is retained. Build includes main-bundle and separate SHA-256-worker dependency notices. |
| `scripts/dev.sh pnpm test:browser` | 35 passed, 5 files, 127.61 seconds. Subsequent narrow visual/copy corrections received the affected reruns below. |
| `python3 scripts/test-governance-png.py` | 2 passed; narrow metadata-free PNG allowlist rejects unsupported binary content. |
| `python3 scripts/check-governance.py` and `git diff --cached --check` | Passed: 404 indexed text files, 49 PNGs, 347 relative links, 4 TOML files and 44 ignore cases. |

## Corrections and preserved failure history

Development used affected tests instead of rerunning the full integration suite
after every change. These records remain separate from consolidated results:

- Independent review found scheduled actions could continue after slow runtime
  validation without rechecking revoked authority. Deferred-provider regressions
  failed before the fix; authorization is now checked again immediately before
  external effects. The affected runtime/queued/schedule group passed **74** tests.
- Owner uncertainty acknowledgement similarly rechecks the bound session after
  acquiring the server lock/provider proof. Revoked, expired and demoted Owner
  regressions reproduced the defect; the affected lifecycle file passed **84**.
- Browser support Exit now clears stale assisted cookies even after parent-session
  expiry. Query observers are reset safely after identity changes. Independent
  review checked strict actor/subject separation and permission revocation.
- Reconciliation no longer labels a partial HTTP 200 result wholly successful;
  unavailable server identities and failed external recovery counts are visible.
  Its actual-handler browser regression passed.
- Minecraft reads actual safe `server.properties` values; terminal job success
  refreshes worlds/players/content without a page reload. Later unsaved drafts
  survive refresh. Targeted world/player and archive/replacement browser pairs
  passed after these corrections; fixture-only evidence is explicitly labeled.
- Platform-operator navigation now exposes audit and read-only settings, with no
  Owner mutation controls. Promotion/demotion, API 403s and axe checks passed.
- Initial browser failures included incorrect localized labels/heading selectors,
  a 12 MiB deep-equality timeout (replaced with byte-length/hash verification),
  and incorrect reset-notice matching. Their affected reruns passed; they were not
  silently removed or recast as successful initial runs.
- Initial final typecheck found harness cleanup could reference Vite before
  assignment; initialization/optional cleanup was corrected and types passed.
  Initial final lint found one formatting discrepancy; the affected file was
  formatted, then lint/format passed.
- The first full integration run exposed an obsolete synthetic file-protection
  fixture: it attached a Minecraft profile to an unrelated generic runtime
  mapping. Trusted module dispatch correctly rejected the inconsistent identity.
  The fixture must identify a matching Minecraft/Fabric mapping; production
  identity checks remain unchanged. The test retains its protected launch-file
  rejection and permitted mod/world write assertions. After correcting only that
  fixture, the complete affected API file passed **30/30** in **26.12 seconds**:
  `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts`.
  This resolves the sole full-run failure; it is an affected rerun, not a second
  full integration run.
- Final independent screen review found narrow issues after the 35-case browser
  run: sparse tall mobile file rows, null quota expiry displayed as unknown,
  acknowledged unknown effects still described as being checked, and two captures
  taken before data settled. The file table now stays compact in a named,
  keyboard-scrollable region; quota expiry and terminal acknowledgement are
  explicit. Capture assertions wait for actual connection/health results.
  A mislabeled duplicate Discord screenshot is excluded from publication; the
  reverse-link behavior itself remains covered by its passing browser scenario.

Affected final browser commands use this prefix:
`scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.

| File and test filter | Result |
| --- | --- |
| `apps/web/tests/services.browser.test.ts -t 'Italian mobile'` | 1 passed, 8 not selected; 11.55 seconds. Includes 320px pseudolocale, compact row-height assertion and ArrowRight scrolling. |
| `apps/web/tests/services.browser.test.ts -t 'persists schedules'` | 1 passed, 8 not selected; 9.00 seconds. Actual unavailable connection and provider outage are loaded before captures. |
| `apps/web/tests/platform.browser.test.ts -t 'Owner acknowledgement\|operates Owner quotas'` | 2 passed, 8 not selected; 15.08 seconds. Terminal unknown-result copy, no replay, no-expiry quota and settled health capture. |
| `apps/web/tests/platform.browser.test.ts -t 'operates Owner quotas'` | Final history-refresh regression: 1 passed, 9 not selected; 13.23 seconds. Waits for existing history, saves limits and verifies the additional audit event/reason without reload. |

Build, types, lint and formatting were rerun after these source corrections;
the expensive full integration suite was not repeated for presentation-only edits.
The affected browser-client/i18n/game-UI/SDK unit group also passed **30/30**:
`scripts/dev.sh pnpm exec vitest run apps/web/src/api/client.test.ts apps/web/src/app/i18n.test.ts apps/web/src/features/game-ui.test.ts games/minecraft/src/ui/ui.test.ts packages/game-sdk/src/ui.test.ts`.

## Browser, accessibility and content review

Account, Discord, platform, Minecraft and server-service suites cover actual
handlers, authorization, durable outcomes, errors and unavailable states.
File transfers include a **12 MiB** byte-identical upload/download through real
routes; this representative test is not a maximum or proof of every multi-GB
transfer. Downloads stream natively, uploads use XHR progress/cancellation and
the SHA-256 worker processes bounded chunks. Text editing alone is bounded.

One light theme is supported. English/Italian desktop and mobile captures and
pseudolocalization are reviewed. Axe checks target applicable WCAG 2.2 AA tags;
keyboard exercises cover dialog Escape/focus restoration, unsaved edits, form
errors and responsive navigation. Charts include readable measurement tables.
Automated checks and these manual inspections do not claim complete WCAG
certification, screen-reader testing on every platform, or Safari/Firefox coverage.

Independent review has already identified and closed authorization races,
partial-result messaging, stale game management views, rounded small file sizes,
overlapping wizard steps, oversized game art and offscreen active mobile tabs.
The [screenshot inventory](M5-SCREENSHOTS.md) links sanitized actual captures and
identifies the evidence boundary. It includes useful empty, unavailable,
capacity-denied, uncertain, failed and completed states; no generated mockup is
presented as a running application.

The independent reviewer examined backend authorization/durability, shared
frontend and game descriptors, every common-integration checklist row, and rendered
account/server/Minecraft/Owner screens. Its final quota-history finding was
reproduced, fixed by invalidating the scoped audit query, and independently closed
after inspecting the regression, passing result and refreshed screenshot.
**No unresolved must-fix findings remain within that reviewed scope.** This is an
independent agent review, not a claim of external security or accessibility
certification. The source of all 49 published captures was checked for fixture
identity and credential masking.

## Safety, cleanup and release prerequisites

The pre-merge private-file fingerprint inventory was rechecked: **67/67 unchanged**,
none missing. Credentials, private infrastructure notes, test ledgers, environments,
archives and persistent data remain ignored. No new Pterodactyl assets, public
bindings, production service changes, DNS writes or infrastructure deployment.
Test harnesses close their browser/listener and drop only their generated schema;
fixture content cleanup is scoped to its created files. No prune or unrelated
cleanup is authorized or performed. Existing approved test containers are left
running; this is not a claim that they were removed.

An independent read-only database/process audit found **no remaining M5 schema,
project browser-test process or project test listener** after the completed runs.
Five older isolated schemas remain: three with M2 migrations through 005 and two
with M4 migrations through 013, carrying only the corresponding historical test
identities. None has M5 migrations 014/015 or browser identities. Exact names and
attribution are retained in ignored `.codex/local/m5-readonly-cleanup-audit.json`;
they were not dropped. Unrelated host browser processes were excluded and left
untouched. Historical M2/M4 resources are not claimed as this milestone's cleanup.

Production requires configured mail and OAuth, protected signing/encryption and
provider credentials, verified runtime/egg mappings, suitable SFTP public endpoint,
fresh Gateway collision/reachability evidence and separately approved networking/
filesystem/deployment changes. A saved Owner setting is not proof of live service
availability. Preserve the complete Vite output and dependency notices when
deploying. SFTPGo #18 must be resolved/reviewed before production release.

Rollback before deployment is to close the unmerged milestone PR. Any later
application rollback must drain scheduled work and preserve durable operation
history; do not drop migrations 014/015 or restore a database blindly over external
effects. No production migration or rollback was executed in this milestone.

## 2026-10-10 — persistent development / production configuration pass

This focused follow-up starts from PR #21 HEAD
`97c0b24c0e06d8443186fa351caf9974cc88b635`. It adds the
[environment architecture and exact activation proposal](M5-ENVIRONMENTS.md),
separate dev/prod Compose projects, pinned multi-stage images, source supervision,
HTTPS-aware Vite networking, same-origin ingress, environment guards and safe
future development preparation. It does not redesign application routes or alter
any M1–M4 provider/Gateway acceptance boundary.

| Actual command / check | Result |
| --- | --- |
| `docker compose --env-file deploy/dev/.env.example -f compose.dev.yaml --profile tools config --quiet` | Parsed development interpolation/dependencies, including explicit migration service. |
| `docker compose --env-file deploy/prod/.env.example -f compose.prod.yaml --profile tools config --quiet` | Parsed production configuration; placeholders are intentionally rejected by runtime guards. |
| `scripts/dev.sh pnpm exec vitest run scripts/deployment-config.test.ts scripts/dev-provider.test.ts scripts/dev-watch.test.ts scripts/prepare-dev-environment.test.ts apps/web/vite-network.test.ts` | **76 passed**, 5 files, 4.90 seconds. Temporary files/loopback fixtures only; no Docker resource creation. |
| Preparation test file rerun after equivalent PEM-regex formatting for the publication scanner | **7 passed**; the previous 76-test result is retained separately. |
| `scripts/dev.sh pnpm exec vitest run scripts/deployment-config.test.ts -t Compose` after adding the migrator's read-only SMTP trust-certificate mount | **5 passed**, 25 outside the filter; avoids a missing-certificate startup warning without broad reruns. |
| `scripts/dev.sh pnpm typecheck` | Passed, including frontend/browser types. |
| `scripts/dev.sh pnpm lint` | No errors; 36 warnings and 2 informational diagnostics. |
| `scripts/dev.sh pnpm format:check` | Passed. |
| `scripts/dev.sh pnpm build` | Passed; 943 EN/IT/pseudolocale keys, unchanged 815.75 kB main JS / 231.49 kB gzip. Existing chunk-size advisory retained. |
| `scripts/dev.sh pnpm build:runtime` | Passed; compiled API/worker and workspace exports, SQL assets; test helpers/testing export excluded. |
| `scripts/dev.sh pnpm --dir build/runtime install --prod --offline --frozen-lockfile --ignore-scripts` | Passed; 190 cached production packages, no downloads, no development dependencies. Generated output only. |
| Plain Node imports of compiled API runtime and jobs, without `tsx` | Passed; no service, database or provider connection started. |
| Read-only `docker buildx imagetools inspect` | Verified pinned Node 24.21.0, Nginx-unprivileged and Mailpit 1.31.4 manifests. No pull/build/run. PostgreSQL/Redis use existing verified pinned image references. |
| Read-only container/network/name/alias checks | Existing `prod-frontend` bridge found; neither proposed stable name/alias nor dev/prod project network names were occupied. |
| Governance, indexed links/TOML/ignore paths and whitespace | Passed after staging this configuration follow-up; no real environment, key, private note or persistent state is tracked. |

New tests exercise environment/purpose credential separation, placeholder and
cross-environment rejection, immutable production image requirements, TLS/origin
handling, forced local provider endpoints, Compose isolation, actual disposable
TypeScript runtime builds and exclusion of tests/private build inputs. The real
supervisor subprocess test verifies that a slow SIGTERM shutdown completes before
replacement. CSS/UI changes do not restart workers. Catalog compilation precedes
Vite and runs again on catalog changes. Vite's actual config runner loads with a
writable temporary cache; no direct/internal HMR fallback is enabled.

The ingress shell test uses temporary paths and **fake `nginx`/`envsubst`** to
check normalization/substitution/order. It does not prove actual Nginx syntax or
network behavior. Simulator tests call real provider connection-validation code
against a temporary loopback-only empty inventory; all mutation methods are denied.
Preparation tests generate TLS/credentials solely in disposable temporary roots.
No actual `.env.dev.local`, `.env.prod.local`, `mountdata/dev` or `mountdata/prod`
was created.

Independent configuration/security review identified and resolved: Vite's default
writes to read-only dependency directories; explicit `:443`/hostname normalization
mismatch; inert test helpers in compiled artifacts; and documentation that implied
API connection draining despite the existing immediate connection close. Affected
regressions pass. Final independent review reports **zero remaining must-fix
configuration findings**. All 67 previously recorded private files/ledgers retain
their recorded hashes. Source watchers, provider fixtures and preparation also
received bounded separate-agent implementation/test review.

**Not executed:** Docker image builds, container/network creation or attachment,
Nginx `-t` inside its image, NPM/DNS/certificate changes, migrations against new
persistent state, live HTTPS/HMR/mail/persistence verification or production
deployment. These require the exact separate activation approval. Full database,
browser and historical live Minecraft scenarios were not repeated for this focused
configuration pass; their complete prior results and failures above remain intact.
SFTPGo's three retained-transport expected failures and issue #18 remain unchanged,
not security passes or resolved release gates. No existing test resources,
Pterodactyl servers, Wings data or production service was mutated.

## 2026-10-10 — controlled development activation, initial attempt

The Owner separately authorized the exact development activation procedure at
`64fb70bff3fff0095fcef063aad91ebd17fd1b89`. Local/PR HEAD matched, the worktree
was clean, and name/alias/network collision checks passed. Available memory was
about 25 GiB and disk about 79 GiB. The private before/after audit records Docker
identities/network metadata without copying container environments or provider
credentials.

Executed only the approved networkless directory helper, non-overwriting dev
preparation, `compose.dev.yaml` parsing, `build api web`, and initial dependency
`up -d --wait postgres redis provider mailpit`. Both application images built.
Dedicated environment/private-key/SMTP-auth files are ignored and mode 0600;
the public TLS certificate is intentionally 0644. No production credentials were
accessed. Image installation retained pnpm's ignored-build-script warnings;
no dependency approval policy was changed.

The initial dependency start **failed** because PostgreSQL could not traverse its
new mount parent. Preparation created `mountdata/dev/postgres` as UID 1000 mode
0700. The official PostgreSQL 18 image created `18/` as root mode 0755 and its
actual `18/docker` PGDATA as UID 70 mode 0700, then dropped privilege. UID 70
could not traverse the mount parent. Nine automatic failed restarts occurred,
without OOM; the coordinator stopped only `nickhosting-dev-postgres-1` to stop
that loop. No migration or application startup proceeded through this failure.

At this pause boundary:

| Resource/check | Actual result |
| --- | --- |
| `nickhosting-dev-postgres-1` | Stopped after the permission failure; 9 failed automatic restarts preserved in evidence. |
| `nickhosting-dev-redis-1` | Healthy, 0 restarts; pinned image reports Redis 8.10.2. |
| `nickhosting-dev-provider-1` | Healthy, 0 restarts. |
| `nickhosting-dev-mailpit-1` | Healthy, 0 restarts. |
| New network | Only `nickhosting-dev-data`, internal. |
| External network / ingress | No new attachment to `prod-frontend`; web/Vite/API/worker not started. |
| Host ports | No published bindings on any new container. Image EXPOSE metadata is not a published port. |
| Internal DNS | Redis/provider/Mailpit resolve from the dev provider namespace. The stopped PostgreSQL does not resolve; an initial probe including it failed, then running-service checks passed. |
| Provider | Five authenticated inventories return HTTP 200 and empty data; unauthenticated inventory 403; POST/PUT/PATCH/DELETE all 405. No production provider call occurred. |
| Mailpit | Internal readiness HTTP 200; SMTP delivery/browser verification not yet tested. |
| Existing resources | All 94 pre-existing container identities and network attachments preserved; 91 had unchanged start/status metadata. Three already-restarting unrelated containers continued their pre-existing restart loops; none was operated on. All 27 pre-existing networks retained. |

Redis logs the existing-host `vm.overcommit_memory` warning. No sysctl/kernel or
host change is authorized or applied. This is a deployment diagnostic, not a
reason to modify unrelated infrastructure during activation.

Independent review confirmed the minimal correction: **only** the new PostgreSQL
mount parent needs 0711 (traversal, no listing/write); actual PGDATA and the dev
ancestor stay 0700. Since this differs from the exact reviewed preparation, the
coordinator requested narrow approval before applying `chmod 0711 --
./mountdata/dev/postgres` and resuming the already-approved sequence. No recursive
chmod, new privileged helper, deletion, credential regeneration or state reset is
needed. Rollback stops PostgreSQL dev before restoring 0700 on that parent.

The future preparation script now explicitly sets 0711 only on the exclusively
created PostgreSQL parent using a no-follow directory handle, including under
`umask 077`. It still refuses existing state. **8/8 targeted preparation tests**,
including the separate-process umask/non-overwrite regression, passed. These
source changes do not apply the correction to the existing development directory.
No UI or application behavior was changed. NPM handoff remains blocked until the
upstream is actually healthy; no HTTPS/WSS, browser mail, persistence restart or
migration success is claimed at this boundary.

## 2026-10-10 — approved permission correction and internal development readiness

The Owner authorized the exact nonrecursive command
`chmod 0711 -- ./mountdata/dev/postgres` and continuation of development activation
at reviewed HEAD `ac5a63617713267ddefab1cdb4efa5d9a2111961`. Before any mutation,
the coordinator verified the exact workspace, local/PR HEAD, clean worktree,
directory ownership/modes, absence of symlinks, and the original development
PostgreSQL container identity against the private activation record. GitHub
authentication remains `ImJstNickDev`; PR #21 remains open, unmerged, targeting
`main` on `milestone/m5-webpanel`.

Only the approved mount-parent mode changed: UID 1000, **0711**. The development
ancestor remains UID 1000 mode **0700**; actual `18/docker` PGDATA remains UID 70
mode **0700**, with unchanged ownership. No recursive chmod/chown, database reset,
credential replacement or preparation-script rerun occurred. The same stopped
PostgreSQL container recovered successfully.

Two narrowly scoped startup defects were then corrected, without UI changes:

- Nginx attempted to create its unused FastCGI module scratch directory under its
  read-only root. Nine failed automatic web restarts occurred before the dev
  ingress was stopped. All module scratch paths now use the already-approved
  `/tmp` tmpfs. No mount, capability or permission was broadened. The corresponding
  production template is corrected as configuration only; production was not built
  or started. The dev web image was rebuilt and the dev ingress recreated.
- The worker was processing heartbeats but Docker reported it unhealthy: the
  probe queried `pg.Pool` directly and destroyed an uninitialized lazy Kysely
  driver, leaving the pool's idle socket open. The original probe exited in
  **11.11 seconds**, beyond its existing 10-second timeout. Explicit `pool.end()`
  reduced the real development-DB probe to **1.58 seconds**. The heartbeat scope,
  running-state/freshness predicate and timeout are unchanged. The shared dev
  application image was rebuilt; only its dev API/worker/Vite/provider services
  were recreated to use it.

| Actual command / check | Result |
| --- | --- |
| Exact approved `chmod 0711 -- ./mountdata/dev/postgres`; host/container `stat` | Parent 0711; dev ancestor and actual PGDATA 0700; owners unchanged. |
| `docker compose --env-file .env.dev.local -f compose.dev.yaml start --wait postgres` | Original development PostgreSQL container recovered, healthy. |
| `docker compose --env-file .env.dev.local -f compose.dev.yaml --profile tools run --rm migrate` | **All 15 migrations (001–015) applied** before API/worker startup. Temporary migrator removed itself. No users, accounts or Owner setup seeded. |
| `docker compose --env-file .env.dev.local -f compose.dev.yaml up -d --wait api worker vite web` | Initial web/worker health failures above retained as failures, not rewritten as a pass. |
| Dev-only `build web`, `up -d --no-deps --wait web`, `build api`, `up -d --no-deps --wait api worker vite provider` | Corrected images built and scoped services healthy. No production image/service operation. |
| `scripts/dev.sh pnpm exec vitest run scripts/deployment-config.test.ts -t ingress` | **5 passed**, 27 outside the filter; includes dev/prod scratch-path regressions. This is targeted verification, not a new full-suite result. |
| `scripts/dev.sh pnpm exec biome check deploy/container-health.mjs scripts/deployment-config.test.ts` | Passed. |
| Dev private-env `config --quiet`; production example-env/tools-profile `config --quiet` | Both passed without printing interpolated secrets. |
| `docker compose --env-file .env.dev.local -f compose.dev.yaml exec -T web nginx -t -c /tmp/nginx.conf` | Real Nginx syntax/configuration check passed. |
| Internal Node HTTP/DNS checks from the dev API namespace | Seven service DNS names resolve; ingress `/`, transformed `/src/main.tsx`, `/v1/setup` and `/api/auth/get-session` all HTTP 200. Actual Vite/React source served; setup remains unclaimed/incomplete, session is null. Correct public Host/Origin used. |
| Local simulator authorization/isolation | Five authenticated inventories HTTP 200 and empty; missing credentials 403; POST/PUT/PATCH/DELETE each 405. Provider URL remains pinned to the simulator, Gateway disabled. No real provider accessed. |
| `docker compose --env-file .env.dev.local -f compose.dev.yaml restart postgres redis mailpit` | Approved development-only restart completed. API/worker logged transient DB/Redis disconnection errors, then recovered without restarting their processes. All eight services healthy; last five worker probe exit codes 0. |
| Read-only SQL snapshot before/after restart | Identical database cluster identity, 15 migration names/checksums/applied timestamps and zero user/account/setup counts. This proves initialized schema persistence, **not yet review-account/session/mail persistence**. |
| Post-restart ingress/DNS/simulator checks | Passed again. No seeded jobs or game mutations were needed. |
| Final Docker resource audit against pre-activation ledger | All 94 pre-existing container identities/network attachments and all 27 original network configurations preserved. Three unrelated containers already in restart loops continued independently; no operation targeted them. Only the two approved internal dev networks and eight dev services exist as additions. |
| `python3 scripts/check-governance.py`; `git diff --cached --check` | Passed: 432 indexed text files, 49 review PNGs, 352 local links, 4 TOML files and 44 ignore cases. Explicit staged-content inspection found no private environments, credentials, audit records or persistence. |

The first internal HTTP probe used Node fetch with an overridden Host header;
that client did not send the intended Host and ingress correctly closed the
request. Switching the **test harness** to `node:http` with explicit Host passed;
ingress host validation was not weakened. One topology snapshot caught transient
metadata from an already-restarting unrelated container; a read-only diagnostic
and complete repeat audit confirmed unchanged attachments. No infrastructure
repair was attempted.

Final services are all **running/healthy**, with **zero automatic restarts on the
current instances** (manual restarts and earlier failed attempts above remain
explicitly recorded):

| Container | Network attachments |
| --- | --- |
| `nickhosting-dev-web` | `nickhosting-dev-edge`, existing external `prod-frontend` |
| `nickhosting-dev-vite-1` | `nickhosting-dev-edge` |
| `nickhosting-dev-api-1` | `nickhosting-dev-edge`, `nickhosting-dev-data` |
| `nickhosting-dev-worker-1` | `nickhosting-dev-data` |
| `nickhosting-dev-postgres-1` | `nickhosting-dev-data` |
| `nickhosting-dev-redis-1` | `nickhosting-dev-data` |
| `nickhosting-dev-provider-1` | `nickhosting-dev-data` |
| `nickhosting-dev-mailpit-1` | `nickhosting-dev-data` |

Both new networks are internal; only dev web joined the existing external network.
Every dev container has empty host-port bindings, no privileged/host-network mode,
Docker socket or unrelated bind mount. Persistent mounts remain under
`mountdata/dev/`; ignored credentials and private audit records remain unpublished.
Final available capacity was about **24 GiB RAM / 76 GiB disk**. The existing-host
Redis overcommit warning remains; no host sysctl was changed.

The upstream **`nickhosting-dev-web:8080` is ready internally**. The Owner must now
configure the [documented NPM proxy host](M5-ENVIRONMENTS.md#exact-nginx-proxy-manager-proposal)
for `dev.hub.nickhost.ing`, HTTP upstream, WebSocket support, certificate/Force SSL,
Cache Assets disabled and scoped streaming/upload directives. NPM, DNS and
certificates were not modified. External HTTPS/WSS HMR, Secure cookies, CSRF,
mail/browser journeys and external-origin behavior remain **pending Owner NPM
confirmation**. No claim of end-to-end NPM connectivity or authenticated-browser
success is made from these internal probes.

No full M1–M5/browser suite or live Minecraft scenario was repeated for these
bounded activation fixes. Their historical evidence remains intact. SFTPGo issue
#18 and its three expected failures remain a separate release blocker. No existing
test persistence/ledger, production container, Pterodactyl/Wings resource, DNS or
production deployment was changed. Development is left running for review; no
cleanup, prune, `down -v` or orphan removal occurred. A safe scoped stop remains
`docker compose --env-file .env.dev.local -f compose.dev.yaml stop`, retaining all
development data.

Independent technical/security review inspected the final source, targeted tests,
documentation and saved health/network/persistence evidence: **zero remaining
must-fix findings in this activation change**. The reviewer performed no
infrastructure operations; the pre-existing-resource comparison is the
coordinator's recorded audit. External NPM/browser evidence remains explicitly
pending; this review does not waive that boundary or issue #18.

## 2026-10-10 — explicit real-provider development mode

Starting clean HEAD: `e6af505002afaa66fa04525e55295ace8cb47a91`. The Owner
explicitly authorized switching the existing dev project to the real Panel,
entering real Application/Client keys through the protected interface, and scoped
dev configuration/restarts. The prior sandbox-only restriction is superseded;
unrelated Panel servers, production infrastructure and release gates are not.

`NH_DEV_PROVIDER_MODE` now selects default `sandbox` or explicit `real`. Real
mode removes Pterodactyl URL/key/transfer-origin environment locks and restores
the normal Minecraft content-origin defaults. Existing Owner settings, encrypted
write-only secrets and the regular adapter are reused without product/API rewrites.
Optional scoped evidence verification uses the original trusted runner key; no
key or evidence was generated/imported and no game was promoted. Existing
authorization, immutable identity, admission and compatibility gates are unchanged.

The small `compose.dev.real.yaml` overlay adds **only API/worker** to the new
`nickhosting-dev-egress` network, retains their internal dependencies and uses a
configured resolver. It profiles the simulator off and removes its API startup
dependency. Private `COMPOSE_FILE` persists the selection for ordinary stop/up
commands; no recurring permission correction, migration or reset is needed.

Read-only preflight confirmed the exact dev project, eight original containers,
no host ports, directory ownership/modes, one Owner and completed setup, 15
migrations and zero managed servers/stored provider secrets. API/worker alone
were rebuilt/recreated. A DNS probe to the previously documented direct resolver
container address timed out. Inspection proved the same DNS service already
publishes port 53 on the host; selecting that existing endpoint only in dev
resolved the Panel name successfully. API/worker were recreated once more for
that resolver correction. No Bind9, host resolver, DNS record, published binding
or production network was changed. Private notes retain the exact endpoint proof.

Final dev state: **seven running healthy services**, zero current automatic
restarts, simulator intentionally stopped (not deleted). Web/Vite/PostgreSQL/
Redis/Mailpit identities are unchanged; only web retains `prod-frontend`, and
all dev host-port bindings remain empty. Owner identity, completed setup and all
migration checksums/timestamps are identical before/after. No reset or account
replacement. Private dev auth/encryption/database/mail secrets were preserved.

| Focused check | Actual result |
| --- | --- |
| Scoped environment tests in `scripts/deployment-config.test.ts` | **25 passed**, 11 outside filter before the separate evidence-key addition. Tests prove default sandbox, real-mode settings provenance/unlocked fields, no key fallback, and unchanged auth/storage isolation. |
| Optional evidence-key regression only | **1 passed**, 37 outside filter; exact existing verifier format, real-only, no generated/default key. |
| Compose-isolation tests only | **6 passed**, 31 outside filter; real overlay merge, simulator dependency/profile, API/worker-only egress/resolver, retained internal storage and sole ingress external attachment. |
| Final real-overlay regression after review's migrator-mode correction | **1 passed**, 37 outside filter; explicit tools-profile migration accepts the optional real-mode evidence key but retains only the data network. No migration was run against dev. |
| `vitest run packages/pterodactyl-adapter/src/connection.test.ts packages/pterodactyl-adapter/src/adapter.test.ts packages/core/src/core.test.ts` via `scripts/dev.sh pnpm exec` | **89 passed**. Standard adapter uses isolated request fixtures, including discovery, separate credentials, explicit-allocation creation and secret/transfer isolation; no real provider calls. |
| Isolated integration selection: `runtime.integration.test.ts` and `minecraft-registry.integration.test.ts`, filter `binds restart process evidence\|fails closed when the resource owner changes\|Minecraft Owner evidence` | **8 passed**, 28 outside filter. UUID/external identity protection and exact signed evidence/rollout eligibility remain enforced. |
| Isolated `platform.integration.test.ts`, filter `resolves precedence\|stores encrypted authenticated secrets` | **2 failed**: filtering skipped the preceding migration test that creates this suite's fixture identities; both audit foreign keys correctly rejected the absent actor. This was a test-selection error, not a provider-mode failure. |
| Rerun only the complete `platform.integration.test.ts` file with its fixture prerequisite | **5 passed**, 1.48 seconds; actual database precedence, encrypted secret storage/presence-only metadata, bootstrap preservation and rollout filtering. No source changes were needed. |
| `scripts/dev.sh pnpm typecheck`; targeted Biome; whitespace | Passed. No frontend build needed: application/UI source and dependencies are unchanged. |
| Selected real Compose and default sandbox parsing | Passed. Only dev application image built; no production build/deployment. |
| Running API environment/settings check | Mode real; no `NH_PTERODACTYL_*` override; URL unlocked with default source until Owner saves it; Panel DNS resolution succeeds; Gateway remains disabled. |
| Actual HTTPS + Chromium/Vite WebSocket smoke | HTTP **200**, browser certificate validation enabled, actual **WSS HMR connected frame** received through `dev.hub.nickhost.ing`. No CSS/catalog edit or account mutation performed. |

Database regressions used only generated schemas on the already-running isolated
M2 test PostgreSQL and removed only those generated schemas. No test services
were started/restarted, historical schemas touched or dev DB used for fixtures.
One initial test command selected a nonexistent filename and executed no tests;
the corrected platform selection exposed the fixture-order dependency above. An initial browser
launch lacked shared libraries; retry used the already-existing user-cache library
path scoped to the Chromium child. No dependency download or OS change. A probe
with an unused nonexistent import was corrected in the private test harness;
the final environment/settings probe passed without application changes.

**Authenticated real-Panel discovery is pending the Owner's interactive URL/key
entry**, not reported as passed. No production credential was read/copied from
old files or containers. No Panel API request or real game-server mutation was
made in this configuration pass. Owner steps and exact prerequisites are in
[real-provider development](M5-ENVIRONMENTS.md#real-provider-development-configuration-and-daily-use).
Historical M4 evidence requires exact signed context; the current stack also lacks
approved host/container observer access for provisioning/start. Neither prerequisite
was bypassed. No Gateway/SFTPGo deployment, DNS write, UI redesign, M6 or PR merge.
SFTPGo issue #18 remains an independent production-release blocker.

Independent configuration/security review found and resolved one future-operation
defect: the tools-profile migrator inherited the optional evidence key but defaulted
to sandbox, rejecting startup. Its overlay now selects real mode without egress;
the effective-Compose/environment regression passes. Documentation also now
distinguishes the successful initial WSS connection from untested source-edit
propagation. The reviewer inspected source and saved dev evidence without any
infrastructure operations and confirmed **zero remaining must-fix findings**.
Governance and staged-content hygiene pass (433 text files, 49 review PNGs,
353 local links, 4 TOML files and 44 ignore cases); the
credentials/discovery and real-creation prerequisites above remain explicit.

### 2026-10-10 — Owner-entered real provider discovery

After the Owner saved the Panel URL and both keys through protected settings, a
read-only probe inside the existing dev API used `containerEnvironment`, encrypted
DB secrets and `createManagementRuntime().adapter`. Client account authentication
and Application API discovery passed: **1 node, 5 nests, 21 eggs, 400 allocations**.
Only counts were emitted; no credentials or provider identities were published.
The first probe failed before making requests because workspace package imports
were unavailable from the repository root; source entry imports corrected the
probe without changing application code. No server mutation, migration, restart
or infrastructure change occurred. This supersedes the pending discovery result
above; it does not establish provisioning or game-runtime eligibility.

SFTPGo remains explicitly disabled in development: the environment-locked
`http://provider:9090` URL and disabled credential are legacy simulator guards,
not an operational SFTPGo endpoint. No development SFTPGo service or authorized
Wings filesystem mount exists in this stack. Real Panel discovery does not enable
SFTP credential issuance or file access through SFTPGo. Existing file-management
APIs use the separate Pterodactyl adapter and retain their own managed-identity and
transfer-origin requirements. Issue #18 and observer/evidence prerequisites remain.

### 2026-10-10 — prepared development host observer (not activated)

Owner requested operational dev prerequisites while retaining sole responsibility
for creating physical hosts, managed nodes and egg mappings. The deployment gap
also affected the earlier production Compose proposal; running web/API containers
alone never established complete provisioning readiness.

Implemented a bounded host-native Unix observer and optional dev overlay. API and
worker use remote physical metrics and the existing container identity observer;
neither receives Docker's socket or Wings files. New configuration is opt-in and
not present in the active private Compose selection. Exact activation and rollback
are in [development operational prerequisites](M5-DEV-READINESS.md); the rendered
unit/environment and machine-specific proposal are private. No helper/socket
service, lingering change or new mount has been activated. Seven existing dev
services remain healthy. No Owner configuration records or real servers created.

Focused evidence (no historical full-suite rerun):

- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/host-observer.test.ts`:
  **7 passed**, including actual isolated Unix IPC, wrong identity, bounded input,
  exact path allowlist, permissions, sanitized failures and stale-socket recovery
  after a fixture process crash. Independent reviewer also confirmed these tests.
- Existing `container-observer.test.ts`: **104 passed**; underlying fixed Docker
  commands and UUID/process/image checks retained.
- `scripts/dev.sh pnpm exec vitest run scripts/deployment-config.test.ts -t observer`:
  **4 passed, 36 outside filter**, including real-mode opt-in and Compose scope.
- Isolated M2 database harness, `remote-observer.integration.test.ts`: original
  **3 passed**; additional expired/future sample cases **2 passed, 3 outside filter**.
  Remote samples persist accurately; wrong identity/path/age does not replace prior
  observations. An initial test expectation failed because the helper samples
  before the client checks response identity; corrected the test to verify rejected
  persistence, without weakening implementation. No test container lifecycle change.
- `scripts/dev.sh pnpm typecheck`: passed; targeted Biome and whitespace passed.
- `systemd-analyze --user verify .codex/local/nickhosting-dev-observer.service`:
  passed without installing/starting a unit. Service name absent; lingering disabled.
- Read-only host mount-table inspection verified the proposed project-owned disk
  probe shares the Wings storage filesystem. Direct directory inspection was
  permission-denied and Wings lacks `stat`; no permission alteration or content
  access was attempted. The probe avoids mounting or reading game directories.

Independent security/configuration review: **zero remaining must-fix findings**.
Stale/future regression suggestions implemented, login/linger effects and stale
socket single-instance requirement documented. Activation, API-to-live-helper
sampling and actual service restart remain **pending exact Owner approval**, not
passed tests. Minecraft mapping certification and Gateway listener deployment are
separate remaining prerequisites; SFTPGo stays disabled and issue #18 unchanged.

### 2026-10-10 — Owner-approved direct Docker activation

The Owner superseded the prepared helper proposal with explicit direct Docker
socket access for development and future production, accepting the risk in
[issue #22](https://github.com/ImJstNickDev/nickhosting-panel/issues/22). Dev/prod
will not run together. The helper/service/remote-only tests were removed from the
active implementation; the historical report above describes that unactivated
attempt faithfully. No systemd unit or lingering change was made.

Changes: direct-socket overlays for dev/prod API+worker only; scoped environment
validation and existing socket group access; pinned Docker CLI 29.6.2 in dev/runtime
image stages. Production remains configuration-only. A physical sampling bug was
corrected: dev `availableParallelism()` was 1 under the container quota, whereas
host counters and Docker report 14 logical CPUs. Sampling now consistently uses
host counter capacity (1400 percent), rejects invalid counters/memory/disk, and
retains admission/provider ownership rules.

Actual authorized dev operations:

- Updated only scoped observer inputs and private Compose overlay selection;
  preserved all credentials. Built only the dev app image.
- `docker compose --env-file .env.dev.local up -d --no-deps --wait api worker`:
  both recreated healthy. Supplementary group matches the existing socket group;
  socket permissions unchanged. Only API/worker have the socket mount. No host
  ports, network attachments, frontend, data services or production services changed.
- Standard adapter `createContainerObserver(...).preflight()` from the API passed.
  Worker Docker CLI independently reports 14 CPUs. Actual API physical sample:
  1400 percent CPU, 64302.22 MiB total memory, approximately 24362 MiB available
  memory and 72383 MiB available disk at that instant (not Owner quota suggestions).
  `/app/mountdata` is the existing dev app bind on the host filesystem already
  verified to back Wings data; no Wings contents mounted or read.
- `docker compose --env-file .env.dev.local restart api worker`: passed; all seven
  dev services healthy afterwards and Docker preflight still works. Database
  counts before/after: physical hosts 0, managed nodes 0, runtime mappings 0,
  Owner/user accounts 1. No migrations or records seeded.
- Actual Chromium navigation: HTTPS **200**, certificate verification enabled,
  secure Vite WSS endpoint and **HMR connected frame** received. No UI changes or
  source-edit propagation retest. Existing frontend/catalog watchers unchanged.

Focused source verification:

- `scripts/dev.sh pnpm exec vitest run scripts/deployment-config.test.ts -t 'scoped container environment|deployment Compose isolation'`:
  **36 passed, 6 outside filter**. Two initial assertions expected the old rejection
  text; corrected to assert the rejected field after validation moved earlier.
- `host-resources.test.ts`: **10 passed** (physical-vs-quota CPU, counter changes,
  malformed memory/disk and failure behavior).
- `scripts/dev.sh pnpm typecheck`: passed. Targeted Biome and whitespace passed.
- No historical full M1–M5 test matrix or game-server scenario repeated.
- Independent review: **zero must-fix**, with requested actual CLI/resource/disk
  evidence completed above. Full Docker API authority is an accepted limitation,
  not a security guarantee from the read-only bind mount.

No real servers created or modified, no production deployment, no frontend
redesign. Owner now has the operational observation environment for registering
host/node/mapping configuration themselves. Exact Minecraft evidence, transfer
origins and any Gateway listener plan remain their distinct requirements, not
claims established by this environment check. SFTPGo stays disabled; #18 unchanged.

### 2026-10-10 — Integration-owned runtime images

Trusted Game SDK manifests can now declare fixed images or unambiguous version/
requirement rules. Minecraft resolves Java requirements from its existing trusted
runtime metadata; each new combination freezes the exact resolved image in its
signed evidence and durable provisioning plan. Owner mappings offer **Defined by
integration** or **Fixed image**, localized in English/Italian. Existing static
mappings, evidence digests and existing server images remain unchanged. Egg image
allowlists, rollout and real compatibility evidence remain mandatory; this change
certifies no additional runtime or version.

Focused verification (no historical full-suite or live Minecraft rerun):

- `scripts/dev.sh pnpm exec vitest run packages/game-sdk/src/runtime-images.test.ts packages/game-sdk/src/game-sdk.test.ts games/minecraft/src/image-policy.test.ts games/minecraft/src/runtime.test.ts`:
  **25 passed** across four files.
- Through `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts`:
  existing `registry.integration.test.ts` and `minecraft-registry.integration.test.ts`
  **24 passed**; existing `minecraft-queued.integration.test.ts` **28 passed**.
  New frozen-image/substitution case **1 passed, 28 filtered**. New
  `runtime-images.integration.test.ts` initially **4 passed**, then the additional
  trusted-module hook case **1 passed, 4 filtered**. These are separate full-file
  and targeted results, not a claim that the historical matrix was repeated.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/runtime-images.browser.test.ts`:
  **2 passed** using actual application/auth/Owner handlers and isolated PostgreSQL,
  with the external provider simulated. Integration-mode save, static fallback and
  unchanged legacy mapping verified. Axe: **zero violations** on English desktop
  and Italian mobile; no JavaScript errors or horizontal overflow.
- `scripts/dev.sh pnpm i18n:compile`: **947 keys**;
  `scripts/dev.sh pnpm typecheck`: passed;
  `scripts/dev.sh pnpm --filter @nickhosting/web build`: passed. Existing production
  bundle warning above 500 kB remains; no unrelated bundling rewrite.
- Initial test-authoring failures involved a missing required UDP fixture role,
  test import/translation namespace, wrong browser tab and duplicate mapping on
  the same node. Fixtures were corrected and affected checks rerun successfully.
  A TypeScript inference error in a new test was also corrected before typecheck.

Reviewed real browser captures:
[English desktop](screenshots/m5/runtime-images-integration-desktop-en.png) and
[Italian mobile](screenshots/m5/runtime-images-integration-mobile-it.png).
The Paper selection and synthetic egg in these isolated screenshots exercise the
mapping form only; they are **not Paper runtime certification**. Coordinator and
independent browser reviewer inspected readability, wrapping and dialog scrolling.
Independent technical review found **zero remaining must-fix findings** after
replacing an initial Minecraft-specific dispatch with the generic trusted-module
`resolveProvisionImage` hook.

Development activation: rebuilt the dev app image with
`docker compose --env-file .env.dev.local build api`; recreated only API/worker via
`docker compose --env-file .env.dev.local up -d --no-deps --wait api worker`.
Applied exactly `016_runtime_images.sql` using the normal migration engine inside
the existing dev API. All seven services healthy. Before/after counts unchanged:
**1 physical host, 1 managed node, 0 runtime mappings, 1 user, 0 managed servers**.
No Owner configuration seeded, database reset or production migration performed.
Frontend/catalog watchers and network attachments were not changed.

Read-only discovery through the regular encrypted configuration and Pterodactyl
adapter succeeded. Installed egg metadata advertises policy images for Java
8/11/16/17/18/21/25 in aggregate; this does not prove every egg supports every image.
No provider writes, new game servers, egg changes or new infrastructure occurred.
SFTPGo #18 and direct-socket #22 remain unchanged.

Rollback requires a reviewed forward fix or data-aware migration: do not blindly
remove the mode column or revert to a binary that hashes it differently after
integration mappings exist. Preserve signed evidence and frozen provisioning
images; never silently substitute another image to recover a failed operation.

### 2026-10-10 — Vanilla catalog and centered creation installer

The Owner-approved flow is now Game → Name → Version → Operators → Whitelist →
Resources → EULA/Create. Vanilla no longer asks for Project or Server content.
SDK descriptors own the game pages, avatar presentation and 1–2 / 3–5 / 6+
resource recommendations. Custom CPU/RAM remain available. Shared storage hides
disk input and resolves an Owner default transactionally; it does not grant
unlimited disk or bypass pool/backup reservations. First activation copies OPs to
whitelist; later edits survive off/on toggles, and disabled lists are not submitted.

Owner Vanilla discovery derives recognized egg bindings and Java images from
integration policy plus official metadata, registering multiple versions in one
bounded request. It reports missing server downloads/unsupported egg contracts.
No per-version technical form is required for recognized Vanilla eggs. Advanced
registration remains collapsed for exceptional contracts. Java boundaries were
read against real official Mojang metadata (8/16/17/21/25 at the documented range
boundaries). No new game version or runtime was live-certified in this change.

Actual focused verification:

- `scripts/dev.sh pnpm exec vitest run packages/core/src/core.test.ts`: **45 passed**.
  An initial command referenced nonexistent `config.test.ts` and ran zero tests;
  the actual core suite above was then run.
- Runtime, Vanilla Java-range/egg contract, compatibility and catalog ordering
  unit files: **30 passed** (22 runtime/policy/egg + 6 compatibility + 2 catalog).
- `scripts/dev.sh pnpm exec vitest run packages/game-sdk/src/ui.test.ts games/minecraft/src/ui/ui.test.ts`:
  **18 passed**, including final additive page/field contract validation.
- Through `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts`:
  `registry.integration.test.ts` + `platform-queries.integration.test.ts` **37 passed**;
  `minecraft-catalog.integration.test.ts` + `runtime-images.integration.test.ts`
  **8 passed**. API Minecraft + Minecraft registry initially **16 passed, 2 failed**
  because expected public projections lacked additive `releaseType`; corrected
  expectations, both affected cases passed on targeted rerun (16 filtered).
- Browser command prefix:
  `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.
  `apps/web/tests/platform.browser.test.ts -t installer`: **2 passed, 9 filtered**.
  Real handlers prove accepted creation, actual isolated job execution and truthful
  first-start capacity denial, Enter-to-add, pending-identity navigation lock,
  whitelist removal/toggle preservation, hidden shared disk, EULA link, Back,
  desktop EN/mobile IT and reduced motion. Axe: **zero violations** on tested states.
- `apps/web/tests/vanilla-catalog.browser.test.ts`: unsupported-contract case passed;
  discovery case passed behavior but found an actual Axe target-spacing violation.
  Added normal control spacing; `-t 'discovers multiple versions'` then passed,
  **zero Axe violations** and page errors. This is one initial pass plus one
  affected rerun, not a claim that every browser suite ran again.
- Final aggregate `scripts/dev.sh pnpm typecheck`: passed. WebPanel production
  build passed; existing >500 kB chunk warning remains. Targeted formatting/lint,
  i18n completeness and index governance are recorded with this revision.

During UI test development, a collapsed whitelist remained visually measurable;
fixed visibility/inert behavior. A subsequent CSS edit accidentally hid headings
under reduced motion; corrected before the final two-case browser pass. These
failures were not suppressed. Independent review found and resolved a pending
player lookup race (stale edits/navigation); lookup now freezes conflicting
controls, aborts on unmount and checks the list bound for Enter. Final review found
**zero remaining must-fix source or UX findings**. Seven desktop/mobile captures
were independently inspected; coordinator also inspected name and whitelist views.

Sanitized actual-browser captures (all use isolated, explicitly synthetic game
metadata/provider/evidence and do not certify these displayed releases):

- [Desktop name](screenshots/m5/installer-name-desktop-en.png),
  [version](screenshots/m5/installer-version-desktop-en.png),
  [operators](screenshots/m5/installer-operators-desktop-en.png),
  [whitelist](screenshots/m5/installer-whitelist-desktop-en.png),
  [resources](screenshots/m5/installer-resources-desktop-en.png).
- [Italian mobile name](screenshots/m5/installer-name-mobile-it.png),
  [version](screenshots/m5/installer-version-mobile-it.png),
  [operators](screenshots/m5/installer-operators-mobile-it.png),
  [whitelist](screenshots/m5/installer-whitelist-mobile-it.png),
  [resources](screenshots/m5/installer-resources-mobile-it.png),
  [confirmation](screenshots/m5/installer-review-mobile-it.png).
- [Owner discovery](screenshots/m5/vanilla-catalog-owner-desktop-en.png).
  Player-input gray masks are screenshot sanitization, not application styling.
  Displayed verification records and avatars belong to the fixture only.

Development changes are source/catalog updates consumed by the existing watchers.
No dependency/image rebuild, SQL migration, new network, container, Owner mapping,
host/node seed or setting mutation is needed. Read-only regular-adapter discovery
confirmed the Owner's Vanilla egg exposes the recognized version/JAR variables.
The first inspection script used an incorrect database cleanup method after its
successful read; corrected to `db.destroy()` and repeated successfully. No secrets
were printed and no remote mutation occurred. Historical M4 live tests were not
repeated. Browser schemas are disposable; development review data is preserved.

**Remaining operational prerequisite:** fresh catalog entries stay disabled and
unverified. Existing M4 signatures bind exact local mapping/image/artifact identity;
they cannot certify the Owner's new mapping automatically. Ordinary creation still
requires legitimate current combination evidence and Owner enablement. The new
catalog removes repetitive manual configuration, not the evidence gate. This
handoff does not claim that fresh dev choices are ready to create real servers.
SFTPGo #18 and accepted Docker-socket #22 remain separate release risks.

Rollback: revert the UI/catalog change if required; existing server and mapping
identities are unchanged. Already discovered local combinations are durable records,
not remote assets; do not delete their evidence or historical audits as cleanup.
The new default setting is additive and does not resize existing servers.

Final dev smoke: actual Chromium HTTPS navigation returned **200** and received
Vite's **connected** frame over **WSS** with normal certificate validation. No
login/account mutation was performed. Read-only database counts remain **1 host,
1 node, 1 mapping, 1 user, 0 managed servers, 0 combinations**; catalog discovery
was exercised only in disposable test schemas, leaving the Owner's real dev
configuration for their control. All seven dev services remained healthy with no
published host ports; no restart/recreate was necessary for this source-only change.

A final read-only prerequisite check found the development metadata User-Agent and
Minecraft evidence verifier key unset. Added a non-secret public application
User-Agent default (project GitHub contact), preserving Owner/environment overrides;
its targeted core regression **1 passed, 45 filtered**, independently reviewed.
Actual Mojang discovery from the dev API container then succeeded: **103 stable
metadata entries** (not 103 verified/server-installable versions). No catalog rows
were inserted. The evidence verifier key remains absent: a legitimate runner/verifier
key and identity-matching reports are required before enabling creation. No signing
key was fabricated or copied from another environment.

## 2026-10-10 — trusted declarations and optional Gateway

This Owner-approved amendment **supersedes the per-mapping signed-evidence creation
prerequisite in the previous checkpoint**. Earlier failures and live M4 evidence
above remain historical records, not new compatibility claims.

The trusted Vanilla integration declares installation/direct access independently
from Gateway, readiness, idleness, sleep/wake and player-list support. The compiled
Gateway pair remains Vanilla 26.1/protocol 775, supported by existing M4 coverage;
other installable Vanilla combinations use direct access. No new real-client or
live-server certification is claimed. Paper/Folia/Fabric/Forge are not promoted.
Actual egg/image/startup identity, artifact integrity, immutable mapping, ownership,
resource admission, permissions and rollout still apply. The first observed installed
image digest is pinned atomically; drift is refused. Legacy/snapshot combinations
without declared player-list support hide those wizard pages and reject incompatible
player commands.

New catalog rows are enabled from the trusted declaration. Ordinary resync preserves
existing disabled choices. The explicit Owner batch-enable option enables supported
versions in the processed batch without requiring individual report uploads or a
local signing key. Owner screens separate declared capabilities from historical
reports; no signature or test evidence is fabricated.

Direct mode freezes an explicit Owner-configured player hostname/port, independently
of the provider and effective backend addresses. Public provider bindings require
explicit direct-only delivery. Canonical endpoint uniqueness, live allocation/node
identity and existing claim immutability remain enforced. Direct servers do not
register Gateway routes or execute sleep/wake jobs. Scheduled manual operations
retain consent/admission. Readiness is unavailable, not indefinitely loading.
No listener, forwarding or DNS change occurs; external reachability is unverified.

Focused executable evidence (not a historical full-suite rerun):

- `scripts/dev.sh pnpm exec vitest run games/minecraft/src/compatibility.test.ts games/minecraft/src/gateway-module.test.ts games/minecraft/src/ui/ui.test.ts packages/game-sdk/src/gateway.test.ts`: **31 passed**.
- Integration runner prefix: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts`.
- `packages/server-management/src/allocation-pool.integration.test.ts`: **45 passed**, including canonical aliases, direct public binding opt-in, claimed delivery/endpoint immutability.
- `packages/server-management/src/minecraft-queued.integration.test.ts`: final **29 passed**. After removing the disabled-Gateway fallback, the initial rerun's 29 cases failed during common fixture setup because its allocation pool lacked explicit direct endpoints. Fixed only that isolated fixture; no product fallback restored.
- Minecraft registry/catalog: initial **9 passed**; after adding explicit batch enablement, catalog file **3 passed**.
- API Minecraft: **12 passed**, plus targeted missing-direct-endpoint refusal **1 passed / 12 filtered**; no server/job is persisted for that refusal.
- Gateway/operation/external/platform integration files: initial **60 passed, 2 failed**. Corrected one duplicate-endpoint fixture and restored an actual mapping-digest guard; affected **2 passed / 28 filtered**. Additional scheduling/queued-direct guards **2 passed / 61 filtered** after correcting return-value test assertions. Direct readiness presentation **1 passed / 17 filtered**.
- Runtime/queued initial focused checks **70 passed**. Content initial **28 passed / 2 failed** due to the host's 9% free disk versus the fixture's default 10% margin. Fixture-specific margin is 1% with 512 MiB absolute headroom retained; production defaults unchanged. Affected two passed; three added report-free installation/hash/legacy regressions also passed.
- Browser command prefix: `LD_LIBRARY_PATH=$HOME/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.
- `apps/web/tests/vanilla-catalog.browser.test.ts`: **3 passed**, zero Axe violations/page errors. Initial bootstrap exposed strict public-schema parsing of persisted `playerIdentities`; corrected to the existing stored schema. A later selector-only failure was corrected before the successful run.
- `apps/web/tests/direct-endpoints.browser.test.ts`: **2 passed**, zero Axe violations/page errors/viewport overflow. Real protected handler saves an unclaimed endpoint (200), rejects claimed endpoint changes (409). Initial screenshots exposed cramped fields; moved controls below inventory and reran these two cases successfully.
- Final aggregate `scripts/dev.sh pnpm typecheck`: passed. Production WebPanel build passed with the existing >500 kB chunk warning. Targeted Biome passed with existing non-null/reduced-motion warnings. EN/IT/pseudolocale compile includes **1007 keys**.

Tests use real handlers and disposable schemas on the already-approved isolated
test database, with simulated external providers/metadata. No real game server is
created. Sanitized actual-browser captures, independently reviewed:
[Owner declarations](screenshots/m5/vanilla-declarations-owner-desktop-en.png),
[direct endpoint desktop](screenshots/m5/direct-endpoints-desktop-en.png),
[direct endpoint Italian mobile](screenshots/m5/direct-endpoints-mobile-it.png).

Independent review found and resolved four issues: equivalent endpoint aliases,
claimed Gateway-to-direct delivery changes, missing direct endpoint fallback and
misleading readiness. Final source and screenshot review reports no remaining
must-fix. Configuration and validation history above is preserved.

Development delivery used only the existing authorized `nickhosting-dev` project:
`docker compose --env-file .env.dev.local build api`, then
`docker compose --env-file .env.dev.local up -d --no-deps --wait api worker`.
The standard `migrate(pool)` runner executed inside the recreated dev API container
applied **017_direct_connections.sql** and **018_runtime_image_digest.sql**. Existing
servers default to their previous Gateway mode; image pins are nullable/additive.
No Owner configuration was seeded or enabled. Before/after counts: **1 host, 1 node,
1 mapping, 1 user, 0 managed servers, 20 combinations**. All seven services healthy,
no published host ports, dev ingress attachment unchanged. Actual Chromium HTTPS
returned **200** and received a Vite **connected** frame over **WSS** with normal
certificate verification. No account/browser mutation in this smoke check.

The Owner must explicitly provide already-working direct player endpoints in their
allocation pool and enable desired existing choices (the batch option is available).
No production Pterodactyl resource, networking, NPM, DNS or credentials changed.
SFTPGo #18 and accepted Docker-socket #22 remain separate release concerns.
Rollback is a scoped application revert coordinated with these additive schema
migrations; never delete migration history, review data or newly created server
identities. No claim of automatic database downgrade or provider rollback.

Final affected content-file run using the integration prefix above:
`packages/server-management/src/minecraft-content.integration.test.ts` —
**33 passed** on the final module/schema and direct-mode source (44.58 seconds).
This includes the earlier affected cases; it is not an additional full M1–M5 run.

Index governance initially flagged an absolute private home path in this command
record; replaced it with `$HOME`. No credential was present.
Final index governance: **461 text files, 66 reviewed PNGs, 378 relative links,
4 TOML files, 44 ignored-path cases — passed**. Staged whitespace passed; private
files remain ignored. The scanner is heuristic, not a guarantee against every secret.

## 2026-10-10 — Runtime step and truncated discovery correction

Read-only development diagnosis found **20 stable release entries disabled** from
the old policy and **19 enabled snapshots**. Default stable filtering therefore
correctly had no eligible results, while Show all exposed only registered snapshots.
The Owner UI previously fetched only one 20-entry page, making this incomplete
catalog easy to mistake for complete discovery. No dev entries were automatically
enabled or deleted during this correction.

Creation is now Game → Runtime → Name → Version, with generic SDK choice pages
positioned before Name. Only eligible runtime choices appear; selecting Vanilla
produces release-only version labels. Runtime-dependent cache/reset contracts avoid
stale choices. Snapshot-only stable-filter results explain how to reveal other
enabled versions. The Owner discovery action now processes all bounded pages
sequentially, preserving completed results across failures, supporting cancellation
and explicit resume. Previously disabled entries still require the explicit Owner
enabling checkbox; cancellation does not imply rollback of an in-flight request.

Targeted evidence:

- Minecraft UI/Game SDK units: **20 passed**. Catalog paging helper: **7 passed**,
  covering sequential completion, retry cursor, cancellation and invalid cursor bounds.
- Browser runner: `LD_LIBRARY_PATH="$HOME/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu" scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.
- `apps/web/tests/vanilla-catalog.browser.test.ts`: **5 passed** (13.57s). Real
  authenticated handlers/database with isolated providers/metadata prove Runtime
  before Name, release-only labels, stable/all filtering and a snapshot-only first
  page of 20 followed automatically by the later stable entries. Explicit enabling
  makes previously disabled fixture releases eligible. EN desktop/IT mobile runtime
  and version views pass Axe; no page errors or viewport overflow.
- `apps/web/tests/platform.browser.test.ts -t 'creates a verified-choice|renders the installer'`:
  **2 passed, 9 filtered** (18.70s), including complete fixture creation, first-start
  admission refusal and preserved Italian mobile Back/reduced-motion behavior.
- Aggregate `scripts/dev.sh pnpm typecheck`: passed. No full historical suites or
  live Minecraft tests repeated; no extra infrastructure was started.

Reviewed actual screenshots: [Runtime desktop](screenshots/m5/runtime-step-desktop-en.png),
[Runtime mobile](screenshots/m5/runtime-step-mobile-it.png),
[Versions desktop](screenshots/m5/runtime-versions-desktop-en.png),
[Versions mobile](screenshots/m5/runtime-versions-mobile-it.png).
Independent technical and visual review: **no must-fix findings**. Switching between
two eligible runtimes has controller/descriptor tests; the browser fixture truthfully
offers only Vanilla, so it does not claim multi-runtime real-server support.

The existing dev source/i18n watchers deliver this change without database migration,
container recreation, Owner configuration mutation or production interaction.
No test-owned live assets created. Disposable test schemas are cleaned by the harness.
SFTPGo #18, Docker-socket #22 and direct-endpoint reachability boundaries are unchanged.
Rollback is a source revert; already synchronized catalog entries are durable records
and must not be removed as cleanup. PR #21 remains unmerged.

Final focused aggregate unit run (`games/minecraft/src/ui/ui.test.ts`,
`packages/game-sdk/src/ui.test.ts`, `apps/web/src/features/catalog-sync.test.ts`):
**27 passed**. Final build passed (existing bundle-size warning), Biome clean,
EN/IT/pseudolocale **1015 keys**. Actual dev HTTPS returned **200** and Chromium
received a Vite **connected** frame over **WSS**; no sign-in or account mutation.
Index governance passed: **463 text files, 70 review PNGs, 382 relative links,
4 TOML files, 44 ignored-path cases**. Staged whitespace checks passed.

## 2026-10-10 — Bounded Owner version catalog and scan feedback

Owner integration catalogs now use a fixed-height scroll region with 25-row
pages, search, runtime/type/availability filters and date/name ordering. Minecraft
release dates come from the official Mojang manifest, independent of database
insertion order; unknown dates remain explicit and last. Authorized API pagination
also removes the WebPanel's former silent 1,000-row truncation. Shared catalog and
scan components are reusable by other trusted integration modules.

Scans show acknowledged progress, approximate remaining time after two measured
batches and a bounded keyboard-scrollable log. The browser test holds the third
fixture request temporarily, proving the displayed **40/44** progress and measured
estimate before completion. Cancellation/resume and explicit enabling remain intact.

Focused final commands and results:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/components/catalog-browser.test.ts apps/web/src/components/catalog-pages.test.ts apps/web/src/features/catalog-sync.test.ts games/minecraft/src/catalog-dates.test.ts`:
  **18 passed**, including date fallback/order, pagination, cancellation/resume and
  deterministic-clock ETA checks.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/minecraft.integration.test.ts -t 'paginates more than|validates Owner catalog pagination'`:
  **2 passed, 13 filtered**, including 1,001 catalog entries without omissions or
  duplicates, authorization, cursor validation and legacy response compatibility.
- `LD_LIBRARY_PATH="$HOME/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu" scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/vanilla-catalog.browser.test.ts`:
  **6 passed**. Real application handlers/authentication and isolated PostgreSQL;
  external provider/metadata fixtures. Search, filters, mixed chronological order,
  pagination/scroll reset, keyboard scrolling and active scan progress verified.
  Desktop EN/mobile IT have zero Axe violations, page errors or body overflow.
- `scripts/dev.sh pnpm typecheck`: passed across core, web and browser tests.
- `scripts/dev.sh pnpm build`: passed, **1,039** localized keys; the existing
  large-bundle warning remains. No full historical or live Minecraft suite repeated.

Preserved failed attempts: the first browser run had **4 passed, 2 failed** from
asserting a log after clearing it and a stale fixture count. The next had **5 passed,
1 failed**, with a held-request timeout/unhandled test promise caused by a wrong
ETA text selector. Test sequencing/selectors were corrected; the final six-test
run has no failures or unhandled errors. These were fixture/assertion defects,
not evidence of successful earlier runs.

Reviewed real Chromium screenshots:
[Catalog desktop EN](screenshots/m5/catalog-browser-desktop-en.png),
[Catalog mobile IT](screenshots/m5/catalog-browser-mobile-it.png),
[Active scan desktop EN](screenshots/m5/catalog-scan-progress-desktop-en.png).
Independent technical and visual/content review found **no remaining must-fix
issues**. The identified 1,000-row truncation was resolved and tested. Optional
log-follow behavior and removing the focused Skip link from future screenshots
are nonblocking polish, not claimed completed work.

No Owner settings, enabled versions, mappings, provider resources or development
application data were changed. Existing source/i18n watchers deliver the change;
no migration, container restart or new infrastructure is required. Only existing
approved isolated test services and disposable schemas were used; no live game
assets were created. SFTPGo #18 and Docker-socket #22 remain unchanged. Rollback
is a source revert, with no catalog-record deletion. PR #21 remains unmerged.

Final scoped Biome check: **16 files passed**, with three pre-existing
`!important` warnings in reduced-motion CSS. `scripts/dev.sh pnpm i18n:check`
passed for all 1,039 keys. `python3 scripts/check-governance.py` passed for
**470 indexed text files, 73 review PNGs, 385 relative links, 4 TOML files and
44 ignored-path cases**; staged whitespace passed. The secret scan is heuristic,
complemented by source and sanitized screenshot review.

## 2026-10-10 — Catalog loading measurement, no optimization

[Measured service-path breakdown](M5-CATALOG-PERFORMANCE.md) records three rounds
on the current 693-entry development catalog with a forced read-only database
connection. Owner list: 2,093 queries, 640–1,220 ms; the sole cold Mojang request
was 149 ms. Wizard user paths: approximately 673–975 ms each, 2,773/2,774 queries
and zero external requests. Synthetic role inputs exclude session authentication;
actual browser/proxy/rendering timings remain unmeasured. Independent methodology
and evidence review passed. No app code, configuration, provider or infrastructure
change; no historical suite rerun. Optimizations await Owner discussion.

## 2026-10-10 — Catalog optimization, persistent manifest and wizard reuse

Implemented after the measurement review. The ordinary Minecraft catalog uses
three aggregate queries for declared Vanilla choices, with one additional bulk
evidence query only when undeclared runtimes require it. Owner summary pages use
four queries and load full evidence separately. The SDK now supports a shared
trusted creation catalog; Servers prefetches games and runtime/version steps reuse
one authorized choices response. Real release dates interleave snapshots/releases.

Migration 019 adds persistent manifest/date metadata and synchronization state.
The worker refreshes every 15 minutes, guarded by a durable cross-worker lease;
failed downloads preserve last-good data. It applies only new/changed metadata
rows and never registers/enables runtime combinations automatically. List reads
and explicit Owner discovery manifest reads use the local copy.

Final focused validation:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/creation-catalog.test.ts games/minecraft/src/ui/ui.test.ts packages/game-sdk/src/ui.test.ts apps/web/src/components/catalog-browser.test.ts apps/worker/src/minecraft-metadata.test.ts`:
  **31 passed**. Covers request reuse, Owner-write and identity invalidation,
  trusted generic SDK projections, chronological options, controlled filters on
  remount and worker metadata polling failures.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/minecraft-registry.integration.test.ts apps/api/src/minecraft.integration.test.ts`:
  **24 passed**. Includes 1,001 entries with exact bounded SQL counts, global
  filtering/sorting/pagination, legacy responses, Owner detail authorization,
  mapping identity and rollout/evidence gates. Initial failures were stale expected
  additive fields and a large fixture leaking into an empty-catalog assertion;
  expectations and test isolation were corrected before the passing run.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/minecraft-metadata.integration.test.ts`:
  **5 passed**. Changed/unchanged manifest, unchanged-row preservation, last-good
  failure recovery, concurrent lease election and late-writer/crash fencing.
- `LD_LIBRARY_PATH="$HOME/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu" scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/vanilla-catalog.browser.test.ts`:
  **6 passed**, final 26.38 s. Actual Chromium/handlers/auth/database with external
  metadata/provider fixtures. Asserts exactly one games request from Servers and
  one choices request across runtime/name/version/Back/Show all; only the initial
  fixture metadata sync fetches the manifest. Also checks mixed release chronology,
  server-side filters/pages, discovery progress and Owner details. Desktop EN/mobile
  IT: zero Axe violations, page errors or body overflow. Earlier six-test run also
  passed; only this focused file was repeated after final regression coverage.
- `scripts/dev.sh pnpm build` and `scripts/dev.sh pnpm typecheck`: passed.
  **1,042 EN/IT/pseudolocale keys**; existing >500 kB bundle warning remains.
  No full historical suite or live Minecraft test was rerun.

[Repeat performance measurement](M5-CATALOG-PERFORMANCE.md) uses the same 693
actual dev combinations, forced read-only profiling and the same explicit
backend-only limitations. User games median **742 → 29 ms**; choices **840 → 45 ms**.
New Owner 25-row summary: **30 ms**, 21,721 bytes, four SQL queries; this is a
smaller response than the old full catalog, whose like-for-like result is recorded
separately. No browser click-to-display timing is inferred from these numbers.

Reviewed actual screenshots:
[Optimized Owner desktop EN](screenshots/m5/catalog-optimized-desktop-en.png),
[Optimized Owner mobile IT](screenshots/m5/catalog-optimized-mobile-it.png).
Independent technical review found one P2: server-mode filters reset visually after
an error/remount while retaining the old query. Controls now derive from the parent
request; a React remount regression covers this. Final source and visual/content
review found **no remaining must-fix issues**. Focused Skip-link screenshot state
and redundant filtered count wording remain nonblocking polish.

The additive migration was explicitly applied to the existing development database,
with exact SQL/checksum and the normal migration advisory lock, without reset or
modification of existing Owner/server records. First worker sync stored **918**
official metadata entries; existing **693 enabled combinations** stayed unchanged.
Existing watchers reload source; no container recreation, network change, production
operation or Pterodactyl API mutation was performed. Anonymous actual dev smoke:
HTTPS **200**, secure **WSS** and Vite **connected** frame. Tests used existing
approved isolated services and disposable schemas; no real game assets created.

Rollback reverts source and retains the additive tables/migration record; no routine
data deletion or migration downgrade. Future built deployments require migration
019 before the new code starts. Production release still depends on independent
SFTPGo #18 and Docker-socket #22 decisions. PR #21 remains open/unmerged.

Final scoped Biome: **30 files passed**. i18n check: **1,042 keys passed**.
Index governance: **479 text files, 75 review PNGs, 389 relative links, 4 TOML files,
44 ignored-path cases**, passed; staged whitespace passed. The heuristic secret
scan complements explicit source and screenshot review. All seven existing dev
containers remained healthy; no container was recreated for this change.


### 2026-10-10 — Wizard runtime artwork cards

Wizard step 2 now presents runtime choices as centered 3:4 portrait cards using
trusted, bundled integration artwork. The image fades from opaque at the top to
transparent at the bottom over a dark base; the runtime name stays opaque and
readable. Native radios preserve keyboard selection, disabled and checked states,
with whole-card focus and a forced-colors fallback. Version lists, eligibility,
catalog caching and API contracts are unchanged.

Focused final validation:

- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed.
- `scripts/dev.sh pnpm exec biome check apps/web/src/features/installer.css apps/web/src/features/installer-fields.tsx apps/web/src/features/create-server.tsx apps/web/tests/vanilla-catalog.browser.test.ts`: passed, four files.
- `LD_LIBRARY_PATH="$HOME/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu" scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/vanilla-catalog.browser.test.ts -t "discovers declared|offers a direct-only|completes later|renders runtime"`:
  **4 passed, 2 excluded by the name filter**, final **14.46 s**. Actual Chromium,
  application handlers/auth/database and existing approved isolated services;
  external provider/metadata fixtures. Coverage includes keyboard selection,
  loaded artwork, portrait geometry, mobile reflow, Axe, creation navigation and
  unchanged catalog request reuse. These results do not claim a full historical
  suite run.

The first focused run also passed (15.00 s). Screenshot inspection revealed that
shared input sizing stretched the radio focus ring; the card-specific input sizing
and whole-card focus treatment were corrected before the final focused rerun.
Reviewed final screenshots: [desktop EN](screenshots/m5/runtime-cards-desktop-en.png)
and [mobile IT](screenshots/m5/runtime-cards-mobile-it.png). Independent read-only
source and rendered UX/content/accessibility review found **no must-fix findings**.

No backend, SDK, configuration, infrastructure or provider mutation. Existing dev
source watchers apply the UI change. No live test assets created or cleaned;
no container recreation or database migration. Rollback reverts only this source
and documentation change. SFTPGo #18 and Docker-socket #22 remain independent
release decisions; PR #21 stays open and unmerged.


### 2026-10-10 — Wizard density, selection and stable layout

Refines the previous runtime-card checkpoint from Owner feedback. Runtime cards
are now 8.5 rem wide with centered labels and centered wrapping. Runtime and version
radios remain native/keyboard-accessible but visually hidden; contained selection
strokes and decorative checks replace the radio circles. Game selection no longer
has an external blue ring. Global keyboard focus now uses a restrained 2 px
outline rather than the yellow/black treatment, remains enabled, and is not shown
on programmatically focused headings. Error-summary focus remains visible.

The installer reserves positions for its counter, heading, errors, bounded content
pane and actions. Required-field errors and player additions do not shift these
positions. Player lists scroll inside reserved space. Whitelist headings mount in
their initial state; animation occurs on toggling. Player lookup uses read-only,
not disabled inputs, retaining Enter focus without imperative focus stealing.
Name/player fields include field-scoped autocomplete/vendor-ignore hints, including
[1Password's documented attribute](https://www.1password.dev/web/compatible-website-design#ignore-offers-to-save-or-fill-specific-fields).
Actual password-manager extensions were not installed in the fixture browser;
the Owner should confirm their own extension behavior. Authentication inputs are
unchanged. Resource suggestion prose and the shared-storage reminder are removed;
limited storage keeps its input and selected CPU/RAM limits remain visible.

Focused checks (no historical full suites):

- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed on final code.
- `scripts/dev.sh pnpm exec biome check apps/web/src/app/style.css apps/web/src/features/create-server.tsx apps/web/src/features/installer-fields.tsx apps/web/src/features/installer.css apps/web/tests/vanilla-catalog.browser.test.ts apps/web/tests/platform.browser.test.ts`:
  passed six files; three pre-existing `!important` warnings in reduced-motion
  overrides remain, no lint errors. `git diff --check` passed.
- Browser command prefix: `LD_LIBRARY_PATH="$HOME/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu" scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.
- Prefix + `apps/web/tests/vanilla-catalog.browser.test.ts -t "discovers declared|offers a direct-only|completes later|renders runtime"`:
  initial **3 passed, 1 failed, 2 filtered**, 18.78 s. The mobile chronology assertion
  read all text including the new decorative check; it now reads only the label
  span. Desktop error/list/counter/footer stability, Enter focus, bounded card size,
  keyboard selection, Axe and ten-card wrapping passed. The ten-card exercise is
  explicitly DOM-only layout replication, removed before screenshots; it does not
  offer or enable unsupported runtime choices.
- Prefix + `apps/web/tests/vanilla-catalog.browser.test.ts -t "discovers declared|completes later|renders runtime"`:
  affected mobile check plus setup dependencies **3 passed, 3 filtered**, 13.94 s.
- Prefix + `apps/web/tests/platform.browser.test.ts -t "creates a verified-choice|renders the installer"`:
  **2 passed, 9 filtered**, 16.09 s. Actual creation/first-start admission reporting,
  operator/whitelist lookup and pending guards, removal/seeding, custom resources,
  EULA submission, mobile Back navigation, reduced motion and Axe. Existing pointer
  tests now click visible labels rather than clipped native radio inputs.

These are actual Chromium + application/auth/database handlers against the existing
approved isolated test services. Mojang identity/metadata and game providers are
fixtures; MCHeads is substituted or falls back to bundled art. No real game-server
creation is claimed. Screenshots sanitize text inputs and use fixture identities.
Reviewed [game](screenshots/m5/wizard-refined-game-desktop-en.png),
[runtime desktop](screenshots/m5/wizard-refined-runtime-desktop-en.png),
[runtime mobile](screenshots/m5/wizard-refined-runtime-mobile-it.png),
[versions](screenshots/m5/wizard-refined-versions-desktop-en.png),
[populated operators](screenshots/m5/wizard-refined-players-desktop-en.png),
[mobile operators](screenshots/m5/wizard-refined-players-mobile-it.png),
[mobile whitelist](screenshots/m5/wizard-refined-whitelist-mobile-it.png),
and [mobile resources](screenshots/m5/wizard-refined-resources-mobile-it.png).

Independent source/rendered UX/accessibility review found and resolved two issues:
CSS-generated checks polluted radio accessible names (now aria-hidden elements),
and selected game cards lost selection in forced-colors mode (now an inset Highlight
outline, verified independently in Chromium using actual CSS). No remaining
must-fix findings. Programmatic heading focus suppression was also narrowed so
error-summary focus remains visible.

Read-only dev HTTPS smoke returned **200** for `/` and the updated installer CSS/TSX
served by Vite. No rebuild/restart, infrastructure mutation, provider access, database
migration or live test asset creation/cleanup occurred. Existing source HMR applies
these changes. Rollback is a source revert, with no data operation. SFTPGo #18 and
Docker-socket #22 remain independent release decisions; PR #21 stays open/unmerged.


### 2026-10-10 — Runtime selection popout

Owner refinement: remove the runtime checkmark, retain the selected border, scale
the selected card by 1.04 and dim other enabled cards to 0.85 opacity with 160 ms
transitions. Version rows are unchanged. Group padding contains the transform;
layout and keyboard semantics stay unchanged. Reduced motion follows the device
preference (no scale/transition); ordinary animation is enabled otherwise. No
application accessibility preference was added. Forced-colors selection retains
its explicit outline.

Focused Biome (three changed source/test files) and web typecheck passed.
The previous catalog browser command with `-t "discovers declared|offers a direct-only|completes later|renders runtime"`
initially produced **3 passed, 1 failed, 2 filtered** (24.47 s): the existing harness
emulates reduced motion, correctly suppressing the expected scale. The animation
test now explicitly selects normal motion and separately checks reduced motion
and forced colors. Affected rerun with `-t "discovers declared|offers a direct-only"`:
**2 passed, 4 filtered**, 13.43 s. Includes no checkmark, scale, dimming, wrap bounds,
keyboard selection and existing wizard regressions. No historical suite rerun.
Actual screenshots: [desktop EN, normal motion](screenshots/m5/runtime-popout-desktop-en.png)
and [mobile IT, reduced motion](screenshots/m5/runtime-popout-mobile-it.png).
No production/provider operation, container restart, migration or live test assets.
Rollback is source-only; existing development HMR applies the change.
Independent source and desktop/mobile visual review: no must-fix findings.
Index governance passed (479 text files, 87 PNGs, 401 links, 4 TOML files, 44 ignore cases).


### 2026-10-10 — Keyboard continuation and grouped whitelist animation

Name → Versions focuses the selected or first enabled native radio without changing
selection; Up/Down selects and scrolls the corresponding row into view. Versions →
Operators focuses the player input. Whitelist activation/return focuses its input
only when enabled. Entry focus is attempted once and respects focus moved elsewhere
while options load. Empty/whitespace player Enter uses the existing form submission;
nonempty Enter retains lookup. Busy requests and IME composition cannot advance.

Whitelist question and Yes/No controls now share one animated header. Motion is
explicitly armed only by a toggle and reset on Next/Back; initial entry stays still.
Moved toggle controls preserve busy/pending disable guards. Errors have a reserved
slot above navigation, avoiding overlap with the translated closed-state header.
Reduced motion and stable counter/footer positions remain supported.

Focused commands and evidence:

- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed.
- `scripts/dev.sh pnpm exec biome check apps/web/src/features/create-server.tsx apps/web/src/features/installer-fields.tsx apps/web/src/features/installer.css apps/web/tests/vanilla-catalog.browser.test.ts apps/web/tests/harness.ts`: passed; existing harness non-null assertion warning remains.
- Browser prefix remains `LD_LIBRARY_PATH="$HOME/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu" scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.
- Prefix + `apps/web/tests/vanilla-catalog.browser.test.ts -t "discovers declared|offers a direct-only"`: final **2 passed, 4 filtered**, **13.94 s**. Tests keyboard focus, native Up/Down, selected-version focus on Back, empty Enter through operators/whitelist, player lookup retention, grouped movement, no entry animation, stable navigation and preparation-failure geometry. The error is an isolated HTTP 503 after explicitly invalidating this fixture browser's cached request, not a real provider failure.
- Prefix + `apps/web/tests/platform.browser.test.ts -t "creates a verified-choice|renders the installer"`: **2 passed, 9 filtered**, **15.49 s**. Creation/admission reporting, pending-player guards, whitelist seed/remove behavior, resources, EULA and mobile/reduced-motion/Axe journey remain passing.

Failure history is preserved: the first four-case catalog run had **3 passed/1 failed**
(17.92 s), detecting an entry transition despite the keyed header; explicit toggle-only
motion fixed it. Two affected reruns (**1 passed/1 failed** each, 18.78 s and 13.85 s)
exposed test-injection issues: a valid cached catalog bypassed the intended 503, then
Vitest rewrote a browser dynamic import. Browser-local invalidation/evaluation fixed
the fixture; **2 passed** (14.87 s). Final 13.94 s rerun captured corrected screenshots
after masks were limited to visible inputs: hidden inputs previously produced a
phantom gray mask in the closed state. All visible sensitive fields remain masked.
No full historical suite was repeated.

Actual reviewed screenshots: [closed](screenshots/m5/wizard-keyboard-whitelist-closed-en.png),
[open](screenshots/m5/wizard-keyboard-whitelist-open-en.png),
[preparation error](screenshots/m5/wizard-keyboard-whitelist-error-en.png),
[mobile IT](screenshots/m5/wizard-keyboard-whitelist-mobile-it.png).
Tests use actual application/auth/database handlers with existing approved isolated
services and external-provider fixtures. No infrastructure restart/mutation,
production provider operation, migration or live test assets. Existing dev HMR
applies source edits. Rollback is source-only; release gates #18/#22 are unchanged.
Independent source and rendered UX/accessibility review: no remaining must-fix findings.


### 2026-10-10 — Game/runtime Enter and name focus

Enter on a selected game advances through ordinary form validation; Enter on an
unselected game still selects it first. Runtime Enter explicitly submits the same
form. Custom handlers exclude repeated/composing Enter. Entering Name focuses its
textbox once per step transition, without stealing focus during edits. No CSS,
backend/API, provider or infrastructure change; existing dev HMR applies source.

`pnpm --filter @nickhosting/web typecheck` through `scripts/dev.sh`: passed.
Scoped Biome for create-server, installer-fields and vanilla-catalog browser test:
passed. The prior browser prefix with
`apps/web/tests/vanilla-catalog.browser.test.ts -t "discovers declared|offers a direct-only"`:
**2 passed, 4 filtered, 14.14 s**, first run. Tests exercise actual Chromium/handlers
with approved isolated services and provider fixtures: first/second game Enter,
runtime Enter, immediate name focus and existing later-step keyboard regressions.
[Actual focus screenshot](screenshots/m5/wizard-name-keyboard-desktop-en.png) reviewed;
independent source review found no must-fix. No historical suite rerun or live assets.
Rollback is source-only; PR #21 remains open/unmerged and release gates unchanged.


## 2026-10-10 — Development Gateway activation preparation (not activated)

Request: start reactivating the existing Game Gateway for interactive development.
The base stack had no Gateway service and forced `NH_GATEWAY_ENABLED=false`.
Added the opt-in Compose overlay, independent scoped service bootstrap, private
Unix readiness check and narrowly authenticated dev ingress control prefix.
No routing, admission, protocol, lease or provider ownership policy was weakened.
No UI change, Owner host/node/egg mapping, route or allocation was created.

Read-only dev inspection: seven existing services healthy; no Gateway container
name collision; API retains edge/data/egress, only web attaches to `prod-frontend`.
Approximately 25,103 MiB available RAM and 68 GiB available filesystem space at
inspection (not a future admission decision). Owner Gateway settings/routes and
managed-node backend allocation pool absent. An independently identified existing
host user service manager supplied readable namespace/socket metadata; exact
identity recorded privately. Root PID1 namespace was not readable by the dev
user; no permissions changed. Container-side proof remains untested.

Final focused checks:

- `scripts/dev.sh pnpm exec vitest run scripts/deployment-config.test.ts scripts/gateway-deployment.test.ts apps/game-gateway/src/control-client.test.ts apps/game-gateway/src/main.test.ts`: **92 passed**, 4 files, 2.52 seconds. Includes actual Compose parsing with fictitious credentials, service isolation, default-disabled/real-mode opt-in, credential rejection, Unix health and existing runtime/control recovery tests.
- `scripts/dev.sh pnpm exec tsc --noEmit`: passed.
- `scripts/dev.sh pnpm exec biome check deploy/container-env.mjs scripts/deployment-config.test.ts deploy/gateway-health.mjs deploy/gateway-health.d.mts scripts/gateway-deployment.test.ts`: passed after formatting.
- `python3 scripts/check-governance.py` and `git diff --check`: passed (rechecked after staging).
- Independent configuration/security review: no must-fix findings. Clarified game readiness versus zero-route control health; moved namespace preflight before any API/worker/web recreation.

No images built, containers started/restarted, persistent data changed or game
ports bound. No full historical/live-server suite repeated for deployment-only
changes. Nginx runtime validation, container namespace access, HTTPS service
control and all actual forwarding/sleep-wake tests remain pending activation.
A healthy empty Gateway is not evidence of a working game route. The exact scoped
proposal, remaining Owner configuration and rollback are in
[M5 environments](M5-ENVIRONMENTS.md#development-gateway--prepared-activation-pending-2026-10-10).
Issues #18 and #22 remain unchanged. Production deployment remains unauthorized.


## 2026-10-10 — Approved Gateway activation attempt, stopped at namespace preflight

Reviewed starting HEAD: `4b6e1a60b2f716d47e348faa262cbb5c583560a4`, clean worktree.
Owner expressly approved the preceding service-only proposal. Read-only identity,
container-name and network checks matched; available RAM approximately 25,084 MiB,
filesystem free 68 GiB. Private bootstrap generated; no secrets printed.

Actual commands/results:

- `docker compose --env-file .env.dev.local --profile gateway config --quiet`: passed.
- `docker compose --env-file .env.dev.local build api web`: passed, locked dependencies. App image `sha256:f6346654de604d6c01e251b6a8da973984fe6b634ef15a799022540045a5195e`; web image `sha256:556c85ef6c0f8f73e4deca5eb660fd6812516af1c33ede8d07e6e4d0e1f56ea6`.
- Documented `run --rm --no-deps --entrypoint node gateway` namespace preflight: **FAILED**, exit 1, `EACCES` reading `/run/nickhosting-host-proc/ns/net`. This is an actual failed deployment prerequisite, not a passing activation test.
- Temporary container `nickhosting-dev-gateway-run-32ed7d55a457` removed automatically; no permanent Gateway created. API/worker/web recreation deliberately skipped after failure.
- Restored prior private Compose selection; repeated `config --quiet`: passed. Dedicated new private Gateway credentials retained; application data and accounts untouched.
- Scoped Docker status: all seven existing dev services still healthy with original uptimes; stopped historical provider unchanged. No game/test server or probe created. No new network/public port, NPM, Wings or production mutation.
- `curl --silent --output /dev/null --write-out 'HTTPS status: %{http_code}\n' https://dev.hub.nickhost.ing/`: **200**.
- New unexecuted diagnostic overlay parsed using real Compose, comparing objects in memory without printing secrets: only Gateway AppArmor security option differs. Other services/networks, nonroot UID, dropped capabilities and absence of published ports preserved.

Previous 92 focused source tests remain valid; source implementation is unchanged
and no historical suite repeated. Activation is blocked pending the exact one-off
diagnostic approval in [M5 environments](M5-ENVIRONMENTS.md#next-diagnostic-proposal--not-approved-or-executed).
AppArmor is a hypothesis, not yet a confirmed cause. Independent review also
confirmed missing Owner Gateway host/network/observer settings prevent health;
zero-route readiness would not validate actual forwarding or Docker observer access.


## 2026-10-10 — Authorized one-off AppArmor diagnostic succeeded

Owner approval was conditional on leaving the existing Pterodactyl stack untouched.
At starting HEAD `bef135d764885b49b21d9cf847470fd55d82b1aa`, reverified the exact
recorded host process UID/executable/parent/starttime/namespace and daemon, clean
worktree and original private Compose selection. No credentials printed.

- Executed exactly the [documented one-off command](M5-ENVIRONMENTS.md#next-diagnostic-proposal--not-approved-or-executed), with explicit five-file Compose chain, `run --rm --no-deps --entrypoint node` and only namespace/socket-table reads. **Exit 0**, `Independent namespace preflight passed`.
- Temporary `nickhosting-dev-gateway-run-b83eab3f18dc` was automatically removed. No permanent Gateway or listener created. No dependency service started/recreated and no private Compose setting changed.
- Before/after inventory retained the same 102 existing container IDs. Panel and Wings metadata (images, start times, restart counters and network attachments) unchanged. A blanket equality check correctly flagged unrelated containers whose pre-existing restart counts exceeded 21,000 and advanced during observation; no restart or change was issued against them. This is not claimed as a globally static host snapshot.
- All seven existing dev services healthy; HTTPS `GET /` returned **200**. No Pterodactyl API calls, production mutation, new network or persistent application-data change.
- Independent reviewer confirmed the exact command avoids Gateway main, listener binding and dependency recreation. No must-fix finding in the diagnostic scope.

Result isolates AppArmor involvement in the namespace access failure; it does not
prove complete observer/Gateway readiness. No permanent unconfined profile was
applied. Source and previous tests unchanged; no full suite repeated for this
infrastructure diagnostic. Governance and staged whitespace checks passed.
Gateway remains inactive pending a separately reviewed confinement decision and
required Owner configuration. Production release gates #18/#22 unchanged.

## Mixed direct/Gateway pools and explicit initial automation — 2026-10-10

Corrected NickHosting's address-wide rejection of explicit direct pins on a
Gateway ingress IP. Mixed delivery on one provider node is now allowed at distinct
ports. Actual endpoint collisions remain rejected in both configuration orders;
checks include durable claims, sibling/disabled nodes, environment overrides,
disabled routes and both Wings transports. Public ports are checked independently
of backend ports. Existing route revocation remains possible after a conflicting
environment override. No provider identity, readiness, collision-observer or
resource-admission guard was removed.

Focused evidence (existing approved M2 isolated stack only):

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/allocation-pool.integration.test.ts`: **52 passed**.
- The same runner with `packages/server-management/src/loopback-allocation.integration.test.ts`: **41 passed**.
- The same runner with `packages/server-management/src/gateway-registry.integration.test.ts packages/server-management/src/gateway-deletion.integration.test.ts apps/api/src/gateway.integration.test.ts`: **42 passed** before the final revoke-under-conflict regression. Final targeted registry rerun: **24 passed**; deletion/API tests were not unnecessarily repeated.
- `scripts/dev.sh pnpm exec vitest run packages/gateway-safety/src/validator.test.ts apps/game-gateway/src/node-probe.test.ts apps/game-gateway/src/node-probe-main.test.ts scripts/gateway-deployment.test.ts`: **100 passed**, including read-only Compose parsing for the separate unapplied live overlay and bounded nonce protocol tests.
- Pure schema preflight with 1,000 synthetic direct pins and 2,000 private backend pins on one node: **3,000 accepted**. Addresses and IDs were fixtures; no provider allocations were created.
- Root `scripts/dev.sh pnpm exec tsc --noEmit`, focused Biome and `git diff --check`: passed for the pool/route/probe implementation.

Initial new retained-claim fixtures attempted an identity update and were correctly
rejected by the existing database immutability trigger. Tests were corrected to
insert distinct fixture claims; no trigger was relaxed. Independent review found
that the new collision guard could prevent disabling an existing route after an
environment pool override. Fixed by checking existing immutable identity first
and applying the new guards to creation/enabling; the final 24-test registry run
includes this regression. No remaining must-fix pool/route findings were reported.

Read-only real-environment recheck: provider inventory still contained 400 direct
range allocations, with none in the proposed 2,000-port Gateway interval. Neither
configured Docker bindings (including stopped containers) nor host TCP/UDP
listeners occupied that interval or the proposed private nonce port. Candidate
Gateway/probe container names were absent. This is a point-in-time preflight,
not a reachability or router-forwarding test.

No Pterodactyl server, allocation, node, egg, Wings configuration, Docker network,
NPM, DNS or firewall was modified. No new container was started. Prepared live
Gateway/probe configuration remains unapplied, with exact pending approval and
rollback documented in [M5 environments](M5-ENVIRONMENTS.md). The Gateway remains
disabled in the running dev environment pending activation; no live forwarding or
sleep/wake success is claimed. SFTPGo #18 and Docker socket #22 are unchanged.

A second concrete usability gap was fixed: an eligible installed Gateway server
without a policy now offers an explicit first-configuration action. A trusted
integration derives the protocol/version; no policy is seeded by reads. Initial
settings disable automatic wake and idle sleep. The create-only request is checked
under the shared resource lock and cannot overwrite a concurrent configuration,
ignore an active operation, or downgrade a changed maintenance intent. Independent
review identified that race before delivery; it is covered by regression tests.

Additional targeted final-source evidence:

- Isolated integration runner with `packages/server-management/src/platform-queries.integration.test.ts packages/server-management/src/gateway-orchestration.integration.test.ts`: **68 passed** (22 platform + 46 orchestration). A coordinator orchestration run also passed 46; overlapping delegated execution was unnecessary and was not repeated further.
- `LD_LIBRARY_PATH="$HOME/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu" scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/sleep-policy.browser.test.ts`: **1 passed**, actual API/database handlers with isolated provider fixtures. Verified no GET-side policy creation, explicit conditional PUT, disabled wake/idle defaults, English desktop and Italian mobile rendering, no horizontal viewport overflow and **zero axe violations** for the tested screen.
- `scripts/dev.sh pnpm i18n:check`: **1,044 keys passed**.

Sanitized real-browser evidence:
[initial desktop EN](screenshots/m5/automation-initial-desktop-en.png),
[initial mobile IT](screenshots/m5/automation-initial-mobile-it.png),
[configured desktop EN](screenshots/m5/automation-configured-desktop-en.png).
These fixture screenshots demonstrate the first-policy workflow, not a deployed
Gateway, live Minecraft readiness, or sleep/wake operation. No complete historical
M1–M5 suite or nine-server live scenario was rerun for this focused correction.

Final coordinator checks: `scripts/dev.sh pnpm typecheck` passed (root and WebPanel
source/tests). Focused Biome check passed with two pre-existing non-null assertion
warnings in unchanged Automation form/pagination lines. Indexed governance passed:
488 text files, 95 reviewed PNGs, 414 relative links, four TOML files and 44 ignore
cases. The private exact deployment plan is ignored. HTTPS returned 200 and all
seven existing dev services remained healthy. Independent final source and actual
screenshot review reported no remaining must-fix findings. Real process-signal,
restart and nonce round-trip checks for the proposed permanent services remain
pending their exact activation approval; browser/axe evidence is not a claim of
complete WCAG conformance.

## Approved persistent Gateway service activation — 2026-10-10

Starting reviewed HEAD `d5234ff31b97289e68eaa742984ad8c66c68e570`; clean worktree.
Owner approved the documented permanent development Gateway exception and private
responder. Available resources at preflight: approximately 24 GiB RAM and 67 GiB
disk. Independent host-process UID/executable/parent/start-time/namespace and Docker
daemon identity matched the private baseline; provider node identity and all 400
allocations were read-only verified. No proposed game/probe endpoint or container
name collision; zero routes. Private environment backup retained; no secrets printed.

Executed scoped commands/results:

- `docker compose --env-file .env.dev.local --profile gateway config --quiet`: passed.
- `docker compose --env-file .env.dev.local build api web`: passed using pinned runtime/dependencies; no upgrade. Application image `sha256:d656f8efd95cc9c1b2b00fdcc879782c9dc68be6477b3fb83fb6f8745dc82e36`; web image reused `sha256:556c85ef6c0f8f73e4deca5eb660fd6812516af1c33ede8d07e6e4d0e1f56ea6`.
- Documented `run --rm --no-deps --entrypoint node gateway` namespace preflight: passed. Temporary container removed.
- `docker compose --env-file .env.dev.local up -d --no-deps --wait api worker web`: passed; nginx used its configured graceful stop window. Database/Redis/Vite/mail were not recreated.
- `docker compose --env-file .env.dev.local --profile gateway up -d --no-deps --wait node-probe`: first attempt **failed** (`invalid mount path: 'noexec'`), corrected YAML quoting, then passed. Only intended single `/tmp` tmpfs mount. `scripts/dev.sh pnpm exec vitest run scripts/gateway-deployment.test.ts`: **13 passed**, including the new exact tmpfs regression; no historical full suite rerun.
- Owner-authenticated settings PATCH: **HTTP 200**; only four approved Gateway settings, exact values reverified. No session fabrication or credential extraction.
- `docker compose --env-file .env.dev.local --profile gateway up -d --no-deps --wait gateway`: passed, healthy after the lease drain.
- `docker exec nickhosting-dev-gateway-1 node /app/deploy/gateway-health.mjs`: passed. Actual-container checks returned configuration/snapshot **200**, **zero routes**, full network observer success (**104 containers**, including new dev services), matching namespace, private nonce round trip **true**, anonymous control request **401**.
- Scoped `restart node-probe` and `restart gateway`: clean shutdown/recovery checks. Probe Docker event exit code **0**, subsequent nonce health passed; Gateway correctly not-ready during startup lease drain.

One earlier ad-hoc full-observer command failed because a bare workspace package
alias could not resolve from `/app/[eval]`. The absolute source import succeeded in
automatically removed one-off diagnostics and subsequently in the persistent
Gateway. This was a diagnostic invocation correction, not a relaxed safety check.

Independent read-only data audit: physical hosts, managed nodes, mappings, managed
servers and users match all five pre-change count/hash records. No new provider
test asset, allocation or public game listener. All private backup/identity/plan
records remain ignored. Existing SFTPGo #18 and Docker-socket #22 boundaries remain.
A live forwarding/sleep-wake test remains pending Owner pool selection and exact
public endpoint approval; healthy zero-route service does not establish gameplay.

Final independent read-only audit: all **nine** active dev services healthy after
restart; exactly Gateway and probe added, only API/worker/web replaced. Dedicated
Gateway credentials only; approved host-network confinement and exact probe bind
verified. No game-range listener. Panel/Wings IDs, start times, restart counters
and network attachments unchanged. Docker reports Wings **unhealthy**; the previous
baseline did not record health, so its prior health cannot be asserted. This is an
observed provider-health limitation for the later pilot, not permission to restart
or reconfigure Wings. No corrective production operation was attempted.

HTTPS returned 200 and the real Vite WSS endpoint emitted its `connected` message.
An initial ad-hoc WSS probe used `/` and timed out; retry on the actual configured
`/__nickhosting_hmr` path passed without any application/proxy change. Gateway
restart recovered after its expected not-ready drain, and the independent Unix
health check returned exit 0. No remaining must-fix service-activation findings.

Read-only follow-up clarified the Wings health signal: its Docker healthcheck
uses a different local port from the API port in the mounted configuration and
fails with curl code 7 (connection refused). A GET to the actually configured local
API returned **401**, demonstrating an HTTP listener without using credentials.
This explains the healthcheck mismatch; it does not prove every Wings operation.
No configuration or restart was applied. A local Python YAML parser was unavailable;
only the two relevant plain scalar configuration fields were inspected with a
bounded read-only match instead; no dependency was installed or secret printed.

## Complete allocation inventory and bulk Owner pool selection — 2026-10-10

Starting HEAD `61eeba929b2fb5f6b5e0ce1d9fd6ed910f3d7c82`. Owner authorized
NickHosting-only corrections after creating the provider allocations themselves.
No Panel/Wings configuration, allocation, server, listener or network was changed.
The Owner's NickHosting pool remains unconfigured; no live Owner save was performed.

Read-only inspection of the installed allocation controller found pagination
without explicit ordering. The old 100-row-page adapter returned 2,400 rows but
only 2,200 unique IDs, omitting 200 existing direct allocations while repeating
200 new backend allocations. Adding `sort=id` did not change that result. A single
bounded provider response returned all 2,400 unique allocations (400 existing direct,
2,000 new backend, all new allocations free), with matching total/count metadata.
The final adapter repeated that result with **one GET**, approximately 299 kB,
using the existing protected credentials without printing them. No production
credential extraction, deduplication of an incomplete result or provider mutation.

Allocation discovery now rejects incomplete/duplicate/overlarge inventories rather
than exposing a partial list to either the Owner or Gateway collision checks.
Explicit supported bounds: 10,000 allocations per node and 4 MiB provider response.
Providers clamping the page size fail closed. Owner selection is exact-address/range,
searchable and paginated at 25 rows with bounded scrolling; selected/offscreen direct
endpoint edits survive filtering. Foreign assignments and provider-node changes are
covered. Saving remains an explicit Owner action with existing claim/identity guards.

The first browser bulk-save attempt **failed with HTTP 413**: the general 64 KiB
JSON limit was too small for 2,000 pins. Corrected only `PUT /v1/owner/nodes` to a
bounded 4 MiB allowance; other JSON routes retain 64 KiB. Subsequent real authenticated
handler/isolated PostgreSQL tests passed, including non-Owner and Origin denials.
No failed attempt is counted as a pass.

Focused commands and results (each prefixed with `scripts/dev.sh`):

- `pnpm exec vitest run packages/pterodactyl-adapter/src packages/gateway-safety/src/validator.test.ts`: **311 passed**. Afterwards only an exact-boundary test was added; final `pnpm exec vitest run packages/pterodactyl-adapter/src/allocations.test.ts`: **17 passed**, including actual 10,000-row acceptance and 10,001-row rejection.
- `pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/allocation-pool.integration.test.ts packages/server-management/src/loopback-allocation.integration.test.ts`: **93 passed**.
- `pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts -t '2000-allocation'`: **1 passed, 30 intentionally filtered out**. Then complete affected API files, `apps/api/src/servers.integration.test.ts apps/api/src/app.integration.test.ts`: **39 passed**.
- `pnpm exec vitest run apps/web/src/features/allocation-pool-model.test.ts`: **5 passed**, independently repeated by the UI reviewer.
- Existing approved isolated browser harness via `pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`, with the existing user-local Playwright library path: final `apps/web/tests/allocation-pool.browser.test.ts` **3 passed**; `apps/web/tests/direct-endpoints.browser.test.ts` **2 passed**. Real application/auth/database handlers; external provider inventory is an isolated fixture. A 2,400-row inventory saves 2,002 selected pins (2,000 range plus two original pins), preserves an offscreen endpoint, rejects claimed endpoint changes, and clears selection on provider-node change.
- `pnpm typecheck`, `pnpm i18n:check` (**1,056 EN/IT/pseudolocale keys**), focused `pnpm exec biome check` on changed source/tests, and `git diff --check`: passed.
- `pnpm build`: passed; existing large JavaScript chunk warning remains (about 872 kB minified), outside this focused correction.

Reviewed actual rendered [desktop English](screenshots/m5/allocation-range-desktop-en.png)
and [mobile Italian](screenshots/m5/allocation-range-mobile-it.png) screenshots.
Both have zero automated axe violations, no page overflow or browser errors.
Independent adapter/API and UI/content reviews found **no must-fix findings**.
Optional UI follow-ups: restoring focus to the originating row after closing its
endpoint editor and an explicit empty-filter result message. These do not alter
selection, ownership or save correctness. Automated axe is not full WCAG certification.

HTTPS returned **200** and all nine existing dev services remained healthy. Source
watch/HMR apply these application changes; no Compose recreation, infrastructure
cleanup, test game server or public-port bind. Database tests use isolated schemas
in the already approved test stack and clean those fixtures only. Historical assets
and review data are preserved. No historical full-suite/live-game rerun was needed.
SFTPGo #18 and Docker-socket #22 remain unchanged production-release boundaries.
A working allocation editor is not a claim of an activated public Gateway route or
verified end-to-end gameplay; Owner pool selection and scoped pilot remain next.

Final staged `python3 scripts/check-governance.py`: **passed**, 494 indexed text
files, 97 reviewed PNGs, 417 relative links, four TOML files and 44 ignore cases.
Secret scanning remains heuristic; all staged paths were explicitly inspected.

## Inherited sleep timeouts and Owner user-control policy — 2026-10-10

Starting HEAD `359a94b9b8c47f654168ced31ebaea7871d72b77`. The Owner requested a
configurable idle timeout with game/runtime/server inheritance, then expanded the
same task to global defaults and hidden/editable/shorten-only user controls.
The completed model separates Owner authority from ordinary-user preferences:
global → game → runtime → Owner server policy, then the permitted user preference.
Hidden is the default access mode; -1 disables idle sleep. A finite shorten-only
ceiling rejects increases/-1, clamps older user preferences after Owner tightening,
and is enforced by the API rather than only HTML input constraints.

Timeout-only writes preserve Gateway generation, readiness and wake jobs. User
saves retain accumulated idle proof rather than postponing Owner-enforced sleep.
Disabled intervals do not accrue idle time. Fresh observations and final power
handoff use the effective timeout; an already handed-off effect can still be
confirmed without replay, while a newly disallowed queued stop is rejected and
recovers without releasing a running server's RAM reservation.

Read-only dev preflight confirmed the Owner's 2,000-pin pool, zero managed servers,
zero routes and zero Gateway server states. Exact additive migrations 020 and 021
were applied explicitly to the independent `nickhosting_dev` database using the
existing container, transaction/advisory-lock/checksum procedure. Eight table
count/content-hash comparisons remained unchanged (users, hosts, nodes, mappings,
servers, routes, states and platform settings). No timeout/access values were
saved for the Owner. No provider mutation, public listener, container recreation,
network change or new live test asset. Source watchers use the updated code.

Development iteration record, retained separately from final passes:

- One initial filtered API run failed during fixture Owner bootstrap with HTTP 500.
  The cause was not established; the same test passed on rerun with a temporary
  diagnostic callback, which was removed, and the complete affected API suite later
  passed. No authentication restriction was removed to make it pass.
- A new game-policy fixture failed a foreign-key check because its trusted manifest
  had not been registered in that isolated database; corrected the test fixture.
- Initial browser runs encountered a process using the earlier runtime-label DTO
  and later a locator for a field removed by switching to inheritance. Updated the
  fixture process/locator and reran the affected browser cases; failures are not
  counted as passes.
- The first combined six-file integration run returned **106 passed, 2 failed**:
  existing platform-query exact-shape assertions omitted the new nullable metadata
  and operational-editability flag. Updated exact expected contracts; no assertion
  was weakened to ignore fields. Only the affected query/orchestration files were
  rerun after that and the final disabled-idle-interval fix.

Independent review corrected missing environment propagation on three early
Gateway-state returns, hidden timeout/proposal redaction, repeated-save idle reset,
and hidden/-1 operational-control availability. These are covered by targeted
regressions. The visibility setting hides configuration controls/values, not the
truthful operational state or a Gateway's upcoming sleep deadline. Existing manual
stop/maintenance and automatic-start consent remain independent safety controls.

Final focused evidence (commands prefixed with `scripts/dev.sh`):

- `pnpm exec vitest run packages/core/src/core.test.ts packages/core/src/gateway-config.test.ts`: **54 passed**.
- `pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/gateway-orchestration.integration.test.ts packages/server-management/src/platform-queries.integration.test.ts packages/server-management/src/gateway-delivery.integration.test.ts apps/api/src/gateway.integration.test.ts apps/api/src/platform.integration.test.ts packages/database/src/platform.integration.test.ts`: first combined run **106 passed / 2 exact DTO failures** described above. The four unaffected files stayed passing. Final affected-file rerun, `packages/server-management/src/platform-queries.integration.test.ts packages/server-management/src/gateway-orchestration.integration.test.ts`: **80 passed**, including legacy migration, permission/ceiling, handoff recovery and disabled-interval regression. No historical full matrix repeated.
- The same isolated browser wrapper with `--config vitest.browser.config.ts apps/web/tests/inherited-sleep.browser.test.ts` and existing Playwright user-local library path: **6 passed**. Existing `apps/web/tests/sleep-policy.browser.test.ts`: **1 passed**. A final UI correction reran the four affected cases (**4 passed, 2 intentionally excluded**), preserving earlier evidence for the unchanged remainder.
- `pnpm typecheck`, `pnpm build`, `pnpm i18n:check`: passed, **1,082 EN/IT/pseudolocale keys**. Build retains the pre-existing large-chunk warning (about 884 kB minified JS).
- Focused `pnpm exec biome check` on all 21 changed/new TS/TSX/JSON files: exit 0, no errors; three non-null-assertion style warnings in `automation.tsx`. `git diff --check`: passed.

Browser evidence uses the actual app, protected API handlers, Better Auth and
isolated PostgreSQL schemas; external provider inventory is a fixture. Global
20-minute default, hidden-by-default behavior, independent wake when sleep is
disabled, game/runtime/server precedence, full edits, shorten-only rejection,
Owner ceiling and inherited fallback are exercised. EN/IT desktop/mobile axe checks
reported zero violations and no mobile page overflow. This is not a blanket WCAG
certification or live gameplay proof.

Sanitized screenshots: [global Owner settings](screenshots/m5/inherited-sleep-global-desktop-en.png),
[game/runtime Owner settings](screenshots/m5/inherited-sleep-owner-desktop-en.png),
[server English](screenshots/m5/inherited-sleep-server-desktop-en.png),
[server Italian mobile](screenshots/m5/inherited-sleep-server-mobile-it.png),
[hidden control](screenshots/m5/inherited-sleep-hidden-desktop-en.png), and
[shorten-only control](screenshots/m5/inherited-sleep-limited-desktop-en.png).
Independent technical/accessibility/content review inspected all six and reported
**no remaining must-fix**. Its final UI correction removes the ineffective Save
button/inapplicable instructions from hidden locked policy controls.

HTTPS returned 200; all nine existing dev services remained healthy. No provider
or production service was changed, no game port was opened, and no test server
was created. Isolated test schemas were cleaned by their existing harness; private
review state was preserved. SFTPGo #18 remains a release gate; the accepted
Docker-socket risk tracked by #22 is unchanged.
Actual Gateway forwarding/sleep-wake on the new pool remains a separate scoped
pilot requiring a real supported managed server and explicit route.

Final read-only dev check resolved global timeout **-1**, access **hidden**, zero
stored game policies and zero managed servers/routes/server policies. Both migration
records are present. These are untouched defaults for the Owner to configure.
Staged `python3 scripts/check-governance.py`: **passed**, 499 indexed text files,
103 reviewed PNGs, 424 relative links, four TOML files and 44 ignore cases. Secret
scanning remains heuristic; all staged paths and screenshots were inspected.

## M5 follow-up — Automatic Gateway route provisioning

Baseline `fc2787f0771c75d243a08886a1818a417ba5fa21`; PR #21 remains open and
unmerged. The Owner requested automatic Gateway connection setup when creating a
supported server and explicitly retained responsibility for creating the real server.

New eligible Gateway-mode creations atomically reserve disabled routes with their
backend claims and durable provisioning job. The single Owner-configured bind
address and same-number port/transport identities are frozen in the job. After
verified provider identity, egg installation and game configuration, the worker
activates routes and initializes the trusted protocol policy with inherited idle
timing. It does not grant wake consent. Direct/legacy servers are not imported or
backfilled. Ambiguous/missing configuration and collisions fail closed; recovery
cannot retarget or re-enable an Owner-disabled route. Public connection DTOs now
report a delivered route as `configured`, not `available`: snapshot issuance is
not evidence that the Gateway accepted/bound it. Existing live safety checks remain.

Validation (isolated PostgreSQL schemas; mocked provider effects, no real games):

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/gateway-provision.integration.test.ts`
  — **13 passed**. Atomic TCP/UDP multiport reservation, idempotency, missing/
  ambiguous config, collisions, immutable identities, direct exclusion, lost start
  reply/recovery, initial-start readiness, no wake grant and manual-stop races.
- Same harness, `packages/server-management/src/gateway-minecraft.integration.test.ts`
  — **7 passed**, including automatic registration through the actual compiled
  Vanilla 26.1 binding with installed-profile fixtures. This is not a new live
  Minecraft compatibility test.
- Same harness, `packages/server-management/src/gateway-registry.integration.test.ts`
  — **24 passed**, retaining interactive Owner and endpoint namespace restrictions.
- Same harness with `packages/server-management/src/{lifecycle,registry,allocation-pool,gateway-orchestration,gateway-deletion,gateway-delivery}.integration.test.ts`
  plus `apps/api/src/{gateway,minecraft}.integration.test.ts` — **251 passed across
  eight files**. The final added initial-start handoff fence was validated by the
  focused 13-test suite above; the broad run was not repeated for that narrow fix.
- Same harness, `packages/server-management/src/platform-queries.integration.test.ts`
  — **22 passed**, including honest configured/expired endpoint reporting.
- `scripts/dev.sh pnpm typecheck` — passed (root, WebPanel and browser-test types).
  `scripts/dev.sh pnpm exec tsc --noEmit` passed again after the final backend edits.
- Focused `scripts/dev.sh pnpm exec biome check` on all nine changed/new TypeScript
  files — passed, no warnings. `git diff --cached --check` — passed.
  `python3 scripts/check-governance.py` — passed: 501 indexed text files, 103 existing
  review PNGs, 425 relative links, 4 TOML files and 44 ignore cases. The credential
  scan is heuristic; staged content was also inspected. No layout or translation
  changes required another browser screenshot pass; no historical full milestone
  suite was repeated.

Development failures were retained in the work record: initial new fixtures attempted
spying on a frozen registry, reused a provider ID, and advanced the fixture clock
beyond a snapshot lease. These fixtures were corrected without weakening production
fences. A missing import in the final handoff check was caught by TypeScript and
fixed. Biome caught comment indentation in the connection DTO; formatting corrected it.
All final affected checks above passed.

Independent review found and resolved two related races: an explicit manual policy
change before initial-start preparation, and another between preparation and the
final provider power handoff. Persisted policy generations and final intent checks
now protect both, with a regression that confirms zero power calls on revocation.
Activated retries validate immutable route identity without replaying activation or
letting later configuration drift corrupt confirmation of an already-issued start.
No remaining must-fix was reported.

Read-only dev checks found all nine existing services healthy and zero managed
servers, routes and protocol-policy rows. No Owner settings, provider resources,
containers, networks, DNS or public listeners were created/modified. No new migration
or container rebuild/restart is required; existing API/worker source watching applies
the change. Isolated test schemas were cleaned by their harness. Real end-to-end
forwarding/sleep/wake remains to be exercised on the server the Owner will create.
Issue #18 and the existing production-release/infrastructure boundaries are unchanged.
Rollback is a reviewed code revert with retained data; automatic routes already
reserved/activated must be inspected explicitly, never broadly deleted or retargeted.

## M5 follow-up — First Minecraft creation resource observation

An Owner creation request failed with `resources_unavailable` before creating any
managed server. Read-only investigation found no `host_observations` row, despite
matching enabled host/observer identities. The Minecraft creation endpoint omitted
`refreshObservations`, unlike the generic server endpoint. The worker intentionally
skips reconciliation when no managed server exists, so first creation could not rely
on a background sample. This was absent admission evidence, not measured RAM exhaustion.

The Minecraft endpoint now refreshes the existing observer immediately after content
preparation and before transactional creation/admission. No thresholds, quotas, host
settings, worker scheduling or provider policy changed. A missing valid sample still
fails closed. The dev sampler was exercised read-only and returned valid memory/CPU/
disk values; no host observation or server was manually seeded.

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/minecraft.integration.test.ts`
  — **19 passed**, including missing/stale first-creation observations and refusal
  when refreshing supplies no valid sample. Provider effects remain isolated fixtures.
- `scripts/dev.sh pnpm exec tsc --noEmit` — passed.
- Focused Biome on both changed API files, indexed governance and diff hygiene — passed.
- Independent read-only reviewer found no must-fix; no historical full-suite rerun.

No real server was created, started or changed. No quota/configuration or infrastructure
mutation was performed. Existing dev source watching applies this API correction.
The Owner can retry creation; actual installation/start still require normal admission.

## M5 follow-up — Recover a missed initial installation event

The Owner's first provision remained in Activity after Pterodactyl had completed
its installer. Initial investigation found an unconfigured Wings WebSocket origin;
after the Owner corrected it, authenticated status/stats worked but the transient
installation event had already passed. Successful Panel status alone was correctly
insufficient. No completion event or successful historical script execution was
invented.

The trusted Vanilla module now offers read-only verification of initial installation
outputs, reusing artifact size/hash, immutable launch binding and observed runtime
image checks. The lifecycle requires its original provisioning effect, exact provider
identity, fresh successful provider state, an offline game process and host-bound
confirmation that installer/game containers are not running. Authorization and
observations are checked again after streaming. An atomic
`required_outputs_verified` receipt releases only that operation's installer
reservation. Existing game configuration and automatic route activation then resume.
Reinstall/wipe remain on the strict event-confirmation path; valid old files do not
establish a new installation outcome. The generic adapter was not relaxed.

The download-origin allowlist was also empty. A read-only signed-URL origin check
identified the configured Wings host; the Owner added its HTTPS origin through
protected settings. No token or signed URL was printed or published. Existing source
watching applied the fix, and the worker resumed the original job without a manual
database patch, retry command, recreation, reinstall, wipe or power request.

Read-only final checks on 2026-10-10 confirmed: original job `succeeded`, error and
wait reason cleared, phase `complete`, no active operation, local/provider installation
complete, provider power `offline`, and zero remaining installer reservations for
that server. The verified server JAR was 60,417,588 bytes. The pinned TCP Gateway
route was enabled; this is configuration evidence, not a new player-connect or
sleep/wake end-to-end test. The original request had automatic start disabled.

The worker performed the already-requested game configuration through its normal
managed-server workflow. Diagnostic accesses were read-only and limited to that
Owner-created managed server. No new test server, infrastructure change, provider
configuration change or unrelated server mutation was performed. Issue #18 remains
unchanged. Rollback is a reviewed code revert preserving receipts, server files and
Owner settings; do not delete or reinstall the completed server to roll back code.

Validation (isolated provider fixtures; no new real game server):

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/lifecycle.integration.test.ts packages/server-management/src/minecraft-content.integration.test.ts`
  — **132 passed, one new fixture assertion failed**. That assertion incorrectly
  expected a valid first observed image digest to fail before any digest was pinned;
  the fixture now supplies an invalid digest. Product image policy was not weakened.
- The same command with
  `-t 'initial|first-install|reinstall completion|wipe completion'` after correction
  — **21 passed, 112 skipped**, both files passed. This is a targeted final rerun,
  not a second full-suite result. Coverage includes missed-event recovery, repeat
  delivery, interruption after the durable receipt, invalid artifact/image/launch
  evidence, identity and authorization changes, running processes, provider-state
  changes, creation-time mismatch, and exclusion of reinstall/wipe.
- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/installation.test.ts`
  — **8 passed**; the generic transient-event confirmation contract is preserved.
- `scripts/dev.sh pnpm exec tsc --noEmit` and focused Biome on the seven changed
  TypeScript files — passed. A missing `installed` field in a new test fixture was
  caught by the earlier typecheck and corrected before the passing final check.
- Independent read-only review found no remaining must-fix. No browser layout,
  translations or API payloads changed, so no new screenshot run was needed.
- `python3 scripts/check-governance.py` and `git diff --cached --check` — passed:
  501 indexed text files, 103 existing review PNGs, 425 relative links, 4 TOML
  files and 44 ignore cases. Staged content was also inspected manually.

## M5 follow-up — Console continuity and Gateway transition investigation

Read-only investigation of the Owner's existing managed Vanilla server separated
the reported UI and transition failures. No extra start, stop, reinstall, file
operation or synthetic player join was sent. Existing Owner-triggered operations
and automatic policy continued independently.

- Console omitted Wings daemon messages and localized status transitions; the API
  did not request provider log history. The adapter now mediates daemon output with
  existing secret redaction; the WebPanel renders status messages and requests the
  provider's available recent log tail on an empty console.
- Component remounts erased console output. A bounded in-memory buffer now survives
  SPA navigation, isolated by actor/subject/support identity and server, cleared at
  authentication boundaries. It is not durable logging: messages emitted while
  disconnected can be missing, especially transient daemon output. The UI says so.
- SSE error envelopes were ignored by the frontend, and exceptions did not reconnect.
  Typed errors now trigger bounded transient retries; permission loss clears output
  and ends retries. Telemetry likewise retries transient failures and distinguishes
  unavailable measurements from an unavailable game integration. The precise upstream
  cause of the Owner's earlier one-off resource error was not retained in old logs;
  no claim of a proven rate-limit or provider outage is made.
- The original wake timeline recorded request-to-power delays of 35.761 seconds and
  5.834 seconds. One real Minecraft `Done` at 21:42:21 local preceded stored readiness
  at 21:43:11 by about 50 seconds. The process launch-file cache was recreated on every
  API runtime, causing repeated full JAR downloads/hashes during Gateway observation.
  Successful proofs now survive runtime recreation with fresh identity/image checks,
  metadata/process fences and bounded singleflight; failed proofs are never cached.
- A stop was physically confirmed at 21:44:45.892, but the job finished at 21:45:13.318.
  It unnecessarily waited for the 20-second provider resource cache plus polling.
  Durable stop proof followed by fresh exact-container non-running evidence now
  completes atomically without that delay. Missing proof still fails closed.
- The start path still retains its existing conservative resource-cache settlement,
  and each new process still requires initial artifact verification and real game
  readiness. Neither these changes nor a console `Done` line imply instantaneous
  start, automatic reconnect or permission to bypass admission/readiness.
- Gateway metrics showed 163 observation errors, 167 snapshot errors and zero lease
  expirations during investigation. The old logs do not identify every failure's
  cause. An independent validation in the actual Gateway namespace later reproduced
  a dormant-route proof failure while Core metadata requests all returned HTTP 200.
  The saved proof predated a Wings container recreation: its digest included Docker's
  ephemeral container ID. That explains a concrete listener-loss path; it does not
  establish that every reported disconnect has the same cause.

Browser evidence uses the real React/API fixture harness with isolated provider
responses, not the live game server. Reviewed screenshots:
[desktop English](screenshots/m5/console-retained-desktop-en.png) and
[mobile Italian](screenshots/m5/console-retained-mobile-it.png).

The new reachability proof v2 removes only the ephemeral Docker ID and adds the
provider node UUID. Durable identity, exact bindings, daemon/namespace/network,
fresh container checks and collisions remain enforced. A running container alone
cannot enable forwarding: a real game protocol probe is still required. Existing
v1 proofs are not relabelled; after container replacement, the Owner's next normal
start and successful protocol probe must establish v2. Missing/ambiguous containers
still fail closed during replacement. The Gateway process has not been restarted
in this investigation, so this change has not yet been verified in a live cycle.

Focused validation (approved existing isolated services; no full historical suite):

- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/console.test.ts`
  — **6 passed**.
- `scripts/dev.sh pnpm exec vitest run packages/gateway-safety/src/validator.test.ts`
  — **70 passed**, including durable identity across container replacement, legacy
  proof handling, readiness, namespace/network/binding drift and ambiguous identity.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts`
  — **31 passed**; a later targeted authorization-loss SSE regression also passed.
- The same integration runner with
  `packages/server-management/src/minecraft-queued.integration.test.ts` — **36 passed**.
  After stable evidence ordering was added to the cache fingerprint, only its three
  affected cases were rerun: **3 passed, 33 skipped**. An earlier expected callback
  count was corrected to include the additional process fence; no fence was removed.
- The lifecycle file initially reported **98 passed, 2 failed**: a previous test
  expected the removed stop delay, and a new retry fixture advanced less than the
  backoff plus jitter. Fixture expectations/timing were corrected. Final affected
  run with `-t 'stop|sleep'` — **16 passed, 84 skipped**. An intermediate rerun also
  exposed the extra fresh-stop observation count; the assertion now expects it.
- Browser runner:
  `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/services.browser.test.ts`
  with focused name filters, not the whole file: **five cases passed** across the
  final runs. They cover console/navigation history and real units, reconnect and
  permission denial, telemetry retry, clearing buffers across sign-out/sign-in,
  and Italian mobile/pseudolocalized service views. Initial fixture-only failures
  concerned a required error message key, redirect timing and isolated auth rate
  limits; these were corrected without changing production authentication policy.
- Root and WebPanel TypeScript checks, i18n catalog check and focused Biome passed.
  Four pre-existing non-null assertion warnings remain in the console feature and
  browser test file.
- Independent source/security and desktop/mobile screenshot review found no must-fix
  in the console, attestation cache, stop fast path or v2 proof change.

Activation boundary: API/worker use the existing development source watcher. Gateway
requires a separately approved restart of only `nickhosting-dev-gateway-1`; its
startup intentionally drains leases for 31 seconds. No listener/network/provider
configuration change is proposed. A restart interrupts Gateway connections. Code
rollback must preserve data and use compatible proof validation: old binaries reject
v2, and a fresh backend proof may be needed. No new assets were created or cleaned;
Pterodactyl/Wings configuration, unrelated servers and issue #18 remain untouched.

### External Pterodactyl stop discovered during this investigation

The Owner confirmed that the later pending wake was deliberately force-stopped in
Pterodactyl. Read-only authenticated provider history independently returned an
interactive `server:power.stop` and `server:power.kill` at 21:53:12 local, after the
API start at 21:53:05. The installed Panel controller records these events after
its daemon request succeeds; this is acceptance of the request, not by itself proof
that the process stopped. The same semantics are visible in the upstream
[Panel power controller](https://github.com/pterodactyl/panel/blob/1.0-develop/app/Http/Controllers/Api/Client/Servers/PowerController.php).

An exited Docker process alone cannot distinguish a deliberate stop from Wings'
[crash recovery](https://github.com/pterodactyl/wings/blob/v1.11.13/server/crash.go).
The adapter now exposes a bounded, sanitized latest power history (100 records,
first page only, checked descending timestamps, preserved ties). Unknown events,
missing API/interactive origin, invalid ordering and malformed pagination fail
closed. It strips actor details, IP addresses and arbitrary provider properties.
The exact live read-only adapter call returned the nine power records for this
managed server, including the two interactive stop receipts; no mutation was sent.
Six targeted adapter tests passed (41 unrelated cases skipped). Review then added
a denial for a full 100-row latest-timestamp group that could hide a conflicting
start on page two. Its first fixture accidentally supplied one row; after correcting
the fixture to 100 rows, the added case passed (47 unrelated cases skipped).

Independent review also caught a regression in the immediate-stop optimization:
reconciliation could read cached `running` and recreate a released reservation.
A recent completed stop now requires fresh host-bound non-running proof before
suppressing that stale sample; a genuinely running replacement defeats the guard.
Seven focused stop/reconciliation tests passed (95 unrelated cases skipped), and
independent review cleared this finding.

The external-stop correction now uses two matching exact exited-process observations
and the latest interactive stop/kill receipt. It ends a correlated pending
start/restart/first-start as failed, records the external stop and suppresses wake;
no successful start is invented. The same corroboration handles an external stop
of an already-online server. Cached running samples cannot resurrect reservations
on the following reconciliation. API-origin actions, unavailable/hidden activity,
crashes and ambiguous/preboot states remain uncertain rather than being guessed.
This does not promise synchronization of every possible external action; external
starts retain existing accounting and do not silently revoke manual-stop intent.

Actual read-only verification at 22:09:29 local found the Owner's original wake
terminalized by the normal source-watching worker at 22:07:38: job `failed`, phase
`failed`, external-stop receipt present, active operation cleared, server offline
and manually stopped, and **zero compute reservations**. No direct database patch
or power request was used. Its prior `waitReason` remains in the historical plan;
the final code clears this field for future terminalizations. No historical record
was rewritten just to change that cosmetic field.

Additional focused checks:

- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/container-observer.test.ts`
  — **111 passed**.
- The isolated integration runner above, with lifecycle and runtime integration
  files and `-t 'interactive external stop|correlated terminal stop|already online reservation|reconciliation sample|expired stop receipt|observed stop immediately|fresh confirmation|confirmed stop before cache'`
  — **21 passed, 125 skipped**.
- After adding initial-provision-start and unavailable-activity cases, lifecycle
  `-t 'reconciles an interactive external stop|already online reservation'`
  — **4 passed, 105 skipped**. After clearing the terminal wait reason, only
  `-t 'reconciles an interactive external stop'` was rerun: **3 passed, 106 skipped**.
- Combined typecheck passed root source checking, then caught the new adapter method
  missing from the WebPanel's isolated provider fixture. Added an empty power-history
  fixture that still checks server identity. The WebPanel source/test typecheck
  rerun passed; `scripts/dev.sh pnpm i18n:check` passed for 1,089 EN/IT/pseudolocale
  keys. No authentication or provider boundary was relaxed.

Remaining live verification: the running Gateway still predates these changes.
After an approved scoped restart and the Owner's next explicit admitted start,
a new real game readiness proof is needed for v2. The next real-client cycle must
measure wake-to-power, readiness-to-forwarding and stop-to-sleeping timing, including
the intermittent disconnect report. Those timings are not claimed as already fixed
or remeasured by fixture tests.

Final independent review found no unresolved must-fix after the cache-resurrection
and truncated-activity fixes. Focused Biome passed on all 21 changed TS/TSX/JSON
files with the four existing warnings noted above. `git diff --cached --check` and
`python3 scripts/check-governance.py` passed: 501 indexed text files, 105 review PNGs,
427 relative links, four TOML files and 44 ignore cases. No historical full-suite or
live Minecraft scenario was rerun; earlier evidence is preserved.


## M5 follow-up — Repeated console status and intermittent resource errors

The Owner observed repeated offline console messages and intermittent console/resource
errors after the transition investigation. Repeated typed status snapshots were
appended unconditionally, including after reconnect/navigation. The UI now retains
the last observed status separately from its bounded log lines, scoped to the same
actor/subject/support/server identity. It suppresses identical status snapshots,
including after old lines are evicted; real state transitions and normal log lines
are preserved. It does not hide provider failures or authorization denial.

An offline Wings console sent only its initial status and stats during a 30-second
read-only adapter observation. API HTTP sockets have a 30-second idle timeout. Console
SSE now sends a bounded heartbeat every ten seconds, with no extra provider request;
authorization checks and stream cleanup remain. A real Node/Hono test with a 12-second
idle timeout survived two heartbeat cycles over 20 seconds and then terminated after
actual database permission revocation. This proves the quiet-stream path without
changing Pterodactyl, proxy timeouts or global socket policies.

The reported request reference correlated to an `integration_unavailable` API failure
at 22:18:24 local, without an API restart at that instant. Its old log lacks the
underlying provider reason: it cannot honestly be attributed to HTTP 429. Later API
watch reloads during this correction can interrupt in-flight development requests.
New safe diagnostics record the registered route template and typed provider scope,
reason and HTTP status; they exclude dynamic IDs, query strings, credentials, actor
metadata and upstream bodies. A targeted test proves that exclusion.

Read-only provider observations returned Application HTTP 200 with 32/240 remaining
and Client HTTP 200 with 704/720 remaining; a later Application sample had 134/240.
These are quota samples, not measurements of aggregate traffic or proof of throttling.
Source inspection nevertheless found duplicate Gateway requests: the allocation
endpoint re-fetched nodes, and a missing non-online listener performed a separate
backend safety inspection before listener validation repeated it. Both duplicates
are removed, retaining fresh node UUID/identity/inventory/collision checks, live
protocol proof and the final fresh check before bind. For one configured node and
one missing listener the nominal refresh/observation pair falls from thirteen to
seven Application requests, excluding elapsed latency and other callers. There is
no new TTL cache and no claim that every historical failure shared this cause.

Validation was deliberately focused:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/app.integration.test.ts -t 'safe provider failure'`
  — **1 passed, 8 skipped**.
- The same integration runner with `apps/api/src/servers.integration.test.ts`
  and `-t 'idle console HTTP|sensitive upstream errors'` — **2 passed, 30 skipped**,
  including real HTTP silence/heartbeat and authorization-revocation behavior.
- `scripts/dev.sh pnpm exec vitest run packages/gateway-safety/src/validator.test.ts apps/game-gateway/src/data-plane.test.ts`
  — **150 passed**. An added bootstrap expiry regression was then checked with the
  focused bootstrap selection: **6 passed, 70 skipped**. Freshness expiry still denies.
- The isolated integration runner with `apps/api/src/gateway.integration.test.ts`
  — **17 passed**, including configured-node authorization and no duplicate node lookup.
- Real-browser service tests selected the new repeated-status case and existing
  reconnect/authorization-denial case; both passed across focused runs. Initial
  fixtures assumed one StrictMode connection and exceeded the protected SSE queue
  with a synchronous 305-event burst; the fixture now tracks active connections and
  drains in bounded batches. Production queue limits were not changed.

The prior Owner-approved Gateway restart loaded the earlier transition fix at
`8f94c3bc9a88f7c3e947ce8ab31be8eed3c0f67d`. These later polling changes require another
scoped Gateway restart; source mounts alone do not reload that process. API/WebPanel
use their existing development watch/HMR. No game-server command, new infrastructure,
provider configuration change or new test asset was created. Legacy-proof activation
still requires the Owner's explicit start and real readiness, as documented above.


Final dedup browser run: **1 passed, 12 skipped** with a captured and reviewed
[actual browser screenshot](screenshots/m5/console-status-deduplicated-en.png).
Its fixture was also corrected to track active rather than aborted StrictMode
relays before emitting test output. The screenshot shows one stopped message
across repeated snapshots/reconnect/navigation; real transitions remain covered.
`scripts/dev.sh pnpm typecheck` passed for root and WebPanel source/tests. Focused
Biome passed with the same four pre-existing non-null assertion warnings. Independent
source review found no must-fix; actual forwarding/latency after the new Gateway
polling change remains unverified until its separately approved restart.

Final staged governance and whitespace checks passed: 501 indexed text files,
106 review PNGs, 428 relative links, four TOML files and 44 ignore cases.
Independent screenshot/content review found no new visible defect or unresolved
must-fix. No full historical suite was repeated for this follow-up.

## 2026-10-10 — start confirmation and permanent status during idle stop

Owner-observed follow-up: manual start took about five seconds before startup, one
ready transition reportedly lagged by 46 seconds, and sleep briefly produced a
Minecraft connection failure. Read-only correlation found queued-to-power-intent
intervals of 5.955 s and 6.494 s. In the second cycle Minecraft logged `Done` at
20:33:09.520 UTC, the lifecycle job completed at 20:33:17.958 and Core recorded
Gateway readiness at 20:33:18.674. The first cycle's original container logs were
not retained by Wings recreation; its reported 46-second post-`Done` interval is
not independently reconstructed. Stop job creation-to-completion was 5.148 s; this is
not a measurement of timeout-expiry-to-idle-detection latency.

Installed Panel 1.11.11 caches the resource endpoint, including power state, for
20 seconds ([upstream controller](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Http/Controllers/Api/Client/Servers/ResourceUtilizationController.php)).
Wings 1.11.13 syncs configuration, manages the image/container and detects startup
from the egg's configured output pattern ([power](https://github.com/pterodactyl/wings/blob/v1.11.13/server/power.go),
[startup detection](https://github.com/pterodactyl/wings/blob/v1.11.13/server/listeners.go)).
It does not verify NickHosting registry ownership or hash the JAR against our pinned
runtime artifact. Those checks cannot truthfully be described as delegated to Wings.
Installation remains Wings-owned; no installer is duplicated by this correction.

A bounded read-only replay of the actual configuration/file verification helpers
used the existing dev encrypted configuration and a PostgreSQL session enforcing
`default_transaction_read_only=on`. It did not enqueue operations, reserve resources
or send power commands. Safe output contained stage durations and method counts only:

| Stage | Before deduplication | After deduplication |
| --- | --- | --- |
| Image and launch configuration | 1,160 ms; 2 server GETs, 1 egg GET | 1,077 ms; 1 server GET, 1 egg GET |
| Full launch-file attestation | 5,902 ms; 7 server GETs, 4 egg GETs | 2,562 ms; 3 server GETs, 3 egg GETs |

These are two live samples, not a benchmark or a promised start latency. The file
was 60,417,588 bytes. Authorization also repeats at transfer boundaries; the slower
sample crossed another boundary. The deterministic change removes the adjacent
second server GET within each authorization and shares one snapshot for image and
launch validation. There is no new provider TTL cache. JAR integrity remains an
extra NickHosting runtime-consistency policy, checked before start and once per
observed process epoch, because out-of-band provider/SFTP edits are possible.

Fresh host-bound process evidence now confirms start/restart/initial-start without
waiting for the cached resource response's 21-second safety window. Epochs must be
strictly after the durable power intent, not future, and different for restart.
A configured observer failure cannot fall back to cached `running`; reservations
remain held. Confirmation polling stays at 2–2.5 seconds instead of growing to ten.
Actual game protocol readiness is still required before forwarding. Startup estimates
are informational only, using the most recent ten same-profile samples, requiring
at least five; they never delay an operation.

The idle quiescence fence previously destroyed passive status sockets alongside
logins. It now retains bounded protocol status/ping and login-disconnect responses,
while still preventing wake and forwarding until the fence reconciles. Responder
sockets do not count as gameplay activity. Separately, failed backend readiness
can retain a status-only public listener with matching durable binding proof and
fresh node/topology checks. Missing ownership, collisions, stale leases and unknown
bindings still close it. Fresh backend readiness is required to resume forwarding.
An independent reviewer caught an intermediate regression where negative backend
readiness also blocked sleeping-route wake; this was corrected and covered by
Minecraft status/login and concurrent-wake tests before delivery.

Idle timing remains observation-based: the timeout starts with confirmed zero
players, not the unobserved instant a client disconnects. A qualifying fresh probe
queues stop immediately; protocol/authorization calls, dispatch and graceful shutdown
add elapsed time. Missing player counts never mean zero. This pass does not claim
instant shutdown or a new live measured latency after the changes.

Focused validation:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/lifecycle.integration.test.ts` — **121 passed**, including twelve new confirmation/timing cases.
- `scripts/dev.sh pnpm exec vitest run packages/gateway-safety/src/validator.test.ts` — **79 passed**.
- `scripts/dev.sh pnpm exec vitest run apps/game-gateway/src/data-plane.test.ts` — **77 passed**, including status during quiescence, false-readiness wake, forwarding downgrade/recovery and held-validation safety.
- The isolated integration runner with `packages/server-management/src/minecraft-queued.integration.test.ts` — **36 passed, one new test failed** because its spy included fixture setup calls. Clearing only the fixture's prior mock history corrected the test; targeted `-t 'shares fresh provider snapshots'` — **1 passed, 36 skipped**. Production behavior was not changed to satisfy that assertion.
- Root and WebPanel typecheck passed after the Gateway/API changes. No historical full-suite rerun or new live game scenario was performed.

No game server was created, started, stopped, mutated or removed by this pass. No
provider configuration, existing infrastructure, DNS or Pterodactyl/Wings service
was changed. The approved isolated test stack was reused without restarting it.
API/worker source watchers load backend edits; Gateway requires a separately
approved scoped restart. Until activation and Owner testing, end-to-end corrected
latency remains unverified. SFTPGo issue #18 remains unchanged.

During live source/watch updates the Owner reported the console route showing only
a request-failed message and an unexpected “Exit support” action. The Owner clarified
this was a regular Owner session, **not** an assisted session. No support session is
inferred. A watch reload may explain the interrupted request but does not establish
the cause of the incorrect action. Per Owner direction this is recorded without an
unrelated UI fix or a claim that the symptom is harmless/resolved.

Final integration follow-up: the Gateway orchestration file ran **55 passed, three
failed**. These were stale assertions expecting a wait after an already corroborated
stop; source review of committed HEAD confirmed the earlier stop fast path already
completed in that delivery. Assertions now require immediate success, replay as
`duplicate`, the original single-stop/reservation safeguards, and the latest-ten
estimate across eleven cycles. Targeted rerun with
`-t 'replaying an old manual stop|idle sleep uses|recent same-profile'` — **3 passed,
55 skipped**. No unrelated lifecycle behavior was altered for these tests.
Final root/WebPanel typecheck and changed-source Biome checks passed. Independent
review found no remaining must-fix. The Owner-reported UI fallback remains an
uninvestigated observation, not a resolved issue or a claimed watcher-only defect.

Owner-approved activation: `docker restart --time 20 nickhosting-dev-gateway-1`
restarted only the label-verified `nickhosting-dev` / `gateway` container at
20:53:52.636 UTC. Docker warned that `--time` is deprecated in favor of `--timeout`;
the approved command succeeded. The existing 31-second startup lease-drain safety
window initially returned readiness503, then readiness200 with `ready:true`,
`controlAvailable:true`, one route, zero active connections/sessions, zero snapshot
errors and zero wake requests. Four failed backend observations were counted while
the database reported sleeping; this is not a claim of a ready Minecraft backend.
Container health is healthy, and source hashes for data plane, safety validator and
SDK match committed source. No game command was sent; live corrected start/sleep
latencies await the Owner's next interactive test.

### 2026-10-10 — Remaining transition latency and ordinary-start artifact policy

The Owner's next interactive cycle still exposed delayed readiness and idle handling.
Read-only correlation showed the second wake job took about 4.6 seconds from job
creation to recorded external-effect intent (not proof that Redis dispatch itself
consumed that time). Minecraft reported Done at 21:03:46.739 UTC; the first positive
Gateway observation was timestamped 21:04:03.037. That timestamp denotes the start
of its observation pass, not completion of the Core report. A later disconnect at
21:04:13.325 was followed by the idle-stop job at 21:05:18.852 and stop handoff at
21:05:21.508. These are pre-fix measurements, not post-fix performance claims.

An isolated regression reproduced the key stale-state path: ordinary reconciliation
could overwrite a freshly confirmed running process with Panel's cached `offline`
or `starting` state, preventing Core from accepting readiness. Reconciliation now
corroborates the exact successful power receipt against fresh host-bound process
identity and a retained reservation. Changed/missing processes, failed jobs, later
stops, manual suppression and unverified provenance cannot inherit that receipt.

The Owner explicitly approved removing ordinary JAR downloads/hash checks. Previous
checks streamed the installed artifact from Wings; the expected hash already came
from persisted metadata, **not a Mojang lookup at each start**. Ordinary start/stop
and process observations now perform no artifact download or file listing. Obsolete
process artifact-cache/invalidation hooks were removed. Installation/content/restore
verification remains. Out-of-band JAR edits are no longer detected by a startup hash.
Provider ownership, immutable launch configuration, actual image, installed-state,
process replacement and atomic resource checks remain mandatory. One fresh provider
snapshot is reused within observation; independent image and launch-metadata reads
run concurrently. Final effect authorization still rechecks current grants.

Minecraft now supplies one coherent status/nonce sample for readiness and idle,
instead of separate sequential exchanges. Unknown player counts remain unknown.
Successful polling subtracts work duration from the period, yields at least 100 ms
and never overlaps; failures retain their cooldown. Accepted positive waking
observations trigger a fresh fully checked snapshot immediately. Quiescence returns
“Server stopping” in EN/IT while denying wake/forwarding, without inventing an ETA.
Aggregate diagnostics expose probe, report, total observation and snapshot timings.
Polling, provider calls and real protocol readiness still take time; this does not
claim millisecond detection or a measured post-fix end-to-end latency.

Focused checks (existing isolated M2 test services, no infrastructure changes):

- `scripts/dev.sh pnpm test:m3 packages/server-management/src/lifecycle.integration.test.ts` — **139 passed**, including 18 reconciliation regressions.
- `scripts/dev.sh pnpm exec vitest run apps/game-gateway/src/data-plane.test.ts packages/gateway-safety/src/validator.test.ts games/minecraft/src/protocol.test.ts games/minecraft/src/gateway-module.test.ts apps/game-gateway/src/main.test.ts` — agent's five-file run: **200 passed**. A new immediate-refresh test initially needed its fixture lease expectations corrected; targeted cadence/deployed-module follow-up: **4 passed, 103 filtered**. Follow-up command: `scripts/dev.sh pnpm exec vitest run apps/game-gateway/src/data-plane.test.ts games/minecraft/src/protocol.test.ts -t 'elapsed Gateway polling cadence|deployed trusted module'`.
- `scripts/dev.sh pnpm test:m3 packages/server-management/src/minecraft-queued.integration.test.ts` — **33 passed** at that revision; added stop/absent-container no-artifact regression **1 passed** targeted. Final added unconfirmed-installation regression first failed, exposing an installed-state guard lost with the old hash hook; the explicit guard was restored. Targeted `--testNamePattern 'refuses playable process evidence'` — **1 passed, 34 filtered**. These are incremental results, not a claimed full 35-case final rerun.
- `scripts/dev.sh pnpm test:m3 packages/server-management/src/game-modules.integration.test.ts packages/server-management/src/minecraft-content.integration.test.ts --testNamePattern 'first-party|module|attests initial|declaration-backed Vanilla installation|partial-install|restor'` — **8 passed, 35 filtered**; installation artifact verification and partial-install fences retained.
- `scripts/dev.sh pnpm typecheck` — root and WebPanel passed.
- Changed-source `biome check` — **18 files passed**. No historical full-suite rerun.

Independent review found one must-fix: running-process evidence must still require
confirmed installation after removing the hash hook. The guard and regression above
resolve it; follow-up review found no remaining must-fix. Historical failures above
are preserved. SFTPGo #18 and the previously reported console fallback remain unchanged.

No game server was created, powered, modified or deleted during this pass. No live
Pterodactyl/Wings configuration, credentials, networks or persistent data were changed.
API/worker use their existing source watchers. Gateway activation requires a new
scoped restart approval; the earlier restart approval was already consumed. New
live timing measurements require the Owner's interactive cycle after activation.

Final staged governance: `python3 scripts/check-governance.py` passed (501 indexed
text files, 106 reviewed PNGs, 430 relative links, four TOML files, 44 ignore cases);
`git diff --cached --check` passed. No private infrastructure notes or credentials
were staged. Rollback is a new revert commit of this patch, followed by a separately
approved Gateway restart; there is no schema/data migration to reverse.

### 2026-10-10 — Prompt durable retries after temporary delivery deferral

The Owner's second post-activation wake completed its remote start but logged a
`deferred` confirmation at 21:37:19.766 UTC, followed by success at 21:37:51.428.
The existing dispatcher reserved its next recovery publication for 30 seconds
later; `deferred` did not re-arm it. The historical log does not establish whether
the particular deferral came from lock contention or another eligibility check.

A temporary deferral now re-arms the existing durable outbox entry after 500 ms,
respecting `next_attempt_at` and an earlier valid dispatch deadline. A transaction
locks that outbox row by job ID before checking the publication generation. This
also covers Redis delivering before the dispatcher's PostgreSQL commit. Stale
generations, removed outbox rows and terminal jobs cannot be revived. No job
attempt/effect is executed by rearming. The unchanged processor still authorizes
and serializes all effects. Obsolete/deleted server operations return internal
`inactive` rather than entering the short retry path. Generic jobs remain separate
from server-domain tables. The 30-second lost-delivery recovery remains unchanged.
Worker logs now include processor/rearm duration and whether a deferred retry was
scheduled; those fields do not claim to isolate queue latency.

Focused evidence:

- New jobs targets initially produced **11 passed, two failed**. Both real Redis
  cases exposed publication-before-commit: the first implementation's generation
  predicate rejected a fast consumer before waiting for the publication lock.
  Independent review identified the same race. Locking the outbox by ID before
  comparing its generation corrected it. An intermediate one-case rerun passed;
  the final new-target run passed **14**, with 13 existing cases filtered.
- `scripts/dev.sh pnpm test:m3 packages/jobs/src/jobs.integration.test.ts` —
  **27 passed** (complete affected file, 8.60 s). Real BullMQ tests defer once/three
  times with the recovery interval still 30 seconds, finish within five seconds,
  retain at least 450 ms between deliveries, and commit exactly one effect/attempt.
  Coverage includes a consumer launched inside publication before commit, future
  persisted backoff, stale generations, concurrent deferrals and terminal/deleted
  outbox rows, plus existing lost-delivery recovery tests.
- `scripts/dev.sh pnpm test:m3 packages/server-management/src/gateway-delivery.integration.test.ts packages/server-management/src/lifecycle.integration.test.ts --testNamePattern 'server-lock deferral|inactive .* operation'`
  — **3 passed, 141 filtered**. Actual isolated PostgreSQL advisory-lock contention
  is released and the admitted wake completes within the fixture's 12-second bound,
  below the 30-second recovery fallback, with exactly one mocked provider power call.
  Replaced/deleted operations request no prompt retry or provider effect.
- `scripts/dev.sh pnpm test:m3 packages/server-management/src/gateway-delivery.integration.test.ts`
  — final complete affected file **3 passed** (17.18 s), retaining Redis loss and
  uncertain remote-effect recovery coverage.
- `scripts/dev.sh pnpm typecheck` — passed root/WebPanel. An earlier test-stub
  return type failed typecheck and was corrected before this final run.
- Changed-source Biome — **five files passed**. No historical full-suite rerun.

Independent re-review found the publication race resolved and no remaining must-fix.
This addresses the observed 30-second deferral hole, not every second of protocol
probing, polling, provider work or graceful shutdown. New live latency measurements
still require an Owner-run cycle; no game was started/stopped to manufacture proof.

Existing dev source watchers loaded the worker changes: graceful stop/start at
21:45:46.641/21:45:49.382 UTC, worker/API healthy, deployed transport/lifecycle
source hashes match the workspace. No manual container restart or Gateway change
was needed. No Pterodactyl/Wings, networking, persistent review data or game-server
mutation was performed. Existing approved isolated services were reused; temporary
schemas/unique test Redis queues were cleaned by their fixtures. SFTPGo #18 remains
unchanged. Rollback requires a new revert commit; no migration or data reset.

### 2026-10-11 — Correlated phase diagnostics for Owner wake/sleep retest

Read-only correlation of the next Owner cycle (UTC+2): wake job created
00:01:00.387, prepared effect00:01:03.640, physical process00:01:05.709,
confirmation00:01:09.641. Thus job creation→physical start is5.322 seconds, while
worker logs show its initial processing took3.967 seconds; this does not assign
all five seconds to Redis. Minecraft Done was00:01:38.853, but persisted ready_at
was00:01:38.826 because that timestamp precedes the successful protocol probe.
It cannot measure the player-visible three-second readiness delay.

Minecraft's own “empty for60seconds, pausing” log was00:02:39.079; the stop job
was created00:02:42.095, final handoff00:02:45.021, Minecraft stopping00:02:45.392,
and stop confirmed00:02:46.327. The persisted quiescence deadline was00:02:53.842:
**7.515seconds after confirmation**. Existing rules require a fresh validated
post-deadline snapshot before releasing that promise, consistent with the Owner's
reported MOTD lag. Exact MOTD application/display timing was not recorded by the
old logs. No server command or provider modification was performed for this audit.

Added structured, correlated phase timings from Gateway intentional wake through
API preflight/enqueue, BullMQ delivery, worker authorization/provider calls, API
readiness commit and Gateway effective response/forwarding changes. Quiescence
start/release logs include original deadline and release delay. Routine identical
snapshots/idle observations do not emit transition logs; no packet/player/credential
or provider-payload logging. See the event table and interpretation in M3-API.
Logging failures cannot change measured actions. This pass instruments existing
behavior; it does not weaken readiness, resource/identity checks, lease fences or
quiescence. Nested/inclusive durations must not be added together.

Focused checks:

- `scripts/dev.sh pnpm exec vitest run apps/game-gateway/src/data-plane.test.ts`
  — **86 passed**. An initial targeted privacy assertion falsely matched `join`
  inside the fixed `intentional_join` label; corrected assertion before this full
  affected-file run. Covers transition deduplication, wake correlation/coalescing,
  quiescence deadline logs and throwing log sinks without altered forwarding.
- `scripts/dev.sh pnpm test:m3 packages/server-management/src/lifecycle.integration.test.ts packages/jobs/src/jobs.integration.test.ts --testNamePattern 'bounded operation timings|real round-trip'`
  — **3 passed, 167 filtered**; scoped stage fields, duplicate-effect barrier,
  throwing lifecycle sinks and actual isolated Redis delivery timing fields.
- Root/WebPanel `scripts/dev.sh pnpm typecheck` passed; changed-source Biome
  **13 files passed**. No full historical suite or new live game scenario.

An intermediate edit briefly had a duplicate closing brace detected by Biome;
corrected before tests/typecheck. Existing development watchers may reload API and
worker while sources change. No manual container restart has been executed in this
pass; the Gateway needs a new scoped restart approval to load its new diagnostics.
SFTPGo#18 remains unchanged. No new infrastructure/test assets or persistent review
data changes. Rollback is a new revert commit and, if diagnostics were activated,
a separately approved Gateway restart; no schema migration or data reset.

Runtime/API targeted evidence:

- `scripts/dev.sh pnpm test:m3 packages/server-management/src/minecraft-queued.integration.test.ts apps/api/src/gateway.integration.test.ts -t 'times an ordinary start|records a failed preflight|correlates safe wake phases'`
  — **5 passed, 51 filtered**.
- `scripts/dev.sh pnpm test:m3 apps/api/src/gateway.integration.test.ts -t 'logs accepted readiness|fresh resource observation is insufficient'`
  — **2 passed, 18 filtered** (transition-only readiness output and rejected admission).
- After adding the validated cross-process `wakeRequestId`,
  `scripts/dev.sh pnpm test:m3 apps/api/src/gateway.integration.test.ts -t 'correlates safe wake phases'`
  — **2 passed, 18 filtered**. Throwing sinks preserve success/failure behavior;
  failure records exclude raw errors and credentials.

Independent review found no remaining must-fix; it checked bounded metadata,
transition deduplication, sink isolation and unchanged authorization/fences. Current
API, worker and Gateway containers are healthy. API/worker use existing source
watchers; the Gateway process has not yet loaded this instrumentation. No new
post-instrumentation live timing result is claimed.

### 2026-10-11 — Owner retest: rejected idle stop and oscillating route authority

The next Owner-run cycle exposed a real failure, not a successful sleep test.
Read-only correlation (UTC, local time UTC+2) shows the idle stop job created at
22:13:38.497, a lock-busy delivery at38.944 and a retry at39.960. Its first
authorization succeeded at40.521, durable power intent was prepared at40.796,
and final authorization failed at40.857 with `forbidden`. The operation completed
failed at40.865. Its durable journal records `effect_state=none`, `rejected=true`,
`powerEffectPrepared=false`, `acknowledged=false`, and no Gateway sleep handoff or
confirmed stop. No provider power effect was sent by that operation; the Minecraft
process remained running. These are failure evidence, not successful shutdowns.

Source analysis found that an observation arriving during the active idle-stop
operation cleared `idle_since`, invalidating the final authorization that the
earlier affirmative idle observation had established. The failed `sleep_job_id`
then remained attached: a healthy readiness report set the server online, while
the next reconciliation blocked it again. The Gateway correctly followed that
alternating Core authority, interrupting forwarding sessions. In this path the
Gateway's `backend_not_ready` diagnostic describes a blocked Core route; it does
not establish a failed Minecraft protocol probe. No Minecraft pause setting,
Pterodactyl configuration or readiness timeout was changed to hide the failure.

The new timing logs also distinguish unrelated latency in the preceding wake:
job creation22:11:59.282, initial Redis publication59.749, worker delivery59.761
(12ms delivery age), provider effect prepared22:12:01.959 and observed process
start22:12:03.652732709. A busy confirmation delivery at05.296 retried at06.311,
then completed08.097. The prior durable retry correction therefore avoided its
old 30-second deferral on this cycle. These timings do not establish instantaneous
startup, nor explain every second as queue delay.

The correction keeps a pending stop's route blocked and retains affirmative idle
proof only for its exact active job/generation/process, fresh zero-player sample,
current enabled policy and original unexpired fence. Contrary/unknown evidence
revokes that proof. Recovery detaches only a completed failed attempt whose journal
proves power was never prepared or was explicitly rejected before handoff, with no
power handoff/acknowledgement/stop confirmation; its
failed journal and running reservation remain. Fresh observations must establish
a new complete idle interval. Prepared, uncertain, handed-off or mismatched
operations remain blocked even if the backend answers status successfully.

The deterministic checkpoint regression first **failed** against the previous
source (expected successful stop, got failed), then passed with the correction.
Command: `scripts/dev.sh pnpm test:m3 packages/server-management/src/gateway-orchestration.integration.test.ts -t 'retains affirmative idle proof when a fresh observation races'`.
An intermediate targeted matrix (`-t 'retains affirmative idle proof|revokes a prepared sleep|retires only a rejected|keeps an unresolved'`)
passed **18 tests, 58 filtered** before additional terminal/policy negatives.

The existing dev source watchers loaded the correction without a manual container
restart. Normal configured automation subsequently recovered the old rejected
attempt and created a **new** idle stop at22:21:03.751 UTC, after fresh idle evidence
began at22:20:01.820. Minecraft logged stopping/saving at22:21:07.121; the original
container exited at22:21:07.491795402 and the new job succeeded at22:21:08.719.
Read-only database verification found `sleeping`, provider runtime `offline`,
no active operation and no retained sleep job. The old failed job remains failed
in history. No manual game command, database repair, policy change or provider
configuration change was issued by Codex. The application's existing automatic
sleep policy did perform the stop after loading the fix.

Gateway diagnostics then recorded `sleeping` at22:21:20.790 after its original
quiescence deadline22:21:16.527. An intervening unavailable interval overlapped
an API source-watcher reload (22:21:11.931–22:21:15.895); this is not a clean
end-to-end latency benchmark. The outstanding fence and validation/polling delay
remain; this fix does not claim immediate MOTD transitions or remove lease safety.

An intermediate complete affected-file run had **78 passed, 3 failed**. Two existing
policy-revocation regressions required recovery of conclusively never-prepared
stops as well as explicit pre-handoff rejection; that distinct journal case was
restored. The third was a new terminal-job fixture missing its required
`completed_at`, corrected with an external assertion that the concurrent
observation actually completed (checkpoint exceptions must not falsely pass a
negative lifecycle test). A subsequent focused run had **6 passed, 1 failed**:
the newly added ambiguous-journal fixture had not removed its rejection marker;
the fixture was corrected before final verification. No production authorization
or lease check was removed to satisfy these tests.

Final checks on the corrected source:

- `scripts/dev.sh pnpm test:m3 packages/server-management/src/gateway-orchestration.integration.test.ts`
  — **82/82 passed** (32.42s), including 24 new race, negative-observation,
  policy/terminal-state and recovery regressions; existing admission, process,
  quiescence, manual-stop and uncertain-effect cases retained.
- `scripts/dev.sh pnpm typecheck` — root and WebPanel passed. After the final
  recovery guard, `scripts/dev.sh pnpm exec tsc --noEmit` also passed.
- `scripts/dev.sh pnpm exec biome check packages/server-management/src/gateway-orchestration.ts packages/server-management/src/gateway-orchestration.integration.test.ts`
  — both files passed; `git diff --check` passed.

Independent read-only review found no remaining must-fix after checking the final
recovery guard and negative fixtures. Only the existing approved isolated M2
database services were used; fixtures clean their own temporary schemas. No new
infrastructure, test-owned game asset, manual game command or Gateway restart was
performed. Dev API/worker source hashes match the workspace and all development
containers remain healthy. No production configuration changes, migration or
data reset. No historical full-suite rerun; SFTPGo #18 remains unchanged. Rollback
is a new revert commit; an automatically completed stop is not undone by reverting
code, and the historical failed operation must not be rewritten.

### 2026-10-11 — Remove repeated power preflight and preserve waiting status

The next Owner cycle completed both operations, but retained substantial delay:
join to Docker start7.252s; Minecraft Done to forwarding5.477s; player departure
to stopping response61.596s; stopping response to physical exit11.713s. The
Gateway withdrew its listener for4.405s during startup. Docker recreation is
corroborated, but the old `safety_rejected` log does not distinguish a backend
binding transition from aggregate validation timeout. The detailed read-only
timeline is recorded in PR#21; no game commands were used to collect it.

The measured worker stop effect included setup and repeated checks, not merely
Minecraft shutdown. Its pre-power setup took5.358s, including1.004s authorization
and1.762s provider identity reads; Minecraft stopping to container exit took0.496s.
Start made three runtime-image checks totaling2.801s. Redis delivery was11ms.

Changes:

- Ordinary start/restart now performs one complete image/launch proof at the
  final handoff after durable preparation. Intermediate local authority checks
  and fresh atomic resource admission remain. A changed image after preparation
  still prevents power. No JAR/Mojang download or proof cache was introduced.
- Internal stop-console setup uses the current attempt's validated Application
  metadata/UUID and current local permissions; it no longer repeatedly fetches
  Application/Client server identities. Final provider identity and full authority
  are checked after socket setup, and idle/fence checks remain after durable
  handoff. Generic lifecycle callers retain explicit host verification unless
  their full authorizer contract supplies it. Browser console auth is unchanged.
- Existing waiting responders can survive corroborated backend container gaps
  or absent effective bindings, with fresh public collision/topology/provider
  checks, matching proof/generation and node challenge. New binds and forwarding
  cannot use that exception; unsafe identity/collisions and aggregate timeout
  still withdraw the listener. ADR0012 documents the narrow exception.
- One duplicate Core context request was removed within each node-challenge
  validation. Fixed safety-failure reasons and stop setup/terminal phase timings
  now expose previously indistinguishable failures and latency.

Focused validation and intermediate failures:

- Minecraft queued tests initially had8failures/5passes: six old drift fixtures
  reached their nonexistent host disk before the relocated final image proof;
  those tests now use their isolated recorded admission observations. Two new
  assertions wrongly expected one host sample although fixtures accumulate
  multiple hosts. A diagnostic rerun reproduced the host-path issue while both
  new full-runtime handoff cases passed. Final
  `scripts/dev.sh pnpm test:m3 packages/server-management/src/minecraft-queued.integration.test.ts`
  — **39/39 passed**. Full runtime tests retain actual admission with isolated
  resource samples; image drift after preparation rejects power, with exactly one
  image observation.
- `scripts/dev.sh pnpm exec vitest run packages/gateway-safety/src/validator.test.ts apps/game-gateway/src/data-plane.test.ts apps/game-gateway/src/main.test.ts`
  — **191 passed**. Added sleeping-transition and aggregate-timeout cases then
  passed with `-t 'already owned waiting responder|aggregate validation timeout|sleeping proof|namespace|node challenge'`
  across validator/data-plane: **16 passed,169 filtered**. Timeout closure remains
  explicitly tested; the live interruption is not claimed resolved before retest.
- `scripts/dev.sh pnpm test packages/pterodactyl-adapter/src/power.test.ts packages/pterodactyl-adapter/src/console.test.ts`
  — **26 passed**; the subsequently added real-WebSocket request-count case passed
  with `console.test.ts -t 'managed stop UUID'` (**1 passed,6 filtered**). Internal
  stop setup requests only egg metadata, WebSocket credentials and power, without
  extra Application/Client server fetches. Final lifecycle identity checks remain.
- The complete lifecycle/orchestration run
  `scripts/dev.sh pnpm test:m3 packages/server-management/src/lifecycle.integration.test.ts packages/server-management/src/gateway-orchestration.integration.test.ts`
  — **230 passed,1 failed** (125.76s). The failure exposed the generic-caller host
  contract described above; the explicit fallback was restored rather than
  weakening that test. All82 sleep/wake orchestration tests passed in this run.
- After restoring the generic host check,
  `scripts/dev.sh pnpm test:m3 packages/server-management/src/lifecycle.integration.test.ts -t 'observations belong to another physical host|local stop-console|changes during console setup'`
  — **4 passed,145 filtered**. The six new lifecycle cases had also passed in
  their initial focused run, including revoked final start authority and changed
  provider identity during console setup.
- `scripts/dev.sh pnpm typecheck` — root/WebPanel passed; final backend
  `scripts/dev.sh pnpm exec tsc --noEmit` passed after the host-contract correction.
  Changed-source Biome (13 files) and whitespace checks passed.

Independent code review found no remaining must-fix in the authorization or
retained-status proof boundaries. The reviewer explicitly requires unknown
validation timeouts to remain fail-closed; retaining an old responder on timeout
would require separate cancellation/late-result fencing and is not part of this
patch. Request-count reductions are tested, but lower real-cycle timings and the
specific cause of the previous transient interruption still require Owner retest.

Only existing approved isolated test services were reused; no new game assets or
infrastructure. API/worker loaded source changes through existing development
watchers and all development containers are healthy. No manual game commands,
provider/configuration/network changes, database repair or Gateway restart were
performed. The Gateway needs a separately approved scoped restart to load these
changes; it is still running the earlier executable. SFTPGo#18 is unchanged.
Rollback uses a new revert commit and, after activation, another explicitly
approved Gateway restart; no schema migration or data reset is required.

### 2026-10-11 — Follow-up cycle and coherent Docker observation

Read-only evidence from the Owner's next cycle (UTC, 2026-10-10) after the approved
Gateway restart at 22:40:58 confirms improvements and a remaining interruption:

| Measurement | Previous cycle | This cycle |
|---|---:|---:|
| Join to Docker process start | 7.252 s | 5.197 s |
| Initial start-worker execution | 5.430 s | 3.472 s |
| Minecraft Done to Gateway forwarding | 5.477 s | 4.423 s |
| Waiting-listener interruption during start | 4.405 s | 5.173 s |
| Stopping response to physical container exit | 11.713 s | 4.910 s |
| Physical exit to sleeping response | 7.371 s | 8.742 s |

The join arrived at 22:44:13.421, worker delivery at 14.067 (14 ms delivery age),
and Docker started at 18.618. The single final runtime-image check took 1.168 s;
no JAR/hash or Mojang download occurred in this power path. Minecraft Main began
at 20.300, Done at 22:45:10.721, and forwarding resumed at 15.144. The game startup
itself must be distinguished from the 4.423 s observation/commit/route delay.

At 22:44:19.123 the Gateway emitted generic `validation_failed`, then withdrew the
listener until 24.297. Docker recreated the container at 18.484. This is neither
a logged aggregate timeout nor a validator-specific collision failure. Inspection
identified two earlier observer failure paths: a listed container disappearing
before inspect, or a changed final container ID set. Both were flattened to the
same error. The historical log cannot prove which inner predicate failed; container
recreation is corroborated, and both paths require regression coverage.

The stopping response began at 22:46:13.876, before the power request at 17.814.
That response marks refusal of new logins before automatic stop, not a claim that
Minecraft already received stop. Minecraft stopped at 18.350 and the container
exited at 18.786. Stop-console setup took 389 ms, final handoff 592 ms, power HTTP
503 ms and terminal confirmation 1.318 s; these spans are nested in the 3.261 s
adapter effect. Redis delivery took 6 ms. The stopping promise expired at 25.899;
a successful fresh snapshot released it at 27.528. The remaining post-exit MOTD
delay is this original fence plus observation time, not slow Minecraft shutdown.
This pass does not shorten that fence or silently permit an early wake.

No players joined this cycle. Final read-only state was sleeping/offline, with no
active operation, failed sleep reference or last error. No manual game commands,
resource cleanup or provider mutations were performed for this investigation.

The observer now discards the failed inventory and retries once only for proven
container churn. Exact Docker missing-container stderr must match requested IDs,
partial stdout must contain exactly the valid surviving rows, and fresh lists
must confirm disappearance with unchanged networks. Complete changed-ID snapshots
also qualify. Sibling failures settle first and take precedence over churn. All
namespace/daemon/inventory/socket reads are repeated within the original 15-second
budget; persistent churn, malformed data, permissions and network changes remain
fail-closed. Fixed observer reason codes now reach Gateway diagnostics. A read-only
inspect of a nonexistent synthetic ID verified the installed Docker CLI's error
form; no real container was changed.

Independent review found no remaining must-fix in the retry/freshness/collision
boundary. This fixes two reproducible observer races, not a proven reconstruction
of the old flattened exception. The original successful suites remain historical
evidence; real startup continuity still requires activation and another Owner cycle.

Focused checks (no historical full-suite rerun):

- The two new container-recreation fixtures failed against the original observer,
  then passed after the fix. An intermediate full observer run passed 46 tests.
- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/network-observer.test.ts packages/gateway-safety/src/validator.test.ts apps/game-gateway/src/data-plane.test.ts`
  — **232 passed, 1 timed out** at the existing 20-second limit. The timeout was
  the pre-existing binary TCP/half-close/concurrent-client case. It also timed out
  on the first isolated rerun. The exact HEAD baseline, copied to an ignored
  local harness without changing watched source, passed near the 20-second limit.
  Initial baseline harness attempts failed module resolution before running tests;
  the local harness resolution was corrected, not product dependencies.
- Final isolated current-code rerun:
  `scripts/dev.sh pnpm exec vitest run apps/game-gateway/src/data-plane.test.ts -t 'streams binary TCP with half-close and concurrent clients' --reporter=json --outputFile=.codex/local/gateway-observer-baseline/current-tcp-result.json`
  — **1 passed, 89 filtered**, measured 16.307 s. No timeout or forwarding-code
  change was made. This is a passing targeted rerun, not a clean combined-suite
  result; the threshold-sensitive test remains a validation limitation.
- Two additional observer cases for complete surviving partial-batch accounting,
  fresh wildcard bindings and the hard wall deadline passed in a focused run.
- `scripts/dev.sh pnpm exec tsc --noEmit` passed. Biome checks on the four changed
  TypeScript files passed. `git diff --check` passed.
- `python3 scripts/check-governance.py` passed: 501 indexed text files, 106 review
  PNGs, 431 relative links, 4 TOML files and 44 ignore cases.

No database tests, live game tests, additional infrastructure or game resources
were needed for this observer change. Gateway activation is pending a new scoped
restart approval; the previous approved restart activated the preceding commit.
Rollback is a new revert commit and an explicitly approved Gateway restart. No
migration, persistent data change or provider configuration change is required.
SFTPGo #18 and the production-release boundary remain unchanged.

### 2026-10-11 — Consolidate start/stop checks and notify committed jobs

The Owner requested a complete critical-path pass after the next cycle showed
5.627 s join-to-process time, 5.820 s Done-to-forwarding and 11.781 s physical
exit-to-sleeping response. That cycle had coherent route transitions with no
recorded listener withdrawal, snapshot error or lease expiration; both jobs
succeeded. This change targets pre-power work and delivery, not the separate
readiness pipeline or original Gateway quiescence deadline.

Read-only investigation identified two intentional 250 ms CPU sampling windows,
a 500 ms outbox polling interval, three Application server GETs during start,
repeated final Docker preflight, and a sequential server/egg lookup. The prior
runtime-image stage measured 957/613 ms in two isolated read-only probes; its
name included remote metadata as well as Docker/local validation.

Implemented:

- Planned power identity and telemetry GETs run concurrently and settle before
  admission or telemetry publication; invalid identity cannot publish telemetry.
- Start/restart/initial-start final provider proof is acquired after durable
  preparation. Runtime validation shares that promise and independently starts
  egg lookup. Both settle before effects. This removes the discarded intermediate
  provider GET and uses two Application server reads on a normal initial start
  attempt. The same fresh snapshot checks limits, installation and suspension.
- Final runtime authorization shares its own successful observer preflight with
  image inspection. Worker host sampling is scoped to the relevant physical host
  and overlaps preflight, retaining the 250 ms CPU window, fresh observations,
  current permissions and atomic admission. Inexpensive local compatibility reads
  remain fresh after external waits instead of introducing a broad proof cache.
- After all parallel final proofs, current local permissions are checked again;
  generic callers without that guard receive full reauthorization. Runtime hooks
  also await provider proof when no game-specific image hook consumes it.
- Stop uses the initial verified snapshot for internal console preparation and
  retains fresh identity/full authority after the handshake. Intermediate local
  guards remain. Repeated pre-handshake full checks are removed where final
  handoff supplies them. Terminal confirmation and reservation/fence rules remain.
- Both durable enqueue paths issue PostgreSQL NOTIFY inside their transaction.
  The schema-scoped signal arrives only on commit and immediately wakes the
  existing outbox dispatcher. One dedicated pooled connection listens; reconnect,
  2-second setup timeout and late-acquisition cleanup are bounded. A failed or
  hanging listener cannot suspend the unchanged authoritative polling/recovery.
  No schema migration, new dependency or new service is needed.

Independent review caught two issues before delivery: listener setup initially
blocked fallback dispatch; and parallel identity/auth allowed a generic authorizer
to finish before a later permission revocation. Both were corrected, with hung
listener/late-client cleanup and post-barrier revocation regressions. Final code
review has no remaining must-fix.

Intermediate test results are preserved: lifecycle initially passed 155/155,
then focused changed-branch batches passed 9, 13 and 15 cases as proof sharing
and final local guards were added. Runtime tests initially exposed a recursive
fixture mock and early parallel rejection; both were corrected with saved mock
implementation and settled branches. The first complete Minecraft/runtime run
passed 79/80: the new host-overlap test incorrectly expected no reservation,
although enqueue already creates one. It now asserts that the existing reservation
is unchanged until both probes complete; that case passed, as did the seven
Promise/drift/revocation cases and the generic-game revocation regression.

Read-only post-change runtime probes measured 946 ms and 441 ms, with server/egg
requests starting at 6/142 ms and 3/15 ms respectively. Remote request durations
varied: server 545/273 ms, egg 458/280 ms. These are not a controlled end-to-end
benchmark or a claim of meeting the 1.5–2 s goal. Calls were protected by a
GET-only fetch guard and a PostgreSQL read-only session against an already pinned
installation; no power, configuration or artifact transfer was performed.

Final validation on the integrated source:

- `scripts/dev.sh pnpm test:m3 packages/server-management/src/lifecycle.integration.test.ts packages/server-management/src/minecraft-queued.integration.test.ts packages/server-management/src/runtime.integration.test.ts`: **245/245 passed**, 113.28 s.
- `scripts/dev.sh pnpm test:m3 packages/jobs/src/jobs.integration.test.ts`: **31/31 passed**, 14.52 s, before the final batch-continuation regression below.
- `scripts/dev.sh pnpm exec vitest run packages/database/src/job-notifications.test.ts`: **2/2 passed**, including bounded setup and late acquisition cleanup.
- `scripts/dev.sh pnpm test:m3 apps/api/src/gateway.integration.test.ts -t 'correlates safe wake phases'`: **2 passed, 18 filtered**. Authenticated wake samples only its selected physical host.
- `scripts/dev.sh pnpm exec tsc --noEmit`: passed after API integration. Biome checks on changed TypeScript files passed.

The final queue inspection also found that a terminal/deferred outbox row ended
the batch despite other due work. Dispatch now distinguishes no row from a skipped
row, retaining the iteration bound and publication count. Its three targeted
regressions initially passed the deferred case but failed two terminal fixtures
because they omitted the database-required completion timestamp. The fixtures
were corrected without changing the database constraint.

Development API/worker source watchers loaded the changes. Read-only checks found
API, worker and Gateway healthy, the relevant nine worker source files identical
to workspace source, and one dedicated active LISTEN connection. No Gateway code
changed in this pass and no Gateway restart was performed. Existing approved
isolated database/Redis tests used private disposable schemas/queues; no new
containers, game servers, migrations or development data resets were performed.
No commands were sent to the Owner's server. No UI or production infrastructure
was changed. Independent technical review found no outstanding must-fix after
the corrections above.

The next Owner-operated start/sleep cycle is still needed to measure end-to-end
improvement; 1.5–2 s join-to-process is a target, not a verified result. Readiness
confirmation and the original post-stop Gateway quiescence deadline remain
separate sources of latency and were not weakened. Rollback uses a new revert
commit loaded by the development watchers; no schema rollback or provider change
is required. SFTPGo issue #18 remains an independent production-release gate.

- Final batch-continuation rerun: `scripts/dev.sh pnpm test:m3 packages/jobs/src/jobs.integration.test.ts -t 'continues the same dispatch batch'`: **3 passed, 31 filtered**, 3.10 s. This is targeted evidence after the 31-test queue run, not a claim of a repeated full suite.
- Final indexed governance: `python3 scripts/check-governance.py` passed (503 text files, 106 PNGs, 431 relative links, 4 TOML files, 44 ignore cases); heuristic secret scan passed. Biome passed on all 18 changed TypeScript files; `git diff --cached --check` passed.

### 2026-10-11 — Owner cycle after bf7c456 and provider-rate correction

Read-only correlation of the Owner-operated cycle beginning 23:33:55.936 UTC:
join-to-process **2.633 s** (previous 5.627), Done-to-forwarding **3.399 s**
(previous 5.820), process-exit-to-sleeping **11.273 s** (previous 11.781).
Power HTTP completed 1.723 s after join; Docker started 0.910 s later. Redis
publication followed accepted enqueue by approximately 4 ms, delivery took 6 ms,
and final worker authorization took 436 ms. These distinguish power completion
from process startup and do not claim the 1.5–2 s process target has passed.

This cycle was not a clean functional pass. At 23:36:09.020 the provider Application
API returned 429 during inventory; Core returned 503, Gateway closed its listener
at 09.028 and Minecraft recorded player disconnection at 09.041. The listener
recovered at 12.923. The pattern repeated at 23:37:09.719, recovering 13.472.
The captured failure window contains 16 upstream 429s (12 inventory, 4 observation
calls), not a measurement of total provider traffic or the configured quota.
Stop arrived 9.566 s after the 60-second idle threshold, affected by that second
interruption. Both jobs ultimately succeeded; final state was offline/sleeping,
with no pending operation, sleep/wake job or error. Raw logs remain private.

The correction shares simultaneous JSON reads across per-request adapter instances,
retains provider cooldown metadata and avoids repeated calls during Retry-After.
API and worker use separate process-scoped coordinators. Backend probes also share
the last successful listener's exact route/context provider evidence within its
original freshness budget. New listener and renewal inventory remains fresh, as do
local context, Docker/network observation and game protocol probes. Gateway treats
only the authenticated explicit provider-rate-limit response as transient and
retains only existing committed leases; it never grants new authority from missing
evidence. See [M3 contract](M3-API.md) for bounds and failure semantics.

Validation:

- Adapter transport/adapter/power files: **81/81 passed**; final active-request
  eviction guard rerun of `packages/pterodactyl-adapter/src/transport.test.ts`:
  **13/13 passed**. Includes coalescing, credential separation, Retry-After,
  cross-adapter cooldown, mutation freshness and no mutation replay.
- `scripts/dev.sh pnpm exec vitest run apps/game-gateway/src/control-client.test.ts apps/game-gateway/src/data-plane.test.ts`:
  **132/132 passed**. Final concurrent cooldown guards: **5 passed, 89 filtered**
  using `-t 'cooldown|rate limited'` on the data-plane file.
- `scripts/dev.sh pnpm exec vitest run packages/gateway-safety/src/validator.test.ts`:
  **104/104 passed**. Three consecutive listener/backend checks use one provider
  inventory but three fresh Docker/context/game samples; renewal reads again.
  Tests reject stale evidence, changed identity/revision/generation, failed renewal,
  fresh Docker collisions and expiry during the protocol probe.
- `scripts/dev.sh pnpm test:m3 apps/api/src/gateway.integration.test.ts`:
  **21/21 passed**, including authenticated-only bounded cooldown metadata.
- During integration a coordinator import had been formatted as type-only before
  a value re-export was added. Typecheck caught it; the first API test attempts
  failed during import without executing cases. The value import was corrected;
  final TypeScript `scripts/dev.sh pnpm exec tsc --noEmit` passed.

Independent technical review found no must-fix. It confirmed original-lease expiry,
no new/staged listener authority, sanitized authentication boundary, fresh listener
inventory and bounded backend-only evidence sharing. No new runtime, dependency,
migration, container or game asset is needed. No provider setting, rate-limit value,
account, API key, egg, server, production network or existing game data was changed.
No M5 UI changed. SFTPGo #18 remains unchanged. Gateway activation needs its scoped
development restart; end-to-end traffic reduction and post-change player stability
remain unverified until activation and an Owner-operated cycle. Revert this commit
and restart the Gateway under approval to roll back; no database rollback required.
- `scripts/dev.sh pnpm test:m3 apps/api/src/app.integration.test.ts -t 'logs only safe provider failure'`: **1 passed, 8 filtered**, confirming ordinary browser diagnostics do not expose the Gateway cooldown contract.
- Biome passed on all 16 changed TypeScript files; staged diff whitespace and
  indexed governance passed (504 text files, 106 PNGs, 432 relative links, 4 TOML
  files, 44 ignore cases; heuristic secret scan). Read-only Docker inspection
  found development API, worker and Gateway running/healthy. API/worker watchers
  load their changes; the Gateway still requires activation of this revision.


### 2026-10-11 — Terminal sleep proof and post-readiness refresh

The Owner-operated cycle on `8bee7343` was audited read-only: intentional join to
successful power HTTP response **1.963 s**, join to Docker process start **2.812 s**,
Minecraft Done to forwarding **4.552 s**, and Docker exit to sleeping response
**12.984 s**. The last interval consisted of 10.109 s remaining original fence
plus 2.875 s subsequent refresh/validation. The game's own empty-for-60-seconds
pause log preceded stop by 7.269 s; that is not a measured player-disconnect or
NickHosting idle deadline. Both jobs succeeded and final state was offline/sleeping
without active jobs/errors. No post-restart 429 or listener-loss event appeared in
the captured application logs. Revision conflicts and unavailable observations
still occurred; no successful player-login evidence was present. This single
sample neither establishes sustained gameplay nor exercises live rate-limit
fallback. Raw logs remain private; [PR cycle evidence](https://github.com/ImJstNickDev/nickhosting-panel/pull/21#issuecomment-6103599173)
records commands/boundaries. [Issue #25](https://github.com/ImJstNickDev/nickhosting-panel/issues/25)
tracks future per-user Client keys and Blueprint work separately.

Corrections in this pass:

- Core supplies negotiated, optional terminal sleep evidence from the latest
  durable confirmed sleep stop. Batch lookup only covers offline inactive servers;
  no new per-route operation lookup or provider request. Generic/uncertain/failed
  stops, active operations/reservations and foreign generations cannot mint proof.
- Gateway can release the exact local fence after fresh fully validated terminal
  evidence across all unchanged roles. The original deadline remains for unknown
  cases. Withdrawal, deadline changes, prefetched snapshots, partial roles and
  changed endpoints cannot release early. Status/wake only resume with sleeping
  authority; no forwarding to an offline backend is granted.
- A post-readiness refresh now waits for a pre-commit in-flight refresh and fetches
  again. Previously joining that older promise could leave a waking snapshot in
  place until the next periodic poll.
- Process observation runs independent prerequisites concurrently and reuses only
  that invocation's completed host preflight for Minecraft image verification.
  All concurrent branches settle on failure; identity and before/image/after
  process checks remain, without cross-observation caching or artifact transfers.
- Snapshot feature negotiation protects older strict Gateway clients during a
  Core-first update. No database migration, dependency, provider configuration,
  UI or infrastructure change is needed.

Validation (targeted; not a repeated historical full suite):

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/runtime.integration.test.ts packages/server-management/src/minecraft-queued.integration.test.ts`:
  **84/84 passed**. Includes independent prerequisite concurrency, failure drain
  and exactly one host preflight per observation.
- `scripts/dev.sh pnpm exec vitest run packages/game-sdk/src/gateway.test.ts`:
  **7/7 passed**.
- `scripts/dev.sh pnpm test:m3 packages/server-management/src/gateway-registry.integration.test.ts`:
  initial **40/42 passed**; two newly written fixtures violated existing DB
  completion/state constraints. Corrected fixtures and asserted the impossible
  state is rejected by PostgreSQL. Targeted `-t 'durable completed sleep evidence'`
  **18/18 passed**, including matching TCP/UDP proof and all rejection cases;
  final offline-only query selection checks **3/3 passed**.
- `scripts/dev.sh pnpm exec vitest run apps/game-gateway/src/data-plane.test.ts apps/game-gateway/src/control-client.test.ts`:
  initial **144 passed, 1 failed** because the positive new fixture's clock margin
  was smaller than its configured skew. Corrected the fixture's explicit skew;
  `-t 'completed sleep fence|older waking refresh|validates authenticated snapshot'`
  **14 passed, 131 filtered**. No production check was relaxed to fix the fixture.
- `scripts/dev.sh pnpm test:m3 apps/api/src/gateway.integration.test.ts`:
  **22/22 passed**, including legacy/new snapshot negotiation with stable revision.
- `scripts/dev.sh pnpm exec tsc --noEmit`: passed on integrated source.

Independent reviewer found no must-fix in terminal-proof authority, late-report
rejection, legacy negotiation, readiness refresh or process-verification changes.
Tests used existing isolated PostgreSQL/Redis and loopback fixtures. No game server
was created, powered or modified, and no infrastructure was restarted for this
pass. API/worker development watchers can load source changes; the standalone
Gateway requires an operation-specific approved restart. No new measured latency
improvement is claimed before activation and a subsequent Owner-operated cycle.
Rollback: revert this change, then load the prior Gateway under a scoped restart
approval; no database rollback is required. SFTPGo #18 remains unchanged. M5 PR
stays open/unmerged; no M6 or production deployment.

### 2026-10-11 — Event-prompted Minecraft readiness, original-lease receipt

Owner requested trying the live startup notification path rather than repeating
full infrastructure checks simply to switch a validated waking route online.
Minecraft now declares a provider-running hint; Core relays only correlated
route/generation/job metadata from live status events, never historical console
or raw `Done` lines. Gateway immediately schedules a real Minecraft probe, with
single-flight observation and polling recovery. A hint alone cannot enable play.

Fresh full validation may supply a bounded within-lease protocol-only probe.
Core still verifies current process/identity and commits readiness. An opt-in
receipt can advance unchanged waking roles online without a second infrastructure
scan/configuration fetch, but cannot extend the original lease, create listeners,
change endpoints or override quiescence. Full opening/renewal checks remain.
Host-gated Docker process reads overlap provider/module discovery; retained
start proofs were deliberately not reused because they lack configuration
fingerprints. No startup/shutdown JAR download was added.

Validation (isolated fixtures and the existing approved M2 test database only):

- `scripts/dev.sh pnpm exec vitest run apps/game-gateway/src/data-plane.test.ts apps/game-gateway/src/control-client.test.ts apps/game-gateway/src/readiness-receipt.test.ts apps/game-gateway/src/startup-client.test.ts apps/api/src/gateway-startup.test.ts packages/game-sdk/src/gateway.test.ts games/minecraft/src/protocol.test.ts packages/gateway-safety/src/validator.test.ts`
  — **326 passed, two failed** on the first affected-suite run. One old assertion
  expected no observation feature header; updated for explicit receipt negotiation.
  One existing completed-sleep fixture encountered `EADDRINUSE` on an ephemeral
  loopback port. Neither failed attempt is relabeled as a passing full run.
- `scripts/dev.sh pnpm exec vitest run apps/game-gateway/src/data-plane.test.ts apps/game-gateway/src/control-client.test.ts --testNamePattern 'receipt|completed sleep fence|authenticated snapshot'`
  — **15 passed, 135 filtered** after the changes, including both failed cases,
  an actual held TCP stream expiring at its captured lease after concurrent renewal,
  and rejection of a receipt racing replacement authority.
- `scripts/dev.sh pnpm exec vitest run apps/game-gateway/src/main.test.ts apps/api/src/gateway-startup.test.ts apps/game-gateway/src/readiness-receipt.test.ts`
  — **32 passed** on final source, including bounded SSE backpressure cleanup.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/gateway.integration.test.ts`
  — **23 passed**: authenticated API, legacy 204 and receipt negotiation, process
  verification, stale-route rejection and unchanged admission.
- Independent runtime worker: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/runtime.integration.test.ts`
  — **42 passed**; overlapping reads never return authority before all proofs,
  and failed host preflight prevents the Docker read.
- `scripts/dev.sh pnpm exec tsc --noEmit` — passed. Scoped Biome over the 24
  affected/adjacent TypeScript files — passed. `git diff --check` — passed.
- Independent technical review found and resolved two must-fix cases: stalled SSE
  writes retaining a subscription, and a receipt failing to rearm the earlier
  captured lease timer. No remaining must-fix was identified.

No live server was created, started, stopped or changed. No Docker/Panel/network
operation was performed for implementation or validation. API/worker source watchers
may load changes automatically; Gateway requires its separately approved dev-only
restart. Actual event-to-forwarding timing is **not yet measured** on this patch.
Historical evidence above remains intact; SFTPGo #18 remains a release gate.
Rollback is a source revert plus an approved Gateway restart; no migration or data
rollback is involved. PR #21 remains open/unmerged; no M6 work.

Activation follow-up: Owner explicitly approved the single
`docker restart --time 20 nickhosting-dev-gateway-1`. Verified the exact source
HEAD `6c88f4887a83f66497f41201d3cfd1a34661a3ef`, clean worktree and Compose labels
(`nickhosting-dev` / `gateway`) before executing. Container started at
`2026-10-11T10:15:27.438533638Z`; after the existing old-lease drain, route recovery
logged at `10:16:01.485Z`. Docker health is healthy and authenticated Unix `/readyz`
returned HTTP 200, `ready=true`, `controlAvailable=true`, one route. Data-plane,
startup client and receipt source hashes match the reviewed workspace. No API
power command or server mutation was sent. The command emitted Docker's harmless
`--time` deprecation notice; it completed successfully. New real wake-cycle timing
still awaits the Owner's test; this restart is not a performance measurement.

### 2026-10-11 — Owner cycle on `6c88f48` and startup-module correction

Read-only capture after the Owner's “test finished”, independently cross-checked.
Private raw logs remain under `.codex/local/cycle-6c88f48/`; no credentials, player
names or infrastructure endpoints are published here. Initial capture still had
a running server; follow-up capture includes the completed automatic sleep.

| Event (UTC) | Time | Measured interval |
| --- | --- | --- |
| Intentional Gateway join | 10:19:46.256 | Origin |
| Core admission/enqueue complete | 10:19:46.616 | 360 ms from join |
| Worker delivery | 10:19:46.624 | Redis delivery age 5 ms |
| Power API response complete | 10:19:48.071 | 1.815 s from join |
| Docker process started | 10:19:49.051448972 | 2.795 s from join |
| Minecraft `Done` | 10:20:20.248060819 | 31.197 s after process start |
| Readiness observation begins | 10:20:21.297 | 1.049 s after `Done` |
| Core commits online | 10:20:22.562 | 2.314 s after `Done` |
| Gateway forwards (`readiness_receipt`) | 10:20:22.599 | 2.351 s after `Done`; 37 ms after Core |
| Last player leaves | 10:21:13.827030765 | Idle origin |
| Gateway quiescence / stopping reply | 10:22:14.646 | 60.819 s after departure |
| Console receives `stop` | 10:22:17.136565315 | 63.310 s after departure |
| Minecraft logs `Stopping server` | 10:22:17.199356096 | Shutdown begins |
| Docker exits | 10:22:17.690435904 | Exit 0, no OOM |
| Durable stop job succeeds | 10:22:18.838 | No uncertain stop left in this run |
| Gateway sleeping reply | 10:22:22.204 | 4.514 s after Docker exit |

The receipt optimization worked: `Done`→forwarding fell from 3.794 s in the prior
cycle to 2.351 s (about 38%); Core→forwarding fell from 1.077 s to 37 ms. This is
one observed cycle, not a guaranteed percentile. Core process verification still
took 911.834 ms; the approximately 256 ms between observation start and Core handler
includes probing/transport and cannot be split reliably with these logs.

**The startup event did not run.** No `gateway.startup_hint` appeared. Inspection
found the real configured `gateway-module.ts` wrapper omitted `startupHint`, although
the inner protocol adapter declared it. Thus polling triggered this cycle's
observation. Corrected the outer exported module to declare `provider_running`
and added an assertion on the actual `gatewayProtocols` loader export. Existing
`supports`/release/evidence gating is unchanged. This fixes an integration omission
in the previous patch; the previous result must not be called an event-driven test.

Targeted module test command:
`scripts/dev.sh pnpm exec vitest run games/minecraft/src/gateway-module.test.ts`
— **6 passed**. Scoped Biome over module/source tests and root TypeScript passed.
Independent source/evidence review found no remaining must-fix. No historic full-suite
rerun was needed for this declaration-only correction. Its live event behavior
requires a separately approved Gateway restart and another Owner-driven cycle.

No captured 429, lease expiry, snapshot failure or listener closure. Three stale
API conflicts during startup (two 409 observations, one 412 context), additional
transitional 409 observations during sleep, and offline/starting probe
warnings remain diagnostic; they are not evidence of a client disconnect. A worker
lock deferral happened after Docker was running and the start job succeeded.
Minecraft also reported 2.021 s and 6.827 s tick lag; do not attribute that to Gateway
without separate evidence. Final Docker state is exited cleanly. No test assets,
provider mutations or manual power commands were created by this audit. Source
watchers reloaded after the narrow code correction; no Gateway restart performed
in this session yet. SFTPGo #18 and production boundaries are unchanged.

### 2026-10-11 — Owner cycle on `0989da9`, HTTP idle timeout investigation

Read-only correlated logs and exact Docker state were independently reviewed.
Raw evidence is ignored under `.codex/local/cycle-0989da9/`.

| Event (UTC) | Time | Interval |
| --- | --- | --- |
| Intentional join | 10:26:51.068 | Origin |
| Start power response | 10:26:52.829 | 1.761 s after join |
| Docker process start | 10:26:53.837645265 | 2.770 s after join |
| Minecraft `Done` | 10:27:29.332037911 | Actual game startup log |
| Core commits online | 10:27:30.644 | 1.312 s after `Done` |
| Gateway forwards via readiness receipt | 10:27:30.961 | 1.629 s after `Done`; 317 ms after Core |
| Player disconnect | 10:30:30.597075056 | Idle origin |
| Gateway stopping/quiescence reply | 10:31:33.662 | 63.065 s after disconnect |
| Console `stop` command | 10:31:35.565070466 | 64.968 s after disconnect |
| Docker exit | 10:31:36.066370248 | Clean exit 0, no OOM |
| Stop job succeeds | 10:31:37.148 | Terminal successful operation |
| Gateway sleeping reply | 10:31:40.090 | 4.024 s after Docker exit |

The receipt path worked again. `Done`→forwarding improved from 2.351 s in the
preceding cycle to 1.629 s; this single-cycle comparison is not a guaranteed
latency. Observation `observedAt=10:27:28.449` predates `Done` by 883 ms: it is the
start of sampling, not the time a successful protocol reply arrived. Core process
verification was 555.303 ms and transaction commit 271.212 ms in this cycle.

**Still no startup-hint event in this capture.** Investigation found the actual
API HTTP server closes inactive sockets at 30 seconds, whereas startup SSE sent
nothing until the running event. This start lasted approximately 36 seconds after
the waking route was installed. The ten-second subscription retry can then miss
the running event before polling finishes. Independent reproduction used real
Hono, its Node adapter and the project's HTTP server on isolated ephemeral
loopback: idle150ms/event400ms without heartbeat terminated at222ms; with a
50ms heartbeat the event arrived at414ms. These scaled fixture timings establish
the HTTP failure mechanism, not a captured live subscription-close timestamp.

Corrective change: negotiate `startup-keepalive-v1`, emit a canonical empty
keepalive immediately and every10s, and consume it without invoking readiness.
This preserves the global30s idle timeout, absolute60s subscription/65s client
bounds, 1KiB/two-event writer limit with5s backpressure deadline, and8KiB client
budget. Partial/coalesced frames remain bounded. Legacy clients receive no new
frames during Core-first deployment. Keepalive cannot renew route authority.
Opening/closing diagnostics contain only correlated identities, canonical reasons
and elapsed time, never provider credentials or console content.

No429, lease expiry, listener closure, snapshot failure or error-level event was
captured. Six412 stale conflicts, one409 conflict, one409 uncertain-stop observation
and49 unavailable observations are retained as diagnostic limitations, not
reported as security passes or client disconnects. Both jobs succeeded. Minecraft
reported2.137s and5.545s tick lag; that is not attributed to Gateway without evidence.
No live server mutation, manual power command, new Docker resource or cleanup was
performed by this audit. The heartbeat correction requires separately approved
Gateway activation and another Owner cycle to establish live event delivery.

Heartbeat validation on final changed source:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/gateway-startup.test.ts apps/game-gateway/src/startup-client.test.ts apps/api/src/http-server.test.ts`
  — **41 passed**. Real HTTP regressions use the actual project server/Hono adapter
  with a200ms inactivity timeout and provider-running event after700ms: suppressed
  heartbeat reproduces failure, negotiated heartbeat delivers the correlated event.
  Other coverage includes legacy negotiation, partial/coalesced frames, excess
  heartbeat bytes, unchanged absolute deadline, revocation and slow-consumer cleanup.
- Root `scripts/dev.sh pnpm exec tsc --noEmit` and scoped Biome over four changed
  TypeScript files passed. Independent review found no remaining must-fix.
- No historical full test matrix was rerun. The previous live cycle remains a
  receipt/polling result; fixture success is not claimed as live event delivery.

Rollback: revert this source change and perform a separately approved dev Gateway
restart; no migration or data reset. PR #21 remains open/unmerged; SFTPGo #18 and
M5 boundaries unchanged.

### 2026-10-11 — Live startup hint confirmed on `0e786e5`

Owner-driven cycle, inspected read-only and independently cross-checked. Private
raw evidence remains ignored under `.codex/local/cycle-0e786e5/`.

| Event (UTC) | Time | Measured interval |
| --- | --- | --- |
| Intentional join | 10:43:41.495 | Origin |
| Start power HTTP response | 10:43:43.408 | 1.913 s from join |
| Docker process starts | 10:43:44.383404576 | 2.888 s from join |
| Minecraft `Done` | 10:44:15.135770392 | Game startup completion log |
| Gateway receives startup hint | 10:44:15.219 | 83.230 ms after `Done` |
| Readiness observation begins | 10:44:15.470 | 251 ms after hint |
| Core commits online | 10:44:16.079 | 943.230 ms after `Done` |
| Gateway forwards (`readiness_receipt`) | 10:44:16.104 | 968.230 ms after `Done`; 25 ms after Core |
| Player disconnect | 10:44:33.330991397 | Idle origin |
| Gateway stopping reply/quiescence | 10:45:36.003 | 62.672 s after disconnect |
| Console receives `stop` | 10:45:38.447163457 | 65.116 s after disconnect |
| Docker exits | 10:45:39.031504087 | Clean exit 0, no OOM |
| Stop job succeeds | 10:45:40.233 | Durable terminal completion |
| Gateway sleeping reply | 10:45:43.158 | 4.126 s after Docker exit |

Live channel evidence is now present: Core logged `keepalives=true`, then
`gateway_startup_channel_closed` with `reason=hint_sent` and elapsed31529ms;
Gateway logged exactly one `gateway.startup_hint` for the same operation and
subsequently the receipt forwarding transition. The channel survived the former
30-second inactivity failure. This proves actual event delivery alongside the
real protocol/Core confirmation; it is not merely a fixture or module-export test.
Polling remains available and the logs do not establish a latency percentile.

`Done`→forwarding was0.968s versus1.629s in the prior cycle. Remaining measured
Core process verification was489.490ms, commit29.378ms. The interval from hint to
observation start was251ms; no narrower attribution is claimed. Start dispatch
remains approximately1.9s to the completed provider response, plus approximately
0.975s before Docker starts. Sleep latency is a separate unchanged path: about
2.672s beyond the configured minute to quiescence, another2.444s to the stop
command, and4.126s after process exit to the sleeping response. The exact completed
sleep proof released its fence6.175s before the original deadline.

Both jobs succeeded. No429, listener closure, lease expiry, snapshot failure or
error-level event was captured. Three412 stale conflicts, two409 conflicts and
one409 uncertain-stop observation occurred around transitions;36 unavailable
observations are retained as diagnostics. Minecraft reported2.025s tick lag,
which is not attributed to Gateway without further evidence. Gateway remained
healthy at final inspection and the game container was stopped cleanly.

This session made no application-code changes, infrastructure changes, manual
server commands or test assets. No runtime restart or test-suite rerun was needed;
only documentation/governance checks apply to this evidence update. Raw private
logs stay untracked, no cleanup was performed. PR #21 stays open/unmerged;
SFTPGo #18 and production/M5 boundaries remain unchanged. Further sleep latency
work is not claimed complete by this startup result.


## 2026-10-11 — idle deadline and stop critical-path optimization

Source changes after `e69ff79`, limited to the existing stop/idle paths:

- A fresh Gateway observation is scheduled at authoritative `sleepEligibleAt`;
  it waits out pre-deadline work then re-probes. Due servers are checked first,
  with stable ordering for others. Same deadlines cannot spin; revocation,
  shutdown and provider cooldown retain authority over the timer.
- Unchanged online routes, like waking routes, may perform a fresh protocol
  sample within the **original** full-validation evidence lifetime. Full bind
  and renewal checks remain. Expiry or any route/proof change requires full
  validation; samples cannot extend a lease or evidence lifetime.
- Stop no longer fetches egg metadata. Wings executes its configured stop
  semantics; mapping validation remains unchanged. A signal that leaves the
  process running cannot pass ordered status + actual host exit confirmation.
- Observer preflight and confirmation WebSocket preparation overlap. Fresh
  provider identity and host/effect authorization overlap at final handoff.
  Every branch settles before power; current local authority/policy and the
  original quiescence fence are rechecked after slow proofs/durable writes.
- After persisted terminal evidence, lifecycle and runtime share this attempt's
  provider/host proof promises instead of fetching twice. Runtime still verifies
  the registry identity and actual stopped process. Missing shared host proof
  falls back to its own preflight. No capacity is released from an HTTP success
  or cached resources response.

Executed checks (isolated fixtures, no real server mutations):

- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/power.test.ts packages/pterodactyl-adapter/src/console.test.ts packages/gateway-safety/src/validator.test.ts apps/game-gateway/src/data-plane.test.ts`: **274 passed** on final unit-test source, including real local WebSocket fixtures, timer revocation, due-server priority, no premature power, failed preparation cleanup and original evidence expiry.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/lifecycle.integration.test.ts packages/server-management/src/gateway-orchestration.integration.test.ts packages/server-management/src/runtime.integration.test.ts`: **291 passed** before the final shared post-stop proof optimization.
- Same isolated integration command restricted to lifecycle/runtime with
  `--testNamePattern 'stop|stopped|host|observer'`: **51 passed, 158 deliberately skipped**, after the shared proof change. No full historical milestone matrix rerun.
- Initial typecheck caught an omitted optional callback-context signature in
  `LifecycleOptions`; corrected before delivery. This was a compile-time finding,
  not a passing result. Final typecheck and the final two shared-proof/fallback
  regression results are recorded below.

Independent read-only review found no remaining must-fix. Its optional observation
fairness concern was addressed by due-first ordering and a two-server regression.
These tests establish ordering and safety, **not a measured live latency gain**.
No early egg/WS preparation is claimed before the timeout; parallel preparation
still starts with the durable stop job. Post-exit Gateway snapshot reconciliation
remains, so event-driven/instantaneous sleeping replies are not claimed.

No manual power command, live provider mutation, container restart, infrastructure
change, new test asset or cleanup was performed. Integration tests used the already
approved isolated M2 services and temporary schemas. PR #21 remains open/unmerged;
SFTPGo #18 and all production boundaries remain unchanged. A new exact Gateway dev
restart approval and Owner-driven cycle are required to collect live timings.

Final checks after the optional shared-context/fallback refinement:

- `scripts/dev.sh pnpm exec tsc --noEmit`: **passed**.
- Isolated lifecycle/runtime integration selection
  `--testNamePattern 'completes an observed stop immediately|binds no-op stop proof'`:
  **2 passed, 207 deliberately skipped**. This verifies shared proof reuse,
  provider identity mismatch rejection and missing shared host-proof fallback.
- Scoped `scripts/dev.sh pnpm exec biome check` on all11 changed TypeScript files:
  **passed**; `git diff --check`: **passed**.
- `python3 scripts/check-governance.py`: **passed**,510 indexed text files,
  106 review PNGs,434 relative links,4 TOML files,44 ignore cases. Secret scanning
  remains heuristic; staged content was inspected before publication.
- Read-only Docker inspection: dev Gateway, API and worker all running/healthy.
  No container operation was performed. Gateway still needs the approved restart
  before its new timer/sampling code is active.


## 2026-10-11 — Owner cycle after `ec89809`: transient listener outage confirmed

Read-only capture after the explicitly approved Gateway-only restart; source and
branch remain `ec89809` during this test. No agent power commands or service
mutations occurred in this audit. Raw logs remain private and untracked.

| Event (UTC) | Time | Measured interval |
| --- | --- | --- |
| Intentional join | 11:10:13.620 | Start of wake |
| Start HTTP response complete | 11:10:15.463 | 1.843s after join |
| Docker process start | 11:10:16.482647 | 2.863s after join |
| Listener rejected: `observer_container_churn` | 11:10:16.653 | 170ms after Docker start |
| Waking listener restored | 11:10:20.594 | 3.941s listener gap |
| Minecraft `Done` | 11:10:50.942789 | Actual game log |
| Startup hint | 11:10:51.026 | 83ms after Done |
| Core online committed | 11:10:52.969 | 2.026s after Done |
| Gateway forwards | 11:10:53.381 | 2.438s after Done |
| Idle observation begins | 11:11:51.204 | Fresh sample |
| Gateway stopping/quiescence | 11:11:51.862 | 658ms after sample begins |
| Console receives stop | 11:11:53.592548 | 1.731s after quiescence |
| Docker exits | 11:11:54.049314 | 457ms after command |
| Durable stop succeeds | 11:11:54.992 | 943ms after exit |
| Gateway sleeping response | 11:11:59.784 | 5.735s after exit |

The brief reported “can't connect” is explained by the explicit listener closure,
not delayed start dispatch. `network-observer.ts` takes before/after Docker
inventories, retries one incoherent container sample, then throws
`container_churn`. `data-plane.ts` currently closes the existing listener for that
error. The capture proves this category, but not which container IDs changed;
Wings replacing the game container is consistent with timing, not independently
proven. No actual allocation/collision conflict was logged. No client packet
capture was taken. Existing test coverage explicitly expects withdrawal on churn;
this is a behavior/design problem, not an unexplained client-side error.

The first positive readiness observation started at11:10:51.201; adding60s gives
11:11:51.201, with the final idle sample starting3ms later. This deadline is derived
from captured observations, not an explicitly logged `sleepEligibleAt`. No player
join/disconnect appears in this cycle, so no disconnect-based idle latency is
claimed. Minecraft's own empty-for60s pause log was11:11:51.191663; stop followed
2.401s later, but that pause is not the authoritative NickHosting deadline.

Parallelism is visible: preflight86ms overlaps console preparation353ms; final
handoff242ms includes identity232ms overlapping host/authorization82ms. No egg
lookup stage occurs. Quiescence-to-stop improves from2.444s in the preceding cycle
to1.731s here. Post-exit response delay does **not** improve: snapshot fetch starts
11:11:58.682 after job success11:11:54.992, then validation/application ends59.784.
Startup readiness likewise takes2.438s this run versus0.968s previously; hint
transport remains83ms, with time spent in observation and snapshot coordination.

Both jobs were independently queried read-only and are `succeeded`; final game
state exited0, noOOM. Full capture includes103 unavailable observation warnings
(mostly the long offline period), one snapshot failure, two API412 conflicts and
one409; no429 or worker warnings/errors. Independent researcher reproduced the
outage and timings; its20 observation warnings count only the active-cycle window.

Required follow-up: distinguish transient container churn from a proven collision.
For an unchanged previously validated listener, retain local status only within
its original lease; no new bind, renewal or unproven backend forwarding. Expired
leases, identity/topology conflicts and actual collisions must still fail closed.
Add corresponding targeted regression coverage before activating that change.
Post-stop snapshot reconciliation remains a separate latency follow-up. This audit
does not claim either issue fixed; no source changes or test-suite reruns occurred.
PR #21 stays open/unmerged; no test assets created/cleaned and SFTPGo #18 unchanged.


## 2026-10-11 — Preserve status during churn and notify confirmed sleep immediately

This follows the preceding failed live cycle without replacing its evidence. The
reported 3.941s listener gap is addressed by retaining unchanged validated listeners
as local protocol responders on transient `container_churn`, within their original
lease. Wake effects, backend forwarding and readiness shortcuts are disabled during
that condition. Actual collisions, changed routes and expired authority still close
listeners. Concurrent route changes can therefore still require fail-closed renewal;
this is not a blanket availability guarantee during unknown topology.

Confirmed stop now immediately invokes the existing canonical Gateway reconciliation,
then delivers its committed proof through an authenticated bounded completion request.
There is no artificial post-stop timer or wait for the next worker/snapshot poll in
this fast path. It retains original lease/fence expiry, exact role/identity checks,
and durable recovery through ordinary reconciliation if the notification is lost.
No database migration, provider API endpoint, UI change or new infrastructure is needed.

Validation on the integrated source:

- `scripts/dev.sh pnpm exec vitest run apps/game-gateway/src/data-plane.test.ts apps/game-gateway/src/sleep-receipt.test.ts apps/game-gateway/src/control-client.test.ts apps/game-gateway/src/main.test.ts apps/api/src/gateway-sleep.test.ts packages/database/src/job-notifications.test.ts`: **218 passed** in six files.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/gateway-orchestration.integration.test.ts packages/server-management/src/lifecycle.integration.test.ts apps/api/src/gateway.integration.test.ts`: **274 passed** in three files, using already approved isolated PostgreSQL/Redis services, no container creation/restart.
- The real PostgreSQL tests cover immediate canonical sleeping state and completion proof after lifecycle success, notification commit/rollback behavior, schema isolation and independence from job notifications. Provider mutations use fixtures, not the Owner's game server.
- Unit regressions cover retained local TCP status, disabled forwarding/wake during churn, bounded retry, UDP session closure, lease expiry, changed/revoked routes, strict multi-role receipt proof, request abort, authentication recheck and subscription cleanup.
- `scripts/dev.sh pnpm exec tsc --noEmit`: passed. `scripts/dev.sh pnpm exec biome check` on all 16 changed TypeScript files: passed. `git diff --cached --check`: passed. `python3 scripts/check-governance.py`: passed (514 text files, 106 review PNGs, 435 relative links, four TOML files and 44 ignore cases; secret scanning is heuristic).

Independent review found a race where a completion receipt could overwrite a newer
candidate whose listener bind failed. The final code requires candidate and committed
revisions/routes to agree before applying a receipt; a failed-bind regression covers
this. The reviewer found no remaining must-fix after that correction, including lock
ordering, post-commit notification, auth revocation and bounded lease authority.

Gateway activation and new live timing evidence remain pending a separately approved
Gateway-only restart and an Owner-run cycle. The 5.735s historical exit-to-sleep result
above is not relabeled as improved. No real server commands, game assets, production
configuration or network changes were made. API/worker retain their existing source
watch behavior. PR #21 stays open/unmerged; issue #18 is unchanged. Rollback is a code
revert and separately approved Gateway restart; no state rollback or migration applies.


## 2026-10-11 — Owner cycle after `d22bc36`: sleep receipt observed live

Read-only log/state capture after the separately approved Gateway-only restart at
11:31:56.414717578 UTC. The unchanged startup lease drain completed and the sleeping
route returned at11:32:30.273. No agent game commands or infrastructure mutations
were performed during this audit; raw capture remains private and untracked.

| Event (UTC) | Time | Interval |
| --- | --- | --- |
| Intentional join | 11:34:59.307 | Wake begins |
| Start HTTP response complete | 11:35:01.139 | 1.832s after join |
| Docker process starts | 11:35:02.068692 | 2.762s after join |
| Minecraft Done | 11:35:33.946994 | Actual game log |
| Gateway startup hint | 11:35:33.973 | 26ms after Done |
| Positive observation starts | 11:35:36.238 | 2.265s after hint |
| Core online commit | 11:35:37.254 | 1.016s after observation starts |
| Gateway forwards (`readiness_receipt`) | 11:35:37.277 | 3.330s after Done |
| Final idle observation starts | 11:36:36.619 | Fresh sample |
| Quiescence/stopping response | 11:36:37.487 | 868ms after sample begins |
| Console receives stop | 11:36:39.040616 | 1.554s after quiescence |
| Docker process exits | 11:36:39.552579 | 512ms after command |
| Terminal confirmation | 11:36:40.049 | 496ms after process exit |
| Stop job returns succeeded | 11:36:40.496 | 943ms after process exit |
| Gateway sleeping (`sleep_completion_receipt`) | 11:36:40.877 | 1.324s after exit; 381ms after job return |

The new completion notification/receipt is directly observed, including release of
the original local fence. Exit-to-sleep decreased from5.735s in the preceding cycle
to1.324s (about77%). This is real confirmation/processing latency, not a configured
post-stop timer. Both start and stop deliveries log `succeeded`; final Docker state
is exited0/noOOM. Gateway authenticated readiness remains200, ready/control true,
one route. Independent read-only review reproduced the timing and receipt result.

No safety-failure, listener withdrawal, lease-expiration or container-churn event
appears in this capture. Therefore the previous interruption did not recur in the
server-side logs, but this run does not independently exercise the churn fallback
or establish uninterrupted client packet delivery. No client packet capture exists.

Readiness latency remains unresolved: Done-to-forwarding is3.330s versus2.438s in
the preceding cycle. Hint delivery is26ms; the positive sample begins2.265s later,
and Core verification takes about1s (943ms process verification). An unavailable
probe is logged at11:35:34.219 between hint and positive sample. The logs do not
identify that probe's precise failure or fully attribute the intervening delay.
No claim of improved readiness or a complete latency fix is made.

The first positive observation plus60s yields11:36:36.238; the idle sample begins
381ms later. This is derived from observations, not a captured authoritative deadline.
No player join/disconnect is logged, so this is not a disconnect-based idle benchmark.
Minecraft's own empty-for60s pause at11:36:34.181 is a different clock; the stop
command follows4.859s later. Existing unavailable observations remain (79 in the
full captured window), with one API409 during startup and one proof-read412 near
sleep completion. No429 or worker warnings/errors were captured.

No implementation changes or test-suite reruns in this audit. Only documentation
and PR evidence updated; governance/diff checks apply. No test assets created or
cleaned, no new restart performed, and SFTPGo #18 remains unchanged. PR #21 stays
open/unmerged. Follow-up should target hint-to-positive-observation latency, without
misrepresenting this successful sleep fast path as zero physical latency.


## 2026-10-11 — Sidebar stays within the desktop viewport

Desktop navigation now uses a sticky, viewport-height scrollport. Long content no
longer stretches the sidebar or pushes Administration to the bottom of the page.
Short windows scroll the navigation independently; children retain their natural
height and keyboard focus scrolls links into view. Mobile keeps its existing menu
disclosure. No routes, APIs, copy, permissions or infrastructure settings changed.

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/sidebar.browser.test.ts`: **3 passed**, real Chromium with the existing isolated database and simulated provider. Disposable fixtures cleaned.
- Covers long-page Administration access, 420px desktop height with independent wheel/Tab navigation, and 390px Italian mobile disclosure/navigation. Axe WCAG A/AA tags found no violations in the tested states; no horizontal overflow or browser errors.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed.
- Biome checks of the changed CSS and new browser test: no errors; CSS retains three existing reduced-motion `!important` warnings.
- Initial exploratory run used the system Node and failed one overly strict viewport assertion at a fractional 0.9953 intersection ratio. Final run used the pinned runtime via `scripts/dev.sh` and a 0.99 tolerance; no product code was changed to mask that assertion.
- Independent browser/accessibility review and coordinator visual inspection found no blocking issue. These focused checks do not claim a full WCAG audit. No historical full-suite rerun was needed for this CSS change.

Reviewed viewport screenshots (only isolated fixture identities):
[scrolled desktop](screenshots/m5/sidebar-scrolled-desktop-en.png),
[short desktop with keyboard focus](screenshots/m5/sidebar-short-desktop-en.png),
[Italian mobile menu](screenshots/m5/sidebar-open-mobile-it.png).

The existing Vite source mount/HMR delivers the CSS change without service restarts.
No production/game operations or new infrastructure; no live test assets created.
Rollback is the CSS revert. PR #21 remains open/unmerged; M6 and SFTPGo #18 unchanged.


## 2026-10-11 — Console entry and controls; Status last

The server root now replaces its history entry with Console. Status (literal label
in EN/IT) moves after integration sections, including Minecraft Content, and is
informational at `/servers/:id/status`. Start/Stop/Restart, restart confirmation,
job feedback, active-operation and first-start-denied notices move to Console.
The existing operation hook is reused; admission, permissions and intent keys are
unchanged. Operators without console capability retain power controls without a
stream; viewers with neither capability nor operate permission fall back to Status.
Creation success links say Open server; direct-connection help points to Console.

Validation:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/server-navigation.browser.test.ts`: **5 passed**, covering default/trailing-slash URLs and history, order, keyboard access, real isolated lifecycle handlers, admission failure, restart confirmation, viewer permissions and capability fallback.
- After mobile header layout refinement, the same command with `-t 'renders Console and Status'`: **1 passed / 4 skipped**, recreating EN/IT desktop/mobile screenshots and accessibility evidence. No horizontal overflow or browser errors; Axe reports no violations for the tested states.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/platform.browser.test.ts apps/web/tests/services.browser.test.ts -t 'rejects insufficient physical capacity|console'`: **13 passed / 10 skipped / 1 failed** initially. The expression also matched the services suite title, so all its services cases ran. Failure was a stale network expectation: fixture commit `277be4e` already configures a direct endpoint; the test still expected Not configured. Independent review confirmed the unchanged fixture/API/Network behavior. The test now verifies the explicit fixture hostname, Configured and unverified-external-reachability notice, preserving exclusion of the unrelated static hostname.
- Targeted rerun of `apps/web/tests/services.browser.test.ts -t 'persists schedules and explicit automation consent'` with the same runner: **1 passed / 12 skipped**. No full historical suite rerun.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, `scripts/dev.sh pnpm i18n:check`, and `scripts/dev.sh pnpm build`: passed. Build retains its >500kB bundle warning; scoped Biome has no errors, with nine existing non-null/reduced-motion warnings. Initial typecheck caught an unexported reused hook; export corrected before final checks.

Independent review found no permission/idempotency or route blocker. Browser review
found clipped keyboard focus on the final tab and crowded mobile Console controls;
focus now reveals the anchor, and the mobile header stacks above full-width actions.
Initial test assumptions about disabled offline Stop and no-console operator fallback
were corrected against API availableActions and the intended lifecycle-only Console.

Reviewed screenshots: [Console desktop EN](screenshots/m5/server-navigation-console-desktop-en.png),
[Console mobile IT](screenshots/m5/server-navigation-console-mobile-it.png),
[Status desktop EN](screenshots/m5/server-navigation-status-desktop-en.png),
[Status mobile IT](screenshots/m5/server-navigation-status-mobile-it.png),
[Console desktop IT](screenshots/m5/server-navigation-console-desktop-it.png),
[Console mobile EN](screenshots/m5/server-navigation-console-mobile-en.png),
[Status desktop IT](screenshots/m5/server-navigation-status-desktop-it.png),
[Status mobile EN](screenshots/m5/server-navigation-status-mobile-en.png).

All browser operations use disposable isolated schemas and provider fixtures, cleaned
afterward. No live game commands, service restart, new infrastructure or provider
changes. Existing Vite HMR serves the update. Rollback: revert UI/catalog changes;
no migrations. PR #21 remains open/unmerged; SFTPGo #18 unchanged.


## 2026-10-11 — Compact console connection indicator

Connected text and Reconnect button are replaced by one 12px state dot on a 40px
clickable target: green connected, yellow connecting, red disconnected. Clicking
or keyboard activation uses the same stream reconnection path. Localized tooltip,
accessible action name, focus outline and screen-reader status remain. The retained
output paragraph and its display-only state/catalog key are removed; buffer history,
identity isolation and retry behavior are unchanged. No power effect is introduced.

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/services.browser.test.ts -t 'shows mediated console output|exposes connection indicator states|records status transitions once|reconnects a failed console stream'`: **4 passed / 10 skipped**. Checks all three states/computed colors, EN/IT tooltip/name, click/Enter/Space reconnect, zero power POSTs, retained output and authorization-denial clearing. Two initial attempts failed only the new test's assumption about one initial stream attach; fixture gating was corrected for development React duplicate attach/abort behavior before the passing run.
- Web typecheck, i18n check (1090 keys), scoped Biome and diff checks pass. Seven pre-existing non-null/reduced-motion lint warnings remain across checked files. No full test matrix or production rebuild needed for this presentation change.
- Independent browser/UX review and coordinator inspection of [desktop EN](screenshots/m5/console-indicator-desktop-en.png) and [mobile IT](screenshots/m5/console-indicator-mobile-it.png): controls fit, no horizontal overflow, keyboard focus visible, removed paragraph absent. Axe WCAG A/AA tags found no violations in tested states; not a full accessibility certification.

Only isolated fixture services used, cleaned afterward. No real game/provider commands,
new infrastructure or service restarts. Existing HMR delivers the UI/catalog change.
Rollback is a source revert; PR #21 remains open/unmerged and issue #18 unchanged.


## 2026-10-11 — Smaller connection-dot hover

Reduced the hover halo from the entire40px button to a5px solid shadow around the
12px dot (22px overall). The40px hit target, state colors and keyboard focus remain.
A focused Chromium capture of the actual app with disposable isolated fixtures
confirmed40×40px target, transparent button background and5px shadow; screenshot
[desktop hover](screenshots/m5/console-indicator-hover-desktop-en.png) inspected.
Independent CSS review found no issue. Scoped Biome/diff/governance checks pass
with existing reduced-motion warnings; no broad tests or rebuild needed. No live
operations, new infrastructure or service restart. Fixtures cleaned; PR #21 open.

## 2026-10-11 — Integrated terminal prompt and automatic output following

Console output follows while at the bottom, pauses when scrolled upward, and
resumes when returning to the bottom. Removed the follow checkbox and external
command form. An integrated `>>` prompt has a localized, subdued placeholder and
accessible name; Enter submits through the existing API. Pending submissions are
guarded, successful commands clear the draft, and failures retain draft/focus
with an announced error. Manage permission and authenticated scope still gate
the prompt. The existing bounded buffer, reconnect and authorization handling remain.

Validation:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/services.browser.test.ts -t 'shows mediated console output|submits the integrated terminal prompt|follows terminal output only|hides the terminal command prompt|keeps the terminal prompt accessible|records status transitions once|reconnects a failed console stream|erases console buffers'`: initially **5 passed / 3 failed / 10 skipped**. New tests assumed a Unicode ellipsis instead of the agreed ASCII placeholder and one fixture relay rather than React development duplicate attaches. These test assumptions were corrected without changing product behavior.
- Same runner with `-t 'submits the integrated terminal prompt|follows terminal output only|keeps the terminal prompt accessible'`: **3 passed / 15 skipped**. All eight selected cases pass across the two runs. Checks include real isolated command handlers, provider failure/retry, duplicate and empty submission, retained focus, Ctrl+Home/End pause/resume, Tab/Shift+Tab, manage gating, reconnect/status and identity-buffer regression coverage.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, `scripts/dev.sh pnpm i18n:check` (1090 keys), scoped Biome and diff checks pass. Seven pre-existing non-null/reduced-motion warnings remain. No full historical matrix or production rebuild was run for this scoped UI change.
- Real Chromium [desktop EN](screenshots/m5/terminal-desktop-en.png) and [mobile IT](screenshots/m5/terminal-mobile-it.png) screenshots reviewed by browser worker and coordinator. No page overflow; integrated prompt, localized placeholder and focus are visible. Axe reported zero violations in tested states; physical mobile keyboard/IME behavior was not independently certified.
- Independent source review found no must-fix issue in submission, identity isolation, authorization or scrolling. Independent browser/UX review found no blocker.

Existing isolated test services and disposable fixture schema only; harness cleanup
completed. No real provider commands, game assets, new infrastructure or service
restarts. Existing Vite HMR delivers the changes. Rollback: revert UI/catalog/test
changes; no migrations. PR #21 remains open/unmerged; issue #18 unchanged.

## 2026-10-11 — Terminal prompt glyph and unobtrusive focus

Replaced `>>` with `»`. The command input no longer draws a focus rectangle;
focus instead underlines the adjacent prompt symbol, retaining a non-color cue.
The existing terminal browser case was rerun with
`scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/services.browser.test.ts -t 'keeps the terminal prompt accessible'`:
**1 passed / 17 skipped**, including Enter/focus, EN desktop/IT mobile, no overflow
and Axe checks. Updated terminal screenshots above were inspected; no rectangle,
prompt underline visible. Forced-colors mode was not separately tested. Scoped
Biome passes with seven existing warnings. Independent source review found no
must-fix issue. No full suite, production operations or restarts; isolated harness
cleanup completed. Rollback is a source revert; PR #21 remains open/unmerged.

## 2026-10-11 — Compact resource graphs

Removed the network-counter explanatory paragraph, measurement table and
Older/Latest measurement buttons, including unused cursor state and four catalog
keys. Charts, period selection, bounded history fetches, live polling, freshness
and failure states remain. Backend history pagination is unchanged.

- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed.
- `scripts/dev.sh pnpm exec biome check --write apps/web/src/features/console.tsx packages/i18n/src/services-web.ts`: passed, no warnings.
- `scripts/dev.sh pnpm i18n:compile`: 1086 EN/IT/pseudolocale keys compiled.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/services.browser.test.ts -t 'keeps the terminal prompt accessible'`: **1 passed / 17 skipped**, including four charts, EN desktop/IT mobile, Axe and overflow checks. Updated terminal screenshots linked above inspected: requested footer/table/controls absent. No full suite rerun.

Independent review found no must-fix findings. Existing 100-sample history bound
remains; this is not a new historical aggregation feature. Isolated fixtures
cleaned normally; no production interactions, new assets or service restarts.
Rollback is a source revert. PR #21 remains open/unmerged; issue #18 unchanged.
