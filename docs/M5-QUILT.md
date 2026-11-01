# Quilt runtime follow-up — 2026-10-31

The Owner requested Quilt in the existing M5 integration after importing the
supplied exact-version egg. Pterodactyl remains responsible for installation.

## Catalog and egg contract

Discovery uses [Quilt Meta v3](https://meta.quiltmc.org/): independent game, loader
and installer catalogs, preserving raw response provenance with bounded requests
and bytes. Minecraft releases and snapshots remain distinct. Loader prereleases
are identified from the version identifier; API list position is not a tested
compatibility guarantee. The installer is selected internally from the accepted
catalog and pinned with the chosen Minecraft/loader pair at creation. Catalog
refreshes do not upgrade existing installations.

Resolution validates the exact pair and server-profile identities, trusted Maven
library coordinates and checksums. Quilt Loader uses its upstream SHA-256;
other libraries use upstream Maven SHA-1 checksums. These are integrity metadata,
not signatures. The vanilla server uses Mojang metadata and Java requirements.
Modern releases without historical intermediary mappings are not excluded just
for lacking those mappings. Unsupported/missing metadata fails closed.

The imported egg must declare `MC_VERSION`, `QUILT_LOADER_VERSION`,
`QUILT_INSTALLER_VERSION` and `SERVER_JARFILE`. The older two-variable egg is not
eligible for automatic binding. A custom safe launcher filename is accepted;
`minecraft.jar` is reserved for vanilla. The ptero-eggs image policy selects only
known Java majors advertised by the actual egg. No egg edits are included.

## Installation and management

The egg removes the installer, so installed verification does not require it.
The integration verifies vanilla's hash/size, the manifest-only launcher's exact
main class and complete classpath, `serverJar=minecraft.jar`, and each pinned
library checksum. ZIP timestamps and library order may vary. Unexpected launcher
entries, missing/extra executable references and altered content are rejected.
Receipts include SHA-256 for every verified file. Installed runtime paths and
launcher properties are protected from ordinary file/modpack replacement.

Quilt declares installation and the shared modern Minecraft Gateway. Mapping,
rollout, protocol, admission, image and identity checks remain required. The
historical M4 real-client runner explicitly rejects Quilt until it has a separate
client-test contract. No live-client compatibility is claimed by these declarations.

The wizard selects Minecraft and Quilt Loader; installer selection is internal.
Owner catalog and wizard retain English/Italian loading, empty and failure states.
Mod providers require explicit Quilt compatibility; Fabric-only metadata is not
silently treated as Quilt-compatible. Existing modpack resolution can select an
exact Quilt loader on compatible same-node mappings, retaining normal permissions
and resource/port contracts. Backups remain offline under the existing policy.

## Activation and rollback

Migration `057_quilt_catalog.sql` extends the provider constraint and adds only
the Quilt metadata row. It does not modify eggs, mappings, servers or allocations.
It requires separate approval for the existing development database. Without the
row, the worker safely skips refresh. An enabled Owner mapping is still required.

A code rollback should disable new choices through Owner controls and preserve
saved combinations, receipts and catalog state. An uncommitted migration rolls
back transactionally; retain the additive provider row after activation rather
than deleting installation evidence. No production deployment is included.

## Validation

Read-only public discovery found 447 Minecraft versions, 309 loaders and 34
installers. The exact 26.3 / 0.31.0-beta.5 / 0.15.1 combination resolved Java25
and nine library checksums. No real game server was created, started, reinstalled
or deleted. Isolated tests do not establish external reachability.

The full unit suite passed 4,170 tests across 267 files, with one intentional skip.
The 26 modpack runtime integration tests passed, including exact Quilt loader
selection for direct and Gateway connections and refusal when capabilities do not
permit the target. Focused Quilt core suites passed 68 cases; launcher/capability/
image/historical runner tests passed 83 cases. Independent review found no blocker.

Browser evidence uses isolated fixtures rather than live installations:

- [Owner catalog](screenshots/m5/quilt-catalog-desktop-en.png), [Italian mobile](screenshots/m5/quilt-catalog-mobile-it.png), [loaders](screenshots/m5/quilt-catalog-loaders-en.png)
- [Loading](screenshots/m5/quilt-catalog-loading-en.png), [empty](screenshots/m5/quilt-catalog-empty-en.png), [queued](screenshots/m5/quilt-catalog-queued-en.png), [error](screenshots/m5/quilt-catalog-error-en.png)
- [Runtime selection English](screenshots/m5/quilt-wizard-runtimes-en.png), [Italian](screenshots/m5/quilt-wizard-runtimes-it.png)
- [Loader selection English](screenshots/m5/quilt-wizard-loaders-en.png), [Italian mobile](screenshots/m5/quilt-wizard-loaders-it-mobile.png)

Guarded read-only development database preflight verified all 56 prior migration
checksums. The Owner explicitly approved migration057 on 2026-11-01; the guarded
transaction applied only that migration and preserved all 56 prior checksums.
The worker synchronized 447 Minecraft versions, 309 loaders and 34 installers
without error. No container restart, mapping/egg change or game-server operation
was performed during this activation. The development Gateway
was restarted under standing authorization to load the compiled declaration.

All 23 Firefox browser tests passed across Quilt, the Fabric wizard and existing
Owner workspace. The 44 UI unit tests, complete typecheck and web build passed.
Axe WCAG2.2 AA, keyboard and overflow checks passed in the tested browser views.
Reviewed screenshots use the existing Quilt artwork; no new third-party asset
was copied. The build retains the existing chunk-size advisory.

Operational limitation discovered during activation checks: the development
Gateway was unhealthy before its authorized restart and remains degraded. API
and worker are healthy. Read-only diagnosis found existing route verification
can consume nearly the complete snapshot lease: one observed 12-second validation
left less than three seconds before expiry. Seven withheld routes among eleven
configured routes prolong sequential validation; this is not a Quilt catalog or
binding error. No routing/lease checks were weakened and no game servers were
changed to hide the condition. This requires a separate Gateway timing follow-up;
do not claim working live Gateway connectivity from this integration's fixtures.

All 243 affected backend integration cases passed across six suites: catalog11,
API38, queued54, content107, registry8 and module25. Together with the separate
26-case modpack runtime suite this gives 269 passing integration cases. Worker
11/11 passed. Lint passed with 30 pre-existing warnings and one info. No additional
runtime or infrastructure changes were needed to pass the tests.
