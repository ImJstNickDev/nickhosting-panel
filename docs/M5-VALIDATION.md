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
