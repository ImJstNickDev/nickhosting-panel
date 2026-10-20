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
silently changes the user's Minecraft target, provider or selected parent version.

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

### Approved development activation

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
