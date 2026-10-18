# NickHosting Blueprint extension

Development started on 2026-10-11 under M5 PR #21 and [issue #25](https://github.com/ImJstNickDev/nickhosting-panel/issues/25).
This is source development, not authorization to install on the existing Panel.

## Repository and development workflow

Keep the source in [extensions/nickhosting](../extensions/nickhosting/README.md).
The extension runs as PHP inside Pterodactyl, not in NickHosting's TypeScript
processes. It is not a second provider adapter. NickHosting communicates with it
through `packages/pterodactyl-adapter`, keeping all credentials server-side.

Blueprint's documented `-init`, `-build` and `-export` workflow uses
`.blueprint/dev` inside a Panel installation. This directory is staging for those
commands, not a requirement for the source repository. Keep the monorepo as the
source of truth; any later staging must avoid overwriting unrelated development
files. Do not bind the repository into the live Panel or run `blueprint -build`
automatically: that command applies changes to the Panel.

The initial target is Panel 1.11.11 / Blueprint beta-2025-09. A target declaration
is not a tested compatibility claim. Newer versions require separate validation.
No live installation, provider registration, migration or account/key mutation
has been performed. The Owner does not want a second Panel deployment; no such
resource is a prerequisite for source development, and none is being created.
A later approved live rollout must have explicit rollback and bounded smoke tests.

## Implemented first increment

- Blueprint metadata, PHP Application API routing and an authenticated read-only
  capabilities response.
- An explicit adapter discovery function using the existing bounded transport,
  Application credential, redirect rejection and rate-limit handling.
- HTTP 404 means unavailable; denied requests, throttling, malformed/version-
  incompatible payloads and provider failures remain errors.
- No automatic discovery call on Start, wake, reconciliation or ordinary requests.
- Both `clientKeyManagement` and `serverChangeEvents` are false. Discovery must
  never be treated as authority to link accounts, import servers or skip admission.

The payload is versioned independently of the extension release:

```json
{
  "schemaVersion": 1,
  "extension": "nickhosting",
  "extensionVersion": "0.1.0-dev",
  "target": { "panel": "1.11.11", "blueprint": "beta-2025-09" },
  "capabilities": { "clientKeyManagement": false, "serverChangeEvents": false }
}
```

## Next increments: not yet implemented

### Account keys

Follow issue #25 for explicit provider-user linking, administrative write ACLs,
non-admin target restrictions, issuance recovery, encrypted storage, rotation,
revocation and project/subuser access. Existing shared credentials remain in use.
The extension will reuse Pterodactyl's token mechanisms. It must not accept an
arbitrary user ID as sufficient authority to mint a key.

### Server configuration notifications

The installed Panel's `BuildModificationService` saves resource limits through
`Server::saveOrFail()` inside a database transaction. `ServerObserver` emits
`Pterodactyl\Events\Server\Updated` before that transaction commits. This is a
usable capture point for normal Panel/API resource edits, not proof that Wings
has applied the change: Wings synchronization occurs after commit and can fail.

Proposed design, requiring implementation/review:

1. Register a listener globally for HTTP and queue/CLI execution. Blueprint
   beta-2025-09 has no confirmed declarative service-provider hook; determine a
   reversible provider-registration mechanism before installation. Side effects
   in route files are insufficient when routes are cached.
2. Only capture explicitly linked NickHosting server identities, scoped by
   provider instance and environment. A name or external-ID prefix alone is not
   ownership proof. Changes to identity must invalidate the link, not silently
   retarget it.
3. Insert an event into an extension-owned durable outbox in the same transaction
   as the relevant change. Send only after commit. A bare after-commit HTTP call
   can lose an event if the process crashes before sending it.
4. Deliver a minimal authenticated payload with stable event ID, ordered server
   revision, exact provider identity and limits. Do not serialize the model,
   environment variables, tokens or other server secrets. Authenticate the raw
   body, reject replay and use explicitly configured HTTPS destinations.
5. Persist the projection in NickHosting PostgreSQL, deduplicate events and reject
   older revisions. Acknowledge only after durable commit; retry undelivered events
   with bounded backoff. Do not give the extension direct access to NickHosting's
   database or share a production Redis namespace.
6. Bootstrap a snapshot and replay cursor without losing concurrent edits;
   support reconnection, delivery backlog, key rotation and version negotiation.
   Start may use the local projection only under an explicit freshness/health
   policy. Asynchronous delivery does not guarantee instantaneous consistency.
7. Retain low-frequency reconciliation and resnapshot on gaps. Bulk query updates,
   direct SQL, muted events and third-party modifications may bypass Eloquent
   events. Allocation changes are not all Server model events; do not claim full
   inventory coverage from the resource-limit listener.

The change feed would remove the normal synchronous limits GET only after these
acceptance conditions are proven. It does not replace host resource observations,
atomic admission/reservations, ownership checks or Gateway routing fences. For
already running servers, changed limits require deliberate reservation handling;
no automatic shutdown or queue for capacity is implied.

## Evidence and licensing

