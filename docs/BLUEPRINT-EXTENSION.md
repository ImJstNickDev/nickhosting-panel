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
