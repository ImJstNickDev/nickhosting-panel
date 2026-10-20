# Minecraft Mods

Mods uses the runtime capability declaration already used by Minecraft navigation.
It does not enable a new loader or change a server's runtime. Modrinth and
CurseForge discovery share typed catalog, version and dependency contracts.

## Selection and publication

Discover stays inside the Mods page. Clicking a result opens its description in
the right pane; the separate checkbox selects it. Selection starts preparation
without opening an installation dialog. Install opens a full-page review within
the same tab. Returning to Discover preserves the selection and preparation.

Automatic selection prefers the latest compatible stable version. Prefer beta
allows a newer compatible beta; if no compatible stable release exists, a beta
can be selected without another confirmation. Beta versions retain a badge in
the review. Alpha versions require an explicit selection. A version chosen by
the user is not replaced by changing the automatic selection preference.

Versions outside the server's Minecraft/loader/environment requirements remain
browsable and require an explicit force decision. That decision applies to the
chosen version, not future selections or all dependencies. It does not override
distribution restrictions, missing artifacts, integrity checks, authorization,
path restrictions or resource admission.

Preparation resolves dependencies, acquires and checks artifacts, and transfers
JARs under generated pending names. Apply publishes prepared changes; it does not
download the same artifacts again. The server can remain running. No automatic
stop, restart or attempt to hot-reload Java mod classes is performed.

After publication, Console shows a restart advisory. It persists across page
reloads and reconnects. Only an observed process start after the publication
receipt clears it. A generic `running` state, new WebSocket connection or clicking
Start is not evidence of a new process.

## Catalog metadata

Execution side is separate from category tags. The normalized sides are Server,
Client, Both and Unknown, while provider-specific distinctions and source labels
remain in metadata. Category synonyms use canonical identities without collapsing
unrelated categories. Unknown metadata is not silently presented as server-safe.

