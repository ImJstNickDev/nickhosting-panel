# Provider ownership and coordinated upgrade readiness

Read-only assessment, 2026-10-19. Tracked in
[issue #27](https://github.com/ImJstNickDev/nickhosting-panel/issues/27), under M5
PR #21. This is an assessment, not an executed upgrade or an activation runbook.

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
