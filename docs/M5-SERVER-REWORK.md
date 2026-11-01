# M5 server workspace rework

Owner-approved scope, 2026-10-22. This extends the existing M5 PR; it does not
authorize a merge or production release. The original UI/UX audit remains part
of the work, alongside contextual navigation and granular server sharing.

## Acceptance checklist

- [x] Contextual sidebar: Your server, Tools, Config; server identity and exit;
  desktop expanded/compact and mobile; no duplicated server/game top navigation.
- [x] Integration-owned navigation metadata and permission declarations; existing
  capability/runtime restrictions, URLs and aliases preserved.
- [x] SFTP dialog in Files; Status discoverable from Console; Settings groups
  server/game/sleep/wake/Gateway messages; Schedules remains an operational tool.
- [x] Direct Subusers independent of projects; READ/WRITE/ADDITIONAL permission
  matrix; existing verified users; additive inherited access with provenance.
- [x] Server-side enforcement, read dependencies, bounded delegation, no self
  escalation; revocation and alternate paths (SFTP, archives, downloads, streams,
  queued jobs and scheduled effects) covered by tests.
- [x] Legacy project access preserved; destructive lifecycle/resource ownership
  restrictions explicit; migration additive and rollback documented.
- [x] Shared semantic tokens, icons/icon buttons, switch, search, pagination and
  workspace surfaces adopted across native sections and game extensions.
- [x] Console/Files remain visual references; Settings, Players, Worlds,
  Datapacks, Mods/Plugins, Modpacks and game viewers have coherent density,
  controls and feedback while retaining domain-specific interactions.
- [x] Draft-safe navigation and transient background errors; consistent focus,
  pending confirmations, inline errors, clipboard feedback and retry.
- [x] EN/IT, desktop/mobile screenshots, keyboard/focus/accessibility checks;
  independent correctness and UX/content review; no unsupported success claims.
- [x] Final consolidated checks and dev verification recorded below.
- [x] PR evidence updated; ready for Owner review, never merged.

## Audit decisions and implementation

Console and Files remain the reference for neutral surfaces, compact controls,
semantic action colors and useful density. The review included every native
server section and every declared Minecraft section, including empty, denied,
pending and failed states. Similar visual controls now share components; domain
workflows retain their own information and safeguards.

| Area | Inconsistency or interaction gap | Result |
| --- | --- | --- |
| Server shell | Global sidebar unused inside servers; native tabs and game tabs competing for space | One contextual sidebar, with server identity, exit, compact rail and mobile drawer; declared capability/permission filtering |
| Console and Status | Details competed with power actions; Network summary assumed access | Details beside the title; independent power/command permissions; no inaccessible Network request/link; restart and kill confirmations |
| Files and SFTP | Separate SFTP destination and duplicated controls; nested confirmations/focus problems | SFTP dialog from Files and legacy URL redirect; shared icon actions/switch; pending close protection and focus restored to trigger |
| Backups | Action controls and authorization tied to broad management | Shared icon actions, independent create/download/restore/delete; existing recovery and uncertainty states retained |
| Network | Clipboard feedback persisted; editor could close during request or discard changes silently | Timed copy feedback, explicit discard, pending preview/save/refresh protection and visible retry |
| Schedules | Local top navigation mixed configuration with operations; immediate destructive actions | Tools destination, shared switches and run/delete confirmations; effects and retention separately authorized |
| Settings and Gateway | Native/game/sleep/message settings scattered; background refresh could reset drafts | Local Settings navigation; shared navigation guard, preserved drafts and explicit retry; supported properties remain integration-defined |
| Players | Separate switch/icon styling and oversized panels | Common switch/icon controls, compact lists and permission-specific actions; player identity/moderation flow retained |
| Worlds | Separate search/paging/actions and recovery feedback | Shared controls and bounded surfaces; import, selection, download and deletion remain world operations |
| Mods and Plugins | Duplicated search, pagination, icon actions and styling; unreliable focus/retry feedback | Shared primitives and aligned installed/catalog/detail surfaces; separate dependency/compatibility and JAR-viewer behavior retained |
| Datapacks | Separate search/paging/switch styling; failures and pending state inconsistent | Shared controls, compact catalog/installed views, explicit action errors/retry and focus handling |
| Modpacks | Separate catalog/review controls and broad reset assumptions | Common controls; preserved pack details, runtime/preparation/recovery review; reset and optional backup require their additional grants |
| Subusers | Sharing required project creation; role bundles could not express independent actions | Direct server grants with READ/WRITE/ADDITIONAL matrix; inherited grants visibly separate, including overlap with editable direct grants |

