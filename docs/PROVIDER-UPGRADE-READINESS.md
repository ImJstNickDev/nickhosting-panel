# Provider ownership and coordinated upgrade readiness

Initial read-only assessment and completed coordinated activation, 2026-10-19. Tracked in
[issue #27](https://github.com/ImJstNickDev/nickhosting-panel/issues/27), under M5
PR #21. The initial assessment is preserved below; the final section records the
approved live activation and its verification boundary.

The subsequent [API compatibility assessment](PROVIDER-API-COMPATIBILITY.md)
covers the entire consumed provider boundary, including upload cancellation,
WebSocket throttling and HTTP cooldown changes beyond the Blueprint extension.

## Directory ownership defect

The inspected Wings 1.11.13 implementation runs as root and assigns the game
UID/GID to newly written regular files, but does not consistently assign it to
new directories. `CreateDirectory` calls `MkdirAll` without changing ownership;
`Write` can create missing parents through `Touch` and changes only the final
file's ownership. Archive extraction uses those same write paths.

NickHosting's folder operations, world import and creation of datapack directories
exercise these native operations. Read-only metadata inspection found 201
root-owned directories across three imported worlds in a managed test fixture.
They existed before the latest Blueprint extension update and their ownership and
modes were unchanged by that update. An uploaded file with correct ownership does
not establish that the game or SFTP user can write its parent directory.

Wings [PR #328](https://github.com/pterodactyl/wings/pull/328), released in
[1.13.0](https://github.com/pterodactyl/wings/releases/tag/v1.13.0), fixes creation
by tracking and changing ownership of the directories actually created. Prefer
this upstream fix over a NickHosting repair request or recursive scan per file.
Existing incorrect directories still need a separately approved, exact repair.
Do not use world-readable permissions or a game-server start as a repair tool.

## Candidate coordinated versions

| Component | Inspected installation | Candidate release |
| --- | --- | --- |
| Panel | 1.11.11 | [1.15.1](https://github.com/pterodactyl/panel/releases/tag/v1.15.1) |
| Wings | 1.11.13, image with curl added | [1.13.4](https://github.com/pterodactyl/wings/releases/tag/v1.13.4) |
| Blueprint framework | beta-2025-09 | [beta-2026-08](https://github.com/BlueprintFramework/framework/releases/tag/beta-2026-08) |
| NickHosting extension | 1.7.0 | Compatibility update required; not yet released |

These are candidates for validation, not a claim that the installed extension
set is compatible. Do not replace pinned releases with `latest` during execution.

Wings 1.13 requires scoped tokens for WebSocket, upload and download operations.
The installed Panel's token producers use the earlier contract. Therefore an
isolated Wings update would break those operations. New Panel versions require
callers of `NodeJWTService` to set scopes explicitly; they are not inferred from
the claims. NickHosting's three token producers must be adapted and tested before
the coordinated activation. New Panel also changes framework/dependency versions;
passing PHP syntax checks alone is insufficient.

The candidate Panel migration set includes clearing notes on unassigned
allocations. This is a provider data change, not just a code replacement, and must
be included in the approval and database rollback scope. Do not run blanket
database seeding as part of the update.

## Installation-specific constraints

The current Panel code is in a persistent application volume. Changing the image
alone does not update that code. A generic `down -v`/reinstall recipe would discard
the customized installation and is not an acceptable update procedure here.

The approved separation of Panel state from Wings game data must remain intact.
The controlled existing-installation entrypoint disables automatic seeding,
migration and recursive permission helpers. Its assumptions about image helper
and supervisor files must be reviewed against the chosen image. Do not silently
replace it with the new image's ordinary initialization entrypoint.

Installed extensions and staged archives are not identical inventories. Preserve
the exact installed code and metadata; validate each required extension or obtain
an explicit Owner decision before removing or replacing one. Do not assume every
extension can be reconstructed from the archive directory. The normal Blueprint
extension installation workflow must not be changed without Owner approval.
The framework upgrade itself can remove extension trees while retaining the
development directory; preserve extension code/private state and review the
explicit reinstalls before running that updater. Do not install every staged
archive indiscriminately.

The new Wings configuration and image also need review, including generated
machine-ID handling, filesystem paths, UID/GID, healthcheck tooling and shutdown
behavior. Preserve existing game allocation bindings, networking and data paths.
Do not automatically update MariaDB, cache services or other containers as part
of a Panel/Wings upgrade.

## Preparation and rollback requirements

1. Pin and inspect the exact candidate artifacts and prepare compatibility changes
   to the NickHosting extension with tests for old and new supported contracts.
   Resolve the remaining third-party extension compatibility questions.
2. Prepare explicit Compose/code/configuration changes and startup commands,
   with independent review. Keep application code and database migrations as
   explicit steps rather than image-start side effects.
3. Prepare recovery of the old Panel application volume, installed extensions,
   external Blueprint archive/development bind mounts, persisted Nginx
   configuration, private configuration/encryption keys, Wings configuration and
   exact old images. An application-volume copy alone misses the external binds.
   The inspected Panel code/dependencies are roughly 700 MiB and its database
   allocation roughly 4.5 MiB; these are separate from the large game-data volumes.
   Recheck sizes before copying. No game-data backup is proposed for this update.
4. Before migration, take a consistent protected Panel database dump with a
   verified restoration procedure. Coordinate a maintenance window and quiesce
   incoming provider-mutating requests and Panel, extension and NickHosting jobs;
   account for in-flight Wings/extension callbacks before the dump. Laravel
   maintenance mode alone does not stop all workers or external writers. Record
   the boundary after which rolling back the database could discard new actions.
5. Obtain operation-specific approval for the reviewed activation and rollback.
   Only then apply the coordinated update, validate it, and reopen writes. Do not
   promise zero interruption: console/file/SFTP connections can be interrupted.
   Existing game processes must not be stopped or recreated implicitly.
6. If validation fails before reopening writes, restore matching application
   code/configuration/images and database state together. An image downgrade alone
   does not reverse database migrations; `migrate:rollback` is not a substitute
   for a demonstrated full restoration path.

No database dump, image pull, live update, permission repair, service restart or
test-server mutation was performed during this assessment.

## Acceptance and follow-up

- Native Panel and NickHosting login, provider discovery, per-user Client API
  access, WebSocket console/installation streams and signed upload/download URLs.
- Managed fixture operations: nested directory creation, upload with missing
  parents, archive extraction with implicit/empty directories, world import and
  datapack preparation. Verify game/SFTP write access and correct owners/modes.
- Existing directory metadata must remain unchanged. Include copy/move/restore
  paths that actually create parents; do not assume the upstream mkdir fix proves
  every filesystem operation.
- Read-only viewers and user SFTP need separate checks. The viewer service was
  configured with an identity matching earlier incorrect ownership and is now
  stale. Realignment requires updating its small private state and process
  identity together; its game-data mount stays read-only.
- Repair only the confirmed previously affected directories after refreshing
  their exact path/inode/ownership manifest and obtaining approval. Do not run
  blanket recursive chown/chmod over the game volumes.
- Retire temporary compatibility measures only after replacement evidence exists.
  Keep SFTP issue #18 and the M5 production-release boundary independent.

Machine-specific paths, identifiers, manifests, credentials and eventual backups
belong only in ignored private infrastructure state.

## Coordinated upgrade preparation, 2026-10-19

The Owner authorized the coordinated update and selected **only NickHosting**
for reinstallation. The approved live activation is recorded below. The earlier
read-only assessment above describes its original evidence boundary; the work
below includes isolated rehearsal and application compatibility changes.

### Extension inventory

| Extension | Previous version | Upgrade disposition |
| --- | --- | --- |
| NickHosting | 1.7.0 | Installed reviewed 1.8.0 |
| Subdomain Manager | 1.0.2 | Do not reinstall; retain code, archives and database state |
| Minecraft World Manager | 3.1.1 | Do not reinstall; retain code, archives and database state |
| AddressConfigurator | 1.0 | Do not reinstall; retain installed source and database state |
| Minecraft Modpack Installer | 3.4.2 | Do not reinstall; retain code, archives and database state |
| Egg Changer | 1.1.0 | Do not reinstall; retain code, archives and database state |
| MC Logs | 1.6 | Do not reinstall; retain code, archives and database state |

This is an explicit Owner choice, not a claim that the six excluded extensions
are compatible. Rehearsal identified an old Modpack Installer controller that
would remove new native node authorization checks; no third-party patch is
being applied. Retaining an extension's database tables does not enable it.

### Rehearsal and compatibility evidence

- Copied Panel application code and a consistent small database dump into an
  isolated installation without game mounts, Docker socket or published ports.
  Game data was not backed up or copied.
- Followed the official [Panel update](https://blueprint.zip/guides/admin/updatepanel)
  and [Blueprint update](https://blueprint.zip/guides/admin/updateblueprint)
  procedures: pinned Panel archive, production Composer dependencies, explicit
  migrations without default egg seeding, then native framework update.
  Updating from beta-2025-09 required a second native `blueprint -upgrade`
  invocation; the resulting CLI reports beta-2026-08.
- Native `blueprint -install nickhosting` installed the final 1.8.0 artifact
  successfully. Its SHA256 is
  `1628eea75493d5b1a9fa23d4f420bae1c5c903802af28da75f99c490b2492108`.
  This replaces the earlier intermediate 1.8.0 test artifact.
- NickHosting migration `000006` adds a nullable recovery-context column to the
  existing file-operation ledger. It preserves original receipts and records
  the paths needed to recover interrupted upload publication.
- Restored the old database into an emptied **isolated** schema, demonstrating
  that target-only tables are removed on rollback; reapplied native and
  extension migrations successfully afterward.
- Native PHP checks passed against both Panel generations, including scoped
  tokens, managed-resource authorization and interrupted publication. Actual
  Wings 1.13.4 filesystem tests exercised upload failure, rename behavior,
  restrictive file modes and nested-directory ownership.
- Prepared application changes cover streamed upload staging/publication,
  bounded token renewal, WebSocket limits and shared credentials, scoped HTTP
  cooldowns and backup exclusion validation. See
  [API compatibility](PROVIDER-API-COMPATIBILITY.md) for guarantees and limits.

### Activation and rollback constraints discovered in rehearsal

Laravel maintenance mode also blocks Wings `/api/remote`. Before starting the
new Wings, bring Laravel up behind a temporary write freeze that permits native
authenticated remote routes; keep queue workers and cron disabled until
verification finishes. The ingress rule must use the normalized path, survive
the PHP internal redirect, and reject traversal and prefix-confusion bypasses.
Sixteen isolated Nginx/PHP routing checks cover this behavior. Restore the exact
original ingress configuration afterward.

Drain **all** provider operations and queues, not only NickHosting jobs. Verify
Docker state against Wings' persisted states immediately before stopping it.
Wings 1.13.4 creates missing registered-server containers during bootstrap,
unlike the previous boot path; it also attempts image pulls for these containers.
The observed installation has 15 missing containers for pre-existing servers.
Their data roots exist and all persisted states are offline, but creating them
required additional Owner approval before activation. The Owner approved the
exact private inventory and rollback; all 15 were created and remained stopped.
Their exact container IDs are retained in the private rollback ledger.

Use a new application code volume and retain the old volume and exact images.
Keep provider database/cache services, game mounts, UID/GID, networks and ports
unchanged. Preserve prior effective API limits explicitly and disable the new
machine-ID mount behavior in Wings. The Wings healthcheck must use its actual
configured listener; listener liveness alone is not an authenticated readiness
test.

Before opening writes, rollback restores the matching old code, configurations,
images and final quiesced Panel database. Remove only newly created, still-stopped
containers identified in the activation ledger, without deleting volumes.
Once writes reopen, reconcile subsequent actions before any database restore.
Source-mounted NickHosting compatibility changes also belong to the rollback;
reverting only a container image does not revert those sources.


## Completed live activation, 2026-10-19

| Component | Activated version |
| --- | --- |
| Pterodactyl Panel | 1.15.1 |
| Wings | 1.13.4; image binary matches the official release SHA256 |
| Blueprint framework | beta-2026-08 |
| NickHosting extension | 1.8.0; native Blueprint installation |

Only NickHosting was reinstalled. The six extensions listed above remain inactive;
their old code and private state were preserved for rollback. The existing Panel
application volume and old provider images were retained. The replacement code
volume was prepared with the native update workflow against an isolated copy;
production received explicit native migrations and the normal
`blueprint -install nickhosting` command. No default database seeding ran.

### Configuration changes

Machine-specific absolute paths remain in the private infrastructure notes.
Relative to the current provider installation, the changed files were:

- `docker-compose.yml`: pinned the reviewed Panel/Wings image digests, selected
  the new Panel application code volume, retained the controlled entrypoint, and
  corrected Wings' healthcheck to its existing HTTP listener. The temporary boot
  marker held Panel queue/cron during migration. Existing ports, networks and
  game-data mounts were preserved.
- `srv/pterodactyl/panel-var/.env`: explicitly retained Client API limit 720,
  Application API limit 240, and existing identifier-based routes with
  `PTERODACTYL_USE_SERVER_IDENTIFIERS=false`. Existing credentials and encryption
  keys were preserved.
- `srv/pterodactyl/wings/config.yml`: disabled new automatic machine-ID mounts.
  Wings also serialized its new upstream defaults for download/restore allowlists,
  SFTP connection limits, passwd generation and CPU scheduling. Existing values,
  game paths and UID/GID were preserved; no hand-written provider patch was used.
- `srv/pterodactyl/nginx/panel.conf`: temporary maintenance write gate, subsequently
  restored byte-for-byte with its original ownership and permissions. The external
  reverse proxy, DNS, certificates and firewall were not changed.

The final Panel database dump was taken after quiescing all provider/NickHosting
writers and verifying empty operation queues. Restoring that dump into an emptied
isolated schema succeeded before live migrations. The exact write-reopening time
is recorded privately; any later database rollback must first reconcile new user
actions. No game-data backup was made, as requested by the Owner.

### Verification and data boundary

- Independent before/after no-follow scans covered **29 game roots and 3,413,483
  entries** with zero errors. All 29 digests matched: path, UID/GID, permissions,
  type and inode were unchanged. This is metadata evidence, not a full file-content
  checksum or a promise of zero operational risk.
- All **14 existing game containers** retained their IDs, images, configuration,
  mounts and start/finish timestamps. The **15 explicitly approved missing
  containers** were created by Wings and never started. No game power commands,
  installs, reinstalls or game-file mutations were issued by the validation.
- The 203 pre-existing root-owned entries remained unchanged. Updating Wings
  prevents the covered creation defect; it does not retroactively repair existing
  entries. Exact repairs remain separately scoped under issue #27.
- Database fingerprints for servers, users, API keys, nodes, allocations, nests,
  eggs, egg variables, mounts and NickHosting identity links matched. Expected
  migration/settings/environment changes were retained. All five managed identity
  and technical-owner links passed the independent native PHP checks.
- All 52 installed extension files matched the reviewed package. Its six migrations
  and bounded settings passed checks. Native authenticated Panel-to-Wings discovery
  reported 1.13.4.
- The smoke report contains thirteen successful result records, including artifact,
  database and completion records. The live checks cover: extension discovery, managed identity,
  upload-publication capability, scoped upload/download token issuance, directory
  listing, identical bounded content via Panel and direct Wings download, authenticated
  console/installation WebSockets and anonymous denial. No upload or command was
  sent during these live checks.
- Panel login and NickHosting HTTPS returned 200. Panel queue/cron were resumed;
  existing dev API, worker and Gateway were restarted without replacing their
  images, storage or configuration. Panel, Wings, dev API, worker, Vite and web
  ingress are healthy. Gateway has three admitted routes and two pre-existing
  `backend_active_binding` failures: those two game containers were already
  never-started before the update and have no initial reachability proof. Its
  degraded readiness is not a new provider regression; no game was started to
  manufacture that proof.

Preparation validation included 323 transfer unit checks, 117 database/integration
checks, 459 native PHP assertions against each supported Panel generation, three
actual upstream Wings filesystem cases, 28 Python updater checks, 43 console
checks, seven backup checks and 16 isolated ingress cases, plus typecheck and
format/lint checks on changed code. Live game creation, a full backup/restore and
real game login were deliberately not repeated during activation; those behaviors
are not established by the read-only smoke test alone.

### Corrected activation issues and rollback retention

An initial code-copy exclusion also omitted Blueprint's `.blueprint` directory.
It was corrected in the new application volume before live migrations and before
reopening writes; the old code volume and game directories were unaffected. A
private quiescence query quoting error and a private smoke-script environment flag
were corrected without changing application behavior. Wings' first bootstrap
spent about six minutes pulling missing images before opening its listener.

The two isolated rehearsal containers were stopped; their private state is retained.
Small private code/configuration/database backups, the old application volume and
old images remain available for rollback. Do not blindly restore the pre-upgrade
database after user writes resume. Keep SFTP issue #18 and the M5 production-release
gate independent of this provider update. PR #21 remains open and unmerged.

### Subsequent Owner-authorized ownership correction — 2026-10-19

After the upgrade verification, the Owner separately authorized repair of the
203 pre-existing root-owned entries. An independently reviewed, manifest-specific
helper changed only their UID/GID to Wings' configured identity, preserving modes,
without recursion, symlink traversal, service restart or content writes. A private
durable journal and exact inode metadata support scoped rollback. The helper was
removed after success.

A second full scan covered the same 29 roots and 3,413,483 entries: exactly 203
ownership corrections, no remaining ownership anomaly, and unchanged modes/types.
One concurrent application world-selection job replaced `server.properties` with
correct ownership/mode; its worker event explains the sole additional inode change.
This follow-up does not change the earlier evidence that the provider upgrade
itself preserved the game metadata. See the dated M5 validation record.
