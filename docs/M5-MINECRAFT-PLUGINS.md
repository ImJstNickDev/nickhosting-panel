# Minecraft Plugins

Plugins uses the same in-page discovery, version selection, preparation, review
and publication flow as [Mods](M5-MINECRAFT-MODS.md). It appears only for runtimes
declaring plugin support. Adding a catalog does not enable a runtime or claim
that every listed plugin works on it.

## Catalogs

| Provider | Source and behavior |
| --- | --- |
| Modrinth | Plugin projects and their declared Minecraft/platform compatibility. |
| Hangar | PaperMC's public project/version API and platform-specific artifacts. |
| SpigotMC | Third-party SpiGet catalog, with exact-version downloads where available. |
| CurseForge | The dynamically discovered Minecraft **Bukkit Plugins** class; uses the existing protected API key. |
| Voxel, builtbybit | Owner-requested placeholders: centered “Coming soon”, with no catalog or download requests. |

Catalog descriptions are untrusted content and reuse the existing sanitized
Markdown/HTML presentation. Premium, external-only or otherwise unavailable files
are not silently replaced with another version or downloaded by bypassing their
provider's distribution policy.

Paper accepts declared Paper, Spigot and Bukkit platform targets. Folia requires
an explicit Folia declaration; a Paper label alone does not imply thread-safe
Folia support. Compatibility is the provider's declaration, not a gameplay test.
SpiGet's tested Minecraft versions belong to the current resource, so historical
files do not inherit that claim. Missing declarations remain visible as
incompatibility and require an explicit version override.

Required/optional/conflicting dependencies are resolved when the provider exposes
structured references. SpiGet does not supply a dependency graph: its description
and the publisher's requirements remain relevant. No dependency names are guessed
into unrelated catalog projects.

Modrinth, Hangar and CurseForge artifacts retain publisher digest checks. SpiGet
does not publish an exact size or digest: only its fixed, exact-version HTTPS
proxy endpoint uses the separate bounded acquisition policy. Downloads are sealed
with their measured size and SHA-256 before publication. This is transport and
local artifact integrity, not a publisher signature. Every redirect still passes
the public-address and exact-origin policy. Arbitrary external download sites are
not implicitly trusted.

Clicking a result opens its description. The separate checkbox selects it and
prepares an automatically chosen compatible version in the background. Stable
versions take priority unless beta preference is enabled. Review keeps explicit
version choices, dependency information and incompatibility consent. Returning
to discovery retains the queue.

## Installation and isolation

Plugins and Mods share implementation, but retain separate directories, drafts,
receipts, preparation tasks and browser caches. Plugin files are published under
`plugins/`; generated `.pending` names cannot be loaded by the game. Apply uses
the existing Fileman publication path. Missing `plugins/` is created when needed.
Enable/disable is an immediate optimistic UI action backed by an asynchronous
rename, with visible error recovery. These actions do not stop the server or
attempt Java class hot-reloading. Console shows the existing restart advisory.

The additive migration `049_minecraft_plugins.sql` creates the plugin lifecycle
tables and permits plugin provenance in the shared source store. No game files,
existing mod records, runtime mappings or provider configuration are migrated.

All endpoints are below `/v1/servers/:id/minecraft/plugins`, sharing the Mods route
contract: inventory, `/catalog`, `/catalog/search`, project details/versions,
`/selection`, `/changes`, `/toggle`, `/apply`, `/recover`, `/updates`,
`/alternatives` and `/restart-status`. Read access follows current server access;
publication and selection require current manage permission and the existing
Fileman mutation scope. Activity records plugin publication/recovery with the
actual actor. Provider keys and artifact URLs remain server-side.

## Sources

- [Modrinth API](https://docs.modrinth.com/api/operations/searchprojects/)
- [Hangar API](https://hangar.papermc.io/api-docs)
- [SpiGet API schema](https://github.com/SpiGetOrg/Documentation/blob/master/swagger.yml)
- [CurseForge API](https://docs.curseforge.com/rest-api/)

## Validation

- Provider catalog, resolver and acquisition suites: 178 passing tests, including
  exact-version SpiGet transport, size ceilings, dependency blockers and bounded
  alternative selection.
- Shared Mods/Plugins backend and API: 51 integration tests and 33 focused unit
  tests passing; plugin Activity authorization also exercised separately.
- UI/controller unit tests: 20 passing. Firefox: 35 existing Mods scenarios and
  3 Plugins scenarios passing, with no reported Axe accessibility violations.
- Root/web typecheck, production frontend build, translation consistency and
  changed-file formatting/lint checks passed.
- Real catalog search/details/version reads passed for Modrinth, Hangar, SpiGet
  and the configured CurseForge Bukkit catalog. No plugin was installed on a
  live game server during validation; publication tests use isolated fixtures.
- Backend, provider and UI/configuration changes received independent review.

Reviewed browser screenshots use isolated fixture data:
[discovery](screenshots/m5/minecraft-plugins-discover.png),
[mobile discovery](screenshots/m5/minecraft-plugins-discover-mobile.png),
[providers](screenshots/m5/minecraft-plugins-providers.png),
[review queue](screenshots/m5/minecraft-plugins-review.png),
[installed](screenshots/m5/minecraft-plugins-installed.png),
[mobile installed](screenshots/m5/minecraft-plugins-installed-mobile.png),
[placeholder](screenshots/m5/minecraft-plugins-coming-soon.png),
[mobile placeholder](screenshots/m5/minecraft-plugins-coming-soon-mobile.png).

## Activation and rollback

Development activation completed on 2026-10-21 after Owner approval, using
implementation commit `3992253f7ce09d315049d143a6cb78e1aad61a1a`. Only migration
049 was applied; existing records and earlier migration checksums were preserved.
The one-shot migrator completed and was removed normally. Application and provider
containers retained their IDs, images, mounts, networks and start times; no recovery
restart was needed. Live Firefox checks passed for HTTPS, secure HMR, desktop/mobile
Plugins, all four real catalog searches and both placeholder providers. No live
plugin installation was performed.

Development source hot reload does not apply SQL migrations. Build the migrator
image and apply migration 049 only after approval of the concrete activation
operation, using the complete existing Compose environment chain. No Blueprint,
Pterodactyl or Wings update is required.

Before code rollback, let preparation finish or cancel it and reconcile any
uncertain publication through the current implementation. Preserve the additive
tables, provenance and game files; do not drop data or remove plugin directories.
Retain applied migration 049 and its unchanged checksum when reverting application
code; the migrator deliberately rejects missing or modified applied migrations.
Returning to earlier code leaves the new plugin management unavailable without
requiring a destructive database downgrade.
