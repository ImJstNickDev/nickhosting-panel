# Minecraft Modpacks (M5)

The Minecraft integration provides an installed-pack view, a searchable catalog,
project details and a full-page preparation/review flow. Browsing is read-only.
Preparing a selected version does not stop the server. Applying the reviewed plan
uses the ordinary managed server boundary, stops a running process, optionally
creates a confirmed backup, installs the exact required runtime and publishes the
prepared files. A previously running server resumes through normal admission.
Failed or interrupted effects never trigger a blind second installer invocation.

## Providers

| Provider | Catalog | Server installation source |
| --- | --- | --- |
| Modrinth | Projects and exact versions | `.mrpack`, pinned manifest files and server overrides; explicitly client-only entries excluded |
| CurseForge | Modpacks and exact file versions | Official server pack where available, otherwise the pinned manifest with one bulk file-resolution request; distribution restrictions remain enforced |
| Feed The Beast | Public pack/version metadata | Exact version file manifest; client-only files excluded |
| Technic | Official platform metadata | Official matching server ZIP; client-only Solder bundles are not presented as server packages |
| VoidsWrath | Official published catalog/pages | Explicit server download link; an unresolved Minecraft/loader requirement blocks installation |
| ATLauncher | Official public catalog and version metadata | Official server ZIP when supplied; otherwise the exact server declarations in `Configs.json`, plus its hashed `Configs.zip` and server-side files |

Catalog metadata is cached with bounded size and TTL. Artifact acquisition uses
the shared HTTPS transport, configured download origins, cancellation, byte limits
and hash validation. Publisher origins are declared by the Minecraft integration;
custom mirrors remain Owner settings. Provider API credentials stay server-side.
Known-size files retain bounded parallel downloads. Files without a manifest size
are admitted sequentially using the existing GET response's validated length,
before writing; absent headers use a bounded remaining allowance. Streaming limits
and hashes still apply, and progress omits the byte total until all sizes are known.

The installer reference examined during research was not copied or executed.
VoidsWrath in that reference used an installer vendor's JSON index, not an official
VoidsWrath API. This implementation reads the official pages instead.

ATLauncher recipes use its public server installation metadata: explicit `server`
flags, separate server downloads and exact loader requirements. Configuration ZIPs
retain their declared server-relative root. Browser-only downloads, unresolved
dependencies, custom installer actions, patched legacy JARs and unsupported runtime
requirements remain visible blockers rather than being silently skipped. The
provider README's restriction concerning a third-party launcher is not treated as
a blanket prohibition on every server download; this is not a license grant for
redistributing its launcher assets or packs.