`workspace-controls.tsx` supplies IconAction, SearchField, Switch and Pagination.
Existing Dialog, ConfirmDialog, ActionForm, Section, Notice and Tooltip remain
shared foundations. The Files editor/selection/transfer guard, content dependency
review, world import and Modpacks plan remain specialized flows; imposing a file
manager interaction on them would conceal information needed for those tasks.
Removed top-tab CSS and per-section switch/pager rules no longer form competing
control implementations. The router has one navigation blocker, with Files
participating through its existing save/transfer decisions. Deferred native dialog
close events caused by controlled state changes no longer cancel a later phase
(such as a file-collision confirmation). Local document/editor preferences work
without the optional remote viewer service; remote-only viewers remain gated.
Shared switches align their thumb at both ends and avoid repeating labels already
visible in the surrounding schedule or Settings row. At 320 px, the Files editor
puts the path above its actions so the filename remains readable.

Navigation groups are Your server (Console, Files, Activity), Tools (declared
Players, Worlds, Mods, Plugins, Datapacks, Modpacks, Backups, Schedules) and Config
(Network, Settings, Subusers). Settings contains General, Minecraft properties,
Sleep/Wake and Gateway messages when supported. `/sftp` redirects to
`/files?sftp=open`; old automation sleep/message URLs redirect to Settings;
`/automation` and `/schedules` reach Schedules. Status remains directly accessible
and linked from Console. Existing game URLs remain valid.

## Permission semantics

READ, WRITE and ADDITIONAL are presentation columns. Each operation has its own
permission key. WRITE and additional actions require the corresponding READ.
Direct and inherited grants are additive; no explicit deny. Removing a direct
grant never claims to remove an inherited grant. A delegated sharing editor may
grant only its own effective permissions, may not modify itself or the server
owner, and may not edit a collaborator whose access exceeds its own.

Console distinguishes read, power and command. Files distinguishes read, write,
delete and SFTP. Backups distinguishes read, create, download, restore and delete.
Subusers distinguishes read, write and delete. Integration-owned permissions
describe supported operations. Scheduled effects require both the schedule
permission and the underlying effect permission, rechecked at execution; backup
retention also requires deletion. Files rename/move requires write and delete.
World archive download is scoped to the selected installed world, without arbitrary
Files authority. Activity does not disclose commands without Console command access.

Direct grants do not delegate native reinstall/wipe/delete, resource quotas or
project ownership. Existing project managers retain their authority without new
Subusers delegation. Modpacks reset requires `game.minecraft.worlds.delete` at
prepare, apply, recovery and worker execution; without it the UI preserves worlds.
The legacy generic `modpack`/`modpack-upload` replacement can also wipe configuration,
mods and plugins, so retains `server:manage` in addition to Modpacks write. Legacy
generic install/remove likewise retain management authority; scoped domain APIs
provide granular alternatives. Backup effects separately require `backups.create`.

The compiled registry is authoritative, not browser metadata or stored untrusted
permission declarations. Sensitive handlers/streams/jobs re-resolve current grants.
SFTP provisioning uses effective file operations and reconciles credentials after
direct or inherited grant reduction. Issue #18 still limits revocation of an
already-open retained SSH transport; this change does not waive that release gate.

## Verification

Commands use Node 24 and pnpm. Integration/browser fixtures use the isolated M2
PostgreSQL/Redis services and mock external providers; they do not certify real
game mutations. Counts below describe separate verification batches; overlapping
reruns are not added into a misleading overall total.

