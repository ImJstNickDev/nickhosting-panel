# M5 viewer format implementation and dependency evidence

The backend viewers consume one shared, already-authorized `ViewerReadSource`.
They do not create Pterodactyl clients, repeat remote ownership discovery, or mint
download credentials. Source authorization and revocation belong to the central
viewer session. Each file revision has one parsed index reused across navigation
requests. This is separate from the ordinary directory-list cache.

## Implemented read-only formats

| Format | Implementation | Access and fixture evidence |
| --- | --- | --- |
| ZIP/JAR | Existing `yauzl` 3.4.0 | Central directory via 256 KiB coalesced reads, four resident blocks; only the chosen entry is streamed. Stored/deflate entries, ZIP64 library support, CRC verified while streaming. A 1,000-file fixture asserts fewer than ten source metadata reads. |
| TAR | Existing `tar-stream` 3.2.2 | One sequential index scan, retaining member offsets; later entries use exact source ranges. PAX/GNU headers use the library parser. No files are extracted onto the game server. |
| TGZ/TAR.GZ | Node 24 zlib + TAR | One bounded streaming decode into a private temporary TAR; subsequent reads use the retained index and local offsets. |
| TAR.ZST | Node 24 zstd + TAR | Same bounded streaming decode and cached index. |
| TAR.BZ2 | `unbzip2-stream` 1.4.3 + TAR | Streaming bzip2 decode. Fixture compressed independently using Python's standard library. |
| TAR.XZ | `xz-decompress` 0.2.3 + TAR | Streaming WASM XZ decode. Fixture compressed independently using Python's standard library. |
| 7z | `sevenzip-wasm` 26.4.0 / 7-Zip 26.04 | Isolated Node worker, generated LZMA2 fixture; list once and decode selected members on demand into the private cache. Solid archives may require decoding preceding members. |
| RAR | Same current 7-Zip dependency | Real upstream libarchive RAR5 stored fixture. This does not certify every RAR variant, multipart set, codec or encrypted archive. |
| JSON / JSONC / JSON5 | Existing `@humanwhocodes/momoa` 3.3.13 | Browser worker retains original source and lexical index; bounded windows feed the virtual tree. Exact numeric lexemes and duplicate keys remain intact; no expression evaluation. |
| SQLite | Node 24 `node:sqlite` | Read-only private snapshot, fixed schema/table pagination queries in a deadline-limited worker; no user SQL or loadable extensions. Integer values preserve 64-bit precision; BLOBs are represented by byte counts; long text cells are explicitly truncated. |

Single compressed streams (`.gz`, `.bz2`, `.xz`, `.zst` without TAR) now expose one
virtual file, named from the source basename without its compression suffix.
Decoded content is streamed once into the bounded private cache. Embedded original
filenames never override that path. Encrypted archives, links, devices, ambiguous paths and
unsupported compression variants return a format error; a filename extension
alone never establishes decoder compatibility. Archive browsing is read-only;
server extraction remains a separately authorized, staged file operation.

The existing extraction operation now accepts ZIP/JAR, TAR/TGZ/TAR.GZ,
TAR.BZ2/TAR.XZ/TAR.ZST, 7z, RAR and standalone GZ/BZ2/XZ/ZST streams. It preserves the existing all-local staging
pass before provider writes, path/conflict checks, disk safety margins and
partial-operation reporting. Compressed TAR extraction shares the viewer codec
but streams directly into staging instead of also writing a complete decoded
TAR. 7z/RAR extraction uses the same bounded worker and 256 MiB
archive/member limits; it does not bypass them by invoking a host executable.
Larger ZIP/TAR operations retain their pre-existing extraction budgets. Remote
ownership, destination authorization, upload limits and audit stay in the
existing generic file operation.

## Bounded work and caching

- `ViewerCache` creates a new private `viewer-*` directory underneath the
  configured cache root. It never clears, chowns or replaces game data,
  unrelated files, or previous runs' directories on startup. Graceful shutdown
  removes only the directory created by that cache instance.
- A private format marker identifies cache run directories. Startup reads only
  recognized cache directories once and accounts their existing files against
  the budget; a crash/restart cannot reset occupied capacity to zero. Previous
  runs are not automatically deleted. Exhausted residual capacity blocks a new
  materialization until scoped cleanup, instead of filling the disk. Use a
  dedicated root per API process; this is not a cross-process shared disk quota.
- Default cache budget is 1 GiB total, 256 MiB per materialized file, 128 entries;
  deployment configuration can set lower or higher budgets. Capacity is reserved
  before downloading or decoding. Concurrent requests share one download;
  cancellation of one subscriber does not invalidate other subscribers.
