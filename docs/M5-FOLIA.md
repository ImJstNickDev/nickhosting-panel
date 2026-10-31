# Folia runtime follow-up — 2026-10-31

The Owner requested Folia in the existing M5 Minecraft integration. Pterodactyl
continues to perform installation; no egg or Wings change is included.

## Catalog and installation

Discovery uses the [official Fill v3 API](https://docs.papermc.io/misc/downloads-service/)
for project `folia`. The shared Paper/Folia transport validates exact project,
version and build identity, bounded raw metadata and SHA-256 provenance. Failed
refreshes preserve the last valid catalog. The newest build is frozen at creation;
existing servers keep their selected build. All published channels are retained,
including alpha/beta and 26.x; channel and Minecraft release type remain distinct.

The automatic egg binding requires `MINECRAFT_VERSION`, `BUILD_NUMBER`,
`SERVER_JARFILE` and `DL_PATH`. The last variable receives the exact trusted Fill
artifact URL, bypassing the supplied script's legacy v2 and latest fallback.
Installed output must match its SHA-256. The actual egg declares all four variables
and the ptero-eggs Java image family. Java selection uses the highest required
baseline from Paper policy, Folia metadata and Mojang metadata.

The Owner catalog supports channels, search, pagination, refresh and translated
loading/empty/error states. The wizard selects the Minecraft version without a
loader step. Owner mapping, rollout, resource admission, protocol and identity
checks remain mandatory. Folia declares the existing modern Gateway and
installation contracts; this does not certify real-client connectivity.

Plugin discovery retains explicit Folia compatibility, without treating ordinary
Paper/Spigot/Bukkit plugins as compatible. See [PaperMC Folia support](https://docs.papermc.io/paper/dev/folia-support/).
Online-player observation accepts the official Paper terminal format only for
Paper/Purpur/Folia, and the two known Folia region scheduler thread names only
for Folia. Runtime identity comes from the inspected combination and participates
in the cache key. Chat, plugin prefixes and arbitrary threads remain rejected.
This follows the [official Folia threading source](https://github.com/PaperMC/Folia/blob/73865e0e1c11752a03f30320e0521d4611221e08/folia-server/minecraft-patches/features/0001-Region-Threading-Base.patch)
and its pinned [Paper logging configuration](https://github.com/PaperMC/Paper/blob/804dd0c3f08b666dc51a0250257915c002c59755/paper-server/src/main/resources/log4j2.xml).
No live player-list observation is claimed. Backups remain offline as required
by the current policy.

## Activation and rollback

Migration `056_folia_catalog.sql` extends the metadata-provider constraint and
adds only the Folia catalog row. No mappings, servers, eggs or allocations change.
Applying it to the existing development database requires separate Owner approval.
The worker skips Folia while its row is absent. An enabled Owner egg mapping is
still required for creation choices.

The development Gateway must load the new capability declaration. Production
deployment and changes to Pterodactyl/Wings are outside this work.

Rollback should disable new Folia choices through Owner controls and preserve
saved builds, metadata and receipts. An uncommitted migration can roll back
transactionally; after activation retain the additive catalog row/constraint
rather than removing installation evidence or game data.

## Validation

Read-only public discovery validated 13 Minecraft versions and 27 documents,
including 26.3 build6, 26.2 build7 and 26.1.2 build8. The guarded database preflight
verified all 55 prior migration checksums. The Owner subsequently approved and
applied migration056; all prior checksums remained unchanged and the worker
synchronized all 13 Folia versions without error.
No real game server was created, reinstalled, started or deleted.

Focused runtime/capability/image suites passed 114 tests; player parser/API suites
passed 62 tests. Sixteen Firefox browser tests passed across Folia, Paper and
Purpur, with Axe WCAG 2.2 AA, keyboard and overflow checks in tested views.
The full unit run passed 4,135 cases, skipped one and exposed one stale historical
bootstrap profile filter from the earlier Purpur addition. Aligning that filter
with the runner's existing unsupported-profile guard restored all 48 tests in
that suite. Independent review found no blocking issue.

Reviewed browser evidence uses isolated fixtures, not live catalog state:

- [Owner desktop](screenshots/m5/folia-catalog-desktop-en.png), [Italian mobile](screenshots/m5/folia-catalog-mobile-it.png)
- [Loading](screenshots/m5/folia-catalog-loading-en.png), [empty](screenshots/m5/folia-catalog-empty-en.png), [queued](screenshots/m5/folia-catalog-queued-en.png), [error](screenshots/m5/folia-catalog-error-en.png)
- [Runtime selection](screenshots/m5/folia-wizard-runtimes.png), [Gateway address](screenshots/m5/folia-wizard-address-en.png), [review](screenshots/m5/folia-wizard-review-en.png), [Italian mobile versions](screenshots/m5/folia-wizard-versions-it-mobile.png)

Typecheck, lint and web build passed; lint retains 30 existing warnings and one
info, and the build retains its chunk-size advisory. Isolated queued provision
(52 cases), installed content (101 cases), and Folia catalog (7 cases) passed.

The development Gateway was restarted under standing Owner authorization with
unchanged image, host configuration, mounts and network membership. The API watcher was waiting for a previous process to finish graceful shutdown.
The Owner explicitly approved the restart of the existing development API and
migration056. The API restarted with the same image, host configuration, mounts
and network membership. API, Gateway and worker are healthy; the catalog contains
13 versions with no refresh error. No other container was manually restarted.
Owner egg mapping remains a separate UI action; no real game installation was
performed as part of this validation.

The final API/registry rerun passed 44/44 after correcting stale fixture
expectations. Together, the affected integration suites pass 204/204 cases
(catalog7, queued52, content101, API36, registry8). Worker tests pass 10/10.