Modrinth's declared environment, where available, takes precedence over its older
client/server compatibility pair. CurseForge carries explicit `Client`/`Server`
Environment tags in each file's `gameVersions`; these are normalized separately
from Minecraft versions and loader tags. Search/detail responses already include
`latestFiles`, so project summaries require no extra per-project requests.
Consistent declarations across tagged files supply the project summary; conflicting
declarations remain unknown. A particular version uses only its own tags, never
the project summary to fill missing metadata. Client-only versions retain the
explicit force requirement. See the official [File](https://docs.curseforge.com/rest-api/#tocS_File)
and [Mod](https://docs.curseforge.com/rest-api/#tocS_Mod) response schemas.

Archive metadata can supply missing side information during the existing
preparation inspection; listing installed files does not download every JAR.
Files without matching provenance remain visible as local files with unknown
catalog metadata.

Required dependencies are resolved together, optional dependencies are explicit,
and embedded dependencies are not independently downloaded. Repeated references
share resolution work. Installed mod receipts and retained datapack requirements
participate in final dependency/conflict validation. Removing a consumer does not
automatically remove dependencies that another selection may still need.
An empty compatible-version lookup is reported separately from an unavailable
download. A parent project's advertised Minecraft range does not override the
range of a required dependency. The resolver neither skips that dependency nor
changes the user's Minecraft target or provider.

Selection now attempts automatic dependency recovery before exposing blockers.
If the initially selected version cannot resolve, preparation uses the same
bounded alternative search, including for a manually selected version. Explicitly
forced selections are preserved. A healthy initial result performs no extra
catalog search. The queue/version picker displays the version actually prepared;
an alternative already installed is shown as already installed and is not
downloaded again. Apply remains a separate, explicit publication step.

Automatic recovery makes one deterministic pass over problematic selected roots.
Each accepted alternative clears that root's dependency problems without adding
new blockers elsewhere; unrelated remaining blockers can be resolved next. One
attempt budget (default 25) and one 30-second search deadline are shared per provider
selection, and one metadata memo includes the initial resolution. Installed
dependency preferences, optional selections, compatibility and force boundaries
are retained. The accepted resolved plan is reused without a final duplicate
resolution. This is bounded recovery, not an exhaustive Cartesian dependency
solver; combinations requiring coordinated backtracking may remain unresolved.
Operational catalog failures retain the known diagnosis, while revision
cancellation stops preparation. Final file/installed/cross-provider checks remain.

The durable requested selection is unchanged, preserving idempotent retries and
the distinction between automatic choices and explicit pins. Effective versions
are recorded in existing prepared changes/receipts. Stale blockers and errors are
hidden while a new selection is saving or preparing; unresolved problems remain
available after preparation. No new schema, migration or persistent job type.

Blocked dependencies retain their provider, requested version, immediate parent and
selected root projects. Review shows the dependency relationship, the server target,
and bounded observed Minecraft/loader versions from the catalog. These hints are
not an exhaustive compatibility matrix. A downloadable alpha-only selection has
its own explanation and remains an explicit version choice. A failed supplemental
catalog read does not replace a known incompatibility with a generic failure.

Review links to dependency details and the selected parent's version picker. Find
alternative stops at the first dependency-resolved candidate, or after 25 attempts
by default. Owner → Integrations → Minecraft → Content configures this budget
(`minecraftModAlternativeLimit`, integer 1–250); the optional environment override
is `NH_MINECRAFT_MOD_ALTERNATIVE_LIMIT`. Existing installations inherit 25 without
a migration. Changed limits invalidate cached alternatives on the server and in
the Owner's browser.

Catalog pages are read progressively using the existing resolver against the
selected roots of that provider. Shared raw metadata is reused across pages and
candidates; a successful candidate prevents further page/resolution requests.
Current pins, duplicates, unavailable, incompatible and alpha files do not consume
resolution attempts. Stable releases take priority unless beta preference is on;
deferred beta candidates are considered after the catalog has been exhausted.
Metadata scanning is bounded to the larger of three pages or the configured
attempt budget rounded up to pages of 20. Sparse catalogs and the existing
30-second deadline can therefore produce a partial result before all attempts
are used, without claiming an exhaustive negative or returning a timeout as HTTP500.
A manually requested suggestion changes nothing
until the user chooses it; normal preparation and final installed/cross-provider
dependency checks still apply. This is a catalog dependency suggestion, not a
gameplay certification or a complete dependency solver. An exhausted search budget
is reported as limited, rather than claiming no compatible version exists.

Installed mods check for updates in the background. Advice uses local publication
receipts and provider metadata; it does not list Wings directories, download JARs
or delay the installed inventory. Results match the displayed file path, provider,
project and installed version. Target/preference changes invalidate browser advice.
The service coalesces matching requests in a bounded five-minute cache and rechecks
authorization before cache access. Two projects are checked concurrently, with up
to three catalog pages per project and a 30-second overall deadline. Completed
checks survive a deadline/provider failure; incomplete checks remain explicit.
At most 512 receipt-backed files are checked in one response, with a limited flag
when more exist. Unrecognized local JAR identification is outside this feature.

Stable/beta selection follows the existing policy. Update candidates must be newer
by provider publication time; opaque version IDs are not compared numerically and
preferring stable never downgrades a newer installed beta. Prepare updates creates
one selection with exact version IDs, preserves existing manual choices and pending
file actions, and opens the ordinary review. Individual updates use the same path.
Replacing a disabled root mod preserves its disabled state. No update is applied
automatically and the game server is never stopped/restarted by these actions.

Fabric identity is extracted during the existing JAR inspection. Identical
artifacts from both catalogs can share one published JAR only when their Fabric
ID and verified SHA-256 match; their catalog aliases remain recorded for dependency
resolution. Different bytes claiming the same Fabric ID conflict rather than
being installed twice or silently treated as equivalent. This does not infer
identity for arbitrary uninspected local files or other loaders.

Fileman, SFTP and the older generic content APIs remain separate authorized file
editing paths. Changes made through them are not a transaction in the new Mods
queue; changed file observations invalidate stale catalog receipts. This feature
does not attempt to infer every dependency of manually installed files.

## API and persistence

All paths are under `/v1/servers/:id/minecraft/mods`:

| Method/path | Purpose |
| --- | --- |
| `GET /` | Actual installed inventory, durable draft and preparation state |
| `GET /catalog` | Available providers |
| `GET /catalog/search` | Paginated project discovery |
| `GET /catalog/:provider/:projectId` | Project description and normalized metadata |
| `GET /catalog/:provider/:projectId/versions` | Versions, compatibility and recommendation |
| `GET /updates?preferBeta=false` | Cached, read-only installed update advice and partial results |
| `GET /alternatives/:provider/:projectId?revision=N` | Bounded dependency-resolved suggestion for a selected root |
| `PUT /selection` | Replace the selected roots and start background preparation |
| `POST /changes` | Prepare enable, disable or removal of an installed file |
| `DELETE /changes/:changeId` | Cancel an unpublished installed-file change |
| `POST /apply` | Publish the specified draft revision |
| `POST /recover` | Reconcile interrupted preparation/publication |
| `GET /restart-status` | Lightweight restart receipt, without inventory/catalog reads |

Reads require current access to the managed server; mutations require current
server-management permission. Catalog and transfer credentials stay in Core.
The existing Pterodactyl adapter, content-source store and Fileman scopes own
provider mediation, resource claims and file access. No Blueprint update is
required for this feature.

Migration `047_minecraft_mods.sql` adds mod source acquisition and durable drafts,
changes, publication receipts, installed metadata and restart markers. Explicit
idempotency keys and revisions distinguish retries from changed selections.
Superseded preparation cannot publish its result into a later draft.

Preparation failures expose their localized public cause on the affected mod,
including required dependencies. `content_storage_unavailable` means the shared
content store cannot admit the bytes while preserving its configured free-space
margin and outstanding reservations. It is distinct from content budget or
concurrency exhaustion (`resources_unavailable`). The Owner controls that margin
in Settings → Content; preparation does not lower it automatically.

If `mods/` is missing, preparation creates it once before the first pending
upload. An admission failure occurs before that step and creates no source claim
or game directory. After correcting the policy or freeing capacity, retry the
selection; the failed attempt does not require database cleanup.

Wings bulk rename is not an atomic filesystem transaction. Publication records its
intent before dispatch and verifies the resulting paths in a shared observation.
An uncertain operation is reconciled, not blindly replayed. Database receipts
must not be discarded to make an uncertain operation appear successful.
Recovery verifies an interrupted rename batch without replaying it; a partially
published batch remains fenced until its result can be established. Interrupted
preparation can require recovery followed by reselection. Cleanup runs separately
and removes only ledger-owned pending/retired files, in bounded batches.

Successful publication and reconciliation appear in server Activity with the
actor, count and bounded path details. A restart advisory is not a claim that the
running game has loaded the new files.

## Activation and rollback

Apply migration 047 explicitly before exposing the new Mods API. Application
startup does not automatically migrate the database. Existing server files are
not rewritten by the schema migration.

Rollback the application version while retaining additive tables, staged files
and receipts. Do not drop the new tables, remove pending artifacts or reverse
published mod changes as an automatic deployment rollback. Applying mods to a
game server is a separate user action.

This feature does not waive SFTPGo issue #18 or authorize production deployment.
Provider fixtures establish contract and publication behavior, not gameplay
compatibility of arbitrary mods.

## Validation — 2026-10-20

- 186 focused unit/contract tests: catalogs, stable/beta selection, compatibility,
  dependency resolution, archive inspection, acquisition, source staging, game UI,
  queue projection, browser contracts and description sanitization.
- 45 database/service regressions: 15 Mods and 30 Datapacks, plus targeted final
  checks for already-installed alias cleanup and concurrent restart markers.
- 13 HTTP/platform tests: actual identity/session handlers, Origin checks,
  authorization, revoked access, catalog boundaries and server-scoped Activity.
  The existing nine Activity integration tests also passed.
- Ten Firefox browser cases: eight component journeys, one complete authenticated
  app/API/database/Fileman journey and one Console restart-notice journey.
  Keyboard interaction, EN/IT, desktop/mobile, overflow and scoped axe checks pass.
- Root and WebPanel TypeScript checks, production build, changed-file Biome,
  localization completeness (2,613 keys) and whitespace checks pass. Existing
  large-chunk build warnings remain.
- Independent backend/provider and frontend/UX/accessibility reviews completed;
  selection races, cross-provider duplicate artifacts, cleanup, version consent
  and description rendering findings were corrected before delivery.

Browser evidence uses the actual application/components with isolated PostgreSQL,
provider HTTP/filesystem fixtures and a small valid Fabric JAR. It proves staged
transfer/publication, Activity attribution and the Console notice with no power
command. It does not prove that a particular third-party mod runs in Minecraft.
No real game files were changed by these tests.

Screenshots: [full app discovery](screenshots/m5/minecraft-mods-app-discover.png),
[full app review](screenshots/m5/minecraft-mods-app-review.png),
[desktop catalog](screenshots/m5/minecraft-mods-discover-en-desktop.png),
[Italian mobile details](screenshots/m5/minecraft-mods-details-it-mobile.png),
[Italian mobile review](screenshots/m5/minecraft-mods-review-it-mobile.png),
[incompatible selection](screenshots/m5/minecraft-mods-incompatible-en.png),
[installed mods](screenshots/m5/minecraft-mods-installed-en.png),
[provider unavailable](screenshots/m5/minecraft-mods-unavailable-en.png),
[Console restart](screenshots/m5/minecraft-mods-console-restart-en.png).

### Dependency guidance and update advice — 2026-10-20

Focused validation for this follow-up: 67 provider/advice/model/controller tests;
28 isolated database/HTTP cases across the regression run and corrected focused
rerun; 19 Firefox scenarios covered by the full initial run and focused follow-ups.
This includes partial deadlines, metadata request reuse, stable/beta/no-downgrade
selection, disabled replacements, revoked sessions, stale target caches, shared
dependency chains, manual-choice preservation and old-draft rechecks. Scoped axe
and desktop/mobile overflow checks report zero findings. Root/WebPanel/test
TypeScript checks, changed-file Biome, localization compilation and production
build pass; existing large-chunk build warnings remain.

Independent backend and frontend/visual reviews completed. Screenshots:
[dependency guidance, desktop](screenshots/m5/mods-dependency-alternative-en-desktop.png),
[Italian mobile guidance](screenshots/m5/mods-dependency-alternative-it-mobile.png),
[updates, desktop](screenshots/m5/mods-updates-en-desktop.png),
[updates, mobile](screenshots/m5/mods-updates-en-mobile.png).

Authenticated Firefox verification against development passed HTTPS 200, WSS HMR,
the installed inventory and the new updates endpoint (seven installed mods,
complete result, no update candidates). The real read-only CurseForge resolution
retained the JEI → MezzConfig incompatibility with catalog version/loader hints.
No artifacts were downloaded, drafts changed, mods published or game power commands
sent. No migration, Blueprint update, container rebuild or manual restart was
needed. Existing blocked drafts can explicitly Recheck dependencies to obtain the
new diagnostics; merely opening the page never restarts preparation.

Rollback this follow-up's application commit while retaining the unchanged database
and existing prepared/installed files. Diagnostics are additive JSON fields; no
schema rollback or resource cleanup is required.

### Initial development activation

On 2026-10-20, the Owner approved the scoped development image build and explicit
migration. Only 047 was applied, with its source checksum verified; all previous
migration checksums and all 12 existing dev container identities, mounts, networks,
ports and restart counts remained unchanged. The one-off migrator was removed
automatically. The previous image is retained as `before-mods-20261020`.

The first authenticated inventory check exposed Wings returning HTTP 500 for a
missing `mods` directory on an installed Fabric server that had not started.
The read path now checks the root only after that ambiguous failure and returns
an empty inventory only when the directory is absent. Existing inaccessible
directories remain errors. Two focused regressions and independent review passed;
the fix loaded through the existing source watcher.

Final authenticated real-provider reads passed for inventory, restart status,
provider availability, search, descriptions and version lists for both Modrinth
and CurseForge. Responses also passed the browser contract schemas. API, worker
and Vite remained healthy; Firefox confirmed HTTPS 200 and the secure HMR
WebSocket connection. No real mod acquisition, publication or game power action
was performed. Real Apply latency/gameplay remains for the Owner's test.

## References

- [Modrinth project versions](https://docs.modrinth.com/api/operations/getprojectversions/)
- [Modrinth execution environments](https://modrinth.com/news/article/new-environments/)
- [CurseForge REST API](https://docs.curseforge.com/rest-api/)
- [Existing datapack dependency and publication contracts](M5-MINECRAFT-DATAPACKS.md)
