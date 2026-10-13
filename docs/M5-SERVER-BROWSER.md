# M5 server browser

The Servers page applies text search after 200 ms and applies select/status filters
immediately. Alt+K focuses and selects the search text. All, Online and Offline
remain visible; the filter icon opens game, available runtime/release, project,
and (in the Owner's other-users scope) owner selectors. Escape closes the panel
and returns focus to its trigger. A badge counts active advanced filters.

Regular Owners start with their own servers and use a switch to view other users'
servers. Switching clears advanced/status filters but retains search. Support
sessions retain their existing authorization scope. Filter options use the same
visible inventory; no account emails are exposed. Existing collaborators retain
project visibility.

Grid and list preferences persist locally. The available viewport determines page
capacity; resizing, filtering or changing views returns to page one. Previous/next
controls show the current page and total pages. Queries preserve prior results
while refreshing within the same identity and ownership scope. A 15-second poll
refreshes runtime state. The API continues supporting legacy cursor consumers.

The Home server-count remaining value uses an accessible infinity symbol when the
count has no limit. Shared disk availability continues using the measured shared
filesystem capacity added previously.

Validation uses disposable database/browser fixtures, including multiple owners,
installed releases, numbered pages, EN/IT, desktop/mobile, keyboard and axe checks.
No migration, real server creation, infrastructure restart or production mutation
is required by this change. Rollback is a code revert; existing cursor clients and
stored data remain compatible. API details are in [M5 API contracts](M5-API-CONTRACTS.md).

Resource values use their intrinsic width and wrap as whole icon/value groups
instead of truncating RAM or disk units. Very short viewports use one compact
column, omitting artwork and the secondary game/runtime line while preserving
name, status and resource values. Owner scope labels are Mine/Others (Miei/Altri).

## Review evidence

- Platform-query integration suite: 28 tests passed against an isolated database.
- New server-browser suite: 5 tests passed; existing platform browser suite: 12 passed.
- Root/web TypeScript, targeted Biome, translation consistency and production web build passed.
- Viewports: 1440×1000, 390×844, 844×390 and 640×480; large resource values,
  content bounds, page bounds, EN/IT, Alt+K and axe accessibility checks covered.
- Independent API/UI review completed; short-viewport metadata and resource clipping
  found during review were fixed and rechecked.
- No production mutations, container restarts, migrations or provider test assets.
  Browser/integration fixtures use disposable schemas and clean up afterward.

Screenshots: [grid](screenshots/m5/server-browser-grid-desktop-en.png),
[list](screenshots/m5/server-browser-list-desktop-en.png),
[mobile list](screenshots/m5/server-browser-list-mobile-en.png),
[Italian filters](screenshots/m5/server-browser-filters-mobile-it.png),
[Owner scope](screenshots/m5/server-browser-owner-scope-desktop-en.png),
[compact Owner](screenshots/m5/server-browser-owner-scope-landscape-en.png),
[narrow grid](screenshots/m5/server-browser-grid-narrow-en.png),
[Home infinity](screenshots/m5/home-server-infinity-desktop-en.png).

## List status strip

List rows replace the runtime badge with a 6 px rounded vertical strip, inset
8 px from the right/top/bottom. Dark red means offline with Gateway wake disabled;
lighter red means offline with configured Gateway wake enabled. Startup/shutdown,
installation, active operations and game loading use amber; running uses green.
Unknown telemetry remains neutral gray. A blocked wake policy alone does not
claim work is progressing. Grid and Home badges remain unchanged.

The additive list/detail `wakeEnabled` hint combines effective global Gateway
configuration with saved per-server policy, connection mode, capability and
manual-stop/maintenance intent. It does not promise available capacity, live
Gateway health or successful admission. Environment settings apply consistently
to list, detail and metadata-update responses.

Hovering or focusing a row increases saturation and adds a small local glow.
Reduced-motion disables the transition. The existing tooltip includes the exact
status; a screen-reader description preserves status independently of color.

Validation: 31 platform-query integration tests and 6 server-browser tests passed,
including both offline tones, starting/stopping, online/unknown, keyboard tooltip,
hover, reduced motion, grid/list separation and desktop/mobile resource bounds.
Root/web TypeScript and targeted Biome passed; independent review completed.
No infrastructure/configuration changes, restarts or provider test assets.
Fixtures were isolated and cleaned. Review the strip colors and hover intensity;
rollback is a code revert without a data migration.

Screenshots: [desktop status strip](screenshots/m5/server-browser-status-list-desktop-en.png),
[mobile status strip](screenshots/m5/server-browser-status-list-mobile-en.png).