| Check | Result |
| --- | --- |
| `pnpm test --maxWorkers=2` | 251 files passed; 3,916 tests passed, 1 existing skip |
| `pnpm typecheck` | Root, web source and browser-test TypeScript passed |
| `pnpm lint` | Passed; 30 warnings and 1 informational diagnostic remain |
| `pnpm build`, `pnpm i18n:check` | Passed; 3,093 EN/IT keys plus pseudolocale; existing large-chunk build warning |
| Native `servers.integration.test.ts` | 84/84 passed |
| Runtime and external-services integration | 165/165 passed, full files after fixture updates |
| Minecraft Mods/Plugins/Datapacks/Modpacks/sources/context integration | 172/172 passed; additional reset/revocation regression passed |
| Schedules integration | 42/42 passed |
| Subusers integration | 11/11 passed, including inherited/direct revocation and bounded delegation |
| Stream and Files-operation integration | 45/45 passed |
| Legacy Modpacks authorization | Mapper 8/8 and enqueue 2/2 passed |
| Final SDK/game UI/i18n focused batch | 62/62 passed after precise Properties empty-state copy |
| Game/navigation/Subusers browser batches | 119 cases passed; EN/IT desktop/mobile and accessibility checks |
| SFTP/Backups isolated browser batches | 34 cases passed |
| Authenticated SFTP lifecycle and transient Settings error | 2/2 passed; nested modal, focus and retained draft verified |
| Console power, Settings, workspace guards | 9/9 passed; final workspace rerun 3/3 includes held Network refresh; final shared Dialog/SFTP/workspace regression 4/4 |
| Additional native browser sweep | 91/91 passed across final full suites: Files 39, Domains 18, Automation 9, Provisioning/shortcuts 25 |
| `python3 scripts/check-governance.py` | Passed; staged text, screenshot metadata, relative links and ignored private state checked |

Integration invocation:
`pnpm exec tsx scripts/test-env.ts --m2 pnpm exec vitest run --config vitest.integration.config.ts <files>`.
Browser invocation: `pnpm test:browser <files>`; the final sweep includes Automation,
Domains, Provisioning, File manager and File shortcuts. These exercise actual
components and authenticated app handlers where supported, with isolated providers.

The first broad runs exposed stale fixture permission assumptions and timing failures
under parallel load. Fixtures now declare their real integration and granular keys;
permission checks were not relaxed. A final low-concurrency unit rerun passed.
Runtime's generic fixtures for Minecraft operations were corrected to use the compiled
Minecraft manifest. SFTP batch tests account for active credentials being rechecked
for revocation. The Network regression initially matched the wrong URL, then one
setup request returned a transient 500 under load; the corrected complete rerun passed.
The Domains fixture was upgraded from MemoryRouter to the application's data-router
and navigation-guard context. The last native sweep also exposed stale tab selectors,
shared test-locale state, a switch alignment defect, a deferred dialog-close race
and local editor preferences incorrectly gated on remote viewer availability.
A sequential drag regression also exposed test coordinates covered by the sticky
column header; the test now verifies the actual source and destination under the
pointer and scrolls while holding the drag. Tests retain strict collision,
overwrite, keyboard/Back and draft assertions.
Automation finishes its real isolated queued backup before regranting start consent;
production consent checks were not bypassed. A repeated locale reset in test
cleanup hit the real authentication rate limit; cleanup now avoids redundant
updates, without changing application limits. The path-picker Escape regression
now targets the focused control and verifies immediate closure before continuing;
the final complete Files suite passed all 39 cases without retries.

Independent correctness and UX review found and verified fixes for Console's
Network access, Network pending/draft races, inherited/direct grant overlap,
Console Details layout, nested SFTP modal events/focus, controlled dialog close
events, local viewer preference fallback, Modpacks reset authority
and the legacy replacement path. No remaining must-fix finding in the final rereview.

Real dev verification covered all 19 server destinations on Fabric/Paper, followed
by 10 distinct final native/Vanilla routes at 1440×1000 and 390×844, with loaded Worlds
explicitly awaited. No JavaScript errors, blocked mutation attempts or horizontal
page overflow. One existing Fabric fixture still returns Players 503; other tested
Fabric/Vanilla profiles return 200. Its Properties form was empty because the file
contains only `white-list`, handled by Players; other profiles expose 15 and 13
properties. Empty copy now describes the available file properties accurately.
No server was started or modified to manufacture a successful state.

Committed browser evidence uses fixture identities/data; real authenticated dev
captures and infrastructure details remain private. Representative reviewed views:

| View | Desktop | Mobile |
| --- | --- | --- |
| Contextual Console | [English](screenshots/m5/server-navigation-console-desktop-en.png) | [Italian](screenshots/m5/server-navigation-console-mobile-it.png) |
| Subusers | [English](screenshots/m5/subusers-matrix-1440-en.png) | [Italian](screenshots/m5/subusers-matrix-390-it.png) |
| Worlds | [English](screenshots/m5/minecraft-worlds-desktop-en.png) | [Italian](screenshots/m5/server-rework-worlds-mobile-it.png) |
| Mods | [Installed](screenshots/m5/minecraft-mods-installed-en.png) | [Details](screenshots/m5/minecraft-mods-details-it-mobile.png) |
| Datapacks | [English](screenshots/m5/minecraft-datapacks-desktop-en.png) | [Italian](screenshots/m5/minecraft-datapacks-mobile-it.png) |
| Modpacks | [Catalog](screenshots/m5/modpacks-discover-desktop-en.png) | [Review](screenshots/m5/modpacks-review-mobile-it.png) |

