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
