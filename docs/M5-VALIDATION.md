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

## 2026-10-11 — Combined network chart and shared custom tooltips

Received/sent totals now share a time range and vertical scale in one network
chart, alongside memory/CPU. Inbound uses blue and outbound amber solid lines; blue is drawn above amber
when values coincide, as requested in the final Owner refinement; matching download/upload icon buttons at the top right expose
localized direction and current MiB totals. Counter semantics and API polling
remain unchanged; these are not bandwidth rates. Missing-data segments remain
separate for each series.

A shared wrapper-free Tooltip provides fixed, viewport-constrained dark popups,
hover persistence, keyboard focus, Escape, touch toggle/outside dismissal and
scroll/resize handling. It also replaces the console connection dot's native
title. Identical timestamp titles were removed rather than adding redundant
focus stops. No new dependency. Native-dialog top-layer use remains a documented
constraint for future consumers; current consumers are outside dialogs.

Reference: reviewed upstream Pterodactyl's
[server details icons](https://github.com/pterodactyl/panel/blob/develop/resources/scripts/components/server/console/ServerDetailsBlock.tsx)
and [custom tooltip](https://github.com/pterodactyl/panel/blob/develop/resources/scripts/components/elements/tooltip/Tooltip.tsx)
for interaction behavior. Independent implementation; no Pterodactyl or Blueprint
code copied and no production installation changes.

Independent source review found and resolved Escape dismissal persisting into a
later keyboard interaction, including when Escape was pressed over the popup.
Final source review reports no remaining must-fix finding.

Validation (only affected checks):

- Browser command prefix: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/services.browser.test.ts -t`.
- Filter `'shares network chart scales|exposes connection indicator states|shows mediated console output|retries transient telemetry'`: **2 passed / 2 failed / 15 skipped**. New assertions incorrectly assumed a seeded sample's array offset despite additional existing fixture metrics, and hover reopening during the same focused Escape-dismissed interaction. Corrected those assertions to compare equal values and respect dismissal persistence.
- Filter `'shares network chart scales|exposes connection indicator states|opens network tooltips by touch'`: **3 passed / 17 skipped**. Covers shared scales/line styles, current values, EN/IT labels, hover onto popup, Escape and subsequent focus, dynamic connection status, touch tap/toggle/outside dismissal, scroll/resize positioning, no overflow and Axe.
- Final filter `'shares network chart scales'`: **1 passed / 19 skipped** after changing mobile capture to the actual viewport. Full-page capture of a scrolled mobile page included the existing offscreen skip link as a screenshot artifact; actual viewport capture avoids misrepresenting the rendered view.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, `scripts/dev.sh pnpm i18n:check` (1087 keys), scoped Biome and diff checks pass. Six existing reduced-motion/non-null warnings remain. An initial direct pnpm browser invocation was blocked by the shell's Node20 engine check before tests; all executed browser runs used the approved Node24 dev wrapper. No historical full-suite rerun.

Reviewed screenshots: [network desktop EN](screenshots/m5/network-chart-desktop-en.png),
[network mobile IT](screenshots/m5/network-chart-mobile-it.png), plus refreshed
connection-indicator EN/IT screenshots linked above. Independent browser/UX review
found no remaining blocker; coordinator inspected network layouts and tooltip.
Axe found no violations in tested states; not a full accessibility certification.

Disposable database/provider/browser fixtures only, cleaned after checks. No game
server commands, new infrastructure, provider changes or container restarts. Vite
HMR delivers the update. Rollback is a source revert; no migrations. PR #21 remains
open/unmerged, and SFTPGo #18 remains a separate release blocker.

Final Owner refinement before commit: both network strokes are solid, with blue
inbound painted after amber outbound so coincident/zero values show blue.
The same network-only browser command passed again (**1 passed / 19 skipped**),
now asserting paint order and solid strokes; EN/IT screenshots regenerated and
mobile inspected. Independent review confirmed legend order/data remain unchanged.

## 2026-10-11 — Fixed last-hour view and aligned chart headers

Removed Period/selector, its state and unused labels; metrics requests keep a
rolling one-hour `from` bound with the existing 100-sample limit. Network legend
buttons made that caption 32px high while text-only memory/CPU captions were
shorter, shifting the network title/SVG/unit/time labels downward. All chart
captions now share a 32px minimum height.

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/services.browser.test.ts -t 'shares network chart scales'`: **1 passed / 19 skipped**; now checks no selector and equal desktop heading, SVG, axis-unit and time-label Y coordinates. EN/IT screenshots regenerated and desktop inspected; existing tooltip/Axe/mobile checks pass.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, scoped Biome, `scripts/dev.sh pnpm i18n:check` (1085 keys), diff/governance checks pass. Existing lint warnings only.
- `scripts/dev.sh pnpm exec vitest run apps/web/src/app/i18n.test.ts`: initially **3 passed / 1 failed** on a pre-existing generic Owner-label assumption for dedicated sleep controls. Independent review confirmed those fields already use `sleepTiming.*` labels. The assertion now checks their actual dedicated labels, retaining coverage; plural coverage uses an existing Owner reconciliation message after removing the unused hours message. Targeted plural run passed, then the corrected complete file passed **4/4**. No unrelated product changes or broad suite rerun.

Independent review found no remaining must-fix. No production interactions,
container restarts or new infrastructure. Isolated fixtures cleaned normally;
Vite HMR delivers the update. Rollback: source revert; PR #21 stays open/unmerged.

## 2026-10-11 — Taller terminal and no standalone measurement timestamp

Console output now uses `height: clamp(360px, 55svh, 680px)` instead of growing
between 280–480px with content. It keeps internal scrolling and a separate command
prompt. Removed the standalone date/time below resource charts at the Owner's
follow-up request; chart axis times and first-start-denial timestamps remain.

`scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/services.browser.test.ts -t 'keeps the terminal prompt accessible'`
passed **1 / 19 skipped** after the height change, then **1 / 19 skipped** after
the requested timestamp removal. EN desktop/IT mobile screenshots refreshed and
inspected; Enter/focus, no overflow and Axe checks pass. Scoped Biome/diff/governance
pass with existing CSS warnings only. No broad suite or production rebuild.
Independent review found no blocker. No production changes, new infrastructure
or restarts; disposable fixtures cleaned. Existing HMR delivers changes. Rollback:
source revert; PR #21 remains open/unmerged.

## 2026-10-11 — Console resource sidebar without outer card

Removed the Console section wrapper/visible title (retaining an accessible
heading). Desktop places the raw terminal beside Address, Uptime, CPU Load,
Memory, Disk, Network (Inbound) and Network (Outbound) cards. Start/Restart/Stop
sit above the card column; the Address card aligns with the terminal top. Narrow
screens put controls above the terminal and cards below. Command focus/scroll,
connection indicator, charts and existing lifecycle handlers remain.

Cards and charts consume one shared resource query. Uptime uses provider
milliseconds (no invented duration when absent); only confirmed offline gets the
red clock background. Errors and a 30-second freshness deadline show unavailable,
including when a refresh hangs. Address uses the authorized primary public
endpoint; auxiliary ports cannot substitute for an unconfigured primary. No new
backend API, provider mutation or infrastructure configuration.

Validation:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/console-sidebar.browser.test.ts`: final **4/4 passed**. Initial four cases and one diagnostic rerun failed Axe because the new stylesheet established its CSS layer before the main ordering declaration; the canonical layer preamble fixes input, indicator and legend styles. Final checks cover desktop alignment, control order, actual isolated API requests, one resource request shared by cards/graphs, units, offline state, primary/unconfigured address variants, unavailable readings and pending-refresh expiry after 31 seconds, viewer controls, EN/IT mobile layout and Axe.
- Same runner for `apps/web/tests/server-navigation.browser.test.ts -t 'keeps lifecycle admission|without console|permissions'`: **1 passed / 4 skipped**, covering admission refusal, job feedback and restart confirmation. Follow-up exact filter `'preserves operator power controls'`: **1 passed / 4 skipped**, covering no-console operator and viewer fallback.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, `scripts/dev.sh pnpm i18n:check` (1093 keys), scoped Biome/diff/governance checks pass. Initial typecheck caught an optional fixture-array spread in the new test; corrected to guarded primary data. Three existing reduced-motion CSS warnings remain. No historical full-suite run.

Independent source review resolved primary-endpoint selection, stale expiration
without an intervening render, and CSS-layer ordering. Final review reports no
must-fix findings. Independent browser/UX review and coordinator screenshot
inspection confirmed the final layout and restored terminal appearance. Four
Axe scans have no violations; this is not full accessibility certification.

Screenshots: [offline desktop EN](screenshots/m5/console-sidebar-offline-desktop-en.png),
[running desktop EN](screenshots/m5/console-sidebar-running-desktop-en.png),
[unavailable desktop EN](screenshots/m5/console-sidebar-unavailable-desktop-en.png),
[running mobile IT](screenshots/m5/console-sidebar-running-mobile-it.png).

Browser tests use real isolated app handlers with fixture provider readings and
disposable schemas; cleanup completed. No live servers, new infrastructure or
container restarts. Existing HMR delivers the changes. Rollback: source revert;
no migrations. PR #21 remains open/unmerged; SFTPGo #18 unchanged.

### 2026-10-11 — Align console columns and move server heading

The resource column now shares the terminal's top and bottom edges on desktop.
The server name moves below the tabs into the power-control row, aligned with the
terminal's left edge. Other server pages keep their existing heading. The
reconnect indicator is inside the terminal's upper-right corner, with output
padding preventing overlap; narrow screens retain name, controls, terminal, cards
in that order. No provider, permission or stream contracts changed.

Validation on this follow-up:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/console-sidebar.browser.test.ts`: **4/4 passed**, including top/bottom alignment within 1px, heading alignment and uniqueness, indicator containment, existing telemetry/permissions checks and four Axe scans.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: **passed**.
- Scoped `pnpm exec biome check` and `git diff --check`: **passed**, with four existing warnings (three reduced-motion declarations and the server navigation's non-null assertion).
- The four console-sidebar screenshots linked above were refreshed and visually reviewed on desktop EN/mobile IT. Fixtures and disposable test schema were cleaned by the existing harness; no new infrastructure, provider mutations or container restarts occurred.

Independent review found that moving the connection button onto a dark background
reduced disconnected-dot and keyboard-focus contrast. Both colors were corrected
with terminal-scoped styles; this was a color-only correction after the browser
suite, not another full-suite run. All other established telemetry and lifecycle
behavior is preserved. Rollback is a source revert; no migration is required.
Final independent review confirmed contrast ratios of 5.28:1 for the disconnected
dot and 10.38:1 for its focus ring against the terminal, reviewed the updated
screenshots and found no remaining must-fix findings. Indexed governance passed.

### 2026-10-11 — Server name only on Console

Removed the shared server-name heading from other server tabs; their own section
titles remain. Console keeps its name beside the power controls. Independent
review identified the removed Page heading's navigation-focus role: the active
server tab now receives focus when the route has no main h1, preserving Console
and Activity heading behavior.

Web typecheck, scoped Biome (one pre-existing non-null assertion warning) and diff
checks passed. A temporary one-case real browser check verified Console retains
its name, Connection omits it and keeps its actual content; Axe found no violations.
The check used the existing isolated fixture harness, not a production server.
[Connection screenshot](screenshots/m5/server-network-without-name-desktop-en.png).
No backend changes, container restarts or production interactions. Rollback:
revert the source change. No historical full-suite rerun was needed.
Final focused browser check also passed active-tab focus after direct reload
(1/1); the temporary test was removed and disposable fixtures cleaned.

### 2026-10-11 — Compact resource-chart headers and CPU-first order

Removed duplicate current values beside Memory/CPU chart titles; the resource
cards remain authoritative for the visible live totals. Chart scales, times,
accessible summaries and the network legend remain unchanged. The Owner then
requested CPU before Memory: the chart order is now CPU, Memory, Network.

Web typecheck and scoped Biome passed for the header change; scoped Biome passed
again after the JSX-only reorder. Independent review found no issues in the
header removal. An isolated one-off browser check passed (1/1, Axe zero), proving
sidebar values remain while chart headers omit duplicate values and network
legend controls remain. No full historical suite was run; no production
interactions or container restarts. Rollback is a source revert.
A final narrow browser capture after the reorder passed (1/1), confirmed CPU →
Memory → Network and refreshed/reviewed the existing running-desktop screenshot.
Temporary checks were removed; disposable fixtures were cleaned.

### 2026-10-11 — Offline Stop and confirmed Kill escalation

Console disables Stop when offline and changes it to Kill during a current
stopping observation. EN/IT confirmation states the risk of unsaved/corrupted
data. The dialog targets the exact active stop job and closes on changed process
state or operation. Status transitions refresh the shared server descriptor;
repeated identical snapshots do not create repeated descriptor requests.

Verified the official Panel v1.11.11 power controller/request/UI and Wings
v1.11.13 power route. The existing adapter sends native Client API
`POST /api/client/servers/{identifier}/power` with `{signal:"kill"}`; the
permission is `control.stop`. Wings accepts the request asynchronously. Research
references are recorded in ADR 0011's amendment; no upstream code was copied.

The implementation uses a private durable escalation receipt on the original
stop job, rather than a second job blocked behind its server lock. Acceptance
atomically withdraws wake consent. The worker rechecks requester/session,
identity, stopping state and the original physical process epoch, and never
replays prepared/unknown effects. A definitively rejected pre-effect receipt
allows a new explicit request while retaining old-key replay protection. No
reservation is released from an HTTP acknowledgement alone. Legacy stop jobs
without a recorded process epoch, and stops initiated only outside NickHosting,
are not eligible for this escalation. No database migration is needed.

Executed checks (targeted to the changed paths):

- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/power.test.ts`: **40/40 passed**, including serialized cooperative callbacks, unknown/rejected stop responses, timeout/closure cleanup and final stream invalidation guards.
- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/adapter.test.ts -t 'sends native kill'`: **1 passed, 48 skipped**; exact URL, Client credential boundary, method and native signal verified with an isolated transport fixture.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/stop-escalation.integration.test.ts packages/server-management/src/lifecycle.integration.test.ts`: **177/177 passed** (167 lifecycle + the initial 10 escalation cases).
- The same integration command with only `packages/server-management/src/stop-escalation.integration.test.ts` on the final expanded implementation: **12/12 passed**. Covers concurrent/repeated requests, confirmation/target/session checks, revoked authority, rejected-request retry, durable consent, process-change races including cached resource responses, crash/nonreplay recovery and physical proof before release.
- The integration runner with `packages/server-management/src/platform-queries.integration.test.ts apps/api/src/servers.integration.test.ts -t 'derives viewer|creates durable operations|isolates unrelated|current project viewer|current role changes|remote identity drift|scopes Activity|support discovery|safe history'`: **8 passed, 46 skipped**.
- The integration runner with `packages/server-management/src/platform-queries.integration.test.ts -t 'offers stop only online'`: **1 passed, 22 skipped**; Stop/Kill eligibility and private receipt exclusion verified.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/console-power.browser.test.ts`: three independent cases verified across initial/targeted reruns. Initial fixture provisioning encountered `resources_unavailable`; a fixture job replacement also lacked its required completion timestamp. The test fixture was corrected and the two affected cases passed; the viewer/403 case had already passed. The final baseline-aware HTTP acceptance case was rerun with `-t 'disables offline'`: **1 passed, 2 skipped**. No real provider commands were sent.
- The browser runner with `apps/web/tests/server-navigation.browser.test.ts -t 'keeps lifecycle admission'`: **1 passed, 4 skipped**. Three outdated heading expectations were corrected to the existing server-name Console heading.
- `scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm i18n:check` (**1097 keys**), scoped Biome and diff checks: **passed**. No historical full-suite rerun.

Independent review found and resolved final state/process handoff races, consent
withdrawal on crash/graceful completion, retry after definite pre-effect rejection,
and authorization ordering. Final review reports no remaining must-fix findings.
Three browser Axe scans passed; desktop EN/mobile IT screenshots were reviewed:

- [Stopping control](screenshots/m5/console-power-stopping-desktop-en.png)
- [Force-stop confirmation, desktop EN](screenshots/m5/console-power-confirmation-desktop-en.png)
- [Force-stop confirmation, mobile IT](screenshots/m5/console-power-confirmation-mobile-it.png)

Evidence boundary: real application/auth handlers and PostgreSQL with isolated
provider/socket/host fixtures. Existing approved test services were reused and
disposable schemas/fixtures cleaned. No live server Kill/Stop, infrastructure
mutation, container restart, production credential access or schema migration.
SFTPGo #18 remains unchanged. Rollback is a source revert; never clear a live
uncertain stop or its reservation as part of rollback. PR #21 remains open/unmerged.
Final indexed governance passed: 524 text files, 132 screenshots, 461 relative
links, four TOML files and 44 ignore cases (heuristic secret scan).

### 2026-10-11 — Console output stays inside its viewport

Reproduced with 280 streamed lines and one 8,000-character unbroken line: before
this correction the terminal grew from 605 to approximately 4,928 pixels on
desktop and from 519 to approximately 4,928 pixels on mobile. Both new regression
cases failed before the fix. The content-dependent percentage flex basis allowed
the output to enlarge its ancestors instead of scrolling.

The output now uses an explicit zero-length flex basis, with shrinkable terminal
ancestors. Existing responsive minimum height and desktop sidebar alignment are
preserved. Appended lines do not resize the terminal or document; long lines
scroll horizontally inside the output pane.

Validation:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/console-overflow.browser.test.ts`: **2/2 passed** (18.19 seconds), desktop 1440×1000 and mobile 390×844. Terminal/output/document heights remain within one pixel of their initial values; both overflow axes stay internal. Automatic following, keyboard pause/resume, command draft/focus and desktop sidebar alignment pass. Both Axe scans report zero violations.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: **passed**, including browser test types.
- Scoped Biome: **passed**, with only the three existing reduced-motion `!important` warnings in the stylesheet. Independent source review found no issues.

Reviewed actual browser screenshots:

- [Desktop console overflow](screenshots/m5/console-overflow-desktop.png)
- [Mobile console overflow](screenshots/m5/console-overflow-mobile.png)

Tests used real application/auth handlers with isolated provider streams and the
existing approved test services. Disposable fixtures were cleaned. No production
interactions, container restarts or infrastructure changes. No historical full
suite was rerun for this CSS correction. Rollback is a source revert. SFTPGo #18
and the open/unmerged status of PR #21 are unchanged.

### 2026-10-11 — Console word wrapping

Follow-up to the viewport correction: horizontal scrolling is replaced by word
wrapping, including unbroken tokens. The nested `pre` now explicitly uses
`white-space: pre-wrap` and `overflow-wrap: anywhere`; explicit log newlines and
spacing remain intact. The prior horizontal-scroll evidence above records the
previous behavior, superseded by this requirement.

Re-ran only `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/console-overflow.browser.test.ts`:
**2/2 passed** (17.48s). Desktop/mobile now assert `scrollWidth <= clientWidth`
with the 8,000-character token, while retaining stable geometry, vertical scroll,
keyboard/focus, follow/pause and Axe checks. Existing screenshots above refreshed;
mobile wrapping visually inspected. Scoped Biome passed with the same three
pre-existing warnings; independent review found no issues. No production or
infrastructure changes, no restart. Isolated fixtures cleaned. Rollback: revert
this scoped CSS/test change.

### 2026-10-11 — Remove generic operation banners

Removed the shared “Operation requested / View operation” notice from Console,
server settings, creation, backups, game forms and Activity retry. Removed the
generic in-progress warning from Console and game forms. Activity retry retains
a plain link to the new operation. Actual errors, uncertain outcomes, destructive
confirmation, job polling, idempotency and disabled-action guards remain intact;
only notice-only state was deleted. Independent review found no must-fix issues.

Checks:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/console-power.browser.test.ts apps/web/tests/server-navigation.browser.test.ts apps/web/tests/services.browser.test.ts -t 'disables offline|keeps lifecycle admission|creates a durable backup'`: **3 passed, 25 intentionally skipped** (42.94s). Real handlers with isolated fixtures verify capacity errors, start/stop and confirmed Kill, restart confirmation, durable backup/restore, and absence of the removed notices.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: **passed**.
- Scoped Biome passed after formatting the edited test; three existing non-null-assertion warnings remain in services.browser.test.ts. No full historical suite rerun. The creation test expectation was updated and typechecked, not rerun in this narrow pass.

[Stopping Console](screenshots/m5/console-power-stopping-desktop-en.png) and
[Kill confirmation](screenshots/m5/console-power-confirmation-desktop-en.png)
were refreshed by the passing browser test; stopping layout visually reviewed.
Browser Axe checks passed. Existing approved isolated services were reused,
disposable fixtures cleaned. No production interactions, real server commands,
container restarts or configuration changes. Rollback is a source revert.
SFTPGo #18 remains unchanged; PR #21 stays open and unmerged.

### 2026-10-11 — Live resources, running uptime and 30-second charts

The browser previously ignored existing console SSE `stats` events and polled
REST resources every ten seconds. It now validates and shares stream CPU, memory,
network, uptime and disk between cards and charts. Healthy statistics pause that
REST polling; missing/stale streams retain the ten-second fallback. No new
provider endpoint, per-second HTTP polling or disk scan was introduced.

Upstream [Wings v1.11.13 resources](https://github.com/pterodactyl/wings/blob/v1.11.13/server/resources.go)
uses `Filesystem().CachedUsage()` in `Proc()`; disk already accompanies its
statistics stream. The [Docker statistics reader](https://github.com/pterodactyl/wings/blob/v1.11.13/environment/docker/stats.go)
provides the live process measurements. Runtime cadence remains provider-driven;
NickHosting displays received samples immediately rather than inventing values.
Uptime advances locally each second from a fresh running-process measurement,
including seconds after the first hour. Missing optional fields stay unavailable.

Charts retain at most 31 second buckets in a sliding 30-second window. Only actual
observations enter the buffer; missing/nonfinite values and delivery gaps split
traces. Visible start/end time labels are removed. Confirmed offline state clears
previous live traces immediately and displays a zero baseline without persisting
fake samples. CPU, memory and network cards show localized muted Offline; disk
keeps its independently fresh occupied-space reading. Restart does not resurrect
the preceding process's trace.

Independent review identified and resolved two freshness problems: cached REST
responses must not override connected-stream power state or restore old-process
uptime after a transition; status-only data must not hide measurement errors.
Final source review found no must-fix issues. The stream retains existing session
and managed-server authorization; no lifecycle/admission or provider logic changed.

Validation (targeted, not a full historical suite):

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/console-resources.test.ts`: **5/5 passed**, validated counters/optional fields and bounded real-sample window.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/console-live-stats.browser.test.ts apps/web/tests/console-sidebar.browser.test.ts`: **6/6 passed** (71.98s) for initial streaming/sidebar behavior. First attempt had three fixture expectation failures: offline SSE contradicted a mocked running REST snapshot, and expected Starting lacked its existing ellipsis. Fixtures/expectations corrected; failed attempts are not counted as passes.
- After the requested 30-second/offline/label changes, the same browser runner with only `apps/web/tests/console-live-stats.browser.test.ts`: **3/3 passed** (26.00s). Covers live CPU/RAM/network/cached disk, ticking uptime without per-second REST, missing counters, stale cached REST after offline, new-process uptime reset, immediate offline cards/flat graphs, missing axis labels, silent-stream expiry and visible fallback errors. Axe passed; mobile overflow check passed.
- Web source/test typecheck and scoped Biome passed. No API, worker or full integration-suite rerun was needed for frontend-only changes.

Sanitized actual browser captures:

- [Live measurements](screenshots/m5/console-live-stats-desktop-en.png)
- [Offline desktop](screenshots/m5/console-live-stats-offline-en.png)
- [Offline mobile](screenshots/m5/console-live-stats-offline-mobile-en.png)

Offline desktop/mobile rendering reviewed. Tests used real application/auth/API
handlers with isolated provider events and disposable schemas, cleaned afterwards.
No real server mutations, provider credentials, container restarts, infrastructure
changes or production interactions. No live game test was repeated. Rollback is
a source revert. SFTPGo #18 remains an independent release gate; PR #21 stays open.

### 2026-10-11 — Synchronize graph movement with samples

The previous render advanced the chart domain on the one-second uptime clock,
while an effect retained incoming statistics afterward. This could leave a brief
right-edge gap before the sample appeared. Chart end time now follows the newest
real observation, and the current sample is included in the same render. Uptime
continues independently. Silence still expires after 30 seconds; no interpolated
or invented measurements are added.

Targeted browser runner (same command above, file
`apps/web/tests/console-live-stats.browser.test.ts`, filter
`-t 'updates stream metrics'`): **1 passed, 2 intentionally skipped** (14.54s).
The test proves unchanged SVG points across an uptime tick, followed by changed
points and a new measurement at the right edge (x=388) on receipt. Refreshed the
live screenshot. Web typecheck, scoped Biome and independent review passed; no
must-fix findings. No provider/infrastructure interactions or restart. Rollback:
source revert. Earlier offline/expiry checks were not unnecessarily rerun.

### 2026-10-11 — Console dispatch and lifecycle latency cleanup

Console POST now reuses its existing API-owned authenticated Wings WebSocket.
The bounded process-local registry includes session, actor/subject/support,
elevation, full managed provider identity, provider URL/credentials and WebSocket
origin policy. Fresh access/identity/write checks, lifecycle exclusion and audit
remain. REST is selected only when no matching handle exists before dispatch;
an attempted WebSocket send never falls back or replays. 204 means dispatched,
not proof the game executed the command. Closed sessions unregister safely.

Stop/Kill no longer sample host capacity before enqueue. Other operations sample
only their server's host; Start admission and worker physical checks remain.
Independent settings/secret reads run concurrently. The lifecycle final power
handoff explicitly owns one final local authorization after slow proofs, avoiding
an immediately duplicated nested check. Standalone callers keep the full guard.
Power operations still use durable jobs and the supported Client HTTP power API;
this change does not expose a direct browser power channel or replace that
transport with a fire-and-forget socket send.

On HTTP acceptance, the UI marks conflicting actions unavailable and refreshes
server/list/Activity/quota queries in the background. A slow refresh no longer
holds confirmation dialogs open. This does not claim operation completion.

Validation:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/console-command-relays.test.ts packages/pterodactyl-adapter/src/console.test.ts`: **10/10 passed**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts -t 'reuses only the current session console relay|skips host sampling|applies current project viewer|streams safe bytes/events'`: **4 passed, 30 intentionally skipped**. Real app authentication covers same-session reuse, foreign-session/no-handle REST selection, uncertain-send no replay, revocation/identity boundaries, cleanup and sampling scope.
- Integration runner with `packages/server-management/src/runtime.integration.test.ts packages/server-management/src/lifecycle.integration.test.ts -t 'standalone final authorization|internal console reuse|one final local guard|rejects authority revoked during final identity|overlaps final identity'`: **7 passed, 2 failed, 204 skipped** initially. All six lifecycle tests passed; new runtime test assertions misread logger records. A premature targeted rerun had the same assertion failure; this was corrected to read `record.data`.
- Integration runner with `packages/server-management/src/runtime.integration.test.ts -t 'standalone final authorization|internal console reuse|awaits.*provider|revok'`: **9 passed, 36 skipped** after the test correction.
- Integration runner with `packages/server-management/src/runtime.integration.test.ts -t 'invalidates console binding'`: **1 passed, 45 skipped**, including URL, either credential and WebSocket-origin policy changes.
- Browser runner with `apps/web/tests/server-navigation.browser.test.ts -t 'keeps lifecycle admission'`: **1 passed, 4 skipped**, including deliberately stalled post-acceptance descriptor refresh. Initial assertions passed but fixture cleanup raced an intercepted request, producing an unhandled error; after awaiting route cleanup the clean run passed (14.15s).
- Browser runner with `apps/web/tests/console-power.browser.test.ts apps/web/tests/services.browser.test.ts -t 'disables offline|shows mediated console output|retries transient telemetry'`: **3 passed, 20 skipped** (32.58s), including command relay behavior and unchanged Stop/Kill confirmation. Existing Console power screenshots refreshed.
- `scripts/dev.sh pnpm exec tsc --noEmit`, `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, scoped Biome and independent security/durability review: **passed**. No must-fix findings remain. No historical full suite rerun.

Evidence boundary: real app/auth/database handlers with isolated provider effects;
fixtures cleaned. Existing dev API/worker source watchers load code changes, and
dev containers remain healthy. No manual container restart, production mutation,
live power/console command or credential access was performed. No real post-fix
latency reduction is claimed before an Owner-driven interaction; tests establish
removed calls and nonblocking acceptance, not millisecond production guarantees.
Rollback: revert code; existing runtime data needs no migration. PR #21 remains
open/unmerged, and SFTPGo #18 remains unchanged.

### 2026-10-11 — Chart area fills and Owner-driven power timing audit

Charts now fill each continuous segment to the baseline in the series color at
12% opacity. All fills precede all opaque strokes; blue inbound retains priority
over amber outbound. Missing samples stay gaps and offline charts have no fill.
Actual desktop/mobile screenshots were independently reviewed with no must-fix
findings.

Validation: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/console-live-stats.browser.test.ts`
passed **3/3** (26.24s), covering fill geometry/layers, offline behavior, existing
live statistics and accessibility. Web typecheck, scoped Biome and diff checks
passed. No historical full suite rerun.

Read-only dev worker logs and two exact operation-job timestamp reads establish
the following boundaries for the Owner-driven 15:47 UTC Start and 15:49 UTC Stop:

- Start: durable creation to worker receipt **59ms**; delivery age **6ms**.
  Worker receipt to HTTP dispatch approximately **1.150s**; HTTP acknowledgement
  another **350ms**. Initial parallel identity/resources checks took **323ms**,
  physical sampling **273ms**, atomic admission **19ms**, and final authorization
  wrapper **434ms** (including overlapping identity/runtime checks). These stage
  durations overlap and must not be blindly summed.
- The later Start confirmation delivery is not a second delayed Start dispatch.
  Durable completion was **5.919s** after creation; HTTP acknowledgement had
  already arrived **1.559s** after creation.
- Stop: durable creation to worker receipt **52ms**; delivery age **3ms**.
  Worker receipt to HTTP dispatch approximately **1.158s**, HTTP acknowledgement
  another **400ms**, followed by **1.039s** terminal confirmation. Durable
  completion was **3.045s** after creation.

No browser click/API-ingress timestamp or individual console-command timing was
available for this interaction. These measurements do not establish complete
click-to-command latency or game readiness. Power still uses the durable Client
HTTP path; console WebSocket reuse does not change that power transport. The
remaining pre-dispatch work is provider identity, resource admission and final
authorization, rather than a multi-second Redis queue. No JAR download/hash is
part of this power path. No new backend optimization is claimed from this audit.

No live commands, server mutations, container restarts or infrastructure changes
were performed. Rollback: revert chart source; no migration/data change. PR #21
remains open/unmerged; SFTPGo #18 remains unchanged.

### 2026-10-11 — Start critical-path overlap and request timing

Planned Start now prepares its physical observation concurrently with initial
provider identity/resources reads. The returned atomic admission is deferred
until those identity, limits, installation and suspension checks pass. Admission
still checks current host/node policy and observation freshness; failures settle
all sibling work. Restart and provisioning retain their existing admission path.
The same runtime sampling helper serves both paths.

Local container image inspection now overlaps the fresh provider identity
promise; neither proof can authorize an effect alone. Installed Start/Restart
omit the egg catalog GET, retaining actual remote egg, image, startup/environment,
mapping, evidence and managed allocation checks. Provisioning, content and
standalone verification retain egg catalog validation. No JAR hash/download is
introduced. Final identity and revocable authorization remain.

API operation requests now log principal, access-check, host-sampling, enqueue
and total handler durations with the resulting job ID. No request body, command,
credential or provider URL is logged; logging failures cannot affect the request.
This covers previously missing pre-enqueue time, not browser network/paint time.

Validation (all via `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts`):

- `packages/server-management/src/lifecycle.integration.test.ts -t 'overlaps start admission|settles start sampling|shares exactly the fresh|overlaps initial identity|rejects provider identity drift'`: **10 passed, 162 skipped**.
- `packages/server-management/src/runtime.integration.test.ts -t 'defers start reservation|does not prepare a start reservation'`: **3 passed, 46 skipped**; sample without reservation, policy/observation invalidation before commit, failed preflight.
- `packages/server-management/src/minecraft-queued.integration.test.ts -t 'power image proof|uses one fresh provider snapshot|shares the final provider|starts egg validation before|rejects current provider'`: **9 passed, 34 skipped**. Initial run: 4 passed, 5 fixture failures because custom admission fixtures did not disable the new preparation hook; corrected fixtures preserve their existing isolated admission implementation.
- `apps/api/src/servers.integration.test.ts -t 'skips host sampling'`: **1 passed, 33 skipped**, including numeric timer fields and allowlisted log content. Initial assertion exposed logger redaction of the name authorizationMs; renamed to accessCheckMs without weakening redaction.
- Root `tsc --noEmit`, scoped Biome and independent source review passed. Initial typecheck found an overly narrow test log record type; corrected the test capture. No must-fix review findings.

The requested 300–400ms Start target is **not yet established**. Existing live
evidence predates this change. API still samples CPU for 250ms before enqueue;
worker checks retain fresh provider responses. Tests prove overlap and eliminated
catalog calls, not a latency guarantee. No live power commands or manual
container restarts were issued; development source watchers may reload API/worker.
No infrastructure/data migration. Rollback: source revert. SFTPGo #18 and PR #21
open/unmerged status remain unchanged.

### 2026-10-11 — Owner-approved clean Start provider delegation

A fresh planned Start now performs one Application API limits read in parallel
with host sampling, no Client resources GET, no second remote identity read, and
no pre-dispatch runtime/image/egg validation. The retained response must match
the stored ID, UUID, client identifier and configured provider node; limits must
match admission. Node binding was added after independent review identified that
a transferred same-UUID server otherwise reserves the wrong host. No additional
provider request is needed for these comparisons.

Wings decides current power-state/install/suspension validity. Local backend
permissions/managed registry remain mandatory. The local final handoff requires
a prepared Start with its own active operation and starting reservation. Final
revocable authority runs after durable preparation. Recovery/confirmation,
restart, initial provisioning and stop/kill remain unchanged. No synthetic
offline measurement or blind replay is introduced. See ADR 0011 amendment for
externally edited runtime/allocation behavior and snapshot limitations.

Validation:

- Initial full `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/lifecycle.integration.test.ts`: **176 passed, 1 failed**. New unavailable-provider case expected failed instead of the existing conservative waiting outcome; corrected expectation, retaining no-power assertions.
- Final targeted same runner/file with `-t 'clean Start|limits snapshot|settles start sampling|ordinary power|start admission|final full authorization'`: **19 passed, 163 skipped**. Covers one provider read/no telemetry read, target/node/limit mismatch, preparation overlap, revocation after preparation, crash and lost-response no replay. Existing full-final-identity tests now explicitly cover Restart, which retains that contract.
- Same runner with `packages/server-management/src/runtime.integration.test.ts -t 'admitted Start handoff'`: **8 passed, 49 skipped**. Actual prepared reservation, wrong/missing reservation, wrong action/phase/active operation and project-permission revocation, with no observer/provider calls in local authorization.
- Root typecheck and scoped Biome passed after correcting intermediate new timer-name union and fixture-call typing errors. Independent reviewer verified node fix and reported no remaining must-fix findings. No unrelated historical suites rerun.

No post-change live latency claim: the earlier Start's 408ms API handler and
683ms worker-before-send are baseline only. The separate 250ms pre-enqueue CPU
sample remains, so 300–400ms end-to-end is not established. No live commands,
manual restarts or new infrastructure/test assets. Development source watchers
may reload API/worker. Rollback: source revert, no migrations. PR #21 stays open
and unmerged; SFTPGo #18 remains a production-release gate.

### 2026-10-11 — Periodic host sampling and four-second freshness

Implemented retained CPU-counter sampler, parallel RAM/statfs reads, independent
worker one-second loop, shared fresh PostgreSQL observations and coordinated stale
fallback. Freshness is capped at four seconds even if a legacy Owner/environment
setting is larger. Cross-process per-host producer locks, effective-source
fingerprints, monotonic publication, future-timestamp recovery and graceful loop
shutdown protect reuse. Existing conservative atomic admission is unchanged.

Validation:

- `scripts/dev.sh pnpm exec vitest run packages/server-management/src/host-resources.test.ts`: **18/18 passed**. Independent reviewer also ran this with `apps/worker/src/host-observations.test.ts`: **21/21 passed**.
- `scripts/dev.sh pnpm exec vitest run apps/worker/src/main.test.ts packages/core/src/config.test.ts`: **2 passed** in the existing worker test file; the supplied config filename did not identify an additional suite.
- Integration runner `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts` with `packages/server-management/src/admission.integration.test.ts packages/server-management/src/restart-admission.integration.test.ts packages/server-management/src/installation-admission.integration.test.ts packages/server-management/src/runtime.integration.test.ts -t 'admission|reservation|sampling|observation|host'`: **72 passed, 42 skipped**,143.35s.
- Same integration runner with `packages/server-management/src/host-observations.integration.test.ts`: **9/9 passed** after future-row/fingerprint review corrections; subsequently added effective disk-path regression **1 passed, 9 skipped**. Covers cross-connection producer deduplication, freshness cap, failures, observer/future data, periodic cadence and late-publication protection.
- Root typecheck and scoped Biome passed. Review identified future-row recovery and effective-path binding; both were corrected and independently rechecked. Independent final observation integration run: **10/10 passed**.

Read-only microbenchmark inside the existing dev worker: new sampler cold call
**255.288ms**; four warm calls at one-second intervals **1.992,1.331,1.527,2.074ms**.
This excludes DB coordination and is not Start end-to-end evidence. Read-only DB
inspection showed a source-bound observation **0.237s old**; API/worker were healthy.
No manual container restart, game-server command, provider mutation or new
infrastructure was performed. Source watchers load the development changes.
Existing dev observation rows are updated by the authorized collector. Isolated
DB fixtures were used; no production/game data was changed.

No post-change Start latency guarantee. Rollback: revert source (optional metadata
is stored in existing JSON, no migration); no persistent state deletion. PR #21
remains open/unmerged and SFTPGo #18 unchanged.

Activation caveat: existing Gateway processes retain the old strict observation
JSON schema until restarted. The added optional sourceFingerprint is accepted by
new code but can be rejected by an already running old Gateway during wake. A
scoped dev Gateway restart was requested for approval; no restart has been
performed as part of the checks above. API/worker hot reload does not establish
Gateway activation.

Owner subsequently approved and executed scoped activation via
`docker restart --time 20 nickhosting-dev-gateway-1` on 2026-10-11 at16:55UTC.
Verified Compose labels project nickhosting-dev/service gateway before restart.
Post-restart Docker health healthy; private readyz HTTP200, ready=true,
controlAvailable=true, stopping=false, one route loaded. Host observation age
0.937s; managed server state sleeping/offline with no active operation.
A recurring route-level gateway.observation_unavailable warning remains (also
present before restart); its code path is backend protocol probing, not host
capacity sampling. Its precise cause was not established and a real wake cycle
was not exercised. No game-server commands or other infrastructure changes.

### 2026-10-11 — Owner-driven periodic-sampling Start/sleep/wake check

Read-only API/worker/Gateway logs and durable job records show all three operations
succeeded (manual Start, automatic sleep Stop, join-triggered Start). No commands
were issued by Codex. No source/runtime changes during this observation.

- Manual Start at17:03UTC: API handler80.537ms (cached observation18.973ms),
  worker pickup13ms after handler completion, worker-to-send346ms. API handler
  entry to power send approximately439.537ms; provider reply another339ms.
- Join wake at17:05:25.191UTC: API wake89.447ms, Gateway request completion104ms;
  power send17:05:25.655UTC, **464ms from Gateway wake request**, response372ms
  later. Worker observation reuse7.188ms; retained limits read275ms.
- Idle quiescence17:05:16.355UTC; stop send18.257UTC (**1.902s**); confirmed stopped
  approximately19.742–19.751UTC; sleeping responder20.472UTC (**~0.73s after
  terminal proof**,4.117s after quiescence). Exact player-disconnect/idle-timeout
  overshoot was not established: old game-container logs were replaced by the
  second launch, so do not equate quiescence with the exact configured deadline.
- Second launch actual Minecraft Done from timestamped current container log:
  17:06:00.319UTC. Gateway startup hint00.371UTC, online forwarding03.028UTC:
  **2.709s from actual Done**, followed by an actual player join17:06:17.639UTC.

Remaining defect: during wake, observer_container_churn at17:05:27.220UTC produced
a safety-rejected unavailable route until17:05:31.202UTC (**3.982s**). No such
transition was logged during the first manual Start. Source review confirms
coherent-inventory failure can close the responder when the candidate route
differs from the previously committed route; normal container replacement is a
possible trigger, not a proven identification of the changed container.

Recurring route-level observation_unavailable warnings also remain. Sleeping
backend probes can produce these without closing listeners; generic logs lack
the precise failure reason, so not every event can be attributed conclusively.
Host sampling is now reused successfully, but the full cycle is not a clean
acceptance pass and the300–400ms end-to-end target is not met in these samples.
No new assets, restarts, mutations or test suites in this read-only check.

### 2026-10-11 — Startup responder continuity and readiness hint priority

Read-only trace of the Owner's Start job `558b8b28-08d5-4334-9dbc-2af3d8712a80`
(UTC): API handler entry approximately20:25:16.113, adapter power invocation16.330,
provider response16.542, container start17.475, Minecraft Done51.051, Wings running
hint51.074, forwarding20:25:56.315. Adapter invocation is not a wire-dispatch
measurement. Done-to-forwarding was5.264s; no fixed five-second readiness hold was
found. The hint waited approximately2.793s behind an existing observation, followed
by approximately1.11s of backend probing,765ms Core process verification and roughly
507ms until receipt application. These stages are inferred from correlated logs;
the new timing events separately expose startup probe/report and receipt queue time.

The new wake generation caused `backend_container_missing` at20:25:17.448 and
status recovered21.321: a3.873s unavailable route interval. This is a logged route
transition, not a continuous external packet measurement.

Corrections:

- An existing sleeping/waking responder survives generation rotation and transient
  container absence only with fresh ownership, allocation, topology/collision and
  matching v2 reachability proof plus node challenge. This cannot authorize a new
  listener or forwarding to an absent/unready backend.
- A running hint starts a coalesced, server-specific readiness observation without
  waiting for the old periodic probe. Superseded probes cannot report stale results;
  Core ordering and route/generation/lease fences remain in force.
- Ordinary process readiness no longer fetches egg installer metadata. Actual
  provider startup/image and process identity remain checked. Provisioning and
  explicit installation revalidation still validate egg metadata.

Validation on changed source:

- `scripts/dev.sh pnpm exec vitest run apps/game-gateway/src/data-plane.test.ts`:
  135 passed, including priority hint, duplicate coalescing and stale-negative test.
- `scripts/dev.sh pnpm exec vitest run packages/gateway-safety/src/validator.test.ts`:
  121 passed, including generation transition and negative identity/topology cases.
- Minecraft queued readiness/provisioning targeted integration selection:15 passed.
  Full `minecraft-queued.integration.test.ts`:29 passed,14 failed. Restoring the
  prior implementation in the test transform reproduced13 identical failures
  (existing lean-start/sampler fixture assumptions and asynchronous image-observer
  assertion); the additional timeout was not independently repeated. This full
  integration run is **not a pass**.
- TypeScript and focused Biome checks passed. Independent safety/concurrency review
  found no must-fix; suggested extra race regressions remain follow-up coverage.

No real game power/file mutations or infrastructure changes were performed.
Gateway activation requires a separately approved dev Gateway restart; the new
live latency and responder behavior remain unverified until an Owner-driven test.
API/worker development watchers may already load their source change. Historical
failures above remain recorded. PR21 remains open; no milestone merge or release.

### 2026-10-11 — Post-activation timing and diagnostic gap

Owner-driven test after approved Gateway-only restart of4623f83: no unavailable
route transition during Start/sleep. Done20:46:09.655UTC to forwarding12.470 was
2.815s:33ms running hint,345ms failed probe,666ms negative report,1018ms until
next sample,approximately22ms successful probe/request transport,665ms Core
handling,65ms response/application (including36ms receipt queue). First probe
failure was logged only as observation_unavailable; its precise exception was
not retained and cannot be reconstructed conclusively from these logs.

Read-only source review found a possible concurrent grant-invalidation path:
full validation deletes/replaces the fast probe grant, and an in-flight leased
probe rejects if that grant changed. This is a candidate, not a proven cause in
this test. Protocol failure and expired observations remain distinguishable only
with better diagnostics. No fixed five-second timer was identified.

Added diagnostic-only observation_failure events: typed safety reason, probe
stage, startup/periodic trigger and duration. Raw exception messages/provider
payloads are excluded. No readiness, retry, lease or authorization behavior
changed. Two focused regression tests pass (135 unrelated tests skipped); Biome
passes. New diagnostics need a separately approved Gateway restart before another
Owner-driven sample; prior live evidence does not validate this new diagnostic.
The leased probe now includes a fixed diagnostic detail distinguishing grant
replacement from evidence expiry without changing its rejection semantics.
Validator suite:121 passed, including revoked-grant diagnostic assertion.
Typecheck passed on the final diagnostic source.
Independent read-only review confirmed the diagnostic gap and candidate race;
no claim is made that the race caused this historical sample.

### 2026-10-11 — Separate startup validation and Minecraft wire timings

Diagnostic-only follow-up separates previously aggregated readiness costs:

- `gateway.safety_stage`: context, provider inventory/reuse, host observation,
  complete inspection, backend protocol and proof write. A validationId links
  concurrent work; completed/rejected means promise outcome, not readiness.
- `gateway.protocol_stage`: TCP connect, status response, pong and total, with
  validationId and unique probeId. Failure enums distinguish connection refusal,
  socket close/error, timeout/abort, malformed frame and protocol mismatch.
- `gateway.observation_report`: request-through-response duration, readiness value,
  observedAt and startup/periodic trigger. Existing Core process/commit timings
  and receipt queue timings allow separating this from backend probing.

Detailed protocol/safety/report logs are limited to waking routes. No packet
payload, address, key or raw error is included; diagnostic sink exceptions cannot
change readiness. No additional network probes or relaxed checks were introduced.
Totals are nested: protocol total contains TCP/status/pong; inspect_total contains
context and parallel provider/host work. Do not sum parallel branches or add Core
processing again to the report round-trip duration. Measurements use monotonic
local clocks; cross-service wall-clock differences remain approximate.

Validation: combined targeted command
`scripts/dev.sh pnpm exec vitest run packages/gateway-safety/src/validator.test.ts games/minecraft/src/protocol.test.ts apps/game-gateway/src/data-plane.test.ts -t 'Gateway pre-bind|Minecraft|event-driven within-lease readiness'`
passed148 tests, skipped140 unrelated cases. Earlier combined run exposed four
assertions expecting the old one-argument callback; these now assert the new
correlation argument and pass. Protocol suite independently passed29/29.
Independent source review found no remaining must-fix after correcting ambiguous
promise outcome labels and linking protocol/safety correlation IDs.

This change does not establish the cause of the historical4ms protocol failure
or improve measured latency. A new specifically approved Gateway restart and
Owner-driven Start are needed to obtain the finer trace. No production commands,
new test assets or infrastructure operations occurred during implementation.
Final source TypeScript check and focused seven-file Biome check passed.

### 2026-10-11 — Bounded startup status retry and Core overlap

The Owner-driven24ec302 trace demonstrated a successful TCP connection (1.8ms),
then peer close during status response (228ms), not a protocol mismatch, timeout
or revoked validation. The next successful Minecraft exchange took9.976ms
(TCP0.568/status7.826/pong1.099). Done-to-forwarding3.035s included571ms negative
report,1379ms until the next sample and785ms positive report (Core process proof
607.613ms). Concurrent renewal inspection timings must not be added to this path.

Implementation now retries only socket_closed while waking, up to three attempts
with100ms between attempts and the original shared timeout/abort signal. Malformed
frames, mismatched protocol, refusal and timeout do not qualify. Successful status
plus matching nonce remain required; no automatic wake/admission queue is added.
Diagnostics identify each attempt. Exhaustion retains the existing negative
observation and recovery behavior.

Core readiness starts image/local launch validation alongside the same fresh
provider request instead of waiting for it first. Host binding, remote managed
identity, runtime image/config and final before/after process epoch remain checked.
All asynchronous branches settle before the caller releases its DB connection.
No cross-call authority cache or additional provider GET was introduced. This can
remove serial local work but does not eliminate provider latency itself.

Final checks: protocol suite34 passed; Gateway event-driven readiness6 passed
(131 skipped); focused Minecraft integration11 passed (34 skipped); focused runtime
host/identity/concurrency4 passed (54 skipped). TypeScript and focused Biome passed.
Independent review found no must-fix. Tests include transient-close recovery,
retry count/deadline, cancellation during backoff, mismatch rejection, delayed
provider proof, no early readiness and foreign identity rejection.

No real game-server command or infrastructure change during implementation.
Owner has granted standing permission for necessary dev Gateway-only restarts;
activation and a subsequent Owner-driven Start are still needed for live timing.
Historical integration failures remain recorded; no full historical suite pass
or new latency target is claimed.

### 2026-10-11 — Retry works; concurrent renewal race reproduced

Owner-driven50bbed0 test (UTC): Done21:28:09.554, running hint09.589.
Attempt1 connected0.700ms then peer closed after356.595ms; after100ms backoff,
attempt2 completed status/pong successfully at10.134 (85.407ms). The whole probe
was545.501ms. Thus transient-close recovery worked without waiting for polling.
However, a concurrent renewal started during the probe; the result was rejected
at10.135 with observation_stale/detail lease_grant_replaced. Renewal inspection
completed10.550. This confirms the previously hypothetical grant race for this
sample, not retroactively for earlier failures.

Negative report539ms, next periodic sample12.626, protocol3.651ms, positive
report425ms, forwarding13.056: total3.502s after Done. Core process verification
356.452ms versus607.613ms in the prior sample; full Core401.889ms. This single-run
comparison is evidence of observed timing, not a controlled latency guarantee.
No unavailable route transition during this Start in inspected logs.

The correction waits for in-flight listener renewals rather than discarding a
successful leased protocol sample solely because its grant object was replaced.
It accepts only identical route/context, backend identity digest and Docker
container ID, with both original and current evidence still fresh. Failed full
inspections rotate an identity token; even a subsequent successful recovery
cannot revive a pre-failure sample. Token storage is bounded and eviction fails
closed. Per-route renewals are serialized so older success cannot overwrite a
newer failure. No stale grant is used while renewal is pending. Existing outer
probe deadline still prevents late results from being reported as readiness.
The new renewal_wait timing identifies this bounded wait separately.
Validation:131 validator tests passed (including pending renewal deadline and
failed-then-successful recovery);6 Gateway event-driven tests passed (131 skipped).
Independent review found no must-fix; focused Biome passed. Initial TypeScript
errors in new promise annotations were corrected before final delivery.
Final root TypeScript check passed on the corrected source. Index governance passed.


### 2026-10-11 — Provider readiness authority and startup responder continuity

Owner-driven `50fc85f` cycle (UTC): Minecraft Done21:34:24.949, Wings hint25.339,
full inspection693ms (context135ms, host555ms, reused provider0.2ms), protocol17.62ms,
proof write46.6ms; probe760ms. Core report672ms including process550.8ms, then
serialized receipt wait335ms. Forwarding27.108: **2.159s after Done**. The first
probe succeeded; this cycle did not reproduce the previous renewal rejection.
Startup nevertheless had an independently observed `observer_container_churn`
unavailable interval21:33:53.777–58.057 (**4.280s**). Sleep quiescence21:35:25.353,
Minecraft stop27.248, Docker exit27.613, sleeping28.959. These are historical
measurements, not results for the following correction.

The Owner requested trusting Pterodactyl readiness and removing redundant work.
[ADR 0016](decisions/0016-provider-readiness.md) records the resulting contract:
compiled Minecraft accepts authenticated live Wings running against the exact
successful admitted operation/process/reservation. Core returns a bounded durable
readiness snapshot; the Gateway applies it within the original lease without a
second Panel/image/game-status verification. Initial reachability and full listener
renewal safety remain. Player counts remain protocol evidence; unknown counts
prevent idle stop. Periodic online observations use local host process confirmation.
Container churn can retain an already authorized status responder across a new
waking generation only for the identical endpoint/identity, without adopting that
candidate or extending authority. No arbitrary readiness delay is added.

Validation commands and actual outcomes:

- `scripts/dev.sh pnpm exec vitest run apps/game-gateway/src/startup-client.test.ts apps/game-gateway/src/data-plane.test.ts packages/gateway-safety/src/validator.test.ts apps/game-gateway/src/main.test.ts games/minecraft/src/protocol.test.ts`: **335 passed**, five complete test files.
- After adding further safety regressions: `scripts/dev.sh pnpm exec vitest run packages/gateway-safety/src/validator.test.ts -t 'provider readiness|declared provider'`: **6 passed, 131 skipped**. Covers matching proof, no proof, identity, collision, stale observation, missing bindings and stopped backend.
- `scripts/dev.sh pnpm exec vitest run apps/api/src/gateway-startup.test.ts`: **17 passed** (including live stop racing the readiness commit).
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/gateway-orchestration.integration.test.ts`: **88 passed, one fixture failed**. The fixture still hardcoded provider user1 after technical-account migration; corrected to its assigned user. A pending-job fixture also required a valid queued state under existing DB constraints. Targeted `-t 'provider running'`: **6 passed**; no claim of a second full-file run.
- Same isolated integration runner, `packages/server-management/src/runtime.integration.test.ts -t 'provider-ready refresh'`: **1 passed**, proving local host/process refresh without Panel/image reads.
- Same runner, `apps/api/src/gateway.integration.test.ts`: **22 passed, one stale identity fixture failed**. Corrected its hardcoded provider user1; `-t 'narrows provider inventory'`: **1 passed**. Existing failures are recorded rather than relabeled full-suite passes.

Independent review found one live-status race across awaited route validation;
Core now rechecks after the await and immediately before readiness write. No code
must-fix findings remain. Review confirmed unchanged lease/identity fences,
bounded streams, unknown-idle behavior and external-stop process recovery.
The first final typecheck exposed nullable IDs in the corrected fixtures; explicit
non-null fixture guards fix those errors. Final static/governance outcomes and
activation are recorded below.

No complete historical M1–M5 suite or live game-server scenario was repeated.
Tests used isolated fixtures/database services, not the Owner's game server.
No production settings/resources, credentials, eggs, ports or networks changed.
New running-driven live latency and continuity require the next Owner-driven cycle;
passing regressions do not establish a latency guarantee. SFTPGo #18 is unchanged.


Final static checks: root `scripts/dev.sh pnpm exec tsc --noEmit` passed;
Biome passed on the changed TypeScript files; `git diff --check` passed.
Index governance checked584text files,142review PNGs,485relative links,4TOML
files and44ignore cases, passing its heuristic content scan.

A final parent review added a local age check after asynchronous network-proof
loading on the new provider-ready path. It adds no I/O. Its new regression initially
failed because the test injected its clock after validator construction; moving
clock injection before construction corrected the fixture. The same targeted
validator command then passed **7 tests,131 skipped**. Independent review approved
this final guard. This targeted result supersedes the earlier six-case run only;
the complete five-file result remains the earlier335-test run.


Activation: verified the existing container's exact `nickhosting-dev` project and
`gateway` service labels, then restarted only `nickhosting-dev-gateway-1` under the
Owner's standing authorization. A second scoped restart loaded the final freshness
guard. API/worker used their existing source watchers and remained healthy.
The final Unix health check reported ready/control available; the route returned
to sleeping at21:52:03.393UTC after the normal restart lease-drain period. Restart
shutdown/control-unavailable logs are retained and are not classified as a game
startup test. No game power/file commands or new test assets were created.


### 2026-10-12 — Owner cycle exposes nested readiness transaction

Owner-driven `23a0664` cycle, timestamps UTC2026-10-11:

| Event | Time / measured interval |
| --- | --- |
| API Start accepted | 21:55:23.275; handler31.603ms |
| Provider Start request | 21:55:23.370–23.630;260ms; about387ms after API entry |
| Docker process start | 21:55:24.639636461 |
| Minecraft Done | 21:55:54.941640273 |
| Startup stream closed unexpectedly | 21:55:54.970; reason `closed` |
| Gateway forwarding enabled by periodic fallback | 21:55:58.224; **3.282s after Done** |
| Last player disconnected | 21:56:19.134177514 |
| Gateway quiescence/status stopping | 21:57:20.506;1.372s beyond60seconds after disconnect |
| Minecraft receives stop | 21:57:21.777600051;2.643s beyond that60second interval |
| Process exit | 21:57:22.208171536 |
| Gateway sleeping via completion receipt | 21:57:23.084;**876ms after process exit** |

No listener-unavailable transition appeared between this cycle's waking and
completed sleeping transitions. This is Gateway log evidence, not an independently
captured client/network availability trace. A read-only query confirmed the Start
job succeeded with the exact process epoch; no real game operation was issued by
Codex. Expected inactive-backend probe failures still occur while sleeping and do
not close the listener; they are not falsely reported as a clean error-free log.

The new provider-ready path did **not** deliver its receipt in this cycle.
Investigation found `reportGatewayProviderRunning` opens a transaction and invokes
`requireGatewayRoute(tx)`; `getGatewaySnapshot` then attempted another transaction.
Kysely rejected it with `calling the transaction method for a Transaction is not
supported`. The SSE callback swallowed this non-domain error, leaving periodic
fallback to establish readiness. This was an implementation defect, not evidence
that the provider event itself was slow.

Correction: snapshot generation reuses an existing transaction and its resource
lock; root callers retain the original transaction wrapper. Revision/lease writes
participate in caller rollback and SSE authority is emitted only after commit.
Unexpected readiness exceptions now log fixed `internal_error` and close reason
`readiness_failed`, without exposing database/provider exception contents.

Validation:

- New genuine route-callback/database regression reproduced the exact nested
  transaction failure before the fix (the previous API unit test mocked this call).
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/gateway-orchestration.integration.test.ts packages/server-management/src/gateway-registry.integration.test.ts -t 'provider running|route registry'`: **29 passed,104 intentionally skipped** after correction.
- `scripts/dev.sh pnpm exec vitest run apps/api/src/gateway-startup.test.ts`: **18 passed**, including sanitized unexpected-error diagnostics.
- Root `scripts/dev.sh pnpm exec tsc --noEmit`, Biome on the four changed TypeScript
  files and diff checks passed. No historical full-suite rerun.
- Independent review found no must-fix: resource locking/rollback intact, no
  uncommitted snapshot published, failure diagnostics do not reveal payloads.

Core/worker loaded changes through existing development source watchers. API,
worker and Gateway health checked healthy; no container restart, infrastructure
change, credentials mutation, game command or new game test asset was needed.
Corrected live receipt latency remains pending the next Owner cycle. The above
3.282s result is retained as a failure of the previous implementation, not a
successful measurement of the correction. PR remains open; issue18 unchanged.


### 2026-10-12 — Live provider readiness receipt succeeds

Owner-driven Start on application commit `9ca9272`, UTC2026-10-11:

| Event | Timestamp / interval |
| --- | --- |
| Minecraft Done | 22:04:41.454950216 |
| Core live-running observedAt | 22:04:41.525;70ms after Done |
| Durable readiness snapshot complete | 22:04:41.783;258ms after event, including158.615ms commit/snapshot work |
| Startup event sent | 22:04:41.784;channel closes with `hint_sent` |
| Gateway forwards via readiness receipt | 22:04:41.787;**332ms after Done**,262ms after Core event |
| Receipt application queue | **0ms** |

The corrected transaction path delivered the receipt; periodic fallback was not
needed to mark this start online. This replaces the previous3.282second live result
with one successful332ms measurement, not a universal latency guarantee.

Container churn at22:04:12.949 retained the existing waking responder under its
original lease (expiry23.228); full waking snapshot applied15.623. A
`snapshot_unavailable` diagnostic appeared12.950, but no unavailable,
safety-rejected or expired-lease route transition was recorded in this cycle.
This proves recorded listener-state continuity, not packet-level client availability.
API, worker and Gateway health were healthy. Independent read-only review confirmed
timing arithmetic and the bounded continuity interpretation.

This verification inspected logs and container health only: no code change, game
command, provider mutation, restart or new test asset. No test suite was repeated
for this evidence-only update. Sleep timing remains the previously documented cycle;
this requested check specifically validates the corrected Start readiness path.

### 2026-10-12 — Files manager, editor and safe batch operations

This pass replaces the old Files forms with breadcrumbs/direct path entry,
search/sort with folders first, list/grid views, keyboard/right-click overflow
menus, range selection and batch actions. Uploads use one inline queue with
per-file progress/speed/cancel/error and explicit replacement confirmation.
CodeMirror is lazy-loaded; JSON/YAML/TOML syntax validation, highlighting for
properties/scripts, search/undo/redo, keyboard save and revision conflict handling
are available without remote language services. No game integration was added.

API additions and safety limits are documented in [M5 API contracts](M5-API-CONTRACTS.md#file-manager-contracts-2026-10-12).
Real streamed ZIP download, recursive copy and validated ZIP/TAR extraction use
existing managed-server access, adapter streams and upload admission. File moves
now preflight every destination before invoking the provider; existing files,
symlink ancestors, duplicate/overlapping sources and self-descendant destinations
are rejected. External writers still prevent an atomic no-overwrite/CAS guarantee.
Partial copy/extraction failures are audited and remain explicit, not rolled back.

The live upload investigation was read-only: the physical host has no upload
policy; no environment override supplies it. The technical provider account and
observer identity are available. The installed Wings per-file upload ceiling is
500MiB. No policy, provider settings or existing game files were changed. Owner
must configure the host's upload policy (provider limit plus observed temporary
filesystem/budget) in Infrastructure. Missing policy is now reported specifically.

Focused verification, rather than rerunning the historical M1–M5 matrix:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/file-browsing.test.ts apps/api/src/file-operations.test.ts apps/web/src/features/file-editor-model.test.ts apps/web/src/features/file-manager-model.test.ts apps/web/src/app/i18n.test.ts`: **60 passed** on the integrated source. Includes streamed ZIP cancellation/lazy reads, editor revision/auth revocation, recursive operations, archive integrity/expansion/path checks and EN/IT/config labels.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run apps/api/src/file-operations.integration.test.ts`: **9 passed** against isolated PostgreSQL with provider fixtures. Actual routes/claims/audit cover copy, extraction, insufficient capacity, partial upload failure, foreign server denial, missing policy and rename authorization/conflict guards. Existing transfer-descriptor regression also passed.
- Core unit suite: **47 passed**. Production frontend build and runtime packaging passed; no services or migrations started by those build commands. Vite reports its bundle-size advisory; editor is a separate lazy chunk.
- The first combined targeted unit run caught missing labels for three new settings; labels were added and the final60-test run above passed.
- Existing services browser suite: **17 passed / 3 failed**. Files journeys,12MiB upload/download, stale editor response isolation and mobile Files checks passed. Remaining failures concern unchanged console expectations (offline network line count, unavailable telemetry tooltip and previously changed indicator color); they are not reported as passing or rewritten in this Files change.
- Shared content-provider suite: **60 passed / 3 failed** at the existing staging disk-headroom guard. Host filesystem is92% occupied, below that suite's default10% free-space requirement; archive callback regressions passed. No unrelated files were deleted and that policy was not weakened.
- Whole-repository lint exposes an existing missing-title SVG diagnostic in `games/minecraft/src/ui/assets/player-placeholder.svg`, outside this change. Changed production files pass Biome. Formatting/diff checks and final governance results are recorded below.

Independent review found and resolved nested database connection acquisition during
ZIP enumeration, stale write authorization, archive ancestor checks, TAR raw
expansion accounting, empty-folder preservation, move overwrites, and editor
interaction races during saving. RAR/7z extraction remains unsupported; binary
and oversized files use downloads rather than the bounded text editor. Source
code contains no new production credentials or provider URLs. SFTPGo issue18 is
unchanged.

Before the separately approved activation below, no live game-server mutation,
Docker resource creation/recreation, Gateway restart, provider credential change
or production deployment was performed.
Tests used the existing approved isolated services and temporary test schemas.
Complete development dependency activation requires the scoped API/Vite rebuild
in [M5 environments](M5-ENVIRONMENTS.md#files-editor-dependency-activation-2026-10-12);
source watching alone cannot install packages into already running images.


Final browser/review evidence:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts`: **7 passed**. Actual application handlers with isolated provider fixtures: breadcrumbs/path entry/search/grid, keyboard/range selection and ZIP download, safe copy/move conflicts, editor save/concurrent changes, multiple uploads/replacement, archive extraction plus folder/breadcrumb drag/drop, pending-save interaction guards and EN desktop/IT mobile accessibility.
- Final `scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm build`, `scripts/dev.sh pnpm build:runtime`, `scripts/dev.sh pnpm i18n:check`, changed-file Biome and `git diff --check` passed. Whole-repository lint limitation remains the unrelated SVG noted above.
- The initial browser ZIP attempt exposed an incorrect fixture: every listing generated a fresh modification timestamp. Fixture metadata now remains stable until file bytes change; production stale-file checks were retained. Extraction fixtures use their own scoped staging directory under test assets, cleaned after the suite. Upload tests now wait for availability rather than bypassing the disabled toolbar through the hidden input.
- Independent backend, interaction and visual review: no remaining must-fix findings in the changed scope. Automated axe checks passed for desktop/mobile; keyboard menus, selection, editor save and dialog state were exercised. This is focused Files evidence, not a claim of full application WCAG certification.
- Index governance passed:596 text files,146 review PNGs,492 relative links,4 TOML files and 44 ignore cases. Secret scanning remains heuristic; screenshots were visually inspected and contain fixture data only.

Reviewed screenshots: [desktop list](screenshots/m5/file-manager-desktop-en.png),
[desktop grid](screenshots/m5/file-manager-grid-desktop-en.png),
[Italian mobile](screenshots/m5/file-manager-mobile-it.png),
[editor conflict](screenshots/m5/file-manager-editor-conflict-desktop-en.png).

Development activation: the Owner explicitly approved the scoped image build,
API/Vite recreation and rollback. Existing images are retained under local
`before-files-api` and `before-files-vite` tags. Source watcher restarts during
implementation encountered missing `tar-stream` before its import was made lazy;
later API shutdown remained waiting and health became unavailable. These are
recorded development interruptions, not successful uptime checks. The approved
recreation is intended to install the final dependencies and restore service;
its actual outcome is recorded below after verification.

Approved activation completed:

- Built the existing development target with the frozen lockfile, then ran
  `docker compose --env-file .env.dev.local up -d --no-deps --wait api vite`.
  Both API and Vite are healthy. The configured90second shutdown grace was
  needed for the previous stuck API process.
- Container-ID comparison confirms **only API and Vite changed**; no container
  was removed outside that recreation. PostgreSQL, Redis, worker, web, Gateway,
  node probe and mail retain their previous identities. No new host ports or
  networks; web retains the existing external frontend attachment.
- HTTPS login returns200. Live Vite requests for Files and CodeMirror modules
  return200. A fresh real Chromium session reports `[vite] connected`, no page
  errors, and the unauthenticated protected server list correctly returns401.
  This public smoke does not claim authenticated editing of a real server.
- Gateway control-plane health recovered automatically after Core returned;
  no Gateway restart or game command was sent. Offline backend-binding probe
  diagnostics are not evidence of a tested game connection.
- Existing database/accounts/configuration were preserved; no migrations, resets
  or upload-policy changes. Images for scoped rollback remain local. No live
  provider file mutation was performed; interactive upload still requires the
  Owner's missing host policy.


### Files toolbar, folder upload and shared focus/tooltip follow-up (2026-10-12)

The Files timestamp heading now reads Modified/Modificato. New folder, New text
file, Upload and Upload folder use compact icon controls with localized accessible
names. Search precedes the action icons; List/Grid sits at the far right of the
same desktop toolbar, eliminating the separate filter row. Small screens wrap
without page overflow. Sorting is on the Name/Size/Modified headers: ascending or
descending arrows appear on the selected non-default ordering; default Name
ascending has no arrow. Folders remain first.

Entering Files preloads the lazy CodeMirror import, shared with subsequent editor
opens. No new dependency, provider operation or API contract was introduced.
Folder selection preserves its root, nested Unicode paths, binary bytes and
zero-byte files through existing authenticated list/mkdir/upload APIs. New-tree
preparation refuses collisions and symlink ancestors, can be cancelled, and
reports partial or uncertain directory creation honestly. It never deletes
partial data. Browser directory pickers omit empty directories; these are not
claimed as uploaded. External directory drops direct users to Upload folder
instead of silently flattening them. Existing upload policy/admission remains
mandatory; no Owner policy was populated or changed.

Shared tooltip investigation found independent popup states, a150ms dismissal
timer and mouse-click focus that kept popups pinned. A single active popup now
switches/closes immediately, preserves its hover bridge, keyboard focus/Escape
and touch behavior, and does not remain pinned by mouse-click focus. This applies
to Files and Console. Server-tab reload outlines had a separate cause:
ServerShell explicitly focused the current tab whenever no main h1 existed,
explaining why Console was unaffected. Removing that forced focus preserves
native visible keyboard focus, active underlines and tab scrolling.

Focused evidence (historical full suites were not repeated):

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/folder-upload.test.ts apps/web/src/features/file-manager-model.test.ts apps/web/src/app/i18n.test.ts`: **40 passed**, including32 directory planning/preparation/collision/cancellation cases.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts`: **8 passed /1 failed**. The failure was the new reload-focus test looking for nonexistent English tab label Network (actual Connection), before exercising the changed behavior. After correcting that selector, the same command with `-t 'does not force tab focus|renders desktop'` passed **1 selected test /8 skipped** (the second filter matched no test). Click/reload adds no outline; Tab/Shift+Tab retains visible native focus. The eight passing cases include actual API folder transfer, collision rejection, binary/zero-byte files, editor reuse/concurrent-edit rejection, menus/ZIP/extraction, header sorting and EN desktop/IT mobile axe checks.
- An earlier8-case Files run passed7 and failed1 because its import-count assertion counted a full document navigation as another editor open. The assertion now measures the preload per document and verifies that opening/reopening the editor adds no module request. The editor case passed in the later run; this was not hidden as a product success.
- New `apps/web/tests/tooltip.browser.test.ts` through the same isolated browser command: **4 passed**, covering immediate adjacent switching and leave, click-focus dismissal, keyboard/Escape, hover bridge, singleton interaction and touch dismissal. Immediate assertions specifically detect the old delay.
- Two additional existing Console tooltip tests were attempted with `services.browser.test.ts -t 'shares network chart|opens network tooltips'`: **both fail on previously documented offline telemetry assumptions** (one vs two polylines; unavailable measurements vs MiB), before the relevant tooltip behavior. They remain unchanged and are not counted as passing.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck` and `scripts/dev.sh pnpm i18n:check`: **passed** (1198 EN/IT/pseudolocale keys). Changed-file Biome passed with the existing non-null assertion warning in ServerShell; no unrelated cleanup was performed.

Tests use existing approved isolated services, real application handlers and
provider fixtures; their temporary schemas and scoped directory-upload assets
are cleaned by their harnesses. No real provider mutation, test game-server
creation, Docker recreation, restart or new infrastructure operation occurred.
Existing development source/HMR mounts serve these frontend changes. Issue18 and
all production-release boundaries remain unchanged. Folder preflight is not an
atomic external filesystem transaction and does not promise rollback.


Final layout follow-up verification: the isolated Files browser command with
`-t 'navigates breadcrumbs|edits JSON|renders compact'` passed **3 selected tests /
6 skipped** after toolbar consolidation. This rechecked header sorting/grid,
editor preload reuse/conflicts, compact EN desktop/IT mobile layout and axe.
The separate reload-focus regression passed as noted above; expensive historical
suites were not repeated. Web typecheck and changed-file Biome passed after this
last layout change. Independent implementation/accessibility/content review and
all four regenerated screenshots found **no remaining must-fix** in this scope.

Current sanitized screenshots: [desktop list](screenshots/m5/file-manager-desktop-en.png),
[desktop grid](screenshots/m5/file-manager-grid-desktop-en.png),
[Italian mobile](screenshots/m5/file-manager-mobile-it.png), and
[editor conflict](screenshots/m5/file-manager-editor-conflict-desktop-en.png).
These are running-application fixtures, not live production data or generated
mockups. Rollback is a revert of this frontend change; no migration or provider
rollback is necessary. Previously documented backend/test limitations remain.


Subsequent Owner feedback in this same follow-up changed shortcut and tooltip
behavior. Search now displays **CTRL + K** on Windows/Linux or **⌘ + K** on
macOS, without parentheses, and selects the existing search text. The borderless
pencil opens direct-path entry. Its shortcut is **ALT + G** (⌥ + G on macOS),
using the letter-key code so macOS Option characters do not prevent activation.
The initial Ctrl+L choice conflicted with Firefox's reserved address-bar command;
Ctrl+/ was then rejected by the Owner because slash requires Shift+7 on their
Italian keyboard. Neither remains registered. See Mozilla's
[keyboard-shortcut reference](https://support.mozilla.org/en-US/kb/keyboard-shortcuts-perform-firefox-tasks-quickly).
Shortcuts are removed on Files unmount and yield to open dialogs.

The same isolated Files browser command with
`-t 'navigates breadcrumbs|platform-specific search|renders compact'` passed
**3 selected cases /7 skipped** on the final ALT+G implementation. It exercises
Windows/Linux/macOS platform hints, actual keyboard focus/selection, path entry,
dialog exclusion, listener cleanup and EN desktop/IT mobile layout/axe. These
are Chromium runs with simulated platform identity, not native macOS or Firefox
certification; Firefox is not installed in this environment. The i18n test alone
was rerun for new catalog copy: **4 passed**, and compilation/checks passed with
**1199 keys**. Web typecheck and changed-file Biome passed.

Tooltip popup hover retention was initially intentional and tested. The Owner
subsequently requested immediate closure when leaving the original trigger, even
when crossing the popup. Shared popups are now pointer-transparent; Files opts
into cursor-relative positioning while keyboard/touch hints remain anchored.
This explicitly supersedes the earlier hover-bridge assertion. Popup hoverability
under manual WCAG1.4.13 is not claimed; accessible trigger names and keyboard
access remain, and no essential interactive content belongs inside a tooltip.
The focused tooltip suite passed **6 cases** after this behavior change. The
Owner then observed cursor lag; investigation found per-move React position state
and repeated layout measurements. Its final correction/evidence is recorded below.


Final cursor-lag correction: popup position is written directly with translate3d
in the pointer event. Geometry is cached and refreshed on open/content/resize/
scroll; pointer movement causes neither React position-state updates nor layout
measurements. The final isolated `tooltip.browser.test.ts` run passed **7/7**.
Its synchronous regression checks the changed transform before React/rAF,
zero geometry reads on movement, and no stale overwrite after an unrelated
Files rerender. Web typecheck and scoped Biome passed again for this change.
Independent final source/interaction/visual review found **no remaining must-fix**
within the requested behavior; the explicitly documented hoverability limitation
and prior unrelated Console fixture failures are not waived or counted as passes.
Final index governance and whitespace checks passed; only project code, catalogs,
documentation, fixture tests and sanitized screenshots are staged. No secret,
local environment, persistence tree or live infrastructure data is included.


### Files focus and stationary cursor tooltips (2026-10-12)

Owner feedback after the preceding commit removes the extra focus outline/shadow
from Files search and direct-path inputs. Their existing1px border becomes darker
without changing dimensions; forced-colors uses the system Highlight color.
The scoped existing browser command
`scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts -t 'platform-specific search'`
passed **1 selected case /9 skipped**, exercising search/path keyboard focus,
dialog exclusions and listener cleanup across three simulated platform identities.
Scoped Biome passed. Independent source and rendered-focus review found no
must-fix; [search focus](screenshots/m5/file-manager-search-focused-en.png) and
[path focus](screenshots/m5/file-manager-path-focused-en.png) show the running
fixture application. No new test was added for this CSS change.

The Owner also chose stationary cursor-positioned hints instead of following
pointer motion. Files tooltips now open at the pointer's entry position and stay
there until leaving the trigger; subsequent pointer movement causes no positioning
work. Default anchored tooltips, keyboard/touch behavior, singleton dismissal and
viewport clamping remain. This explicitly supersedes the prior moving-tooltip
UX without rewriting its historical test results. The already documented manual
hoverability limitation remains. No live provider, infrastructure or dependency
changes; rollback is a frontend revert. Existing approved isolated services are
reused, and fixture schemas are cleaned by the browser harness.


The stationary-tooltip suite initially passed6 of7 cases. Its remaining assertion
incorrectly expected no tooltip anywhere after the pointer crossed into an
adjacent toolbar icon. The original tooltip did close; the adjacent icon properly
opened its own. The assertion now checks the original identity is gone, followed
by no tooltip once the pointer leaves all controls. Product code was unchanged;
only that focused case was rerun. Other cases verify frozen entry coordinates,
zero layout/style changes on pointer movement, fresh coordinates on reentry,
keyboard/touch behavior and viewport clamping. Final focused result follows.


The isolated tooltip browser command with
`-t 'places Files hints at pointer entry'` passed **1 selected case /6 skipped**.
Together with the preceding6passing cases this covers the final tooltip source;
there was no unnecessary full-suite repetition. Changed-file Biome/diff checks
passed. Independent review found no must-fix. Reviewed
[stationary tooltip screenshot](screenshots/m5/file-manager-tooltip-desktop-en.png)
contains only sanitized running-app fixture data. No live service restart or
provider mutation occurred.


### Files path completion and shortcut handoff (2026-10-12)

The Owner requested actual file/folder suggestions in direct-path entry and removal
of its redundant Open folder button. A compact portaled combobox now filters the
current parent listing locally, with folders first and a bounded scrolling popup.
Files and completion share the same cancellable React Query directory contract;
typing another character in a basename does not request another directory. Changing
the parent queries that parent through the existing authorized endpoint. This is
not recursive filesystem search. No provider credential or endpoint is exposed.

Up/Down selects a candidate; Enter or Space confirms that explicit selection.
Space without selection remains text, including names containing spaces. A folder
candidate completes the path for further traversal; Enter on its exact path opens
it. File candidates use the existing revision-protected editor, with the captured
parent used for both reading and saving. Pending writes block navigation, previous
reads remain abort/sequence-fenced, and revision state resets on a new read.
Symlink suggestions and malformed/traversal paths are excluded; this does not claim
new ancestor-symlink guarantees beyond the existing directory API.

Search focus closes path entry. ALT+G/⌥+G always opens and selects it again, even
when already mounted; dialogs retain their own shortcuts. Loading, no matches,
missing paths and listing failures are localized inside the popup. No layout space
is added for suggestions. Existing input focus styling remains.

Scope: frontend component/model, shared frontend query factory, EN/IT catalogs,
focused tests and documentation only. No API mutation contract, dependency,
infrastructure, live game file or provider configuration changed. Browser tests
reuse approved isolated services with real application handlers and a fixture
provider; their disposable schemas/data are cleaned by the harness. No Docker
operation or service restart. Rollback: revert this frontend change. Issue#18 and
prior release/accessibility limitations remain unchanged.

Validation performed for this change:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/file-path-model.test.ts`:
  **15/15 passed** (bounded parsing, spaces/Unicode, local prefix filtering,
  ordering and unsafe/symlink exclusion).
- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/file-manager-model.test.ts packages/i18n/src/i18n.test.ts`:
  **10/10 passed**.
- `scripts/dev.sh pnpm i18n:compile`: **1203 keys**, EN/IT/pseudolocale.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: **passed**.
- `scripts/dev.sh pnpm exec biome check` on the eight changed TS/TSX/CSS source/test
  files: **passed**.
- Browser prefix: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts`.
  Initial selection with
  `-t 'navigates breadcrumbs|edits JSON|completes actual|keeps path errors|renders bounded path|platform-specific search'`
  passed **4/6 selected** (7 skipped). The two new failed tests pressed ALT+G
  before Files mounted; tests now wait for its toolbar. Product behavior was unchanged.
- Rerun `-t 'keeps path errors|renders bounded path'`: **1/2 selected passed**
  (11 skipped). Missing/invalid paths and stale selection passed. The rendered audit
  identified `scrollable-region-focusable`: scrolling was on the wrapper rather
  than its controlled listbox. Overflow now belongs to that listbox, keeping focus
  in the combobox and arrow-driven visibility. Screenshot review also corrected
  inherited centered button layout to left-aligned file/folder names.
- Final `-t 'renders bounded path'`: **1/1 selected passed** (12 skipped),
  desktop English and mobile Italian, no horizontal page overflow and **zero axe
  violations** in the selected WCAG tags. Screenshots:
  [desktop](screenshots/m5/file-path-picker-desktop-en.png),
  [mobile](screenshots/m5/file-path-picker-mobile-it.png).

Passed behavioral cases prove Enter/Space selection versus literal filename spaces,
exact-folder navigation, nested read/save without touching the same basename at
root, no per-character listing requests, existing editor revision conflicts,
and repeated path/search shortcuts on simulated Windows/Linux/macOS identities.
These are Chromium fixture-browser results, not native Firefox/Safari certification
or new live provider tests. Only affected checks were rerun; the historical full
suite was not repeated. Earlier failure records above are retained as failures.

Independent rendered review subsequently caught a small popup-boundary defect:
the inherited inner max-height did not subtract the outer padding/border, letting
the last row extend below the surface. A flex-column popup with a shrinking
scrollable listbox fixes that. Only `-t 'renders bounded path'` was repeated:
**1/1 passed**, including an explicit listbox-within-popup bounds assertion, last
option keyboard scrolling, EN/IT desktop/mobile screenshots and axe. The screenshots
linked above now show this final correction. No broader suite was rerun.

Independent final source and rendered UX/accessibility review found **no remaining
must-fix** after that correction. Final scoped Biome and catalog freshness checks
passed. Staged-content inspection confirmed exactly four new message keys in each
of EN/IT/pseudo and only the intended source/test/docs/sanitized screenshots.
Governance passed:603 indexed text files,151 review PNGs,501 relative links,
4 TOML files and 44 ignore cases; the secret scan remains heuristic. No persistent
dev review data, live servers or existing infrastructure were changed.


### Files skeleton loading and consistent Alt shortcuts (2026-10-12)

Directory loading now renders static, noninteractive skeleton rows or grid tiles
instead of a visible Loading paragraph. The listing uses its existing responsive
height bound as a stable viewport, including empty/error results, and reserves the
count footer. Toolbar/breadcrumb remain available; no stale directory files are
used as placeholders. Background refetch retains current data. Shapes are hidden
from assistive technology; aria-busy and one localized, visually hidden status
report loading without invented counts or progress. No animation/delay added.

Owner follow-up aligns shortcuts: Search uses ALT+K (⌥+K on macOS); path retains
ALT+G (⌥+G). Physical key codes support Option-generated characters. Repeated
invocation selects the input, Search closes path entry, and dialogs/composition or
extra modifiers retain their own behavior. Ctrl/Cmd+K is no longer intercepted.

The first targeted skeleton browser run reached and passed initial layout/axe
checks, then failed because its Refresh selector omitted the existing word
“files”. Corrected the test selector to the actual localized accessible name;
no product correction was required. Final scoped evidence follows below.

Only Files presentation/shortcuts, focused browser coverage and documentation
changed. No API, dependency, provider, credential or live resource changes. Tests
reuse existing approved isolated services and real handlers with external-provider
fixtures. No Docker lifecycle operation, game mutation or dev data reset. Rollback:
revert the frontend commit. Issue#18 and existing release limitations remain.

Validation:

- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed.
- `scripts/dev.sh pnpm exec biome check apps/web/src/features/files.tsx apps/web/src/features/files.css apps/web/tests/file-manager.browser.test.ts`: passed.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts -t 'reserves the Files viewport|platform-specific search'`:
  **2/2 selected passed**,12 skipped. The skeleton case verifies stable overall
  height before/after initial and uncached-folder results, list/grid presentation,
  nonfocusable placeholders, visually hidden localized loading, retained data
  during refresh, no horizontal overflow and zero axe findings on initial pending
  EN desktop/IT mobile screens. Existing shortcut coverage checks hints, focus,
  selection, path/search handoff, dialog exclusions and unmount on simulated
  Windows/Linux/macOS identities. Chromium only; native browser certification is
  not inferred. No historical full suite rerun.

Reviewed running-fixture screenshots:
[list desktop](screenshots/m5/file-skeleton-list-desktop-en.png),
[grid desktop](screenshots/m5/file-skeleton-grid-desktop-en.png),
[list mobile](screenshots/m5/file-skeleton-list-mobile-it.png),
[grid mobile](screenshots/m5/file-skeleton-grid-mobile-it.png).

Independent source and four-screen UX/accessibility review: **no remaining must-fix**.
The isolated harness cleaned its disposable test state. Public staging contains
only the intended frontend/test/docs files and sanitized PNGs; no private data.

## M5 directory-list identity reuse and early renewal — 2026-10-12

Owner approved retaining Client API → Wings and removing repeated Application
API identity lookup from folder navigation. Only directory GET now shares a
bounded, process-local successful identity proof across per-request management
runtimes. The proof has a fixed 60-second deadline and starts a background renewal
at 55 seconds. Old proof remains usable until its deadline; replacement is
published only after validation. No expired fallback, recursive indexing or
directory-content cache was added. An unused renewed proof does not poll again.
Current authentication/project permissions and Client API credential resolution
remain mandatory; local provider/account/node/claim/Blueprint changes invalidate
reuse. Mutations, downloads and editor reads keep fresh remote corroboration.
See the [API contract](M2-API.md#console-files-and-backups) for the bounded
out-of-band change-detection limitation.

Independent review found and resolved a possible connection-pool deadlock:
directory requests no longer pin a connection while awaiting pool-based renewal.
A single-connection/concurrent-expiry regression proves progress. Shutdown guards
prevent late proof/timer resurrection. A failed background renewal retains only
the old deadline; a subsequent expired request retries freshly rather than
reporting an old failure when the provider has already recovered. No remaining
must-fix findings after these corrections and independent final source review.

Focused validation (existing approved isolated M2 services, disposable schemas,
real authorization handlers, external provider fixtures):

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/directory-identity.integration.test.ts`:
  **28 passed, 1 failed expectation**. The remaining case correctly rejected a
  call after cache shutdown with `integration_unavailable`; the test expected
  `conflict`. Corrected that expectation, then the same command with
  `-t 'closing the cache'`: **1 passed, 28 skipped**. These establish 29 distinct
  scenarios; this is not reported as a fresh 29/29 single-run result. Coverage
  includes actual scheduled renewal callback/idle cessation, expiry, failed
  renewal, single-flight, single-connection pool, provider binding/identity/claim/
  credential/projection changes, in-flight invalidation, session/project revocation,
  and unchanged strict read/write checks.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts packages/server-management/src/runtime.integration.test.ts -t 'revalidates .*pinned connection|blocks later interactive|keeps a two-connection pool|reuses directory identity|isolates unrelated users|applies current project'`:
  **13 passed, 84 skipped**. Three folder GETs produce one identity GET and three
  Client listings; an unrelated caller cannot reuse authorization, and a write
  still verifies remotely. Existing regular/support revocation regressions pass.
- `scripts/dev.sh pnpm exec tsc --noEmit`: passed.
- `scripts/dev.sh pnpm exec biome check` on the seven changed TypeScript files:
  passed. `git diff --check`: passed. No historical full-suite or UI screenshot
  rerun: this change has no visual or browser-contract changes.

Earlier test development exposed fixture mistakes (attempting to edit an
immutable allocation claim, asynchronous deferred-proof ordering, and global
fake timers affecting PostgreSQL disposal); fixtures were corrected without
weakening product invariants. One aborted hook may have left its generated
isolated test schema: no broad cleanup or claim of historical-schema cleanup.
The final test runs disposed their generated schemas normally. One CLI attempt
specified `-t` twice and was rejected before tests; the command above is the
corrected, executed invocation.

Read-only dev measurement used a temporary process inside the existing API
container, the standard runtime/real per-user adapter, and PostgreSQL
`default_transaction_read_only=on`. A first diagnostic import failed before
connections; corrected workspace-source imports then produced:

| Sample | Runtime + directory access | Provider GETs |
| --- | ---: | --- |
| Previous strict path, root | 1,174 ms | Identity + Client listing |
| New path, initial root | 1,045 ms | Identity + Client listing |
| New path, subsequent child | 476 ms | Client listing only |
| New path, same child again | 419 ms | Client listing only |

All six remote GETs returned HTTP 200. Root/child returned 13/1 entries; contents,
names, identities and credentials were not logged. These are four diagnostic
samples, not browser end-to-end timings or a latency guarantee; provider latency
and cold initialization vary. They prove the redundant call is absent on warm
navigation. They do not separately attribute Panel versus Wings processing time.

Development API remained healthy and ingress `/healthz` returned HTTP 200. Source
watchers load these backend edits; no Docker lifecycle/configuration operation,
production mutation, game-server creation or restart was issued. Cache timers
were closed before disposing the diagnostic process. No provider keys/private
state are staged. Issue#18 and all production-release boundaries remain unchanged.
Rollback: revert this change; there are no migrations or persistent cache data.
Final index governance passed: 605 text files, 155 review PNGs, 506 relative links,
4 TOML files and 44 ignore cases. Secret scanning remains heuristic; this change
adds no screenshots or private diagnostic artifacts.

### 2026-10-12 — Inline Files editor, compact search and file-type eligibility

The editor replaces the directory listing at the same bounded height. Breadcrumbs
remain navigable; text reads and lazy CodeMirror loading use static skeleton lines.
The single toolbar provides Home, Save, Undo, Redo and Find as localized icon actions.
Saving remains in the editor with the confirmed revision; conflicts preserve the
local draft. The filename pencil now means Rename, using the existing authorized
file operation after saving pending edits. The listing uses a distinct path icon;
ALT+G remains available in both views. Opening focuses the text editor when ready,
without stealing a deliberate focus move during loading. New files focus Name,
and saving them returns focus to the existing editor. Returning restores row focus.

The existing route tree now uses React Router's data-router bootstrap solely to
support its navigation blocker; route declarations/order and authentication remain
unchanged. Dirty drafts and pending writes block browser Back/Forward as well as
application navigation. Reload uses the existing browser unload warning.

Search is a compact top panel with current/total matches, previous/next icons,
case/whole-word/regex toggles, and an optional replacement row. It uses CodeMirror's
native query/replace engine, not a second implementation. Display bookkeeping is
bounded to 10,000 matches, indicates a lower-bound total with `+`, and uses an
unknown marker when a selected match lies beyond that count. Invalid regex remains
an accessible error. Text-field focus uses the existing border globally instead
of a second outer rectangle; editor focus uses its caret/active line instead of a
cyan surround. Buttons and forced-colors keyboard cues remain available.

File icons distinguish JSON, JAR, configurations, scripts and other common formats.
The Minecraft module owns its original `.properties` voxel/gear asset through
validated decorative SDK rules. Icons cannot grant permissions or editor support.
The shared browser/API metadata policy avoids body reads for known binary types;
unknown files still require bounded strict UTF-8/content validation. Editor GET
and PUT reject binary bytes, including renamed files, with localized HTTP415.
No binary editor exception exists. Streaming uploads/downloads retain their
independent limits and authorization. No migration or dependency was added.

Validation, preserving full versus targeted boundaries:

- `scripts/dev.sh pnpm exec vitest run packages/core/src/file-content.test.ts apps/api/src/file-browsing.test.ts`: **79 passed** (49 policy,30 API). Covers metadata spoofing, renamed binary bytes, Unicode/BOM preservation, size bounds, revisions and authorization.
- `scripts/dev.sh pnpm exec vitest run packages/game-sdk/src/ui.test.ts apps/web/src/features/game-ui.test.ts apps/web/src/features/file-editor-model.test.ts apps/web/src/features/file-manager-model.test.ts apps/web/src/app/i18n.test.ts`: **39 passed,1 failed**. The failure is the unchanged creation test expecting the former modpack archive picker in Vanilla creation fields; the current baseline already omits that picker. New icon/SDK cases and file models/i18n passed. No unsupported wizard behavior was reintroduced to satisfy that stale expectation.
- Browser prefix: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.
- Prefix + `apps/web/tests/file-manager.browser.test.ts`: **17 passed**, before later search/focus/rename refinements. Those refinements were verified with the same file and `-t 'opens text inline|renames the open file|retains the open editor|known binary'`: **4 passed** on the final behavior. Includes stable skeleton geometry, Ctrl/Cmd+F, native search/replace+undo, dirty navigation, rename/save, binary body-read exclusion, pending saves, EN/IT axe and320px reflow.
- Prefix + `apps/web/tests/services.browser.test.ts -t 'creates, edits, renames|streams a 12 MiB|does not replace a second editor'`: **3 passed** after final focus changes. Real handlers confirm new-file save/focus,12MiB byte-preserving transfer and stale-response isolation.
- Prefix + `apps/web/tests/services.browser.test.ts apps/web/tests/server-navigation.browser.test.ts -t 'creates, edits, renames|streams a 12 MiB|does not replace a second editor|opens Console|keeps Console first'`: **5 passed**, including the two bootstrap navigation regressions.
- Prefix + `apps/web/tests/text-field-focus.browser.test.ts`: **1 passed** for pointer/keyboard text-entry borders, button focus and forced-colors indicators.
- `scripts/dev.sh pnpm typecheck`: passed; after final frontend refinements, `scripts/dev.sh pnpm --filter @nickhosting/web typecheck` and production build passed. `scripts/dev.sh pnpm i18n:check`: passed,1214 EN/IT/pseudo keys. Vite retains its existing bundle-size advisory; CodeMirror remains a lazy chunk.
- Changed-file `scripts/dev.sh pnpm exec biome check`: passed with six existing warnings (three reduced-motion `!important` rules and three test non-null assertions). `git diff --check`: passed.

A new320px browser assertion initially exposed the clipped search Close icon.
Grid sizing corrected the issue; the final targeted run passed. Earlier broader
browser execution was interrupted for Owner-requested UI refinements and is not
claimed as a complete successful run or guaranteed cleanup. Completed runs disposed
their isolated database schemas and test staging normally. No historical suite was
repeated merely for cosmetic changes; unaffected evidence above remains distinct
from final targeted checks.

Independent technical, accessibility and rendered UX/content review found and
resolved browser Back draft loss, focus restoration, count-cap honesty, narrow-screen
clipping and an incorrect error translation key. No remaining must-fix finding in
this change. This is focused evidence, not complete application WCAG certification.
Provider calls were isolated fixtures behind actual Hono/auth/database handlers;
there was no production API mutation, live game-server test, new Docker resource,
container restart or production configuration change. Existing dev watchers load
the source changes. No private configuration or credentials are included. Issue#18
remains a separate release gate. External Panel/game writes can still race Wings'
non-atomic comparison/write interval; no transactional CAS or rollback is claimed.

Reviewed sanitized screenshots:
[editor EN](screenshots/m5/file-inline-editor-desktop-en.png),
[editor IT mobile](screenshots/m5/file-inline-editor-mobile-it.png),
[loading EN](screenshots/m5/file-inline-editor-loading-desktop-en.png),
[loading IT mobile](screenshots/m5/file-inline-editor-loading-mobile-it.png),
[search EN](screenshots/m5/file-inline-editor-search-desktop-en.png),
[search IT mobile](screenshots/m5/file-inline-editor-search-mobile-it.png),
[binary state](screenshots/m5/file-inline-binary-unavailable-desktop-en.png),
[file icons](screenshots/m5/file-type-icons-desktop-en.png).

Rollback: revert this change and rebuild only if using compiled artifacts. There
are no migrations, new packages or persistent-state conversions to undo. PR#21
remains open and unmerged; this does not declare all M5 acceptance complete.
Final index governance passed:611 text files,163 review PNGs,514 relative links,
4 TOML files and 44 ignore cases. Screenshots were visually inspected for fixture
content before staging; automated secret scanning remains heuristic.

### 2026-10-12 — Files editor Tab indentation

The editor now uses CodeMirror's native `indentWithTab`: Tab indents the current
or selected lines; Shift+Tab outdents. These edits participate in undo/redo.
Escape then Tab/Shift+Tab preserves a keyboard exit, described in EN/IT accessible
editor instructions. Search inputs retain normal Tab focus navigation; pending
saves remain read-only. No layout, API, dependency or infrastructure change.

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts -t 'indents with Tab|retains the open editor'`: **2 passed**,17 unrelated cases skipped. Covers single/multiple lines, undo/redo, both keyboard exits, search focus and pending-save protection through real application handlers with an isolated provider fixture.
- The first focused run had **1 passed,1 failed** because the new test used a platform-dependent redo shortcut. Using the native Ctrl+Y binding corrected the test; no production behavior was changed to accommodate it.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed.
- `scripts/dev.sh pnpm i18n:compile` and `scripts/dev.sh pnpm i18n:check`: passed,1215 EN/IT/pseudo keys.
- `scripts/dev.sh pnpm exec biome check apps/web/src/features/file-text-editor.tsx apps/web/tests/file-manager.browser.test.ts packages/i18n/src/services-web.ts`: passed.
- `git diff --check`: passed. Full historical suites were not rerun for this keyboard-only change; prior failures and evidence above remain unchanged.

Independent review found no must-fix issue. Existing screenshots remain applicable:
there is no visual layout change. Tests reused the approved isolated services and
disposed their own schemas/staging; no live provider call, game-server asset,
container restart, Docker resource creation or production mutation was performed.
Rollback is a code revert; no state migration is required. PR#21 remains open and
unmerged, and issue#18 remains a release gate.

### 2026-10-12 — Sole path completion and indentation at the cursor

Enter in the Files path field confirms an explicit selection, otherwise an exact
name or the sole matching candidate. Files open at their actual parent path;
folders complete with a trailing slash and preserve focus for further input.
Enter on an already slash-terminated path opens that directory, without choosing
its only child. Ambiguous prefixes, invalid paths and stale selections retain
their existing protections. Exact folder names also complete with a slash now.

Following the Owner's clarification, Tab with an empty selection inserts the
configured indentation unit at the cursor, not at the start of its line. Selected
lines retain native block indentation; Shift+Tab outdents lines. The read-only
guard, undo history, cursor mapping and Escape/Tab focus exit remain intact.
The current unit remains two spaces, avoiding an unsolicited literal tab in YAML.

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts -t 'completes the sole path|completes actual folders|keeps path errors|navigates breadcrumbs|indents with Tab|retains the open editor'`: **6 passed**,14 unrelated skipped. Covers relative/nested completion, file opening, focus, trailing-slash navigation with one child, ambiguous/stale prefixes, ordinary navigation, indentation at a middle-of-line cursor, subsequent typing, block indentation, undo/redo, keyboard exit and pending-save protection.
- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/file-path-model.test.ts`: **15 passed**.
- Web typecheck, i18n compile/check (1215 keys), changed-file Biome and `git diff --check`: passed.
- Initial path browser run: **3 passed,1 failed** because the new fixture had file bytes but no parent-directory records. Fixture setup now creates those directories through isolated application handlers. Initial test tuple type errors were corrected. Final checks above passed; no backend change was required.

Only focused checks were rerun. No visual layout changed; existing screenshots
remain applicable. No production provider operation, server asset, infrastructure
mutation or container restart occurred. Tests reused approved isolated services
and disposed their own schemas/staging. Rollback is a code revert with no state
migration. Historical results and release blockers remain as recorded above.
Independent review found no remaining must-fix issue; index governance passed
(611 text files,163 PNGs,514 links,4 TOML files,44 ignore cases). PR#21 stays open
and unmerged.


### 2026-10-12 — Inline filename rename and nonblocking editor saves

The editor rename action now replaces the breadcrumb filename with an inline
field. It selects the basename without its last extension, commits on Enter or
blur, cancels on Escape and rejects invalid names without a provider request.
A hidden text mirror measures actual glyph width: the field grows and shrinks
with the draft rather than reserving a character-count estimate. Validation uses
a viewport-contained popup, avoiding breadcrumb overflow and mobile clipping.
A confirmed rename retains editor text/revision without downloading it again.

Content saves submit an immutable snapshot while the editor, search, indentation
and navigation remain usable. Later typing stays unsaved after confirmation;
responses cannot overwrite another file's editor. A compact cross-route notice
reopens pending or failed drafts. One request per path is allowed at a time;
conflicts and lost responses are never replayed automatically. Draft state is
volatile browser memory scoped to actor/subject/support identity, with unload
warnings, not a durable offline queue. Explicitly discarded additional typing
is not presented as saved. Rename still excludes conflicting writes.

The API now shares request-local directory observations between the Minecraft
protected-path and generic file guards. A two-component path needs two directory
GETs rather than four, preserving identity, symlink, binary-type, protected-file,
revision and post-write checks. There is no cache across requests, no skipped
verification and no claim of measured live-Panel milliseconds. Wings still does
not provide atomic compare-and-swap; the existing documented write-race limitation
remains.

Focused checks (no full historical suite rerun):

- `scripts/dev.sh pnpm exec vitest run apps/api/src/file-browsing.test.ts packages/server-management/src/minecraft-content.test.ts`: **56 passed** (36 API,20 Minecraft). New cases cover directory request counts, protected paths/case aliases, provider-identifier mismatch and fresh observations on subsequent requests.
- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/file-background-save.test.ts apps/web/src/features/inline-file-rename-model.test.ts`: **26 passed**. Covers immutable submissions, duplicates, independent paths, failed-draft recovery, identity changes and late callbacks, filename selection and validation.
- Browser prefix: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.
- Prefix + `apps/web/tests/file-manager.browser.test.ts -t 'renames the open file' --reporter verbose`: **1 passed**,20 unrelated skipped. Covers basename selection, no dialog, actual glyph-width bounds/growth/shrinkage, invalid-name rejection, Enter/blur, retained contents and editor focus.
- Prefix + `apps/web/tests/file-manager.browser.test.ts -t 'saves in the background|inline rename compact|keeps edits when browser Back' --reporter verbose --hideSkippedTests`: final **3 passed**,18 unrelated skipped. Covers editable pending saves, preserved later typing, duplicate prevention, cross-route failure recovery, cancel/retry navigation, mobile IT validation, keyboard cancel and zero applicable axe violations.
- The existing services create/edit/rename browser journey passed in an earlier combined focused run. It is separate evidence from the final three-case run, not a claim that all browser cases were rerun.
- Root TypeScript, WebPanel source/test typecheck, production web build, i18n compile/check (1219 EN/IT/pseudo keys), changed-file Biome and diff checks passed. Biome reports three pre-existing Shell warnings; Vite retains its existing large-chunk advisory.

Intermediate browser failures exposed focus restoration against an editor being
recreated after rename and a repeated router-blocker effect causing duplicate
confirmation/invalid state transitions. Both were corrected and covered by the
final targeted runs. An earlier mobile screenshot exposed clipped validation;
the portal correction is shown in the final screenshot. Initial new backend
test import order and error assertion issues were corrected. These failed
attempts are not reported as passing or as full-suite results.

Independent technical, accessibility and rendered EN/IT UX review found no
remaining must-fix issue. The reviewer checked the final navigation transition
guard against the installed router, recovery isolation and the compact mobile
validation layout. This is focused accessibility evidence, not a full WCAG audit.

Reviewed sanitized browser screenshots:
[rename EN](screenshots/m5/file-editor-inline-rename-desktop-en.png),
[rename IT mobile](screenshots/m5/file-editor-inline-rename-mobile-it.png),
[invalid name IT mobile](screenshots/m5/file-editor-inline-rename-invalid-mobile-it.png),
[background save EN](screenshots/m5/file-editor-background-save-desktop-en.png).

Tests used real application handlers and approved isolated services with provider
fixtures, disposed their own schemas/staging, and did not create game-server
assets. No live provider mutation, production interaction, Docker resource change
or container restart occurred. Existing development watchers load source changes.
No private configuration is published. Rollback is a code revert; no migrations
or dependencies were added. Issue#18 remains a separate release gate. PR#21 stays
open and unmerged; this focused pass does not declare all M5 acceptance complete.


### 2026-10-12 — Preserve editor position during asynchronous rename

Follow-up to the preceding pass: content saves were nonblocking, but rename still
made the editor read-only and changing its path recreated CodeMirror. That reset
selection, scroll and undo history. Valid rename submission now returns to the
existing cursor immediately on Enter; blur preserves the user's chosen target.
Local typing/search/undo remain available. Content saves and navigation still wait
for rename confirmation so they cannot race an uncertain path. A failed rename
retains its proposed name and any newly typed text without stealing focus.

CodeMirror keeps its document/view and reconfigures language/validation in place.
An explicit document-session key resets state for another file or recovered draft,
so history cannot cross documents. Known noneditable extensions are rejected before
an editor rename with an actionable message; list rename remains available. This
prevents a late binary-extension switch from hiding text typed during the request.

- Browser prefix: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.
- Prefix + `apps/web/tests/file-manager.browser.test.ts -t 'returns to the same editable cursor|does not steal focus on blur|saves in the background' --reporter verbose --hideSkippedTests`: **3 passed**,20 unrelated skipped. A held rename proves immediate editing at line120, stable DOM/cursor/scroll/undo through a text-to-properties extension change, content-save fencing, zero requests for a JAR target, preserved search focus, failed-rename draft retention and existing background-save recovery.
- The prior inline rename/validation/width regression also passed in the first focused run. That run had two new-test failures: comparing DOM text-node offsets across syntax-token changes rather than the line-relative cursor, and using the wrong English Find selector. Both test assertions were corrected; the subsequent three-case run above passed.
- Web source/test typecheck, production build, i18n compile/check (1220 EN/IT/pseudo keys), changed-file Biome and diff checks passed. The existing Vite chunk-size advisory remains. No backend or historical full-suite rerun was required.

Independent review identified the late binary-extension draft-loss case; the
preflight guard and zero-request regression resolve it. Final review found no
remaining must-fix issue and inspected the [pending-rename screenshot](screenshots/m5/file-editor-rename-pending-desktop-en.png).
Existing mobile layout is unchanged. Evidence uses real application handlers with
isolated provider fixtures and approved test services, whose own schemas/staging
were disposed. No production operation, game-server asset, container restart or
new infrastructure resource occurred. Development source watchers remain in use.
Rollback is a code revert, without migrations/dependencies. PR#21 remains OPEN and
unmerged; SFTPGo#18 and other existing release boundaries are unchanged.


### 2026-10-12 — Direct drag/drop moves and scoped overwrite confirmation

Dropping internal files onto a folder, parent row or breadcrumb now moves them
without a form when a fresh target listing has no collisions. Existing same-name
regular files produce a compact EN/IT confirmation with the destination, affected
names, actual replacement consequences and only Cancel/Overwrite. The Owner's
visual refinement uses a larger centered title, normal-sized subtitle, more space,
centered 48px buttons, neutral Cancel and red Overwrite. Cancel receives initial
focus; mobile layout and keyboard dialog behavior remain accessible.

Overwrite consent names exact destination paths, rather than allowing all
collisions in a batch. A newly appearing collision requires renewed consent.
The API revalidates the entire batch, keeps authorization/protected-file checks,
and refuses folders, symlinks, case ambiguity and unrelated/duplicate approval.
No delete-before-move was introduced. Source and destination query caches are
invalidated after success. POST409 reconciliation can reopen confirmation but
never replays the operation automatically; failed overwrite remains visible.
Manual Move/Copy retain their existing no-overwrite behavior.

Focused evidence:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/file-operations.test.ts`: **35 passed**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/file-operations.integration.test.ts`: **14 passed**. Covers exact/root-relative consent, default refusal, changed target type, unapproved collisions in a mixed batch, audit and authorization revocation before mutation.
- Browser prefix: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.
- Prefix + `apps/web/tests/file-manager.browser.test.ts -t 'supports keyboard context menus|extracts a ZIP|asks only for file collisions' --reporter verbose --hideSkippedTests`: **3 passed**,21 unrelated skipped. Covers unchanged manual behavior, direct folder/breadcrumb moves, cancellation, multi-selection replacement, added conflicts and refusal to replace folders.
- Prefix + `apps/web/tests/file-manager.browser.test.ts -t 'collision appears after drop preflight' --reporter verbose --hideSkippedTests`: final **1 passed**,24 unrelated skipped. Covers a new target between browser preflight and POST, API409 consent recovery and a failed overwrite with visible error/no extra POST.
- After the Owner's styling refinement, prefix + `apps/web/tests/file-manager.browser.test.ts -t 'asks only for file collisions' --reporter verbose --hideSkippedTests`: **1 passed**,24 unrelated skipped. EN desktop/IT mobile assert centered enlarged heading, 48px action height, destructive styling, initial Cancel focus and zero applicable axe violations.
- Root TypeScript, final WebPanel source/test typecheck/build, i18n compile/check (1224 EN/IT/pseudo keys), changed-file Biome and diff checks passed. Existing bundle-size advisory remains. No historical full-suite rerun; these are focused results.

Independent security/configuration and rendered UX review found no must-fix issue.
Reviewed screenshots: [EN desktop](screenshots/m5/file-drop-collision-desktop-en.png),
[IT mobile](screenshots/m5/file-drop-collision-mobile-it.png). Evidence uses real
application handlers and isolated external-provider fixtures with approved test
services. Test-owned schemas/staging were disposed; no game server, live-provider
mutation, restart, new Docker resource or production configuration change occurred.
Existing development watchers load source changes.

The existing provider limitation remains explicit: Client API rename has no
atomic no-clobber flag and batch renames are not transactional. External writes
can race final preflight, and a failed provider operation may have partial effects;
no rollback guarantee or automatic retry is claimed. The new optional API field
is backward-compatible. Rollback is a code revert with no migration or dependency
change. PR#21 remains OPEN/unmerged and SFTPGo#18 remains a release gate.

### 2026-10-12 — Compact selected-file actions

The selection count remains visible, followed by icon-only ZIP download, Move,
Copy and red Delete actions. A neutral X at the right clears selection and returns
keyboard focus to the first selected checkbox. Existing EN/IT tooltips and
accessible names explain each icon. The compact bar wraps at narrow widths;
permission/capability guards, batch limits and deletion confirmation are unchanged.
File size/date text was slightly darkened to meet contrast on selected rows.

Focused validation:

- Browser prefix: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts`.
- Prefix + `-t 'supports keyboard context menus|keeps bulk file actions' --reporter verbose --hideSkippedTests`: existing keyboard/multi-operation case passed; new visual case failed contrast. A diagnostic rerun identified selected-row metadata at 4.43:1. These failures are preserved here.
- After the contrast correction, prefix + `-t 'keeps bulk file actions' --reporter verbose --hideSkippedTests`: **1 passed**,25 unrelated skipped. Covers EN desktop and IT at390/361/320px, compact height, no horizontal overflow, localized tooltip/labels, red destructive action, retained confirmation, keyboard clear/focus restoration and zero applicable axe violations.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck` and `scripts/dev.sh pnpm --filter @nickhosting/web build`: passed; existing bundle-size advisory remains.
- Changed-file Biome, diff and staged governance checks passed. No historical full-suite rerun or new translation keys.

Reviewed screenshots: [EN desktop](screenshots/m5/file-selection-toolbar-desktop-en.png),
[IT mobile](screenshots/m5/file-selection-toolbar-mobile-it.png).
Independent code/accessibility and rendered UX review found no remaining must-fix
finding. Browser evidence uses real application handlers and isolated provider
fixtures with approved test services; its own schemas/staging were disposed.
No game-server asset, live-provider call, infrastructure change or container restart
occurred. Development source watchers load the UI change. Rollback is a code revert;
no migration, dependency or API change. PR#21 remains OPEN/unmerged and issue#18
remains an independent production-release gate.

### 2026-10-12 — Preserve single-file download names

The mediated file route previously sent bare `Content-Disposition: attachment`,
so native browser downloads fell back to the endpoint name `content`. It now
provides the validated POSIX basename as a safe ASCII fallback plus UTF-8
`filename*`. Spaces, accents and other Unicode names survive; parent paths never
become the download name. Validation/encoding happens before opening the provider
stream. Streaming, content length, cancellation, access checks and live transfer
authorization are unchanged. No client-side buffering or provider URL is added.

Focused evidence:

- The new browser regression first reproduced `content` instead of `server.jar`.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts apps/web/tests/services.browser.test.ts -t 'preserves original download filenames|streams a 12 MiB binary upload' --reporter verbose --hideSkippedTests`: **2 passed**,45 unrelated skipped. Native browser filenames and identical bytes verified for nested binary, spaced and Unicode names; existing 12 MiB upload/download also verifies its filename.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts -t 'names file attachments|streams safe bytes|ends an established .* download|isolates unrelated users' --reporter verbose --hideSkippedTests`: **5 passed**,34 unrelated skipped. Covers header encoding, invalid paths/control characters, unchanged bytes, cross-user denial, private token mediation and file/backup transfer revocation.
- `scripts/dev.sh pnpm typecheck`, changed-file Biome, diff and staged governance checks passed. Biome retains three pre-existing non-null assertion warnings in the services browser tests; no new warning. No historical full-suite rerun; no visual change requiring new screenshots.

Independent review found no must-fix issue. Tests used existing approved isolated
services, real application handlers and provider fixtures, disposing their own
schemas/staging. No live provider call, game-server asset, infrastructure operation
or explicit container restart occurred; existing dev source watchers load the fix.
No secrets, migration or dependency changes. Rollback is a code revert. PR#21 stays
OPEN/unmerged; SFTPGo#18 remains an independent production-release gate.

### 2026-10-12 — Named ZIP exports

ZIP downloads now use `nhpanel-<normalized-server-name>-YYYY-MM-DD_HH_mm_ss.zip`.
The name comes from the already-authorized managed-server row, without additional
DB/provider requests. The timestamp is captured at request start in UTC, so lengthy
enumeration does not change it. The ASCII stem is lowercase, accent-folded,
hyphen-separated and bounded to100 characters, with `server` as an empty fallback.
Archive contents, paths, lazy streaming and authorization remain unchanged.

- `scripts/dev.sh pnpm exec vitest run apps/api/src/file-browsing.test.ts`: **40 passed**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts -t 'supports keyboard context menus' --reporter verbose --hideSkippedTests`: **1 passed**,26 unrelated skipped. Confirms the actual browser filename, UTC request-time window and existing ZIP bytes/batch behavior through real application handlers.
- Initial typecheck caught a new test fixture's MIME type differing from the adapter's literal `application/octet-stream` contract. Corrected the fixture only; final `scripts/dev.sh pnpm typecheck` passed. Reran only affected naming cases with `scripts/dev.sh pnpm exec vitest run apps/api/src/file-browsing.test.ts -t 'names ZIP attachments safely' --hideSkippedTests`: **4 passed**,36 skipped. These cover punctuation/accents, unsafe header characters, empty-normalized names, bounded Unicode expansion and request time surviving delayed enumeration.
- Changed-file Biome, diff and staged governance checks passed. No full historical suite or visual screenshot rerun; rendered UI is unchanged.

Independent review found no remaining must-fix issue after correcting the fixture
contract. Tests used isolated provider fixtures and approved existing services,
cleaning their own schemas/staging. No production interaction, live provider call,
game-server asset, infrastructure change or explicit restart occurred. No migration
or dependency change; rollback is a code revert. PR#21 stays OPEN/unmerged and
SFTPGo#18 remains an independent production-release gate.

### 2026-10-12 — Folder-tree moves and per-file conflict decisions

Move now opens a bounded folder tree with lazy expansion, keyboard navigation and
a live destination path. Selection summaries show three names plus the remaining
count. Close is an accessible X. Toolbar/context-menu moves and drag/drop share
the same conflict flow: Skip, Overwrite, Skip all and Overwrite all. Decisions
precede one batch; skipped files remain intact, all-skipped sends no mutation,
and newly appearing conflicts need explicit consent. Unsafe folder/link/ambiguous
replacements remain unavailable. No API schema or provider behavior changed.

Final focused evidence:

- Browser prefix: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.
- Prefix + `apps/web/tests/file-move.browser.test.ts`: **6 passed**. Covers lazy loading, skeleton/error/retry, keyboard tree traversal, root/source/self/descendant/link handling, focus recovery after a directory disappears, exact mixed overwrite/skip payloads, newly appearing conflicts after Overwrite all, and Skip all with/without nonconflicting files.
- Prefix + `apps/web/tests/file-manager.browser.test.ts -t 'supports keyboard context menus|extracts a ZIP|asks only for file collisions|collision appears after drop preflight|clears move decisions on identity' --reporter verbose --hideSkippedTests`: **5 passed**,23 unrelated skipped. Existing ZIP/copy/drop behavior remains valid. A held mutation disables Close, ignores Escape and duplicate Enter, then shows an inspection warning without replay after a simulated 503. Actor-context changes discard decisions during destination selection, conflicts, preflight and submitted requests; the browser fixture changes its session cache, while real backend authorization remains independently enforced.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, `scripts/dev.sh pnpm --filter @nickhosting/web build`, `scripts/dev.sh pnpm i18n:check`: passed with1233 EN/IT/pseudolocale keys before the final label-only refinement. Existing bundle-size advisory remains.
- The Owner then requested no label below leaf folders. Removed only the empty-state paragraph, its CSS selector and unused translation; `scripts/dev.sh pnpm i18n:compile` passed with1232 keys. Reran only prefix + `apps/web/tests/file-move.browser.test.ts -t 'loads expanded branches only' --reporter verbose --hideSkippedTests`: **1 passed**,5 skipped, plus scoped Biome. Prior screenshots contain no leaf labels and remain representative.
- Changed-file Biome, diff and staged governance checks passed. Applicable axe scans on EN desktop/IT mobile reported no violations; screenshots and keyboard behavior were inspected. No historical full-suite rerun.

Initial tree testing exposed inherited disabled semantics on expansion buttons;
these are corrected without enabling forbidden destination selection. A later
focus-recovery test initially failed because its synthetic visibility event did
not bubble to the query listener; corrected the fixture and reran the affected
test, then the complete six-case file. Independent review also found pending
choices surviving identity changes and focus restoration preceding busy release;
both were fixed and covered before the final runs. No must-fix finding remains.

Reviewed screenshots: [EN desktop tree](screenshots/m5/file-move-tree-desktop-en.png),
[IT mobile tree](screenshots/m5/file-move-tree-mobile-it.png),
[IT mobile conflicts](screenshots/m5/file-move-conflict-mobile-it.png).
Tests used the existing approved isolated services, real application handlers and
provider fixtures, disposing their own schemas/staging. No live-provider request,
game-server asset, infrastructure change or explicit restart occurred. No new
dependencies or migrations; rollback is a code revert. Existing non-atomic Wings
batch limitations remain documented; no automatic replay or rollback guarantee is
introduced. PR#21 stays OPEN/unmerged; SFTPGo#18 remains a release gate.


### 2026-10-12 — Consistent file Delete confirmation

File deletion now uses the same centered title, spacing, bounded name summary,
quiet X and large action buttons as the move conflict dialogs. Cancel is neutral;
Delete is red and provides explicit confirmation in place of the generic checkbox.
The irreversible-content warning and backend `confirm:true` remain. Initial focus
stays on Close; pending requests prevent dismissal and duplicate submission.
ActionForm's cancellation/destructive options are opt-in; other forms keep defaults.

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts apps/web/tests/services.browser.test.ts -t 'confirms file deletion|creates, edits, renames and deletes' --reporter verbose --hideSkippedTests`: **2 passed**,47 unrelated skipped. Covers EN desktop/IT mobile with zero applicable axe violations, safe focus, Cancel/X/Escape without mutation, held-request guards, visible simulated503 without automatic replay, and exact confirmed fixture deletion. Existing editing/rename/focus behavior also passed.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck` and `scripts/dev.sh pnpm --filter @nickhosting/web build`: passed; existing bundle-size advisory remains. Changed-file Biome, diff and staged governance passed. No translation keys changed or historical full-suite rerun.

Reviewed [EN desktop](screenshots/m5/file-delete-desktop-en.png) and
[IT mobile](screenshots/m5/file-delete-mobile-it.png) screenshots. Independent
technical/accessibility/content review found no must-fix issue. Tests used real
handlers, provider fixtures and existing approved isolated services; their own
schemas/staging were disposed. No live-provider mutation, game-server asset,
container restart or infrastructure change. No API, migration or dependency change;
rollback is a code revert. PR#21 stays OPEN/unmerged; SFTPGo#18 remains a release gate.

### 2026-10-12 — Shared Copy/Move destination and conflict flow

Copy now uses Move's bounded folder tree, live destination path, three-name
summary and Close icon. Both actions share one UI state machine, while Copy calls
the existing streaming copy endpoint and preserves source files. Conflicts offer
Skip/Overwrite and Skip all/Overwrite all; consent covers only reviewed exact
regular-file destinations. Newly appearing names need a new decision. Folders,
links and case-ambiguous replacements cannot be overwritten or merged.

The additive `overwrite` API field is validated for the whole selection before
effects and audited. Per-entry checks retain authorization, protected paths,
streaming, full upload capacity and durable uncertainty. Destination metadata is
rechecked after download negotiation. No destination is deleted first, no source
is moved, and no failed/unknown effect is automatically replayed. Copy refreshes
transfer availability after completion; its own claim cannot hide its result.

Focused validation:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/file-operations.test.ts --reporter verbose`: **52 passed**. Covers scoped consent, unsafe replacements, overlaps and unchanged default collision refusal.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/file-operations.integration.test.ts --reporter verbose`: **23 passed**. Covers actual copies preserving source bytes, protected paths/revoked permissions, whole-batch preflight, late collisions, full capacity accounting, partial effects and retained uncertain claims. The initial run failed one new assertion that counted earlier cases' claims; scoped it to the current server and reran this handler file successfully. No production behavior was changed to satisfy the assertion.
- Browser prefix: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.
- Prefix + `apps/web/tests/file-move.browser.test.ts apps/web/tests/file-manager.browser.test.ts -t 'M5 file move tree|supports keyboard context menus|asks only for file collisions|collision appears after drop preflight|clears move decisions on identity' --reporter verbose --hideSkippedTests`: **10 passed**,25 unrelated skipped. Preserves Move/drop identity invalidation, exact consent, uncertain-response behavior and existing ZIP/batch interactions.
- Prefix + `apps/web/tests/file-copy.browser.test.ts`: initial **7 passed,1 failed**. A30s source-folder lookup timed out immediately after navigation, before any copy request. Prefix + that file + `-t 'copies a nested-source'`: **1 passed**,7 skipped. Prefix + that file + `-t 'uses the copy tree|copies a nested-source'`: **2 passed**,6 skipped. The navigation timeout did not reproduce; added failure-only navigation diagnostics, no retries or unrelated source change. All eight scenarios passed across these runs, not a single clean eight-case run. Covers desktop/mobile tree/menu/keyboard, original preservation, exact mixed consent, fresh conflicts after Overwrite all, all-skipped/no POST, unsafe replacements, revoked upload availability, own in-flight claim and an actual copy followed by lost response without replay.
- `scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm --filter @nickhosting/web build` and `scripts/dev.sh pnpm i18n:check`: passed;1233 EN/IT/pseudolocale keys. The existing bundle-size advisory remains. No historical full-suite rerun.
- Final changed-file Biome and `scripts/dev.sh pnpm exec tsc -p apps/web/tsconfig.tests.json --noEmit` passed, including the failure-only browser diagnostics. Applicable axe scans reported no violations in all three captured states. Independent source/API/UX review found no must-fix issue; screenshots were inspected for desktop/mobile layout and EN/IT content.
- `git diff --cached --check` and `python3 scripts/check-governance.py`: passed;625 text files,180 PNGs,531 relative links,4 TOML files and 44 ignore cases checked. The credential scan remains heuristic.

Reviewed screenshots: [EN desktop tree](screenshots/m5/file-copy-tree-desktop-en.png),
[IT mobile tree](screenshots/m5/file-copy-tree-mobile-it.png),
[IT mobile conflicts](screenshots/m5/file-copy-conflict-mobile-it.png).

Tests use real application handlers, provider fixtures and the existing approved
isolated services, disposing their own schemas/staging. No production provider
request, game-server asset, configuration write, container restart or infrastructure
change. No dependency or migration changes. The non-atomic interval against
external Wings filesystem writers remains documented; partial copies have no
automatic rollback guarantee. Rollback is a code revert. PR#21 stays OPEN/unmerged;
SFTPGo#18 remains a separate production-release gate.

### 2026-10-12 — Upload cancellation, preserved queue and scoped recovery

The reported 49-file batch exposed two related defects: a cancellation/failure
before Wings POST could leave an ingestion claim, and the browser continued
submitting untouched files into that blocked admission. This produced misleading
changed-item errors and blocked later folder deletion. The adapter now carries
internal proof of no POST invocation; only that proof releases the captured claim
with `server.upload.not_dispatched`. Cancellation during signed-URL acquisition
cannot dispatch a later POST. Once POST is invoked, lost responses, synchronous
fetch failures, cancellation and timeout still retain uncertainty. No partial-file
rollback or successful upload is inferred from cancellation.

Cancellation is bound to the exact queue-entry ID. Fresh admission reads precede
continuation; shared-state failures pause untouched entries even if availability
looks ready, since a preflight lock may exist before the durable claim. Check and
resume never resubmits a failed/uncertain file. Pending files stay in the current
tab, not across reloads. The UI distinguishes queued cancellation from a submitted
request that may have partial effects.

Focused evidence (pinned Node24.21.0/pnpm10.33.0):

- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/transfers.test.ts`: **40 passed**. Covers cancellation before/during signed-URL lookup, invalid destinations and revoked authorization without POST; retains uncertainty after actual invocation, lost/early responses and timeout. Independent review also ran this file successfully.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts packages/server-management/src/upload-admission.integration.test.ts`: **65 passed**. Real handlers/database cover exact-claim release, distinct audit, subsequent admission, unknown outcomes remaining blocked, permissions and streaming regressions.
- Browser prefix: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-upload-cancel.browser.test.ts`.
- The initial four-case browser file passed after correcting the upload notice's small-text contrast. Covers cancelling file11 after ten completions in a49-file batch, preserving38 queued entries, eventual48 completions without replay; queued-only cancellation; automatic continuation when admission is available; and repeated blocked recovery/queue cancellation on Italian mobile.
- Independent review found a remaining preflight-lock race despite successful availability reads. Added a fifth regression, rerun with prefix + `-t 'pauses after one conflicting submission'`: **1 passed**. The real handler holds the lock with zero claims, the next PUT returns409, and six untouched entries remain queued until explicit resume. Neither submitted file is replayed. The fixture initially waited on a browser request event that arrived after preflight; removed that event dependency and asserted the real409 explicitly.
- Final screenshot cases rerun with prefix + `-t 'cancels file 11|keeps queued files'`: **2 passed**. Applicable mobile axe scan has zero violations; desktop/mobile screenshots were inspected. Resetting screenshot scroll after focus removed a capture-only floating skip-link artifact, without product CSS changes. These are targeted final reruns, not one final five-case suite run.
- `scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm exec tsc -p apps/web/tsconfig.tests.json --noEmit`, `scripts/dev.sh pnpm i18n:check`: passed;1237 EN/IT/pseudolocale keys.
- `scripts/dev.sh pnpm --filter @nickhosting/web build`: passed with the existing bundle-size advisory. Scoped Biome checked all13 changed code/test files; diff checks passed. No historical full-suite rerun.
- `git diff --cached --check` and `python3 scripts/check-governance.py`: passed;627 text files,182 PNGs,533 relative links,4 TOML files and 44 ignore cases. The credential scan remains heuristic.

An initial backend invocation accidentally used the system Node20: two adapter
cases failed because that unsupported runtime lacks `Promise.withResolvers`; its
integration attempt was interrupted. The pinned-runtime runs above passed. The
interrupted attempt may have left an unidentified disposable schema in the approved
isolated test database: its random identity was not logged/persisted, so no guessed
schema or broad cleanup was attempted. Completed fixture runs disposed their own
schemas/staging. Initial failures are retained here rather than reported as passes.

Read-only incident inspection matched the API failure to one dev ingestion claim.
Ten successful signed-URL/upload pairs preceded it; no further matching provider
upload request followed in the incident interval. The claim had no active advisory
lock/query, and Wings temporary-directory metadata showed no multipart files.
The Owner-requested repair used the existing recovery service with exact stored
claim/provider identity, current Owner authorization and audit reason/evidence.
Only that NickHosting dev claim was released; post-check showed zero pending
claims and upload availability true. Neither the folder nor its ten completed
files was deleted or changed. Private recovery evidence and logs remain ignored.
API, Vite and web containers were running/healthy; no explicit container restart,
provider mutation, production configuration change or new game-server asset occurred.

Reviewed screenshots: [EN desktop queue](screenshots/m5/file-upload-cancel-49-paused-en-desktop.png)
and [IT mobile recovery](screenshots/m5/file-upload-cancel-blocked-it-mobile.png).
Independent final source/accessibility/content review found no remaining must-fix
issue after the pause-latch correction. No dependency, migration or endpoint-schema
change. Rollback is a code revert; the audited incident recovery does not require
recreating a stale claim. Genuine post-dispatch uncertainty still needs verified
Owner recovery. PR#21 remains OPEN/unmerged; SFTPGo#18 remains a release gate.

### 2026-10-12 — Centered empty-folder message

Scoped `.fm-list > .empty` alignment centers the folder-empty/no-search-results
message horizontally without changing its existing vertical spacing or the shared
Empty component. A one-off real-browser inspection used the existing isolated
harness/provider fixtures (no new regression test). EN desktop and IT mobile,
list/grid: horizontal center error at most0.008px; before/after vertical delta0px
and list height unchanged in all four cases. Fixture schema was disposed.
Command: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec tsx .codex/local/check-empty-folder-ui.ts`
(private disposable inspection script). Reviewed [desktop](screenshots/m5/file-empty-centered-desktop-en.png)
and [mobile](screenshots/m5/file-empty-centered-mobile-it.png) screenshots.
`scripts/dev.sh pnpm exec biome check apps/web/src/features/files.css`, diff and
staged governance checks passed. Independent scoped CSS review found no issue.
No type/build/full-suite rerun for this CSS-only change, no infrastructure or
provider interaction, no restart. Rollback: revert the scoped CSS rule.
PR#21 remains open/unmerged; no new blockers.

### 2026-10-12 — Transient upload contention without losing the queued file

The new report occurred without cancellation. Read-only dev evidence shows a409
at12:16:20.268Z, immediately after the previous file's confirmed/uploaded audits at
12:16:19.918Z/19.921Z. The rejected request produced no upload-request audit or claim;
inspection found no outstanding ingestion claims, so no dev-state recovery was
needed. Historical logs did not identify the exact conflict site/lock holder.
Source investigation and an actual reconciliation-barrier regression establish a
concrete defect with this symptom: periodic reconciliation takes the same server
lock as file writes, and initial lock refusal was reported as a changed-item
conflict. A saturated upload slot used the same misleading code. The browser
marked that file failed and manual resume processed only the remaining entries.

The two initial refusals now return `operation_busy` before provider effects.
Only the existing browser queue retries this explicit code: at most five attempts,
with cancellable 250/500/1000/2000 ms waits. Brief contention resolves automatically;
exhaustion leaves the same file at the queue head for Check and resume. Cancelling
a waiting file affects only that entry. The retry loop adds no availability polling;
normal view refreshes remain. No backend wait/retry, new infrastructure, extra
provider check or duplicated upload implementation was added. Generic conflicts,
lifecycle conflicts, retained host/server claims and unknown provider outcomes
remain non-retryable. Old failures without the new explicit proof cannot safely
be converted into automatic retries; the previously failed file can be reselected
by the Owner after inspecting its result.

Final targeted validation on pinned Node/pnpm:

- `scripts/dev.sh pnpm exec vitest run packages/core/src/core.test.ts packages/i18n/src/i18n.test.ts`: **53 passed**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts packages/server-management/src/runtime.integration.test.ts -t 'M2 Hono API|keeps a two-connection pool'`: **50 passed**,58 unrelated runtime cases skipped. Includes real reconciliation lock contention with no extra identity/resources/list/upload calls, no claim/request audit, then exactly one upload after release. Pool contention preserves authentication, reads and logout; lifecycle conflicts and retained same-server/sibling-host claims remain nonbusy.
- Browser prefix: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-upload-cancel.browser.test.ts`.
- Prefix + `-t 'retains a busy file|short background server lock|cancels a waiting busy|exhausting busy retries|keeps queued files'`: **5 passed**,3 skipped. Actual advisory-lock fixtures cover automatic continuation, bounded exhaustion, same-file manual resume, cancellation during backoff and unchanged unknown-outcome no-replay behavior.
- Prefix + `-t 'cancels file 11|cancels a queued file|continues untouched files'`: **3 passed**,5 skipped. All eight cases passed across these non-overlapping runs; this is not a claimed single eight-case run. The49-file cancellation regression remains covered.
- `scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm i18n:check`, `scripts/dev.sh pnpm --filter @nickhosting/web build`: passed;1240 EN/IT/pseudolocale keys. Browser types were checked again by the frontend worker after final test edits. Existing bundle-size advisory remains.
- Changed-file Biome and diff checks passed; staged governance checks passed. No historical full-suite rerun. Mobile axe scan reported no applicable violations or horizontal overflow.

Independent technical/accessibility/content review found no remaining must-fix
finding. Reviewed [EN waiting](screenshots/m5/file-upload-busy-waiting-en-desktop.png),
[EN paused](screenshots/m5/file-upload-busy-paused-en-desktop.png),
[IT waiting](screenshots/m5/file-upload-busy-waiting-it-mobile.png) and
[IT paused](screenshots/m5/file-upload-busy-paused-it-mobile.png) screenshots.
Tests used existing approved isolated services, real handlers and provider fixtures;
their locks, schemas and assets were disposed. Live investigation was read-only.
No dev database repair, game-file mutation, provider write, explicit container
restart or infrastructure change occurred; API/Vite remained healthy. No migration
or dependency change. Rollback: code revert. PR#21 remains OPEN/unmerged and
SFTPGo#18 remains a separate release gate.

### 2026-10-12 — Deduplicate bulk file-mutation directory checks

Bulk delete already sends one browser request and one provider `deleteFiles`
request containing all selected names. The redundant work was Minecraft's
preflight: it fetched every ancestor listing again for each selected path.
A listing-Promise map now lives only inside that guard invocation. All paths
retain protected-runtime, case-ambiguity and symlink checks; a later invocation
reads fresh listings. Neither directory data nor mutation-result confirmation is
cached across requests. Reads remain sequential, without a burst of provider calls.

Regression fixtures verify 49 existing files need one listing at root, two under
one top-level folder, or three under `world/data`, versus 49/98/147 before the fix.
The authenticated API test confirms the nested case still sends exactly one delete
batch with all 49 names. Late unsafe entries/ancestors, protected paths, mismatched
provider context, failed reads and changed listings on the next invocation remain
covered. These are request counts from isolated fixtures, not live deletion timings.

Validation:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/game-modules.integration.test.ts apps/api/src/servers.integration.test.ts -t 'compiled first-party game module dispatch|Minecraft file mutation preflight|protects Minecraft launch inputs'`: **20 passed**,48 unrelated API cases skipped;10.13 seconds. Includes five existing dispatcher cases,14 guard cases and one extended API case.
- `scripts/dev.sh pnpm typecheck`: passed. Backend `scripts/dev.sh pnpm exec tsc --noEmit` also checked the final API test addition.
- Scoped Biome, diff and indexed governance checks passed. No historical full-suite, browser or production-build rerun for this backend-only change.

Independent final review found no must-fix finding. Tests used existing approved
isolated services and provider fixtures; their disposable schemas were cleaned up.
No live game-file mutation, infrastructure change, new test server or explicit
container restart occurred. No API-schema, migration or dependency changes.
Rollback: revert this code change. PR#21 remains OPEN/unmerged; SFTPGo#18 remains
a separate production-release gate.

### 2026-10-12 — Remove waits and duplicate reads between uploads

The browser still sends one file at a time and marks completion only after the
upload API returns success. It no longer awaits a directory display refresh
between successful files. Refreshes are coalesced outside the upload loop, with
a final/pause refresh; display failures stay with the file query and cannot turn
a confirmed upload into a failed upload. Directory/identity changes dispose old
refresh work. Uploads retain the existing cancellation, busy backoff and uncertain
outcome rules; no parallel-upload or storage-admission policy was introduced.

The upload route now shares each request's listings between the Minecraft guard
and generic destination checks, and overlaps the resource read with independent
path checks. Every started branch settles before a failed request releases its
server lock/connection. Folder uploads use strict `overwrite=false` and localized
`409 file_exists` instead of issuing a separate parent-listing GET for each file.
Default/explicit `overwrite=true` retains existing overwrite behavior. Collision
checks remain preflight observations, not atomic guarantees against external
filesystem writers. Provider success, authorization and ingestion-claim settlement
still precede the upload response.

Backend validation on pinned Node/pnpm:

- `scripts/dev.sh pnpm exec vitest run packages/core/src/core.test.ts packages/i18n/src/i18n.test.ts`: **53 passed**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts`: **63 passed**,0 skipped,44.06 seconds. Covers strict query parsing, exact/case/symlink/directory collisions before dispatch, shared/fresh listings, concurrent-read barriers, lock retention on failures and existing transfer/authentication/uncertainty regressions.

The first API run passed 51 cases but failed 12 new Minecraft cases during fixture
creation because the extracted helper duplicated a unique runtime mapping. The
helper now reuses its isolated mapping and creates distinct combination identities;
the final run above passed. This fixture failure required no production-code fix.

`scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm i18n:check` and
`scripts/dev.sh pnpm --filter @nickhosting/web build` passed on the final source;
the catalog contains 1241 EN/IT/pseudolocale keys. The existing bundle-size advisory
remains. Scoped Biome passed for the six changed source/test files. No historical
M1–M5 full-suite rerun or live upload performance claim is made.

Browser validation used the actual Hono handlers and isolated provider fixtures:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-upload-refresh.browser.test.ts apps/web/tests/file-upload-cancel.browser.test.ts`: **13 passed,1 failed**,87.02 seconds. All eight existing cancellation/busy cases and five new refresh cases passed. The navigation case expected exactly one destination read, but preserving the pending final refresh correctly adds one follow-up when joining an older listing.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-upload-refresh.browser.test.ts -t 'folder navigation'`: **1 passed,5 skipped**,10.25 seconds after correcting that assertion to require exactly two root reads and one or two destination reads, still checking stale-response isolation and final contents. All14 scenarios passed across these runs; this is not a claimed single clean14-case run.

The new coverage proves 49 uploads finish while a display GET is held, followed by
one fresh final listing; failed listings retain Completed upload states; folder
navigation and workspace unmount discard stale responses; a destination listing
started before the final upload cannot satisfy its final refresh; folder uploads
send `overwrite=false` without per-file browser listings and preserve existing
case-insensitive collision bytes. An earlier exploratory browser run passed 3/4
cases but used an outdated “Retry” locator instead of “Try again”; this test typo
was corrected. An intermediate focused run passed display-failure and navigation
but needed the remount request-count assertion adjusted from two reads to at most
three; its no-late-refresh assertion passed, as did the final unmount test.
Review also resolved the directory-effect handoff/joined-listing
edges before the final combined run. No unnecessary full-suite repeat followed.

Independent technical review found no remaining must-fix findings. Regenerated
private EN desktop/IT mobile queue screenshots were inspected; layout and existing
published screenshot history are unchanged. Existing approved isolated services
were reused; fixture schemas/locks were disposed normally. API/Vite remained
healthy with their normal source watchers. No real game-file upload, production
mutation, new infrastructure/test server or explicit container restart occurred.
No migration/dependency change. Indexed hygiene/governance checks passed. Rollback:
revert this commit's API/browser/catalog changes together. PR#21 remains OPEN and
unmerged; SFTPGo#18 remains a separate production-release gate.

### 2026-10-12 — Reuse upload identity and overlap fresh path checks

The preceding read-only diagnosis examined49 recent upload audit sequences:
reservation-to-confirmation was205 ms median, confirmation-to-final-audit5 ms,
and previous completion to the next completed preflight723 ms. Audit timestamps
are transaction timestamps, not exact browser/provider stage traces. Three separate
read-only adapter probes measured identity190–306 ms, root listing231–245 ms,
child listing201–212 ms and resource reads206–251 ms. Browser XHR100% can occur
before these checks finish; it does not mean Wings has completed the write.
These are pre-change observations, not claimed post-change timings.

Binary uploads now reuse the same bounded identity proof as directory browsing,
so opening Files prepares identity for subsequent uploads. The proof still expires
at60 seconds and renews in the background at55; local identity, account/key,
allocation and Blueprint drift invalidate reuse. Fresh session/manage authority,
active-operation/pending-upload checks, the exclusive server lock and final identity
comparison remain per request. General mutations keep their existing fresh remote
identity verification. No new API endpoint, browser token, persistent batch state,
permission cache, migration or dependency is introduced.

Minecraft ancestor listings now overlap with at most four requests in flight,
deduplicated within each mutation. They remain fresh between uploads: external
SFTP changes can introduce in-root symlinks, so caching path safety across files
would weaken runtime-file protection. All reads settle before validation returns;
original-order validation preserves ancestor errors and missing-ancestor behavior.
The destination guard shares these same observations. Resource sampling remains
parallel and current; local disk allowance may differ from the provider allowance.
Physical upload admission, cancellation, unresolved claims and confirmed-success
semantics remain unchanged.

The API emits one privacy-safe `server.files_upload` timing event for requests
that acquired an upload slot, separating access, path/resource reads, admission,
provider transfer and settlement. Paths/content/signed URLs/credentials are absent.
Parallel durations must not be summed. This allows the next Owner upload to be
measured without repeating live writes merely for benchmarking.

Validation on pinned Node/pnpm:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/game-modules.integration.test.ts`: **23 passed**,5.83 seconds. Covers49-file deduplication, bounded overlap, fresh unsafe ancestors, protected runtime paths, deterministic error precedence and draining failed speculative reads.
- The same integration prefix with `packages/server-management/src/directory-identity.integration.test.ts`: initial **45 passed,1 failed**. A new project fixture incorrectly used `operator` instead of the required `manager`; production permission checks correctly denied its upload. After correcting the fixture and adding the contention case, the targeted rerun passed **2 tests**,45 skipped. All47 scenarios passed across those runs; no single clean47-case run is claimed. Coverage includes49 uploads sharing one identity proof, cold/expired proofs,55-second renewal, drift and revocation, pending claims, fail-fast locks and an actual two-connection pool during renewal.
- The same integration prefix with `apps/api/src/servers.integration.test.ts`: **64 passed**,0 skipped,63.81 seconds. A real-handler49-upload fixture uses one remote identity read, while all49 quota checks and98 root/child observations remain fresh. A later injected symlink is rejected without upload/claim; timing fields and absence of private filenames/tokens are asserted. Existing streaming, origin/permission, cancellation, pool-capacity and uncertain-effect coverage passes.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-upload-refresh.browser.test.ts apps/web/tests/file-upload-cancel.browser.test.ts`: **14 passed**,0 skipped,74.99 seconds. Real browser/handler fixtures cover49-file continuation, cancellation, busy retry/exhaustion, uncertainty, folder collisions, failed/coalesced display refreshes and navigation/unmount isolation.
- `scripts/dev.sh pnpm typecheck`: passed. Scoped `biome check`, `biome format` and `git diff --check` passed for all six source/test files. No frontend layout/catalog/dependency changes; no production build or historical full-suite rerun was necessary.

Independent source/security review found no must-fix findings. Existing approved
isolated services were reused; fixture schemas/assets were cleaned by their normal
teardown. No live game-file upload, server mutation, new infrastructure, data reset
or explicit container restart occurred. API/Vite source watchers remain in use.
The actual post-change live latency is pending the Owner's next upload; request
counts and concurrency are proven through isolated fixtures. No new screenshot
was required for this backend-only behavior change. Rollback: revert this change;
no data migration. PR#21 remains OPEN/unmerged; SFTPGo#18 remains a separate
production-release gate.

### 2026-10-12 — Prepared upload groups and concurrent streaming

The Owner requested removing repeated directory/resource observations and using
configurable concurrent uploads. The preceding live49-file sample (3,952,843bytes)
took31.576seconds from first request start to last completion. Mean backend time
was587.69ms/file: access17.26ms, paths304.42ms and resources245.16ms overlapping,
admission19.56ms, provider226.49ms, settlement8.38ms and other work11.58ms.
Provider time included signed-URL issuance, not just file bytes. Mean gap between
requests was57.9ms. These remain baseline measurements, not new performance claims.

The browser now prepares bounded groups and streams independent files with
**two concurrent slots by default**, Owner-configurable1–6. It starts the largest
file first (large threshold16MiB), uses other slots for small files, and refills
freed slots immediately. All-small queues keep selection order; all-large queues
fill the slots largest first. There is no artificial bandwidth throttle. Group
partitioning respects existing storage budgets and at most500entries; it does
not impose a new fixed cap on the whole selection.

Preparation performs shared path checks and one quota snapshot. The real-handler
49-file fixture now proves **2 directory reads and1 resource read**, replacing
98 and49 respectively for the same root/child paths. No directory/resource read
is required between admitted files. Single-use private upload URL issuance
runs alongside local entry admission; bytes wait for both. GET coalescing is
explicitly disabled for token issuance, avoiding accidental reuse of the same
Wings token by two concurrent files. Separate timing fields expose signed-URL
latency and streaming/provider response latency for the next live comparison.

Existing ingestion records hold the group manifest and independent file states;
no migration/dependency/service change is needed. Shared lifecycle locks permit
parallel uploads while excluding other mutations. Current authorization, managed
identity binding, streaming bounds, atomic concurrency claims and conservative
physical reservation remain. Cancel/error affects its entry, and confirmed
siblings continue. Uncertain effects retain their claim and consume a slot;
there is no blind replay or invented rollback. Lost preparation responses reuse
their original identity; abandoned queued entries release only unused groups.
Directory/collision observations are now made **once at preparation**: external
SFTP/game/provider changes can race them. This accepted boundary is documented
in [M5 upload contracts](M5-API-CONTRACTS.md), not presented as atomic no-clobber
or continuous protection against externally introduced filesystem aliases.

Validation (pinned runtime, actual handlers and existing approved isolated
PostgreSQL/Redis services; external file effects use provider fixtures):

```sh
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts packages/server-management/src/upload-batches.integration.test.ts packages/server-management/src/upload-admission.integration.test.ts packages/server-management/src/directory-identity.integration.test.ts packages/server-management/src/platform-queries.integration.test.ts
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts -t 'requests a private upload URL'
scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/transfers.test.ts packages/pterodactyl-adapter/src/adapter.test.ts packages/pterodactyl-adapter/src/transport.test.ts packages/server-management/src/scoped-provider-adapter.test.ts
scripts/dev.sh pnpm exec vitest run packages/core/src/core.test.ts apps/web/src/features/file-upload-queue.test.ts
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-upload-cancel.browser.test.ts apps/web/tests/file-upload-refresh.browser.test.ts
```

- Final affected integration run: **165 passed across5files**,155.59seconds.
  The subsequently added signed-URL/admission-overlap test passed separately:
  **1 passed,66 skipped**,7.00seconds. This is not a claimed single166-test run.
- Adapter/transport/scoped-credential units: **131 passed across4files**,3.41seconds.
  Distinct single-use tokens are asserted across two scoped adapters sharing the
  same transport coordinator. Scheduler/configuration units: **54 passed**.
- Initial affected browser run: **15 passed,2 failed** across17scenarios. One
  busy-backoff assertion allowed5seconds for up to3.75seconds of retry delay plus
  handler overhead; its bounded test wait is now10seconds. A case-insensitive
  collision incorrectly returned generic conflict; the API now reports the
  specific existing-file result without blocking unrelated entries.
- Targeted busy/collision/mobile rerun: **3 passed**. The actual protected Owner
  settings journey then passed after correcting test locators to `Saved setting`
  and `Save changes`; it saves3 and verifies3 active uploads and independent
  queued cancellation. A new eighteenth scenario checks cancelling every queued
  entry after a lost preparation response releases the unused reservation.
- Final targeted browser command used the same browser prefix with
  `apps/web/tests/file-upload-cancel.browser.test.ts -t 'unused reservation|prepared batch after unmount|lost preparation response with'`:
  **3 passed,9 skipped**,12.64seconds. **All18 distinct scenarios passed across
  these runs**, not a single clean18-case run. Coverage includes49 files with a
  held first transfer, large/small scheduling, independent errors/cancellation,
  lost responses, unmount, final listing freshness and existing content protection.
- One intermediate browser invocation failed in Owner setup with HTTP500 before
  any test executed. The cause remains unproven; safe fixture diagnostics were
  retained. It did not recur in the final targeted run after other integration
  suites finished. No external-provider error is inferred from that fixture event.
- An earlier API run had43passes/23failures after a new fixture omitted deletion
  `confirm:true`, received400 instead of the expected409, and left its prepared
  claim for subsequent cases. Corrected input/final cleanup passed targeted3cases
  and the final165-test run. Coordinator fixture corrections covered JSONB key
  order and a strict input accidentally containing persisted state. Historical
  failures are not rewritten as successful production executions.

`scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm build` and
`scripts/dev.sh pnpm i18n:check` passed (1242EN/IT/pseudolocale keys). The existing
bundle-size advisory remains. Scoped Biome lint/format and indexed governance
checks cover the final changed files. No historical M1–M5 full-suite rerun or
real-server benchmark was performed. The SFTPGo retained-SSH-transport regressions
were not rerun or claimed fixed; issue#18 remains a production-release gate.

Independent technical review found one pool-headroom issue in preparation;
reusing the existing upload-slot gate resolved it, with a small-pool regression.
No remaining must-fix finding was reported after review of authorization, group
claims, recovery, scheduler and token isolation. Actual browser screenshots were
reviewed for EN desktop/IT mobile progress, completion truthfulness and cancellation:

- [English desktop uploads](screenshots/m5/file-upload-parallel-complete-en-desktop.png)
- [Italian mobile uploads](screenshots/m5/file-upload-parallel-it-mobile.png)
- [Owner concurrency setting](screenshots/m5/file-upload-concurrency-owner-en-desktop.png)

Mobile axe reported0violations and no page overflow; upload rows wrap so the
cancel control remains visible. This is focused evidence, not a new whole-app
accessibility certification. The screenshots contain isolated fixture identities.

API/Vite source watchers picked up the changes; dev services remain healthy and
the HTTPS ingress returned200. No explicit container restart, real game-file
write, production resource mutation, new infrastructure or test server occurred.
Isolated schemas/fixtures used normal teardown; development accounts/data remain
unchanged. Live latency improvement awaits the Owner's next upload, with separate
preparation/token/stream traces. Rollback: drain/close groups, preserve uncertain
claims for reviewed recovery, and revert matching API/browser changes together;
no migration or data reset. PR#21 remains OPEN and unmerged.


## 2026-10-12 — bulk signed upload URLs and extension function list

Blueprint 1.2.0 replaces per-file URL issuance for prepared groups with one
bounded Client API request. The Core API keeps distinct one-use, file-bound
handoffs privately in memory; streaming, independent cancellation and the
existing two-upload default are preserved. A missing older endpoint falls back
to single-file issuance; permission/provider failures do not silently fall back.
No browser receives signed URLs or provider credentials. The extension admin page
now lists its six responsibilities in concise EN/IT bullets.

Focused final results (no historical full-suite rerun):

- Unit: **71 passed** across upload URL cache, adapter bulk uploads, Blueprint
  capability parsing and scoped provider dispatch.
- PostgreSQL/Hono: **80 passed** across `servers.integration.test.ts` and
  `upload-batches.integration.test.ts`; real authentication, claims and recovery,
  mocked external provider. Explicit cache-restart/cancellation regression also
  passed separately before this affected-suite run.
- Chromium: **18 passed** across file-upload cancellation and refresh suites;
  actual application handlers/isolated database, simulated game provider.
- Extension: **133 vendor-backed PHP checks**, **10 package tests**, expanded PHP
  and shell syntax passed. Rendering reuses the SQLite-memory fixture and actual
  Blade engine; production Panel application/database are not bootstrapped.
- Root/WebPanel typecheck, changed-file lint/format and indexed governance passed.
  The first typecheck exposed an incorrect test table shape (array rows spread as
  arguments); corrected to object rows and reran the affected test and typecheck.
- Independent code review caught and resolved canonical path conversion, shared
  refresh snapshots and cancellation propagation. No remaining must-fix finding.
- Actual Blade screenshots reviewed: [desktop EN](screenshots/m5/blueprint-bulk-uploads-desktop-en.png),
  [mobile IT](screenshots/m5/blueprint-bulk-uploads-mobile-it.png); no overflow or
  clipped controls, concise administrator-oriented copy.

The already authorized extension update completed through the standard Blueprint
installer, with a private pre-update backup. No migration was pending. Native
Client middleware/route registration verified. Live protected-store smoke:
**49 URLs / 1 request / 281.793 ms**, valid 900 seconds; **zero file uploads**.
Anonymous/Application-key/invalid-count checks returned **401/403/422**. This is
URL issuance timing only, not a new 49-file transfer benchmark. Previous upload
measurements and failure history remain unchanged. API, worker, Vite and Panel
were healthy afterward; no container restart, game command, game-file mutation,
network change or database reset occurred. Issue #18 remains a release gate.

Full commands, artifact hash, evidence boundaries and rollback are in the
[extension record](BLUEPRINT-EXTENSION.md#2026-10-12--120-bulk-upload-credentials).


## 2026-10-12 — granular upload timing experiment

The Owner authorized granular timing after the three unchanged-code upload runs.
Those 147 successful uploads remain the pre-instrumentation baseline: mean
59.732 ms/file, including 14.437 ms for the provider phase and 45.295 ms outside it.
No upload optimization or policy change is included in this experiment.

A bounded request-local collector adds `atomic` count/total/max durations to the
existing final upload event, without per-query logging, SQL text/arguments,
content, paths or credentials. Connection acquisition, session/permission reads,
identity proof, locks, claim read/update/delete, validation, serialization/hash,
audit, transaction entry/tail and release are distinguished. The provider phase
also exposes its repeated local permission checks. Query times include database
round trips and waiting; they do not isolate database-engine execution. Nested
and parallel spans must not be summed as independent wall-clock costs.

Focused validation:

- Timing collector: **5 unit tests passed** (overlap/isolation, count/rounding,
  bounds, disabled mode and error transparency).
- Durable upload batches: **12 integration tests passed**, including independent
  concurrent traces, failed admission with rollback, no mutation on refusal,
  intermediate UPDATE and final DELETE.
- API 49-file uploads, cache restart/cancellation and encrypted account lookup:
  **3 targeted integration tests passed, 73 intentionally skipped**. Trace fields
  survive redaction, contain numbers only and do not expose fixture private data.
- Typecheck passed after correcting two TypeScript narrowings captured in timer
  callbacks; focused Biome and diff checks passed. No browser/full historical
  suite rerun: browser behavior and request contracts are unchanged.
- Independent source review found no must-fix; ordering, lock release, rollback
  and original errors are preserved. No new query, retry or provider call is added.

Synthetic overhead measurement used 40 resolved-promise operations per request,
a snapshot, existing logger redaction and JSON serialization: five alternating
samples of 1,000 requests after warm-up. Incremental elapsed cost was
**0.111–0.126 ms/request**, median **0.116 ms**. This excludes Docker stdout I/O,
real database/network waits and live scheduling; it is not a performance bound or
proof of zero measurement perturbation. Serialized output is larger but remains
one event per file. Private benchmark output is retained with the timing records.

Existing dev source watchers load the code; API and worker health checks pass,
container restart counters remain zero. No manual restart/rebuild, infrastructure
change, game-file operation or new live test asset. Detailed live results await
the Owner's next upload. Rollback is a source revert; no migration or data reset.
Issue #18 remains unchanged; PR #21 remains open and unmerged.

Commands: `scripts/dev.sh pnpm exec vitest run
packages/server-management/src/upload-timing.test.ts`; isolated wrapper
`scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run
--config vitest.integration.config.ts packages/server-management/src/upload-batches.integration.test.ts`;
same wrapper for `apps/api/src/servers.integration.test.ts
packages/server-management/src/provider-accounts.integration.test.ts -t
'prepares 49 files once|normalizes real bulk handoffs|enrolls once, encrypts credential'`;
`scripts/dev.sh pnpm typecheck`, changed-file Biome and indexed governance.

## 2026-10-12 — scoped upload locks, authorization and atomic completion audit

The first Owner run with granular timing at `8c8c39c` completed **49/49 files**,
3,952,843 bytes, in **3,229.945 ms** including 528.945 ms preparation. Mean per-file
time was 81.717 ms: 64.156 ms outside the provider phase and 17.561 ms inside it.
The latter already included 9.626 ms of local authorization. This is a different
sample from the previous 147-file baseline; the difference is not attributed to
instrumentation. The two global resource-lock calls averaged 16.474 ms combined,
but their combined median was 2.019 ms. These spans include communication and
scheduling, not only lock contention. Connection acquisition averaged 0.066 ms;
validation/serialization/hash together averaged 0.550 ms. Original private traces
are retained; no paths, credentials or file contents are published.

Following the read-only analysis and explicit Owner instruction, the changes are:

- Entry admission and intermediate settlement use the existing batch row lock.
  They do not change reserved capacity and no longer acquire the platform-wide
  resource lock. Final release first rolls back a decision-only transaction, then
  re-reads once under global → row locks. This keeps the reservation visible across
  other admissions' filesystem-observation/capacity-sum interval and avoids a
  row → global deadlock. Preparation, cancellation, close and recovery are unchanged.
- Successful settlement preserves both completion event names and metadata in
  one audit INSERT within the same transaction. The separate `files.uploaded`
  autocommit is removed; an audit failure rolls back the settlement too.
- Only actual binary batch transfers defer the second access recheck to the fresh
  pre-POST authorization. That check also compares complete managed identity and
  upload binding. All three stream checkpoints and periodic checks remain.
- `/v1` no longer reads the session once for locale and again for authentication.
  Authentication remains fresh per request; errors before authentication obtain
  stored locale lazily without masking the original error if that lookup fails.

No schema, dependency, provider endpoint, UI or infrastructure change is required.
The two durable boundaries before and after provider dispatch remain. No external
effect is retried by the internal final-release transaction fallback.

Validation used existing approved isolated M2 PostgreSQL/Redis services, temporary
per-test schemas, real application/authentication handlers and external-provider
fixtures. Commands and results:

- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/transfers.test.ts packages/pterodactyl-adapter/src/bulk-uploads.test.ts apps/api/src/upload-url-cache.test.ts packages/server-management/src/upload-timing.test.ts --reporter dot`: **78 passed**.
- Integration prefix: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts`.
- Prefix + `packages/server-management/src/upload-batches.integration.test.ts`: **15 passed**. Proves intermediate progress while the global lock is held, final release waiting without holding its row, the filesystem-observation/accounting race, atomic audit rollback, concurrency, cancellation, uncertainty and recovery.
- Prefix + `packages/server-management/src/directory-identity.integration.test.ts`: **59 passed** on the initial set. One additional case and a fixture property correction were finalized during this run; prefix + that file + `-t 'binary batch|batch bookkeeping'` then passed **13**, with 47 unrelated skipped. All 60 cases are covered across these runs; this is not a claimed single final 60-case run.
- Prefix + `apps/api/src/servers.integration.test.ts apps/api/src/app.integration.test.ts --reporter dot`: **81 passed**. The real-handler 49-file fixture proves only one global release-lock acquisition, no second access authorization or separate completion audit, two transfers concurrently, and both completion events for each file. Session/identity changes after admission cause zero Wings POSTs and release unused capacity. Existing real HTTP-disconnect tests emit expected abort diagnostics and pass.
- Two new localization/session cases first passed independently. A later TypeScript check caught a JSON predicate fixture passing a serialized string instead of its typed object. After correcting it, prefix + `apps/api/src/servers.integration.test.ts -t 'rejects batch .* drift after admission'` passed **2**, 70 skipped. Root TypeScript rerun passed; full root/web `pnpm typecheck` had passed before that test-only addition.
- Changed-file Biome, `git diff --check` and indexed governance passed. No expensive historical M1–M5/browser rerun: UI, browser contracts and transfer-guard checkpoints are unchanged.

Independent technical review found no must-fix. API/worker source watchers loaded
the changes; both are healthy with container restart counts zero. No manual
restart/rebuild, production-provider request, game-file mutation, network change
or new live test asset was performed. Test schemas are removed by their fixtures.
The live performance improvement remains to be measured with the Owner's next
upload; removed spans must not be summed as guaranteed wall-clock savings.
Rollback is a source revert with no migration/data reset. PR #21 remains open and
unmerged; the SFTPGo issue #18 production-release gate is unchanged.

## 2026-10-12 — upload timing diagnostics opt in through debug logging

Following the Owner's decision to close upload performance tuning, preparation,
per-file stage and atomic timing diagnostics now use the existing effective API
`logLevel=debug` (`NH_LOG_LEVEL=debug` as an explicit environment override).
Default `info` skips collection, snapshots, payload construction and emission;
it does not merely filter an already-collected trace. Request errors and durable
audit records remain unchanged. Enabling diagnostics requires the normal API
process reload. No new setting, schema, provider operation or request is added.
Earlier measurements and failed attempts above remain historical evidence.
Gateway and lifecycle diagnostics are outside this upload-only cleanup.

Validation:

- `scripts/dev.sh pnpm exec vitest run packages/core/src/core.test.ts packages/server-management/src/upload-timing.test.ts`: **54 passed**. Covers effective log levels, redaction and the existing timing collector.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts -t 'omits upload diagnostics|49 uploads|prepares 49 files once'`: **3 passed, 70 intentionally skipped**. Uses real handlers/authentication and the existing approved isolated PostgreSQL/Redis stack with provider fixtures. Both batch and legacy uploads succeed at `info`, without collectors/traces; durable upload audits and failed-request errors remain. Both 49-file diagnostic paths still emit their timings at `debug`.
- `scripts/dev.sh pnpm typecheck`: root and WebPanel passed. Changed-file Biome, diff and indexed governance checks passed.
- Independent read-only technical review found no must-fix: authorization, locks, streaming order, audit and error handling are unchanged. No browser or historical milestone suite rerun; no UI or transfer behavior change.

Read-only dev checks confirm effective API log level **info**, healthy API/worker
and zero container restart counts. Existing source watchers load the changes;
no manual restart/rebuild, production-provider call, game-file mutation, new
test asset or infrastructure change. The disposable integration schema is
cleaned by its fixture. Rollback is a source revert with no migration/data reset.
PR #21 remains open and unmerged; SFTPGo issue #18 is unchanged.

## 2026-10-12 — active upload cancellation without a stale reservation

The Owner's new batch completed 100 small files, but cancelling two concurrent
450 MiB files retained two uncertain entries. Browser abort previously closed
the provider socket before NickHosting could learn the result; the browser also
released its scheduler slot before backend settlement. Subsequent writes were
correctly blocked by that unresolved reservation, but normal cancellation had
no way to settle it automatically.

The adapter now sends chunked multipart, retaining declared-byte enforcement and
bounded streaming. Browser abort before the final boundary closes an incomplete
form and waits for Wings' native parser rejection. Only its exact HTTP 400 error
body, bounded to 1 KiB, establishes cancellation before final writes. Generic
errors, missing responses, timeouts and aborts after a complete form remain
conservative; no destructive compensating delete or automatic upload replay is
introduced. This follows the existing parse-before-write path in
[Wings 1.11.13](https://github.com/pterodactyl/wings/blob/v1.11.13/router/router_server_files.go)
and multipart cleanup behavior in
[Go ReadForm](https://github.com/golang/go/blob/go1.23.6/src/mime/multipart/formdata.go).
Go attempts temporary-file cleanup on parsing failure; filesystem accounting
still applies if cleanup itself fails. No Wings patch is needed.

The browser keeps cancelled slots occupied while checking authenticated batch
status for at most five seconds. Only `operation_busy` is retried. An unresolved
result remains visible and prevents a new batch; admitted siblings can finish.
Normal successful uploads add no polling. `closed:true` proves the reservation
ended, not absence of a file whose upload may have completed before a late abort.
Upload diagnostics remain opt-in at `debug`.

Focused validation (existing approved isolated database/Redis, disposable schemas,
real API/authentication and browser handlers, fixture provider writes):

- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/transfers.test.ts`: **51 passed**, including real loopback HTTP multipart cancellation, native versus unrelated 400, lost responses, late abort and body-error/abort ordering.
- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/bulk-uploads.test.ts packages/pterodactyl-adapter/src/adapter.test.ts`: **75 passed**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts -t 'upload|binary|stream'`: **31 passed, 43 intentionally skipped**. Two actual browser-side HTTP disconnects settle two cancellation audits, zero fixture writes, release the claim and permit another batch; unauthorized status access is rejected. Initially an existing never-responding provider fixture waited the default 30-second idle timeout and hit the test deadline, causing 13 cascading failures (18 passed). Setting that fixture's idle timeout to 50 ms corrected the test; the final complete selected run passed. Production timeouts are unchanged.
- `LD_LIBRARY_PATH="$HOME/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu" scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-upload-cancel.browser.test.ts`: **13 passed**. Covers two held cancellation acknowledgements, busy status retry, next-batch sequencing, sibling independence, no claims left, subsequent upload/delete and normal uploads without status polling. An initial 12-pass/1-fail run exposed a missing `confirm:true` in the new fixture's final delete; correcting the fixture yielded the final 13-pass run.
- `scripts/dev.sh pnpm typecheck`: root and WebPanel passed. Changed-source Biome, `git diff --check` and indexed governance checks passed. No full historical suite, layout changes or new screenshots.

Independent review found and resolved one must-fix: status polling now uses the
existing upload-slot gate rather than competing without bounds for reserved DB
connections. Final review found no remaining must-fix; late-abort semantics above
remain explicitly conservative.

The old dev claim was recovered through the existing Owner recovery service,
with exact scope hash, current session, exclusive claim lock and an audit event.
Read-only evidence corroborated provider ID/UUID/external identity, both cancelled
destination files absent, 100 HTTP 200 upload responses followed by two completed
HTTP 400 responses, and no multipart temporary files in the current Wings `/tmp`
archive metadata. The 100 completed files were preserved. The claim is absent and
exactly one recovery audit exists. Private identities and evidence remain ignored.
No provider file deletion, game-server mutation or production configuration change
was performed; no live upload was generated by Codex for this fix.

API, worker and Vite remain healthy with container restart counts zero; existing
source watchers load the correction. No manual restart, new infrastructure or
live test asset. Rollback is a source revert without migration; reverting does not
recreate the manually recovered stale reservation. PR #21 remains open/unmerged,
and SFTPGo issue #18 remains a separate production-release blocker.

## 2026-10-12 — automatically clear finished upload rows

Completed and confirmed-cancelled uploads now disappear from the visible queue;
failed/uncertain entries stay visible alongside pending transfers. Removed the
clear-finished link and partial-file disclaimer, with EN/IT/pseudolocale catalogs
updated. An empty queue hides its section. Backend settlement, cancellation and
retry behavior are unchanged.

Independent review caught an initial UI approach that discarded completed state:
it would lose overwrite confirmation before a slow directory listing refreshed.
The final change filters visible rows while preserving that existing state and
guard. A browser regression holds the stale listing and verifies that uploading
the same filename still requires replacement consent. Final review found no
remaining source must-fix.

Validation uses the existing approved isolated M2 database/Redis stack, real
application handlers and browser, and fixture provider effects. Browser command
prefix: `LD_LIBRARY_PATH="$HOME/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu" scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.

- Prefix + `apps/web/tests/file-upload-cancel.browser.test.ts`: **12 passed, one timeout** while awaiting the next batch after two cancellations. Prefix + the same file + `-t 'waits for both active cancellations'`: **1 passed, 12 skipped**, without product or test-behavior changes (only failure diagnostics added). The first timeout's exact cause is unconfirmed; this is not a claim of a clean single full-file run.
- Prefix + `apps/web/tests/file-upload-refresh.browser.test.ts apps/web/tests/file-manager.browser.test.ts apps/web/tests/services.browser.test.ts -t 'M5 uploads coalesce|uploads multiple files sequentially|uploads a whole folder|streams a 12 MiB binary'`: **9 passed, 46 skipped**. Includes held/failed listings, directory changes, uploads with collisions, replacement confirmation, folder uploads and binary transfer integrity.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, `scripts/dev.sh pnpm i18n:compile`, `scripts/dev.sh pnpm i18n:check`: passed; 1,240 keys in each compiled locale. Changed-source/test Biome exits zero with three pre-existing non-null-assertion warnings in `services.browser.test.ts`. Diff and indexed governance checks passed. No historical backend/milestone suite rerun.

Real rendered screenshots independently reviewed: [cleared desktop queue](screenshots/m5/file-upload-auto-clear-en-desktop.png), [failed and pending transfers](screenshots/m5/file-upload-failed-pending-en-desktop.png), [cleared Italian mobile queue](screenshots/m5/file-upload-cleared-it-mobile.png). Previous screenshots and failure evidence are retained.

Only WebPanel presentation, translations and tests changed. Existing Vite HMR loads
the update; no container restart, provider operation, production mutation or new
live asset. Test fixtures clean their isolated schemas/files. Rollback is a source
revert, without migration or data reset. M5 PR #21 remains open and unmerged;
SFTPGo #18 is unchanged.


## 2026-10-12 — large file selections without the 100-item UI cap

Removed the uniform 100-item selection/drag/API restriction. Delete and move
validate the complete selection before dispatch, then use sequential provider
batches of at most 1,000 entries, with authorization before each batch. Planning
indexes directory contents once per request instead of rereading a directory for
every selected file. Invalid/protected paths, duplicate/case aliases, overlapping
sources and unapproved replacements fail before the first remote effect. A lost
response or later-batch failure remains uncertain, without replaying completed
batches or claiming the failing batch made no changes.

ZIP downloads now submit the manifest through a native streamed POST rather than
an oversized query string. Legacy GET remains supported. The temporary form is
removed immediately; successful attachments use the browser download manager,
while HTTP errors open separately instead of replacing the workspace. A Chromium
probe established that `no-referrer` gives native POST `Origin: null`; the page
now uses `same-origin`, retaining suppression of external referrers and Core's
normal Origin/session enforcement. No CSRF bypass or provider token exposure.

Remaining workload limits are explicit: 4 MiB manifest bodies on the three file
selection endpoints, 10,000 recursively enumerated ZIP entries, and 20,000 copy
entries / 16 GiB, with depth 64. The manifest limit does not limit transferred file
bytes. Copy's later per-write source/destination checks do not reuse planning
snapshots. Removed the obsolete EN/IT selection-limit message.

Focused checks used existing approved isolated M2 PostgreSQL/Redis resources,
disposable schemas, real application/authentication/browser handlers and fixture
provider effects:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/file-operations.test.ts`: **58 passed**, including 2,501-entry dispatch, pre-dispatch rejection, later revocation, uncertain partial effects and indexed planning budgets.
- `scripts/dev.sh pnpm exec vitest run apps/api/src/file-browsing.test.ts apps/web/src/api/client.test.ts`: **57 passed**, including 512-file streamed POST, malformed/duplicate fields, authorization, recursive archive budget and native form cleanup. Initial run: 56 passed and one pre-existing editor assertion failed. A temporary baseline test confirmed that existing parallel ancestor validation already reads both root and child before rejecting a new symlink. The corrected test asserts those exact fresh reads and no additional content read/write instead of the obsolete serial call count; editor production behavior did not change.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/file-operations.integration.test.ts`: **28 passed**. Covers 1,001 moves as 1,000 + 1, conflict at the end before any dispatch, 2,001-entry partial failures without a third request, copy over 100 roots and existing overwrite/recovery regressions.
- Same integration command with `apps/api/src/servers.integration.test.ts -t 'protects Minecraft launch inputs|larger bounded POST archive'`: **2 passed, 73 intentionally skipped**. Covers 1,001 deletes, late protected/invalid paths before any mutation, missing/null/forged Origin rejection, valid manifest over 64 KiB and 4 MiB body rejection.
- `LD_LIBRARY_PATH="$HOME/.cache/nickhosting-playwright-libs/root/usr/lib/x86_64-linux-gnu" scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts -t 'more than 100 selected|keyboard context menus, range selection'`: **2 passed, 28 intentionally skipped**. Real Chromium selects 128 long-named files, downloads their ZIP through POST without leaving the SPA, copies them, moves them in one provider call and deletes them in one provider call. Existing keyboard/context-menu/overwrite behavior also passes. Test files and disposable schemas are cleaned by fixtures.
- `scripts/dev.sh pnpm typecheck` and `scripts/dev.sh pnpm i18n:check`: passed (1,239 keys per locale). Initial typecheck caught two new test-only mock/error typings; both were corrected before this final pass. Changed-source/test Biome passes with one pre-existing informational template-string suggestion. Diff and indexed governance checks passed. No historical full-suite rerun.

Independent source review found no remaining must-fix. Reviewed the actual browser
[screenshot with 128 selected files](screenshots/m5/file-selection-large-en-desktop.png):
bounded listing, enabled compact actions, long names truncated without overflow,
no obsolete selection warning. No unrelated visual redesign.

No container/network changes, manual restart, production provider mutation or live
test asset. Existing development source watchers can load the change. Rollback is
a source revert, without database migration or reset. PR #21 remains open and
unmerged; SFTPGo #18 remains an independent production-release blocker.


## 2026-10-12 — background reconciliation without remote-I/O server locks

The intermittent file `operation_busy` response originated before provider dispatch
at the per-server advisory lock. Read-only development sampling found the worker
holding that lock during periodic provider reads: four windows of approximately
400–500 ms, 19 occupied samples among 180 at 100 ms intervals. The historical
failed request's individual lock holder was not logged; the periodic worker
contention was independently observed, and no pending upload claim or active
lifecycle operation remained at inspection.

Reconciliation now collects provider/host evidence without a server lock, pinned
connection or open transaction. A single short database transaction checks
PostgreSQL row revisions and applies installation/runtime/readiness, metrics,
reservations and events. The revision check detects an operation that begins and
ends during collection even if its final values/timestamps equal the originals;
newer observations, identity/configuration/allocation changes and new reservations
also invalidate old results. Potentially blocking resource/row locks precede the
nonwaiting server-lock attempt. A busy/stale pass returns deferred and refreshes
no observation timestamp. The existing cached-running-after-stop safeguard remains.
Lifecycle effects, upload/file mutual exclusion and resource admission are unchanged.
No automatic retry of external effects or extension of stale host samples.

`POST /v1/owner/reconcile` now includes `deferred` server IDs and only counts
accepted observations in `observed`, rather than counting skipped passes as
successful. Contracts and resource-operation documentation were updated.

Validation used the already approved isolated M2 database/Redis stack, disposable
schemas and fixture provider effects, without creating containers:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/lifecycle.integration.test.ts`: **196 passed, one new fixture failed**. All 185 existing cases passed. The new fixture attempted to alter immutable allocation identity and was correctly rejected by the database before exercising the race. It was corrected to change permitted allocation protocol metadata; the production immutability guard was retained.
- Same command plus `-t 'unlocked reconciliation|stale running reconciliation|does not suppress a current observation'`: final **14 passed, 183 skipped**, covering all 12 new collection/concurrency/atomic rollback cases and two cached-stop regressions after the final ordering correction. This is targeted final validation, not a claim of a second clean full-file run.
- Same integration prefix with `packages/server-management/src/runtime.integration.test.ts -t 'reconciliation|partial external recovery|two-connection pool'`: final **4 passed, 57 skipped**. A held provider response permits an actual authorized file-mutation callback exactly once while leaving the old observation untouched; busy reconciliation is reported deferred, external recovery errors remain visible and the existing two-connection upload contention/revocation behavior is preserved. Initial run had two new fixture failures (one timeout awaiting a provider stage never reached): the identity-only helper lacked `container.installed`. A direct diagnostic confirmed that omission; adding installed metadata to these two fixtures resolved it without product changes.
- `scripts/dev.sh pnpm typecheck`: root and WebPanel passed. After final test/code edits, `scripts/dev.sh pnpm exec tsc --noEmit` passed again. Changed-file Biome, diff and indexed governance checks passed. No historical milestone-wide or browser suite rerun; no UI layout change or new screenshot.

Independent technical review found no remaining must-fix. It checked lock order,
revision guards, competing Gateway state updates, capacity accounting and test
coverage. Review specifically confirmed that live sampling is not proof that
legitimate contention is impossible.

Existing dev source watchers loaded the correction. Read-only post-change
sampling over 18 seconds found **one occupied sample among 357 at 50 ms intervals**,
with three subsequent observation timestamp advances. The earlier sustained
remote-I/O lock windows were not observed; brief atomic apply still takes a lock.
This sampling is observational, not a precise lock-duration benchmark. API and
worker health remained healthy, container restart counts remained zero, and no
new warning/error was observed in the inspected worker window. Source-watcher
process reloads occurred; no manual container restart or infrastructure change.

No real game-server command/file mutation, new live asset, network change,
credential change or production deployment. Test schemas are disposed by their
fixtures. Rollback is a source revert, without migration/data reset. PR #21 stays
open and unmerged; SFTPGo #18 remains a separate production-release blocker.

### 2026-10-12 — completed-upload hints and folder restoration

Fixed the browser-only upload/delete/reupload conflict: hidden completed queue
entries were permanently treated as existing files. They are now retired after
an already-required successful directory listing started after their completion.
A delayed older listing, failed read or aborted navigation cannot discard newer
completion hints. This adds no provider request or per-file verification. Folder
paths are remembered per browser tab, server and authenticated actor/subject
(including support-session identity); reload returns to the current folder.
Blocked browser storage degrades to ordinary non-persistent navigation.

Validation:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-upload-refresh.browser.test.ts`: **9 passed**, 34.45 seconds. Real browser/application handlers and disposable database schema with fixture provider: root/nested upload→delete→reupload, nested-folder reload/root reset, delayed/failed listings, navigation, unmount and folder uploads. Existing true-overwrite consent regression preserved.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed.
- Changed-file Biome, whitespace and indexed governance checks: passed.
- Independent read-only review: no must-fix findings. Explicit browser-storage-denied and cross-identity persistence coverage remain optional additions, not claims of tested scenarios.

Only the existing isolated test services were used; fixtures dispose their
schemas and temporary test assets. No real server file operation, container
restart, production/infrastructure change, or new resource. Development uses
its existing Vite HMR. No layout change or new screenshot; no historical full
suite rerun. PR #21 remains open and unmerged; rollback is a source revert.

### 2026-10-12 — debug-only editor opening timings

Added `server.file_editor_open`, one aggregate diagnostic per editor GET only
when the API logger enables `debug`. It records principal/configuration setup,
connection acquisition/release, both local authorization passes, remote identity
fetch versus local identity verification, sequential directory reads, content
read, decode, revision hashing and response serialization. Labels contain no file
paths, names, content, credentials or provider error text. Request/server IDs,
byte count, outcome and handler duration allow correlation. Depths >=31 share a
bounded directory phase with a count. `editor.access` includes its nested phases;
do not add it to those children. Client calls include credential resolution and
transport time, not separately instrumented here. Handler duration excludes
response delivery and browser rendering. No performance or authorization policy
was changed; editor reads still perform fresh identity corroboration.

Validation: `scripts/dev.sh pnpm exec vitest run apps/api/src/file-browsing.test.ts packages/server-management/src/upload-timing.test.ts`
**64 passed** (2.82 seconds), including debug/off logging, failed read, redaction
and diagnostic sink failure. `scripts/dev.sh pnpm exec tsc --noEmit`, changed-file
Biome, whitespace and indexed governance passed. Independent review found no
must-fix and confirmed inclusive phase semantics. No historical/browser suite
rerun for this server-only diagnostic change.

Development already has database `logLevel=debug` with no environment override.
Existing source watcher reloaded the API; read-only inspection found it healthy
with container restart count zero. No manual restart, configuration/state change,
real file operation or new infrastructure/test asset. Ready for the Owner's next
file opening; no live timing result claimed yet. Revert the source change to roll
back; `info` disables this trace on API logger initialization. PR #21 remains open
and unmerged; SFTPGo #18 remains unchanged.

### 2026-10-12 — direct editor reads with reused identity proof

The Owner's 10 KiB opening measured **778.194 ms** inside the API: identity fetch
170.106 ms, local identity verification 4.627 ms, ancestor listings 199.820 and
186.002 ms, contents 208.544 ms, decode/hash 0.390 ms. This is the pre-change
measurement; it excludes browser rendering and response delivery.

Editor GET now uses the same 60-second non-sliding identity proof as folder
browsing, retaining fresh local session/permission checks, binding invalidation,
background renewal and expiry behavior. It requests contents directly without
listing ancestors. The pinned Panel/Wings source evidence and containment limits
are documented in M5-API-CONTRACTS.md. No live symlink/adversarial filesystem test
was performed. PUT path/revision/game-file guards remain unchanged. The browser
still excludes listed symlinks. API reads enforce local path/extension validation,
strict text decoding and bounded bytes; oversize responses, with or without a
length header, cancel the stream and return 413. Missing content returns 404;
other provider failures do not trigger alternate-path retries. Debug timings
remain enabled for the Owner's next measurement; no post-change latency promised.

Checks:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/file-browsing.test.ts packages/pterodactyl-adapter/src/adapter.test.ts packages/pterodactyl-adapter/src/transport.test.ts`: initial **126 passed, 1 failed** because the trace test still expected the deliberately removed directory phases. Corrected that assertion, added provider-refusal coverage, then reran `scripts/dev.sh pnpm exec vitest run apps/api/src/file-browsing.test.ts`: final **66 passed**. Adapter/transport **63 passed** in the initial run; their source/tests did not change afterward.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/directory-identity.integration.test.ts`: **65 passed**, 87.34 seconds. After extending the final single-connection case, targeted rerun with `-t 'single-connection pool'`: **1 passed, 64 skipped**, 3.45 seconds. Covers warm/cold/expired proof, revocation, identity/account drift and pool safety.
- `scripts/dev.sh pnpm exec tsc --noEmit`, changed-file Biome, whitespace and indexed governance: passed. Independent technical review: no must-fix. No browser/layout change or full historical suite rerun.

Only existing approved isolated services/fixture providers and disposable schemas
were used; integration fixtures dispose their schemas. No real server/file
operation, new infrastructure, credential change or manual container restart.
Existing watcher loaded the API; read-only health check was healthy with container
restart count zero. Rollback is a source revert. PR #21 stays open/unmerged;
SFTPGo #18 remains a separate production-release gate.

### 2026-10-12 — editor provider-read timing breakdown

The first optimized Owner opening succeeded in **238.379 ms** for 10 KiB, versus
778.194 ms before: 217.167 ms content read, 6.864 ms cached identity proof and
14.348 ms other handler work. These are individual backend observations, not a
browser/render benchmark. The content-read aggregate is now split, only in debug,
into `file.serverRead`, existing resolver labels `url.ownerRead`, `url.accountRead`
and `url.decrypt`, `file.adapterCreate`, `file.httpHeaders` and `file.bodyRead`.
No additional queries/requests or credential caching were introduced. The timing
object is passed per read through the scoped adapter, never stored globally.
Header timing includes transport preparation, remote response and status checks;
body timing includes bounded consumption/cancellation. Neither separates the
remote Panel from Wings or measures pure network latency. All remain nested in
`editor.readContent`; do not add parent and child totals together.

Checks: `scripts/dev.sh pnpm exec vitest run apps/api/src/file-browsing.test.ts packages/server-management/src/scoped-provider-adapter.test.ts packages/server-management/src/upload-timing.test.ts`
**100 passed**; `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/adapter.test.ts`
**56 passed**, including deterministic separated header/body waits, failures,
oversize responses and untimed behavior. TypeScript (`scripts/dev.sh pnpm exec tsc --noEmit`),
changed-file Biome, whitespace and indexed governance passed. Independent source
review found no must-fix. No full integration/browser suite rerun for diagnostics.

Existing dev debug logging/source watcher retained; API observed healthy with zero
container restarts. No real file mutation, new test asset, manual restart,
production/configuration change or infrastructure operation. Awaiting the next
Owner opening for the new phase measurements. Rollback is a source revert; PR #21
remains open/unmerged and SFTPGo #18 remains unchanged.

### 2026-10-12 — prepared editor/download URLs and Blueprint 1.3.0

The approved change prepares path-specific, one-use Wings download URLs from the
existing authorized folder listing. Preparation runs in the background without
another directory query. Editor GET and streamed downloads share a bounded,
credential/managed-identity-bound backend cache. Taking a URL removes it before
concurrent access and replenishes only that path. Cold reads wait for issuance;
unused entries expire without recurring renewal. Mutation verification reads and
revision checks are unchanged. Signed URLs never reach browser responses or logs.
Blueprint now exposes configurable batch limits, signed URL lifetime and bounded
webhook delivery settings; existing settings and omitted fields are preserved.
See [contracts](M5-API-CONTRACTS.md#prepared-file-download-urls-blueprint-13) and
[extension settings/evidence](BLUEPRINT-EXTENSION.md#2026-10-12--130-prepared-downloads-and-operational-settings).

Focused validation, without rerunning the historical M1–M5 matrix:

- Vendor-backed extension PHP harness: **207 assertions passed**; package tests:
  **11 passed**; expanded extension PHP syntax: **25 files passed**. Commands:
  `python3 extensions/nickhosting/tests/run_php_tests.py --container <existing-panel>`,
  `python3 -m unittest discover -s extensions/nickhosting/tests`, and
  `python3 extensions/nickhosting/package.py`. Framework fixtures use an in-memory
  SQLite database; no production database is used by those assertions.
- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/bulk-downloads.test.ts packages/pterodactyl-adapter/src/bulk-uploads.test.ts packages/pterodactyl-adapter/src/adapter.test.ts packages/pterodactyl-adapter/src/transfers.test.ts packages/pterodactyl-adapter/src/blueprint.test.ts`:
  **178 passed**; after the final upload TTL/timeout adjustment,
  `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/bulk-uploads.test.ts`:
  **30 passed**. Coverage
  includes concurrent token claims, per-path renewal, expiry, settings changes,
  long-path chunking, invalidation, bounded cache pressure, stream bounds and
  refusal without fallback on authorization/throttling/malformed responses.
- `scripts/dev.sh pnpm exec vitest run apps/api/src/file-browsing.test.ts packages/server-management/src/scoped-provider-adapter.test.ts`:
  **99 passed**. Proves prepared editor reads, unchanged write verification and
  per-owner scoping of every new adapter operation.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/directory-identity.integration.test.ts`:
  initial **66 passed, 1 failed**. The new revoked-session fixture referenced the
  wrong user property and therefore deleted no session. Corrected the fixture;
  targeted rerun with `-t 'prefetch'`: **2 passed, 65 skipped**. Covers 600 paths
  without another listing, nonblocking prefetch, optional issuance failure and
  fresh authorization. This is not a claim of a second full-suite run.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts`:
  initial **73 passed, 2 failed**. One provider fixture needed the new settings
  endpoint; another asserted an exclusive lock during remote reconciliation I/O,
  superseded by the earlier short-commit-lock implementation. Independent review
  confirmed the lifecycle implementation was unchanged and its lock checks remain
  covered. Updated those fixtures/assertions, then reran with
  `-t 'normalizes real bulk handoffs|allows upload while reconciliation'`:
  **2 passed, 73 skipped**. Existing busy-operation/concurrency cases passed in
  the initial run; no lifecycle checks were removed from product code.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/services.browser.test.ts -t 'editor|download'`:
  **2 passed, 18 skipped**, using real application handlers with isolated database
  state and fixture external providers. No real game-file mutation.
- `scripts/dev.sh pnpm exec tsc --noEmit` and
  `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed. An earlier
  typecheck caught the same incorrect fixture property above before its correction.
  Changed-file Biome: **18 files passed**, no changes needed. Whitespace and
  indexed governance passed: **650 text files, 199 review PNGs, 561 relative links,
  4 TOML files and 44 ignore cases**. The heuristic secret scan passed; private
  credentials, helpers, backups and signed URLs remain untracked.

Independent technical review found and resolved stale cached-TTL handling, response
byte budgeting for long paths, repeated set construction across chunks, stranded
pending-cache entries after a reservation failure, and invalidation allocating a
new scope under cache pressure. Final review found no remaining must-fix.
Reviewed sanitized, actual framework-rendered administrator fixtures:
[desktop EN](screenshots/m5/blueprint-transfer-settings-desktop-en.png) and
[mobile IT](screenshots/m5/blueprint-transfer-settings-mobile-it.png). These prove
rendering of the extension form, not a live administrator save or full accessibility
certification. No NickHosting frontend layout was changed.

The Owner-authorized standard Blueprint update installed **1.3.0** successfully;
its hook reported **Nothing to migrate**. The previous artifact and scoped code
backup remain private. Blueprint performed its normal cache/queue/ownership
housekeeping. No manual Panel/Wings core patch, network change or game-server
mutation was performed. Separately, the dev API source watcher stalled while
shutting down after edits. Following explicit approval, only
`docker restart --time 20 nickhosting-dev-api-1` was executed. API, worker and Vite
were then running/healthy, and dev HTTPS and Panel login returned HTTP 200. The
watcher shutdown issue was recovered by restart, not claimed fixed in code.

Read-only live smoke used normal stored per-owner credentials and an existing
Owner-selected 10 KiB file. The extension returned its version/capability/settings;
anonymous, Application-key and unsafe-path requests returned **401/403/422**.
One request signed **600 distinct paths in 238.487 ms**, without opening those
synthetic files. Existing-file bytes/hashes matched privately:

| Adapter operation | Observed duration |
| --- | ---: |
| Native contents, three reads | 203.767 / 182.405 / 215.405 ms |
| First cold signed editor read | 344.962 ms |
| Folder background preparation | 180.585 ms |
| Warm signed editor reads | 3.749 / 4.043 / 2.970 ms |
| Warm streamed download | 4.263 ms |

Cold issuance includes settings discovery/token creation. Warm token acquisition
was 0.828–1.694 ms, Wings response headers 1.730–2.267 ms and body consumption
0.126–0.181 ms. These are adapter observations, not browser/whole-handler timings
or statistical performance guarantees. Recorded batch sizes confirm one-path
replacement after consumption, without whole-folder regeneration.

No files were mutated; no new game/test infrastructure was created. Isolated test
schemas were disposed by the existing fixtures. Unused signed credentials expire
naturally. Rollback requires reverting NickHosting source and the retained prior
Blueprint artifact through the approved update procedure; no schema rollback is
needed. Further live restart/update operations retain their approval boundaries.
PR #21 remains open/unmerged; SFTPGo #18 remains a separate production-release gate.

### 2026-10-12 — Files entry reset and reload listing snapshot

Leaving the Files workspace clears its saved folder; re-entry through a server
tab or browser Back starts at root. Reload while still in Files keeps the folder.
The symmetric storage effect survives StrictMode replay, and cancelled unsaved-edit
navigation retains the folder/draft. Explicit save recovery remains unchanged.

A bounded, tab-local snapshot of the latest folder metadata now supplies immediate
placeholder rows on reload while the real listing request runs. No file contents,
credentials or signed URLs are persisted. The snapshot is scoped to actor, subject,
support session, server and directory; it is limited to 5000 entries / 1 MiB.
Storage denial/corruption or larger listings use the existing skeleton. React
Query structural sharing and filename row keys retain unchanged rows while applying
additions, removals and metadata changes. Placeholder rows do not retire upload
completion hints or count as a completed provider listing.

Review identified and resolved two cache-identity problems: using `initialData`
would retain snapshots as reset state, so the final implementation uses
`placeholderData`; unscoped in-memory listing keys could relabel data after a
session change, so the shared query factory now includes the identity context.
Folder invalidation after save/copy/move uses prefixes matching the scoped keys.
Identity changes and 401/403/404 listing responses discard the stored snapshot.
Independent final review: no remaining must-fix findings.

Focused checks:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/file-listing-cache.test.ts`:
  **13 passed**, including metadata-only storage, identity/server/folder isolation,
  empty folders, malformed snapshots, size limits and unavailable browser storage.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-upload-refresh.browser.test.ts -t 'restores the current nested folder|returns to root after leaving Files|shows the saved listing'`:
  final **3 passed, 8 skipped**, 16.74 seconds. Real application handlers and
  isolated provider/database fixtures prove reload, root re-entry/Back, cancelled
  and confirmed dirty navigation, visible stale rows during a held response, added/
  changed/removed entries afterward, and unchanged row DOM identity.
  Earlier attempts exposed test synchronization errors: Back was requested before
  route unmount, editor navigation before dirty state committed, and the held
  listing intercepted only the first StrictMode request. Those fixture waits and
  interception were corrected; their failures are not counted as passes.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts -t 'supports keyboard context menus, range selection, batch copy/move and streamed ZIP download'`:
  **1 passed, 29 skipped**, 16.50 seconds, including post-copy/move listing updates.
- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/file-directory-query.test.ts apps/web/src/features/file-background-save.test.ts apps/web/src/features/creation-catalog.test.ts`: **11 passed**, including identity changes and background-save regressions.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed. The first
  final check found a type-only TSX import incompatible with the browser-test
  compiler options; using the existing shared `AuthContext` type fixed it without
  changing runtime behavior or compiler settings. Changed-file Biome passed.
- Whitespace and indexed governance passed: 653 text files, 199 review PNGs,
  561 relative links, 4 TOML files and 44 ignore cases; private state remains ignored.

No layout/copy changes or new screenshots. No historical full-suite rerun, live
game-file mutation, new infrastructure or manual container restart. Existing Vite
HMR loads the frontend; API/Vite were observed healthy. Isolated schemas and test
assets use existing fixture cleanup. Rollback is a source revert; the snapshot is
optional browser state. PR #21 remains open/unmerged; SFTPGo #18 is unchanged.

### 2026-10-12 — Directory prefetch cost investigation

[Directory benchmark report](M5-DIRECTORY-BENCHMARK.md) separates nine read-only
native provider samples, 3,586 isolated HTTP directory requests and actual Chromium cache
measurements. All requests succeeded within the bounded probes. Synthetic provider
throughput is not production capacity evidence. The report records current cache
budgets, background signing amplification, the native 1,000-entry page limit and
recommendations for visible-folder prefetch. No product behavior, Blueprint code
or infrastructure was changed; recursive prefetch remains a proposal.

### 2026-10-13 — Real-provider directory fixture benchmark

The Owner explicitly authorized creating `dirscan-test` on their sole managed
server. The [benchmark follow-up](M5-DIRECTORY-BENCHMARK.md#2026-10-13--owner-authorized-real-provider-fixture-test)
records native setup writes, fixture-only provenance and 290 successful real
directory GETs across 120 paths. The 111-directory recursive traversal took
14.306 seconds at concurrency two. Concurrency four reduced a 24-folder batch to
2.032–2.113 seconds but coincided with brief Panel CPU peaks above five cores;
no claim of cost-free or indefinitely sustainable prefetch is made. No guard,
error or rate limit fired. The fixture remains for scoped cleanup; no existing
game content, power state, provider configuration or infrastructure was changed.
This is benchmark evidence only, not an implementation of recursive prefetch.

### 2026-10-13 — Blueprint 1.4.0-dev directory batch trial

The Owner selected a reversible Blueprint batch experiment before considering
direct Wings access. New explicit adapter methods and extension routes read
metadata for several directories under one native Client authorization. Normal
file-manager listing, download preparation and cache policy remain unchanged.
No recursive browser prefetch or node-wide token export was added.

Focused checks on the final implementation:

- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/directory-batch.test.ts packages/pterodactyl-adapter/src/blueprint.test.ts packages/pterodactyl-adapter/src/adapter.test.ts packages/pterodactyl-adapter/src/transport.test.ts`:
  **130 passed**, four files.
- `scripts/dev.sh pnpm exec tsc --noEmit`: passed.
- `python3 extensions/nickhosting/tests/run_php_tests.py --container <existing-panel-container>`:
  **265 checks passed**, Composer-only SQLite-memory/fake HTTP harness; no live
  application bootstrap or production database writes.
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s extensions/nickhosting/tests -p 'test_*.py'`:
  **12 passed**. Deterministic allowlisted archive and expanded manifests verified.
- **32 expanded PHP source syntax checks** passed using the installed PHP binary.
- Changed TypeScript files passed Biome and `git diff --check`.

Coverage includes native file-read and server-state permissions, exact linked
technical-owner identity, rejection of anonymous/Application/session credentials,
root and whitespace preservation through Laravel middleware, canonical paths,
constant per-batch SQL checks, ordered results and partial failures, bounded concurrency 1/2/4, deadlines, oversized streamed/output
responses and 429 suppression without retries. Negative network behavior uses
isolated Guzzle handlers; it is not a live cURL timeout/oversize fault injection.

The actual Blade view was rendered with sanitized fixture data in Chromium:
[desktop English](screenshots/m5/blueprint-directory-settings-desktop-en.png) and
[mobile Italian](screenshots/m5/blueprint-directory-settings-mobile-it.png).
Both have eight feature bullets, nine correctly labelled/described settings and
no horizontal overflow. Independent source and visual review found no must-fix;
these fixtures are not authenticated production screenshots or a full WCAG audit.
The batch deadline/caller-timeout relationship is documented in the API contract.

The authorized standard installer completed with **Nothing to migrate**; live
capability/settings discovery and native route middleware were verified. Two
initial negative smoke assertions failed because the installed Wings reports a
missing directory as HTTP 500, not 404. The native API corroborated this; the
corrected assertion passed without a production-code workaround. Anonymous,
Application-key and invalid-path rejections passed. The
[complete comparison](M5-DIRECTORY-BENCHMARK.md#2026-10-13--blueprint-140-dev-batch-comparison)
records 202 Panel requests representing 386 successful Wings directory reads,
three alternating 24-directory rounds, a 111-directory traversal per method,
identical metadata, resource sampling and recovery. Mean 24-directory duration
fell from **3557.4 to 393.8 ms**; traversal from **14.8316 to 1.8368 s**.

No directory/file/power mutation occurred during these reads, no new asset was
created and the existing fixture was retained. No native Wings access credential
was exported. The exact stable 1.3.0 artifact and scoped backup remain private for
rollback through the standard approved update; no database rollback is required.
No historical full milestone suite was rerun. M5 PR #21 remains open/unmerged;
SFTPGo #18 is unchanged. Recursive prefetch remains a separate follow-up.

### 2026-10-13 — Stable Blueprint 1.4.0 and silent directory prefetch

The Owner approved implementation after the
[96-directory comparison](M5-DIRECTORY-BENCHMARK.md#2026-10-13--batch-size-and-concurrency-comparison).
Stable Blueprint defaults are 48 paths / two simultaneous Wings reads / eight
seconds. The ordinary Files view now prefetches only metadata through the managed,
authorized batch endpoint. Visible folders seed up to three levels, with at most
96 candidates per navigation, 48 paths per request and one request in flight.
Cached descendants are reused; only the opened folder refreshes and prepares
download URLs. No notification, banner or progress text was added.

The browser retains at most 192 inactive directory listings / 8 MiB serialized
metadata, while keeping active data usable. This is not a total-heap guarantee.
The existing single-folder reload snapshot remains at most 1 MiB / 5,000 entries.
Identity scoping, mutation invalidation, current-folder reload and root-on-tab-reentry
remain intact. Prefetch aborts on navigation and cannot overwrite newer foreground
results. Lower Owner batch limits use bounded sequential chunks; missing Blueprint
support never causes native request fanout. Foreground browsing remains functional.

Focused validation on final source; the historical full M1–M5 matrix was not rerun:

- `scripts/dev.sh pnpm exec vitest run packages/server-management/src/scoped-provider-adapter.test.ts packages/pterodactyl-adapter/src/directory-batch.test.ts`:
  **82 passed**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/directory-identity.integration.test.ts apps/api/src/servers.integration.test.ts -t 'directory batches|directory extension|directory metadata|path and tree|invalid directory|directory settings'`:
  **15 passed, 142 skipped by filter**. Covers authentication, outsider/Origin
  rejection, canonical paths, one identity proof, Owner-key selection, settings
  refresh, transient recovery, abort/deadline/response budgets and no signing.
- Independent review found that an optional-batch catch also preserved a proof
  after contradictory provider identity errors. Corrected 401/403/409 and
  provenance-mismatch handling to invalidate it, retaining the optional behavior
  for absent endpoints/outages. Reran only affected checks:
  `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/directory-identity.integration.test.ts -t 'contradictory directory batch|directory extension'`:
  **4 passed, 80 skipped** (three new cases and the repeated missing-endpoint case).
- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/file-directory-memory.test.ts apps/web/src/features/file-directory-prefetch.test.ts apps/web/src/features/file-directory-query.test.ts apps/web/src/features/file-listing-cache.test.ts`:
  **25 passed**. Includes memory/work bounds, visible roots, old descendant reuse,
  identity separation, cancellation, late responses, foreground/mutation fences,
  unsafe-name/symlink exclusion and snapshot compatibility.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-directory-prefetch.browser.test.ts`:
  **3 passed**, final run 32.96 seconds. Real application handlers and the existing
  isolated test database, with fixture external-provider metadata, prove a
  500-folder listing does not preload all offscreen folders, scrolling reveals
  new candidates, cached rows remain visible under a held GET, changed rows
  reconcile without replacing unchanged DOM rows, download preparation stays
  separated, tab exit aborts work and optional 503 failures stay silent. Reload
  and root re-entry behavior also passed. An earlier run passed before the final
  cache defaults; only these three affected browser cases were rerun afterward.
- `scripts/dev.sh pnpm typecheck`: passed for backend, WebPanel and browser-test
  types. Focused Biome and `git diff --check` passed. No dependency installation
  or historical full build/test matrix was needed.
- Indexed governance passed: **669 text files, 205 review PNGs, 578 relative
  links, four TOML files and 44 ignore cases**; the heuristic secret scan passed.
- Extension validation: **12 package tests, 266 isolated PHP checks and 32 expanded
  PHP syntax checks passed**. Commands and stable artifact/installation evidence
  are recorded in the [extension follow-up](BLUEPRINT-EXTENSION.md#2026-10-13--140-stable-directory-batches).

Independent source, rendered UI and content review found no remaining must-fix.
Reviewed real-browser fixtures:
[Files root](screenshots/m5/files-prefetch-root-desktop-en.png),
[opened folder](screenshots/m5/files-prefetch-open-desktop-en.png),
[Blueprint EN](screenshots/m5/blueprint-directory-stable-desktop-en.png),
[Blueprint IT](screenshots/m5/blueprint-directory-stable-mobile-it.png).
There was no Files layout/copy redesign. A rare shared, already-running metadata
GET can skip optional URL warming for that navigation; normal on-demand issuance
remains available. No duplicate GET was added solely for this optimization.

The authorized standard Blueprint update installed 1.4.0 successfully and reported
**Nothing to migrate**. Existing saved settings remained **48/4/8**; the new
default does not overwrite the Owner's last benchmark override. Read-only live
discovery and one two-directory fixture batch matched the native API (12/502
entries). API, Vite and Panel remained running/healthy; dev HTTPS and Panel login
returned HTTP 200. No manual container restart, network change, game-file mutation
or power command occurred. Existing fixture assets remain unchanged; isolated
test schemas use their normal cleanup.

Rollback: revert the NickHosting source and, if necessary, apply the retained
1.4.0-dev or 1.3.0 archive using the standard approved Blueprint update. No schema
rollback is required. Optional batch absence leaves foreground navigation intact.
Framework housekeeping is not reversed by code rollback. Private credentials,
raw timings, scoped backups and archives remain untracked. PR #21 remains open
and unmerged; SFTPGo #18 remains a separate production-release blocker.

### 2026-10-13 — Explorer selection, clipboard and Delete shortcuts

Ctrl/Cmd-click toggles files and folders without opening them. Shift-click selects
a visible range; Ctrl/Cmd+Shift-click adds a range. Ctrl/Cmd+C and Ctrl/Cmd+X retain
selection metadata without a request or destination dialog. Ctrl/Cmd+V uses the
current folder and the existing copy/move handlers and overwrite-consent flow.
No system clipboard contents or file bytes are stored by this feature. Metadata
is scoped to the mounted Files workspace, exact identity and server; it is cleared
on exit/reload. A submitted cut is consumed even when the response is uncertain,
while cancelling conflict resolution before submission leaves it available.

Delete/Canc opens the existing confirmation with Cancel focused. Arrow keys switch
between Cancel and Delete; Enter activates the focused action. Inputs and the
editor retain their own keyboard behavior. Paste uses no checking dialog but
temporarily disables overlapping file mutations. Directory navigation retains
keyboard focus; completion does not steal focus from an input the user has chosen.

Focused checks (no historical full milestone suite):

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/file-manager-model.test.ts`:
  **8 passed**, covering toggle/range semantics, symlinks, path rules and clipboard
  identity/server separation.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-shortcuts.browser.test.ts apps/web/tests/file-manager.browser.test.ts -t 'M5 file explorer selection|confirms file deletion|supports keyboard context menus, range selection'`:
  **10 passed, 28 skipped by filter**, final run **39.00 seconds**. Eight new cases
  cover selection, copy to multiple destinations, cut of files/folders, overwrite
  consent, delayed paste, unknown move outcome/no replay, cancelled conflict reuse,
  editor/input isolation and EN/IT keyboard deletion. Two existing cases verify
  toolbar/context-menu operations and pending deletion behavior.
- `scripts/dev.sh pnpm typecheck`: passed. WebPanel and browser-test typechecks
  were repeated after the final focus fix using
  `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`.
- Focused `biome check` on the eight changed TypeScript/CSS files and
  `git diff --check`: passed. No dependencies, localization strings, database
  schema or provider API contracts changed.
- `python3 scripts/check-governance.py`: passed on the staged content — 670 text
  files, 208 reviewed PNGs, 581 relative links, four TOML files and 44 ignore cases;
  the heuristic secret scan passed.

Initial browser tests exposed lost focus after folder navigation (three paste
failures). Independent review also found overlapping actions during silent paste
and insufficient contrast when dimming cut filenames. Corrected these by restoring
breadcrumb focus before paint, guarding active transfers and dimming only the
decorative file icon. The expanded run then exposed deferred focus restoration
stealing focus from Search during paste completion (seven passed, one failed).
A targeted diagnostic reproduced it; the final guard preserves an already-focused
control. Final browser results above passed after these corrections. Temporary
diagnostic output was removed. Independent final source, keyboard and rendered
EN/IT review found no remaining must-fix.

Reviewed actual browser screenshots:
[desktop selection](screenshots/m5/files-keyboard-selection-desktop-en.png),
[EN deletion](screenshots/m5/files-delete-keyboard-en.png),
[mobile IT deletion](screenshots/m5/files-delete-keyboard-it.png).
Tests use real application handlers and the existing isolated database, with
external-provider fixtures; Ctrl and Cmd events were exercised in Chromium on
Linux, not on a physical Mac. Temporary test schemas and file staging use their
scoped cleanup. No live game files, provider resources, containers, networks or
Blueprint extension were mutated or restarted. Rollback is a source revert;
there is no persistent clipboard or migration to undo. PR #21 remains open and
unmerged; SFTPGo #18 remains a separate production-release gate.

### 2026-10-13 — Paste focus recovery and transfer completion latency

An isolated browser reproduction confirmed that cutting a file, opening an empty
folder and clicking its empty area could move focus to the document body. The
section-local keyboard handler then never received Paste. A newly created,
extensionless `test` file otherwise moved correctly when breadcrumb focus remained.
The workspace now accepts focus from empty-space clicks; a paste-only document
fallback also handles lost body focus immediately after navigation. It is removed
when Files unmounts and does not capture shortcuts addressed to other controls,
inputs, the editor or dialogs. Noneditable listing text selection cannot suppress
Paste. Both direct navigation and empty-space navigation are regression-tested.

The read-only dev audit recorded one copy's requested-to-completed interval at
**1,598 ms**. This is only the recorded backend segment, not the browser's total
latency or a network-transfer measurement. No rename audit existed in the inspected
window. No live file was created, copied, moved or deleted for diagnosis.

The frontend previously issued two additional directory reads before submission,
then held its mutation lock while listings, transfers and capabilities refreshed.
It now plans consent from shared, identity-scoped cached metadata; cold reads
disable download-URL preparation. The existing backend remains authoritative for
path safety, collisions and authorization. An API conflict fetches fresh metadata
and requests new consent without replaying an uncertain effect. UI locks release
at the operation response; follow-up reads run in the background. Copy refreshes
its destination, move both directories. Capability refresh remains asynchronous
because the copy's own ingestion claim can temporarily make polling report it
unavailable. Real backend work still takes time; no optimistic success is shown.

Focused validation, preserving prior evidence rather than rerunning historical
milestone suites:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/file-manager-model.test.ts apps/web/src/features/file-directory-query.test.ts apps/web/src/features/file-directory-memory.test.ts`:
  **14 passed**.
- Browser command prefix:
  `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts`.
  `apps/web/tests/file-shortcuts.browser.test.ts` initially reported **9 passed / 2
  failed** out of 11: both new tests used the wrong accessible Refresh label.
  After correcting that locator, `-t 'reuses listed metadata|requires new overwrite'`
  passed the late-collision case and exposed a second test locator error (search
  inputs have searchbox semantics). Corrected the selector; the targeted
  `-t 'reuses listed metadata'` case passed. It holds background reads indefinitely
  and proves that controls are usable, while counting **zero extra preflight
  directory GETs** for already-listed folders. This is deterministic fixture
  evidence, not a new live throughput benchmark.
- Added `-t 'refreshes temporary'`: **1 passed / 11 filtered**, proving that a
  polled `copy=false` during an in-flight claim is refreshed after completion.
  `-t 'pastes a newly created'` also passed with a fresh extensionless file,
  body-focus loss, direct navigation, empty-space clicking and selected listing
  text. Thus all **12 shortcut cases** passed across focused runs, not one full run.
- `apps/web/tests/file-manager.browser.test.ts -t 'asks only for file collisions|requests consent when a collision|clears move decisions'`:
  **3 passed / 27 filtered**, 23.58 seconds. The identity test deliberately evicts
  just its destination cache entry to retain a real delayed cold preflight; warm
  navigation no longer needs a duplicate GET. Covers changed consent, failed
  effects and actor changes before/during submission.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, focused Biome and
  `git diff --check`: passed. No dependencies, backend/API/schema changes or
  production deployment were needed.
- `python3 scripts/check-governance.py`: passed on staged content — 670 text
  files, 209 review PNGs, 582 relative links, four TOML files and 44 ignore cases;
  heuristic secret scan passed.

Independent review found and resolved one capability-refresh regression before
delivery: removing that refresh could leave Copy disabled until the next poll.
It remains a background authoritative refresh. Final review found no remaining
must-fix. [Empty-folder focus screenshot](screenshots/m5/files-empty-folder-paste-focus-en.png)
comes from the running isolated browser application; the existing EN/IT deletion
and selection screenshots remain applicable. Browser/provider fixtures and test
schemas use scoped cleanup. Live actions were limited to reading dev container
status, logs and dev file-operation audit timestamps. No live server/file mutation,
new infrastructure, container restart or Blueprint change occurred. Rollback is
a source revert; PR #21 stays open/unmerged and SFTPGo #18 remains unchanged.

### 2026-10-13 — Copy/paste and cut/paste timing breakdown

This pass adds measurement only: no new provider calls, copy algorithm, identity
policy, lock, retry or operation-order changes. The earlier **1,598 ms** live
copy audit interval excludes planning/access before the requested audit and
browser/refresh work afterwards; it is not an end-to-end paste measurement.

With API logging at `debug`, copy and ordinary file mutations emit one bounded
`server.file_operation` record per request, correlated by request ID. Fixed phase
names/counts separate principal/runtime acquisition, access/identity/SQL checks,
copy/move planning and directory calls, mutation guards, resource lookup,
authorization, provider effects, ingestion claims, audit and cleanup. No file
names, paths, contents, SQL, credentials or signed URLs enter these traces. At
`info` or higher, there are no trace records/headers and the aggregate timer is a
no-op. The debug `Server-Timing: nh-file;dur=...` response exposes only the total,
not private provider or authorization details.

The browser emits a single `files.transfer_timing` console-debug object only when
that response timing and a request ID are present. It separates cached/fetched
consent preflight, mutation HTTP/body consumption, the point where the UI lock is
released, and background directory invalidation settlement. Capability/transfer
refresh is not counted as directory refresh and remains asynchronous. No extra
telemetry request, UI notification or persistent browser log buffer is added.
These browser measurements stay in the browser; they are not in API logs.

Interpretation boundaries:

- Nested spans (`copy.access`, `copy.plan`, source/destination checks and their
  directory reads, authorization and its SQL phases) must not be summed twice.
- Adapter spans include scoped credential resolution and transport, not just wire
  latency. Download negotiation ends at response headers; its lazy body streams
  during the upload span. That span covers relay/upload setup and completion.
- Route duration excludes earlier Hono middleware, proxy/browser processing and
  screen rendering. Subtracting it from browser HTTP time does not prove pure
  network latency. Directory invalidation settlement does not prove DOM paint or
  even a network fetch for an inactive query, and can settle with a query error.
- Each submission has its own trace; time spent deciding overwrite consent is
  excluded. The new trace has not yet measured an Owner live paste at this HEAD.

Focused validation:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/file-operation-trace.test.ts apps/api/src/file-operations.test.ts apps/web/src/api/client.test.ts`:
  **74 passed**. The helper's first run exposed that setting a Hono context header
  in `finally` does not update an already-created response. The final helper
  attaches timing directly to that response; success, failure, disabled debug
  and throwing diagnostic sinks/observers now pass.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run apps/api/src/file-operations.integration.test.ts`:
  **32 passed** against the existing isolated test database, provider fixture.
  Debug and non-debug copy perform the same **nine** provider directory reads for
  one file between two child folders; move performs **three**, then one rename.
  Those counts describe that fixture, not every possible tree/path.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-shortcuts.browser.test.ts -t 'reuses listed metadata|cuts files and folders|pastes a newly created'`:
  **3 passed / 9 filtered**. Real browser plus isolated handlers; debug headers are
  injected for the browser timing assertion. Held background directory reads
  prove the controls unlock before refresh; the summary waits for settlement and
  omits file names. Cut and body-focus paste regressions also pass.
- Root TypeScript and WebPanel TypeScript checks passed. Focused formatting/lint
  and staged governance are recorded in the PR update. No full historical suite
  was rerun for this diagnostic-only change.

Only normal dev source watchers reloaded the API/Vite code. Both existing
containers remain healthy; read-only dev HTTPS health returned HTTP 200. No
manual container restart, Panel/Blueprint/Wings change, live file mutation or
new infrastructure was performed. Isolated test fixtures clean up their own
schema/staging state. Production-release gate #18 is unchanged.

Independent read-only review approved the final diff with no must-fix findings:
operation/cleanup ordering, fresh identity semantics, error headers, bounded
private logs, absence of extra provider calls, and background UI release are
preserved. Staged governance passed: 672 text files, 209 existing review PNGs,
582 relative links, four TOML files and 44 ignore cases; heuristic secret scan
passed. Focused Biome passed with one pre-existing informational template-literal
suggestion in the API client's old text-limit test.

### 2026-10-13 — Shared copy/move preflight and Wings observations

The Owner's live pre-change debug sample measured **2,761.496 ms** for copy and
**955.032 ms** for move inside the API route. Copy included 183.268 ms identity,
466.166 ms planning, 432.114 ms in two protected-path guards, 154.312 ms disk REST,
305.489 ms source recheck, 918.620 ms destination rechecks, 29.865 ms download
negotiation, 218.091 ms relay/upload and 53.571 ms remaining work. These are
non-overlapping categories; nested directory spans are not summed again. The
private trace remains local. This is the baseline, not a post-change benchmark
or an end-to-end browser measurement.

Changes:

- Ordinary file mutations and copy reuse the existing identity proof (60-second
  deadline, renewal at 55 seconds), with fresh local permissions, exclusive
  lifecycle locking and pending-upload fences. Pool admission preserves capacity
  for proof renewal. No frontend-only authorization is trusted.
- Copy/move use one bounded, fresh request-local directory snapshot across
  planning, protected-runtime guards and collision checks. Blueprint reads the
  distinct paths in batches, honoring extension limits. Only absent optional
  endpoints permit native fallback; authorization/transient/path failures do not.
  Sources/destinations are not relisted at every stage or after download issuance.
- Copy uses recent authenticated disk measurements from the already-open Wings
  console relay when available. Samples expire after 30 seconds, are scoped to
  managed/provider identity, and are invalidated around filesystem effects.
  Missing/offline/stale observations use the existing resources API; no new socket
  or background polling is introduced. Physical staging reservations remain.
- Wings contains paths, opens sources and enforces its disk quota. NickHosting
  retains its own permissions, protected runtime files, overwrite consent,
  bounded streams, staging admission and partial/uncertain failure reporting.
  The single preflight is not atomic against external Panel/SFTP/game writes;
  those can race subsequent effects. No rollback is invented.

Read-only installed-source research confirmed Panel 1.11.11's copy adapter accepts
only a source `location`. The installed Wings binary reports 1.11.13; the current
image's recorded upstream revision is `71c5338549801ca1dde46919f3ea81500269264d`.
[Wings 1.11.13 copy](https://github.com/pterodactyl/wings/blob/v1.11.13/server/filesystem/filesystem.go)
duplicates one regular file in its current directory, generates a suffix and does
not return the chosen name. It cannot replace arbitrary-folder/recursive paste
or implement explicit overwrite consent. Copy therefore keeps the existing
private backend stream; no file downloads through the user's PC, copy/guess/rename
sequence, new provider endpoint or installed extension update was introduced.
The [filesystem containment code](https://github.com/pterodactyl/wings/blob/v1.11.13/internal/ufs/fs_unix.go)
and [disk quota implementation](https://github.com/pterodactyl/wings/blob/v1.11.13/server/filesystem/disk_space.go)
were reference evidence, not modified production source.

Focused execution evidence (no full historical milestone suite):

- `scripts/dev.sh pnpm exec vitest run apps/api/src/file-operations.test.ts apps/api/src/file-browsing.test.ts apps/api/src/file-directory-plan.test.ts packages/server-management/src/file-disk-usage.test.ts`:
  **160 passed**. The directory helper subsequently added all-settled failure
  coverage; `scripts/dev.sh pnpm exec vitest run apps/api/src/file-directory-plan.test.ts`
  passed **23/23** on its final source. The disk suite separately passed **13/13**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/directory-identity.integration.test.ts`:
  **87/87 passed**, 125.25 seconds. Covers proof reuse/expiry, permission loss,
  lifecycle/pending-upload fences, exclusive locks, settings reuse and disk
  cache invalidation/identity drift.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run apps/api/src/file-operations.integration.test.ts`:
  **30 passed, 2 failed** initially because old guard assertions omitted the new
  shared-context argument. Both assertions were updated;
  `-t 'requires exact overwrite|copies mixed'` then passed **2/2** (30 filtered).
  All 32 cases thus passed across those runs, not one final full run. The same
  one-file/two-child-folder fixture drops from nine directory reads to three
  distinct directories through one batch, with one whole-plan runtime guard.
  Coverage includes protected paths, explicit collisions, source open/size
  failures, mixed copies and incomplete effects.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run apps/api/src/servers.integration.test.ts -t 'protects Minecraft launch inputs|rechecks logout|console relay|console authorization|newly opened console|idle console HTTP|foreign|origin'`:
  initially **8 passed, 2 failed**, 66 filtered. The legacy provider fixture lacked
  optional batch-settings discovery; it now returns the extension's 404 contract.
  The real heartbeat test waited for two 10-second heartbeats inside the global
  20-second test timeout; its test-only budget is now 30 seconds. Rerunning
  `-t 'protects Minecraft launch inputs|keeps an idle console HTTP'` passed
  **2/2**, 74 filtered, 27.40 seconds. Product heartbeat timings did not change.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-shortcuts.browser.test.ts apps/web/tests/file-manager.browser.test.ts -t 'copies without|cuts files|reuses listed metadata|requires new overwrite consent|asks only for file collisions|requests consent when a collision|clears move decisions'`:
  **7 passed**, 35 filtered, 48.07 seconds. Real browser + isolated handlers prove
  copy/cut/paste, UI release before refresh, consent and actor-change behavior.
- `scripts/dev.sh pnpm typecheck`: root and WebPanel passed after correcting
  initially inferred callback/promise and fixture parameter types. Focused Biome
  checked all ten changed TypeScript files successfully.
- `python3 scripts/check-governance.py`: passed on staged content — 676 text
  files, 209 existing review PNGs, 583 relative links, four TOML files and 44
  ignore cases; heuristic secret scan passed. `git diff --cached --check` passed.

Independent source review found no remaining must-fix across authorization,
identity proof, directory batching/fallback budgets, runtime protection, scoped
resource observations, invalidation and partial-failure behavior. Browser tests
use provider fixtures, not live file mutations. Existing approved isolated test
services were reused; their per-test schemas/staging state are cleaned by fixtures.
No containers, networks, live game files or test servers were created/removed.
Only the normal dev source watchers reloaded code; API and Vite remained healthy,
and HTTPS `/v1/setup` returned HTTP 200 with `application/json`. Panel inspection
was read-only. No manual
restart, Pterodactyl/Wings/Blueprint change, credentials change or production
interaction with side effects occurred. Issue #18 remains unchanged.

An Owner live copy/cut comparison is still needed for actual post-change latency;
provider call counts alone do not establish a millisecond result. Rollback is a
source revert through the existing dev watcher; no schema/configuration migration
is involved. PR #21 remains open and unmerged.

### 2026-10-13 — Save shortcut from a new file's name

The new-file name input now intercepts Ctrl/Cmd+S and submits the existing editor
form, with native name validation, instead of opening the browser's Save Page
dialog. Enter and CodeMirror shortcuts are unchanged; composition cannot submit.
No visual, API or infrastructure change is involved.

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-shortcuts.browser.test.ts -t 'pastes a newly created'`:
  **1 passed / 11 filtered**, 15.74 seconds. The existing new-file/cut/paste journey
  now saves its document with Ctrl+S while focus is in the name input.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck` and focused Biome:
  passed. Only existing isolated browser fixtures were used; no live file writes,
  manual restart, provider or infrastructure changes.

### 2026-10-13 — Shared file viewer engine, first pass (issue #26)

Implemented the shared lazy viewer engine, personal Open with defaults, reusable
private SFTP transport and readonly range endpoints. Existing CodeMirror editing,
files/downloads and optimized provider paths remain in place. Builtins now cover
images/ICO, browser-native media, JSON/JSONC/JSON5, SQLite and archive virtual
folders. Archive extraction extends the existing staging pipeline. See
[ADR0017](decisions/0017-shared-file-viewers.md),
[format/dependency evidence](M5-VIEWER-FORMATS.md) and
[the exact activation proposal](M5-VIEWER-DEPLOYMENT.md).

Validation on the implemented source:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/viewer-cache.test.ts apps/api/src/viewer-archive.test.ts apps/api/src/viewer-sqlite.test.ts apps/api/src/viewer-http.test.ts apps/api/src/viewer-access-watch.test.ts apps/api/src/file-operations.test.ts packages/external-services/src/viewer-sftp.test.ts packages/external-services/src/viewer-sftpgo.test.ts packages/external-services/src/external.test.ts packages/core/src/viewer-config.test.ts packages/game-sdk/src/viewers.test.ts apps/web/src/features/viewer-engine`:
  **169 passed, 14 files, 21.53s**. This is the focused affected suite, not the
  historical complete M1–M5 matrix. Subsequent narrow transport/layout changes
  have their affected reruns recorded below.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/file-viewers.integration.test.ts apps/api/src/viewer-service.integration.test.ts packages/external-services/src/viewer-sftpgo.integration.test.ts apps/api/src/file-operations.integration.test.ts`:
  **53 passed, 4 files, 18.22s**. PostgreSQL uses generated isolated schemas;
  SFTPGo uses fresh marked accounts/directories in the existing approved M2 test
  stack. Cleanup removed only those fixtures. Service and handler tests isolate
  external providers where stated in their fixtures; they do not prove a live
  Wings mount. Real SFTP tests prove ranges, read-only permissions, cross-server
  and symlink confinement, retained local transport revocation, and no home
  initialization or owner/mode changes on login.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts`:
  **6 passed, 28.30s**. Actual React/browser rendering with isolated identity and
  fixture viewer HTTP responses: SVG script isolation, ICO frame selection,
  JSON integer preservation/defaults, archive navigation/text preview, readonly
  SQLite, real WAV playback, unsupported AVI feedback, Italian mobile chooser,
  keyboard dismissal and unconfigured fallback without preference-table reads.
  Axe scan of the mobile chooser: **zero violations**. This is not a claim that
  every media codec or every WCAG criterion has been verified.
- After visual review found the archive parent row right-aligned, one CSS selector
  was corrected. Only its archive browser journey was rerun: **1 passed**, five
  unrelated viewer journeys skipped; screenshot regenerated and reviewed.
- `scripts/dev.sh pnpm typecheck`: passed for backend, WebPanel and browser tests.
- `scripts/dev.sh pnpm build` and `scripts/dev.sh pnpm build:runtime`: passed.
  Viewer modules are separate lazy chunks; existing editor/application chunks
  retain Vite's size warning. Runtime build did not start services or migrate DBs.
- `scripts/dev.sh pnpm exec biome check . --diagnostic-level=error --max-diagnostics=20`:
  passed, 559 files. An initial full lint run found two pre-existing blockers:
  formatting in upload-cancellation diagnostics and a decorative avatar SVG
  missing explicit accessibility semantics. Both received minimal corrections;
  no functional upload or game behavior changed. Existing warning-level
  diagnostics are not described as eliminated.
- `scripts/dev.sh pnpm format:check`: passed, 555 files.
- `scripts/dev.sh pnpm i18n:compile`: 1,288 keys, EN/IT/pseudolocale parity.
- Combined current development Compose overlays plus `compose.dev.viewers.yaml`
  parsed successfully with fixture-only viewer environment values; no resources
  were created. Preparation-script shell syntax and boundaries were reviewed.

Independent review found and resolved: deceptive ICO DIB dimensions bypassing
pixel limits; cancelled SQLite queries poisoning a retained shared worker;
full archive-member reads skipping EOF/CRC validation; insufficient pooled-handle
headroom; request-bound cancellation of shared snapshots; and retention of old
credential identities during rotation. Added targeted regression coverage. Final
review reports no remaining must-fix in the reviewed source/configuration. It
explicitly retains the expired-account cleanup limitation documented with issue26.

Sanitized browser screenshots, reviewed by the coordinator and independent UI
reviewer: [image](screenshots/m5/file-viewer-image-desktop-en.png),
[JSON](screenshots/m5/file-viewer-json-desktop-en.png),
[archive](screenshots/m5/file-viewer-archive-desktop-en.png),
[SQLite](screenshots/m5/file-viewer-sqlite-desktop-en.png),
[Italian mobile](screenshots/m5/file-viewer-json-mobile-it.png), and
[Open with](screenshots/m5/file-viewer-open-with-mobile-it.png).

Development continuity: source hot reload initially exposed missing new packages
in the existing API image, causing HTTP502. Optional parser/broker loading was
made lazy; API recovered through its existing watcher, without any Docker restart.
The API container is healthy and public `/v1/setup` returns HTTP200. The existing
file/text path works while private viewers remain unconfigured. No development
accounts/data were reset. No live Panel/Wings/game-server writes, Blueprint
installation, network changes, new containers, or new Wings mounts occurred.

Activation remains pending the exact Owner approval in the deployment proposal:
new private SFTPGo service/read-only mount, scoped empty state preparation,
API/Vite dependency rebuild/recreation and explicit additive development migration.
Single compressed streams and game-specific viewers remain outside this first
pass. 7z/RAR limits, native media codec variability and SQLite snapshot uncertainty
are explicit. SFTPGo issue18 remains a separate production-release gate; its three
retained-transport regressions were not rerun or reported as security passes.

Viewer transport benchmark and final narrow rerun:

- Private reproducible command: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec tsx .codex/local/viewer-cold-warm.ts`. Existing isolated SFTPGo2.7.6,
  new 1MiB fixture file, one cold and twenty warm OPEN/FSTAT +64KiB READ operations.
  Exactly one SSH connection and one SFTP channel served all21 operations. Account
  issuance was measured separately; each run removed its own account/directory.
- First run: cold626.72ms; warm min219.78, median227.67, mean227.17, max240.82ms.
  Repeating44ms steps prompted inspection of the installed ssh2 client, which
  created a socket without enabling TCP_NODELAY.
- The broker now calls the documented
  [ssh2 `setNoDelay(true)` method](https://github.com/mscdex/ssh2#client-methods)
  once after connecting. Identical second run: cold131.40ms; warm min2.25,
  median3.32, mean3.48, max5.86ms. Warm median OPEN/FSTAT1.45ms, READ1.89ms,
  CLOSE0.76ms. No server, Docker-network or kernel setting changed.
- Only affected tests were repeated after that fix: transport **11/11 passed**
  (14.30s), real isolated SFTPGo **4/4 passed**, scoped Biome passed. The new
  regression asserts the client's no-delay setting.
- These measurements exclude HTTP/browser latency, NickHosting authorization,
  production Wings storage and large-file throughput. They are not a claim that
  every viewer opens in3ms. The first benchmark remains recorded rather than
  being replaced by the faster result.

Publication checks: `git diff --cached --check` and
`python3 scripts/check-governance.py` passed: 737 indexed text files,215 reviewed
PNGs,604 relative links,4 TOML files and 44 ignored-path cases. The secret scan is
heuristic; private ledgers, environments, SFTP state and benchmarks stay untracked.
Final `pnpm lint` passed with39 pre-existing/advisory warnings and2 informational
diagnostics; format check passed. Concurrent account-menu/sidebar edits in the
shared workspace are not part of this viewer delivery and were preserved unstaged.

## 2026-10-13 — Approved private viewer activation

The Owner approved the proposal at `c3002697ee0de42d5cac69fa5128738ed646da66`.
Only the new development viewer service/state, explicit additive migration024,
protected settings/secret and API/Vite image replacement were applied. No Panel,
Wings, game process/file, NPM, DNS, production network or existing test-stack
configuration was changed. No Blueprint update was needed.

Commands and actual results:

- Complete six-overlay Compose chain with `.env.dev.local` and private
  `.env.dev.viewer.local`: `config --quiet` passed; `pull sftpgo-viewer`,
  `bash deploy/prepare-viewer-state.sh --owner-approved 100 101` and scoped
  `up -d --no-deps --wait sftpgo-viewer` completed. New state `0700`, secret file
  `0600`, verified data-reader UID/GID100:101, read-only Wings bind and no host ports.
- `build api` succeeded; `run --rm --no-deps migrate` applied only
  `024_file_viewers.sql`; `up -d --no-deps --wait api vite` succeeded. All three
  affected services healthy with RestartCount0. Previous application images retained.
- Actual authenticated HTTPS smoke (private script
  `.codex/local/viewer-live-smoke.mjs`, run through `docker exec -i
  nickhosting-dev-api-1 node --import tsx --input-type=module`): Owner session and
  capabilities200, exact byte ranges/seek206, out-of-bounds416, existing JSON200,
  stream cancellation followed by successful206, anonymous401. No credentials or
  file contents are included in public evidence.
- Headers-only elapsed measurements on that smoke: cold range559.61ms (includes
  first private account/SSH setup), warm range23.88ms, seek36.01ms, JSON38.05ms,
  read after cancellation71.54ms. These are individual observations through HTTPS,
  not a load benchmark or claimed universal viewer latency.
- The one private account is confined to the selected managed server, permits only
  `list`/`download`, and disables filesystem initialization. It is persistent
  application state, not a temporary test account to delete. Existing server
  root/file owners and modes match preflight; no game files were created or changed.
- Existing Owner/user row count remains1 and the complete row hash is identical
  before/after migration and configuration. Existing unrelated settings preserved.
- `scripts/dev.sh pnpm exec tsx .codex/local/files-live-smoke.ts`: HTTPS login200,
  frontend modules200, anonymous protected API401, Vite HMR connected, no page errors.
- `scripts/dev.sh pnpm exec tsx .codex/local/viewer-live-browser.ts`: real Chromium,
  existing Owner session, actual managed file listing, existing JSON opened in the
  JSON tree through real SFTP-backed HTTP, zero page errors. No response mocks or
  game-file writes. This is additional live evidence; the broader visual/format
  matrix above remains isolated fixture evidence.
- `scripts/dev.sh pnpm exec vitest run scripts/deployment-config.test.ts`:
  **44 passed**,3.13s. No historical full-suite rerun for a deployment-only correction.

Failures/corrections are retained: initial SFTPGo startup loaded default RSA keys
while allowing only Ed25519 and failed; explicitly limiting `HOST_KEYS` to Ed25519
resolved it. A private activation helper reported an error from closing its DB pool
twice after successfully saving configuration; subsequent protected reads verified
both settings and encrypted secret, without replaying creation. Initial smoke
scripts used an incorrect DB column, then an absolute instead of required relative
file path (correctly400); the browser helper initially used the wrong CSS selector.
These test harness errors were corrected before the successful runs above.

Independent activation/configuration review found no must-fix. All107 pre-existing
container IDs/images were preserved except the authorized API/Vite replacement;
only the viewer service was added. Three unrelated services independently changed
StartedAt in existing crash loops (unchanged IDs/images/networks, more than24,000
restarts); they were not touched. Existing isolated M2 resources were unchanged.
Temporary preparation and migration containers removed themselves; private viewer
state, account, key and bounded cache remain intentionally persistent.

Issue26 continues to track single-stream compressed formats and scoped expired
account retirement cleanup. Browser-native codec limits, bounded archive/snapshot
sizes and SQLite consistency caveats remain documented. Issue18 is unchanged and
production remains undeployed. Concurrent Owner UI work was preserved unstaged.

Final Compose validation and `git diff --check` passed. The repository governance
check passed (736 indexed text files,215 review PNGs,604 links,4 TOML files and44
ignore cases before staging this record). Biome does not process Markdown/YAML
in this repository: its targeted invocation reported no files processed, not a
formatting pass. No TypeScript application source changed during activation.

## 2026-10-13 — One-row viewer actions

The shared file header now places the path left and Open with → Home → Download
right. Actions remain owned by the current viewer through stable header slots,
so archive-entry downloads and chooser options refer to the entry, not its outer
archive. Root viewers no longer render a separate action row. Text editing keeps
Save/Undo/Redo/Find before the common actions; unavailable/binary text fallbacks
use the same header download. Narrow screens use a labeled Open with icon and
prioritize the current filename, including 320px layouts. No API, dependency,
provider, authorization or infrastructure changes.

Validation was targeted:

- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed.
- `scripts/dev.sh pnpm exec biome check` on the seven changed TSX/CSS/test files:
  passed; `git diff --check` passed.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts`:
  initial run5/6 passed; the added Escape-focus assertion exposed missing chooser
  focus restoration, which was fixed. The first archive-only rerun then exposed a
  test harness assumption: native downloads need Playwright's download event,
  not a page request event. The final affected archive/mobile rerun passed both
  journeys, including entry-specific download/chooser, keyboard and axe checks.
- Same browser command for `apps/web/tests/file-manager.browser.test.ts -t
  'opens text inline|keeps known binary'`: both passed initially. Added320px coverage
  caught filename clipping; compact controls fixed it. Mobile navigation tests now
  use Home when parent breadcrumbs are collapsed; the path shortcut uses its
  declared physical KeyG. Final editor-only rerun passed in19.63s, including
  desktop/390px/320px, unsaved changes, search, keyboard and accessibility checks.
  The binary fallback journey also passed. No full historical-suite rerun.

Screenshots reviewed: [desktop JSON](screenshots/m5/file-viewer-json-desktop-en.png),
[Italian mobile](screenshots/m5/file-viewer-json-mobile-it.png),
[archive](screenshots/m5/file-viewer-archive-desktop-en.png),
[320px editor](screenshots/m5/file-viewer-editor-header-320-it.png), and
[390px editor](screenshots/m5/file-inline-editor-mobile-it.png).
Independent read-only code/UX review reports no remaining must-fix. The tests use
existing isolated services and temporary test schemas; no live provider mutation,
new Docker resource, restart or game-file write. Vite applies the UI through HMR.
Concurrent Owner UI changes remain unstaged; only the shared-header documentation
paragraph from FRONTEND-I18N.md belongs to this change.

## 2026-10-13 — Open with cards and personal defaults

Open with now uses immediate-action cards, distinct first-party SVG marks and
stable EN/IT names: Scribe, Frame, Wave, Motion, Atlas, Data Grid and JSON Tree.
Functional descriptions remain localized and connected to each accessible name.
One scope selector precedes the cards: one-time opening (no write), or a personal
extension default for this server, game or all servers. The existing server > game
> global resolution is unchanged; broader choices never silently delete narrower
preferences. X/Escape replaces the Cancel/Open footer. Failed preference writes
retain the chooser; pending writes disable controls and reject duplicate clicks.
No API, authorization, provider, dependency or persistence contract changes.

Targeted validation:

- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed, including
  application and browser-test TypeScript.
- `scripts/dev.sh pnpm i18n:compile` and `scripts/dev.sh pnpm i18n:check`: passed
  for EN/IT/pseudolocale. Concurrent Owner translations remain in the working tree;
  only viewer catalog changes are included in this commit.
- `scripts/dev.sh pnpm exec biome check` on open-with.tsx, viewer-icon.tsx,
  core/registry.ts, viewer.css, viewers-web.ts and file-viewers.browser.test.ts:
  passed; `git diff --check` passed.
- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/core/registry.test.ts`:
  3/3 passed, including availability and personal-preference resolution.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts`:
  8/8 passed in 35.99s. Coverage includes click/Enter/Space opening, all three
  scopes, one-time choices without writes, failed-write retry, duplicate activation,
  pending Escape/close guards, editor focus, archive entry targeting and unavailable
  preview fallback.
- Independent review found missing accessible functional descriptions behind brand
  labels, and a single-card CSS selector that also counted the legend. Both fixed;
  the same browser command with `-t 'preserves JSON|retains the chooser|keeps Italian mobile|keeps the existing editor'`
  passed all 4 affected journeys in 26.53s (4 others intentionally skipped), with
  EN/IT accessible-description assertions, single-card centering, 390px/320px
  layouts, keyboard focus and zero axe violations in the mobile chooser.
- `python3 scripts/check-governance.py`: passed (737 indexed text files, 219
  review PNGs, 615 links, 4 TOML files and 44 ignore cases; heuristic secret scan).

Reviewed screenshots: [desktop](screenshots/m5/file-viewer-open-with-desktop-en.png),
[Italian mobile](screenshots/m5/file-viewer-open-with-mobile-it.png),
[320px](screenshots/m5/file-viewer-open-with-320-it.png), and
[failed preference save](screenshots/m5/file-viewer-open-with-error-en.png).
Independent code/accessibility/UX review reports no remaining must-fix; no manual
screen-reader session was performed. Browser tests use the actual application with
isolated provider/viewer API fixtures and temporary schemas on existing approved
services. No real game-file operation, new container, restart or infrastructure
change was needed. An HTTPS GET of the dev Vite module returned 200 and confirmed
the new cards, scope control and accessible descriptions are served through HMR.
Issue18 and existing production-release boundaries remain unchanged. Concurrent
Owner UI changes were preserved; no broad historical suite was rerun.

## 2026-10-13 — Show all and explicit viewer attempts

Open with offers Show all / Show suggested. Expansion is local metadata only;
no content is fetched until a card is chosen. The bounded scrollable grid exposes
compiled builtin and same-game viewers beyond filename matches. Explicit personal
defaults now survive unmatched extensions and apply in normal/context-menu opens.
SDK `forGame` enumerates trusted modules without executing their lazy loaders.
Existing transport, editor/size and decoder constraints remain. Nested archive/
SQLite readers stay excluded for archive entries because they target the outer
file. Atlas still recognizes archive formats by supported suffix; forcing a viewer
is an attempt, not format conversion or a compatibility guarantee.

Validation:

- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed on final code.
- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/core/registry.test.ts packages/game-sdk/src/viewers.test.ts`:
  5/5 passed (forced defaults, unknown IDs, scope precedence, nested exclusions,
  memory limits and trusted same-game discovery).
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'offers all|preserves JSON|keeps Italian mobile|keeps the existing editor|navigates archives'`:
  6/6 targeted journeys passed, 4 intentionally skipped, in 32.59s. Covers a JSON
  payload named .dat, remembered reopening/context menu, wrong-image error and
  recovery, nested entries and unavailable transport.
- Independent review caught a newly introduced dependency on optional viewer
  metadata for ordinary text opens. Fixed by retaining the visible lookup error
  while allowing the independent text editor. Same browser command with
  `-t 'offers all|keeps Italian mobile|keeps text editing'`: all 4 affected journeys
  passed in 29.14s, 7 intentionally skipped. Both capabilities 503 and preferences 503
  tested; keyboard reaches the last card through scrolling; expanded 320px chooser
  has zero axe violations and no horizontal overflow.
- `scripts/dev.sh pnpm i18n:compile`, `scripts/dev.sh pnpm i18n:check`, targeted
  Biome on the nine changed TS/TSX/CSS files and `git diff --check`: passed.

Reviewed [desktop](screenshots/m5/file-viewer-all-desktop-en.png) and
[320px Italian](screenshots/m5/file-viewer-all-320-it.png) screenshots. Independent
review reports no remaining must-fix. Actual app/browser handlers use isolated
provider fixtures and disposable schemas on existing approved test services;
no live game mutations, new infrastructure or restarts. No full historical suite
rerun. Production release restrictions and issue18 are unchanged.

Index governance passed: 737 text files, 221 review PNGs, 617 links, 4 TOML files
and 44 ignore cases (heuristic secret scan). Read-only HTTPS smoke returned 200
and confirmed the new toggle and expanded list are served by Vite in dev.

## 2026-10-13 — Frame zoom and viewport interaction

Replaced the competing CSS-fit/state-scale calculations with one transform in
natural image pixels. Fit reports its real percentage and follows viewport
resizing; Actual size is centered 100%. Buttons, CTRL/CMD +/− and a typed percentage
zoom around the viewport center even after panning. Trackpad deltas pan, pinch
anchors at the pointer, and separate WebKit gestures suppress duplicate wheel
updates. Percentage input accepts dot/comma decimals, validates without changing
the image on failure, applies on Enter and cancels on Escape/blur. All controls
remain scoped to Frame; inputs/dialogs retain their normal shortcuts.

Validation:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/image-viewport.test.ts`:
  3/3 passed; fit/sub-1% scale, center/pointer invariance, inverse zoom, finite
  bounds and decimal validation.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'opens SVG|Frame'`:
  3/3 targeted journeys passed, 10 intentionally skipped, 21.26s. Covers actual
  image dimensions, Fit/Actual size, resized viewport, keyboard/buttons after
  panning, percentage success/error/cancel, wheel bursts, pinch anchoring, gesture
  duplication prevention, dialog isolation and ICO keyboard frame changes.
  Italian 390px layout has zero axe violations within Frame and no page overflow.
- Initial run had two passing journeys and one failing anchor assertion; an
  isolated rerun reproduced it. The test assumed fractional coordinates survived
  construction of a WheelEvent. Corrected it to use the actual event coordinates
  delivered by the browser, retaining the same strict geometric tolerance.
- Independent review found ICO frame switching unmounted the focused picker;
  fixed conditional focus restoration and added consecutive ArrowDown/ArrowUp
  assertions. An inset viewport focus outline avoids clipping. Final independent
  technical/accessibility/visual review reports no remaining must-fix findings.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, `scripts/dev.sh pnpm
  i18n:compile`, `scripts/dev.sh pnpm i18n:check`, targeted Biome on the six changed
  TS/TSX/CSS files and `git diff --check`: passed.

Reviewed [desktop Fit](screenshots/m5/file-viewer-frame-fit-desktop-en.png) and
[Italian mobile zoom](screenshots/m5/file-viewer-frame-mobile-it.png) screenshots.
Tests use the actual application in Chromium with isolated provider fixtures and
disposable schemas on existing approved services. Wheel/pinch/WebKit gesture
events are synthetic: physical trackpads and native Safari/Firefox behavior were
not manually certified. Event handling follows the documented
[wheel cancellation](https://developer.mozilla.org/en-US/docs/Web/API/Element/wheel_event),
[trackpad CTRL wheel behavior](https://developer.mozilla.org/en-US/docs/Web/API/MouseEvent/ctrlKey)
and nonstandard [WebKit gesture API](https://developer.mozilla.org/en-US/docs/Web/API/Element/gesturechange_event).
No content/proxy/API contract, real server, Blueprint extension, network or
container change; no restart or new test asset on a game server. Concurrent Owner
UI work was preserved. No full historical suite rerun; issue18 is unchanged.

Index governance passed: 739 text files, 223 review PNGs, 619 relative links,
4 TOML files and 44 ignore cases (heuristic secret scan). Read-only dev HTTPS
module check returned 200 and confirmed the new Frame controls are served through
Vite HMR, including percentage parsing, gestures and ICO focus restoration.

## 2026-10-13 — Frame movement bounds and zoom limits

Owner follow-up supersedes the earlier sub-1%/large zoom behavior: Frame now
allows 1–5000%, with the existing two-decimal display/draft. Fit also respects the
minimum; unusually wide images that cannot fit at 1% remain pannable to their
edges. A shared transform constraint centers axes that fit and bounds oversized
axes at either edge. Wheel/trackpad, drag, keys, buttons, percentage entry and
viewport resizing all use it. Edge limits take priority over zoom anchoring.
Zoom buttons disable at the relevant bound. Frame's top corners are square at
the file-toolbar seam; the bottom corners retain their rounding.

Validation on final code:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/image-viewport.test.ts`:
  5/5 passed, covering limits, both signed edges, mixed-size axes, zoom-out
  recentering, minimum Fit and manual resize.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'Frame'`:
  3/3 passed, 11 intentionally skipped, 23.88s. Includes extreme wheel deltas,
  arrow/pointer constraints, resize reclamping, typed minimum/maximum, disabled
  buttons, shortcut/pinch limits, centered small images and computed corner radii.
  Existing anchoring, percentage, gesture and mobile axe checks still pass.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, targeted Biome on the
  five changed TS/TSX/CSS files, and `git diff --check`: passed.

Updated and reviewed [desktop](screenshots/m5/file-viewer-frame-fit-desktop-en.png)
and [Italian mobile](screenshots/m5/file-viewer-frame-mobile-it.png) screenshots.
Actual browser/application with isolated provider fixtures and temporary test
schemas; no new containers, game assets, server operations or restarts. No full
historical suite rerun; previous hardware/browser evidence limits remain.
Concurrent Owner work and issue18 were preserved.

Independent final code/accessibility/visual review found no must-fix issues.
Read-only HTTPS module inspection returned 200 and confirmed the new bounds and
shared constraint are served by Vite HMR.
Index governance passed: 739 text files, 223 review PNGs, 621 relative links,
4 TOML files and 44 ignore cases (heuristic secret scan).

## 2026-10-13 — Frame integer percentage display

Owner follow-up replaces the two-decimal display with a rounded integer, including
the initial edit draft. Transform calculations retain full precision; accepting an
unchanged rounded value does not rescale the image. Decimal input still works.
An initial targeted browser run exposed multiplication noise at 125.5%; rounding
now compensates machine epsilon and consistently shows 126% for that value.

Final `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run
--config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts
-t 'keeps Frame fit'`: 1/1 passed, 13 skipped, 13.86s. It checks the integer display,
rounded draft and preservation of the 1.255 internal scale after confirmation,
alongside existing fit/zoom/resize behavior. Web typecheck and targeted Biome pass.
Updated desktop screenshot reviewed. No full-suite rerun, infrastructure restart,
API change or game-server interaction; prior gesture evidence boundaries remain.

## 2026-10-13 — Frame Fit for small images and ICO

Fit previously capped scale at 100%, so small images appeared unchanged when
switching between Fit and Actual size. It now enlarges small images as well as
shrinking large images within the existing 1–5000% limits. Actual size remains 100%.
Transparent canvas pixels remain part of the dimensions; no alpha-cropping,
parser, file or provider behavior changed.

Validation:

- Image-viewport unit suite: 5/5 passed, including 400×200 upscaling to 250%, tiny
  images bounded at 5000%, large images and the 1% floor.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run
  --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts
  -t 'opens SVG|small transparent|Frame'`: 5/5 passed, 10 skipped, 24.69s. New transparent
  PNG Fit/Actual/Fit assertions, both ICO frames with keyboard-focus preservation,
  plus existing geometry/gesture/bounds/mobile regressions.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, targeted Biome and
  `git diff --check`: passed. Full historical suites were not rerun.
- Owner-authorized read-only live check: inspected the reported dataset through
  normal authenticated NickHosting reads (directory metadata and bounded image
  header ranges). PNG 256×256; ICO 6 frames from 16×16 through 256×256. Actual Chromium
  dev WebPanel at 1440×1000: PNG Fit 246% / Actual 100% / restored Fit 246%; first
  ICO frame Fit 3938% / Actual 100% / restored Fit 3938%. No writes to game files,
  lifecycle operations, new assets or infrastructure/container changes.

Reviewed [transparent PNG fixture](screenshots/m5/file-viewer-frame-transparent-fit-en.png).
Only sanitized fixtures are published; private helpers/credentials remain ignored.
Concurrent Owner changes and issue18 are preserved.
Independent final code/test/screenshot review found no must-fix issues.

## 2026-10-13 — Frame SVG rendering and 25000% zoom

SVG now supports 1–25000%; raster images and ICO retain 1–5000%. SVG zoom changes
the image's displayed CSS dimensions, with translation only, instead of enlarging
it with CSS scale. Native image rendering retains the vector source and avoids
depending on compositor scaling of an existing rasterized layer. The same image
URL and inert `<img>` boundary remain; no inline SVG, object/iframe, new parser,
server conversion or zoom-sized canvas. See the browser's documented
[SVG image restrictions](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image).

Validation on final source:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/image-viewport.test.ts`:
  6/6 passed, including distinct raster/vector limits, Fit and typed zoom bounds.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run
  --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts
  -t 'renders SVG'`: 1/1 passed, 15 skipped, 20.99s. Four SVG fixtures cover
  explicit dimensions plus viewBox, dimensions without viewBox, viewBox only,
  and a 1000×480 image. At 25000%, translation matrix scale remains 1 and CSS
  dimensions reflect 250× magnification. Screenshot pixels show narrow vector
  antialiasing (at most four intermediate pixels across a diagonal), not enlarged
  source pixels. Embedded script and external image requests remain blocked.
- The same browser command with `-t 'opens SVG|small transparent|Frame'`:
  5/5 passed, 11 skipped, 21.37s. Fit/Actual, raster maximum, SVG maximum, ICO,
  keyboard, pointer, pinch, bounds, resize and mobile accessibility regressions.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, targeted Biome on
  the four changed TS/TSX files, and `git diff --check`: passed.
- Owner-authorized read-only real dataset check found a 1000×480 SVG containing
  vector shapes and no embedded raster images. Actual dev UI in Chromium
  confirmed 25000% (250000×120000 CSS dimensions, translation only), Fit and
  Actual size. No real file or server mutation.

Reviewed the sanitized [25000% vector fixture](screenshots/m5/file-viewer-frame-svg-25000-en.png).
A small standalone Chromium comparison did not reproduce the previously reported
blur under CSS scale; the new path explicitly removes that dependency. Firefox
and Safari rendering have not been certified by these checks. Embedded raster
content inside other SVG files cannot gain vector detail through zoom.
Only existing approved isolated test services were used; no new container,
restart, network, Blueprint or API change. Private live screenshots and helpers
remain ignored. Historical suites were not rerun; concurrent Owner work and
issue18 are unchanged.
Independent final code/security/geometry/screenshot review found no must-fix
issues. Index governance passed: 739 text files, 225 PNGs, 623 relative links,
4 TOML files and 44 ignore cases (heuristic secret scan).

## 2026-10-13 — Firefox SVG document rendering, 50000% and raised separator

Owner follow-up confirmed the preceding image-dimension fix did not resolve blur
or zoom stalls. Frame now uses native SVG document rendering in an isolated,
viewport-sized frame rather than Firefox's SVG-as-image cache. The file is fetched
once through the existing authorized byte reader, parsed detached, and imported
only after the frame's trusted CSP is active. The frame never allows scripts;
external resources/navigation/forms are restricted, and its content is inert.
No raw SVG Blob is exposed for navigation. A short-lived, detached image obtains
intrinsic dimensions only, then its Blob URL is revoked. Root selectors, percentage
geometry, gradients/use/clip references, and source root transforms are preserved;
an independent clip retains the logical image canvas. Updates coalesce per rAF.

SVG now allows 1–50000%, displayed with a raised thousands separator (`50·000%`).
Raster/ICO retain 1–5000%; calculations retain full precision.

A bounded headless Firefox comparison of 40 zoom steps on the same simple
1000×1000 vector fixture, from 100% to 25000%, measured:

| Rendering path | Mean update including animation-frame wait | Maximum |
| --- | ---: | ---: |
| Previous SVG image CSS sizing | 58.0 ms | 935 ms |
| Native SVG document | 16.3 ms | 18 ms |

These are synthetic local measurements, not a guarantee for every SVG or GPU.
The initial static Chromium sharpness test had missed this image-cache behavior.
Related upstream evidence: [Firefox vector image scaling](https://bugzilla.mozilla.org/show_bug.cgi?id=1456558)
and [large SVG image rasterization](https://bugzilla.mozilla.org/show_bug.cgi?id=1712702).
A fragment-camera experiment was fast but did not preserve all source semantics;
nesting another SVG image retained the Firefox stall and was not adopted.

Final checks (targeted only):

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/image-viewport.test.ts`:
  6/6 passed for limits and geometry.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run
  --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts
  -t 'renders SVG|isolates native|clips SVG|opens SVG|small transparent|Frame'`:
  Chromium 8/8 passed, 10 skipped, 54.48s. Includes 50000% pixel sharpness, full
  keyboard/gesture/bounds/resize/mobile-axe regressions, ICO/raster, and root
  translation/scale clipping at 100%/200%.
- Firefox uses the same command with `NH_BROWSER=firefox` and the user-local
  `LD_LIBRARY_PATH` for browser libraries. Rendering/security final 2/2 passed,
  29.92s; final Fit/root-transform tests 2/2 passed, 25.00s. The other affected
  Firefox journeys passed in the earlier scoped run. Seven sharpness variants
  include viewBox-only, no viewBox, large dimensions, root CSS/percentage lengths
  and UTF-16 LE/BE. Canvas pixel assertions verify local gradients/use/clip paths;
  hostile scripts, handlers, external requests, frame navigation/forms and focus
  theft do not execute. Zoom causes no additional content requests.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, targeted Biome and
  `git diff --check`: passed. The shared harness retains its pre-existing
  non-null-assertion warning; unrelated Owner work was not reformatted/reverted.
- Actual development UI in Firefox: the reported 1000×480 vector dataset file
  opens at 50000% (500000×240000 native SVG layout), Fit and Actual size pass.
  Read-only access only; no game files or lifecycle operations changed.

Intermediate tests caught a StrictMode cancellation ref left set after rAF cleanup
(fixed), layout assertions tighter than Firefox's 1/60-CSS-pixel snapping (now
asserted within 0.05 displayed pixels), and a test-only locale init script running
inside nested frames (now top-level only). Browser request notifications include
CSP-blocked attempts; security assertions count dispatched fixture requests.
Independent review found source root transforms could paint beyond the canvas;
the separate iframe clip fixes this and has committed Chromium/Firefox coverage.
Historical failures and earlier evidence remain recorded above.

Reviewed the [Firefox 50000% fixture](screenshots/m5/file-viewer-frame-svg-50000-en-firefox.png).
Firefox and required Debian libraries were downloaded/extracted solely to the
current user's browser cache; no system package installation or upgrade. Tests
reuse approved isolated services. No deployment, container restart, provider or
Blueprint change; no game assets created or removed. Safari and physical trackpad
hardware remain outside this verification. DTD-bearing SVG is rejected; ordinary
UTF-8 and BOM-marked UTF-16 are covered. See the ADR0017 amendment for the revised
security boundary. Issue #18 and PR #21's unmerged status remain unchanged.

Independent final code/security/geometry and Firefox screenshot review found no
remaining must-fix issues. Index governance passed: 741 text files, 226 PNGs,
625 relative links, 4 TOML files and 44 ignore cases (heuristic secret scan).

## 2026-10-13 — Frame high-dot separator correction

The preceding separator was a middle dot, not the requested high dot. Frame now
uses U+02D9 (`50˙000%`); zoom calculations and bounds are unchanged. The existing
Firefox rendering test was rerun alone with `NH_BROWSER=firefox` and the browser
command above, filtered to `-t 'renders SVG vectors sharply'`: 1 passed,
17 skipped, 27.47s. The screenshot was refreshed and visually inspected. Targeted
Biome and independent scoped review passed. No infrastructure/provider interaction,
restart or new test resources; previous full rendering evidence remains valid.

## 2026-10-13 — ICO picker and first-paint Fit

Frame replaces the native ICO selector with a compact custom combobox: local
preview, dimensions, bit depth and a bounded options popup. Arrow keys/Home/End
navigate, Enter selects, Escape cancels, Tab/outside interaction dismisses it.
The file-keyed viewport keeps the toolbar mounted so selection retains focus.
The old onLoad path revealed natural dimensions before the next rAF applied Fit;
initial dimensions and Fit now commit together before paint. Interactive zoom/pan
retain their existing rAF coalescing. No provider requests are added when switching.
The Owner subsequently requested plain integer percentages: 50000%, no separator.

Targeted verification using existing approved isolated services:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run
  --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts
  -t 'opens SVG|switches ICO|small transparent|keeps Frame fit'`: Chromium 4/4 passed,
  15 skipped, 22.13s. Covers SVG/raster Fit regressions and ICO controls.
- Same command with `NH_BROWSER=firefox`, filter `-t 'opens SVG|switches ICO'`:
  2/2 passed, 17 skipped, 19.75s. Paint sampling during 256-to-128 selection
  confirms every visible sample is already fitted; no extra content reads.
  Keyboard/focus, dismissal, mobile bounds and scoped axe checks pass.
- Targeted Biome and `git diff --check` pass. The first typecheck caught the
  React composing-event property (fixed to nativeEvent.isComposing). The final
  `scripts/dev.sh pnpm --filter @nickhosting/web typecheck` remains blocked by
  concurrent unrelated work: owner-storage-policy.tsx:75 (useRef missing argument).
  Earlier errors in that concurrent storage-policy work also appeared on the first
  run; they were not changed by this task. Do not interpret this as a full typecheck pass.

Independent code/accessibility and [desktop](screenshots/m5/file-viewer-ico-picker-en.png)/
[mobile](screenshots/m5/file-viewer-ico-picker-mobile-en.png) screenshot review found
no must-fix findings. Existing localization supplies the picker name; dimensional
values retain the existing notation. Screenshots are sanitized browser fixtures.
No infrastructure restart, provider/game-file mutation, new service or test-server
asset. Existing services only, concurrent edits preserved. Issue #18 remains open.

The final Firefox `-t 'renders SVG vectors sharply'` check passed (1/1,
18 skipped, 36.09s), including the plain `50000%` label and refreshed SVG screenshot.
Index governance passed: 742 text files, 228 review PNGs, 627 relative links,
4 TOML files and 44 ignore cases (heuristic secret scan).

## 2026-10-13 — Wave custom controls and waveform

Wave replaces native audio controls with centered transport controls, repeat on the
left, speed on the right and centered volume below. The seekable SVG envelope uses
actual decoded amplitude peaks in the existing palette. Playback position samples
native `currentTime` on animation frames while playing; pointer seeking previews
immediately and commits once on release. The shared custom selector also serves
ICO, with a viewport-positioned portal so menus are not clipped on small screens.

Analysis is independent of playback: one extra full-content read, at most 32 MiB
and ten minutes, 8 kHz decode, 1024 retained peaks. Duration refinement within those
bounds does not repeat analysis. Reads abort on exit; non-abortable native decodes
are serialized and obsolete results discarded. This is not a hard browser-decoder
memory cap. Larger/longer/undecodable files retain playback/seek with a neutral
fallback. No server transcoding, new API, dependency or provider credential path.
See [browser decoding requirements](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData).

Targeted commands/evidence (existing approved isolated browser services only):

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/audio-waveform-model.test.ts`:
  4/4 pass, bounds, silence, stereo phase, peak reduction and invalid samples.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'Wave|switches ICO|opens SVG|typed SQLite'`:
  Chromium 6/6 pass, 16 skipped, 43.24s. Real browser WAV playback/seek/end/release,
  actual decoded peaks, centered geometry, keyboard, pointer scrub, mute/volume,
  repeat, speed, failed media/retry, loading, EN/IT and 320/390 px layouts. Scoped
  axe covers the viewer and portaled options. Shared ICO and native Motion/SQLite
  behavior remain covered. Desktop/mobile/loading/error screenshots are sanitized fixtures.
- A subsequent `-t 'runs Wave'` regression passed 1/1, 20.02s: simulated metadata
  refinement 59.9→60 seconds preserves ready peaks without another analysis fetch.
- `scripts/dev.sh pnpm --filter @nickhosting/web build`: pass; existing >500 kB
  main/editor chunk warnings remain. No new library or codec bundle.
- `scripts/dev.sh pnpm i18n:check`: pass, 1384 keys across EN/IT/pseudolocale.

Historical failures are retained: the initial typecheck caught an untyped tuple in
new waveform tests (fixed). Review caught a speed popup clipped by the viewer
(fixed via the shared portal) and repeated analysis on duration refinement (fixed).
The Firefox `-t 'Wave|switches ICO'` attempt was 2 pass/2 fail: unmuted playback
failed with native code 3 `OnMediaSinkAudioError`, despite decoded readyState 4;
the headless host has no usable audio sink. A standalone test-only mock-sink
preference was unavailable in that browser build; no system services were changed.
The separate loading assertion passed when isolated; retry reused Firefox's
same-URL decoded media cache, so loading/error fixtures now use distinct URLs.
Do not interpret these attempts as Firefox audio playback certification. Chromium
executes native playback; injected rejected play promises and waiting/canplay
cover only the stated UI error/buffering states.

No infrastructure changes, restarts, game-server operations or real file mutation.
No new test assets on Pterodactyl. Concurrent account/storage work is excluded.
Issue #18 and the existing M5/production-release boundaries remain unchanged.

The final interaction pass adds animation-frame playhead sampling and rearranges
repeat/transport/speed with volume underneath. Targeted `-t 'Wave'`: two tests
passed (playback and loading/recovery), including a controlled native-clock change
with `timeupdate` suppressed, proving the playhead updates on rAF. The mobile case
caught an actual 320 px overflow after that layout change; compact spacing and
speed-selector sizing correct it. Only the affected mobile case is rerun below.
Web typecheck and scoped Biome pass. Final production build also passes with the
same main/editor size warnings. No full historical suite was rerun.

Final mobile reruns: Chromium 1/1 passed (14.25s), Firefox 1/1 passed (18.92s),
using `-t 'keeps Wave mobile'` and `NH_BROWSER=firefox` respectively. Firefox
successfully decodes the real WAV waveform offline, without an output sink; this
establishes waveform/UI behavior, not unmuted playback. The final 320 px menu also
passes bounds, hit testing and scoped axe. Independent code/accessibility/visual
review found no remaining must-fix findings.

Screenshots: [desktop EN](screenshots/m5/file-viewer-wave-desktop-en.png),
[loading](screenshots/m5/file-viewer-wave-loading-en.png),
[error/retry](screenshots/m5/file-viewer-wave-error-en.png) (Chromium);
[mobile IT](screenshots/m5/file-viewer-wave-mobile-it.png),
[320 px](screenshots/m5/file-viewer-wave-320-it.png),
[speed menu](screenshots/m5/file-viewer-wave-speed-320-it.png) (Firefox).
Final screenshot inspection also corrected the waveform's loading label after a
native media failure: failed media now exposes the unavailable state and cancels
analysis rather than leaving an indefinite loading indication.
The final `-t 'shows Wave'` regression passed 1/1 in Chromium (17.84s), with
loading/error screenshots refreshed and an explicit unavailable-waveform assertion.
Final web typecheck, 12-file scoped Biome and catalog checks pass.

Owner's final visual amendment: flat initial bars, no waveform loading caption;
real peak snapshots emitted every 64 computed bins expand each band from its
center (160 ms transition, respecting reduced motion). This occurs after complete
native decoding, not during network streaming. Independent two-file review found
no must-fix. Final `-t 'Wave'`: Chromium 3/3 pass, 34.51s, including observed
partial peaks during analysis, flat initial state, smooth native-clock progress,
seek, metadata refinement, errors and mobile/axe checks. All linked screenshots
were refreshed in Chromium for this last amendment (superseding earlier Firefox
captures); prior Firefox mobile evidence applies to the preceding rendering.

### Wave — browser streaming analysis (2026-10-13)

Supersedes the full-file decode described above; historical results remain intact.
Mediabunny 1.61.4 now parses the authorized same-origin Range stream and reduces
real decoded samples into waveform peaks inside a dedicated browser Worker.
Native playback remains independent. No backend decoder, Blueprint change,
provider credential or game-file mutation is involved. Limits remain 32 MiB,
ten minutes and eight channels; larger/unsupported media retains native playback
with the unavailable-waveform state. Explicit source cache: 2 MiB; 4 KiB peaks
and 16 KiB scratch, excluding decoder/metadata/network allocations.

Focused commands:

```sh
scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/audio-waveform-model.test.ts apps/web/src/features/viewer-engine/builtin-viewers/audio-waveform-stream.test.ts
scripts/dev.sh pnpm --filter @nickhosting/web typecheck
scripts/dev.sh pnpm --filter @nickhosting/web build
scripts/dev.sh pnpm exec biome check apps/web/src/features/viewer-engine/builtin-viewers/audio-waveform.tsx apps/web/src/features/viewer-engine/builtin-viewers/audio-waveform-worker.ts apps/web/src/features/viewer-engine/builtin-viewers/audio-waveform-stream.ts apps/web/src/features/viewer-engine/builtin-viewers/audio-waveform-stream.test.ts apps/web/tests/file-viewers.browser.test.ts apps/web/tests/harness.ts apps/web/package.json
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'Wave'
```

Unit tests: 12/12 pass (752 ms). Typecheck and production build pass; existing
main/editor >500 kB warnings remain. Scoped Biome passes with the pre-existing
`browser!` harness warning. Initial Chromium browser run: 5/5 pass (41.35 s),
including real HTTP partial-body decoding, cancellation, oversized response,
native playback/seek and mobile/axe. Tests use existing isolated DB services,
real browser/native decode and a Node HTTP WAV fixture; provider operations are
mocked. No real game file is written. This does not certify every media codec.

Final review removed a redundant metadata-duration lookup: the native seek
timeline is authoritative for rendering; significant decode overrun/shortfall
fails waveform analysis instead of silently clipping or claiming completeness.
Firefox initially failed the HTTP-cancellation assertion after viewer exit;
explicit cancellation now aborts fetch and disposes the decoder before worker
termination. Final browser outcomes and activation evidence follow below.

Firefox investigation retained: termination alone and then explicit abort both
failed the intercepted HTTP test. A two-second test-only termination delay also
failed; it was removed. The same real Worker in a fresh page without Playwright
routing closed the HTTP response correctly. The final UI regression therefore
uses same-origin Node fixture handlers and an unrouted page, not `route.continue`,
which still invokes Firefox interception. Assertions still require actual
partial peaks before EOF and actual HTTP closure on viewer exit.

Final Firefox streaming UI regression: 1/1 pass (21.12 s). The 960,044-byte WAV
produced nonzero Worker peaks 7 ms after the first response byte, with 262,144
bytes (27.3%) delivered and the remaining body deliberately held. EOF followed
278 ms later. This demonstrates incremental behavior; the artificial held tail
is not a production throughput benchmark. Firefox mobile/axe also passed in the
earlier two-test run whose separate intercepted cancellation case failed.
Previous Firefox unmuted audio-sink limitation remains unchanged.

Worker production artifact: 240,942 bytes raw, 62,626 gzip, 53,272 Brotli.
Only eligible Wave analysis loads it. MPL-2.0 full notice and corresponding
unmodified upstream source references ship in THIRD-PARTY-WORKER-NOTICES.txt.
Independent code review found no remaining must-fix after the native-duration
and explicit cancellation corrections.

Owner explicitly approved updating only the development Vite image. Saved
`nickhosting-dev-vite-before-mediabunny:5791f01`, then ran:

```sh
docker compose --env-file .env.dev.local build vite
docker compose --env-file .env.dev.local up -d --no-deps --wait vite
```

Initial activation exposed a real Vite optimizer memory failure: discovering the
Worker-only dependency after the app scan triggered a second dependency bundle,
exceeding the existing 768 MiB limit and killing Vite. HTTPS briefly returned 502.
`optimizeDeps.include: ['mediabunny']` now includes it during initial preparation;
restarted only `nickhosting-dev-vite-1` to finish the approved activation. No memory
limit was increased. HTTPS subsequently returned 200, Worker module returned 200,
and the new process cgroup showed no OOM events. No other service was recreated.
The container retains only `nickhosting-dev-edge`, no published ports; image is
`sha256:3c202670072279383ebed42d7c09511fb19e9a642a23da1e9aac932f1019d894`.
Existing SFTPGo orphan warning was not acted upon; no cleanup was authorized or
performed. Gateway was already unhealthy before activation and is outside this
Wave task. Production, game servers, database and provider settings were untouched.
Rollback: revert this Wave change, restore the saved image tag and recreate only
Vite with the same Compose service scope. Issue #18 remains a release gate.

Final Chromium same-stream regression: 1/1 pass (16.39 s), first peak 9 ms after
first byte at the same 262,144/960,044-byte boundary, 145 ms before held EOF.
Both browsers prove HTTP cancellation on exit without weakening the assertion.
Final rerun command selected `-t 'draws real Wave peaks'`, with
`NH_BROWSER=firefox` for Firefox and `--silent=false` for test-only metrics.
The default five-test Wave suite was not repeated after these targeted fixes.
Final web source/test typecheck and scoped Biome pass; no historical M1–M5 suite
was rerun. The development prebundle correction also passed independent review.
Screenshot: [actual partial waveform](screenshots/m5/file-viewer-wave-incremental-en.png).

Live development smoke also fetched `/@vite/client` over HTTPS and established
`wss://dev.hub.nickhost.ing/__nickhosting_hmr` with Vite's current client token,
receiving the `connected` event. No token was logged. Repeated HTTPS and container
health checks stayed successful; cgroup OOM counters remained zero after recovery.

Final visual inspection caught one genuine incremental-rendering issue: leading
throttling left later decoded peaks unpublished while awaiting another network
chunk. A single trailing timer now flushes those real peaks within 50 ms and is
cleared on completion/error. Three new regressions cover held-source progress,
no late publication after completion/failure and callback errors. Independent
review found no must-fix. The browser assertion now also requires display bar 10
(about seven seconds into the file) to grow before the held body is released,
not merely the first peak. Firefox strengthened test: 1/1 pass (20.88 s), first
peak 10 ms, the same 27.3% byte boundary and actual HTTP close on exit.
Final production build/typecheck and eight-file Biome pass. Updated Worker size:
241,128 bytes raw, 62,712 gzip, 53,295 Brotli.
Final strengthened Chromium stream test: 1/1 pass (15.41 s), first peak 25 ms;
bar 10 grew with only 262,144/960,044 bytes received, cancellation still passed.
Final combined units: 15/15 pass (629 ms). Screenshot refreshed and independently
reviewed: received portion has real amplitude, unread remainder stays flat;
centered controls retain their layout with no additional loading copy.

### Wave per-bar reveal (2026-10-13)

Owner-requested presentation refinement: each newly available bar rises over
180 ms, with starts spaced 8 ms apart. Incoming batches continue the sequence;
refined peaks update an active animation's destination without restarting it.
Both playback-color layers share timing. Decoding/playback/seek are unchanged.
Reduced motion bypasses/cancels the reveal, file exit cancels pending animations,
and viewport resizing does not replay already received data. The effect only
runs when peak geometry changes, not on playback animation frames.

Web typecheck and production build pass (existing large app/editor chunk warnings
remain). No dependency, API, Worker, infrastructure or live file changes; dev uses
ordinary Vite HMR. Independent review and focused browser evidence follow.

Focused Chromium real-stream regression passes 1/1 (14.53 s), using the existing
`-t 'draws real Wave peaks'` browser command. An observer of actual Web Animations
verifies unique ascending first appearances, equal timing in both color layers,
8 ms stagger and 180 ms rise. Changing reduced motion cancels pending animations
and suppresses new reveals. Real partial decode and HTTP cancellation still pass.
Independent code review found no must-fix. Screenshot refreshed from the actual
browser; no historical suites or Firefox matrix rerun for this presentation change.
The final test typecheck initially caught the browser's wider CSSNumericValue
animation-duration type; the test observer now uses the native getTiming return
type. Final web source/test typecheck passes. Scoped Biome and indexed governance
pass (782 text files, 239 PNGs, 638 links, four TOML files, 44 ignore cases).

### Wave Play feedback (2026-10-13)

The player previously requested only metadata before Play and displayed every
native waiting event immediately. Bounded audio previews (positive size <=32 MiB)
now request native automatic preloading; larger media remains metadata-only.
This is a browser hint, not a promise of instant network/decoder availability.
A 200 ms continuous-wait threshold applies only to the buffering label; Play is
still issued immediately. Recovery, pause, errors and exit cancel the notice.

Targeted Chromium `-t 'runs Wave|shows Wave'`: 2/2 pass (24.94 s), exercising real
WAV playback, a 50 ms injected wait with no transient announcement, persistent
waiting feedback, error/retry and the preload attribute. Injected waiting events
prove UI behavior, not real-provider timing. Web typecheck and scoped Biome pass;
independent review found no must-fix. No infrastructure, restart, dependency,
provider or real file changes. No full suite rerun for this presentation fix.

### Wave playback clock polish (2026-10-13)

Play now synchronizes the actual native paused state immediately after play(),
without awaiting queued media events. The native currentTime animation loop lives
in a separate timeline subtree; transport controls and number formatters no longer
rerender for each clock frame. Unchanged control snapshots retain their state.
Ten-second skips read the current native position. No speculative clock or
artificial advancement is introduced; browser media startup still applies.

Validation:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'runs Wave|shows Wave' --silent=false`: Chromium 2/2 pass (26.49 s). Real WAV playback still exposes Pause with play/playing/timeupdate events withheld by the test. The isolated clock-update regression advances the slider while constructing zero playback-speed formatters. Seek, drag, pause, skips, volume, repeat, rate, ended, stream cleanup, waiting/error/retry and scoped axe checks remain covered.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: pass, source and tests.
- `scripts/dev.sh pnpm --filter @nickhosting/web build`: pass; existing app/editor chunk-size warnings remain.
- Scoped Biome and governance checks: pass.

Independent code review found no must-fix across playback, scrubbing, retry and
cleanup. This is focused browser-fixture evidence, not a new latency benchmark on
the Owner's Firefox/audio device. Layout and copy are unchanged; existing Wave
screenshots remain representative. No production/provider interactions, persistent
test assets, dependencies or container restarts; development uses Vite HMR.
Rollback is a revert of this UI/test change. PR #21 remains open and unmerged.

### Open viewer restoration after refresh (2026-10-13)

Files previously remembered only the directory, losing its open viewer at Ctrl+R.
A bounded, tab-local bookmark now retains the file path and selected compiled
viewer ID, scoped to the existing user/support identity and server. Restoration
reuses the current folder listing and normal open/read flow; missing files return
to the listing. Explicit navigation and save recovery take precedence. Leaving
Files clears the bookmark; returning to the tab still starts at root.

No contents, drafts, credentials or signed URLs are persisted. Text refresh reads
the saved file; accepting a reload with an unsaved draft still discards that draft.
Archive containers reopen at their root, without restoring inner paths, playback
position or zoom. No visual layout/copy changes or new network endpoints.

Validation commands:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'restores the open viewer' --silent=false`: final Chromium 1/1 pass (26.60 s). Image, one-time JSON-to-text selection, forced non-text JSON Tree selection, saved text, unsaved-draft exclusion, tab exit and subsequent reload covered. The earlier narrower version passed 1/1 in 28.59 s before adding non-text selection coverage.
- Same command with `apps/web/tests/file-upload-refresh.browser.test.ts -t 'restores the current nested folder|returns to root after leaving Files'`: 2/2 pass (15.49 s), preserving directory reload, root return, browser Back and cancelled unsaved navigation.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: pass.
- `scripts/dev.sh pnpm --filter @nickhosting/web build`: pass; existing app/editor chunk-size warnings remain.
- Scoped Biome, diff whitespace and indexed governance checks: pass.

Independent review found no must-fix; its suggested non-text viewer callback
coverage was added and passed. Isolated browser fixtures only; no real provider
mutation, persistent test assets, dependency changes or container restarts. Vite
HMR applies the change. Rollback: revert this UI/session change. PR #21 stays open.

### AAC waveform and playback duration (2026-10-13)

Raw ADTS AAC has no declared duration. The old envelope used the media element's
bitrate estimate and could reject valid decoded samples as incomplete. Wave now
uses Mediabunny's encoded-frame duration for ADTS, retaining strict envelope
completeness checks. The same duration reaches the seek slider, time labels and
waveform progress; a native end position beyond that endpoint is clamped.

The Owner confirmed their Firefox decodes both AAC audio and waveform; the
remaining issue was the mismatched timeline. No alternate decoder dependency was
added. Firefox in the isolated Linux probe lacked AAC WebCodecs support, which is
an environment limitation, not a claim about the Owner's browser. Native Web
Audio also failed in that probe; evaluated software packages were not retained.

Read-only real dataset check in Chromium through the running dev app:
`bbb-music.aac` native estimate 18.478376 s; corrected slider 18.0266666667 s,
visible total 0:18, completed waveform with nonzero amplitudes. No file writes or
playback/power commands to game servers. ADTS scans encoded frames before decode;
waveform arrival can wait for this scan and reread bytes outside the existing
2 MiB cache. Native playback is independent. Other formats retain their previous
progressive path. No new infrastructure, dependencies, persistent test assets,
backend APIs or container restarts. Development uses Vite HMR.

Validation: waveform model/stream units 15/15 (435 ms); web typecheck and production
build pass (existing app/editor chunk-size warnings); scoped Biome passes.
Independent review found no must-fix in cancellation, source reset or duration
propagation. Focused browser regression results recorded below. Rollback: revert
this frontend change; PR #21 remains open and unmerged.

Browser command: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'aligns Wave playback|runs Wave' --silent=false`.
The existing real-WAV controls test passed. The new duration-contract test first
timed out because its Worker stub expected a nonexistent `type: start` field;
the stub was corrected to the actual `{url,size,duration}` request. Rerunning only
`-t 'aligns Wave playback'` passed 1/1 (19.73 s). This test simulates native 20 s
versus decoded 18 s: slider/labels use 18, position 9 maps to 50%, skips clamp to
18, native ended at 20 stays at 18/100%, and a new file resets the duration.
This synthetic UI regression complements the separate real AAC check above.
Final source/test typecheck, scoped Biome, whitespace and indexed governance pass.

### Wave playhead interpolation (2026-10-13)

The visual clock now bridges quantized native media observations on each display
animation frame. It never writes playback time: small phase corrections are
bounded to 10% of playback speed, prediction to 100 ms of wall time at the current
rate. Pause/waiting/seek/end/error reset to native time; playing resumes it.
Rate changes, loops and background gaps re-anchor the clock. No dependencies,
API calls, provider changes or infrastructure restarts were added.

Read-only Firefox probe on the same 1.8 s WAV and 600 px seek bar: before,
63 repeated native readings and 63 repeated UI positions; after, 63 repeated
native readings and **zero repeated UI positions**. Median RAF interval 17.04 ms,
positive native step 40.24 ms, UI step 17 ms (maximum 20 ms). This is headless
Firefox evidence, not a measurement on the Owner's 240 Hz monitor. The pure clock
regression simulates 60/120/144/240 Hz over 30 seconds, verifies monotonic steps
and bounded drift, and covers rate changes, stalled clocks, seeks, loops and
frame gaps: **9/9 passed** (682 ms). Command:
`scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/audio-playback-clock.test.ts`.

Web source/test typecheck passed via
`scripts/dev.sh pnpm --filter @nickhosting/web typecheck`; focused Biome checks
passed. Independent read-only clock/event review found no must-fix findings.

Focused Chromium browser run: **2 passed, 25 skipped** (29.04 s), covering the
quantized-clock lifecycle and existing real WAV transport/stream-release test:
`scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'interpolates quantized Wave|runs Wave' --silent=false`.
The first run passed the new test but exposed an existing fixture withholding
`playing` permanently; it now redelivers that intentionally withheld event before
asserting playback-clock behavior. The new fixture covers waiting/canplay hold,
playing resume, pause, seeking, rate changes and document visibility; native
currentTime remains unchanged. These controlled events complement the separate
real Firefox probe, rather than claiming a physical 240 Hz browser test.
The [player screenshot](screenshots/m5/wave-interpolated-playhead.png) was reviewed;
layout and controls are unchanged. No game files or server state were mutated.
Rollback: revert this frontend-only change; no migrations or data cleanup.

### Wave ten-second skip animation (2026-10-13)

Back/forward buttons still change native playback time immediately. Only the
playhead and played-waveform overlay travel, together, using a 280 ms cubic
ease-in-out. The destination follows the playback clock, avoiding a completion
snap while audio is playing. Repeated skips accumulate from native time and
retarget from the drawn position. Direct pointer/keyboard seeking cancels the
tween; reduced motion disables it. Hidden documents, media errors/source teardown
and unmount release the animation. No backend, dependency or infrastructure
changes. Independent read-only review found no blocking findings.

The existing playback-clock unit suite passed **9/9** (864 ms), with the same
command documented above. Source/test typecheck and focused formatting checks
are run for this frontend-only change; no historical integration-suite rerun.

Final targeted browser run: **4 passed, 24 skipped** (36.70 s): immediate native
seek versus intermediate visual positions in both directions, waveform/cursor
alignment, repeated skips, direct keyboard cancellation and reduced motion,
plus the existing AAC duration, quantized-clock lifecycle and real Wave controls.
Command: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'animates Wave skip|aligns Wave playback|interpolates quantized Wave|runs Wave' --silent=false`.
Final web typecheck and scoped Biome passed. Static layout is unchanged; the
existing player screenshot remains representative, while frame samples prove
the new motion. No production mutations, restarts or test assets were required.
Rollback: revert this frontend-only commit.

### Wave keyboard controls and shared viewer Escape (2026-10-13)

Left/Right seek five seconds; Shift doubles this to ten. Space after pointer
interaction toggles playback even when a control retains focus; actual Tab
navigation keeps native control semantics. Inputs, editable hosts and open
menus/dialogs retain their keys. Held arrows cancel visual easing and seek
immediately on repeat, avoiding the slow repeated ease-in reported by the Owner.
Single presses retain the previous skip animation. Repeated Space is ignored.

Every viewer/editor now uses Escape to invoke the existing Home action, returning
to the current folder with normal focus restoration and unsaved-change guard.
Child handlers and transient overlays retain first Escape; closed native selects
do not trap it. Independent review identified editable-host/account-menu exclusions
and a native-select veto; all were corrected before final checks.

Focused browser commands/results:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'routes Wave shortcuts|runs Wave' --silent=false`: **2 passed, 27 skipped**, 35.48 s. Covers ±5/±10, Space, pointer versus Tab, native volume, held arrows/no leftover tween, inputs/contenteditable/dialog/menu exclusions and listener cleanup.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewer-escape.browser.test.ts --silent=false`: **3/3 passed**. All seven builtin viewers/editor, current-folder return, closed SQLite select, overlay precedence and accept/decline of dirty editor changes. These navigation tests intentionally fixture media errors/archive/database metadata, not codec functionality.

Escape test iteration fixed fixture navigation that persisted the prior folder;
a concurrent Vite optimizer run also produced duplicate React instances. Final
Escape tests were run serially and passed after the other browser run finished.
Web typecheck and focused Biome passed. No UI copy/layout changes; existing
screenshots remain representative. No infrastructure restarts, provider writes,
or persistent test assets. No must-fix review findings remain. Rollback is a
frontend source revert. Motion implementation has not started.

### Motion AVI and trickplay investigation only (2026-10-13)

Read-only same-origin authenticated Range inspection of the Owner-provided test
dataset read 64 KiB from each AVI (206 responses): `bbb-action-75s-480p.avi`
(13,894,454 bytes, 854×480, 24 fps, 1801 frames) and
`bbb-short-12s-360p.avi` (1,497,502 bytes, 640×360, 30 fps, 361 frames).
Both have RIFF/AVI headers, FMP4 video (MPEG-4 Part 2) and MP3 audio
(format tag 0x55), stereo 48 kHz. These codec/header checks are not full-file
integrity certification. Native Firefox test of the short AVI failed with media
error 4, “Failed to init decoder”; AVI and MP4/MPEG-4 Part 2 canPlayType probes
returned empty. Transport succeeded; no source file was modified or converted.
[FFmpeg's RIFF codec mapping](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/riff.c)
identifies the tags. Browser playback needs a supported codec/container; merely
renaming or remuxing this unsupported video codec is insufficient.

Proposed only: reuse installed Mediabunny for lazy worker-based timeline thumbnails
on supported formats, one decode in flight, latest requested position prioritized,
small retained-image cache and bounded Range reads. Preceding-keyframe previews
reduce decode work at the cost of approximate timing; exact frames may require
intermediate decoding. A small thumbnail reduces retained image memory, not
necessarily source-decoding cost. AVI/MPEG-4 Part 2 are not supported by the
installed library; no fallback decoder/dependency or server transcode was added.
Sources: [supported formats](https://mediabunny.dev/guide/supported-formats-and-codecs),
[CanvasSink](https://mediabunny.dev/api/CanvasSink),
[reading and disposal](https://mediabunny.dev/guide/reading-media-files).
The Owner will review before Motion development begins.

### Wave restart after manual endpoint seek (2026-10-13)

Owner reported first-Play immediate pause at a manually selected endpoint, and
looped playback with the visual position stuck at the end. Play previously relied
entirely on the browser's own EOF rewind. It now explicitly rewinds through the
existing timeline seek path when native ended or currentTime reaches the effective
(decoded, where available) endpoint. This cancels visual skip animation and resets
native and predictive clocks before play(), including Repeat. No artificial wait
or widening of normal mid-file seek behavior was added. The exact Owner-browser
native event ordering was not captured; this fix handles the endpoint explicitly.

Targeted browser regressions **2 passed, 28 skipped** (19.00 s): actual WAV paused
at its endpoint with Repeat off/on must restart native audio, slider and waveform
on the first Play; the controlled decoded18/native20 duration case also restarts
at the effective endpoint. Command:
`scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'restarts Wave audio|aligns Wave playback' --silent=false`.
Independent read-only review found no blockers. This adds no provider operations,
API changes, dependencies or infrastructure restart. Revert the frontend change
for rollback. Motion remains investigation only.

### Motion custom video player (2026-10-13)

Owner-authorized implementation follows the earlier AVI/trickplay investigation.
Motion now uses native video playback with its own compact transport controls,
real buffered ranges, display-frame timeline interpolation, repeat, volume,
speed, fullscreen and capability-gated Picture-in-Picture. Keyboard behavior is
shared with Wave: Space, ±5 seconds with arrows, ±10 with Shift, held-arrow
repeat and native keyboard navigation in controls. Escape preserves transient
menus/fullscreen before leaving the viewer. No autoplay, server transcoding,
provider API changes or game-file mutation were introduced.

Optional timeline thumbnails use Mediabunny's existing dependency in a dedicated
lazy worker. Authenticated same-origin Range reads select preceding keyframes,
not a full-video analysis. Work has a single pending position, bounded byte/time
budgets, a 32-image LRU and cancellation on pointer exit, hidden document or viewer
exit. Thumbnail decoding failure leaves playback and timestamp seeking usable.
Native codec support still determines whether a video plays: the previously
inspected AVI/MPEG-4 Part 2 file is not made compatible by this UI change.

Independent review found and resolved: mobile fullscreen controls clipping,
preview work continuing after pointer exit, predictive timeline advancement
during buffering, and error-message contrast. Browser interaction additionally
caught stage focus revealing controls before the click immediately hid them;
stage pointer focus no longer races the click. The first five-case browser pass
preceded these expanded checks; intermediate expanded runs failed on contrast,
that real focus defect and test setup assumptions. Those failures are retained
here rather than described as successful validation.

The browser fixture is original generated artwork (60-second VP9/WebM, moving
circle and timestamp), stored as text base64 for reproducibility. It exercises
native decoding and the real worker against an isolated HTTP Range handler;
provider data and authorization sessions come from the existing isolated M2 test
harness. This does not certify every container/codec, actual touch hardware,
all assistive technologies or the Owner's 240 Hz display.

Independent visual/content review inspected real rendered desktop English and
320 px Italian screenshots: controls remain legible and unclipped, layout and
copy are compact, no decorative dashboard/card layer or unsupported success
state is added. One existing application theme; fullscreen/mobile/error/loading
states are also captured. No new Docker resources, container restart, Panel/Wings
change, real server operation or production interaction was needed. Development
uses existing Vite HMR. Rollback is a frontend/source revert; no migration or
persistent-data rollback is involved. SFTPGo issue #18 remains unchanged.

Focused validation (no historical full-suite rerun):

- `scripts/dev.sh pnpm exec vitest run apps/web/src/app/i18n.test.ts apps/web/src/features/viewer-engine/builtin-viewers/audio-playback-clock.test.ts`: **13 passed**.
- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/video-thumbnail-model.test.ts`: **8 passed**, including cancellation retaining cache, coalescing, eviction and streamed-read budget.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: **pass**, app and browser-test TypeScript.
- `scripts/dev.sh pnpm --filter @nickhosting/web build`: **pass**, existing large app/editor chunk warnings remain. Media UI is 31.65 kB (9.29 kB gzip); the 258.79 kB thumbnail worker is loaded on demand.
- Scoped `scripts/dev.sh pnpm exec biome check` over all changed TS/TSX/CSS files: **pass**. `git diff --check`: **pass**.
- `scripts/dev.sh pnpm i18n:compile`: **1402 complete EN/IT keys**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion.browser.test.ts --silent=false`: final Chromium **8/8 passed**, 29.34 s. Covers real VP9 playback and thumbnails, Range cancellation, buffering-clock hold, transport and keyboard, repeat/end replay, speed/volume, fullscreen portals, conditional PiP, loading/error/retry, cleanup, automated axe and responsive screenshots.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewer-escape.browser.test.ts --silent=false`: **3/3 passed** after the video selector update.

Reviewed screenshots: [desktop with thumbnail](screenshots/m5/file-viewer-motion-preview-desktop-en.png), [mobile Italian](screenshots/m5/file-viewer-motion-mobile-it.png), [320 px Italian](screenshots/m5/file-viewer-motion-320-it.png), [fullscreen](screenshots/m5/file-viewer-motion-fullscreen-en.png), [430 px fullscreen](screenshots/m5/file-viewer-motion-fullscreen-430-it.png), [loading](screenshots/m5/file-viewer-motion-loading-en.png), [error](screenshots/m5/file-viewer-motion-error-en.png).

Firefox command: `NH_BROWSER=firefox scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion.browser.test.ts --silent=false`: final **8/8 passed**, 41.27 s. Both browsers decoded actual VP9 frames through native playback and the Mediabunny worker; neither used the time-only thumbnail fallback in this fixture. A first Firefox run passed 7/8 with a test-helper navigation/session-restore race; explicitly closing the previous viewer corrected the helper, with no product-code workaround. Fullscreen entry/exit and the speed menu portal were verified. PiP coverage requires either actual API success with enter/exit state or an honest localized rejection; it does not certify a visible OS PiP window on every platform.

Shared-keyboard regression: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'routes Wave shortcuts|runs Wave' --silent=false`: **2 passed, 28 intentionally skipped**, 24.87 s. Independent review reports no remaining must-fix findings. [Firefox rendered preview](screenshots/m5/file-viewer-motion-preview-desktop-en-firefox.png) also confirms real thumbnail decoding; its “Pop out this video” overlay is browser-owned Firefox UI.

`python3 scripts/check-governance.py`: pass on the final index, including documentation links, TOML, ignore fixtures, tracked-content hygiene and reviewed PNGs (secret detection remains heuristic). Test harnesses closed; no real Pterodactyl test assets were created or changed. PR #21 remains open and unmerged.

### Motion stage zones and temporary speed gestures (2026-10-13)

Owner-requested invisible zones replace the old stage controls toggle: left 20%
held applies temporary 2×, middle 60% click toggles play/pause, right 20% click
hides controls even while paused. Controls remain independently clickable. Pointer
capture restores the chosen speed on release outside the original zone, cancel,
lost capture, blur, hidden document, pause/end/error or viewer exit. A drag does
not accidentally activate the center/right action. Holds never autoplay paused
media. Space tap toggles on keyup; a 250 ms hold applies 2× until release without
then toggling playback. Wave keeps its prior keydown behavior.

F/M toggle fullscreen/mute only with focus inside Motion. Independent review
identified this focus restriction as necessary for single-character shortcut
accessibility; it is implemented and covered alongside input exclusions. No
remaining must-fix review findings. Prior speed (tested at 1.5×) is restored;
menus and keyboard-navigation controls retain native behavior. No subtitle loader
or internal-track selector was added: Motion still does not claim subtitle
support. No backend/provider changes, infrastructure operations, live test assets
or container restarts. Existing HMR applies the change; rollback is a source
revert. Appearance is unchanged, so the prior reviewed Motion screenshots remain
representative.

Checks:

- Motion browser command from the preceding entry: **9/9 Chromium passed**, 36.96 s, before the final F/M focus restriction.
- `NH_BROWSER=firefox scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion.browser.test.ts -t 'three stage zones|plays actual video|hides controls' --silent=false`: **3 passed, 6 skipped**, 25.38 s before that focus refinement.
- Final focused Chromium command: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion.browser.test.ts apps/web/tests/file-viewers.browser.test.ts -t 'three stage zones|routes Wave shortcuts|runs Wave' --silent=false`: **3 passed, 36 skipped**, 42.57 s. Includes actual pointer cancellation, held/short Space, speed restoration, F/M inside/outside player, input exclusions and Wave regressions.
- Final web `typecheck`, production `build`, scoped Biome and `git diff --check`: **pass**. Existing large app/editor build warnings remain. `pnpm i18n:compile`: **1403 EN/IT keys** plus pseudolocale.
- Final Firefox gesture-only command uses `NH_BROWSER=firefox` and `-t 'three stage zones'`: **1 passed, 8 skipped**, 16.28 s, including the focus restriction. Final indexed governance check passes. All browser harnesses closed; historical full suites were not rerun for this UI-only change.

### Motion embedded audio selection through one native media clock (2026-10-13)

M5 / `milestone/m5-webpanel`, PR #21. Motion now discovers internal audio names,
languages and browser-supported codec pairs and provides a compact headphone
selector. Supported multitrack MKV/MP4/WebM media uses Mediabunny 1.61.4 to remux
the original compressed video and selected audio into fragmented MP4 for one
native video element. There is no server conversion, second audio playback clock,
new dependency or Blueprint change. Native single-track playback remains the fast
path; unsupported optional discovery must not invalidate otherwise working native
playback. Browser capability checks are not a blanket codec certification.

Switches preserve paused/playing intent, time, speed, volume and mute. Superseded
selections cancel their reads/buffers, unbuffered seeks restart from an indexed
keyframe, and leaving the viewer releases native media and request resources.
Transport changes are disabled during switching while the track selector remains
available. Metadata/packet caches, prefetch, fragments and read budgets are
bounded; startup/update deadlines prevent indefinite loading. Detailed limits
are recorded in FRONTEND-I18N.md. Indexed duration and bounded keyframe distances
are required. Embedded subtitles, transcoding, negative-timestamp certification
and physical display/speaker synchronization within one millisecond are not
claimed.

The new fixture is original, generated locally with the project's pinned
Mediabunny/Chromium: 40 seconds of VP9 video and two Opus tracks, named English tone
and Tono italiano, with 440/880 Hz tones and shared-timestamp visual/audio markers.
Its reproducible generator and base64 asset are committed. Tests use the existing
isolated browser/API harness and Range fixture; no real user media/server writes,
new Docker resources, container restart, Panel/Wings/network change or production
access. Development receives source changes through existing HMR. Rollback is a
frontend/source revert; SFTPGo #18 remains an independent release gate.

Independent read-only review found and resolved potential indefinite no-common-
range startup, incomplete deadlines, stale playback intent during switching,
read-budget renewal and misleading optional-discovery errors. Final technical
and desktop/mobile UX review reports no remaining must-fix findings. Real-file
coverage is still dependent on the Owner's MKV and its codecs.

Focused checks (no historical milestone-wide rerun):

- `scripts/dev.sh pnpm exec vitest run apps/web/src/app/i18n.test.ts apps/web/src/features/viewer-engine/builtin-viewers/video-mse.test.ts apps/web/src/features/viewer-engine/builtin-viewers/video-thumbnail-model.test.ts apps/web/src/features/viewer-engine/builtin-viewers/audio-playback-clock.test.ts`: **34/34 passed**, including 13 new Range/budget/cancellation/SourceBuffer tests.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: **pass**, application and browser-test TypeScript.
- `scripts/dev.sh pnpm --filter @nickhosting/web build`: **pass**; existing large app/editor warnings remain. The lazy media bundle now includes remux support: 322.46 kB / 86.14 kB gzip. No dependency was added.
- Scoped `scripts/dev.sh pnpm exec biome check` over changed source, CSS, translations, tests and fixture generator: **pass**. `scripts/dev.sh pnpm i18n:compile`: **1408 EN/IT keys**, plus pseudolocale.
- `NH_BROWSER=firefox scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion-audio.browser.test.ts --silent=false`: final **4/4 passed**, 38.22 s. This verifies the real native MSE source, selected track metadata, video progression, settings/position preservation, seeks/buffer windows, repeat/end replay, cancellation, mobile layout and automated axe.

Firefox evidence limitation: two tests explicitly report their frequency-analysis
substep unavailable. The initial run timed out waiting for Web Audio `resume()`;
a standalone oscillator triggered by a trusted click also remained suspended
(`resume` unresolved, no measurable output). The test now bounds that optional
inspection and does not attach an inactive analyzer to the video. Product code
was not relaxed to accommodate the headless audio environment. Firefox selection
and video-playback assertions still run; its physical audio output is **not**
certified by these tests. Chromium frequency-analysis assertions are mandatory.
The first Chromium multitrack run passed 3/3 before adding the repeat regression.

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion-audio.browser.test.ts --silent=false`: final Chromium **4/4 passed**, 27.06 s. Mandatory FFT detects actual 440→880 Hz switching and the final 880 Hz choice after rapid selections. Also verifies pause/time/rate/mute/volume retention, seeks across 28/3/21 seconds, buffer targets, repeat/end replay, held-read cancellation, disposal and mobile axe.
- Browser fixtures ran on installed Chromium 156 and Firefox 157, not Safari/iOS hardware or every desktop codec stack. Safari's ManagedMediaSource branch is capability-guarded but unverified on real hardware.

Reviewed real rendered screens: [Chromium desktop EN](screenshots/m5/file-viewer-motion-audio-desktop-en-chromium.png), [Chromium mobile IT](screenshots/m5/file-viewer-motion-audio-mobile-it-chromium.png), [Firefox desktop EN](screenshots/m5/file-viewer-motion-audio-desktop-en-firefox.png), [Firefox mobile IT](screenshots/m5/file-viewer-motion-audio-mobile-it-firefox.png). Metadata track names are intentionally preserved rather than translated; all application labels/errors are localized. No clipping or inaccessible native-select substitution was found.

Existing-control regression command:
`scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion.browser.test.ts apps/web/tests/file-viewers.browser.test.ts -t 'M5 Motion video viewer|routes Wave shortcuts|runs Wave' --silent=false`
ran **10 passed, 1 failed, 28 intentionally skipped**. The thumbnail cancellation
fixture armed its generic non-video Range stall before opening the file, also
stalling the newly added optional track-discovery reads. It now arms the stall
after native playback is ready, isolating the hover operation it intends to test.
No product workaround was added. The affected-only rerun with
`apps/web/tests/motion.browser.test.ts -t 'cancels an actual pending thumbnail'`
passed **1/1, 8 skipped**, 12.72 s. Other native Motion and shared Wave regression
assertions passed in the original run; they were not needlessly rerun wholesale.

Final Firefox native-control regression:
`NH_BROWSER=firefox scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion.browser.test.ts -t 'plays actual video|three stage zones|cancels an actual pending thumbnail' --silent=false`: **3 passed, 6 skipped**, 23.61 s, including the corrected thumbnail fixture. Browser harnesses closed and all generated test media remains local/original; no live game-server assets were created or cleaned.

`python3 scripts/check-governance.py` and indexed `git diff --check`: **pass**,
including relative documentation links, tracked-content hygiene, ignore fixtures,
TOML and reviewed PNGs. Secret scanning remains heuristic. Final independent
review also checked the disclosed Firefox measurement limit and found no hidden
pass substitution or remaining must-fix. PR #21 stays open and unmerged.

### Motion viewport and aspect-ratio fit (2026-10-13)

Motion replaces its fixed 65vh / 672 px height with the native video's aspect
ratio constrained to the remaining viewport below the Files toolbar, leaving
16 px at the bottom. A Motion-only wrapper override removes the old minimum
height that otherwise left unused dark space. Video remains `object-fit: contain`:
unavoidable bands stay when preserving the whole image requires them. Short
screens retain a usable control area and may scroll. Source metadata, intrinsic
resize, window/visual viewport and toolbar changes update geometry; ordinary
page scrolling cannot progressively enlarge the player. Fullscreen is unchanged.

- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: **pass**.
- `scripts/dev.sh pnpm --filter @nickhosting/web build`: **pass**, existing large app/editor chunk warnings remain.
- Scoped `scripts/dev.sh pnpm exec biome check` on the layout hook, video component/CSS and Motion browser test: **pass**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion.browser.test.ts -t 'fits native video proportions|controls volume, repeat|keeps Italian controls' --silent=false`: **3 passed, 7 skipped**, 24.60 s on the actual workspace. Covers larger desktop sizing, native proportions, wrapper slack, metadata resize, short-window scroll stability, mobile/axe and fullscreen controls.
- `NH_BROWSER=firefox scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion.browser.test.ts -t 'fits native video proportions' --silent=false`: **1 passed, 9 skipped**, 28.90 s.

The initial browser attempt was blocked before Motion loaded by an unfinished,
unrelated parallel `server-browser.css` import. A disposable snapshot attempt
also stopped during harness setup (missing local dependency/test-path wiring);
no product workaround was applied. Once the parallel file existed, the actual
workspace runs above passed. The snapshot was removed. Historical full suites
were not rerun for this layout-only change.

Reviewed screenshots: [desktop EN](screenshots/m5/file-viewer-motion-fit-desktop-en.png)
and [mobile IT](screenshots/m5/file-viewer-motion-fit-mobile-it.png). Independent
code and visual review found no must-fix issues: complete image, modest margins,
unclipped controls and readable mobile rows. Synthetic dimension-change coverage
is geometry-only, not certification of another codec. No infrastructure/provider
operations, restarts, live assets or new dependencies; existing HMR applies the
change. Browser harnesses closed. Rollback is a source revert. SFTPGo #18 and all
production boundaries remain unchanged; PR #21 stays open and unmerged.

Final indexed `python3 scripts/check-governance.py` and `git diff --cached --check`
pass, including documentation links, reviewed PNGs and tracked-content hygiene.

### Motion manual-hide pointer tolerance (2026-10-13)

M5 / `milestone/m5-webpanel`, PR #21. A right-side click now anchors an invisible
36 px circle: small mouse/pen motion leaves controls hidden, leaving the circle
inside the player reveals them, and leaving the player only discards the circle.
Reentry and keyboard focus reveal controls normally. Touch behavior and playback
are unchanged. No new copy or visible decoration.

Final focused checks:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion.browser.test.ts -t 'click circle|three stage zones|hides controls during playback' --silent=false`: **3 passed, 8 skipped**, 29.91 s.
- `NH_BROWSER=firefox scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion.browser.test.ts -t 'click circle' --silent=false`: **1 passed, 10 skipped**, 16.16 s.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: **pass** after declaring the test coordinates as tuples; the initial check caught that test typing issue.
- `scripts/dev.sh pnpm exec biome check apps/web/src/features/viewer-engine/builtin-viewers/video.tsx apps/web/tests/motion.browser.test.ts`: **pass**.

Independent review caught a captured-pointer edge case: a second move outside the
player could reveal controls after the circle was cleared. The final guard and
browser regression cover repeated outside moves while dragging, along with
circular distance, exit/reentry near the edge, paused state and Tab accessibility.
No remaining must-fix findings. Reviewed [hidden-controls screenshot](screenshots/m5/file-viewer-motion-hidden-en.png);
existing visible-player screenshots remain representative.

Only existing isolated browser fixtures were used; harnesses closed. No provider
operations, infrastructure changes, restarts or live assets. Existing Vite HMR
applies the change. Rollback is a source revert. Historical full suites were not
rerun for this pointer-only change; SFTPGo #18 remains unchanged.


### Motion embedded subtitle selection and rendering (2026-10-13)

M5 / `milestone/m5-webpanel`, PR #21. Embedded MKV/WebM SRT, WebVTT,
ASS and SSA now have native-clock-synchronized rendering and compact track
selection. A single audio track has no audio selector; a single subtitle track
has no track selector and uses On/Off inside Playback settings. Text captions
use safe DOM nodes; ASS/SSA uses local JASSUB WASM and embedded/default fonts.
No external font lookup, independent playback clock, transcoding, Panel/Wings
change or Blueprint update is involved.

Indexed extraction uses subtitle duration/relative-position entries. A synthetic
2 GiB, densely packetized source verifies that initial playback and a one-hour
seek together fetch less than 256 KiB while retaining an earlier hour-long cue.
Incomplete index fields use a bounded fallback. Well-formed-but-incomplete
indexes, large unindexed files, bitmap subtitle codecs and native PiP captions
are not certified. Full boundaries and license obligations are in
[M5-VIEWER-FORMATS](M5-VIEWER-FORMATS.md#motion-embedded-subtitles) and
[M5-DEPENDENCIES](M5-DEPENDENCIES.md#motion-subtitle-rendering).

Commands/results:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/subtitle-source.test.ts apps/web/src/features/viewer-engine/builtin-viewers/subtitle-renderer.test.ts apps/web/src/features/viewer-engine/builtin-viewers/video-mse.test.ts --silent=false`: **27/27 passed**, 5.07 s. Covers selective reads, long overlaps, malformed/unsupported metadata, cancellation, source identity boundary, bounded fonts, hung ASS operations/cleanup and existing media-source contracts.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion-subtitles.browser.test.ts apps/web/tests/motion.browser.test.ts apps/web/tests/motion-audio.browser.test.ts --silent=false`: **18/19 passed**, 81.46 s. All four subtitle and four audio cases passed. The existing Motion source-error case found duplicate Retry buttons when both video and optional subtitle reads failed. The fix shows subtitle recovery only after native playback is available; the general Retry retries both failed reads.
- Targeted Chromium rerun with `apps/web/tests/motion.browser.test.ts -t 'shows loading and errors'`: **1/1 passed**, 10 intentionally skipped, 13.51 s. This is targeted evidence after the two-line correction, not a claimed second complete suite.
- `NH_BROWSER=firefox scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion-subtitles.browser.test.ts apps/web/tests/motion.browser.test.ts -t 'subtitle|shows loading and errors' --silent=false`: final **5/5 passed**, 10 intentionally skipped, 56.08 s.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: **pass**; focused Biome on all changed source, tests and Vite configuration: **pass**.
- `scripts/dev.sh pnpm i18n:check`: **pass**, 1,423 EN/IT/pseudolocale keys.
- `scripts/dev.sh pnpm --filter @nickhosting/web build`: **pass**; existing main-app/editor large-chunk warnings remain. JASSUB workers, both WASM variants and local font are emitted separately. The unused GPL-3.0 rvfc-polyfill is excluded through an exact Vite alias; neither its package/license entry nor its prototype-patch implementation appears in the compiled browser assets. Required mixed-license notices ship separately.

Browser fixtures are original 12-second VP9/Opus Matroska files containing real
SRT/ASS/SSA/WebVTT packets and unsupported PGS metadata. Browser tests execute
actual JASSUB and native playback, with paused seeks, actual 2x-playback cue
boundaries, switching/Off without audio/video source replacement, safe literal
markup, unsupported options and viewer cleanup. Desktop English and mobile
Italian screenshots were inspected; automated Axe found zero violations. At
320 px, two-line captions clear controls (1 px fractional-layout tolerance).
An initial strict zero-tolerance assertion failed on fractional rounding; it was
corrected without relaxing the substantive no-clipping check.

Reviewed screenshots:

- [Chromium desktop](screenshots/m5/file-viewer-motion-subtitles-desktop-en-chromium.png)
- [Chromium Italian mobile](screenshots/m5/file-viewer-motion-subtitles-mobile-it-chromium.png)
- [Firefox desktop](screenshots/m5/file-viewer-motion-subtitles-desktop-en-firefox.png)
- [Firefox Italian mobile](screenshots/m5/file-viewer-motion-subtitles-mobile-it-firefox.png)

Independent source/UX review resolved stalled worker RPC cleanup, sparse-index
handling, excessive A/V metadata prefetch, caption clearance and the unused
transitive polyfill licensing concern. It found no remaining must-fix issue;
current documentation was corrected while historical validation entries remain
unchanged. ASS coordinates are deliberately preserved; authored graphics may
intersect temporary controls, but remain readable above their gradient.

Tests used existing isolated M2 services and authored media fixtures, with no
live game-server writes or new test infrastructure. No historical M1–M5 full
matrix was repeated. SFTPGo #18 remains unchanged. Production release still
requires the existing gates and distribution of corresponding LGPL source/build
materials; this change does not authorize a production deployment.


Owner-approved activation updated only `nickhosting-dev-vite-1`:

- Saved the previous image as `nickhosting-dev-app:before-motion-subtitles`.
- `docker compose --env-file .env.dev.local build vite`: **pass**; frozen lockfile,
  existing pinned development base, dependency build scripts remain blocked.
- `docker compose --env-file .env.dev.local up -d --no-deps --wait vite`: **healthy**.
  Compose reported the separately configured viewer SFTPGo service as an orphan;
  no orphan removal was requested or performed.
- Before/after private topology snapshot confirms all ten other dev container
  identities/images/restart counts unchanged, all network attachments unchanged,
  and Vite still exclusively on `nickhosting-dev-edge` with no published ports.
- Internal `/`, `/@vite/client`, subtitle renderer and source modules: **HTTP 200**.
  Public HTTPS app and Vite client: **HTTP 200**. Logs show Vite ready and normal
  dependency optimization, without unresolved imports.

No API/worker/Gateway/Panel/Wings restart or game-server operation occurred.
No persistent data was reset. Scoped approved rollback, if needed: restore the
saved image to `nickhosting-dev-app:local` and recreate only `vite` with the same
`up -d --no-deps --wait vite` command, alongside reverting this feature's source.
Do not recreate other services merely because they share the development image
name. PR #21 remains open and unmerged.


The final public WSS handshake on `/__nickhosting_hmr` returned Vite's
`connected` message. An initial manual probe used `/` instead of the existing
configured HMR path and timed out; correcting the probe succeeded without any
proxy or application configuration change. Staged governance/link/TOML/ignore
checks pass after normalizing upstream license-notice line endings; no private
state, credentials or local topology snapshot is staged.

### Motion: unindexed MKV subtitle fallback (2026-10-13)

M5 / `milestone/m5-webpanel`, PR #21. The Owner's reported 31,762,747-byte
MKV exposes eight SRT tracks but no subtitle Cue entries. Read-only reproduction
found discovery in 136.8 ms, followed by `Video read budget exceeded` after
4,488.4 ms: the browser's 64 KiB Range cache fetched unrelated video payload while
walking packet headers, exhausting its 8 MiB budget. Successful HTTP 206 responses
did not mean successful subtitle extraction.

The unchanged parser now lives in a shared pure module. Indexed files retain
selective browser Range reads. Unindexed ordinary files use a new authorized
subtitle-window route over the existing retained SFTP source, with 1 KiB metadata
reads that skip A/V payloads, a 2 MiB cache and the existing bounded scan/deadline.
No full-movie download, transcoding, new service, dependency or Blueprint update.
Request cancellation preserves the shared handle; session/permission revocation
still aborts it. Archive-contained unindexed video retains the bounded Range
fallback. Large unindexed deep seeks remain subject to limits.

Focused validation (historical full suites were not repeated):

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/subtitle-source.test.ts`: **15 passed**; indexed packets, fallback delegation, archive isolation, cancellation, response limits and cached backward seeks.
- `scripts/dev.sh pnpm exec vitest run apps/api/src/viewer-subtitles.test.ts`: **4 passed**, 690 ms; a sparse original 1000 MiB fixture finds its caption after skipping 1,000 video payloads with less than 1,100 KiB transferred; cached repeat performs no reads.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/file-viewers.integration.test.ts`: **9 passed**, 8.18 s; actual parser fixture, reuse, authorization, revocation and input/unsupported-track errors.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion-subtitles.browser.test.ts`: **4 passed**, 24.03 s; indexed text/ASS/SSA/WebVTT rendering, switching, seeking, cleanup and accessibility.
- Same browser command with `NH_BROWSER=firefox`: **4 passed**, 36.28 s.
- Root `pnpm exec tsc --noEmit`, WebPanel typecheck, `pnpm --filter @nickhosting/web build` and `pnpm build:runtime`: **pass** via `scripts/dev.sh`. Existing frontend chunk-size warnings remain.
- Focused Biome: **pass**, with two pre-existing non-null assertion warnings in `file-viewers.ts`.

Private authenticated read-only probes against the reported file now return
HTTP 200 and correct caption windows. A first backend scan took 1,463 ms;
subsequent windows/seeks took 72–93 ms. A separate browser-source probe (run
alongside the UI probe) took 3,871 ms for its initial window and 72–94 ms for
later windows: five requests total, only two Range requests, none failed. These
are separate samples, not a guaranteed latency or a benchmark average.

The actual development UI in Chromium rendered both English and Italian captions
after selection/seeking, with all four subtitle responses HTTP 200, no subtitle
notice and no page errors. The first UI probe failed its caption assertion before
the final cache-window correction; the final rerun passed. Independent review
found and resolved an overly strict browser validator for a reused window after
a small backward seek; the new regression covers it. No remaining must-fix findings.

The headless Firefox build could not decode this particular real video:
`NS_ERROR_DOM_MEDIA_METADATA_ERR`, native H.264 capability empty, readyState 0.
Its subtitle endpoint still returned HTTP 200 without a page error. Real-file
Firefox playback is therefore not claimed by this automated run; the separate
Firefox VP9/Opus fixtures verify subtitle rendering. The Owner's browser remains
the final check for this media/codec combination. Existing reviewed subtitle
screenshots remain representative; no UI layout or text changed, and no private
movie frame or subtitle text is published.

Existing dev watchers/HMR loaded the change without a manual container restart.
Only authorized reads of the supplied game file were performed. No Panel/Wings,
Blueprint, network, game-server state or persistent media change; no test assets
created on the provider. Isolated fixture sessions closed normally. SFTPGo #18
and production-release boundaries remain unchanged. Rollback is a source revert;
the new route requires no migration. PR #21 remains open and unmerged.

### Motion debug timetrace (2026-10-13)

M5 / `milestone/m5-webpanel`, PR #21. Added optional Motion instrumentation;
no playback, caching or buffering optimization is included in this pass.
API debug level enables collection through existing viewer capabilities. Opaque
trace/request IDs correlate browser milestones with backend access, extraction
and streaming summaries. The next Owner test can be analyzed from API logs
without asking the Owner to export the browser console. No media paths, caption
text, provider URLs or credentials are collected.

The browser batches milestones (maximum 512 in five minutes, at most 48 per POST).
Native first-frame callbacks are one-shot; there is no per-frame/packet logging.
Streaming observes existing chunks without buffering/copying them. Disabled
diagnostics do not run timing clocks or deliver telemetry. Intake retains normal
session/server permission/Origin checks, strict fixed fields and bounded rate
bookkeeping. Timelines begin at Motion mount, excluding earlier lazy-module loads;
nested/parallel durations are explicitly not additive. See
[timing interpretation](M5-VIEWER-FORMATS.md#motion-debug-timing).

Focused commands/results:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/viewer-timing.test.ts apps/api/src/viewer-http.test.ts`: **26 passed**; debug-off, strict payloads, rate bounds, stream/cancellation and existing HTTP behavior.
- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/video-mse.test.ts apps/web/src/features/viewer-engine/builtin-viewers/subtitle-source.test.ts`: **30 passed**, 4.70 s; existing reader/parser regressions plus timing/cache and safe failure metadata.
- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/motion-timing.test.ts`: **5 passed**, 572 ms; batching, fixed fields, idempotent spans, bounds and diagnostic failures not surfacing to playback.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/file-viewers.integration.test.ts`: **11 passed**, including authenticated debug intake and unchanged reader authorization.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion-subtitles.browser.test.ts`: **5 passed**, 31.39 s. Covers existing subtitle rendering plus schema-valid diagnostic batches, stable playback URL, one timeline across StrictMode replay, seeks, and cancellation of buffering time on intentional pause. Debug-off cases send no batches.
- Same browser command with `NH_BROWSER=firefox` and `-t 'bounded debug milestones'`: **1 passed, 4 deliberately skipped**, 21.93 s. Targeted tracing evidence, not a repeated full Firefox suite.
- `scripts/dev.sh pnpm typecheck`, WebPanel production build and runtime build: **pass**. Existing frontend large-chunk warnings remain.
- Focused Biome on all 16 changed source/test files: **pass**, two pre-existing non-null assertions in `file-viewers.ts`; whitespace check passes.

Read-only development smoke: viewer capabilities returned HTTP 200 with
`debugTiming: true`. The actual reported MKV retained visible English/Italian
captions after seeks, all subtitle responses HTTP 200, no page errors, and six
diagnostic batches accepted with HTTP 204. API logs contain matching browser and
request records covering discovery, native playback, MSE and subtitles, including
explicit cancellation outcomes. This checks collection, not an Owner latency
benchmark. Private probes and the movie content are not tracked or published.

Independent review resolved an over-broad request-ID filter, waiting intervals
that could include intentional paused time, and hover-preview reads initially
labeled as native playback. The final implementation uses UUIDs, ends/cancels
waiting correctly, and labels thumbnails separately. No remaining must-fix
findings. No UI layout changed; prior screenshots remain representative.

Existing watchers/HMR loaded the source; no manual container restart, dependency
installation, configuration change, provider write, new infrastructure or test
media asset. Existing isolated fixtures closed normally. SFTPGo #18 remains a
production-release gate. No historical full milestone matrix was repeated.
Rollback: revert this source-only change; there is no migration. PR #21 stays
open and unmerged.

### Motion Owner trace and fractional subtitle windows (2026-10-13)

M5 / `milestone/m5-webpanel`, PR #21. Analyzed the completed Owner run without
changing provider or media state. Times below are relative to Motion timeline
creation, excluding the earlier lazy-module download. Nested and parallel phases
must not be added together.

| Milestone | Duration | Completion from trace origin |
| --- | --- | --- |
| Video track discovery | 541 ms | 728 ms |
| Subtitle track discovery (parallel) | 558 ms | 745 ms |
| Subtitle renderer import/setup | 27 ms | 773 ms |
| MSE metadata | 248 ms | 976 ms |
| MSE first packets | 506 ms | 1,482 ms |
| First displayed-frame callback | — | 1,560 ms |
| MSE first buffer | 336 ms | 1,819 ms |
| Complete MSE initialization (includes preceding MSE stages) | 1,091 ms | 1,819 ms |
| First completed subtitle window | 1,889 ms | 3,715 ms |

Two earlier subtitle reads were cancelled after 756 ms and 297 ms as native
metadata and the restored MSE position triggered replacement reads. Code review
confirms the transient zero-position read during source replacement is redundant;
it is a measured optimization candidate, not changed by this correctness pass.
The final window's backend extraction occupied 1,728 ms of a 1,756 ms request.
Later cached browser windows completed in approximately 31–141 ms. The first
user Play and native playing event had the same recorded millisecond.

The captured run contains 384 backend requests: 357 succeeded, 27 cancelled,
zero failed. Cancellations include source replacement and hover-preview changes;
they do not establish playback failures. The browser reached its 512-event limit
after about 18 seconds, before the reported later subtitle error/retries. Thus
the exact user exception was not captured and is not claimed as proven.

A concrete matching defect was independently reproduced: a valid 22-second
window at 12.072 seconds has the floating-point span `22.000000000000004`. The
frontend rejected it despite a successful backend response; retries could receive
the same cached window. Two new regression cases failed before the fix. The
comparison now permits only a few floating-point units, capped at 0.1 microsecond;
genuinely oversized responses still fail. No parser, provider or media mutation.

The trace now samples at most 192 Range milestones within the existing 512-event
cap, reserving space for subsequent subtitle errors/recovery. A fixed marker
reports this sub-limit. Independent review caught and resolved a marker-ordering
edge case that could otherwise emit event 513; a mixed-budget regression covers it.

Read-only Chromium probe of the Owner-supplied MKV succeeded at 12.072, 11.072,
12.072 and 35.075 seconds, with no failed HTTP response or source-reader error.
The first cold window took 2,808 ms; subsequent windows 54/33/64 ms. This verifies
the actual source reader against the real file; it does not claim that all of the
Owner's later interactive failures were reproduced. Private media and probe
outputs remain untracked.

No visual layout change, new dependency, migration, manual container restart,
Blueprint update, provider write, game-server command or new infrastructure.
Existing HMR loads the fix. Existing screenshots remain representative.
No historical full milestone suite repeated; SFTPGo #18 remains unchanged.
Rollback: revert the source-only changes. PR #21 remains open and unmerged.

Focused validation for this correction:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/subtitle-source.test.ts apps/web/src/features/viewer-engine/builtin-viewers/motion-timing.test.ts apps/api/src/viewer-timing.test.ts`: **31 passed** before the final marker-ordering regression.
- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/motion-timing.test.ts`: **7 passed** after that final fix; 32 distinct unit cases across these files.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion-subtitles.browser.test.ts`: **5 passed**, 31.65 s, existing isolated services. No new containers started.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: **pass**.
- Focused Biome on all five changed source/test files: **pass**.
- Independent read-only review: **no remaining must-fix findings**, with the evidence boundary above explicitly retained.

### Motion subtitle locality and retained seek buffers (2026-10-13)

M5 / `milestone/m5-webpanel`, PR #21. Owner authorized subtitle aggregation,
parallel startup/reuse and bounded video cache retention. The final Owner choice
supersedes intermediate suggestions: **128 MiB encoded retention, no time expiry**.
This is compressed append accounting, not total browser memory. New forward
production remains approximately 12 seconds; retained future islands may extend
farther after backward seeks. No automatic 128 MiB pre-download.

Same-track seeks now preserve the MediaSource, SourceBuffer, input and bounded
raw cache. Only the serialized remux pump is replaced for missing data. Native
parser reset permits new compatible fragments without removing retained frames.
Audio-track changes still rebuild the source. Byte/Quota pressure evicts distant
ranges, protecting current playback; completed accounting reconciles browser
removal, while the incomplete fragment stays charged. Initial startup retains
its original whole-operation 15-second deadline. Initial `mse.start` remains
comparable; later pumps use `mse.refill`.

Subtitle extraction starts alongside renderer initialization. Duplicate metadata
and covered seeks retain pending/completed windows; overlapping refresh keeps
current captions while loading the next window. Failed generations stop further
reads until Retry. The backend coalesces locally adjacent metadata reads up to
512 KiB, deciding locality from the last actual requested endpoint, including
cache hits. Distant skips fall back to 1 KiB. Baseline parser allowance is 8 MiB
plus at most 24 MiB speculative reads: **32 MiB physical reads per operation**,
2 MiB retained byte cache and unchanged 15-second deadline.

Research: inspected mpv MKV demux/stream buffering and VLC segment seeking at the
pinned upstream revisions linked in [format contracts](M5-VIEWER-FORMATS.md#subtitle-lookup-research-and-bounded-simulations).
They use indexes, buffered locality and retained knowledge of explored regions.
Our existing index-first/cluster-summary parser remains authoritative; no copied
LGPL source, new dependency, guessed byte-offset search, full-file indexing job,
transcode or changed caption-coverage claim was introduced.

**Experiments and their limits:** fixed 32/64/128/512 KiB reads exhausted the old
8 MiB physical-read budget on the real unindexed file; those were failed trials,
not successful timings. A bounded first adaptive candidate reduced request count
but still wasted read-ahead on medium-spaced fixtures. Switching locality from
cache-chunk end to actual requested end removed that waste. A 32 MiB speculative
allowance trial reduced calls further but transferred more without a measured
latency benefit in that pair; the final allowance remains 24 MiB. Preliminary
600 ms / roughly 49% improvement observations belong to earlier runs/variants,
not the final three-pair result below.

Final read-only real-file comparison used three alternating baseline/final runs,
a fresh parser per run and an existing SSH transport. Each returned the same
three captions. The file was unchanged; connection/handles were closed afterward.

| Metric | Original 1 KiB | Final adaptive ≤512 KiB |
| --- | ---: | ---: |
| Window run 1 | 1,278.06 ms | 1,064.25 ms |
| Window run 2 | 2,310.95 ms | 1,364.97 ms |
| Window run 3 | 1,476.95 ms | 1,126.62 ms |
| Mean extraction | 1,688.65 ms | 1,185.28 ms |
| Median extraction | 1,476.95 ms | 1,126.62 ms |
| Mean parser open + extraction | 1,698.94 ms | 1,207.04 ms |
| Read calls, including open | 1,502 | 404 |
| Bytes, including open | 1,537,995 | 26,102,678 |

Mean extraction improved **29.8%**, median **23.7%**. This is an explicit bounded
bandwidth-for-latency tradeoff, not a zero-cost optimization or a promise for
other files/networks. Host variation remains visible. Old measured first-run
1,728 ms extraction and later multi-second runs are retained in prior entries.

Pure local virtual Matroska fixtures have 1,000 video payloads plus a subtitle;
large payload spans are synthesized rather than allocated/stored. Final table:

| Virtual bytes | Payload spacing | Original reads | Final reads | Final transferred bytes |
| ---: | ---: | ---: | ---: | ---: |
| 70,099 | 64 B | 67 | 1 | 70,099 |
| 2,055,099 | 2 KiB | 1,001 | 4 | 2,049,664 |
| 8,199,101 | 8 KiB | 1,001 | 16 | 8,192,320 |
| 32,776,101 | 32 KiB | 1,001 | 986 | 1,531,944 |
| 131,080,101 | 128 KiB | 1,001 | 998 | 1,544,232 |
| 262,152,101 | 256 KiB | 1,001 | 1,000 | 1,546,280 |
| 1,048,584,103 | 1 MiB | 1,001 | 1,001 | 1,547,304 |

These prove selection/bounds and identical parsed captions across density/size;
their in-memory CPU times are not transport predictions. Reproduction:
`SUBTITLE_READER_BENCHMARK=1 scripts/dev.sh pnpm exec vitest run apps/api/src/viewer-subtitles.test.ts -t benchmark --disableConsoleIntercept`:
**1 benchmark passed (all seven sizes), 7 ordinary tests deliberately skipped**.

Read-only final Chromium development smoke of the Owner-supplied MKV: first frame
1,023.8 ms; initial MSE complete 1,120.8 ms; first subtitle window complete
2,234.4 ms (one successful initial read, no redundant initial cancellation).
Seeks 26→3→30→7 retained the same blob URL and earlier buffered ranges. The first
uncached target took 914 ms end-to-end in the polling probe; cached targets
130/128/128 ms, including probe scheduling/poll overhead. Background range reads
continued (one per cached step), so this live probe does **not** claim zero HTTP
traffic. Subtitle responses were HTTP 200 and no page/subtitle notice occurred.
The isolated browser cases separately establish zero new requests for controlled
cached-return steps. The first attempted pre-change live probe was invalidated by
concurrent HMR/cancelled requests and is not used as a latency baseline. The
historical Owner trace remains the earlier reference, not a controlled before/
after browser benchmark.

Independent review found and resolved two memory-accounting progress defects:
cumulative removals could leave phantom charges, and browser eviction during a
capacity wait needed reconciliation on every iteration. Regression cases cover
partial/final removal and disappeared native ranges. Real browsers prove small
fixture seek/cache behavior; 128 MiB saturation/accounting uses unit models, not
a claimed full-size browser memory-pressure stress test. Large unindexed/deep
subtitle seeks can still reach the documented scan/time bounds.

No UI layout/copy change; prior screenshots remain representative. Existing HMR
loads the sources without manual restarts. No dependency/migration, Blueprint
update, provider mutation, game-server command, new container/network or media
asset. The existing isolated browser services were reused. Historical test files,
credentials and data remain untouched; private probes/results are gitignored.
Rollback is a source revert. SFTPGo #18 and production-release restrictions are
unchanged; PR #21 remains open and unmerged.

Final focused validation:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/viewer-subtitles.test.ts apps/web/src/features/viewer-engine/builtin-viewers/subtitle-source.test.ts apps/web/src/features/viewer-engine/builtin-viewers/motion-timing.test.ts apps/api/src/viewer-timing.test.ts`: **39 passed, 1 opt-in benchmark skipped**; benchmark separately executed above.
- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/video-mse.test.ts`: **21 passed**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion-subtitles.browser.test.ts`: **7 passed, Chromium**.
- Same browser command with `apps/web/tests/motion-audio.browser.test.ts`: **4 passed, Chromium**; repeated with `NH_BROWSER=firefox`: **4 passed, Firefox**. Browser evidence does not establish physical millisecond audio/video synchronization.
- `scripts/dev.sh pnpm typecheck`: **passed**, including browser-test types.
- `scripts/dev.sh pnpm --filter @nickhosting/web build`: **passed**; existing bundle-size warnings remain.
- `scripts/dev.sh pnpm exec biome check` on the nine changed TypeScript source/test files: **passed**.
- Independent final review: **no remaining must-fix findings**. No full historical M1–M5 suite rerun for this scoped change.
- `python3 scripts/check-governance.py`: **passed**, 834 indexed text files, 276 review PNGs, 681 relative links, 4 TOML files and 44 ignore cases; secret scanning remains heuristic. `git diff --cached --check`: **passed**.

### Motion volume shortcuts (2026-10-13)

Arrow Up/Down adjust Motion volume by five percentage points, clamped to 0–100%.
Increasing muted volume starts at 5%; zero mutes. Text fields, open menus/dialogs
and native controls reached through keyboard navigation keep their own keys.
Focused real Chromium transport case passed (`scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/motion.browser.test.ts -t 'plays actual video'`): 1 passed, 10 unrelated cases skipped. Covers volume steps, both bounds and muted recovery alongside existing transport behavior. Scoped Biome passed. No layout changes, infrastructure actions or provider mutations.
Web typecheck passed. Independent review checked exclusions and volume semantics;
its native-select exception was applied so pointer-focused selects retain arrows.

### Atlas archive navigation and selective extraction (2026-10-13)

Implemented within M5/PR #21 and viewer issue #26. Atlas now shares the File
breadcrumb, compact icon actions/tooltips, searchable/paginated listings and
name/size/modified sorting. Ctrl/Cmd-click, Shift-click, page selection, context
menus and keyboard focus are covered. Cached pages stay visible during a held
refresh; prefetch is limited to the next page and hovered folders. Only metadata
enters the browser's bounded 48-page / 8 MiB cache. Background refresh has no
loading message replacing valid rows. Menus/selection consume Escape before the
viewer; cancelling extraction preserves the mounted nested archive and selection.

The existing extraction operation accepts selected files/folders and up to four
nested containers, stages selected bytes before writes, and retains authorization,
disk/path checks, new-destination conflict policy and uncertainty reporting.
Multi-selection downloads use the existing backpressured native ZIP stream via a
bounded POST manifest. Nested archive reads retain a root index plus at most eight
child indexes; only opened nested containers materialize in private temporary
storage. Single GZ/BZ2/XZ/ZST streams expose a cached read-only virtual file. No
archive editing or implicit extraction onto a game server.

7z/RAR now read from a private-cache file descriptor instead of copying all input
into WASM; output uses acknowledged chunks no larger than 64 KiB. Default input
and member limits are 256 MiB for viewing and extraction; decoder heap remains
256 MiB, with one concurrent decoder and a 30-second deadline. Existing expansion,
ratio and metadata budgets remain. A generated **65 MiB stored 7z input/member**
was streamed in **1,040 chunks**, initially measured **2,446 ms** with a **32 MiB
decoder heap cap**. The same fixture passed normal viewer materialization and
actual local `stageFileArchive` extraction above the old 64 MiB limit. This proves
the file-backed path on a local fixture, not production throughput or all codecs,
solid/dictionary sizes, encrypted/multipart RAR variants. No new dependency or
Blueprint update. Upstream filesystem contract references and limits are in
[M5-VIEWER-FORMATS.md](M5-VIEWER-FORMATS.md).

Final focused validation:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/viewer-archive-tree.test.ts apps/api/src/viewer-archive.test.ts apps/api/src/file-operations.test.ts apps/web/src/features/viewer-engine/core/registry.test.ts apps/web/src/features/viewer-engine/core/access.test.ts`: **128 passed**, including real codecs, selective/nested staging, held-read shutdown, shared-caller cancellation, invalid paths, cached indexes, sort/filter and large 7z streaming/staging.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/file-viewers.integration.test.ts`: **12 passed**; authorization, nested search/sort, selected ZIP bytes, normalized directory names, Range/CRC and revocation using real isolated PostgreSQL plus fixture transports.
- Same integration command with `apps/api/src/file-operations.integration.test.ts`: **41 passed**, including selective nested extraction, rejected selections with no provider mutations and partial upload uncertainty. External writes are fixture-only.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'navigates archives|Atlas'`: **3 passed**, with 450-item pagination, current-folder search, ordering, nested member preview, native ZIP selection, keyboard/focus, held cache revalidation, cancelled extraction, EN/IT desktop/mobile and Axe. No Axe violations in the checked states; this is not blanket WCAG certification.
- Same browser command with `-t 'restores the open viewer|preserves JSON|offers all'`: **4 passed**, **28 unrelated cases skipped**, protecting shared viewer refresh, chooser and editor integration.
- `scripts/dev.sh pnpm typecheck`: **passed**, root/web/browser types.
- `scripts/dev.sh pnpm --filter @nickhosting/web build`: **passed**; existing large-chunk warnings remain. Atlas lazy chunk approximately 12.9 kB minified / 4.3 kB gzip in this build.
- `scripts/dev.sh pnpm exec biome check` on all 24 changed source/test/style/catalog files: **passed**, with two existing non-null-assertion warnings in file-viewers.ts. No full historical M1–M5 suite rerun.

Historical attempts/review: the first new nested-route test expected 422 for the
existing validation error mapped to 400; corrected the assertion. New uncertainty
coverage legitimately retained a claim and exposed two existing copy tests that
counted claims across fixture servers; those assertions now scope their own
server. Review caught and fixed compressed-member basename mismatch, trailing
slash ZIP projection, pending nested-shutdown lifetime, empty/error conflation,
menu Escape/focus and extraction-dialog double close. Early UI captures had
centered filenames and widely spaced actions; final captures correct both.
Independent backend/security and frontend UX/accessibility reviews report **no
remaining must-fix findings**.

Reviewed browser captures (fixture data, actual application):
[desktop selection](screenshots/m5/atlas-selection-desktop-en.png),
[Italian mobile](screenshots/m5/atlas-mobile-it.png),
[loading](screenshots/m5/atlas-loading-desktop-en.png),
[empty search](screenshots/m5/atlas-empty-desktop-en.png),
[error](screenshots/m5/atlas-error-desktop-en.png).

Safety: no real game-server data read or written for these tests, no Pterodactyl/
Wings/Blueprint mutation, no new containers/networks, dependencies or migrations.
Previously approved isolated services were reused; generated archives and staging
files are removed by test cleanup. Existing dev API/Vite reported healthy and
load source changes through their established watchers/HMR without manual
restarts. An unrelated existing dev Gateway unhealthy status was observed only;
it was not changed as part of Atlas. Production deployment and SFTPGo issue #18
remain outside scope. Rollback is a source revert; no production data migration.

`python3 scripts/check-governance.py`: **passed**, 836 indexed text files,
281 review PNGs, 687 relative links, 4 TOML files and 44 ignore cases (secret scan
is heuristic). `git diff --cached --check`: **passed**. Final read-only container
status: dev API and Vite both running/healthy.

### Fileman host, shared Atlas UI and single compressed views — 2026-10-13

Owner-requested architecture follow-up to the Atlas pass above. Fileman now owns
one actual presentation for real directories and virtual archive folders. Shared
components cover toolbar, breadcrumb, search, list/grid, sorting, entry icons,
selection, contextual menus and skeletons. Atlas retains its existing bounded
metadata cache and archive source adapter. It no longer carries separate row/table/
hover CSS. Its search, layout toggle and actions mount at the corresponding Fileman
toolbar positions; unsupported writes/uploads are absent.

The trusted Game SDK adds named presentation patches (prepend/append/decorate/
replace/hide) alongside complete lazy viewer modules. The host indexes patches by
slot, validates namespaces and deterministic conflicts, and scopes them to the
current game/viewer/entry. No installed game extension is added by this change.
Backend operations, authorization, SFTP sessions, signed URLs and filesystem
controllers remain unchanged; extension rendering adds no provider requests.
Native text editing also uses the common content slot. Active nested viewer context
propagates to the outer toolbar, avoiding stale or falsely writable context.

Standalone GZ/BZ2/XZ/ZST opens the decoded read-only member while preserving the
compressed visible identity. Download distinguishes original and decoded bytes;
explicit Atlas choices and compound TAR remain browsable. See the format contract
and ADR 0017 amendment for extension APIs and boundaries.

Review/attempt record: the first native Files browser suite ran during concurrent
source/HMR edits and was interrupted with exit 130 after it stopped yielding
progress; it produced no test summary and is **not** counted as passing. Focused
Atlas tests exposed mobile toolbar breadcrumb/search clipping; shared CSS now
uses normal folder layout when directory search is present. Independent review
also found stale outer host context, a decoded-ZIP source-chain mismatch, and
wrapper-vs-member preference ambiguity; fixes and final verification are recorded
below. Historical Atlas/backend codec validation above remains unchanged.

Additional test-attempt detail: the stable native run first stopped on a stale
cold-skeleton assertion (persisted metadata was correctly displayed), then passed
five cases before an old `goto(files)` assumption restored the previous folder
instead of root. Tests now explicitly establish cold contexts or root navigation;
reload/retained-cache assertions remain. One agent test process exited 143 before
results; no pass was counted. A new compressed Retry case initially used the wrong
existing English label, `Retry` instead of `Try again`; corrected the test selector.
No production behavior was weakened to satisfy those assertions.

Final focused checks:

- `scripts/dev.sh pnpm exec vitest run packages/game-sdk/src/fileman.test.ts packages/game-sdk/src/viewers.test.ts apps/web/src/features/fileman/host.test.ts apps/web/src/features/file-manager-model.test.ts apps/web/src/features/viewer-engine/core/registry.test.ts apps/web/src/features/viewer-engine/core/access.test.ts apps/web/src/features/viewer-engine/core/compressed.test.ts`: **27 passed** across seven files.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts apps/web/tests/fileman-extension.browser.test.ts apps/web/tests/file-viewer-escape.browser.test.ts -t 'navigates archives|Atlas|restores the open viewer|preserves JSON|offers all|compiled Fileman|Escape' --bail=1 --reporter=verbose`: **12 passed, 25 unrelated cases skipped**. Includes shared native/Atlas computed-style parity, EN/IT desktop/mobile, real host context across Atlas→JSON→Files and native editor, personal defaults, refresh and Escape/dirty editor handling.
- Same isolated browser command with `apps/web/tests/compressed-viewers.browser.test.ts --bail=1 --reporter=verbose`: **7 passed**. Covers all four single-stream types, root/nested decoded ZIPs, readonly text, original/decoded download targets, directory return, saved wrapper Atlas preference without changing ordinary JSON, refresh, failure/retry and Italian mobile keyboard menu.
- `scripts/dev.sh pnpm typecheck`: **passed** (root, web and browser tests).
- `scripts/dev.sh pnpm --filter @nickhosting/web build`: **passed**. Existing large-chunk warnings remain; no new package or decoder dependency.
- `scripts/dev.sh pnpm exec biome check` over the changed SDK, host, viewer, native Files, tests and catalog files: **passed**.

Independent technical and UX/accessibility reviews found and resolved the issues
listed above, including shared Extract/Download icon reuse and suppressing the
Download tooltip while its menu is open. Final technical review reports no
remaining must-fix. Screenshots are actual browser fixtures, reviewed by the
coordinator and separately by the UX reviewer:
[list/hover desktop EN](screenshots/m5/atlas-fileman-list-hover-desktop-en.png),
[grid desktop IT](screenshots/m5/atlas-fileman-grid-desktop-it.png),
[list mobile EN](screenshots/m5/atlas-fileman-list-mobile-en.png),
[grid mobile IT](screenshots/m5/atlas-fileman-grid-mobile-it.png),
[nested compressed](screenshots/m5/file-viewer-single-compressed-nested.png),
[download mobile IT](screenshots/m5/file-viewer-single-compressed-download-mobile-it.png),
[lookup error](screenshots/m5/file-viewer-single-compressed-error.png).

Safety: this is frontend/SDK composition over unchanged backend controllers and
transports. Browser tests use isolated PostgreSQL/API handlers and fixture provider
responses, not real server mutations. Existing approved test services were reused;
no Docker resource creation/restart, Blueprint update, provider/network mutation,
new dependencies or database migration. Historical codec/SFTP/backend integration
evidence remains valid for unchanged code; no full M1–M5 matrix was repeated.
Dev API/Vite remain healthy and use their existing source watchers/HMR. Issue #18
and production release boundaries remain unchanged. Rollback is a source revert;
there are no provider writes or schema changes to reverse.

The native continuation exposed two further fixture assumptions: raw drag mouse
coordinates could point outside the clipped listing, and a Back-navigation setup
inherited an editor bookmark from the preceding test. Drag fixtures now require
visible in-viewport geometry (the spring case filters its own sibling names), and
root-intended setup clears only this isolated server's navigation bookmarks.
Actual move/drop, Back/dirty-content and reload assertions were retained. These
were test setup changes only; no backend or product workaround was introduced.

Native Fileman verification completed: **all 34 distinct scenarios passed across
partitioned runs**, not a single clean full-suite run. The command prefix was
`scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts --bail=1 --reporter=verbose`:

- No filter: first **10 passed**, then the off-screen held-drag fixture failed.
- `-t 'opens nested folders|opens a hovered breadcrumb|cancels a held drag'`:
  **3 passed, 31 skipped** after fixture correction.
- `-t 'asks only|requests consent|clears move|opens text inline|renames the open|returns to the same|does not steal|keeps inline rename|keeps edits when|keeps known|edits JSON|indents with|saves in|uploads|completes|keeps path|renders bounded|shows platform|renders compact desktop'`:
  first **8 passed**, then the inherited editor bookmark in Back setup failed.
- `-t 'keeps edits when|keeps known|edits JSON|indents with|saves in|uploads|completes|keeps path|renders bounded|shows platform|renders compact desktop'`:
  **13 passed, 21 skipped** after correcting that setup. No unhandled errors.

Coverage includes >100-file bulk operations, downloads/filenames, selection,
collision handling, held drag and breadcrumb drops, authorization changes, editor
concurrent writes/dirty guards, undo/cursor retention, uploads, path completion,
keyboard shortcuts and desktop/mobile Axe checks. Zero Axe violations in tested
states is not blanket WCAG certification. The corrected test file passed Biome,
browser test TypeScript and whitespace checks. Expensive already-passing scenarios
were not repeated merely to obtain one monolithic summary.

`python3 scripts/check-governance.py`: **passed**, 847 indexed text files,
288 review PNGs, 696 relative links, 4 TOML files and 44 ignore cases (heuristic
secret scan). `git diff --cached --check`: **passed**. Read-only final dev status:
API and Vite running/healthy; no manual restart or real game asset creation.

### 2026-10-14 — Single-line shared Fileman paths

The shared breadcrumb keeps directory, editor and Atlas/viewer paths on one line,
showing the current/recent tail when space is limited. Older ancestors remain
scrollable and keyboard-accessible. Portal content changes and resizing update
only the scroll position; focused ancestors and inline rename keep their focus.
Long labels use ellipsis, with inset keyboard focus to avoid overflow clipping.
No provider calls, cache changes or infrastructure operations were added.

Focused validation:

- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed.
- `scripts/dev.sh pnpm exec biome check apps/web/src/features/fileman/presentation.tsx apps/web/src/features/files.css apps/web/tests/fileman-breadcrumb.browser.test.ts`: passed.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/fileman-breadcrumb.browser.test.ts`: passed (one browser scenario; directory/editor, desktop/mobile, tail visibility and keyboard ancestors).
- The same browser command with `apps/web/tests/fileman-extension.browser.test.ts`: passed in the combined run (one scenario, actual nested portal viewer transitions). These two scenarios passed in separate runs, not one clean combined run.
- Earlier attempts exposed test-only database-wrapper/label/alignment assertion mistakes, corrected in the new fixture, plus intermittent isolated provisioning `resources_unavailable` before UI assertions. No admission requirements or production behavior were changed to bypass that fixture failure.
- Independent code/visual review: focused ancestor retention and clipped keyboard outlines corrected; desktop/mobile screenshots reviewed. No broad historical suite rerun.

Sanitized screenshots: [directory desktop](screenshots/m5/fileman-breadcrumb-desktop.png),
[directory mobile](screenshots/m5/fileman-breadcrumb-mobile.png),
[editor mobile](screenshots/m5/fileman-breadcrumb-editor-mobile.png).
All test provider assets are isolated fixtures; no real server or production changes.

### 2026-10-14 — Atlas contributes virtual path navigation to Fileman

ALT + G now includes the physical archive, nested containers, virtual directories
and current member. Atlas registers a typed `FilemanPathProvider` for the whole
archive session, including members opened in other viewers. The shared picker
consumes the capability; FilesWorkspace has no archive-specific path handling.
Completion, archive listing and single-stream decoding share the same metadata
query keys and 48-page / 8 MiB cache. Picker results are capped at 200 and discarded
on leaving the query; no duplicate completion history or recursive indexing.

Focused evidence:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/core/{atlas-path,compressed}.test.ts apps/web/src/features/file-path-model.test.ts apps/web/src/features/fileman/host.test.ts packages/game-sdk/src/fileman.test.ts`: **32 passed**. Covers namespace separation, nested source chains, aliases, filtered pagination beyond 200 entries, invalid paths and cancelled navigation/opening.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/atlas-path.browser.test.ts apps/web/tests/compressed-viewers.browser.test.ts apps/web/tests/fileman-extension.browser.test.ts`: **10 passed**. Full virtual path, arrow/Enter completion, opening JSON members, returning to real root, missing paths, previously unopened compressed nested archives, explicit Atlas overrides, scope cleanup and existing compressed/viewer behavior.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: **passed**.
- Focused `scripts/dev.sh pnpm exec biome check` on all 13 changed/new TypeScript/TSX files: **passed**.

Independent review identified pending-navigation cancellation and duplicate query
retention; both were corrected. Provider replacement closes/cancels the old picker.
Compressed nested containers typed directly now discover the same hidden aliases
as ordinary opening, respecting explicit Atlas preferences. Final code and rendered
UI review reported no remaining must-fix findings.

Reviewed screenshots use only isolated fixtures:
[desktop](screenshots/m5/atlas-path-member-desktop.png),
[mobile](screenshots/m5/atlas-path-member-mobile.png). Browser tests exercise real
application handlers with the existing isolated test database/provider harness;
archive HTTP fixtures distinguish UI/navigation evidence from parser/live-provider
coverage. No real game resources were created or mutated. No Blueprint, Wings,
Pterodactyl or container changes/restarts. The change uses existing HMR. SFTPGo #18
remains unchanged. Broad historical suites were not repeated.

Native Fileman regression command:
`scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts -t 'completes actual folders|completes the sole path|keeps path errors|renders bounded path|shows platform-specific search'`:
**5 passed, 29 intentionally skipped**. Covers native candidate completion,
Space/Enter/arrows, stale-prefix errors, desktop/Italian mobile accessibility and
platform-specific shortcuts. Final web typecheck and whitespace checks passed.
`python3 scripts/check-governance.py` and `git diff --cached --check`: **passed**
(854 indexed text files, 294 review PNGs, 703 relative links, 4 TOML files, 44 ignore cases; heuristic secret scan).

### 2026-10-14 — Atlas parent row and extraction icon

The outer archive root now includes `..`, using Fileman's existing close action
to return to the containing physical folder and restore focus. Nested archive
and virtual-directory parent navigation retain their existing behavior. Extract
uses the shared icon-button sizing; its symbol is an open box with an upward arrow.

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/atlas-path.browser.test.ts -t 'uses parent rows'`: **1 passed, 2 intentionally skipped** on final code. Covers all three parent levels, actual SVG dimensions, opening/dismissing extraction without submitting it, and restored file-row focus.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: **passed** for the callback changes.
- Focused Biome check on the four changed TS/TSX files: **passed**.

Reviewed [browser screenshot](screenshots/m5/atlas-parent-root-desktop.png).
Independent code review reported no findings. Only isolated provider fixtures
were used; no real extraction, server mutations, infrastructure changes or
container restarts. Existing HMR applies the UI change. Historical suites were
not repeated; SFTPGo #18 is unchanged.

### 2026-10-14 — Datagrid rebuild and real SQLite correction

The original SQLite proof of concept serialized a function into an eval worker.
The dev `tsx` transform injected a module helper that was absent in that worker:
`ReferenceError: __name is not defined`. Three Owner-requested SQLite files all
returned 422 `viewer_sqlite_unavailable` despite valid headers. This failed attempt
is preserved as evidence: the earlier Vitest transform did not exercise the real
dev launch path. Datagrid now uses an autonomous ESM worker and tests both actual
`tsx` and compiled JavaScript execution.

Implemented: searchable table sidebar, first-table data in the initial response,
100-row pages, deterministic sorting and literal substring search across a chosen
column or non-BLOB fields, schema, keyboard cell navigation/copy, accessible column
resize and on-demand text chunks. Browser cache is local to viewer identity and
source (eight pages / 4 MiB estimated serialized UTF-16); no persistent browser DB
contents. Known revocation and source changes clear cached content. BLOBs remain
size-only, integers preserve precision, and long text never masquerades as a
complete copied value. Snapshot consistency remains explicitly unverified.

Focused validation:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/viewer-sqlite.test.ts`: **11 passed**, including real dev/prod worker startup, read-only source bytes, quoted/alias-collision columns, shadowed rowid/WITHOUT ROWID ordering, 128-column search, exact integers, Unicode chunks, revision and cancellation.
- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/sqlite-model.test.ts`: **3 passed** for LRU bounds, oversized responses and revision isolation.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/file-viewers.integration.test.ts`: **14 passed**, including real SQLite routes, source reuse, authorization, revocation and revision rejection. External storage is an isolated fixture; SQLite queries and application handlers are real.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/datagrid.browser.test.ts`: **7 passed** in Chromium, covering browsing/search/sort/schema, cached back-navigation, keyboard/pointer resizing, Unicode details, known access denial, changed sources, loading/error recovery and Italian mobile. Axe checks returned no violations for the tested desktop/mobile surfaces; keyboard tests include focus restoration and obscured-grid exclusion.
- The accompanying `apps/web/tests/file-viewer-escape.browser.test.ts` regression run: **3 passed**, preserving Escape behavior across existing viewers.
- `scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm i18n:check`, `scripts/dev.sh pnpm build` and `scripts/dev.sh pnpm build:runtime`: **passed**. Final frontend build was repeated after the canonical first-page cache correction; the lazy Datagrid chunk is 17.84 kB / 5.35 kB gzip, plus 9.04 kB / 2.42 kB gzip CSS, with no new dependency. Existing large main/editor bundle warnings remain.
- Focused Biome on 19 changed/new TS/TSX/CSS files passed with two pre-existing non-null-assertion warnings in `file-viewers.ts`.

Initial browser runs exposed two test-harness mistakes (a non-unique Refresh
locator and the persisted viewer reopening before a filename click); these were
corrected and the seven-scenario run passed. The initial non-M2 integration wrapper
reported unavailable services; the existing approved M2 stack was then used. No
containers were started or changed to resolve this.

Independent technical review found and resolved SQL output-alias ambiguity,
excessive search expression depth, retained browser data after a denied cell read,
inherited object-property column widths and keyboard focus behind the mobile
cell drawer. Final code and rendered desktop/Italian-mobile/content review report
no remaining must-fix findings.

Sanitized fixture screenshots:
[desktop](screenshots/m5/datagrid-desktop-en.png),
[Italian mobile](screenshots/m5/datagrid-mobile-it.png),
[cell details](screenshots/m5/datagrid-cell-detail-en.png),
[loading](screenshots/m5/datagrid-loading-en.png),
[empty](screenshots/m5/datagrid-empty-en.png),
[error](screenshots/m5/datagrid-error-en.png).

Read-only live evidence: the three Owner-specified `.db`, `.sqlite` and `.sqlite3`
files each returned HTTP 200 with four tables after the fix. First measured
requests were 871/206/156 ms; repeated requests were 172/70/92 ms with unchanged
revision. These are one smoke sample per file, not a benchmark or latency promise.
The real HTTPS browser opened the SQLite file with four tables and 500 displayed
cells, without JavaScript errors. Private paths, IDs, cookies and screenshots stay
ignored. No game files were changed, no live SQL was executed on the source, and
no Panel/Wings/Blueprint changes, migrations or manual container restarts occurred.
Normal approved dev watchers/HMR picked up code. Temporary isolated test databases
and fixture files were cleaned by their harnesses. SFTPGo #18 and the no-production
release boundary remain unchanged. Rollback is the code commit revert; no source
file or schema migration rollback is needed.

Final cross-browser/regression evidence:

- `NH_BROWSER=firefox scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/datagrid.browser.test.ts`: **7 passed**, including desktop/mobile axe checks and keyboard/detail focus tests.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'displays typed SQLite'`: **1 passed, 32 deliberately skipped**; existing typed-cell/audio/unsupported-video scenario remains intact after its SQLite fixture was updated to the new contract.
- Combined final SQLite/cache unit run: **14 passed**. Final dev API/Vite inspection: both running and healthy. No additional container operation.
- Final runtime build passed after the effective primary-key nullability correction (SQLite worker tests: **11 passed**). `git diff --cached --check` and `python3 scripts/check-governance.py` passed: 862 indexed text files, 301 review PNGs, 710 relative links, four TOML files and 44 ignore cases; secret scanning remains heuristic.

### 2026-10-14 — JSON Tree rebuild

Replaced the initial recursive `<details>` proof of concept with a read-only,
virtualized JSON/JSONC/JSON5 browser. Momoa remains the existing parser; the worker
retains the source and index rather than sending the entire tree to React. Normal
responses are capped at 200 rows, 240-character previews and 16 Ki UTF-16-unit
source chunks. Search, expansion, navigation, details and copy require no further
provider reads after opening. Exact branch copy preserves original numeric
lexemes, duplicate keys, order and comments; string-value copy decodes the string.
Ambiguous JSON Pointers are identified. Existing 8 MiB / 100,000 nodes / depth 128
and worker-deadline limits remain; there is no persistent browser content cache.

Implemented UI: bounded tree with type colors, debounced key/value search,
previous/next match, branch controls, keyboard arrows/Home/End, Ctrl/Cmd+C,
source details, EN/IT pluralization and precise syntax locations. Desktop details
retain tree navigation; mobile details use a native modal with inert background.
Shared tooltips now portal inside an open ancestor dialog to remain above its
backdrop. Fileman continues to own Home, Download, Open with and Escape.

Final focused evidence:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/json-model.test.ts --silent=false`: **13 passed**. Covers lexical precision, duplicate/prototype-like keys, original JSONC/JSON5 source, RFC 6901 escaping, ancestor ambiguity, decoded search, navigation, bounded replies, Unicode chunk boundaries, parser budgets, request IDs, abort, timeout and worker-failure cleanup.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/json-tree.browser.test.ts`: **8 passed** in Chromium; the same command prefixed with `NH_BROWSER=firefox` passed **8/8**. Actual React code, Web Worker and parser run in real browsers; viewer bytes and remote provider are isolated fixtures. Includes 60,001-node virtualization, immediate click/copy, exact raw copy, match navigation, long-value paging/focus, formats and primitive roots, parse/read errors, canceled loading, terminated-worker recovery, Italian mobile, modal tooltip placement and depth-35 match reveal. Desktop/mobile axe checks returned zero violations for tested surfaces.
- After aligning the search focus border with Fileman's existing input styling, the Chromium `-t 'keeps Italian mobile'` check passed **1**, with **7 deliberately skipped**, including the deep-tree screenshot and accessibility check. No complete historical suite was repeated for this CSS-only adjustment.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/tooltip.browser.test.ts`: **7 passed**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewer-escape.browser.test.ts`: **3 passed**, preserving shared Escape and editor discard behavior.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'preserves JSON numbers'`: **1 passed, 32 deliberately skipped**, retaining the existing JSON-to-Scribe and personal-default journey.
- `scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm i18n:check` and `scripts/dev.sh pnpm --filter @nickhosting/web build`: **passed**. Catalog contains 1,521 EN/IT/pseudolocale keys. Final lazy JSON UI: 14.77 kB / 5.05 kB gzip JS and 6.54 kB / 1.97 kB gzip CSS; parser worker 34.58 kB. No dependencies added. Existing main/editor bundle-size warnings remain.

The reproducible model test measures local parse/index + search + bounded view,
excluding source generation, network transfer and browser rendering. Final Node 24
samples (not end-to-end latency promises):

| Fixture | Source bytes | Time | Serialized response bytes / rows |
| --- | ---: | ---: | ---: |
| Wide, 100,000 total nodes | 588,885 | 242 ms | 46,042 / 200 |
| 128 nested arrays | 257 | <1 ms | 552 / 2 |
| Single 7 MiB string | 7,340,046 | 140 ms | 794 / 2 |

Development failures remain part of the record: an initial browser helper raced
remembered-viewer restoration, and a later failed helper left its rejection flag
set, cascading into other cases. The harness now navigates the mounted viewer
and resets the fixture flag between tests. Browser tests also exposed real stale
selection during immediate copy and premature scroll clamping during deep search;
both were fixed and the complete eight-scenario runs passed. A combined tooltip
run failed before its tests because isolated provisioning returned
`resources_unavailable`; the standalone run passed all seven, without changing
infrastructure or admission policy.

Independent technical and rendered EN-desktop/IT-mobile review resolved worker
retry using a terminated client, detail/pager focus loss, excessive mobile indent,
short-key truncation, action-selection races and deep reveal timing. Worker crashes
now report unavailable rather than incorrectly blaming valid JSON. Final review
has no outstanding must-fix findings. Automated checks and keyboard tests do not
constitute a complete screen-reader/WCAG certification.

Reviewed sanitized screenshots:
[desktop](screenshots/m5/json-tree-desktop-en.png),
[mobile](screenshots/m5/json-tree-mobile-it.png),
[desktop details](screenshots/m5/json-tree-details-en.png),
[mobile details](screenshots/m5/json-tree-details-mobile-it.png),
[deep mobile search](screenshots/m5/json-tree-deep-mobile-it.png),
[empty](screenshots/m5/json-tree-empty-en.png),
[loading](screenshots/m5/json-tree-loading-en.png),
[syntax error](screenshots/m5/json-tree-error-en.png).

No live game server, file, Panel/Wings/Blueprint configuration or credential was
read or mutated for this rebuild. Tests reused already approved isolated services;
temporary fixture schemas are cleaned by their harness. API/Vite dev were inspected
read-only and both remain healthy in `nickhosting-dev`. Existing HMR applies the
change; no container restart/build, network operation or production deployment.
SFTPGo #18 remains unchanged. Rollback is a code revert; there are no migrations,
provider changes or new persistent resources to undo.

Final focused Biome check: **14 changed/new TS/TSX/CSS files passed**; `git diff --check` passed.
Final staged governance passed: 868 indexed text files, 309 reviewed PNG assets,
719 relative links, four TOML files and 44 ignore cases. The secret scan remains
heuristic; the staged inventory contains only the scoped code, tests, documentation
and sanitized fixture screenshots.

### 2026-10-14 — JSON Tree initial keyboard focus and footer polish

Removed the footer JSON Pointer tooltip. The ready tree takes focus once when
mounted, so arrow navigation works immediately without clicking a row. Subsequent
search/selection updates do not steal focus. Independent read-only review found no
must-fix issues or late Fileman focus override.

Validation: focused `json-tree.browser.test.ts -t 'preserves source precision'`
through `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run
--config vitest.browser.config.ts` passed in Chromium and `NH_BROWSER=firefox`
(**one passed, seven intentionally skipped each**). Assertions cover initial focus,
immediate ArrowDown and no footer tooltip, plus the existing precision/copy/accessibility
checks. Focused Biome passed for both changed TSX/test files. No production access,
container changes, new resources or provider mutations; existing dev HMR applies
this UI-only correction.

### 2026-10-14 — Scribe false unsaved state for CSV/TSV

Read-only inspection of the Owner's two reported table fixtures confirmed 121
CRLF-terminated records in each. No contents or private paths are published and no
live file was modified. CodeMirror normalized those separators to LF; the prop
synchronization compared its normalized text against the original CRLF string,
replaced the document and emitted a false user edit.

Scribe now tracks the synchronized raw value, preserves uniform CRLF/LF/CR when
serializing real edits, and marks external updates as non-user/non-history changes.
CodeMirror keeps its flexible internal parser, including paste/drop and search
replacement. Syntax diagnostic offsets still use the normalized internal document.
Separator detection runs at initial load or external replacement, not on each key.
Mixed-ending files open clean; their existing normalization to LF on actual editing
is unchanged. Exact mixed-ending edit/undo preservation is not claimed by this fix.

The first browser attempt used the wrong accessible Save label; corrected to the
existing “Save changes”. The initial fixed-separator implementation was discarded
after independent review reproduced incorrect logical lines for escaped-newline
search replacements. The final serialization-only implementation covers that case.

Final validation:
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts -t 'line endings'`: **5 passed**, 34 intentionally skipped, Chromium.
- Same command with `NH_BROWSER=firefox`: **5 passed**, 34 intentionally skipped.
  Firefox's initial synthetic DataTransfer paste fixture supplied no text; replacing
  it with deterministic clipboard data made the same application-handler assertions
  pass. This exercises editor paste handling, not an operating-system clipboard grant.
- Cases cover CRLF CSV/TSV, LF and CR opening, real edit, undo/redo, exact saved bytes,
  multiline paste, escaped-newline Replace All and mixed-ending opening without writes.
- `scripts/dev.sh pnpm exec tsc --noEmit -p apps/web/tsconfig.json` and
  `scripts/dev.sh pnpm exec tsc --noEmit -p apps/web/tsconfig.tests.json`: passed.
- Focused Biome and `git diff --check`: passed. Independent final review:
  no must-fix findings. No complete historical suite rerun for this focused fix.

Only read-only sample inspection used the existing viewer SFTPGo read-only mount.
Browser mutations used isolated provider fixtures and already approved test services;
no real files were saved, no infrastructure changed and no containers restarted.
The update uses existing frontend HMR; rollback is a source revert.

### 2026-10-14 — Editable CSV/TSV Datagrid and shared Scribe session

Physical CSV/TSV opens in Datagrid with editable cells, row/column changes, header
controls, search/filter/sort and paging. An icon switches to Scribe and back using
one draft, save revision and undo history. No file reread or write occurs merely
from switching. The reusable document-view contract is a compiled ViewerEngine
extension; it does not patch another viewer's DOM. Shared Datagrid rendering is
independent of SQLite versus delimited-source adapters. SQLite and archive entries
remain read-only. The existing 1 MiB UTF-8 text editor boundary remains unchanged.

PapaParse 5.7.0 (MIT) runs in a browser worker. Values remain strings; formulas are
never executed, leading zeros and large integers are preserved. Untouched source
quoting, BOM and newline sequences are retained. This extends the preceding Scribe
fix: mixed newline preservation on actual edits is now covered, including embedded
LF inside CRLF-delimited quoted CSV cells, shared undo/redo and exact saved bytes.
Actual external document replacement resets old history, preventing stale raw
patches from affecting a replacement document.

Independent reviews found and resolved: normalized newlines corrupting untouched
multiline cells, stale column filters after structural edits (including deletion
of the widest ragged row), stale undo after external replacement, mobile footer
clipping, and missing keyboard entry into the body after header selection. Reviewers
subsequently reported no outstanding must-fix findings. Independent model checks
covered 156 parsing/edit combinations and 350 seeded raw-history edit sequences.

Validation (isolated provider fixtures and existing approved M2 test services):

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/file-editor-document.test.ts apps/web/src/features/viewer-engine/builtin-viewers/delimited-model.test.ts apps/web/src/features/viewer-engine/core/registry.test.ts`: **21 passed**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/delimited.browser.test.ts`: final **8 passed**, Chromium.
- Same browser command with `NH_BROWSER=firefox`, also including `apps/web/tests/datagrid.browser.test.ts`: **15 passed** (eight delimited plus seven SQLite journeys).
- Chromium SQLite suite: **7 passed** during the combined regression run; the delimited portion initially failed a test selector and was corrected/retested separately.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-manager.browser.test.ts -t 'opens.*clean and preserves|mixed line endings'`: **5 passed**, 34 intentionally skipped, separately on Chromium and Firefox.
- Browser cases cover live cell flushing before switching, zero switch rereads/writes,
  cross-view Undo/Redo, conditional save conflict retention, malformed CSV repaired
  in Scribe, source-row edits after sorting, structural changes, header keyboard
  navigation, read-only archive switching and mobile pagination. Axe reported no
  violations in tested desktop/mobile editor surfaces.
- `scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm build`,
  `scripts/dev.sh pnpm i18n:check` and focused Biome: passed. Build retains existing
  large-chunk warnings; the separate delimited worker is about 25.6 kB uncompressed.
  English/Italian/pseudolocale catalog contains 1,550 keys.

Initial test failures included mismatched accessible labels (Edit cell/menu item/
Delete column), a blank-origin sessionStorage access in an isolated test, an overly
strict single initial request assertion under React development remounting, and a
unit assertion unintentionally grouping two history edits. Test fixtures were
corrected without weakening switch/no-write assertions. All final cases above pass;
full historical M1–M5 suites and live game tests were intentionally not rerun.

Reviewed browser captures:
[desktop](screenshots/m5/datagrid-csv-desktop-en.png),
[Italian mobile with pagination](screenshots/m5/datagrid-csv-mobile-it.png),
[parse error](screenshots/m5/datagrid-csv-error-en.png),
[retained draft after save conflict](screenshots/m5/datagrid-csv-conflict-en.png).
These use synthetic provider data and real application handlers/browser workers;
they are not evidence of live server writes. Test databases/caches use harness-owned
cleanup. No Pterodactyl/Wings resources, real files or Blueprint installation changed.
Issue #18 and production-release boundaries remain unchanged.

Owner-approved development activation completed: saved the previous Vite image as
`nickhosting-dev-app:before-datagrid-csv`, built the existing `vite` service and ran
`docker compose --env-file .env.dev.local up -d --no-deps --wait vite`. Only
`nickhosting-dev-vite-1` was recreated. It is healthy, with zero restarts, still on
`nickhosting-dev-edge` only and no published ports. Root HTTPS, document module,
worker module and its PapaParse dependency return HTTP 200. The existing Compose
orphan warning was left untouched; no orphan removal or other cleanup ran.

API/worker/database, network configuration, provider and persistent review data
were not changed. The previous image is retained for the approved scoped rollback;
a source revert plus retag/recreation of Vite restores the previous frontend.
The shipped worker license notices now include PapaParse's full MIT notice.
Final staged governance: **passed**, 883 indexed text files, 313 review PNGs,
723 relative links, four TOML files and 44 ignore cases (secret scan is heuristic).

### 2026-10-14 — Compact delimited Datagrid toolbar

Search/filter, editing icons and delimiter controls now share one desktop row;
icons sit immediately left of the right-aligned delimiter. Header interpretation
uses a labelled icon toggle with a custom tooltip and `aria-pressed`. Narrow mobile
layouts wrap the grouped controls without losing actions or pagination. No parsing,
save or provider contract changed. Existing desktop/mobile screenshots above updated.

`pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/delimited.browser.test.ts -t 'shares draft|Italian mobile'`
(via `scripts/dev.sh`): **2 passed**, six unrelated cases intentionally skipped.
Checks include same-row desktop placement, header toggle without dirtying the file,
shared draft/save behavior, mobile overflow/footer and Axe. Web typecheck and focused
Biome passed. Source-only HMR update; no rebuild, restart or live provider interaction.

Follow-up: Datagrid owns Ctrl/Cmd+F while active even when focus is on Fileman's
surrounding toolbar. Hidden delimited views do not intercept Scribe's search;
SQLite's Schema view retains browser Find. A shared search field shows `CTRL + F`
(or `⌘ + F` for Apple keyboards) only while empty, alongside the localized placeholder.
Firefox focused delimited desktop/mobile suite: **2 passed**, six skipped; covers
external focus, Ctrl/Meta shortcuts, Scribe handoff, hint hiding/restoration, Axe and
320px Italian reflow with the longest separator label. SQLite keyboard regression:
**1 passed**, six skipped. Web typecheck and focused Biome passed. A test selector
initially omitted the separator's punctuation; corrected and the mobile check passed.
Independent review closed the narrow-screen clipping and Schema-shortcut findings;
no remaining must-fix findings. Changes use existing HMR, with no live mutations.

### 2026-10-14 — Datagrid contextual row/column editing

Added icon context menus on cells, row numbers and headers, keyboard invocation and
a compact touch actions button. CSV/TSV supports source-relative row/column insertion,
first/last positions, rename and confirmed deletion; SQLite/archive menus remain
read-only. Native Tab advances after closing the menu, Escape restores the trigger,
and row targets do not add 100 tab stops to a page. Mobile submenus expose Back.
No new file read, write path or provider call is added by opening a menu.

Validation (all commands through `scripts/dev.sh`):

- `pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/delimited-model.test.ts`:
  **23 passed**; stable identity under sorting/filtering/paging, insertion boundaries,
  empty/header cases, invalid anchors, exact serialization and source restoration.
- `pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/delimited.browser.test.ts`:
  initial run **8 passed, 2 failed**. It exposed automatic header detection changing
  after redoing a blank-row insertion, fixed by retaining interpretation per open
  document; the other failure was a test label mismatch (Rename column). The two
  affected cases then **passed**, and an additional sort-key edit/row-context case
  **passed**. All eleven cases have passing evidence; the final runs were targeted,
  not a repeated full suite.
- The same command with `NH_BROWSER=firefox` and
  `-t 'context|keyboard.*insertion|Italian mobile'`: **4 passed**. Covers source-order
  insertion, Scribe/Undo/Redo/save, keyboard submenus, row-number targets and mobile.
- Final Firefox Italian mobile rerun after adding submenu Back: **1 passed**,
  including Back/reopen, viewport bounds and zero Axe WCAG AA violations in menus.
- SQLite browser file with `-t 'context actions|uses keyboard'`: **2 passed**, six
  unrelated cases skipped. Real SQLite handlers, readonly actions, details and focus.
- `pnpm typecheck`, `pnpm build`, focused Biome and catalog compilation: **passed**.
  Build retains the existing large-chunk advisory; no new dependency was added.

These tests use real application handlers/browser workers with synthetic provider
files and already-approved isolated test services. Harness state is cleaned up;
no real game-server files, production resources, containers or network configuration
were changed. Development receives source changes through existing HMR.

Independent technical review found no remaining must-fix findings. Browser review
confirmed readable desktop menus and contained mobile menus; its mobile Back
suggestion was implemented. Review also resolved unnecessary row tab stops and menu
Tab behavior. Historical failed attempts above are retained. SFTPGo #18 remains an
independent production-release gate.

Reviewed captures:
[desktop context menu](screenshots/m5/datagrid-csv-context-menu-desktop-en.png),
[Italian mobile menu](screenshots/m5/datagrid-csv-context-menu-mobile-it.png).

### 2026-10-14 — Shared destructive confirmation

Extracted Fileman's centered confirmation into `ConfirmDialog`, now used by Fileman
and Datagrid deletion. Neutral Cancel initially focused, red Delete, close icon,
arrow navigation, pending-dismissal protection and visible retryable errors reuse
existing primitives. Rename and other modal layouts are unchanged. Datagrid still
modifies only its shared draft until Save; Fileman retains its existing permission
check and delete request. No new backend/API/configuration or dependency.

Focused commands, via `scripts/dev.sh`:

- `pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/delimited.browser.test.ts apps/web/tests/file-shortcuts.browser.test.ts -t 'shared destructive confirmation|shared deletion confirmation|defaults Delete confirmation|reconciles removed columns'`:
  initial **2 passed, 2 failed** exposed a nested editor form/submit propagation.
  ConfirmDialog now renders through a portal and ActionForm stops submit bubbling.
  Rerun: **4 passed**, 21 unrelated cases skipped. Includes no unintended editor
  write, local Undo, column deletion, pending Escape/Close protection, failure/retry
  and English/Italian Fileman keyboard confirmation.
- `NH_BROWSER=firefox` with the delimited browser file and
  `-t 'shared destructive confirmation'`: **1 passed**, eleven skipped; desktop EN
  and mobile IT, cancellation/focus, no unintended save, viewport bounds and zero
  Axe WCAG AA violations for the desktop confirmation.
- `pnpm --filter @nickhosting/web typecheck`, focused Biome and `git diff --check`:
  **passed**. No full historical suite rerun.

Reviewed screenshots:
[Datagrid desktop](screenshots/m5/datagrid-delete-confirm-desktop-en.png),
[Datagrid Italian mobile](screenshots/m5/datagrid-delete-confirm-mobile-it.png),
[Fileman desktop](screenshots/m5/files-delete-keyboard-en.png),
[Fileman Italian mobile](screenshots/m5/files-delete-keyboard-it.png).

Existing approved isolated services and synthetic provider files only; harness
state cleaned. No production files/resources, game servers, containers or networks
were changed or restarted. Source loads through existing development HMR. Independent
review covers shared component behavior, preserved mutation contracts and real renders.
Issue #18 remains an independent production-release gate.

### 2026-10-14 — Folio read-only PDF viewer

Folio adds PDF navigation, text selection, search/highlights, editable zoom,
fit presets, rotation, thumbnails, outline, password entry and bounded print
preparation. Fileman retains download/Open with. PDF.js 6.4.299 and its worker,
fonts/decoders are lazy and self-hosted; all 283 emitted static assets/license
files were compared byte-for-byte with the pinned package. No Blueprint changes.
The existing authorized source revision pins Range reads; no content hash or
repeated provider identity request was introduced.

Validation on the final implementation:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/pdf-model.test.ts apps/web/src/features/viewer-engine/core/registry.test.ts`: **8 passed**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run apps/api/src/file-viewers.integration.test.ts`: **17 passed**, including physical/archive stale revision rejection before bytes, permission precedence and PDF preference persistence.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/pdf-viewer.browser.test.ts`: **9 passed**, Chromium, 53.94 s.
- Same command with `NH_BROWSER=firefox`: **9 passed**, 80.68 s.
- Targeted existing `file-viewers.browser.test.ts` chooser tests for showing all viewers, unsupported defaults and Italian mobile keyboard navigation: **3 passed**. Expectations now include eight viewers and the additional keyboard stop.
- `scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm build`, `scripts/dev.sh pnpm i18n:check`, focused Biome and `git diff --check`: **passed**. Existing main/editor chunk-size warnings remain; PDF engine and CSS are lazy chunks. No historical full suite rerun.

Browser coverage uses original generated PDFs and real application content/Range
handlers, with only the remote source mocked. It includes safe/unsafe links,
noninteractive forms/no PDF script execution, mixed page sizes, text/search,
password rejection and success, malformed/empty documents, late first-page
failure with retry, revision-bound ranges, refresh restoration, PDF within a real
ZIP, three-page print preparation and afterprint cleanup, responsive fit presets
and retained numeric zoom. Native OS print dialogs/printer output were not automated.
Application controls and generated annotation names pass Axe checks. Tiny fixed
PDF annotation geometry is excluded only from target-size checking under the
inline/essential-presentation exception; application controls retain that check.
This is scoped evidence, not a blanket accessibility certification of PDF content.

Earlier failures preserved: the first cold browser fixture setup rejected a
stale resource observation before Folio ran; the unchanged policy passed warm
runs. Initial test assertions incorrectly treated read-only directory batch POSTs
as writes. Review then found missing annotation labels, uncaught asynchronous
first-page failure, print cleanup and fit presets retaining desktop scale after
resize; these were corrected and covered by final browser runs. Existing chooser
assertions also expected outdated JSON Tree whitespace and were corrected without
changing production behavior. Independent technical/accessibility/UX review found
no remaining must-fix issue after these corrections.

Reviewed, synthetic screenshots:
[desktop English](screenshots/m5/folio-desktop-en.png),
[desktop Italian](screenshots/m5/folio-desktop-it.png),
[mobile English](screenshots/m5/folio-mobile-en.png),
[mobile Italian 320px](screenshots/m5/folio-mobile-320-it.png),
[mobile Italian 390px](screenshots/m5/folio-mobile-390-it.png),
[thumbnails](screenshots/m5/folio-thumbnails-en.png),
[outline](screenshots/m5/folio-outline-en.png),
[search](screenshots/m5/folio-search-empty-en.png),
[archive member](screenshots/m5/folio-archive-en.png),
[password](screenshots/m5/folio-password-en.png),
[loading](screenshots/m5/folio-loading-en.png),
[error](screenshots/m5/folio-error-en.png),
[empty PDF](screenshots/m5/folio-empty-en.png),
[malformed PDF](screenshots/m5/folio-malformed-en.png).

Owner-approved activation saved the old Vite image as
`nickhosting-dev-app:before-folio`, built the development image, then ran
`docker compose --env-file .env.dev.local -f compose.dev.yaml up -d --no-deps --wait vite`.
Only `nickhosting-dev-vite-1` was recreated. New image:
`sha256:9ce2d8870161b55bc4c177e76b6ae9b2fbec8413e6e4722802acf10df120723a`.
Vite is healthy, remains solely on dev-edge and publishes no host ports. API is
healthy on its unchanged image; no API/Gateway/Panel/Wings restart occurred.
The Compose warning about services supplied by overlays did not cause removal;
no orphan cleanup command was used. HTTPS font asset returned 200.

A private, authenticated Chromium smoke test read the existing dataset through
the real viewer transport: `hosting-report-8-pages.pdf` rendered 8 pages,
`short-report-3-pages.pdf` rendered 3, and `empty.pdf` produced the expected error.
No browser JavaScript errors. Private screenshots stay ignored; no provider file,
server state, production configuration or credential was changed. Isolated
browser schemas/fixtures were cleaned by their harness. No game assets created.
Rollback is the reviewed previous code plus saved Vite image, recreating only
Vite; no database migration or data rollback is required. SFTPGo issue #18 remains
an independent production-release gate.

Owner verification then exposed an additional Firefox issue missed by the initial
light-OS screenshots: upstream PDF.js CSS included global `.sidebar` selectors
and `:root { color-scheme: light dark }`, changing the application sidebar and
leaving it changed after closing Folio. The upstream stylesheet is now imported
inline, scoped to `.folio`, with root declarations rewritten to `:scope`, and
removed on unmount. PDF viewport height is maintained locally. Folio's native
controls/scrollbars inherit the application theme; scrollbars use neutral palette
colors with forced-color mode preserved. No further image/restart was needed.

Final CSS verification: full Firefox PDF suite **10/10 passed** (64.52 s), after
initial targeted theme/render tests **2/2 in Firefox and 2/2 in Chromium**. The
regression compares actual application sidebar styles and document color scheme
before opening, while reading, and after closing under a dark OS preference.
Final screenshot set was regenerated; additional
[before](screenshots/m5/folio-shell-before-dark-preference-firefox.png),
[during](screenshots/m5/folio-shell-during-dark-preference-firefox.png), and
[after](screenshots/m5/folio-shell-after-dark-preference-firefox.png) images prove
isolation. The final scrollbar assertion passed separately: **1/1 Firefox** (17.73 s) and
**1/1 Chromium** (13.02 s).
A real Firefox read-only dataset smoke also passed both valid PDFs and the empty
PDF, with unchanged shell styles, a light viewport color scheme and zero JS
errors. Final scoped-style production build and web typecheck passed.

### 2026-10-14 — Shared JSON/Scribe views and document-position handoff

JSON/JSONC/JSON5 within the existing text-editor budget now share one document
session with Scribe, with the same icon switch as CSV/TSV. Selected JSON nodes and
Datagrid cells transfer their exact source position into Scribe; returning selects
and reveals the matching node/cell. Multiline quoted records, BOM/CRLF, sorting,
filtering, paging, duplicate JSON keys and unsaved drafts are covered. Parsing and
position lookup remain in browser workers; switching neither writes nor rereads
provider files. Standalone large-JSON previews and read-only archive members keep
their existing limits and permissions. Markdown is not part of this change.

Commands and evidence:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/file-editor-document.test.ts apps/web/src/features/viewer-engine/core/registry.test.ts apps/web/src/features/viewer-engine/builtin-viewers/delimited-model.test.ts apps/web/src/features/viewer-engine/builtin-viewers/json-model.test.ts`: **58 passed**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/document-positions.browser.test.ts apps/web/tests/json-tree.browser.test.ts`: **16 passed** in Chromium (60.12 s; the initial eight position cases and eight standalone JSON cases). Earlier runs exposed fixture assumptions about inferred headers, smart Home and trailing whitespace; those assertions/setup were corrected. Standalone fixtures exceed 1 MiB intentionally, preserving independent preview/read/retry coverage.
- `NH_BROWSER=firefox scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/document-positions.browser.test.ts`: final **10 passed** (53.67 s), including added rapid-reparse switching and archived JSON toolbar → Scribe → Open With → JSON Tree. No extra provider reads or writes while switching; invalid drafts remain repairable.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/delimited.browser.test.ts`: final **12 passed** (62.26 s). Initial run was **10 passed / 2 failed**: keyboard insertion and schema/filter reconciliation. Undo could leave a cell focused after reparsing cleared its selection; clicking the already-focused cell did not emit another focus event. Selection now reconciles with that cell after page commit without moving focus or overriding a pending handoff. Both failed cases passed targeted checks before the final suite.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/file-viewers.browser.test.ts -t 'restores the open viewer|preserves JSON numbers'`: **2 passed / 31 intentionally skipped** (32.30 s). The refresh assertion now checks that retained JSON Tree is hidden rather than unmounted.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: **passed**. Targeted `pnpm exec biome check` for 26 relevant TypeScript/test files: **passed**. `scripts/dev.sh pnpm build`: **passed**, 1608 compiled EN/IT/pseudolocale keys; existing large-chunk warnings remain.

Independent code review found and resolved a shared-view host-state mismatch:
archived JSON's toolbar previously changed only the nested text viewer, so choosing
JSON Tree again in Open With could leave Scribe displayed. The host now owns that
selection with a stable document key, retaining the same document and read. Final
review found no remaining must-fix issues, including the focused-cell reconciliation.
Independent screenshot review found no layout/compact-content regression; keyboard
and actual cursor/selection behavior are established separately by browser tests.

Reviewed sanitized evidence:
[CSV source line 32](screenshots/m5/document-position-csv-row32-scribe-en.png),
[JSON node selection](screenshots/m5/document-position-json-duplicate-en.png), and
[mobile JSON](screenshots/m5/document-position-json-duplicate-mobile-en.png).

Only isolated fixture handlers and the existing approved M2 test services were
used; the harness cleaned its schemas/fixtures. No real game files, provider state,
credentials, Blueprint, networks or containers were changed/restarted. Development
uses its existing source hot reload; no new dependency/image is required. Rollback
is reverting this source change; no data migration. SFTPGo #18 remains unchanged.
The historical full milestone suites were not rerun for this frontend-only change.

Final staged governance passed: 899 indexed text files, 337 review PNGs, 750
relative links, four TOML files and 44 ignore cases; secret scanning is heuristic.
`git diff --cached --check` passed.


### 2026-10-14 — Quill Markdown documents

Quill is a lazy shared document view alongside Scribe. See [syntax and boundaries](M5-QUILL.md):
GFM, safe HTML, math/chemistry, callouts, highlighted code, outline/search/print,
frontmatter, local citations, Mermaid and bounded Obsidian wiki links/inclusions.
Custom directive/tab blocks (the Owner's item 12) are excluded. Task-list edits
share the existing explicit save, revision and undo history; archive/included notes
stay read-only. Source position survives switching to/from Scribe. No Blueprint
extension update or additional provider API is required.

Validation commands:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/markdown/parser.test.ts apps/web/src/features/viewer-engine/builtin-viewers/markdown/bibliography.test.ts apps/web/src/features/viewer-engine/builtin-viewers/markdown/ui-model.test.ts apps/web/src/features/viewer-engine/core/registry.test.ts apps/web/src/features/viewer-engine/core/document-resources.test.ts`: **37 passed**. Separate `bibliography-client.test.ts`: **2 passed**, covering worker loading/parsing deadlines, cancellation and cleanup.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/file-viewers.integration.test.ts`: **17 passed**, including the authenticated Markdown viewer preference contract.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/markdown.browser.test.ts`: **9 passed** in Chromium. With `NH_BROWSER=firefox`: final **9 passed**, 44.58 s. Assertions cover real rendering, local BibTeX and inline CSL-JSON, task edit/undo/save readback, no repeated content read during switching, wiki navigation, hostile HTML/diagram assets, archive read-only behavior and Italian mobile search. Scoped Axe WCAG 2/2.1/2.2 AA checks report **zero violations** on the checked EN desktop and IT mobile surfaces; this is not a blanket WCAG certification.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/document-positions.browser.test.ts`: final **10 passed**, 58.26 s, preserving CSV/JSON shared-document behavior.
- `scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm build`, `scripts/dev.sh pnpm i18n:check` and focused `pnpm exec biome check`: **passed**. Build compiles 1,648 EN/IT/pseudolocale keys. Existing main/editor and lazy diagram large-chunk warnings remain; Markdown, bibliography and diagram work is loaded on demand.

Development failures and corrections are retained here rather than presented as
successful attempts. Initial browser runs failed because upstream browser exports
used DOMParser/document inside workers. Math now uses the pure parse5 conversion;
the named-character decoder explicitly resolves its pure worker-safe entry.
Subsequent tests caught a double slash in root wiki navigation, CTRL+S focus loss,
code contrast, missing Mermaid labels and Firefox task checkboxes temporarily
reverting while the preview reparsed. Those were corrected with targeted coverage.
A cold bibliography worker also exhausted a deadline that incorrectly included
module loading: it now has a separate bounded startup handshake and parsing limit.
The first shared-document regression run was 8 passed / 2 failed during active
module/dependency changes; the stable-source final run passed all 10 without changes
to CSV behavior. No historical failed run was counted as a pass.

After the final task-checkbox and worker-startup fixes, the targeted Chromium
command above with `-t 'bibliography|shares task'` passed **3 tests / 6 intentionally
unselected**, 18.92 s. Its first attempt stopped in isolated fixture provisioning
with `resources_unavailable` before any browser assertion; the serial retry passed.
Final production build and web typecheck were repeated after the worker change
and passed. Staged governance passed: 924 text files, 339 review PNGs, 760 relative
links, four TOML files and 44 ignore cases; secret scanning remains heuristic.
`git diff --cached --check` passed.

Independent code/security and screenshot review resolved eager Mermaid asset
requests before sanitization, repeated-include budget bypass, Unicode search
offsets, embedded anchor namespaces, missing footnote return IDs and task labels.
Final reviewer reports **no remaining must-fix findings**. Resource reads reuse
existing authorized brokers and indexed metadata; no recursive server crawl or
per-link provider identity implementation was introduced.

Reviewed real-browser screenshots: [desktop English](screenshots/m5/quill-desktop-en.png)
and [mobile Italian search](screenshots/m5/quill-mobile-it-search.png).

Tests used isolated application handlers, schemas and provider-byte fixtures with
the already-approved test services. No game server, real file, Blueprint, Panel,
Wings or production resource was mutated; test schemas are cleaned by the harness.
Historical full M1–M5 suites were not repeated. The new dependencies require a
separately approved update of the existing development Vite container; approval
was pending at the implementation commit (activation follow-up below). Rollback is reverting Quill source/dependency changes
and recreating only Vite with its saved image, without migrations or data resets.
SFTPGo issue #18 remains an independent production-release gate.


### 2026-10-14 — Quill development activation and bounded Vite optimization

The Owner explicitly approved updating only Vite and scoped rollback. Saved the
previous image as `nickhosting-dev-app:before-quill`, then executed:

```sh
docker compose --env-file .env.dev.local -f compose.dev.yaml build vite
docker compose --env-file .env.dev.local -f compose.dev.yaml up -d --no-deps --wait vite
```

The image build passed. Activation exposed two actual container memory failures
that the unconstrained browser harness did not reproduce: late discovery of worker
dependencies rebuilt the complete optimization graph, and serving the optimized
Mermaid/ELK graph caused another OOM after the first correction. Both failed smoke
attempts are retained in private logs; neither is reported as successful activation.

The correction stays inside application development configuration: explicit worker
scan entries, and a dev-only alias to Mermaid's existing split browser ESM
production distribution, excluded from redundant dependency optimization. Production
builds still use the original Mermaid entry. No dependency version, memory limit,
network or host setting was changed. See [Vite scanning options](https://vite.dev/config/dep-optimization-options#optimizedeps-entries).
Two scoped `up -d --no-deps --wait --force-recreate vite` recovery operations replaced
only the failed Vite container within the approved activation. Compose's warning
about separately configured development services did not trigger orphan removal.

Final image: `sha256:2460669093a603d7280be97aa927e2fd5d07b08d5774ab0fccda61828a1ee222`.
`nickhosting-dev-vite-1` is **healthy**, restart count zero, only on the existing
`nickhosting-dev-edge` network, with no published host ports. Actual HTTPS browser
smoke returned HTTP 200, confirmed Vite HMR connected, loaded Quill, executed its
parser/math and bibliography workers, and rendered Mermaid successfully. No page
JavaScript errors occurred; the anonymous session probe correctly returned 401.
The first standalone browser launch lacked the already-installed user-local shared
library path; retry used the same library path as the established browser harness,
without installing system packages.

After the complete real-dev smoke, cgroup peak memory was **1,133,830,144 bytes**
(about 1.06 GiB) under the unchanged 1.5 GiB limit, with zero OOM/kill events in the
replacement container. This is observed smoke evidence, not a universal memory
bound for arbitrary documents. The prior image remains available for rollback.
No API, worker, Gateway, provider or production container was recreated; persistent
state, accounts, files and network attachments remain unchanged. Only anonymous
application/module requests and synthetic in-browser documents were used.

The final dev-only packaging change passed `scripts/dev.sh pnpm typecheck` and
focused Biome checks. The Quill browser command with `-t 'renders diagrams'` passed
**1 test / 8 intentionally unselected** (31.23 s), including rejection of malicious
diagram asset requests. Independent follow-up review confirmed the upstream browser
distribution, unchanged rendering guards and production entry; no must-fix remains.

### 2026-10-14 — Quill cold-open readiness and Retry

Reported behavior: opening Markdown after Fileman refresh could wait and show
`viewer.unavailable`; Retry then succeeded quickly. Inspection and a controlled
reproduction established that the main parser's 12-second deadline included cold
module loading, unlike the bibliography worker. The main parser now announces
readiness; loading has a separate 20-second bound and actual parsing retains its
12-second deadline. Loading/rendering errors have accurate EN/IT messages rather
than incorrectly instructing the user to download a supposedly unsupported file.

Worker failure now permits an explicit subsequent parse to create a replacement,
so embedded-note Retry also recovers. Closing the document remains terminal;
failed-generation events are ignored and all pending work/timers are cleaned.
No background retries, new provider requests or dependency changes were added.

Read-only Firefox investigation of the Owner-indicated development dataset opened
its Markdown file after Fileman refresh in **1,480 ms before** the correction
(worker result 462 ms) and **1,559 ms after** (worker ready 357 ms, result 450 ms).
The user's intermittent failure was not reproduced spontaneously in these runs;
these timings are not evidence of a performance improvement or proof of the
specific original incident's cause. A deliberate 13-second worker request delay
reproduces the defective deadline boundary and verifies the correction without
clicking Retry.

Validation:

- `scripts/dev.sh pnpm exec vitest run apps/web/src/features/viewer-engine/builtin-viewers/markdown/ui-client.test.ts apps/web/src/features/viewer-engine/builtin-viewers/markdown/parser.test.ts apps/web/src/features/viewer-engine/builtin-viewers/markdown/bibliography-client.test.ts`: **20 passed**, including startup/parsing timeouts, replacement, deduplication and disposal.
- `NH_BROWSER=firefox scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/markdown.browser.test.ts -t 'cold worker|shares task|preserves unsaved'`: **3 passed / 7 unselected**, 45.43 s. Covers refresh plus delayed worker, explicit save/undo and Scribe draft/position handoff.

- Chromium's same browser command with `-t 'cold worker'`: **1 passed / 9 unselected**, 27.33 s; the test asserts its delayed-worker interception actually occurred.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`, `scripts/dev.sh pnpm build`, `scripts/dev.sh pnpm i18n:check`, focused Biome and diff whitespace checks: **passed**. No historical full milestone suite was repeated.

Independent review found no remaining must-fix; it also independently verified
constructor failure and stale worker events. The fix is loaded through existing
dev source/HMR and catalog compilation. No image update, container restart,
provider mutation, game-file write or new infrastructure was performed. Real reads
used the existing authenticated development session; no credentials are published.

### 2026-10-14 — Quill complete-document printing

Fixed print pagination without changing screen layout: hide off-document subtrees,
release height/overflow/flex constraints along the document's ancestor path, and
print the article in normal block flow instead of absolute positioning. Previously,
the new regression reproduced a 727px printed article for a 64-section document.

Validation:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/markdown.browser.test.ts -t 'prints the complete'`: passed in Chromium; repeated with `NH_BROWSER=firefox`: passed. One targeted test per browser, ten unrelated tests skipped. Chromium PDF extraction checks all 64 section markers and the final-page marker; both browsers check unclipped print layout and restoration after `afterprint`, including printing after scrolling to the bottom.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed.
- Focused Biome checks and `git diff --check`: passed.
- Read-only development smoke opened the Owner-authorized synthetic long document:
  Chromium generated a **16-page PDF** containing all 64 markers; Firefox print-media
  layout expanded from 459px to 16616px and restored to 459px afterward.
  Firefox's native print-dialog PDF export was not automated. Reviewed
  [Firefox print-layout screenshot](screenshots/m5/quill-print-firefox.png).
- Independent reviewer found no must-fix issues. Existing lazy-resource/loading
  boundaries are unchanged; this fix addresses document clipping/pagination.

No container restarts, provider writes, or server-file changes. Existing isolated
test services were reused. Development received the CSS through Vite HMR.
Rollback: revert this scoped CSS/test change. PR #21 remains open and unmerged;
SFTPGo issue #18 remains unchanged.

### 2026-10-14 — Quill metadata visibility and print scale

Information is absent for documents without nonempty parsed metadata. The single
Print toolbar icon now opens a compact native popover with a percentage field,
minus/plus controls and Print. Default 100%, accepted range 25–200%; Enter submits,
Escape/outside click dismiss. Scale changes print layout only, preserving screen
geometry and source text. English, Italian and pseudolocale catalogs updated.

Focused validation uses the existing isolated browser harness/provider fixtures:
`scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/markdown.browser.test.ts -t 'print|metadata'`
The same command was repeated with the `NH_BROWSER=firefox` prefix: six tests passed, ten unrelated tests skipped.
Chromium: six targeted tests passed, ten unrelated tests skipped; final settings
regression rerun passed after adding form-isolation and zero-file-write assertions.
PDF extraction at 100% and 150% retains all 64 sections and the final-page marker,
with more pages at 150%. Keyboard dismissal/submission, empty/out-of-range scale,
valid bounds, screen restoration and empty/nonempty frontmatter are covered.
During development, review caught nested Fileman form interference; the popover
now renders through a body portal with explicit print handlers, and its input
has no form owner. Printing does not submit file edits.

Web typecheck, focused Biome, catalog completeness and whitespace checks passed.
Read-only Firefox development smoke confirms hidden metadata and popover focus/
Escape at desktop and mobile widths. Reviewed screenshots:
[desktop Italian](screenshots/m5/quill-print-options-desktop-it.png),
[mobile Italian](screenshots/m5/quill-print-options-mobile-it.png).
Independent technical and visual review: no remaining must-fix findings.
No provider writes, infrastructure operations or container restarts; changes apply
through Vite HMR. Rollback: revert this scoped UI/CSS/catalog change. SFTPGo #18 and
production-release boundaries are unchanged.

Owner polish: removed the extra blue focus outline/shadow from the Scale input
without changing its focus, typing or Enter handling. Refreshed and reviewed
Firefox desktop/mobile screenshots; read-only smoke and focused CSS Biome pass.
Button keyboard focus indicators remain visible. No expensive suites repeated
for this CSS-only adjustment.

### 2026-10-14 — Stable usernames and primary/additional SFTP access

Unique immutable usernames are separate from editable display names. Added a
persistent primary SFTP identity per actor/server, 16-character passwords and
named additional accesses with an Owner-configurable limit (default 3). Existing
credentials stay auxiliary with unchanged provider identity, password and expiry.
Migrations 029/030 and the two explicitly approved username assignments were
applied only to dev; existing credential records were compared before/after and
preserved. See [contracts](M5-API-CONTRACTS.md) and
[deployment/rollback notes](M5-SFTP-DEPLOYMENT.md).

Exact focused commands/results (no full historical matrix rerun):

```bash
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/auth/src/identity.integration.test.ts packages/auth/src/invitation.integration.test.ts packages/auth/src/username.integration.test.ts
# 37 passed; migration/default/uniqueness, concurrent registration, invite rollback, immutable username.
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/external.integration.test.ts
# 36 passed.
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/external.integration.test.ts -t 'revokes .* logins when issuer authority'
# Final storage-transition correction: 2 passed, 34 unrelated tests skipped.
scripts/dev.sh pnpm exec vitest run packages/external-services/src/external-services.test.ts
# 22 passed, including stable named rotation and omitted zero expiry.
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/external-services/src/sftpgo.integration.test.ts -t 'named persistent'
# 1 passed, 8 unrelated tests skipped. Real isolated SFTPGo login/read/rotate;
# old password fails fresh authentication, new password works, username preserved.
scripts/dev.sh pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/sftp-ui.browser.test.ts
# 6 passed: confirmations, failures, one-time password, auxiliary limit,
# EN/IT desktop/mobile, automated axe WCAG checks (no reported violations).
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/services.browser.test.ts -t 'issues, rotates'
# 1 passed, 19 unrelated tests skipped; real handlers and isolated provider fixture.
scripts/dev.sh pnpm typecheck
scripts/dev.sh pnpm i18n:check
# Passed; 1683 keys in EN/IT/pseudolocale.
```

Scoped Biome check/format passed (11 existing non-null assertion warnings and one
existing redundant-catch informational notice in services tests/catalog compiler).
Independent technical review caught omitted primary username during rotation;
the adapter now sends the persisted username, with regression coverage. Real
isolated testing then exposed SFTPGo omitting zero `expiration_date`; decoding now
uses its zero/no-expiry meaning and the rerun passed. The first failing test left
one fixture account, subsequently removed after exact ID/marker/root verification;
all test connections and directories were cleaned. No retained-transport regression
was presented as a pass; issue #18 remains a separate production-release gate.

The initial dev UI smoke failed with session HTTP 500 during source/schema
activation. A fresh read-only authentication/schema check passed; after the
existing watcher reloaded, the real Firefox UI smoke passed without page errors.
The original exception was unavailable; its cause is not conclusively attributed.
No explicit container restarts, Pterodactyl changes, game-server operations or
live SFTP password rotations occurred. New primary issuance is left to the Owner.

Reviewed sanitized screenshots: [English desktop](screenshots/m5/sftp-primary-desktop-en.png),
[Italian mobile](screenshots/m5/sftp-primary-mobile-it.png).
Independent technical and visual/content review: no remaining must-fix findings.
PR #21 remains open/unmerged; this does not declare the whole M5 complete.

Final indexed governance passed: 940 text files, 346 review PNGs, 772 relative
links, four TOML files and 44 ignore cases; secret scanning remains heuristic.
`git diff --cached --check` passed. Dev API, worker, Vite and public SFTPGo service
were all running/healthy at handoff.

### 2026-10-14 — Compact SFTP table and revoked filter

Refined the SFTP tab around Fileman/Console spacing and quiet icon actions. Host
presentation and clipboard values include `sftp://` (IPv6 hosts are bracketed);
port stays separately copyable. Additional accesses are an always-visible table
with separate name, username, status, expiry and action columns. Revoked rows are
hidden by default and shown with an accessible switch; filtering is entirely local
and does not change quota counts. Pending and expired entries remain visible.
Primary credential, password delivery and confirmation contracts are unchanged.

Focused verification:

- `scripts/dev.sh pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/sftp-ui.browser.test.ts`: **8 passed**, including copied URI, keyboard filter, immediate removal after revocation, capacity accounting, errors, secrets, EN/IT desktop/mobile and axe checks.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed.
- `scripts/dev.sh pnpm i18n:compile` and `scripts/dev.sh pnpm i18n:check`: passed, 1684 EN/IT/pseudolocale keys.
- Scoped Biome and `git diff --check`: passed (services browser test retains three pre-existing non-null assertion warnings).
- Read-only Firefox smoke against running dev: passed, no page errors. Activated through existing Vite HMR; no container restart, credential mutation, game-server action or infrastructure change. No backend suites repeated for this presentation-only change.

Independent technical/accessibility/visual review: no remaining must-fix findings.
Reviewed fixture screenshots: [desktop](screenshots/m5/sftp-table-desktop-en.png),
[mobile](screenshots/m5/sftp-table-mobile-it.png),
[revoked shown desktop](screenshots/m5/sftp-table-revoked-desktop-en.png),
[revoked shown mobile](screenshots/m5/sftp-table-revoked-mobile-it.png).
Issue #18 remains unchanged. Rollback: revert the scoped presentation/catalog/test
change; no database or provider rollback required. PR #21 stays open/unmerged.

### 2026-10-14 — Explicit encrypted SFTP password recovery

Owner-approved change: passwords can be shown/copied again by their issuing user.
The existing context-bound encrypted intent already retained the current password;
no schema migration, password reset or provider mutation is needed. Added strict
`POST /v1/servers/:id/sftp/:credentialId/password` with fresh regular-session and
server-manage authorization, issuing-actor isolation, active/unexpired checks,
serialized rotation/revocation, no-store response and IDs-only audit. Disclosure
performs no SFTPGo/Pterodactyl request or resource admission. Lists remain secret-free.

Primary access exposes inline Show/Hide/Copy; additional accesses reveal into the
existing password panel. Copy fetches a current value without displaying it unless
clipboard access fails. Secrets stay in component memory, never query/browser
storage. Hide cancels pending retrieval; navigation, identity changes and refreshed
permission loss discard secrets. Rotation clears an earlier revealed password.
The previous once-only warning was removed; create/rotate idempotency is preserved.

Validation commands and actual results:

```bash
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/external.integration.test.ts
# 41 passed: legacy/repeated retrieval, latest rotation, serialization, session,
# support/Owner/issuer isolation, state/expiry/envelope validation, audit redaction.
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts -t 'reveals current passwords|keeps support attributable'
# 2 passed, 77 unrelated cases skipped: strict body, no GET, Origin/no-store,
# secrets excluded from logs/list/audit, current rotation and support restrictions.
scripts/dev.sh pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/sftp-ui.browser.test.ts
# 17 passed before final followups; final three changed tests passed separately
# (15 skipped), covering all 18 current cases without repeating unchanged cases.
scripts/dev.sh pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/sftp-ui.browser.test.ts -t 'renders EN/IT|authenticated identity changes|manage permission is lost'
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/services.browser.test.ts -t 'issues, retrieves'
# 1 passed, 19 unrelated cases skipped: real handlers and isolated provider.
scripts/dev.sh pnpm exec tsc --noEmit
scripts/dev.sh pnpm --filter @nickhosting/web typecheck
scripts/dev.sh pnpm i18n:check
# Passed, along with scoped Biome and whitespace checks.
```

Failures and limits preserved: a first integration invocation used system Node20
and was interrupted; final results use the pinned Node24 through scripts/dev.sh.
All descendants of the interrupted process stopped. Its random isolated test
schema ID was not recorded, so possible schema residue cannot be conclusively
identified or cleaned; no guessed/broad cleanup was performed. Completed isolated
runs clean their own schemas. One new support test initially omitted the required
Owner-elevation fixture and was corrected before the passing run. Two browser
tests initially used a dynamic import rewritten by the test runner; corrected
browser evaluation passed. The first services-browser selection matched an old
test name and skipped all cases; the corrected selection is shown above.

The full API integration file was also attempted and is **not a passing full-suite
result**: 69/79 cases failed after an existing ordering defect. The earlier durable
HTTP creation test leaves a GLOBAL_POOL disk=0 server in its shared beforeAll DB;
the next directory-identity test calls a fixture forcing PER_USER_BUDGET, whose
admission rejects that existing unlimited-disk server. Failures begin before the
changed SFTP cases. No unrelated admission/fixture rewrite was undertaken; the
changed API cases pass in isolation. An old >=40-character password assertion in
the SFTP API test was corrected to the established 16-character contract.

Real dev smoke: existing Owner primary password explicitly retrieved via the new
endpoint with no-store, displayed then hidden, with no page errors. No real secret
was logged or captured in screenshots. This adds only the normal disclosure audit
event; no credentials or provider files changed. Initial smoke used a stale
expected hostname; matching the configured SFTP URI fixed the harness assertion.
No containers restarted or infrastructure changed; existing source watchers apply
code. Issue #18 and all production-release restrictions remain unchanged.

Independent security/async review found no authorization or lifecycle blockers.
Its focus-visibility finding was fixed with a subtle keyboard-focus underline
and forced-colors outline, then checked in real Firefox and screenshots:
[English desktop](screenshots/m5/sftp-password-desktop-en.png),
[Italian mobile](screenshots/m5/sftp-password-mobile-it.png).
These contain deliberately fake fixture passwords. Final independent review:
no remaining must-fix findings. Rollback is a scoped source/UI revert, without
migration or password changes. PR #21 remains open/unmerged.

SFTP password layout followup: hidden mask and revealed input now share the same
non-growing 16ch flex basis, retaining shrinkability on narrow screens. Show/Copy
no longer move on reveal. CSS Biome and the existing `sftp-ui.browser.test.ts`
`-t 'renders EN/IT'` check passed (1 passed, 17 skipped), including responsive/axe
and keyboard focus checks. Independent comparison of fresh hidden/shown desktop
and mobile screenshots found no regressions; revealed screenshots above refreshed.
CSS-only, existing HMR, no backend or infrastructure operations.

SFTP password selection followup: clicking or focusing either readonly password
input selects its entire value, including the additional-access/issuance panel.
Scoped Biome, web typecheck and whitespace checks pass. Real Firefox dev smoke
verified full selection after explicit reveal and clearing on hide, without
logging/capturing the secret. Independent diff review: no findings. No provider
mutation/restart; only the regular disclosure audit is written by verification.

### Failed installation retry recovery — 2026-10-14

A terminal failed provision/reinstall could leave an installation reservation
behind after the active operation was cleared, preventing an explicit Reinstall.
Failure now records the incomplete local installation as failed. Reconciliation
releases only the exact failed job's reservation after the existing observer
proves installer and game stopped and fresh owned-provider observations confirm
offline plus installed or an explicit installation failure. Unknown pending
installation, missing evidence and concurrent job/reservation changes retain it.
This does not mark Minecraft installation verified or replay external effects.

Read-only dev diagnosis found a failed provision with a stale installation
reservation. The Owner confirmed manually reinstalling through Pterodactyl after
that failure; a subsequently present JAR alone does not prove why the original
attempt failed. Normal worker reconciliation with this fix changed the local
state to failed and cleared the orphan reservation. API/worker remained healthy;
existing source watchers loaded the change, without a manual restart, migration,
SQL repair or provider mutation. No reinstall/start was performed by the agent;
the Owner can now request Reinstall through the existing authorized/admitted job
flow. No test game servers or infrastructure resources were created or removed.

Validation: full targeted lifecycle integration suite, root/web/test TypeScript
checks and scoped Biome. The first integration run exposed three new fixture
errors (running/queued jobs incorrectly retained completed_at); those fixtures
were corrected, preserving the failure history. Final counts are recorded below.
Independent lifecycle/security review found no remaining must-fix. Coverage
includes explicit retry, unknown/running installations, unavailable evidence,
identity and exact reservation/job ownership, concurrency and ABA changes, and
preserving an already confirmed installation. No UI change or screenshot needed.
Rollback is a source revert; it does not recreate released reservations or undo
an Owner-requested reinstall. PR #21 stays open/unmerged; SFTPGo #18 unchanged.

Final evidence: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec
vitest run --config vitest.integration.config.ts
packages/server-management/src/lifecycle.integration.test.ts` — **225/225 passed**
(197 existing, 28 new; 43.93 seconds), using the existing isolated test stack.
`scripts/dev.sh pnpm typecheck` and scoped `pnpm exec biome check` passed.
`python3 scripts/check-governance.py` passed (952 indexed text files, 353 review
PNGs, 789 relative links, 4 TOML files, 44 ignore cases); staged whitespace passed.
Historical full M1–M5 suites were not rerun for this targeted recovery fix.

### Gateway activation after recovered provisioning — 2026-10-14

Follow-up to failed-installation retry: an initial failed provision left its route
reserved but disabled. A later successful Reinstall and Start did not finish that
initial registration. Normal reconciliation now recovers the original untouched
route plan after verified installation and successful explicit reinstall, reusing
the existing activation/configuration logic. It preserves Owner edits/deletions,
prior activation, existing policy and active operations. A later confirmed explicit
Start/Restart can restore its missing waking transition; normal readiness evidence
is still required. Original failed-job chronology is preserved. A candidate check
avoids recovery query chains for ordinary healthy servers. No new provider requests,
API, schema, listener configuration or UI controls are introduced by recovery.

Live dev verification: the affected server was already installed and running.
A passive legacy FE01 query to its backend returned protocol 61, version 1.5.2 and
the real MOTD. Existing worker hot reload/reconciliation enabled the reserved route
and the Gateway independently reached online. The same passive query through the
Gateway public endpoint returned the actual backend response. No login/wake test,
power command, reinstall, game-file edit, manual DB repair, migration, container
restart or new test asset was performed. This proves local-host forwarding/status,
not a remote player's full login or Internet/router reachability. Existing unrelated
Gateway routes with backend_active_binding failures remain outside this fix; global
Gateway health must not be represented as fully healthy from this server's success.

Rollback: scoped source revert; already recovered route state remains durable and
must not be silently disabled or reverted. PR #21 remains open/unmerged and the
SFTPGo #18 production-release gate is unchanged. Test/review results follow below.

The initial focused run exposed a stale fixture provider-user identity and fake
historical timestamps older than the provision job; fixture data was corrected,
without relaxing production identity or chronology checks. The focused suite then
passed 31/31. Two final concurrency cases were added before the combined run.
Independent review: no remaining must-fix, including later Stop preservation,
Owner edits at PostgreSQL timestamp precision and missing/extra routes. Full
`scripts/dev.sh pnpm typecheck`, scoped Biome and staged governance/whitespace checks
passed. No historical full M1–M5 matrix was rerun.

Final combined validation: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2
pnpm exec vitest run --config vitest.integration.config.ts
packages/server-management/src/gateway-provision.integration.test.ts
packages/server-management/src/lifecycle.integration.test.ts` — **258/258 passed**
(33 Gateway provisioning tests, including 20 new; 225 lifecycle tests; 55.76s).

### Inherited sleep policy on generated Gateway registrations — 2026-10-14

Generated Gateway policies previously stored enabled=false, silently preventing
inherited idle timeouts from taking effect. New registrations now enable supported
automation through the existing compiled binding. Normal reconciliation repairs
only old generated defaults with original activation provenance, unchanged policy
shape and no explicit policy-update audit (including no-op disables). It preserves
intent, generation and valid observations; no new provider request or duplicated
idle detector is added. Timeout -1 still disables sleep only; missing player counts,
manual stops, maintenance and explicit policy changes remain authoritative.

Read-only dev evidence: the affected 1.5.2 server inherited global timeout of 60 seconds with no
explicit policy-update audit. Existing source watchers/reconciliation repaired its
generated flag. A subsequent observed explicit Stop job had succeeded; the server
remained offline/manually_stopped with automation enabled. No agent-issued start,
stop, reinstall or manual DB repair was performed. A new real idle cycle remains
for the Owner to exercise after starting the server. No migrations, manual container
restarts, new test assets or production configuration changes. Rollback is a scoped
code revert; reconciled policy flags remain durable and must not be blindly reset.
SFTPGo #18 unchanged; PR21 remains open/unmerged. Validation results follow below.

Independent review found no must-fix. Coverage includes inherited 60-second sleep after
fresh zero-player observation, -1, unknown player count, explicit/no-op disable,
overrides, missing provenance and lifecycle generation changes. The compiled 1.5.2
binding declares sleepWake; Alpha without status/player counts remains wake-only.
An initial focused run passed 43/44: the remaining fixture incorrectly represented
unknown playerCount as null instead of omission; only the fixture was corrected.
Full root/web/test TypeScript checks and scoped Biome passed. Final suite counts
and staged governance are recorded below; no full historical matrix rerun.

Final evidence: combined command `scripts/dev.sh pnpm exec tsx scripts/test-env.ts
--m2 pnpm exec vitest run --config vitest.integration.config.ts
packages/server-management/src/gateway-provision.integration.test.ts
packages/server-management/src/gateway-minecraft.integration.test.ts
packages/server-management/src/lifecycle.integration.test.ts` returned 277 passed,
1 failed because it had already loaded that pre-correction fixture. Lifecycle
passed 225/225 and Minecraft binding passed 9/9. Rerunning only
`gateway-provision.integration.test.ts` with the same command prefix after the
fixture correction passed 44/44 (21.41s). Final per-suite evidence covers 278 tests;
this is not reported as a single clean combined run. Staged governance and
whitespace checks passed. No remaining review findings.

### Automatic personal SFTP access — 2026-10-15

Personal primary credentials are now reconciled from current server-manage
permissions, without opening the SFTP page or clicking Generate. Creation uses
shared encrypted pending intents, existing server locks/unique primary reservations
and the existing SFTPGo adapter. Service authority records a subject without a fake
interactive session; password disclosure/rotation remain account-scoped interactive
operations. Existing primaries are reused, auxiliary creation stays manual, and
permission loss/deletion use existing revocation. Missing configuration/provider
outages defer SFTP independently of game installation. In-memory scheduling cursors
provide bounded fair retries; durable desired state and encrypted intents remain in
PostgreSQL and survive worker restarts. No new migration or scheduler service.

The worker now continues pending external cleanup when the last server has been
deleted. The UI removes manual primary creation and polls preparation via secret-free
GETs, retaining configuration errors and uncertain state. Real Firefox fixture tests
exercise missing→pending→active without issuance POSTs, EN/IT desktop/mobile,
password controls, permission/support boundaries and accessibility. Sanitized
[screenshot](screenshots/m5/sftp-automatic-pending-en.png) independently reviewed:
compact state, no clipping or misleading success, no UX must-fix.

Live dev: existing source watchers applied changes without manual restart. Read-only
DB/audit verification found three automatically issued service-primary credentials,
all active, alongside the preserved pre-existing primary. Service audit actors are
null with the account as subject; no secrets were read/logged for this verification.
API and worker were healthy. No game creation, power, files, membership changes or
production infrastructure modifications. Only requested personal SFTP provisioning
occurred through the regular worker. No live destructive permission-loss test was
performed; those cases use the isolated database and provider fixture. SFTPGo #18
still limits retained SSH transports; automatic revocation is not a security pass.

Rollback must retain the new service-authority envelope reader for credentials
already issued automatically; blindly reverting to the old reader would prevent
recovery/reveal of those intents. Disable automatic issuance in code while retaining
reader/revocation support if rollback is needed. Do not delete encrypted credentials
or rotate existing passwords as cleanup. No new infrastructure/test servers created.

Completed checks: `scripts/dev.sh pnpm typecheck`; scoped Biome; isolated worker
`reconcile.integration.test.ts` 2/2; real Firefox `sftp-ui.browser.test.ts` 18/18
(71.52s), including EN/IT screenshots and accessibility cases; catalog compilation
1686 keys. Governance passed (952 indexed text files, 354 PNGs, 790 relative links,
4 TOML files, 44 ignore cases), as did staged whitespace. Independent technical
and screenshot/content review found no implementation must-fix.

The first existing external-service integration run passed 34/41. Seven expectations
still assumed reconciliation never created additional primary credentials (old
counts/list ordering); those assertions were updated to identify original
credentials explicitly and account for the new automatic primary. Final targeted
rerun outcomes are recorded below, without presenting this as a clean full run.

Final backend rerun: `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec
vitest run --config vitest.integration.config.ts
packages/server-management/src/external.integration.test.ts` with a name filter for
the seven affected legacy cases and eight new automatic-primary cases passed 15/15,
34 skipped (43.83s). The other 34 passed in the preceding full-file run, giving 49
passing cases across runs; no remaining failures. Final backend typecheck/Biome and
independent review of the adjusted assertions passed. No unrelated historical suite
was repeated. PR21 remains open/unmerged.

### Owner settings schema HTTP 500 — 2026-10-15

The legacy Minecraft idle-policy key normalization added a Zod transform. The Owner
settings schema endpoint incorrectly serialized the output schema, which cannot
represent transforms, causing HTTP500 before the form rendered. It now describes
the input schema (`io: 'input'`); runtime validation/normalization and saved settings
remain unchanged. Independent review confirmed this narrowly scoped correction.

The existing authenticated API regression passed (1 passed, 5 skipped) via
`scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config
vitest.integration.config.ts apps/api/src/web-session.integration.test.ts -t
'exposes only Owner configuration schemas'`. It verifies Owner200, ordinary-user403,
retained bounded idle-timeout schema and the existing settings/reset guards. Scoped
Biome passed. Existing dev watcher reloaded API; no manual restart, migration,
configuration reset or DNS/provider write. Rollback is a two-file source revert,
which would restore the broken form; no state rollback needed. DNS development
remains paused pending Owner approval.
Root `tsc --noEmit`, staged governance and whitespace checks also passed.

### Development Cloudflare credential opt-in — 2026-10-15

Added `NH_DEV_CLOUDFLARE_ENABLED=true` for explicit real-provider development.
It removes only the placeholder Cloudflare token environment override so the
Owner can save the real token through the existing encrypted secret store.
Default sandbox/real-dev behavior and production remain unchanged; invalid or
sandbox opt-ins fail. No credentials are included in images or frontend code.

Validation: `scripts/dev.sh pnpm exec vitest run scripts/deployment-config.test.ts`
passed 46/46; scoped Biome, Compose `config --quiet`, whitespace and governance
checks passed. Independent configuration/security review found no must-fix issues.
Read-only dev inspection confirmed API/worker healthy, no published host ports,
zero DNS assignments and no stored Cloudflare token. No DNS writes or test assets.
Activation requires the documented scoped API/worker rebuild/recreation; approval
was requested with exact commands, private-env backup and previous-image rollback.
Until activation, the running environment still reports the token as environment
managed. No live Cloudflare connectivity claim is made.

Activation subsequently approved and completed. Image
`sha256:08e7e080d1f89b3b2e143e2dbb100fa14057d142041a851bd6f75f5664b98e3b`
built; only API/worker recreated. The first command exposed a pre-existing mismatch:
the private COMPOSE_FILE selection omitted the viewer/user-SFTP overlays present
in the running containers. Restored that complete selection and recreated the
same two services with the existing additional private env files, preserving SFTP
opt-in. No SFTP container was removed/restarted. Previous image retained as
`nickhosting-dev-app:before-cloudflare`, private env backup retained locally.

Final read-only checks: API, worker and both SFTP services healthy, restart count
zero; HTTPS ingress 200. Cloudflare credential is configured, database-sourced,
unlocked; all four DNS settings are present. Owner supplied the token interactively.
Cloudflare token verification and scoped zone DNS-record listing returned HTTP200,
success=true. No token or record contents were logged. No DNS writes, migrations,
game-server operations, new test resources or production changes. Existing #18
production-release boundary remains unchanged.

### Integration-defined server subdomains — 2026-10-15

Implemented personal generated/custom names, shared configurable/fixed integration
hostnames, multiple eligible domains, integration allow/deny policies and an
initially empty Owner blacklist. Automatic naming has 262,144 candidate combinations
with transactional uniqueness reservations. Preview pins the proposed name; rename
publishes replacement records before retiring owned old records. Shared records
have integration lifetime. Existing servers require explicit activation; creation
stores the new server's address preference for worker reconciliation.

Validation used focused suites, not the full historical M1–M5 matrix:

- `scripts/dev.sh pnpm exec vitest run packages/core/src/dns-policy.test.ts
  packages/core/src/core.test.ts packages/game-sdk/src/ui.test.ts`: 67 passed;
  final DNS-policy-only rerun 7/7 after adding incomplete-domain filtering
  (68 distinct cases across these runs).
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run
  --config vitest.integration.config.ts` with targeted files/name filters:
  existing external-service suite 49/49; new DNS cases 11/11 across targeted runs;
  platform connection 2/2; worker/health 4/4. Covers foreign-record isolation,
  cross-zone rename, shared-host target changes/lifetime, failed-intent cancellation,
  reservation recovery and legacy-zone recovery.
- Same integration runner with registry/API files and
  `-t 'DNS choice|DNS connection choices'`: 2 passed, 103 skipped. Confirms
  idempotent creation intent, scoped options and no zone-secret disclosure.
- Provider unit tests 23/23; Minecraft UI 13/13; connection contracts 3/3.
- Firefox domain browser suite: seven scenarios passed across focused runs,
  including EN/IT, 390px mobile, keyboard, axe, pinned previews and recovery with
  an older active address. Browser API responses are isolated fixtures.
- Final `scripts/dev.sh pnpm build`, `typecheck`, `lint`, `format:check`,
  `i18n:check`, staged governance and whitespace checks passed. Lint retains 37
  warnings/two informational diagnostics in existing code; build retains the
  existing large-chunk warning. Catalogs contain 1,719 keys.

Initial new tests exposed a JSONB key-order comparison defect and fixture mistakes;
these were corrected and affected checks rerun. Mobile layout/keyboard scrolling
findings were also corrected. Final typecheck caught an inferred test environment
object missing an optional key; explicit ProcessEnv typing fixed it, then typecheck
was repeated. No failed attempt is counted as a passing full-suite run.

Independent backend/security and rendered UX/content review found no remaining
must-fix findings. Sanitized fixture screenshots:
[Connection EN](screenshots/m5/domains-en.png),
[Connection IT/mobile](screenshots/m5/domains-it.png),
[Owner domains](screenshots/m5/domains-owner-en.png).

Migration032 was explicitly applied only to the existing development database,
preserving accounts/settings/data; source watchers loaded the implementation.
Worker briefly failed while the new tables were absent and then on an undeclared
import; migration and use of the existing query builder resolved these during
integration. Final API/worker/Vite healthy with restart counts zero; HTTPS200.
No manual container restart, Pterodactyl/Wings mutation, game-server creation,
network change or real DNS write occurred. Real Cloudflare token verification and
zone listing from the preceding activation remain read-only evidence. The exact
create/rename/delete smoke test with temporary owned DNS names awaits separate
operation-specific confirmation; no live publication success is claimed yet.

Limits: changing an existing shared host's zone ID fails closed, and retired shared
hosts are retained for existing connections. Removing a selected domain before a
new server's first DNS intent leaves it pending until configuration is restored or
an explicit replacement is submitted. Issue #18 remains a production-release gate.
Rollback preserves migration032 and all DNS intents/ownership ledgers: stop DNS
reconciliation before reverting to code that cannot interpret v2/shared intents;
restore compatible code rather than dropping tables or broadly deleting records.
PR21 remains open/unmerged; no M6 implementation or production deployment.

### Dedicated address step, availability and wizard holds — 2026-10-15

Minecraft's common SDK address step now follows version selection, before operators.
The final summary no longer contains its editable address form. Valid custom labels
are checked after 600ms idle; blank labels retain automatic naming. Next acquires a
15-minute account/game-bound database hold, carried atomically into creation.
Replacement, expiration and creation retry preserve the existing ownership model.
No provisional DNS records are written. Backend availability uses exact Cloudflare
hostname/SRV queries, bounded coalescing/cache and a conservative per-process budget;
429 responses apply Retry-After cooldown without automatic retry loops.

Focused validation (not a full historical milestone-suite rerun):

- `scripts/dev.sh pnpm exec vitest run packages/game-sdk/src/ui.test.ts
  games/minecraft/src/ui/ui.test.ts`: 25 passed.
- `scripts/dev.sh pnpm exec vitest run games/minecraft/src/ui/ui.test.ts
  apps/web/src/features/connection.test.ts`: 17 passed (overlaps the previous run).
- Browser runner with `apps/web/tests/domains.browser.test.ts`, filtered to
  `debounces availability|ignores late|renders the SDK`: 3 passed; mobile
  `keeps the address step`: 1 passed. Covers stale responses, held-name reuse,
  replacement, expired holds before Create, automatic naming, EN/IT, keyboard and
  mobile axe (zero violations).
- Isolated integration runner with `packages/server-management/src/registry.integration.test.ts
  -t 'DNS choice'`: 1 passed, 24 skipped. Verifies token ownership, no-token bypass
  rejection, expired-hold rollback, successful transfer and idempotent replay.
- Availability/provider unit suites: initial 30 passed; final cache/HTTP/presence
  subset 8 passed after an additional record-shape regression (existing provider
  suite 23 passed). Focused DNS wizard/worker integration: 5 passed, 63 unrelated
  cases skipped; covers local/foreign claims, coalescing,
  concurrent accounts, bounded holds, replacement rollback, automatic assignment
  transfer and deleted-server cleanup.

Read-only real Cloudflare smoke through the actual adapter and configured private
credentials: two exact-name GETs (hostname plus Minecraft SRV), both unoccupied,
516ms combined. No writes, no record/test-server creation, no record contents or
credentials logged. This verifies read connectivity, not real DNS publication.
Migration033 extends the existing hostname registry with wizard identity; after its
application, FK cleanup was added in separate migration034 rather than rewriting an
applied migration. Both applied only to the existing development database; data and
accounts preserved. API/worker/Vite healthy, restart counts zero; ingress HTTPS200.
No manual restart, Pterodactyl/Wings, production network or Cloudflare modification.

Screenshots reviewed:
[Address EN](screenshots/m5/address-wizard-en.png),
[Address IT/mobile](screenshots/m5/address-wizard-it-mobile.png).
Rollback must retain migrations and owned claims; older code that ignores wizard
holds must not continue accepting custom-name creation. Let temporary holds expire
or restore compatible code; do not drop the reservation registry. The hold prevents
NickHosting races, not manual/external Cloudflare changes. The preview quota is not
a distributed account quota; other applications/replicas remain independent users
of Cloudflare capacity. Issue #18 and all production-release boundaries are unchanged.

Final API regression `apps/api/src/servers.integration.test.ts -t 'protects DNS
availability'`: 1 passed, 80 skipped; session/Origin rejection and Retry-After
propagation covered on both routes. Independent review found a concurrent
unreserved INSERT could return a raw unique-constraint failure; it now returns a
controlled conflict, covered by a targeted concurrency test. A final creation
rerun verifies the consumed domain choice is persisted consistently. The initial
lint attempt caught formatting while backend edits were still underway; fixed
before final checks. Final build, root/web typecheck, lint, format, i18n and staged
governance/whitespace checks passed (existing warnings retained). Catalogs contain
1,729 keys. Independent source/security and rendered UX review has no remaining
must-fix findings. PR21 remains open/unmerged.

### First live DNS assignment recovery and hostname-only presentation — 2026-10-15

An Owner-requested existing-server assignment returned integration_unavailable and
remained uncertain. Read-only inspection showed an empty ledger and no matching
records. The zone is Cloudflare Free: our ownership comment was 122 characters,
exceeding its documented 100-character limit. New markers are 79-character versioned
SHA-256 digests of the exact validated ownership tuple; exact legacy markers remain
recognized, with all identity/content/ledger checks retained. Provider fixtures now
enforce the real Free-plan limit. Source hot reload allowed normal reconciliation
to complete the Owner's existing request; no manual create/retry was issued.
Read-only verification subsequently confirmed active state, two ledger entries and
matching owned A/SRV records. This is actual publication evidence, unlike the prior
empty-name read-only probe.

DNS-mode DTOs and Console no longer fall back to a raw IP before first confirmed
publication. Pending/uncertain state is shown instead; rename keeps the previously
confirmed hostname. Secondary ports only reuse that hostname when their public host
matches the primary DNS transport's endpoint; different-host roles remain without a
presented address. Explicit static-host integrations preserve their address contract.

Independent review retained strict marker ownership and identified the multiport
host/transport edge, which was corrected and covered by regression tests.
Validation: provider/HTTP 28 passed; targeted platform connection regressions and
Network/Console browser coverage recorded below. Initial expanded fixture errors
(column name and JSON typing) were corrected before final reruns.

Important deployment finding: Cloudflare's configured zone currently reports
`moved`; public recursive DNS still delegates to another provider and resolves the
new label to that provider's parking wildcard. The host's local authoritative DNS
instead returns NXDOMAIN. A successful owned Cloudflare write does not establish
public or local reachability. No registrar, nameserver delegation, Bind9, NPM,
Pterodactyl/Wings or network configuration was changed. The two records complete
the Owner-requested server address and are retained, not disposable test assets.
DNS delegation/local resolution require separate Owner work/approval. Issue #18
and production-release boundaries remain unchanged.

Rollback: new code reads both exact legacy and compact markers. Do not revert the
provider to legacy-only matching after compact records exist; retain the compatible
reader or restore compatible code. Do not delete records or reservation state to
roll back UI presentation. PR21 stays open/unmerged.

Final focused results: three platform connection cases passed across targeted runs
(one expanded DNS-mode regression plus retained static/direct cases); one real
Firefox Network/Console regression passed. Root and web typechecks, production
build, scoped Biome, 1,731-key i18n check, whitespace and staged governance passed.
Independent final review found no remaining must-fix. API/worker remained healthy;
no manual container restart or migration was needed.

Sanitized Firefox fixture screenshots: [Network uncertain address](screenshots/m5/dns-unavailable-network.png)
and [Console address summary](screenshots/m5/dns-unavailable-summary.png).
The latter exercises the actual summary component, not the full Console shell.
Cloudflare documents the Free-plan comment limit in its
[record attributes reference](https://developers.cloudflare.com/dns/manage-dns-records/reference/record-attributes/).

### Console address card — 2026-10-15

The authoritative address is now a compact copy button with custom full-address
tooltip, temporary success checkmark and accessible feedback. A separate edit
icon links to Connection settings even while publication is pending/unavailable.
Long names truncate without overflowing the card; no raw-IP reconstruction or
reachability badge was added. Clipboard rejection remains visible and actionable.

Three focused Firefox tests passed (11 unrelated tests skipped), covering clipboard success/failure, keyboard access, edit URL,
EN/IT mobile truncation and existing pending/uncertain hostname-only states.
Web typecheck, scoped Biome, i18n completeness (1,734 keys) and staged governance
passed. Independent source/accessibility/content and rendered-screen review found
no must-fix. These are actual React components with isolated API/clipboard fixtures,
not evidence of live DNS resolution. No infrastructure or DNS operations were needed;
the previously recorded delegation/local-DNS blocker remains unchanged.

Screenshots: [Desktop EN](screenshots/m5/console-address-en.png),
[Mobile IT](screenshots/m5/console-address-it-mobile.png).
Rollback is a source revert; backend address semantics and DNS records are unchanged.

Connection table follow-up: added the localized Port column between Transport and
Status. It displays the existing public `port` contract, not a backend allocation;
missing values remain unavailable. Scoped Biome and web typecheck passed;
independent read-only contract review found no issues. No backend or infrastructure
changes.
The existing DNS-state Firefox regression passed (1 passed, 13 unrelated skipped);
its Network screenshot above was refreshed and reviewed with the added column.

Owner UI follow-up: removed the State column from the ports table, leaving Role,
Address, Transport and Port. DNS assignment feedback remains above the table.
Scoped Biome/whitespace and independent diff review passed; no backend changes.
Existing Firefox DNS-state test passed (1 passed, 13 unrelated skipped); screenshot
refreshed and reviewed with the four-column layout. No infrastructure operations.

### Shared binary viewer credential regression — 2026-10-16

Frame, Wave, Motion, Atlas, SQLite Datagrid and Folio failed together with HTTP400
`validation_failed`. Personal SFTP's shared password generator had changed from
43 to16 URL-safe characters; both the private viewer issuance adapter and SSH pool
still required32. Text viewers used a different read path and remained functional.
The pre-fix adapter suite reproduced this with10/10 failures.

Aligned both validators to the existing16–128 character SFTP contract. Generated
passwords use12 cryptographically random bytes (96bits), and old longer passwords
remain accepted. Existing encrypted pending intents recover through normal issuance,
without changing identity, rotating credentials or migrating state. The dedicated
read-only viewer namespace, expiry, exact server root, host-key verification and
filesystem protections remain unchanged.

Focused tests: `scripts/dev.sh pnpm exec vitest run
packages/external-services/src/viewer-sftpgo.test.ts
packages/external-services/src/viewer-sftp.test.ts` —30 passed. Includes actual local
SSH reads with generated passwords, legacy43-character credentials, idempotent
recovery and rejection of invalid inputs before external calls. Scoped Biome and
independent review passed with no must-fix findings.

Live dev authenticated read smoke on existing dataset: Frame/Wave/Motion/Folio
returned206 and1024 bytes each; Atlas archive listing200; SQLite Datagrid200.
This verifies backend transport/parser recovery, not a fresh full browser matrix.
The existing source watcher loaded the fix; no manual container restart, migration,
game-file write or Pterodactyl/Wings change occurred. No disposable assets created.
Issue18 remains unchanged. Rollback must keep validators compatible with existing
16-character intents; reverting only their minimum would reproduce the failure.

### Personal settings tabs — 2026-10-16

Settings now separates Profile (`/settings`) from Security (`/settings/security`)
using the server navigation style. As requested by the Owner, linked accounts stay
in Profile alongside name, username, language and email. Security retains password,
TOTP/recovery, passkeys and sessions. Existing identity handlers and permissions are
unchanged. Session/passkey lists load only in Security; the account query is shared.
The layout retains in-progress TOTP setup in memory across tab navigation only.

Focused verification uses the actual application and authentication handlers with
an isolated disposable PostgreSQL schema, a virtual WebAuthn authenticator, and the
existing Discord provider fixture. Six selected account/linking browser journeys
passed. Coverage includes keyboard tab navigation, direct Security reload, browser
history, preserved authenticator setup, recovery login, EN/IT profile edits, both
account-link directions, rejected account linking, and mobile reflow. Axe found no
violations in the checked Profile/Security screens. Screenshots were recaptured
after waiting for account lists and resetting scroll/focus; no product change was
needed for capture artifacts. The targeted account subset passed again (four tests).

The initial run stopped on stale registration fixtures using the old Name label
and omitting the required Username; these test inputs now match the existing UI.
The earlier layout run also predated the Owner's move of linked accounts to Profile.
Neither failure is reported as a security pass. No full historical suite was run.

Web typecheck, production build, scoped Biome, i18n completeness (1846 EN/IT keys
plus pseudolocale), whitespace and indexed governance passed. Existing build
chunk-size and scoped style/test lint warnings remain; no new lint errors.
Independent source, accessibility and rendered-screen review found no must-fix
findings. Reviewed fixture-only screenshots:
[Profile desktop](screenshots/m5/settings-profile-desktop-en.png),
[Profile mobile](screenshots/m5/settings-profile-mobile-it.png),
[Security desktop](screenshots/m5/settings-security-desktop-en.png),
[Security mobile](screenshots/m5/settings-security-mobile-it.png).

The existing dev source watcher supplies the change; HTTPS for the Security route
returned200. No container restart, migration, external-provider mutation, DNS
change or game-server/test-asset creation was needed. Disposable browser schemas
are closed by the existing harness. Issue18 and all production-release gates stay
unchanged. Rollback: revert this UI commit; no data rollback is necessary.


### Desktop sidebar collapse — 2026-10-16

The sidebar now collapses from 224 to 64 px using its header toggle. Stable icon
positions, fading single-line labels and a 200 ms width transition keep the layout
coherent. The browser remembers this display preference across reloads and area
changes. Compact navigation has accessible names, active markers and shared
tooltips. Reduced motion disables transitions. Mobile keeps its full-label menu;
existing routes, authorization and topbar administration access are unchanged.

Focused validation:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run
  --config vitest.browser.config.ts apps/web/tests/sidebar.browser.test.ts`:
  five passed. Actual application/auth handlers with isolated disposable schemas;
  keyboard toggle/focus, reload persistence, ordinary/Owner navigation, active
  links, tooltips, short-window scrolling, rapid toggles and mobile resize covered.
  Axe and viewport-overflow checks passed on the sampled screens.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`: passed.
- `scripts/dev.sh pnpm --filter @nickhosting/web build`: passed; existing large
  bundle warning remains.
- Scoped Biome and `scripts/dev.sh pnpm i18n:check`: passed (1848 EN/IT keys plus
  pseudolocale). Indexed governance and whitespace checks passed before commit.

Independent source, accessibility and screenshot review found no must-fix issues.
Reviewed real-browser fixture screenshots:
[compact personal](screenshots/m5/sidebar-collapsed-personal-desktop-en.png),
[compact Owner](screenshots/m5/sidebar-collapsed-owner-desktop-en.png),
[expanded Owner](screenshots/m5/sidebar-expanded-owner-desktop-en.png),
[Italian mobile](screenshots/m5/sidebar-open-mobile-it.png),
[short desktop](screenshots/m5/sidebar-short-desktop-en.png).

Only the existing dev source watcher is needed. No container restart, migration,
production/provider mutation or game-server asset creation; the browser harness
cleans its disposable schemas. No historical full-suite rerun. Issue18 remains
unchanged. Rollback: revert this UI commit; no server data rollback is required.


### Uploaded profile photo — 2026-10-16

Profile now accepts PNG/JPEG/WebP up to 5 MiB with a circular crop preview,
keyboard/pointer positioning and zoom. Only a 256 px PNG thumbnail is uploaded;
original files stay in browser memory. The shared avatar updates in Profile,
topbar and account menu, supports removal and uses a local silhouette fallback.
Discord images do not overwrite the uploaded photo. Save failures retain the
previous photo; pending saves freeze dismissal and crop controls. English/Italian
copy, focus return and mobile layout are included.

The authenticated API normalizes bounded noninterlaced RGB/RGBA PNG input, strips
ancillary metadata and stores at most 300 KiB in the dedicated photo table with an
atomic audit entry. Reads are private/no-store and limited to the actor/effective
subject; writes require a regular self session and the existing Origin checks.
No external image URL, raw original, photo bytes in session responses or browser
storage is introduced. Contracts: [M5 API](M5-API-CONTRACTS.md).

Focused final evidence:

- `scripts/dev.sh pnpm exec vitest run apps/api/src/profile-photo-image.test.ts
  apps/web/src/features/profile-photo-crop.test.ts`: 12 passed (9 parser/encoder,
  3 crop geometry).
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 bash -c
  'cd .codex/local/profile-photo-worktree && scripts/dev.sh pnpm exec vitest run
  --config vitest.integration.config.ts apps/api/src/profile-photo.integration.test.ts
  apps/api/src/web-session.integration.test.ts'`: 16 passed. Actual authentication,
  Origin, support-session rejection, foreign/old-revision read denial, replacement,
  removal, byte limits, audit rollback and identity-provider image independence.
- The same isolated wrapper with `--config vitest.browser.config.ts
  apps/web/tests/profile-photo.browser.test.ts`: 6 passed across Chromium/Firefox.
  Actual application/API/auth and disposable DB schemas; external providers are
  fixtures. PNG/JPEG/WebP, keyboard crop, pending-save race, save/reload/remove,
  malformed/oversize input,503 recovery and Italian mobile reflow are covered.
  Axe found no violations in the sampled Profile and crop screens.
- `scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm build` and
  `scripts/dev.sh pnpm i18n:check`: passed (1863 EN/IT keys plus pseudolocale).
  The existing large-bundle advisory remains. Scoped Biome, whitespace and indexed
  governance passed. No full historical M1–M5 suite rerun was required.

Initial browser run: 2 passed/4 failed. One malformed-file fixture exercised the
format rejection instead of decoding; it was replaced by a correctly typed,
truncated PNG. Firefox exposed an actual 400: its canvas adds a `deBG` ancillary
chunk. The normalizer now discards all ancillary chunks without interpreting or
decompressing them; structure, critical chunks, APNG, CRC and bounded inflate
checks remain. The targeted pending-request test also needed to wait for the
continued PUT response before removing its interception. All final browser tests
passed; these earlier failures remain recorded rather than reclassified.

Independent source/security, accessibility and rendered-screen review found no
remaining must-fix findings. Reviewed fixture-only screenshots:
[crop desktop EN](screenshots/m5/profile-photo-crop-desktop-en.png),
[profile/menu desktop EN](screenshots/m5/profile-photo-desktop-en.png),
[profile mobile IT](screenshots/m5/profile-photo-mobile-it.png).
This focused review is not a complete WCAG audit.

Prepared in an isolated worktree so live development remains on its previous
source/image. **At preparation, activation awaited specific Owner approval; it is now completed below.** Read-only dev
inspection found migrations through 034 applied: the normal runner will apply
existing 035 (generic content policy) and new 036 (photo table). Both are explicitly
included in the [activation proposal](M5-ENVIRONMENTS.md#profile-photo-activation-proposal--2026-10-16).
No live database/schema/profile, container, network, game file or external provider
was mutated. Disposable test schemas are cleaned by the harness; no game assets
were created. Issue18 and production-release boundaries remain unchanged.
Rollback retains additive schema/photo data and restores the prior application
image/source; no database reset or automatic restoration of a backup.


#### Profile photo approved activation evidence

Owner approval was received and the exact feature `fad8e43` activated. The Docker
`development` image built successfully; only API/worker were stopped/recreated.
The verified private DB backup precedes transactional migrations 035/036, both
applied successfully. Post-migration identity/secret/rollout fingerprints, managed
server count and expected content-settings conversion matched their baselines.
No data reset or real profile upload was performed by tooling.

API/worker are healthy with zero automatic restarts, unchanged mounts/networks and
no published ports. Vite remained running and connected via WSS. The targeted live
Firefox smoke passed: HTTPS login 200, web config 200, unauthenticated photo 401,
no browser JS errors or HTTP 5xx. This complements the earlier authenticated
isolated tests; those suites were not needlessly repeated during deployment.

The first inventory comparison flagged restart counters of three unrelated
containers. Their preflight state already showed restart loops; identity/image/
configuration comparisons were unchanged, and no command targeted them. This was
an overly strict observation check, not a regression requiring infrastructure
changes. Gateway and unused-provider unhealthy statuses also predate activation.
The final evidence records these limits instead of claiming every host service is
healthy. The migration container is absent; private recovery artifacts are retained.
See [completed activation](M5-ENVIRONMENTS.md#profile-photo-activation-completed--2026-10-16).

Independent activation review checked the scoped plan and final evidence. No
remaining feature blocker; the Owner can upload their photo in Settings → Profile.
No game test assets, provider writes, production changes or new release permission.

### Profile settings visual and interaction refinement — 2026-10-16

Profile now uses one compact surface with photo/name/@username at the top,
aligned editable fields, an email summary and linked-login rows. Email changes
and adding an email login open inline on request. Save stays disabled for
unchanged values; pending requests disable repeat actions, and failures preserve
the draft. Unlink uses the existing confirmation dialog with Cancel initially
focused and retains the last-login-method protection. Existing authentication,
photo, email verification and account-link endpoints are unchanged. Security
keeps its own route and existing behavior. EN/IT copy and responsive layouts are
included without new dependencies or backend changes.

Focused validation (actual browser/application handlers, disposable database
schemas, external OAuth/mail fixtures):

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run
  --config vitest.browser.config.ts apps/web/tests/account-profile.browser.test.ts
  apps/web/tests/profile-photo.browser.test.ts apps/web/tests/discord.browser.test.ts`:
  initial run **14 passed, 3 failed**. Failures were ambiguous test selectors
  matching the Email section and Discord's hidden form label, corrected to target
  the intended controls. The targeted rerun of email changes in Chromium/Firefox
  and explicit Discord linking/unlinking passed **3/3** (8 filtered out).
  All 17 cases are therefore covered by passing results across these runs,
  including all 6 existing photo regressions; this is not claimed as a second
  complete run. The initial run also exposed duplicate sibling React keys in
  the new profile header, corrected with distinct keys.
- A final focused rerun of the unchanged/failed/pending profile-save case,
  `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run
  --config vitest.browser.config.ts apps/web/tests/account-profile.browser.test.ts
  -t 'keeps unchanged profiles'`, passed **2/2** in Chromium/Firefox
  (4 filtered out). It additionally checks the actual focus-border change,
  absence of extra outline/shadow, Tab/Shift+Tab order and absence of React
  key/hook warnings, and refreshes the desktop/mobile screenshots and axe checks.
- Profile coverage includes real name/locale persistence, unchanged and pending
  saves, simulated503 recovery, email cancellation and verification-pending
  behavior, last-login protection, EN/IT and mobile overflow. Axe reported no
  violations in the sampled Profile screens. Discord tests exercise actual
  application linking/unlinking with fixture OAuth and mail delivery.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`,
  `scripts/dev.sh pnpm build` and `scripts/dev.sh pnpm i18n:check`: passed
  (1870 EN/IT keys and pseudolocale). The existing large-chunk build advisory
  remains. Scoped Biome and whitespace checks passed.

Independent source, accessibility and rendered desktop/mobile review identified
an input focus-border override and low control-border contrast; both were fixed
on the existing border, without adding a second outline. Final review found no
remaining must-fix issue. The optional behavior of refreshing a clean form after
an edit in another tab remains as before; it is not an account synchronization
guarantee. Screenshots use fixture identities only:
[Profile desktop EN](screenshots/m5/settings-profile-polish-desktop-en.png),
[Profile mobile IT](screenshots/m5/settings-profile-polish-mobile-it.png).
This focused accessibility review is not a complete WCAG audit.

Only the existing dev source watcher is used. No container restart, migration,
live account/provider mutation, production change or game test asset. Browser
fixtures clean their disposable schemas; no persistent review data is reset.
No historical full-suite rerun. Issue18 remains unchanged. Rollback: revert the
UI commit; no database or infrastructure rollback is required.

### Interactive personal Settings — 2026-10-16

Following Owner feedback, the refinement above is superseded by a change to
interaction as well as layout. The heading/tabs/content are centered at a bounded
width. The identity header replaces the always-open name form: click the name,
Enter or blur to save, Escape to discard. Language segments apply immediately,
save only the locale and roll back the preview on failure. Name and language
updates send independent fields; a concurrent blur/save cannot overwrite the
other preference. The shell adopts changed session preferences/identities without
reverting a local language preview on every render.

The avatar opens the picker and accepts one dropped photo through the existing
validation/crop/upload flow. Multiple-file drops are rejected, and pending uploads
cannot be replaced. Email remains verified through the existing flow. Security now
has contextual password/TOTP controls, passkey naming/removal, recovery-code copy
and readable session rows with confirmed revocation. Existing password, session
revocation and TOTP rules remain authoritative; setup secrets/recovery codes stay
in the layout's memory across tabs. Shared account hooks and icons are reused;
there are no new endpoints, dependencies or migrations.

Focused evidence:

- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run
  --config vitest.browser.config.ts apps/web/tests/account-profile.browser.test.ts
  apps/web/tests/profile-photo.browser.test.ts apps/web/tests/account.browser.test.ts`:
  initial **13/19 passed**. Six failures exposed the changing accessible name of
  the inline name control and the clipped native-radio hit area. Heading/control
  names now preserve the visible user name, tests target the edit action, and
  transparent native radios cover their visible segment. Historical failures are
  retained rather than counted as initial successes.
- The affected-case rerun of `account-profile.browser.test.ts` and
  `account.browser.test.ts`, filtering to inline-name/language plus their
  setup/invitation/security/profile journey prerequisites, passed **8/8** with
  5 unrelated cases filtered out. All 19 distinct cases have passing evidence
  across the two runs; the six photo cases and two email cases were not repeated.
  Exact targeted command:

  ```sh
  scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 scripts/dev.sh pnpm exec vitest run \
    --config vitest.browser.config.ts \
    apps/web/tests/account-profile.browser.test.ts apps/web/tests/account.browser.test.ts \
    -t 'edits the name inline|saves language immediately|completes protected first-run|creates an invitation|enrolls TOTP|updates profile/locale'
  ```

- Actual handlers and disposable DB schemas prove name Enter/blur/Escape and
  failed/pending behavior; immediate language/503 rollback; concurrent name and
  locale partial updates; reload persistence; keyboard radio selection; picker,
  WebP drag/drop and multiple-file rejection; email verification; real TOTP,
  virtual WebAuthn passkeys and recovery-code sign-in. A gated passkey rename
  proves Add/Edit/Delete/Cancel cannot replace the editor while its request is
  pending. Browser/provider/mail fixtures remain isolated, with no live-account
  mutation. Chromium/Firefox cover Profile/photo; the account/security journey
  uses Chromium and a virtual authenticator.
- `scripts/dev.sh pnpm --filter @nickhosting/web typecheck`,
  `scripts/dev.sh pnpm build`, `scripts/dev.sh pnpm i18n:check`: passed
  (1892 English/Italian keys plus pseudolocale). The existing large-chunk advisory
  remains. Scoped Biome/format, whitespace and indexed governance passed.

  Scoped lint retains the existing non-null-assertion warnings in the older
  account journey and catalog compiler, plus the compiler's existing rethrow-only
  catch advisory; no new lint error was introduced.

Independent source and visual/accessibility review found and resolved a pending
passkey-editor switch race and a surviving global width limit. Final review has no
remaining must-fix. Axe and mobile overflow checks passed on sampled Profile and
Security states; this is not a complete WCAG audit. Reviewed fixture screenshots:
[Profile desktop EN](screenshots/m5/settings-interactive-profile-desktop-en.png),
[Profile mobile IT](screenshots/m5/settings-interactive-profile-mobile-it.png),
[Security desktop EN](screenshots/m5/settings-interactive-security-desktop-en.png),
[Security mobile IT](screenshots/m5/settings-interactive-security-mobile-it.png),
[password change](screenshots/m5/settings-interactive-password-edit-desktop-en.png),
[passkey confirmation](screenshots/m5/settings-interactive-passkey-remove-desktop-en.png).

Dev updates through existing HMR. No container restart, live database/account,
provider, infrastructure or production mutation; no game assets or new persistent
resources. Test schemas are cleaned by the harness. No historical full-suite
rerun; issue18 and production-release gates remain unchanged. Rollback is the
UI commit revert, with no data restoration required.

## Persistent session management and passkey reauthentication — 2026-10-16

Live development diagnosis reproduced HTTP403 from Better Auth's session list and
passkey registration-options endpoint with an otherwise valid session older than
five minutes. Passkey listing returned200. Both features were configured; the
unmapped `SESSION_NOT_FRESH` error incorrectly became the generic internal-error
message. Prior browser tests authenticated immediately before visiting Security,
so they did not exercise this age boundary.

Session discovery now uses `GET /v1/web/account/sessions`: all unexpired persisted
sessions belonging to the caller, including closed browsers, with an exact current
session marker and no bearer tokens. Revocation resolves the caller-owned ID and
uses the existing Better Auth revocation/audit implementation. Neither operation
requires a fresh login. Anonymous, foreign, assisted-session and cross-origin
requests retain their existing boundaries. Passkey enrollment still requires a
recent authentication; its localized notice links to the existing login flow and
returns to Security, without automatically replaying enrollment or weakening 2FA.
Only the literal `reauth=security` destination is recognized.

Focused checks:

- `scripts/dev.sh pnpm exec vitest run packages/i18n/src/i18n.test.ts apps/web/src/api/client.test.ts`: **17 passed**.
- `scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 scripts/dev.sh pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/web-session.integration.test.ts`: **7 passed**. Includes older/expired sessions, safe projection, owned/current revocation, audit hooks, anonymous/foreign/support denial and DELETE Origin checks.
- `scripts/dev.sh pnpm typecheck`, `scripts/dev.sh pnpm i18n:check`: **passed**, 1893 EN/IT and pseudolocale keys. Focused product lint/format and whitespace checks passed; pre-existing older-test warnings remain.
- `scripts/dev.sh pnpm test:browser apps/web/tests/account-freshness.browser.test.ts`: final **8/8 passed** in39.19s across Chromium/Firefox. Initial run **7/8 passed**: its second enrollment reused an already-registered virtual authenticator, which correctly rejected duplicate registration. The fixture now proves enrollment once and checks fresh registration-options for subsequent recovery. An initial invocation without `scripts/dev.sh` stopped at the Node20 engine guard before running tests; the pinned Node24 wrapper was then used.

Browser coverage proves closed-browser session persistence, other/current-session
revocation, token-free responses and foreign denial; EN password and IT
password+TOTP reauthentication, return to Security and fresh passkey enrollment.
Sampled axe and desktop/mobile reflow checks pass. Reviewed screenshots:
[Security desktop EN](screenshots/m5/settings-security-reauth-desktop-en.png),
[Security mobile IT](screenshots/m5/settings-security-reauth-mobile-it.png),
[sign-in handoff](screenshots/m5/settings-security-reauth-login-en.png).

Live read-only smoke: the new endpoint returned200 with three existing Owner
sessions, exactly one current marker and no exposed token; passkey listing also
returned200. No real account was enrolled, revoked or edited. Source changes loaded
through the existing API watcher/Vite; no manual container restart, migration,
provider call, game mutation or new persistent infrastructure was needed.
Independent technical review found no must-fix. Actual OAuth and passkey sign-in
roundtrips were not rerun; password/TOTP recovery uses real handlers, while passkey
enrollment uses Chromium's virtual authenticator. Rollback is a code revert; no
schema/data restoration is required. PR21 stays open and unmerged; issue18 and
production-release boundaries remain unchanged.

Final independent source/visual review: no remaining must-fix. Indexed governance
passed: 1022 text files, 397 reviewed PNG assets, 849 relative links, four TOML
files and 44 ignore cases. No historical full-suite rerun.

## Password change confirmation — 2026-10-16

Personal Security now requires Current password, New password and Repeat new
password (EN/IT). Confirmation compares exact strings before the existing
change-password request; a mismatch preserves the form and shows localized
validation. The confirmation is never sent to the API. Existing minimum/maximum
length, autocomplete, current-password authentication and other-session revocation
remain unchanged. No API, schema, dependency or infrastructure change.

`scripts/dev.sh pnpm test:browser apps/web/tests/account-password.browser.test.ts`:
**2/2 passed** (Chromium EN/IT,23.12s), proving required confirmation, exact
whitespace-sensitive matching with no premature API request, successful change
through real handlers, current-session retention and revocation of other sessions.
The initial two cases stopped during fixture preparation on its shared login
rate-limit; resetting the isolated rate-limit table between cases fixed that test
setup, with no production change. Web/source and browser-test typechecks, focused
Biome,1895-key i18n and whitespace checks passed. Independent implementation and
screenshot review found no issues. Reviewed [desktop EN](screenshots/m5/settings-password-confirmation-en.png)
and [mobile IT](screenshots/m5/settings-password-confirmation-it.png). Disposable
schemas cleaned; no live-account mutation or manual service restart. Rollback:
revert this frontend change. No unrelated suite rerun.

## Guided authenticator enrollment — 2026-10-17

Security now separates identity confirmation, local QR/manual-key pairing and
verified recovery-code storage. Existing Better Auth endpoints remain authoritative;
no authentication API, schema, provider or gateway behavior changed. The optional
QR library is lazy and locally encoded. An unavailable QR chunk offers manual
entry. The six-digit text field supports leading zeros, paste and one-time-code
autocomplete. Codes remain hidden until successful verification, then can be
copied/downloaded locally. Done clears them from memory. No password/secret/code
is placed in browser storage, URLs or query caches. See the updated
[authentication contract](AUTH-AND-PERMISSIONS.md) and
[dependency notices](M5-DEPENDENCIES.md#authenticator-qr-encoding).

Settings owns the pending enrollment across Profile/Security navigation, preventing
duplicate preparation or verification. Partial OTP text clears when changing tabs;
URI/recovery data remain in identity-keyed layout memory until exit. Set up later
hides an unverified draft without calling disable. Recovery regeneration and
password-confirmed disable still use the existing handlers. A cached regular
session survives a transient HTTP5xx/network refresh error with an explicit retry;
this prevents losing codes immediately after successful activation. Actual auth
failures, unavailable initial identity and support sessions retain the existing
boundary. The verified mutation result remains accurate until a successful
session read catches up; retries do not repeat verification.

Validation (isolated PostgreSQL schemas, actual identity handlers, Chromium):

- `scripts/dev.sh pnpm test:browser apps/web/tests/account-totp.browser.test.ts`:
  **6/6 passed**, 45.47s. Covers password/cancel, shared in-flight state across tabs,
  defer/resume, clearing on reload/layout exit, invalid and valid OTP, cookie
  rotation, recovery copy/download/Done, regeneration/disable, QR import failure,
  and successful activation followed by a failed session refresh and read-only retry.
- Existing `apps/web/tests/account.browser.test.ts`: **7/7 passed** in the combined
  targeted command, including actual recovery sign-in and virtual WebAuthn enrollment.
  The first new-test run passed 3/4; the remaining test read recovery nodes before
  tab navigation completed. A subsequent run passed 4/6; its two new scenarios used
  ambiguous Home and incorrect retry-label selectors. Corrected those waits/selectors,
  without changing authentication behavior, before the final 6/6 run.
- Web/source and browser-test typechecks, focused Biome and 1916-key EN/IT/pseudo
  completeness passed. Production build passed; existing large-chunk warnings remain.
  Four pre-existing non-null-assertion lint warnings remain in the older account journey.
  The QR chunk measures16.32 kB minified / 6.07 kB gzip, loaded only during setup.
- A targeted recovery-test rerun after a clipboard-denial layout fix passed 1/1 (five unrelated cases skipped), 22.86s,
  including mobile reflow/axe. Errors now sit outside the icon group and explain
  manual copying; a failed retry clears the previous Copied indication.
- Sampled axe WCAG2.2AA, keyboard/focus checks and desktop/mobile EN/IT reflow passed.
  Independent source and rendered-screen review found no remaining must-fix.
  This is not a full WCAG audit; physical-phone QR scanning and passwordless/OAuth
  enrollment were not newly exercised. Their existing backend contract is unchanged.

Sanitized, reviewed screenshots: [confirmation EN](screenshots/m5/settings-totp-password-desktop-en.png),
[pairing EN](screenshots/m5/settings-totp-authenticator-desktop-en.png),
[recovery EN](screenshots/m5/settings-totp-recovery-desktop-en.png),
[confirmation IT](screenshots/m5/settings-totp-password-mobile-it.png),
[manual pairing IT](screenshots/m5/settings-totp-authenticator-manual-mobile-it.png),
[recovery IT](screenshots/m5/settings-totp-recovery-mobile-it.png),
[incorrect code](screenshots/m5/settings-totp-incorrect-code-desktop-en.png),
[pending request](screenshots/m5/settings-totp-loading-desktop-en.png).
QRs, setup keys, OTP inputs, passwords and recovery codes are masked.

Live read-only checks: Settings HTTPS and the new TOTP frontend module return 200.
The existing Vite image lacks `qrcode.react`; its activation requires a separately
approved Vite-only image update. Until then, the manual-key fallback remains usable.
The running container is `nickhosting-dev-vite-1`, project `nickhosting-dev`, only
`nickhosting-dev-edge`, with no published ports. Compose resolution preserves those
boundaries. No real account was changed and no containers were rebuilt/restarted;
no provider, infrastructure or persistent data mutation occurred. Test schemas are
scoped and cleaned by the harness. PR21 remains open/unmerged; issue18 remains a
separate release gate. No historical full-suite rerun. Rollback: revert this
frontend/lockfile change; if activation is approved, retain the current Vite image
and recreate only Vite from that image. No migration or data restoration is needed.

Indexed governance passed: 1029 text files, 407 reviewed PNGs, 862 relative links,
four TOML files and 44 ignore cases. The secret scan is heuristic. No unresolved
implementation/review finding remained at that checkpoint; Vite dependency activation
was pending approval. The subsequent approved activation is recorded below.

### Approved Vite activation — 2026-10-17

Owner authorized the exact Vite-only image update and scoped rollback. Verified
clean branch `milestone/m5-webpanel` at source commit
`984dcb86204ff154a5568590ca182c8314ba7a49`, matching running Vite identity,
existing edge-only network and no published ports. Private dev interpolation files
were preserved; the explicit base Compose file matches this service’s live config.

Executed the approved commands:

```bash
docker image tag sha256:2460669093a603d7280be97aa927e2fd5d07b08d5774ab0fccda61828a1ee222 nickhosting-dev-app:before-totp-workflow
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local -f compose.dev.yaml build vite
docker compose --env-file .env.dev.local --env-file .env.dev.viewer.local --env-file .env.dev.sftp.local -f compose.dev.yaml up -d --no-deps --wait vite
```

Build succeeded with the frozen lockfile. New image:
`sha256:2826f15993d2904e0da636ef101b01774937896cef45ae0d5bfc1c800a22a350`.
`nickhosting-dev-vite-1` is healthy, restart count 0; startup compiled all 1916
EN/IT/pseudo keys and Vite reported ready in 854 ms. Installed QR dependency is
4.2.0. The original image remains at the rollback tag. No rollback was necessary.

Private before/after metadata proves only Vite was recreated: the other 11 dev
containers retain their IDs, images, start times, restart counts, network
attachments and published-port configuration. No extra/missing container.
The warning about four existing optional dev containers outside the base Compose
file was informational; none was removed or recreated. Vite retains only the
existing dev-edge attachment and no published host port.

A fresh, unauthenticated Chromium context verified HTTPS 200/login rendering,
successful import of the live QR component and its new dependency, exact synthetic
setup-URI propagation, and HTTP 200 for both bundled QR license notices. The HMR
socket connected through the configured HTTPS origin using WSS. Zero browser
page errors and zero mutation requests. This is dependency/transport smoke evidence;
physical authenticator scanning and real Owner enrollment remain the Owner’s action.
No historical suite was rerun because the source was already covered above.

No real account, database, provider, game server, Gateway, NPM, DNS, certificate,
production container or persistent storage was changed. Private activation evidence
is retained locally; the browser context was closed. Independent activation review
confirmed the exact Vite scope, rollback image, before/after snapshots and browser
smoke evidence; no remaining activation blocker. PR21 remains open and unmerged.

## Backup pipeline and interface — 2026-10-17

Implemented the [backup contract](BACKUPS.md): SDK offline policy, temporary
stop/backup/admitted resume, optional pre-restore snapshot, native replacement
semantics, protection and human names, schedule options and opt-in retention.
Blueprint 1.5.0 captures committed native completion into the existing signed
outbox; Core deduplicates receipts and wakes durable jobs. Database notifications
feed one shared API listener and authorized server SSE. Migration 037 is additive
and explicit. Source-before-migration guards preserve unrelated services.

Reviewed browser evidence uses actual React components in Firefox with isolated
API responses, not generated images or live game backups:

- [Desktop](screenshots/m5/backups-desktop-en.png)
- [Italian mobile](screenshots/m5/backups-mobile-it.png)
- [Destructive restoration](screenshots/m5/backups-restore-mobile-en.png)
- [Backup success / resumption failure](screenshots/m5/backups-partial-outcome-en.png)

Ten backup scenarios cover creation, exclusions, native protection, rename,
streamed-download launch, quotas, permissions, failed requests with preserved
list data, loading/empty/uncertain jobs, partial outcome, and keyboard dialog
focus. Four additional schedule scenarios verify submitted modes/retention,
capacity-derived defaults and bounds, zero/one-slot disabling and required-offline
policy. EN/IT desktop/mobile reflow and automated axe checks passed; independent
visual/content review inspected eleven rendered states without blocking findings.
This evidence does not establish actual provider transfer/restore behavior.

Commands and results:

```bash
scripts/dev.sh pnpm exec vitest run packages/server-management/src/backup-policy.test.ts packages/server-management/src/minecraft-backup.test.ts packages/pterodactyl-adapter/src/blueprint.test.ts packages/pterodactyl-adapter/src/blueprint-bridge.test.ts packages/server-management/src/scoped-provider-adapter.test.ts
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/provider-events.integration.test.ts apps/api/src/provider-backup-events.integration.test.ts
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts apps/api/src/servers.integration.test.ts -t 'scopes backup labels|streams safe bytes'
scripts/dev.sh pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/backups-ui.browser.test.ts
scripts/dev.sh pnpm exec vitest run --config vitest.browser.config.ts apps/web/tests/backups-ui.browser.test.ts -t 'schedules .*backups'
python3 extensions/nickhosting/tests/run_php_tests.py --container pterodactyl-panel-2
python3 -m unittest discover -s extensions/nickhosting/tests -p 'test_package.py'
scripts/dev.sh pnpm typecheck
scripts/dev.sh pnpm build
scripts/dev.sh pnpm i18n:check
```

- Event/API integration: 12 passed; backup metadata/download authorization targeted
  cases: 2 passed, 80 intentionally skipped.
- Browser: 10 backup scenarios passed across full plus targeted correction runs;
  schedule-only run 4 passed, 10 skipped. Do not interpret these as a full M5 browser run.
- Vendor-backed PHP: 280 checks passed, including real native activity-save ordering,
  transaction rollback, source recovery, identity rejection and microsecond timestamps.
  The harness uses in-memory SQLite, no Panel bootstrap, outbound HTTP or production
  database writes. Package: 13 passed. Reviewed archive SHA-256
  `fd256f922bcd9b33355159a05d588fb91d54b1883e53c8fdee5c524e78a2b88f`.
- Production WebPanel build passed; existing large lazy viewer chunks still produce
  the bundle-size advisory. EN/IT/pseudo compilation checks passed (1965 keys).
- Focused changed-source Biome checks pass with existing warnings; formatting and
  whitespace checks pass. Full historical M1–M5/SFTPGo suites were not repeated.

Independent review drove fixes for event timestamp precision, early-receipt/wait
race, old restore baselines, stale Panel resource state, rejected-operation recovery,
Gateway process rebinding, compensation after authorization withdrawal, retention
spare capacity and cleanup after external stop. A later full integration run exposed
a null Gateway generation on direct servers; it was fixed rather than weakening
identity/admission checks. Synthetic-clock fixture failures are recorded with final
suite evidence below; initial failures are not represented as passes.

Activation remains pending the [scoped procedure](M5-ENVIRONMENTS.md#backup-workflow-activation-proposal--2026-10-17).
No live backup, restore, server power command, extension install, migration, container
restart or production configuration change was performed. Existing isolated M2 test
services were reused; disposable test schemas and browsers were cleaned by their
fixtures. No new game server or persistent test asset was created. Read-only
preflight found dev API/worker/Vite healthy and the existing Gateway unhealthy;
this work does not claim live Gateway validation. Native restore callbacks lack
attempt tokens as documented in BACKUPS.md. SFTPGo #18 remains a release gate.

Final capability review found that legacy Minecraft could accept `save-off` while
the modern-only receipt parser rejected both preparation and cleanup replies.
Minecraft therefore declares required offline backup consistently; the generic SDK
recommended/none policies and live preparation/cleanup hooks are implemented and
isolated-tested, but live Minecraft availability remains pending exact version
evidence. No guessed cutoff or fixture-only real-server compatibility claim is used.

Remaining non-blocking behavior: a recent live-backup receipt can temporarily
shadow an older Start receipt in cached resource-state reconciliation. The existing
reservation stays conservatively retained; no readiness promotion or resource
release is inferred. This does not enable live Minecraft backups.

Final execution evidence:

```bash
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/lifecycle.integration.test.ts packages/server-management/src/schedules.integration.test.ts packages/server-management/src/gateway-orchestration.integration.test.ts
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/schedules.integration.test.ts
```

The final combined run was **347 passed / 1 failed**: lifecycle 237 and Gateway 92
passed completely; schedules had 18 passes and one fixture failure. That fixture
hardcoded provider user 1 rather than its allocated technical owner. After correcting
only the fixture identity, the full schedules file passed **19/19**. An earlier
Gateway synthetic-clock fixture exhausted the four-second host-proof freshness
window; refreshing the fixture observation each cycle matched production without
changing the freshness limit.

A subsequent lifecycle regression found and fixed rejection flags leaking from a
failed backup-create phase into admitted resumption. Targeted final backup/journal
coverage passed **11 tests, 227 skipped**, including failure → pending resume →
confirmed process with one power request and retained compute reservation. This
is targeted final-source evidence, not a claimed final rerun of all 348 tests.
Final five-file adapter/backup unit command above passed **66/66**. Additional SDK/
schedule unit coverage with the lifecycle author's four-file selection passed
17/17 (overlapping backup units; these counts must not be added as unique tests).
Root/web typechecks passed. Changed-source Biome/format and index governance passed;
existing non-null assertion warnings were not unrelatedly refactored.

Final independent security/durability review accepted the revised event, cleanup,
Gateway, retention and phase-journal paths with no remaining must-fix finding.
The reviewer separately accepted the required-offline Minecraft capability decision.
The remaining operational boundary is explicit activation and Owner-triggered live
backup/restore verification, not a fabricated production pass.

The final targeted selections (Node 24.21.0, equivalently via `scripts/dev.sh`):

```bash
scripts/dev.sh pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts packages/server-management/src/lifecycle.integration.test.ts -t 'event-driven backup lifecycle|backup recovery and restore safety|recovered rejected resume|retains resumed compute|retention deletes|compensating cleanup'
scripts/dev.sh pnpm exec vitest run packages/server-management/src/backup-policy.test.ts packages/server-management/src/minecraft-backup.test.ts packages/server-management/src/schedules.test.ts packages/game-sdk/src/game-sdk.test.ts
```


### Approved backup activation — 2026-10-17

Activation of reviewed source `814e26fc116e2a4e3da90aba5d78d82e3869cd98`
completed as recorded in [Environments](M5-ENVIRONMENTS.md#backup-workflow-activation-completed--2026-10-17).
This adds deployment smoke evidence to the isolated results above; it does not
replace them or claim a live backup/restore pass.

Executed: full-environment `docker compose build api`, scoped `stop api worker`,
private `pg_dump` and `pg_restore --list`, explicit `--profile tools run --rm
--no-deps migrate`, native `blueprint -install nickhosting`, and scoped
`up -d --no-deps --no-build --wait api worker`. Only database migration 037 and
Blueprint's owned backup-event migration were added, with checksums verified.
API/worker are healthy with zero restart counts. Data/configuration fingerprints
and provider-server metadata remained unchanged. No game server was operated on.

Read-only standard adapter discovery: 1.5.0, backup events supported; anonymous
request denied with 401. Shared feed: zero pending events and a fresh health
stamp after a preserved transient startup feed/reconciliation warning. Actual
backup-event delivery was not generated for this activation. The previously
unhealthy Gateway remains a separate unresolved operational finding.

Real fresh Firefox smoke passed: HTTPS 200, web configuration 200, protected
anonymous request 401, secure HMR WebSocket present, zero page errors/5xx.
Independent activation review covers topology, migrations, preserved identities,
artifact verification and smoke evidence. No full historical suite was repeated
for this documentation/activation-only pass. No test server was created or removed.
