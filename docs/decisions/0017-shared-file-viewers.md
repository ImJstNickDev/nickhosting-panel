# ADR 0017 — Shared file viewers and private range access

Status: Accepted implementation direction, deployment pending explicit approval
Date: 2026-10-13
Milestone: M5; tracking [issue #26](https://github.com/ImJstNickDev/nickhosting-panel/issues/26)

## Decision

The file manager has one viewer engine. It owns access, cancellation, selection,
personal defaults, limits and loading states; lazy builtin modules own rendering.
The existing text editor remains its editable text implementation. Images, native
browser audio/video, archive virtual folders, JSON trees and SQLite tables are the
first builtin group. JSON and SQLite views are read-only. No server transcoding,
Minecraft NBT implementation, arbitrary SQL or executable third-party plugins are
introduced. Single compressed streams are a later pass, separate from compressed
TAR archives.

Trusted first-party game modules may supply typed, namespaced viewer descriptors
and compiled loaders. Personal preferences select server, then game, then global
scope before integration suggestions. A saved identifier is never a code URL or
an authorization grant. Unavailable/removed modules fall back to applicable known
viewers; metadata does not enable unknown code.

A central API broker uses private, read-only, per-managed-server SFTPGo credentials
for random reads and streaming. Credentials stay encrypted server-side, use a
separate namespace from external SFTP users, and are issued from durable intent.
The existing managed-server access proof is reused. A pooled SSH/SFTP connection,
pinned host key and one local authorization watch per active session/server avoid
remote Panel checks and database queries on each byte range or data chunk. Browser
request authorization and revocation remain authoritative; this does not solve
SFTPGo's external retained-transport defect in issue #18.

Temporary disk snapshots are bounded and private. ZIP/JAR central directories and
TAR indexes are retained with leases; compressed TAR, 7z/RAR and SQLite may require
bounded local materialization. Cancelling one HTTP subscriber must not cancel
another subscriber. Session/permission/configuration revocation invalidates the
shared work. Cache capacity includes recognized residual files from prior crashes;
startup never removes old or unrelated files. No cache writes target game data.

## Consequences and evidence boundaries

- Browser-native codec support determines playable audio/video combinations; an
  extension does not prove playback support. Unsupported files remain downloadable.
- SVG is rendered in image context with sandboxed direct responses; no SVG DOM or
  script execution. ICO frame/pixel budgets apply before parsing.
- SQLite is a file snapshot with an explicit consistency limitation, not a claim
  of a transaction-consistent live database. WAL/journal detection rejects unsafe
  snapshots. Fixed read-only queries run in an isolated worker.
- Archive browsing and extraction are separate: extraction uses the existing
  authorized staging/upload operation and conflict flow. No archive name grants
  permission to overwrite server files.
- A new read-only Wings bind and private SFTPGo service require exact Owner
  approval. No Panel/Wings configuration patch or Blueprint release is necessary
  for this implementation. Existing optimized file transfers remain available.
- Parser/library licenses and distribution obligations are recorded in
  [format evidence](../M5-VIEWER-FORMATS.md). This ADR does not change repository
  licensing or declare production release readiness.

See [deployment proposal](../M5-VIEWER-DEPLOYMENT.md),
[API contracts](../M5-API-CONTRACTS.md) and the validation report. This extends
[ADR 0007](0007-file-transfer-and-storage.md) without replacing its external SFTP
or existing file-management decisions.

## Amendment — 2026-10-13: native SVG rendering in Frame

The image-only SVG rule above is superseded for Frame. Firefox's SVG image cache
made large zoom slow and could degrade detail; CSS dimensions alone did not resolve
the Owner's report. Frame now mounts a native SVG document in a fixed-viewport
iframe. The trusted, constant srcdoc installs CSP before source import; iframe
sandbox permits parent access only, never scripts. CSP denies external resources,
forms and base changes; only embedded data images/fonts and inline styles remain
available. Frame is inert and excluded from focus, with image naming and keyboard
controls in the parent. Raw source nodes never enter the application DOM.

The source root is retained for root CSS, percentages and local paint references;
an independent clip retains the natural canvas despite root transforms. Input
bursts are coalesced per animation frame. Raw source Blob URLs are never exposed:
a temporary detached Image decodes intrinsic dimensions and its URL is immediately
revoked. Direct API responses keep their existing sandbox CSP. No API, provider,
Blueprint, infrastructure or file-write permission changes are introduced.

[Validation](../M5-VALIDATION.md) records Chromium/Firefox tests, independent review,
synthetic performance measurements, and the read-only real dataset check. Raster
previews and ICO decoding retain their existing path; SFTPGo issue #18 is unchanged.

## Amendment — 2026-10-13: Fileman as the viewer extension host

The initial engine registered complete viewers but left Atlas with an independent
folder presentation. The Owner requested one extensible Fileman rather than a
similar-looking archive browser. Real folders and Atlas now use shared toolbar,
list/grid, entry, selection and menu components. Each retains its own data source
and cache; existing filesystem operations are not duplicated.

The SDK adds validated compiled presentation patches for named slots, alongside
complete viewer loaders. Add/decorate/hide/replace behavior has deterministic
ordering and explicit replacement-conflict rejection. Game context scopes patches;
viewer context and portal lifetime follow React, without global DOM modifications.
This is an explicit extension API, not an arbitrary runtime mixin mechanism.
Capabilities remain separate from authorization and source access.

Single compressed streams now open their decoded member automatically while
retaining the compressed filename. Download distinguishes original versus decoded
bytes; compound archives and explicit Atlas choices retain virtual-folder browsing.
No Blueprint, provider, infrastructure, credential or backend permission changes.
See [extension contract and formats](../M5-VIEWER-FORMATS.md) and
[validation](../M5-VALIDATION.md).

### 2026-10-14 — Contributed Fileman path navigation

Presentation patches alone do not define how the path picker resolves virtual
folders. Fileman now accepts a typed, compiled `FilemanPathProvider` contribution:
current path, namespace ownership, bounded candidate listing, navigation and file
opening. The host shares registration across viewer scopes and removes it on
unmount. The existing picker remains responsible for its UI, keyboard interaction,
input validation and cancellation. No archive condition is added to FilesWorkspace.

Atlas supplies this capability for its whole archive session, including when
another viewer displays a member. It resolves physical root, nested containers
and relative member paths separately, reuses its existing metadata cache/API and
retains compressed-container aliases. Leaving the archive namespace uses normal
Fileman navigation. Callbacks honor cancellation before committing navigation;
changing the contributing scope closes the old picker. This adds no filesystem
write capability or alternative provider transport.

### 2026-10-14 — Datagrid replaces the initial SQLite proof of concept

Datagrid remains a lazy read-only builtin hosted by Fileman. It reuses the central
source broker, snapshot cache, permissions and revocation; no separate provider
adapter, Blueprint endpoint or database editor is introduced. The worker is an
actual ESM module in both development and compiled runtime, avoiding function
serialization that lost transpiler helpers in the original prototype.

The shared SDK transport describes typed pages, schema, source revision and
bounded cell details. Search/sort are fixed parameterized read queries with a
stable row order. The browser retains at most eight pages / a 4 MiB serialized
UTF-16 estimate in session-local memory. It discards those pages on viewer scope
changes, known access denial, or observed source revision changes. Inspecting a
cell requires its original page revision and does not silently read a newer row.

The UI supplies table discovery, keyboard grid navigation, column sizing, schema,
search/sort and chunked value inspection inside the existing viewer chrome.
There is no SQL console, server write, live-database consistency claim or unbounded
cell download. WAL/sidecar restrictions and SFTPGo issue #18 remain unchanged.