Also reviewed [Players mobile](screenshots/m5/minecraft-players-mobile-it.png),
[Console confirmation](screenshots/m5/console-power-confirmation-desktop-en.png),
[Status](screenshots/m5/server-navigation-status-desktop-en.png),
[SFTP dialog](screenshots/m5/sftp-desktop-en.png),
[Sleep/Wake Settings](screenshots/m5/automation-sleep-consent-en.png) and the
[320 px Files editor](screenshots/m5/file-viewer-editor-header-320-it.png).

## Activation, limitations and rollback

Owner authorization covered NickHosting dev restarts and migrations. Applied only
additive migration `053_server_subusers.sql`; the previous 52 migration checksums
and existing users, sessions, servers and mappings were preserved. Restarted only
the existing dev API and Gateway after a stalled API source reload. No container
configuration, mount, port, network or external routing change. No Blueprint update
was needed; Panel/Wings were neither patched nor restarted. No real game server,
file, player, install, DNS or SFTP credential operation was performed for this work;
no live test assets were created or cleaned.

No dependency or environment-variable change. Source-bound dev services load the
new implementation; the updated local build tag includes migration053. Previous
build tag and private activation evidence are retained. This is development
activation, not production release or new runtime/gameplay certification. Existing
production gates, including SFTPGo #18, remain.

Prefer a forward fix for authorization problems. A scoped source rollback must
retain migration053, its checksum and every Subusers grant; do not drop the table
or restore an old database. Older code does not honor direct grants and may retain
older, broader role-based authority, so review affected accounts, queued work and
SFTP credentials before activation. Do not roll back beneath an active content
publication or runtime transition. If a build rollback is needed, rebuild the
reviewed source with the retained migration history and restart only the affected
dev services using the existing complete Compose chain. Keep mounts, networking,
provider data and all game files unchanged.

## Server selector follow-up (2026-10-22)

The Owner's visual concept replaces the separate All servers link, server title
and game/runtime subtitle with one bordered Currently managing card: muted label,
server name and chevron. It follows the application's existing color tokens.
The compact rail retains an accessible trigger, and the mobile drawer uses the
same selector. The topbar and server destinations keep their current behavior.

Opening the selector loads the existing permission-filtered server list on demand.
Its bounded initial list explicitly indicates additional results and links to
All servers; loading and retryable failures do not remove that exit. Ordinary
router links retain unsaved-change protection. The native popover supports
outside dismissal and Escape without closing the containing mobile drawer.

Validation: all 8 contextual-navigation browser cases passed, including real
isolated server switching, draft cancel/discard, lazy loading, failure/retry,
outside dismissal, Escape focus, compact/mobile layouts and zero axe findings.
The first run had one incorrect test selector (Retry instead of the existing
Try again label); the corrected complete run passed. TypeScript, scoped Biome,
production build and i18n checks passed (3,098 EN/IT keys plus pseudolocale).
The existing large-chunk build warning remains. Independent review found no
must-fix issue. Reviewed [desktop menu](screenshots/m5/server-switcher-open-desktop-en.png),
[compact rail](screenshots/m5/server-switcher-compact-en.png),
[mobile card](screenshots/m5/server-switcher-mobile-it.png) and
[mobile menu](screenshots/m5/server-switcher-open-mobile-it.png); existing
Console/Status desktop/mobile EN/IT screenshots were refreshed.

No API, schema, environment or infrastructure change was required. All new server
operations used the disposable browser fixture database and mock providers,
cleaned with the harness; no live test assets were created. This UI follow-up can
be reverted independently while retaining the prior migration and permissions.

The Owner's density refinement reduces the selector's expanded minimum height
from 74 to 56 px, vertical padding from 12 to 8 px and row gap from 7 to 3 px.
The label is now 10 px, regular weight and a quieter gray; the server name keeps
its emphasis. Three existing browser journeys passed after this CSS-only change,
including EN/IT desktop/mobile screenshots and accessibility checks; scoped Biome
passed. No runtime behavior, infrastructure or live test assets changed.