- Parsed sessions default to 16 entries and a 60-second idle lifetime, with an
  idle cleanup timer and active-operation leases. Revocation invalidates the
  cached session; it is not a permanent authorization grant.
- Archive defaults bound entry count to 25,000, one expanded member to 256 MiB,
  total declared expanded content to 1 GiB, metadata to 16 MiB, and compression
  ratio to 1,000. These are format-service options, not ordinary UI preferences.
- 7z/RAR have default limits of 256 MiB compressed input and 256 MiB opened
  member, also subject to the configured private cache budget. Their decoder runs
  one operation at a time with a 30-second deadline. A read-only descriptor of the
  already cached input supplies decoder reads; MEMFS holds metadata rather than
  another full input copy. There is no NODEFS mount, native shell, or game-data
  mount. Output is capped independently of archive claims and delivered in 64 KiB
  chunks with consumer backpressure. Large dictionaries/solid archives can still
  exceed decoder budgets; these defaults do not certify every file of that size.
  The pinned Emscripten loader grows its exported memory through the JS
  `resize_heap`/`Memory.grow` path; the integration caps that growth at 256 MiB.
  Node worker `resourceLimits` limit the JS heap, **not** WASM memory. Dependency
  upgrades must retain or revalidate this memory-growth contract.
- ZIP indexes and archive metadata are built once per server/path/revision key.
  One parent-to-children index supports later folder navigation without scanning
  or sorting all archive members for every opened directory.
  No provider calls occur when paging an existing index. SQLite queries execute
  only against the private snapshot. Existing credentials and source streams
  stay in the central backend service, never in browser responses.
- Cache shutdown order is parsed sessions first, then temporary files. An
  interrupted process can leave its private run directory; cleanup of such
  residual directories is a separate scoped operation, not startup deletion.

## Fileman extension host

Fileman owns filesystem controllers, browser navigation and authorized operations.
ViewerEngine is its extension layer, not another file manager. Shared presentation
lives in `apps/web/src/features/fileman/presentation.tsx`: real directories and
Atlas adapt their own metadata to that same UI. Atlas supplies a virtual directory
source with archive-specific cache/pagination; it does not duplicate ordinary
uploads, mutations or provider authorization. Unsupported mutation actions are
absent rather than decorative disabled controls.

Two compiled extension contracts serve different needs:

- `defineTrustedGameViewer` adds a lazily loaded complete content view.
- `defineTrustedFilemanExtension` modifies existing named presentation slots.
  `FilemanHost` applies `FilemanSlot` contributions; `FilemanScope` narrows context
  for the current viewer without creating another registry or transport.

Slots cover toolbar, breadcrumb, search, view toggle, selection, listing, entry
icon/name/metadata/actions, context menu, viewer content/actions/download. A patch
can prepend, append, decorate, replace or hide. Decorators receive the existing
presentation, preserving its controllers. Conditions use server/game, path, view,
read-only state and entry metadata. Game contributions apply only to their game;
builtin contributions are explicitly namespaced. Ordering is priority then ID;
multiple active replacements/hides of one slot are rejected instead of silently
winning. Unmounting a viewer removes its scoped UI and portals; nothing patches
the DOM globally. Render functions must remain pure and do not fetch provider data.

Only reviewed, statically imported first-party modules enter
`fileman/extensions.ts` and `viewer-engine/trusted-viewers.ts`. JSON from settings,
provider metadata or saved preferences cannot install executable code. Presentation
capabilities do not confer authorization; existing shared API/controllers enforce
all writes. Deep alterations require a new explicit contract, not arbitrary
prototype/DOM patching. Shared renderers remain a future extension point; this pass
does not add 3D, Minecraft NBT/DAT or another game integration.

Viewer chrome uses positioned search/view/tools outlets in the Fileman toolbar;
React portals retain scoped context and event ownership. Atlas uses those outlets
instead of an extra toolbar row. Extraction is an icon with an accessible label
and tooltip. Navigation keeps the existing cache and backend revision boundaries.

Standalone GZ/BZ2/XZ/ZST opens its single decoded member directly, read-only. The
visible filename and breadcrumb retain the original suffix; only internal viewer
selection/highlighting use the decoded member name. Compound TAR variants still
open Atlas. The download action offers archive versus decoded file. Explicit
Open With Atlas remains available, and refresh retains that choice. Unsupported
decoded formats use the existing chooser instead of pretending to support them.

## Contributed path navigation

`FilemanPathProvider` is a trusted SDK capability registered through
`useRegisterFilemanPathProvider` in the shared Fileman host. It supplies the current
path, namespace ownership, candidate listing and cancellable navigation/opening.
The existing path picker consumes it without format-specific branches; outside its
namespace, ordinary directory navigation remains unchanged. Registration belongs
to the viewer session and is removed on exit. Scope changes close the old picker.

