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
