# Minecraft datapacks

Datapacks belong to a world. The Minecraft tab starts on the configured world;
the world selector also exposes the other discovered worlds. The inventory reads
the actual server directories, including packs uploaded through Fileman/SFTP or
included with an imported world. Filesystem presence and Minecraft's loaded pack
selection are distinct observations.

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
hashes, provenance and distribution restrictions. Required/incompatible dependency
resolution is not yet implemented for datapacks: such catalog files are explicitly
unavailable, rather than installed without their dependencies. Local uploads do
not manufacture provider dependency metadata.

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

These are real browser captures against isolated application handlers and provider
fixtures, not screenshots of a live game-server installation.