Atlas supplies the full visible location for ALT + G, for example
`/backups/world.zip/config/settings.json`, including nested archives. Folder and
archive candidates complete with `/`; files open in their selected viewer. A
compressed archive alias such as `bundle.zip.gz/data/` hides its synthetic decoded
filename while API requests retain the actual nested chain. Explicit Atlas
preferences still retain wrapper browsing. Typing beyond the first 200 metadata
entries uses filtered, paginated lookup, not recursive filesystem indexing.

Listings, completion and compressed decoding share the same archive query keys,
with 200 candidates per picker result, the existing 48-page / 8 MiB metadata cache,
and no retained duplicate picker history. Complete recent listings answer prefix
queries locally. Virtual paths never become native server-file requests; original
root authorization and archive budgets remain in force. Escape, input changes,
closing or replacing the provider cancel pending navigation before it can commit.

## Atlas navigation, selection and nested archives

Atlas uses the same Fileman presentation components as real directories: toolbar,
breadcrumb, list/grid, rows, sort headings, selection bar, contextual menus and
custom tooltips. Its folder listing exposes name/size/modified-time sorting, folders first, and search
within the current directory. Sorting is cached per directory/order in the parsed
index; filtering happens before pagination. Browser pages are metadata only,
bounded by the existing 48-page / 8 MiB cache, with 200 visible rows per page.
Cached rows remain visible during revalidation; next-page and hovered-folder
prefetch are bounded instead of recursively exploring every folder.

Ctrl/Cmd-click and Shift-click select entries; context menus and selection actions
provide download and extraction. Downloads of multiple files/folders stream ZIP
through the same backpressured implementation as the regular file manager. No
whole ZIP is accumulated in browser memory. Archive content remains read-only:
selection does not expose rename/delete or imply edits to compressed files.

The `..` row is available at the outer archive root as well: it closes the viewer
through Fileman's existing exit action and returns to the physical containing
folder. Within virtual folders or nested archives, it still moves up one logical
level instead of leaving the entire archive session.

The archive-list API accepts `query`, `sort=name|size|modifiedAt` and
`direction=asc|desc`. Viewer requests may include `archives`, a JSON array of up
to four nested archive-member paths; `path` always identifies the real outer file
and `entry` identifies a member in the innermost archive. Root authorization and
revision identity are retained. One root index owns at most eight cached child
indexes with existing session leases. A nested archive is materialized only on
opening it, under the same temporary-file budgets. Concurrent callers share that
work; leaving one view does not cancel another reader. Shutdown aborts creation
before waiting for index disposal.

`GET|POST /v1/servers/:id/files/viewer/archive/download` accepts a current
`directory` and JSON `entries` selection (POST form preferred for large lists).
It resolves folders recursively against retained metadata and streams selected
members relative to that directory. `POST /files/extract` retains its existing
`root`, `file`, `destination`, `confirm:true` contract and adds optional `entries`
and `archives`. Extraction targets a new destination, preserving conflict checks;
it does not overwrite an existing destination. Selected members are staged and
validated before provider writes, with cumulative nested staging accounting.
Unselected ZIP/7z members are not opened; TAR still requires sequential decoding.
Provider failure after writes remains partial/uncertain, never a claimed rollback.
Selection manifests use the existing bounded 4 MiB request-body class and normal
Origin/session enforcement. No new Blueprint endpoint or provider credential.

