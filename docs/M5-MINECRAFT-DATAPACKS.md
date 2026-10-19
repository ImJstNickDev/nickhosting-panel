# Minecraft datapacks

Datapacks belong to a world. The Minecraft tab starts on the configured world;
the world selector also exposes the other discovered worlds. The inventory reads
the actual server directories, including packs uploaded through Fileman/SFTP or
included with an imported world. Filesystem presence and Minecraft's loaded pack
selection are distinct observations.

Before the first world exists, the default inventory read returns an empty
`worlds` list, empty packs/changes and `world: ''`. The tab shows a centered,
localized empty state rather than an error or unavailable actions. Missing
`server.properties` is allowed during this discovery. An explicitly requested
missing world still returns 404; provider/authorization failures remain errors
and are never disguised as an empty inventory.

## Task flow

1. Choose packs from Modrinth/CurseForge, or upload a ZIP/folder. Folder uploads use
   the existing Fileman archive worker with `pack.mcmeta` as the root marker.
2. Acquisition, archive metadata inspection and transfer happen during preparation.
   A prepared ZIP ends in `.pending`; Minecraft cannot discover it yet. Other
   changes are durable drafts. Closing a dialog does not apply them. Catalog selections waiting locally
   survive closing the catalog dialog; leaving the tab discards selections not
   yet submitted. Prepared drafts persist in the database across reloads. Inventory refreshes on
   completion, window focus or explicit refresh, without full-directory polling.
3. **Apply changes** publishes the prepared changes. ZIP enable/disable uses
   `.zip`/`.zip.disabled`. Disabled directories live outside `world/datapacks`:
   renaming a directory to `.disabled` inside it would still load the pack.
4. The active running world receives one reload for ordinary filesystem changes.
   Offline/inactive worlds use the published files on their next load. A saved
   native command-disabled pack needs Minecraft's explicit enable command, which
   itself triggers a reload; that exceptional case cannot be presented as a
   simple filename toggle. It is applied alone, for the active running world, to
   avoid racing multiple asynchronous native reloads.

The interface keeps preparation, file publication and reload dispatch separate.
Minecraft's `Reloading!` message is emitted before its asynchronous reload and is
not proof of successful resource loading. World-generation changes, experimental
feature flags and pack functions may require additional game-specific conditions.
No automatic server restart or world conversion is performed.

## Shared services and durability

Core's existing Fileman scopes own provider identity, current permissions, signed
transfers and bounded directory reads. Datapack operations do not introduce a
second Pterodactyl adapter or a new Blueprint endpoint. Preparation uses the
existing protected content-source acquisition and storage budgets. Paths and
download credentials never come from an untrusted provider URL submitted by a
browser.

Migration `044_minecraft_datapacks.sql` adds the datapack source kind and durable
change/apply receipts. Same-name pending changes are unique per server/world.
Preparation is separate from publication: the Apply path does not download,
extract or rehash each archive. Current authorization and final conflict checks
remain at the mutation boundary.

Wings bulk rename is concurrent, not transactional; missing sources can return
HTTP 204. Independent moves can share one request. Replacing an existing pack
requires ordered retirement/publication phases and a bounded final directory
receipt. An interruption is reconciled from the recorded paths, never treated as
permission to blindly replay the entire batch. Cleanup of retired files runs
after publication, with a durable receipt and audit, without delaying Apply.
An unpublished generated pending file can be discarded explicitly; this does not
clear an uncertain shared storage claim. Those claims retain the existing Owner
recovery procedure because deleting a destination does not prove that a remote
multipart upload has stopped. Recovery of an interrupted replacement can restore
the recorded retired original before allowing a new explicit Apply. Replacing a
disabled ZIP preserves its disabled state.

## Metadata and catalogs

`games/minecraft/src/datapacks.ts` interprets legacy `pack_format`, legacy
`supported_formats`, and modern `min_format`/`max_format`. Major/minor pairs are
compared numerically. An integer modern maximum includes all minor versions of
that major. Declared format compatibility is not gameplay certification.

The bundled numeric format catalog is extracted from the pinned version metadata
source recorded in `datapack-formats.json`. Unknown releases remain unknown; world
`DataVersion` is never substituted for pack format. No Mojang request is made
during inspection or Apply. Historical versions without datapacks are marked
unsupported.

Modrinth discovery uses `all_project_types:datapack`, including projects whose
primary type is `mod`, and selects versions with the `datapack` loader. CurseForge
resolves its `data-packs` class from the categories API. Both retain archive
hashes, provenance and distribution restrictions. Catalog files remain browsable
when they declare dependencies. Selecting one resolves a bounded, memoized graph
for the server release before any archive transfer. Required datapacks are prepared
automatically, optional dependencies are opt-in, and embedded dependencies are not
fetched separately. Explicit version pins, cycles, shared dependencies and mutually
incompatible requirements are handled without one request per repeated edge.
Provider-declared restrictions are not waived by dependency resolution.