- [Blueprint quick start](https://blueprint.zip/guides/dev/quickstart)
- [Blueprint packaging](https://blueprint.zip/guides/dev/packaging)
- [conf.yml](https://blueprint.zip/docs/configs/confyml)
- [Extension routes](https://blueprint.zip/docs/concepts/routing)
- [Extension scripts](https://blueprint.zip/docs/concepts/scripts)
- [Tagged Blueprint framework](https://github.com/BlueprintFramework/framework/tree/beta-2025-09)
- [Pterodactyl ServerObserver](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Observers/ServerObserver.php)
- [Pterodactyl build modifications](https://github.com/pterodactyl/panel/blob/v1.11.11/app/Services/Servers/BuildModificationService.php)
- [Laravel model events and their bulk-update limitations](https://laravel.com/docs/10.x/eloquent#events)

Upstream code is a reference; no Blueprint/PteroCA/closed-source extension source
is bundled. This work makes no new repository licensing decision. Any later
reuse must carry its own license review and applicable notices.

## Initial validation — 2026-10-11

- `scripts/dev.sh pnpm exec vitest run packages/pterodactyl-adapter/src/blueprint.test.ts packages/pterodactyl-adapter/src/transport.test.ts`: 24 passed.
- `scripts/dev.sh pnpm exec tsc --noEmit`: passed.
- Scoped Biome check on the adapter additions: passed.
- `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s extensions/nickhosting/tests -v`: 5 passed; deterministic allowlisted archive, no overwrite, symlink rejection and missing-input handling.
- Three PHP sources, with Blueprint namespace placeholders expanded in memory,
  passed `php -l` via stdin using the existing Panel PHP binary. No application
  bootstrap, files copied into the container or production mutations occurred.
- No full historical suite was run. PHP syntax and mock-transport tests do not
  prove Laravel routing/ACL enforcement, Blueprint installation, route-cache
  compatibility or future notification delivery. Those remain unverified.
- Independent review found no must-fix in this source-only increment. It checked
  the installed Application request/ACL and Blueprint route-provider signatures,
  explicit rejection of browser/Client tokens, archive safety and honest feature
  declarations. Runtime installation/authentication evidence remains outstanding.

### Manifest correction and first artifact

A subsequent direct check of the beta-2025-09 installer's required-field checks
found a defect missed by the initial review: `admin.view` is mandatory. The
initial manifest lacked it and must not be considered installable as written.
Added an EN/IT informational Blade view, its manifest binding and archive entry;
a regression checks that the view is declared, packaged and required by the build.
The six packaging tests pass. The independent follow-up review checked the other
mandatory manifest fields and paths; no further missing requirements were found.

The first default build attempt under `mountdata/build/` failed because the
existing mountdata parent is not writable. No permission/ownership changes were
made. Build artifacts now default to the already ignored `build/blueprint/`
directory, separate from application persistence.

Created `build/blueprint/0.1.0-dev/nickhosting.blueprint` (2,117 bytes, five
allowlisted entries), ZIP CRC validation passed. SHA-256:
`871280a46b8c7481b5d0fa84d7d9ffb44013a8ecce0f8fb0f560cf580653cb5e`.
This is a development foundation archive, not the completed key-management or
notification extension. No installer was executed; Blade rendering and actual
installation remain unverified.

### Pre-installation source audit

The actual archive was rechecked byte-for-byte against all five source files.
No NickHosting extension directory, Application route or application namespace
collision was found in the current Panel (read-only check). Independent review
found no further package/source blocker for a trial of this minimal foundation.

Ten in-memory PHP checks using the installed vendor libraries passed: absent,
anonymous, browser-session and Client-token denial; Application-token servers
ACL denial/acceptance; controller response; EN/IT Blade compilation and rendering.
Only the Composer autoloader was loaded, not the Panel application/bootstrap or
HTTP kernel. Unsaved token attributes were supplied in memory without database
access. An initial harness attempt to construct a normal Eloquent model failed
because its validation service was intentionally not bootstrapped; the harness
was corrected to supply an unpersisted model without running its constructor.
These checks do not replace real HTTP middleware testing after installation.

**Standard Blueprint installer effects must be included in rollout approval:**
installed beta-2025-09 runs `storage:link`, rebuilds view/config/Blueprint caches,
clears route/application caches, signals `queue:restart`, recursively adjusts
ownership across the Panel directory excluding node_modules, and adds executable
permissions across extension files. These are framework actions even though our
archive has no install hooks, migrations, schedules or frontend assets. Standard
removal also rebuilds caches/restarts queues/adjusts ownership; it is not an exact
rollback of pre-installation permissions.

For an Owner-managed trial, place the exact reviewed `nickhosting.blueprint` in
the Panel root, then run `blueprint -install nickhosting` there. Use a maintenance
window and retain a restorable pre-installation Panel/Blueprint file and metadata
backup; do not overwrite another development workspace or extension. Verify the
admin information page, then the capabilities endpoint with the existing private
Application credential and servers READ permission. It should return HTTP 200
with both feature flags false; unauthenticated/Client-key requests must be denied.
Do not include credentials in chat or diagnostic output. If successful, record
the installed package hash and HTTP evidence before enabling any NickHosting
caller. This foundation adds no automatic calls or Start-path behavior.

Normal removal is `blueprint -remove nickhosting`, from the same Panel root.
If installation fails partway, preserve its logs and assess partial state before
removal/retry. Restore the pre-installation snapshot and original metadata if a
full rollback is needed; do not claim that removal undoes shared permission
changes. Neither installation nor removal was executed during this audit.

### Owner installation and authenticated HTTP smoke

The Owner ran the standard installer and reported success, then confirmed the
NickHosting information page was visible. A subsequent read-only HTTP check from
the existing development worker, using configured credentials through the normal
secret store, verified:

- Application credential: HTTP 200; the adapter accepted schema version 1,
  extension version 0.1.0-dev and both capabilities false.
- No credential: HTTP 401.
- Existing Client credential on this Application endpoint: HTTP 403.

Exactly three GET requests were made; credentials and provider response errors
were not printed. No users, keys, servers or settings were changed, and no
installer/restart was run by the agent. This establishes the initial installed
route/authentication path, not future key issuance, notifications or rollback.
Next implementation priority is the durable server-limit change feed and its
NickHosting receiver; per-user key management follows separately. The current
Start-path limit read remains unchanged until the new synchronization is proven.

## 2026-10-11 — 1.0.0 bridge release

This section supersedes the initial discovery-only capability statements above;
the earlier installation and failed-test history is retained.

The Owner authorized completing and installing the extension in one reviewed
release. Version **1.0.0** adds exact managed-server linking, signed durable
server-limit notifications, authoritative recovery snapshots and explicitly
linked non-administrator account key issuance/rotation/revocation. The extension
README documents its routes, authentication, queue recovery and deployment hooks.

NickHosting stores the webhook secret encrypted with an instance-specific
context. Its exact machine endpoint is `POST /v1/provider-events/pterodactyl`;
only this method/path bypasses browser session/CSRF authentication, replacing it
with bounded raw-body HMAC, timestamp, instance/provider/callback binding and
persistent revision checks. Other browser routes retain their protections.

A shared worker refreshes feed health every 15 seconds and linked snapshots
approximately every 60 seconds, using the existing coordinated Application
transport. Start may use projected limits only with health at most 30 seconds
old, a snapshot at most 120 seconds old, exact managed identity and unchanged
managed limits. Otherwise it uses the existing provider read. Admission, active
reservations and provider command authorization remain mandatory. A local
generation fence prevents an in-flight health reply from undoing a newer event's
invalidation. Identity invalidation cannot be repaired by stale snapshots.
These bounded freshness windows are not a guarantee against arbitrary direct SQL
changes; Eloquent changes produce immediate notifications, while periodic
snapshots cover missed events. This feed reports Panel configuration, not proof
that Wings has applied it.

Deployment uses the packaged extension migration only, a reversible marked
service-provider entry in `config/app.php`, and an explicit local HTTPS callback
origin allowlist in `config/nickhosting_bridge.php`. Bootstrap configuration is
syntax-validated and replaced atomically. The standard Blueprint installer still
performs the shared cache, queue and ownership operations documented above.
No Panel core service or Wings code is patched.

After installation and explicit database migration, run
`node --import tsx scripts/blueprint-connect.mjs --owner-approved` from the project
root in the configured application environment. It persists an encrypted secret
before registration, reuses the existing instance on retry, and never prints
credentials. It registers extension metadata only; the worker links only exact
identities already in NickHosting's managed registry. It does not import foreign
servers. The callback must already be present in the extension's local allowlist.

The per-user key **extension API** is complete; migrating NickHosting accounts,
assigning provider ownership and selecting a Client credential per actor remain
tracked in issue #25. No existing account is migrated, linked by email, promoted
or reassigned automatically. Live user/key mutation testing requires explicitly
approved target identities; isolated tests do not count as a live migration.

### Validation and independent review

- PHP harness: 46 checks using the installed Composer dependencies, SQLite memory
  databases and mocked outbound HTTP, without bootstrapping the production Panel.
- Packaging: 7 tests; 11 expanded PHP files and both shell hooks passed syntax checks.
- Adapter discovery/signatures/administrative calls plus worker loop: 25 tests passed.
- Actual Hono receiver and PostgreSQL projections: 20 integration tests passed.
- Targeted clean-Start lifecycle/projection run: 25 passed, 170 intentionally
  filtered; later projection checks include the review fixes.
- Root TypeScript check passed. No historical full milestone suite was repeated.
- Independent review found and resolved reserved Blueprint route placeholder
  expansion, non-atomic bootstrap configuration writes, and stale health-response
  invalidation. The reviewer found no remaining must-fix before activation.

The first development migration attempt refused safely because the existing
container image contained migrations only through 019. The complete current SQL
set was supplied in a temporary directory to the unchanged checksum-verifying
migration runner; only 022 was applied. Existing migration checksums and data were
preserved; the temporary files were removed. Source hot reload initially exposed
a missing worker dependency; the feed orchestration was placed in the existing
server-management package, restoring worker health without a container rebuild.

Rollback: disable the local feed to immediately restore provider GET fallback;
retain encrypted secrets, projections and extension audit/outbox data. Reverting
the extension requires the preserved prior artifact and reviewed removal of its
marked provider hook before reinstalling discovery-only code. Never drop tables,
revoke user keys or blindly restore shared Panel files as an automatic rollback.
Blueprint removal is not an exact rollback of global permission/cache changes.
Issue #18 remains an independent production-release blocker.

### Approved live activation evidence

The standard installer selected its update workflow and completed successfully.
Archive SHA-256:
`b52eed7757d1dff4b50951ab0346dabb64e7aecad1de90c3497ce23b2d4887ca`.
A private pre-update archive preserves the old extension artifact, bootstrap
configuration and relevant Blueprint files. This scoped backup is not a full
Panel database/filesystem backup or exact global permission rollback.

- Exactly the extension's MySQL migration completed; its provider is loaded and
  the recovery job appears in the existing minute scheduler.
- The explicitly allowed dev callback origin was configured; configuration cache
  and queue-worker reload completed as part of activation.
- Live Application discovery returned HTTP 200, version 1.0.0 and both flags true;
  anonymous access returned 401 and Client-key access returned 403.
- One existing NickHosting-managed identity was registered as extension metadata.
  No underlying server properties, power, files, users or ownership were changed.
- The initial signed notification was delivered on attempt **2**, following one
  unacknowledged attempt during activation. The exact first rejection reason was
  not logged and is not claimed. Durable scheduled recovery marked it delivered;
  the receiver accepted the duplicate revision safely.
- Subsequent health was fresh and `cachedProviderStartLimits` returned an eligible
  snapshot (approximately 29 seconds old at the check). This proves the live
  extension → queue → HTTPS receiver → local projection path. It does not measure
  an actual user Start or simulate a live provider resource-limit change.
- Panel, development API and development worker health checks passed. No Gateway
  restart, game-server creation/power command, account creation, Client-key
  issuance or ownership reassignment was performed.
- Final combined receiver/projection/targeted lifecycle run: **35 passed, 170
  intentionally filtered**, approximately 28 seconds. Unit adapter/worker run:
  **25 passed**. Existing isolated test services were reused; no new infrastructure.

A normal Owner-initiated Start is the next optional latency measurement; no
installation, secret copy or additional configuration step is required for the
currently linked dev instance. Do not infer a sub-second timing result from the
read-only cache check. Issue #25 stays open for the per-user account/credential
consumer migration; SFTPGo #18 remains unchanged.

Final governance checked 567 indexed text files, 138 existing review PNGs, 471
relative links, four TOML files and 44 ignore cases successfully. Scoped Biome and
TypeScript passed. A repository-wide `pnpm lint` was also attempted: it remains
red on the pre-existing `games/minecraft/src/ui/assets/player-placeholder.svg`
missing SVG title, with 32 warnings and two informational diagnostics. That
unrelated UI asset was not changed in this extension task; this is not reported
as a full lint pass. Private backups and built archives remain gitignored.

## 2026-10-11 — 1.0.1 administration settings

The callback destination moves from a manually maintained PHP configuration file
into the extension administration page. Blueprint beta-2025-09 already provides
custom admin controllers and namespaced `dbGet`/`dbSet` settings; this mechanism is
used for the NickHosting HTTPS origin. The existing admin session and CSRF
middleware remain responsible for browser access, with explicit administrator
checks on configuration writes. No Application or Client credential is exposed.

The configured origin authorizes delivery; it does not silently rewrite existing
registered callbacks, rotate webhook secrets or import servers. NickHosting's
configured public URL must agree with it. A blank origin disables delivery.
Status reflects actual registered instances and delivery records, not an assumed
successful connection merely because the URL was saved. Changes are read by the
extension without restarting the Panel or manually editing PHP files.

The original single managed provider registration in `config/app.php` remains:
installed Blueprint has no service-provider manifest binding. `requests.app`
loads classes but does not boot listeners; registering them from a route file is
unsafe because Laravel can skip route-file execution when routes are cached.
The registration remains installation-managed and reversible. The standard
Blueprint installer still performs its documented shared cache/queue/ownership
operations. These are separate from ordinary URL edits in the administration UI.

Upgrade must preserve the existing allowed origin, avoid overwriting already
saved settings, and retain an ignored backup before retiring the old extension
configuration file. This does not authorize edits to provider accounts, servers,
eggs, networks or Wings. Historical 1.0.0 configuration and test evidence above
remains unchanged.

### Settings validation

- `python3 extensions/nickhosting/tests/run_php_tests.py --container <panel>`:
  **72 checks passed**, using SQLite memory fixtures and the installed Composer
  libraries without bootstrapping the production application. Includes actual
  authorized save, anonymous/non-admin rejection, invalid-input nonmutation,
  legacy-value preservation, changed-origin delivery blocking, and EN/IT Blade
  compile/render with CSRF fields.
- `python3 -m unittest discover -s extensions/nickhosting/tests -p 'test_*.py'`:
  **8 passed**. Expanded PHP syntax and shell hook syntax passed.
- Chromium screenshots of the actual rendered Blade with native Bootstrap/AdminLTE
  styles: [English desktop](screenshots/m5/blueprint-settings-desktop-en.png) and
  [Italian mobile](screenshots/m5/blueprint-settings-mobile-it.png). No horizontal
  overflow at 1100/390 pixels; independent UX/content inspection found no must-fix.
  These are isolated template fixtures, not a logged-in production browser flow.
  Initial browser launch lacked libatk; the existing user-local browser library
  path resolved it without any system installation.
- Independent security/configuration review found no remaining must-fix. No
  historical TypeScript, game-server or full milestone suite was repeated for
  this PHP-only change.

The 1.0.1 package SHA-256 is
`e4edef6d88202edde06244f89a451bfd285edec16863cd3f03b2e389c26f29c9`.
A private pre-update backup retains the 1.0.0 artifact and relevant extension and
Panel configuration. The scoped settings migration ran successfully and a
read-only comparison confirmed that the configured origin was preserved exactly.
Live discovery returned 1.0.1 with HTTP 200; anonymous and Client-key requests
remained rejected with 401/403. No existing server/account settings were modified.

The approved Blueprint update completed successfully. A duplicate-revision
notification probe, enqueued only in the extension's own outbox after verifying
the existing linked identity, was acknowledged on its **first attempt**. No server
model, power state, file or account was changed by this probe. The legacy PHP
configuration was then moved to a private `storage/app` backup after verifying
that its sole origin matched the migrated setting. It is no longer present under
`config/`; configuration cache was refreshed. For a 1.0.0 rollback restore that
specific backed-up file before activating the old artifact. Normal 1.0.1 settings
edits need neither file changes nor cache rebuilds. Governance passed for 570
indexed text files, 140 PNGs, 473 relative links, four TOML files and 44 ignore cases.

## 2026-10-11 — 1.1.0 per-user technical identities

This supersedes the historical 1.0 rollout's deferred per-user integration.
[ADR 0015](decisions/0015-provider-technical-accounts.md) records the decision.
The extension adds idempotent technical-user provisioning, durable technical
markers, browser/reset/mail restrictions and owner-change invalidation. Its
Application-authorized endpoint creates native non-admin Pterodactyl users;
existing administrators are never adopted. Explicit `expectedOwnerId` relinking
is required to acknowledge a managed server's reviewed owner handoff.

The NickHosting runtime routes Client operations by the registered resource
owner, including console, files, backups, game content and background jobs.
Enrollment is durable and separate from feed-health polling. Setup/settings no
longer advertise the shared Client credential. Existing encrypted secrets are
retained privately for a reviewed rollback, never used as a runtime fallback.

Activation and live migration evidence must be recorded separately from fixture
results. Do not interpret account creation tests as proof of a live server owner
transfer, MySQL concurrency or complete live HTTP middleware behavior.

### 1.1.0 validation and approved live migration

- PHP vendor-backed in-memory harness: **104 checks passed**; package tests:
  **9 passed**. This covers native user creation, rollback/retry, mail suppression,
  browser/reset restrictions, key scoping and explicit owner relinking.
- Adapter discovery/signature/transport and scoped Client dispatch: **50 passed**.
- PostgreSQL enrollment: **8 passed**, including leases/concurrency, registration
  rollback, Owner backfill, lost key response, identity drift and encrypted context.
- Lifecycle: **185 passed**. Registry: **20 passed**, plus the new account ownership
  regression passed. Transfer readiness/disabled-feed regression passed.
- Auth, settings, health and schedules: **40 passed**. Initial API fixture failures
  were caused by replacing fixture users without their new enrollment records;
  fixtures were corrected, not production enrollment requirements.
- Combined API-server/runtime run: **94 passed, 1 failed** because a historical
  assertion assumed an empty database after new console tests had added fixtures.
  Corrected to compare before/after IDs; affected test and three console rotation
  regressions: **4 passed**. Platform API: **6 passed** after fixture correction.
- Real Chromium first-run flow: **1 passed, 5 intentionally skipped**. The removed
  shared Client-key field is asserted absent; actual setup/auth handlers complete.
  [Sanitized setup screenshot](screenshots/m5/setup-provider-individual-keys-desktop-en.png).
- Typecheck, formatting and focused changed-file lint passed. Whole-repository
  lint still reports the pre-existing missing SVG title in
  `games/minecraft/src/ui/assets/player-placeholder.svg`; unrelated warnings were
  not rewritten as part of this account migration.

Commands used include `scripts/dev.sh pnpm typecheck`, `pnpm format:check`,
`pnpm lint`, targeted `pnpm exec vitest run`, and
`pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config
vitest.integration.config.ts` with the named affected suites. Browser validation
uses `vitest.browser.config.ts` and the first-run test filter. PHP validation uses
`python3 extensions/nickhosting/tests/run_php_tests.py --container <existing-panel>`
without bootstrapping the production database; packaging uses unittest discovery.
No historical full M1–M5 matrix was repeated.

Independent reviews found and resolved feed polling blocked behind enrollment,
console credential rotation during/after connection, relay cleanup on credential
lookup failure, transfer readiness with a disabled feed, and equal-revision
recovery after an explicit handoff lost local confirmation. Ordinary projection
invalidation remains strict. MySQL concurrency and fault-injected execution of
the entire handoff are not claimed by the SQLite/helper tests.

The approved existing Blueprint installation was updated to 1.1.0 using its
standard installer. Artifact SHA-256:
`8ce755e7d13da04b561bc4b5722a982448896c18bc315eb0e5af01065609b475`.
Private backups preserve 1.0.1 and scoped pre-update files. Live Application
capability discovery returned 200; anonymous and Client-key requests to the
administrative endpoint returned 401/403. Only application migration 023 was
applied by the unchanged checksum-verifying runner; no database reset occurred.

The existing NickHosting Owner received a separate non-admin provider account
(ID 7). Its Client key initially listed zero servers. After the Owner's separate
explicit approval, only server 53 was reassigned from provider administrator 1
to technical account 7 through the regular Application details endpoint. Exact
UUID/external identity and unchanged name/description were verified. The local
owner pin, fresh projection and durable audit were committed; no pending jobs
existed. The original provider administrator remains administrator, without an
`nh-` prefix. The new Client key now lists only the transferred server. Read-only
runtime checks succeeded for server details, offline resources, files and backups.
The first file-list smoke used `/` instead of the adapter's empty-root input and
failed local validation; corrected input passed, without a provider mutation.

No game start/stop, file edit, egg/node/allocation/network change or additional
server creation was performed. API and worker are healthy. Gateway reported
`backend_active_binding` while the server was sleeping: its reachability proof
includes provider-owner identity and cannot be reused after the handoff. A normal
Owner-initiated Start is required to establish fresh actual backend proof; no
proof was forged and no automatic game start or Gateway restart was performed.
Do not claim post-migration sleep/wake validation until that test is completed.
Issue #18 remains the independent SFTPGo production-release gate.

The node editor no longer asks for a shared Pterodactyl user. Existing node rows
retain their legacy metadata; new rows derive that metadata from the ready Owner
technical account. New server creation always selects the individual server
owner's account. Two focused PostgreSQL checks cover omission, pending enrollment,
legacy validation and preserved existing-node identity. Explicit handoff helper
checks add three tests for approval, exact identity and stale/equal revisions.

For future approved migrations, run `node --import tsx
scripts/provider-account-handoff.mjs --owner-approved --server <local-uuid>
--expected-provider-id <id> --expected-provider-uuid <uuid>
--expected-owner-id <old-owner>` in the configured application environment. It
records intent before the remote effect, rejects active/uncertain operations,
verifies the technical target, preserves server details and checks remote state
before committing local ownership. A lost response is read back, not blindly
replayed. Review the durable plan before retrying. This is not automatic import
or a bulk reassignment tool. Rollback requires an explicitly reviewed reverse
handoff and matching credential deployment, not deletion of provider accounts.

The changed Owner node dialog was also exercised in Chromium: **1 passed, 2
intentionally skipped**, including the existing 2,000-allocation save flow and
an assertion that the provider-user selector is absent. Its
[sanitized desktop screenshot](screenshots/m5/owner-node-individual-account-desktop-en.png)
was inspected alongside the setup screenshot; no clipping or spacing regression
was found. These desktop images do not claim fresh mobile/Italian coverage.
The development HTTPS ingress returned 200 after migration.


## 2026-10-12 — 1.2.0 bulk upload credentials

The native Panel upload endpoint issues one locally signed, single-request Wings
JWT. It has no bulk operation. The extension now exposes
`POST /api/client/extensions/nickhosting/servers/{server}/upload-urls` with
`{count: 1..500}`. One authenticated request returns that many distinct native
15-minute tokens; no Wings request or game-file write occurs during issuance.
The native Client middleware, file-create permission, non-admin technical owner,
registered instance and exact managed-server identity remain required. Application
keys, browser sessions, foreign accounts and stale bindings cannot issue tokens.

NickHosting requests the group during existing upload preparation and retains
file-bound handoffs only in bounded API memory. Actual files still use independent
streaming requests and the configured concurrency. Expiry/restart may reissue
unused credentials together without replaying completed or uncertain effects.
Only an absent endpoint (404) permits the older single-URL path. The extension's
admin page now lists its six functions in short English/Italian bullets.

Source evidence: installed Panel 1.11.11 native Client middleware,
`FileUploadController`/`NodeJWTService`, and Wings 1.11.13 upload handling. Tokens
are single-use per request, not reusable credentials for a batch of requests.

Focused verification:

- Vendor-backed PHP/SQLite memory harness: **133 checks passed**. It covers native
  token verification/uniqueness, count/ownership/permission rejection and the
  existing technical-account/change-feed/settings functionality. No production
  database bootstrap is used by this harness.
- Package tests: **10 passed**; expanded PHP and shell-hook syntax passed.
- Adapter, scoped dispatch and private cache unit suites: **71 passed**.
- API/authenticated uploads and durable PostgreSQL batch integration: **80 passed**.
  The real adapter with fixture HTTP proves canonical paths, one issuance for 49
  uploads, cache loss, concurrent refresh, and one cancelled waiter while its
  sibling completes. External file mutations in these tests are mocked.
- Chromium upload/cancellation/refresh browser suites: **18 passed**, including
  the 49-file queue, independent outcomes, navigation and Italian mobile controls.
- TypeScript (Core/API and WebPanel), changed-file Biome and diff checks passed.
- Independent review identified and resolved path normalization, recovery-snapshot
  coalescing and shared-cancellation defects before rollout; no must-fix remained.

Sanitized actual Blade fixture renders, reviewed at desktop/mobile sizes:
[desktop English](screenshots/m5/blueprint-bulk-uploads-desktop-en.png) and
[mobile Italian](screenshots/m5/blueprint-bulk-uploads-mobile-it.png). These are
rendered extension views, not screenshots of the authenticated live Panel.

Archive SHA-256:
`5b106092327505c0af602d613414b904691562ea7be0ead974419bc825ef11b4`.
A private scoped pre-update backup and exact 1.1.0 archive are retained. Rollback
is the standard Blueprint update with that previous archive and reverting the
NickHosting change; it preserves existing settings/accounts and needs no reverse
schema migration. As before, rollback does not undo Blueprint's shared cache and
ownership housekeeping. No new migration or infrastructure resource is added.


The Owner-authorized standard Blueprint update completed successfully. Its hook
reported **Nothing to migrate**. Installed route discovery confirms the native
Blueprint Client auth/bindings, `api.client` throttle and server-access middleware.
A live check from the existing dev API, resolving credentials through its normal
protected store, returned extension **1.2.0** and `bulkUploadUrls:true`.
Exactly **49 distinct URLs in one request took 281.793 ms** (one sample, not an
end-to-end upload benchmark); adapter validation accepted the complete response.
Anonymous, Application-key and invalid-count requests returned **401/403/422**.
The unused tokens expire naturally; **zero files were uploaded**, and no game
server, key, account, allocation, network or provider setting was changed.
Panel/API/worker/Vite remained healthy without container restarts. An initial
ad-hoc health probe used the wrong default API port and failed to connect; the
actual configured `deploy/container-health.mjs api` check passed.

Commands: `python3 extensions/nickhosting/tests/run_php_tests.py --container
<existing-panel>`, `python3 -m unittest discover -s extensions/nickhosting/tests`,
`python3 extensions/nickhosting/package.py --output build/blueprint/1.2.0/nickhosting.blueprint`,
`pnpm exec vitest run` on the four affected unit files, and `pnpm exec tsx
scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts
apps/api/src/servers.integration.test.ts packages/server-management/src/upload-batches.integration.test.ts`.
Browser command uses the same isolated environment wrapper with
`--config vitest.browser.config.ts apps/web/tests/file-upload-cancel.browser.test.ts
apps/web/tests/file-upload-refresh.browser.test.ts`. pnpm commands use `scripts/dev.sh`.
The standard update was `blueprint -install nickhosting` in the existing Panel
container after copying the hash-verified package and preserving the previous
artifact. All private helper output excludes credentials and signed URLs.

## 2026-10-12 — 1.3.0 prepared downloads and operational settings

The Owner approved bulk signed downloads, per-file background replacement and
updating the installed extension. Blueprint now exposes Client transfer-settings
and download-urls routes, using native Client authentication, file-read permission,
server-state middleware and the exact linked nonadministrator managed owner.
It signs the supplied canonical paths without listing or opening files. A maximum
batch has five extension queries total: three settings and two identity/link
reads; native token signing still includes its existing per-token cryptography.
No production signer or Wings patch was made.

The administrator page now exposes these defaults, preserving existing values
and omitted fields:

| Setting | Default | Allowed range |
| --- | ---: | ---: |
| Download paths per batch | 2500 | 1–2500 |
| Upload URLs per batch | 500 | 1–500 |
| Signed URL lifetime, seconds | 900 | 60–900 |
| Webhook events per job | 10 | 1–10 |
| Webhook connect timeout, seconds | 2 | 1–2 |
| Webhook response timeout, seconds | 4 | 1–4 |

Webhook bounds retain the existing job/claim budget; connect timeout is clamped
to total timeout. Account restrictions, permissions, token uniqueness, identity
and destination validation remain compulsory. The UI includes seven short
feature bullets. Reviewed actual Blade fixture screenshots:
[desktop English](screenshots/m5/blueprint-transfer-settings-desktop-en.png) and
[mobile Italian](screenshots/m5/blueprint-transfer-settings-mobile-it.png).
These are sanitized framework-rendered fixtures, not live admin-session captures.

Checks: 207 vendor-backed PHP/SQLite-memory assertions, 11 package tests, and 25
expanded PHP source syntax checks passed. Independent review found no remaining
must-fix in extension authorization/settings or rendered EN/IT presentation.

The standard Owner-authorized `blueprint -install nickhosting` update succeeded
in the existing Panel container. The hook reported **Nothing to migrate**. Its
normal shared cache/queue/ownership housekeeping ran; no new network/container,
game-file mutation, account change or Wings configuration was performed. Private
scoped backups and the previous 1.2.0 archive were preserved. New artifact SHA-256:
`dd0514770d955acb39674b408cb384b55f223bb8f6982785bf277c46fab12944`.
Live route discovery confirmed native Blueprint Client/state/throttle middleware.

Live discovery returned 1.3.0, bulkDownloadUrls=true and the documented defaults.
A single authenticated batch generated 600 distinct path-scoped URLs in 238.487 ms;
none of those synthetic paths was opened. Anonymous/Application-key/unsafe-path
requests returned 401/403/422. Using the normal stored per-owner credential, the
same existing 10 KiB file was then read without mutation: native contents requests
203.767/182.405/215.405 ms, warm signed editor reads 3.749/4.043/2.970 ms,
and a streamed download 4.263 ms. Bytes/hashes matched privately. A cold editor
read took 344.962 ms including settings/token issuance; these are adapter timings,
not complete browser or API handler measurements. Network traces confirm only
one replacement path per consumed token, not regeneration of the folder.

Rollback uses the retained 1.2.0 archive through the standard approved update and
reverts NickHosting source. No schema rollback is needed; settings remain stored.
It does not reverse Blueprint's shared housekeeping. SFTPGo #18 remains unchanged.

## 2026-10-13 — 1.4.0-dev directory-list experiment

Historical prerelease record. Stable promotion and current defaults are recorded
in the [1.4.0 follow-up](#2026-10-13--140-stable-directory-batches).

The Owner chose a Blueprint batch experiment before considering direct Wings
access. This is a minor prerelease, not a stable replacement for 1.3.0. It adds
metadata reads and configurable batch bounds; no migration or recursive browser
prefetch is introduced. Ordinary `listFiles` continues using the native Client
API, so installing the extension does not automatically crawl any server.

`bulkDirectoryListings` capability discovery advertises two Client endpoints:

- `GET /api/client/extensions/nickhosting/servers/{server}/directory-settings`:
  `directoryBatchLimit` (default 24, range 1–64), `directoryConcurrency` (default
  2, range 1–4), and `directoryTimeoutSeconds` (default 8, range 1–10).
- `POST /api/client/extensions/nickhosting/servers/{server}/directory-list`:
  `{directories:string[]}` with unique canonical relative paths; `""` means root.
  The response is `{results:[{directory,files}|{directory,error}]}`, in the exact
  request order. Errors are `not_found`, `forbidden`, `unavailable`, `too_large`
  or `deadline_exceeded`. Failed reads are never presented as empty directories.

Native `file.read`, account-token authentication and server-state middleware
remain mandatory, followed by the exact managed technical-owner check once per
batch. Settings are also resolved once. The native node HTTP client retains its
credentials inside Panel; NickHosting receives no daemon token. Guzzle bounds
simultaneous reads and the whole-batch deadline, including queued paths. There
is no retry cascade, redirect following or signed-download preparation. Native
Wings still lists each directory and samples regular files for MIME detection;
the optimization removes repeated Panel request bootstrapping, not filesystem
work. Hard bounds are 4 MiB input per directory, 8 MiB aggregate input/output
and 10,000 entries per directory, with explicit errors instead of truncation.

The adapter exposes `getDirectoryBatchSettings` and `listDirectoriesBatch` as
explicit opt-in methods. It validates complete ordered results and bounded
responses; it does not automatically fall back or retry failures. Existing 1.3.0
discovery remains valid when the new optional capability is absent. Rollback is
the retained exact 1.3.0 archive through the standard Blueprint update procedure;
existing extension tables/settings/keys are retained. Framework cache, queue and
ownership housekeeping is not undone by that code rollback.

### Controlled installation and measurement

The standard authorized update installed **1.4.0-dev** successfully; its hook
reported **Nothing to migrate**. Artifact SHA-256:
`8424c25ca7b82bcfc636497376a797dfb69b4584cb46879c7a37d7622f83d630`.
A private scoped backup and the exact **1.3.0** archive (SHA-256
`dd0514770d955acb39674b408cb384b55f223bb8f6982785bf277c46fab12944`)
were retained. No new infrastructure or manual container restart was needed.
Blueprint performed its usual cache/queue/ownership finalization; no Panel core
patch, Wings modification or game-file mutation was made by this extension.
Native Client authentication/state/throttle middleware was verified on both new
routes. Live discovery/settings returned the expected version, capability and
24/2/8 defaults. Permission/path rejections and partial results were verified.

The [comparative benchmark](M5-DIRECTORY-BENCHMARK.md#2026-10-13--blueprint-140-dev-batch-comparison)
reused the existing fixture read-only. Three 24-directory rounds averaged
3557.4 ms native versus 393.8 ms batch; a 111-directory traversal took 14.8316 s
versus 1.8368 s. All successful metadata matched. The report preserves the initial
incorrect missing-directory smoke assertion, the installed native HTTP 500
finding, resource observations and sampling limitations. This supports bounded
prefetch exploration, not an automatic switch of the file manager or a claim
that single-directory latency disappeared.

## 2026-10-13 — 1.4.0 stable directory batches

The Owner approved stable promotion after the
[batch-size comparison](M5-DIRECTORY-BENCHMARK.md#2026-10-13--batch-size-and-concurrency-comparison).
Version **1.4.0** defaults to **48 directories / two concurrent Wings reads /
eight seconds**. Administrator labels no longer call this experimental. Existing
saved settings take precedence and are preserved, including the four-reader
override used in the last benchmark. Promotion does not silently reset Owner
configuration. Per-batch authorization, bounds, deadlines and native Wings
filesystem semantics are unchanged; there are no new migrations.

The independently reviewed archive was installed using the existing standard
Blueprint update command. The hook reported **Nothing to migrate** and the
installer completed successfully. Stable archive SHA-256:
`f11207f60ad38436100d6b552361c9d03211b5b9940cd4868f78ccdf417f5571`.
The exact 1.4.0-dev and 1.3.0 archives and a scoped pre-update file backup remain
private. Blueprint performed its normal cache/queue/ownership finalization;
no manual Panel core patch, Wings change, game operation or network change was
performed.

Read-only discovery confirmed version 1.4.0 and `bulkDirectoryListings=true`.
Live settings remained **48/4/8**, correctly preserving the saved override.
One batch over the existing balanced/wide fixture directories returned 12/502
entries, identical to the native API. No fixture file was created, changed or
deleted, and no signed download URL was needed for this check.

Validation: 12 package tests, 266 vendor-backed isolated PHP checks and 32
expanded PHP syntax checks passed. New regressions cover the 48-path boundary,
constant five-query batch authorization and saved override preservation. Actual
Blade fixtures were rendered and reviewed in Chromium:
[desktop EN](screenshots/m5/blueprint-directory-stable-desktop-en.png) and
[mobile IT](screenshots/m5/blueprint-directory-stable-mobile-it.png). They show
nine labelled settings, stable version/defaults, eight feature bullets and no
horizontal overflow. These are sanitized framework fixtures, not authenticated
production screenshots.

NickHosting's optional bounded prefetch uses the
[metadata API contract](M5-API-CONTRACTS.md#directory-metadata-batches-blueprint-140).
Rollback is the retained previous archive through the same standard update plus
a source revert; no schema rollback is required. A missing batch endpoint simply
disables optional acceleration, leaving native foreground navigation available.
It does not remove the existing technical-account/mail guards or weaken the
separate SFTPGo production-release gate in issue #18.

## 1.5.0 — committed backup notifications (2026-10-17)

Adds capability `backupEvents` and an extension-owned durable activity marker.
Native backup completion/failure and restore completion/failure enter the existing
signed outbox after commit. Marker recovery covers a process crash before callback
materialization. It does not change backup execution, storage, server ownership or
limits-feed revision. [Backups](BACKUPS.md) describes event correlation and the
upstream restore attempt-token limitation.

The isolated PHP harness uses the installed upstream ActivityLogService with
in-memory SQLite: 280 checks passed, including native subject ordering, rollback,
identity rejection, duplicate delivery, recovery and microsecond timestamps.
These are fixture/runtime compatibility checks, not a live game backup. Installing
this version and applying its additive migration remain a separate activation.

Reviewed 1.5.0 package SHA-256: `fd256f922bcd9b33355159a05d588fb91d54b1883e53c8fdee5c524e78a2b88f`.
The non-overwriting build is `build/blueprint/1.5.0-reviewed/nickhosting.blueprint`.
Package tests: 13 passed. This archive has not yet been installed.


Activation follow-up (2026-10-17): the Owner subsequently approved and installed
this exact reviewed 1.5.0 archive through the native Blueprint installer.
Its owned migration completed and the native queue worker reloaded. Authenticated
capability discovery confirms `backupEvents: true`; anonymous access is rejected.
Existing extension settings, instance links, technical accounts/keys and provider
server metadata were preserved. See the
[activation record](M5-ENVIRONMENTS.md#backup-workflow-activation-completed--2026-10-17).
No live game backup/restore was initiated; callback outcomes still need the Owner's
interactive test. The earlier not-installed statement records the pre-approval state.

### Deployment blocker: Panel tree contains Wings data

**Resolved for the inspected deployment on 2026-10-18:** the approved
[mount separation](#panelwings-mount-separation--2026-10-18) below removes the
traversal into Wings data. The following paragraph records the original incident.

The 2026-10-17 SFTP investigation confirmed that native Blueprint ownership
housekeeping traverses the deployment's `/app/var` bind mount into Wings volumes,
changing game files to the Panel's nginx user. See the
[incident evidence](M5-VALIDATION.md#sftp-upload-ownership-regression-discovered--2026-10-17).
Do not repeat native installation in that layout until an Owner-approved deployment
correction prevents this traversal. This is an observed failure, not an extension
payload issue. A successful installer exit or unchanged provider IDs does not prove
that game filesystem permissions survived. Do not automatically repair unrelated
servers or change the SFTP service identity as a workaround.


### 1.6.0 — Generic Fileman archive commit and guarded directory removal

The optional Client API endpoints are scoped through the existing managed server
link, technical user and per-user key. Discovery advertises `fileOperations`; scoped discovery returns `inspection`,
`guardedDelete` and `archiveCommit` only when implemented. Core caches
capability availability briefly; this does not cache permission to mutate files.
Each operation validates the exact provider identity in the extension.

Inspection returns a bounded regular guard file and opaque directory metadata
observation. Guarded deletion binds those observations to an operation UUID,
checks them again and uses one native Wings bulk-delete call. A durable receipt
prevents a repeated request from deleting a newly recreated path. These metadata
checks are not an inode compare-and-swap against arbitrary out-of-band writers.

Archive commit receives an already uploaded normalized ZIP in job-owned scratch,
an exact destination, archive digest and bounded member manifest (10,000 files,
4 MiB request maximum). It invokes native Wings extraction, verifies the resulting
entry metadata, checks the destination, publishes it and removes its scratch.
Core validates decoded sizes, CRC32 and SHA-256 while sending; the archive digest
in the commit request binds its receipt, rather than requesting a remote rehash.
A request-specific 90-second timeout covers extraction; ordinary API timeouts are
unchanged. Unknown outcomes retain the journal and are never blindly replayed.
The minimal commit requires ten Wings calls in seven dependency waves, contained
in one Panel request. This reduces Panel round trips; it does not remove Wings I/O.
Native rename has no atomic no-replace guarantee against unrelated writers.

The reviewed package is `build/blueprint/1.6.0-reviewed/nickhosting.blueprint`,
SHA-256 `96a84b8d0569486d66505d7a2541f6c7ffc0d61593c2cc90864d817d816648ee`.
The [bounded extension-only updater](../extensions/nickhosting/UPDATE-INSTALLED.md)
was dry-run against the identified installation and independently reviewed. It
changes twelve extension-owned files and runs one additive receipt migration,
without the native installer or recursive permission changes. The Owner subsequently approved this exact procedure and its scoped rollback.
Activation changed exactly the twelve listed extension files and applied only
the extension receipt-table migration. The updater verified its final result;
no native installer, global cache clearing or restart ran. A private rollback
manifest preserves original contents and ownership. The native-installer
deployment blocker above remains in force. No live extraction is proven by
activation itself.

### Panel/Wings mount separation — 2026-10-18

The Owner approved correcting the inspected deployment, with no game-data or
database backup. Only the Panel container was recreated, using its existing image
and named `/app` volume. Its `/app/var` bind now points to a dedicated `panel-var`
directory containing the exact existing `.env`. The original `var` tree, Wings
data paths, game mounts and SFTP mounts were not moved or modified. No Panel UI
setting, node configuration or game-server path needed changing.

Inspection found that the image's normal entrypoint unconditionally runs
`migrate --seed --force`, whose egg seeder can update existing default eggs.
Supervisord also starts a seeder and a recursive bind-mount ownership helper.
The private Compose configuration therefore supplies a controlled startup for
this **existing installation**: require the existing key and nginx configuration,
wait for the database, start cron and the usual PHP/nginx/queue services, but do
not initialize, migrate, seed or repair permissions. Original image scripts and
Panel/framework code remain unchanged. The extension-directory watcher still
runs; its initial archive-overwrite rsync is skipped. Future file events continue
to stage archives, and native Blueprint commands remain available.

This startup is not a first-install bootstrap. Future Panel/database upgrades
must explicitly review and apply their required migrations; starting the container
will not do so. A framework/image change requires reviewing the startup against
the new image. The mount separation removes the observed game-file ownership
hazard, but does not authorize an arbitrary extension install or guarantee every
third-party hook is safe. No native installer was rerun during this change.

Rollback preserves the previous image, named volume and original `var` directory.
Restore the old `/app/var` binding **while retaining controlled startup**, then
recreate only Panel. Do not blindly restore the original entrypoint: doing so
would reintroduce seeding and recursive permission changes during rollback.
Private configuration copies and exact guarded activation/rollback commands are
retained locally. No game files, database dump or whole `/app` backup was made.
See the [validation record](M5-VALIDATION.md#panelwings-mount-separation-validation--2026-10-18).