The sevenzip filesystem adapter was checked against the pinned Emscripten 6.0.1
[filesystem implementation](https://github.com/emscripten-core/emscripten/blob/6.0.1/src/lib/libfs.js)
and [MEMFS implementation](https://github.com/emscripten-core/emscripten/blob/6.0.1/src/lib/libmemfs.js).
Those internal stream contracts must be revalidated when updating the dependency.
The 65 MiB archive/member regression uses a 32 MiB decoder heap to verify that
input and output size no longer require equally large WASM allocations. This is
not a benchmark of production SFTP/network performance.

## SQLite consistency boundary

Datagrid runs as an autonomous ESM worker module, not a serialized function.
Development uses the project's native Node 24 TypeScript support; production
uses the compiled JavaScript counterpart. This avoids captured transpiler helpers
such as `__name`, which made the initial proof of concept fail under `tsx` despite
passing Vitest's different transform. Both launch paths have regression coverage.
See [Node's TypeScript execution contract](https://nodejs.org/docs/latest-v24.x/api/typescript.html).

One retained read-only snapshot serves table navigation, schema, deterministic
sorting, literal substring search and cell inspection. The first response includes
the first table's rows, avoiding an extra discovery round trip. Search can target
all non-BLOB columns or a selected column. Row order uses an unshadowed rowid,
the primary key of a WITHOUT ROWID table, or the visible columns as a fallback;
sorting retains a tie order. SQL identifiers are validated against the cached
schema and qualified to avoid collisions with generated result aliases.

The lazy browser view owns a private cache bounded to eight pages and a 4 MiB
serialized UTF-16 estimate, cleared on source/identity scope changes or unmount.
Database values never enter browser persistent storage. Visited pages are shown
immediately; a newly observed source revision requires an explicit refresh instead
of mixing rows from different snapshots. Large cells are inspected in bounded
65,536-code-point chunks, with copy applying only to the displayed chunk when
the value spans multiple chunks. The grid remains read-only, including keyboard
navigation and clipboard copying; no SQL console, export or database writes.

The viewer rejects a WAL-mode header and existing `-wal`, `-shm` or `-journal`
sidecars. The source is re-statted after snapshotting; changed size or modification
time rejects the snapshot. `quick_check(1)` verifies structural consistency.
Unchanged metadata and a valid SQLite file do **not** prove a transaction-consistent
copy of a database another process is writing. Ordinary file snapshots therefore
report `consistency: unverified`; only a provider-native snapshot contract may
report `provider-snapshot`. Stopping a game server alone is not treated as proof
that no other writer exists. The viewer never checkpoints, repairs or writes the
source database. See SQLite's [live-copy cautions](https://sqlite.org/howtocorrupt.html#_backup_or_restore_while_a_transaction_is_active)
and [WAL requirements](https://sqlite.org/wal.html).

## Dependency selection and distribution obligations

Research date: 2026-10-13. No Prism Launcher code or closed-source Blueprint code
was copied. These dependencies do not change the repository's licensing decision.

| Dependency | License and primary evidence |
| --- | --- |
| yauzl 3.4.0 | MIT; existing project dependency. [Random-access reader contract](https://github.com/thejoshwolfe/yauzl#class-randomaccessreader). |
| tar-stream 3.2.2 | MIT; existing project dependency. [Source](https://github.com/mafintosh/tar-stream). The pinned parser's `header.byteOffset` is regression-tested for selected-entry reads. |
| unbzip2-stream 1.4.3 | MIT; [source and license](https://github.com/regular/unbzip2-stream). Its classic Node stream is adapted to a modern bounded stream. |
| xz-decompress 0.2.3 | MIT; [source, streaming contract and build instructions](https://github.com/httptoolkit/xz-decompress). The package includes the WASM decoder; it is not a native installation or system XZ replacement. |
| sevenzip-wasm 26.4.0 | LGPL 2.1-or-later with the unRAR restriction and bundled BSD notices. [Wrapper source/build](https://github.com/arktronic/sevenzip-wasm/tree/e62fe972cf51bf50293968afa54bee5bb582cc84), [license](https://github.com/arktronic/sevenzip-wasm/blob/e62fe972cf51bf50293968afa54bee5bb582cc84/LICENSE), [7-Zip source](https://github.com/ip7z/7zip). The npm package identifies upstream 26.04 in its changelog. |
| Node SQLite/zlib/zstd | Existing Node runtime distribution; retain its bundled component licenses. [SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html). |

The older `libarchive.js` 2.0.2, `libarchive-wasm` 1.2.0 (libarchive 3.7.7), and
`7z-wasm` 1.2.0 (7-Zip 24.09) were not selected. Upstream has subsequently fixed
parser/security defects; the similarly named maintained `sevenzip-wasm` package
is intentionally distinct. See [libarchive releases](https://github.com/libarchive/libarchive/releases)
and [7-Zip source history](https://github.com/ip7z/7zip/blob/main/DOC/src-history.txt).

Keep `sevenzip-wasm` as a separately replaceable dependency, loaded by module path;
do not inline its WASM or wrapper into proprietary minified application code or
remove its `LICENSE`. Binary/image distribution must carry the full LGPL 2.1
license, the dependency's unRAR/BSD notices, and the corresponding source/build
materials or a compliant source-availability mechanism. The source must not be
used to implement a RAR-compatible compressor. NickHosting uses the RAR decoder
only. The release packager must verify these obligations before distribution;
an upstream hyperlink alone is not presented as a blanket compliance guarantee.

The small RAR5 fixture is decoded from upstream
[`test_read_format_rar5_stored.rar.uu`](https://github.com/libarchive/libarchive/blob/master/libarchive/test/test_read_format_rar5_stored.rar.uu).
Its data says “hello libarchive test suite!”; it contains no private or game data.
The libarchive BSD-2-Clause notice is reproduced below for this fixture.

```text
Copyright (c) 2003-2018 <author(s)>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:
1. Redistributions of source code must retain the above copyright
   notice, this list of conditions and the following disclaimer
   in this position and unchanged.
2. Redistributions in binary form must reproduce the above copyright
   notice, this list of conditions and the following disclaimer in the
   documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE AUTHOR(S) ``AS IS'' AND ANY EXPRESS OR
IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
IN NO EVENT SHALL THE AUTHOR(S) BE LIABLE FOR ANY DIRECT, INDIRECT,
INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Targeted validation

The owned tests are `viewer-cache.test.ts`, `viewer-archive.test.ts` and
`viewer-sqlite.test.ts`. They create only temporary fixture data and do not access
production services. Full command/results are recorded in the milestone
validation report by the coordinator. They cover cache singleflight/capacity,
scoped cleanup, cancellation, shared index lifetime, archive paths and special
entries, decompression limits, format fixtures, table-name injection, integer
precision, readonly source preservation, WAL/source-change rejection and
revocation. These fixtures establish decoder behavior, not live SFTPGo deployment
or external SFTP revocation. Issue #18 is unchanged.

`file-operations.test.ts` additionally verifies the shared extraction path with
RAR5, LZMA2 7z (nested files and empty directories), TAR.BZ2/TAR.XZ/TAR.ZST,
malformed data and traversal rejection. No fixture writes to a provider.

## Private credential retention

Private viewer credentials expire after 24 hours. Rotation retires the old durable
identity record and closes its local pooled transport; it never overwrites the
old remote account identity. Expired remote accounts and retired database rows
are retained in this first pass. Automatic cleanup across changed provider
instances is not implemented: it must use recorded instance/account identities
and preserve ambiguous records. This is an operational retention limitation,
tracked in issue #26, not permission to prune SFTPGo users or game data. External
SFTP revocation issue #18 remains separate.

The shared SSH client explicitly enables TCP_NODELAY once per connection. A
controlled isolated SFTPGo benchmark of a 64KiB read (20 warm samples, one pooled
connection/channel) measured median OPEN/FSTAT+READ3.32ms after this change,
versus227.67ms before; cold establishment+read131.40ms. Full measurement scope and
history are in [M5 validation](M5-VALIDATION.md). No kernel or provider setting was
changed and these are transport-only timings.

## Motion debug timing

With API logging at `debug`, the existing viewer-capabilities response enables a
Motion timeline on the next viewer mount. Refresh the page after changing the log
level so cached capabilities do not retain the old setting. No timing UI is added.
The browser emits `viewer.motion_timing` in its debug console and batches fixed
numeric milestones into API `viewer.motion_browser` records. An opaque trace UUID
correlates them with API `viewer.motion_request` records and request UUIDs. Browser
diagnostics are untrusted measurements, not authoritative operational events.

The timeline starts when Motion mounts, after its lazy-loaded bundle is available;
it does not measure the preceding Files navigation/module-download interval.
It records native metadata, first decoded/displayed frame callback, play/pause,
buffering and seek intervals; track discovery; Range queue/header/body durations;
MSE metadata, first packets, source-open and first buffer; subtitle discovery,
renderer import, fonts, initialization, extraction and window application. Hover
thumbnail reads have a distinct request purpose. Waiting ends on readiness or is
cancelled by pause/error/source reset, excluding intentional paused time.

API phases distinguish principal resolution, management configuration, viewer
access/open, retained-session acquisition, parser creation on cache miss and
subtitle extraction. Stream summaries include first byte, bytes, completion or
cancellation. `Server-Timing: nh-motion;dur=...` measures response-header readiness,
not body completion; stream totals include backpressure and cleanup. HTTP browser
durations also include transfer and scheduling. These cannot independently isolate
network latency or GPU decoding. Nested/parallel phases must not be summed as
serial time; compare the browser's relative timestamps and request correlations.
Development StrictMode can create cancelled discovery attempts, identified as such.

Browser collection is bounded to 512 milestones/five minutes per mount, batches
of at most 48, normally flushed after one second, and no per-frame/packet logging.
Range queue/header/body milestones share a 192-event sub-limit; a fixed
`trace.range_limit` marker identifies truncation. Remaining capacity preserves
subtitle failures, recovery and playback milestones rather than recording every
Range read. The overall 512-event limit is unchanged.
Delivery is best-effort with a five-second timeout and no retry; closing flushes
remaining records. Intake is limited to 30 batches per authenticated session per
minute, with bounded in-memory bookkeeping. No file reads are added for tracing;
only small diagnostic POSTs are added. No filenames, caption content, credentials,
provider URLs or error strings enter these records. Debug-off uses no timing
clocks or diagnostic delivery. Timing is diagnostic instrumentation with bounded
overhead, not a claim of a zero-overhead benchmark.

## Motion embedded subtitles

Motion reads embedded Matroska/WebM text tracks: `S_TEXT/UTF8` (SRT-style),
`S_TEXT/ASS`, `S_TEXT/SSA`, and `S_TEXT/WEBVTT`. ASS/SSA uses JASSUB/libass with
bounded embedded fonts; plain text captions use safe DOM rendering, basic inline
styling and timed spans. WebVTT regions, authored positioning and CSS headers are
not implemented; these text captions use the player's readable bottom layout.
PGS/VobSub and other bitmap codecs, encrypted/compressed tracks, lacing, missing
cue durations and dynamic codec-state changes are not claimed as supported.
MP4 embedded subtitle extraction and external subtitle-file selection remain
outside this pass. Audio/video codec compatibility is unchanged.

Subtitle tracks use the existing authenticated same-origin viewer Range source.
For indexed files, Motion uses subtitle CueDuration and CueRelativePosition to
read only relevant packets, including long captions spanning a seek. This follows
[Matroska subtitle indexing](https://www.matroska.org/technical/subtitles.html)
and the [FFmpeg muxer's subtitle cue generation](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/matroskaenc.c).
An otherwise well-formed but incomplete subtitle index cannot establish complete
caption coverage and is not supported. Missing/incomplete index fields on ordinary
files use the same parser on the backend through the existing authorized SFTP
handle. The reader coalesces locally adjacent requests up to 512 KiB, using
the previous actual requested endpoint (including cache hits) to identify locality.
Distant jumps use 1 KiB prefixes instead of reading large irrelevant media blocks.
The browser receives only a caption window from `GET /files/viewer/subtitles`. Archive members keep the
bounded browser Range fallback. Large unindexed files/deep seeks may still report
subtitles unavailable when the scan budget is exhausted, rather than download an
entire movie. This limitation affects captions only.
No automatic repair, provider write or transcoding is performed.

The browser keeps a 2 MiB range cache, the current 20-second caption window and
at most one overlapping request in flight. Extraction begins alongside renderer
initialization; metadata events and seeks within a covered window reuse completed
or pending work. Refresh starts three seconds before the current window ends,
keeping its captions visible while the next response arrives.
Each parser operation has an 8 MiB baseline read budget and a 15-second deadline.
The backend additionally permits up to 24 MiB of speculative read-ahead (32 MiB
maximum transferred per operation), then reverts to small reads. This reduces
round trips by deliberately transferring some unused bytes; it neither stores
the whole film nor guarantees fast arbitrary seeks into large unindexed media.
Limits also bound
index entries, cue text and fonts. The backend keeps at most eight parsed sessions,
with a 2 MiB metadata cache per reader and 60-second idle expiry. Retained state is
bound to the authenticated session, actor/subject and file revision; each request
reauthorizes access. Selecting Off, switching tracks or closing the viewer aborts stale reads and
destroys unused rendering workers. Seeking outside pending coverage replaces the
read; a permanent failure stops background extraction until explicit Retry.
ASS initialization is bounded; runtime operations have a 5-second deadline and
worker destruction has a 1-second termination fallback.

The native video frame timestamp/currentTime owns synchronization, including
paused seeks, rate changes and audio selection. No independent audio/subtitle
clock is created. Rendering follows actual browser frame delivery; this is not
a guarantee of sub-millisecond display latency under load. Captions work in the
player and fullscreen, but DOM/canvas overlays do not appear in native video
Picture-in-Picture. Authored ASS coordinates are preserved; temporary controls
can overlap authored graphics, which remain above the controls' dark gradient.

Multiple subtitle tracks have a compact Off/track selector. A single track hides
the track selector and exposes On/Off inside Playback settings. Audio selection
remains hidden for a single audio track. Forced/default supported subtitles are
selected initially; all other tracks remain Off until selected. Unsupported
tracks remain disabled. Selection failure is nonfatal and offers Retry while
video/audio continue. English and Italian controls use the existing catalog.

See [dependency notices and distribution obligations](M5-DEPENDENCIES.md#motion-subtitle-rendering)
and the append-only [validation evidence](M5-VALIDATION.md).

## Motion retained playback buffer

Same-track seeks preserve the MediaSource, SourceBuffer, demux input and bounded
Range cache. An unbuffered seek replaces only the remux pump; compatible fragment
initialization resets the segment parser without discarding retained frames.
Changing audio track may rebuild the source so stale audio cannot be played.
The initial `mse.start` trace spans metadata through the first playable buffer;
subsequent pump work is reported separately as `mse.refill`.

The Owner-selected retention policy is **128 MiB of appended compressed audio/video
bytes, without a time-based expiry**. Forward production remains approximately
12 seconds, rather than automatically filling 128 MiB. Under byte or browser
quota pressure, distant media is removed while protecting the current position.
The byte ledger reconciles native buffered ranges, including browser eviction;
partially retained fragments remain conservatively charged. Range and demux
caches, decoder surfaces and other browser allocations are separate: this is not
a 128 MiB total browser-memory promise. Closing the viewer releases its session;
cache is not persisted to disk or shared between users.

Reference: [W3C Media Source Extensions](https://www.w3.org/TR/2016/REC-media-source-20161117/),
particularly parser reset, compatible initialization segments and coded-frame eviction.

## Subtitle lookup research and bounded simulations

Reviewed upstream on 2026-10-13, as design references only; no code was copied:

- [mpv MKV demuxer at c3ac7f3](https://github.com/mpv-player/mpv/blob/c3ac7f39514c7f45bc38a18e66887240539ee33c/demux/demux_mkv.c): deferred Cues, incremental indexing toward a target, and duration-aware subtitle pre-roll.
- [mpv stream buffering](https://github.com/mpv-player/mpv/blob/c3ac7f39514c7f45bc38a18e66887240539ee33c/stream/stream.c): buffered reads and reuse of nearby positions.
- [VLC segment seeker at 1176b56](https://github.com/videolan/vlc/blob/1176b56bdef7b96c9d6518b62be37ec8c32d92ed/modules/demux/mkv/matroska_segment_seeker.cpp): known cluster/seekpoint lookup and exclusion of already searched byte intervals.

The inspected files carry LGPL-2.1-or-later notices; they remain references, not
new bundled dependencies or repository licensing changes. Our existing parser
already prefers usable subtitle indexes, retains cluster positions/durations and
skips known expired clusters. Without such an index, an arbitrary byte guess or
a video-only seekpoint does not prove that a long preceding caption has ended.
The optimization therefore aggregates nearby metadata reads while preserving
coverage and bounded work, rather than replacing lookup with a guessed offset.
Sparse virtual files exercise size/density without allocating their full media
payload. Their request/byte counts are deterministic; their in-memory CPU times
are not predictions of SFTP/network performance. See the validation report for
separate real-file timings and failed fixed-block experiments.

## JSON Tree — worker-owned document and virtual browsing

JSON Tree is a read-only builtin hosted by Fileman. The existing same-origin
viewer source transport handles physical files and archive members. Reading the
source happens once per opening/explicit reload; expansion, search, selection,
value details and clipboard requests are local browser operations. No Blueprint,
Pterodactyl or Wings endpoint is added, and no parser sends document contents to
an external service.

The browser worker retains source text and an indexed tree, rather than cloning
the full tree into React. The renderer requests bounded windows and mounts only
the viewport plus overscan. Search examines keys/scalar values and reveals matched
ancestors. Original property order, duplicate names, large numbers and JSON5
lexemes are not normalized through `JSON.parse` / `JSON.stringify`. Copying a
branch uses its original source slice, including comments inside that branch.
JSON Pointer escapes are supported; paths through duplicate property names are
identified as ambiguous instead of falsely promised to identify one occurrence.

The existing 8 MiB source, 100,000-node and depth-128 preview limits remain.
Source size is bounded before parsing; node/depth budgets apply while indexing
the parsed AST, not as a JavaScript heap limit. Worker deadlines and termination
keep parsing off the main thread; disposal cancels pending work on source or
identity changes. Values and rows are bounded for routine UI messages; explicit
copy is the exception and may return a complete selected branch within the source
budget. Source text is not persisted in browser storage.

Interaction follows the [WAI-ARIA Tree View pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/):
arrow navigation, expand/collapse, Home/End and explicit hierarchy metadata for
virtualized rows. Details and clipboard feedback use localized EN/IT labels.
The shared shell continues to own Home, Download, Open with and viewer Escape.
Editing remains Scribe's responsibility. Validation, screenshots and measured
fixture costs are recorded in [M5 validation](M5-VALIDATION.md).

## Editable CSV/TSV documents (2026-10-14)

Datagrid now reads and edits physical UTF-8 CSV/TSV files through the same document
session and conditional save as Scribe. The toolbar icon switches between them
without another file read. Pending cell edits are committed to the shared draft
before switching/saving; Undo/Redo spans both views. Remote revision conflicts keep
the draft and never silently overwrite the changed provider file.

Supported operations: cell edits, row/column insertion and deletion, header rename,
header interpretation, comma/tab/semicolon/pipe delimiter selection, literal search,
column filtering, stable sorting and bounded paging. Delimiter/header choices
interpret the existing source; they do not silently convert its contents. Sorting
never changes saved row order. Quoting, BOM, final newline, exact strings and untouched
multiline cells survive edits. No formulas are evaluated or coerced into numbers.

[PapaParse documentation](https://www.papaparse.com/docs) defines the parser/unparser
contract. Pinned `papaparse` 5.7.0 and `@types/papaparse` 5.5.2 both use MIT licenses;
the dependency is bundled only in the lazy document worker. No upstream code is
copied into the project. The worker retains at most a 1 MiB source, 50,000 records,
100,000 cells and 128 columns. Pages contain at most 100 rows and 256-character
cell previews; explicit cell inspection/editing retrieves the full value. A five
second worker deadline terminates stalled work. Exceeding a budget reports a limit;
it never saves a truncated document.

Archive CSV/TSV entries use the same renderer and switch in read-only mode. SQLite
remains read-only and uses its existing service. The source-neutral shared table
renderer provides future adapter extension points, not implemented DuckDB/H2 support.

The production frontend build includes the worker. Persistent development must
rebuild only its Vite image to install the added dependency; no API/worker/database
restart, migration, Blueprint update or provider operation is needed.

### Datagrid context actions (2026-10-14)

The shared table exposes typed cell/row/column context targets to its source adapter.
Right-click, Shift+F10 / the Context Menu key and the compact actions button open
icon menus; mobile submenus include Back. CSV/TSV adapters provide insertion above/
below or left/right, first/last positions, column rename and confirmed deletion.
SQLite and archive documents expose only inspection/copy operations.

Row anchors use stable source IDs. With sorting/filtering active, the menu says
before/after the source row and explains file-order insertion; row numbers show the
current source record position. Undo/Redo shares Scribe's document session. Automatic
header interpretation persists for the open document across draft reloads, so an
inserted blank record does not turn the header into data on redo. Explicit header
changes remain available. Menus expire with the displayed snapshot; no new provider
requests, remote mutations, dependencies or Blueprint endpoints were introduced.

## Folio — read-only PDF viewer (2026-10-14)

Folio is a lazy builtin, including PDFs selected inside Atlas. Mozilla PDF.js
6.4.299 (Apache-2.0) parses in a browser worker and renders in the browser. NickHosting supplies
its own compact controls, using upstream continuous-page rendering, selectable
text, search and annotation layers. PDF bytes follow the existing authorized
ViewerEngine transport; no provider credentials, external PDF service or new
Blueprint endpoint is involved. The current build targets Chromium and Firefox;
other browsers are not certified by these tests.

Navigation includes page entry, previous/next, fit width/page, actual size,
editable zoom, rotation, optional thumbnails and outline, text search and print.
The Fileman toolbar retains original download and Open with. Position preferences
are bounded per-tab session state; passwords and PDF text are never stored there.
Forms, editing, signatures, OCR, embedded attachment execution, PDF JavaScript
and XFA are outside the read-only contract. Only validated HTTP/HTTPS external
links may open a separate tab; internal destinations stay inside Folio.

Worker, CMaps, standard fonts, WASM decoders, ICC profiles and annotation images
are served from the same application, version-matched to the npm dependency.
The Vite asset plugin uses a fixed package inventory in development and emits the
same inventory with its license files for production. There is no CDN fallback.
See [PDF.js releases](https://github.com/mozilla/pdf.js/releases/tag/v6.4.299)
and [upstream browser support](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#which-browsersenvironments-are-supported).

An initial authorized metadata read supplies the opaque existing source revision.
Folio pins subsequent HTTP reads with `If-Match`; a changed root is rejected with
412 before streaming. Archive members pin the containing archive. This uses the
existing identity/size/mtime fingerprint, not a full-file hash or new provider
lookup. It detects ordinary changes, not same-size writes preserving mtime, and
is not a transactional filesystem snapshot. Compressed archive seeking can
still require decoding preceding bytes; range requests do not make compressed
members randomly seekable at zero cost.

Folio bounds input at 256 MiB and 10,000 pages; ordinary page canvases use a
2,097,152-pixel budget with PDF.js's detail canvas for zoom. Thumbnail rendering
is windowed, and print preparation is sequential with a 128 MiB summed decoded
pixel budget. These are individual budgets, not a strict total browser heap cap:
PDF objects, fonts and complex image decoders also consume memory. Printing over
the budget reports a failure and offers the existing original download; it never
silently prints only part of a document. Large raster images use upstream
image downscaling rather than a custom limit that silently omits them.

PDF.js includes stock application selectors as well as page-layer styles. Folio
loads these inline inside `@scope (.folio)`, rewrites `:root` to the local scope,
and removes the stylesheet on unmount. Its viewport height stays local and its
color scheme follows NickHosting; opening a document cannot restyle the shared
sidebar or change the application's native controls. The supported current
Chromium/Firefox targets implement CSS scope (Firefox 146+).
