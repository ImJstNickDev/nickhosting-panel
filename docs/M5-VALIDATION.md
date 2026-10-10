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