References: [official public version API](https://wiki.atlauncher.com/api-docs/v1/objects/pack-version/),
[server file declarations](https://github.com/ATLauncher/ATLauncher/blob/master/src/main/java/com/atlauncher/data/json/Mod.java),
and [server installation/configuration ordering](https://github.com/ATLauncher/ATLauncher/blob/master/src/main/java/com/atlauncher/workers/InstanceInstaller.java).

## Runtime and files

Pack-required Minecraft and loader versions remain exact. Existing runtime
mappings, rollout and integration capabilities decide eligibility. This change
**does not implement or enable NeoForge or Quilt**. Forge is supported by the
subsequent Forge runtime addition when an Owner-enabled Forge Enhanced mapping
and an exact compatible catalog entry are available. Unsupported runtime
requirements remain visible blockers. Fabric uses the existing latest-installer policy
and the pack's exact loader version.

A runtime change retains server identity, node, allocations and public routes.
Different port-role/feature requirements cannot silently replace an existing
mapping. Runtime installation is attested separately from game configuration, so
it does not reapply the original creation wizard or player lists. Image changes
use the existing first-process verification rather than pinning the old stopped
container's image.

Preparation performs one local extraction/hash pass. Scripts belonging to the
game (for example KubeJS) are pack content; host launchers and installer binaries
are not executed. Paths, links and archive expansion limits are validated before
publication. The private staging budget includes the STORE ZIP used for Fileman's
bulk transfer. At most 10,000 changed files are published in one reviewed plan.

Opaque mod JARs are inspected only for the metadata used to classify them. Duplicate
unrelated resources and case-distinct Java resource names are not interpreted as
filesystem collisions. Actual metadata ambiguity remains an error, and archives
whose members are extracted still receive the normal path/collision checks.

Fileman supplies shared metadata batches, signed streams, bulk archive transfer
and publication receipts. Publication moves replaced files into an operation-owned
rollback directory before moving new data into place; it verifies batched metadata
because an HTTP 204 alone does not prove that Wings moved every source. Rollback
files are retained during uncertainty and cleaned only after a durable applied
receipt. There is no recursive cleanup of unrelated server data.

## Updates and replacement

- Updating the same pack changes only its receipt-owned files. Locally changed
  configurations and world/player data are preserved by default.
- Changing to another pack requires an explicit replacement review, including
  exact deletion paths, backup choice and whether worlds should be preserved.
- Pack `server.properties` is merged through the existing Minecraft parser using
  supported gameplay settings. Network/authentication settings, operator and
  whitelist policy, world selection and generation settings remain local.
  Later local changes preserve the properties file unless explicitly overridden.
- Native provider actions are not assumed to be atomic. An uncertain runtime or
  publication remains fenced until read-only reconciliation proves the outcome.
- A restart failure does not erase a successful installation receipt. The UI
  reports that a start is still required.
- A failed preparation can be retried without prepared pack metadata. The new
  attempt retains the selected version, mode, world policy and file decisions;
  transport retries reuse its idempotency key. Project names/descriptions resolve
  independently from preparation, including after a page reload.

Manual archive upload remains on the pre-existing backend contract; the new UI
currently exposes the six provider catalogs rather than routing uploaded archives
through the old destructive replacement flow.

## Persistence and APIs

Migration `050_minecraft_modpacks.sql` adds operation/receipt storage and the
narrow runtime-image transition marker. Operations retain private session IDs
(not bearer tokens), actor/subject identities, resource reservations, exact
selection, plan digest, publication/runtime journals and lease state. Public
snapshots omit filesystem staging paths, credentials and internal journals.

Routes are under `/v1/servers/:id/minecraft/modpacks`:

- `GET /`, `/catalog`, `/catalog/search`, `/catalog/:provider/:projectId` and
  `/catalog/:provider/:projectId/versions`.
- `POST /prepare`, `POST /apply`.
- `DELETE /operations/:id`, `POST /operations/:id/recover`.

CSRF/session handling remains in the normal API middleware. Current server
membership is checked for requests and background effects. Preparation does not
hold the server mutation lock; application uses the existing server lock and
fences other file/lifecycle mutations. The worker consumes durable rows with
notification wakeups and a bounded fallback poll. It does not enqueue the same
work in both the generic lifecycle processor and the modpack processor.

## Validation and deployment

Tests cover provider fixtures, exact pinned recipes, staging, sanitized ZIPs,
properties, shared inventory, publication and recovery; isolated PostgreSQL tests
cover leases, session authority, runtime changes and the operation fence. Browser
fixtures exercise discover, preparation, review, blocked, uncertain and installed
states in English/Italian, including mobile and keyboard interaction. Screenshots
are under `docs/screenshots/m5/modpacks-*`; they are fixture evidence, not a claim
that a real pack was installed on the live provider.

Validation on 2026-10-21: the provider/planner/properties suite passed 426 tests;
API, worker and publication checks passed 27 tests. The final six-file isolated
integration suite passed 87 cases, with the two subsequent pre-effect recovery
regressions also passing. Firefox covered 12 screen/flow cases and a separate
keyboard regression (Tab, Enter, arrows and Escape), plus three existing Plugins
regressions. Desktop/mobile accessibility scans reported no serious or critical
violations. Root/web typechecks, EN/IT catalog checks, frontend/runtime builds
and scoped Biome passed. Existing large-bundle build warnings remain.

All runtime/file mutations in these checks used isolated fixtures; no real modpack
installation is claimed by this validation.

Recovery validation on 2026-10-21 reproduced the Antimatter Chemistry 1.4.10
failure against its original server archive. Its CraftTweaker JAR contains repeated
unrelated `META-INF` resources; a later JourneyMap JAR contains case-distinct license
names. Metadata-only scanning now prepares all 902 server data files locally with
the exact Minecraft 1.12.2 / Forge 14.23.5.2860 requirement. No game server was
modified. Retry/name regressions include desktop/mobile Firefox screenshots in
`docs/screenshots/m5/modpacks-failed-metadata-*`.

The same isolated check prepared official ATLauncher Fossilized v2.1.14: 786
staged server files, including two downloads without manifest sizes, and exact
Minecraft 1.12.2 / Forge 14.23.5.2864 requirements. It used the declared origins and
stayed below the 1 GiB test staging budget. Focused validation passed 267 unit
tests, 19 isolated integration tests and 14 Firefox cases; typechecks, frontend
build, scoped Biome and independent review passed. Existing large-bundle warnings
and absent private Minecraft preview assets in the isolated checkout remain build
warnings. These are preparation checks, not real server installations.

The live default ATLauncher version page exposed five older Fossilized recipes
with duplicate declared mod paths. Known invalid recipe metadata now marks only
that version unavailable; transport, cancellation and provenance failures still
propagate. Direct preparation remains strict. The corrected page returned 15
available and five unavailable versions, and authenticated dev Firefox checks
confirmed Antimatter's name, enabled retry, HTTPS, secure HMR and mobile layout.
No actual preparation retry/application was submitted through the live UI.

Activation requires a new development dependency image, the explicit migration,
and recreation of only API, worker and Vite with the existing Compose overlays.
No Blueprint release, Panel/Wings edit, DNS change or game-server test is required
for activation. PR #21 remains open and unmerged. Issue #18 and production release
boundaries remain unchanged.

Development activation completed with explicit Owner approval on 2026-10-21.
Only migration050 was applied; all49 previous checksums were preserved. Only API,
worker and Vite were recreated with the reviewed dependency image. All13 observed
development/provider services remained healthy; the other10 container identities,
images and start times were unchanged. Mounts, network attachments, published ports,
environment hashes and existing user/server/session counts were preserved.

Authenticated read-only Firefox checks passed HTTPS, WSS HMR, desktop/mobile
catalog and project views, plus search/details/version reads for all six providers.
The first live check caught upstream400 responses for empty FTB/Technic searches;
empty browsing now uses their official public catalogs, hydrates only visible
results with at most four simultaneous requests, and shares the metadata cache.
All25 catalog regressions passed after this correction. No frontend errors,
horizontal overflow or mutation requests occurred in the final browser pass.
ATLauncher was initially browse-only; the server descriptor support above supersedes
that restriction. Client-only/missing-server-package restrictions remain visible.
New operation/receipt tables and runtime-transition markers were empty
immediately after activation. A subsequent preparation remained blocked by its
runtime requirement, with no held storage, published files or runtime effects;
its record was preserved. Independent infrastructure and correction reviews
passed; rollback was not needed.

Rollback retains the additive database schema and operation/receipt history.
Before reverting active code, ensure no modpack application is in progress or
uncertain. Restore the prior source revision and service images; never drop the
new tables or delete staged/retired game files to force an operation out of the
queue.

### Interrupted runtime configuration

The Application API startup PATCH can return a server without allocation
relationships. Runtime transitions confirm that write with the normal full server
GET before checking identity and the exact egg, image, startup and environment.
An incomplete PATCH representation is not evidence of a different server.

**Verify and resume** can reuse an existing prepared operation when its durable
journal proves that stopping (and any requested backup) completed, the exact
startup configuration is already present, and neither installation nor publication
was dispatched. Recovery checks current authority and the original reviewed file
plan, then queues the same operation under the current caller. It preserves staged
downloads, backup and prior running state; it does not repeat the startup PATCH,
stop or backup. A possibly dispatched installer or ambiguous publication remains
uncertain and is never replayed by this path.

Console and Activity project the modpack operation's actual state and phase rather
than the synthetic reinstall job's default phase. An uncertain operation links
directly to its Modpacks review without an indefinite preparation animation.
Gateway snapshots withdraw the route of an active reinstall until that operation
releases the server. Existing route configuration is preserved, other routes stay
eligible, and provider identity validation remains unchanged.

Regression coverage includes incomplete PATCH responses, valid full GET identity,
unchanged/partially advanced registry bindings, replacement Owner recovery after
session revocation, ambiguous installer/publication rejection, and preserved
stop/backup/staging. Isolated runtime/service/context/publication checks passed
52 cases; route registry/context checks passed58 cases (the context suite overlaps).
Seven API cases, 34 Firefox cases, focused projection units, root/web typechecks,
EN/IT catalogs, frontend build and independent code/visual review passed. Existing
large-chunk and private Minecraft-asset warnings remain in isolated builds.

The real game-section wrapper allows recovery while the server is busy only for
its exact active, uncertain operation, with current manage permission and successful
reads. Other actions stay disabled. Nine wrapper regressions cover this exception,
permission loss, mismatched/running jobs, failed refreshes and duplicate submissions.

Development source reload and authenticated read-only Firefox checks passed:
Console shows the uncertain operation, its review link opens the existing prepared
pack, and **Verify and resume** is enabled on desktop and mobile. HTTPS and secure
HMR work, with no page errors, overflow or mutation requests. All eleven dev
services and the observed Panel/Wings containers are healthy; scoped container
identities, images, start times, mounts, networks and ports are unchanged. No
migration, manual restart or real recovery was executed. The existing installation
awaits the Owner's explicit recovery action.

Reviewed uncertainty states:
[desktop English](screenshots/m5/modpack-runtime-uncertain-en-desktop.png) and
[mobile Italian](screenshots/m5/modpack-runtime-uncertain-it-mobile.png).
These checks use isolated providers and database schemas; they do not claim a real
Forge installation. Source rollback must preserve the pending operation and its
prepared files, and must not run underneath an active runtime transition.