The plan prefers known compatible installed or prepared versions for unpinned
requirements; an explicit provider pin takes precedence. Dependencies disabled on disk are staged for enabling. A pack explicitly disabled
in Minecraft’s saved selection must first be enabled through its existing native
enable action; it is not silently treated as active. Conflicting installed datapacks require explicit approval
to stage their disable; they are not deleted. Mods are never installed from this
tab and the runtime is never changed: a mod requirement can only be satisfied by
a compatible, identified installed mod with verified bytes. Files larger than the
64 MiB bounded identity read remain unverified rather than assumed compatible. Unknown local files
are not matched by filename. Local uploads do not manufacture provider dependency
metadata, so undeclared relationships cannot be inferred.

Plans use a bounded server-side cache, scoped to the actor, subject, server and
world, with a ten-minute lifetime. A stale plan is resolved again during preparation.
Each prepared/installed receipt persists provider identity, dependency and conflict
information in the existing JSON plan; no new database migration is required.
Apply uses these receipts and a shared filesystem observation to validate the final
selection. Cancelling a required preparation, removing/disabling a required pack,
or introducing a conflict cannot silently publish a broken graph. Apply does not
resolve provider metadata, download archives or rehash installed mods. Removing a
consumer does not automatically remove its dependencies. Opting into an optional
pack does not convert it into a mandatory dependency; it remains removable.
Current receipts are selected per filesystem path in PostgreSQL rather than
truncated with audit history. A conflict with an unpublished draft asks the user
to discard that draft; it never offers to disable a nonexistent published path.

The protected `POST /v1/servers/:id/minecraft/datapacks/catalog/plan` returns public
items, optional additions, conflicts and named blockers, never download URLs. The
existing `/catalog/acquire` accepts its `planId` and explicit `disablePaths` decisions
and prepares the graph through the same source store and Fileman service. Both
operations retain current server-management authorization. Expected failures use
localized `content_dependency_missing`, `content_dependency_conflict`, and
`content_plan_expired` errors.

Manual ZIP metadata is inspected on demand, rather than downloading every pack
while listing a world (ZIP inspection is bounded to 8 MiB). Prepared metadata
can be reused when size, modification time and target release still match the
shared directory observation. Saved selection in `level.dat` is read through the existing
bounded Minecraft NBT decoder. It can lag the live state of a running server.

## Evidence and activation boundaries

Automated tests use isolated databases and provider/file fixtures. They establish
API, authorization, staging and publication behavior, not that every arbitrary
datapack works in a real Minecraft process. Real server reloads and performance
measurements must be reported separately. Neither passing tests nor adding this
tab authorizes a production deployment or waives SFTPGo issue #18.

Apply the new migration explicitly before using the new API. Normal application
startup still does not migrate databases. Rollback preserves the additive tables,
prepared files and receipts; do not drop them or delete pending files as an
automatic rollback action. Existing worlds and live game files are not migrated.

## References

- [Minecraft 1.21.9 pack-format changes](https://www.minecraft.net/en-us/article/minecraft-java-edition-1-21-9)
- [Modrinth dependency metadata](https://docs.modrinth.com/api/operations/getdependencies/)
- [Modrinth project search](https://docs.modrinth.com/api/operations/searchprojects/)
- [CurseForge REST API](https://docs.curseforge.com/rest-api/)
- [Wings batch rename implementation](https://github.com/pterodactyl/wings/blob/v1.11.13/router/router_server_files.go#L89-L149)

Pack discovery and reload behavior were also checked against the official 26.1
client, SHA-1 `191771837687b766537a8c4607cb6fad79c533a1`, specifically `PackDetector`,
`FolderRepositorySource`, `ReloadCommand` and `DataPackCommand`. This source check
does not claim real-client testing of every historical release.

## UI evidence

- [Desktop inventory](screenshots/m5/minecraft-datapacks-desktop-en.png)
- [Italian mobile inventory](screenshots/m5/minecraft-datapacks-mobile-it.png)
- [Prepared catalog changes](screenshots/m5/minecraft-datapacks-prepared-en.png)
- [Required mod not installed](screenshots/m5/minecraft-datapacks-dependencies-en.png)
- [Italian mobile dependency details](screenshots/m5/minecraft-datapacks-dependencies-mobile-it.png)
- [Optional dependencies and explicit conflict decision](screenshots/m5/minecraft-datapacks-conflicts-en.png)
- [Available and unavailable catalog releases](screenshots/m5/minecraft-datapacks-catalog-unavailable-en.png)

Catalog releases carry individual distribution/archive availability reasons.
Dependency blockers and conflict decisions are returned by the preparation plan. One unavailable release does not invalidate the rest of the project list.
The UI and backend consume the same strict datapack receipt schema; world catalogs
retain their separate strict contract. These reasons do not bypass installation guards.

These are real browser captures against isolated application handlers and provider
fixtures, not screenshots of a live game-server installation.
