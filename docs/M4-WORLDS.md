# M4 Minecraft world staging and validation

The [2026-10-18 world-format investigation](MINECRAFT-WORLD-FORMATS.md) records
the metadata evidence behind the M5 implementation amendment at the end of this
document. Earlier M4/M5 constraints below are retained as implementation history;
the final amendment separates import from activation compatibility.

World imports are authorized durable jobs. The public request identifies an uploaded archive; it never supplies a local path or chooses a world DataVersion. Core resolves the immutable archive reference to a trusted file under project `mountdata`, obtains its recorded SHA-256, and passes the selected release's integration-owned world DataVersion to the Minecraft package. Neither release spelling nor Owner configuration is accepted as evidence of the world format.

## Implementation boundary

`stageMinecraftWorld(archivePath, options)` stages one world under `mountdata/world-staging/<jobId>/files/<targetWorld>`. Its result contains a hash manifest, source archive digest, stable plan digest and validated `level.dat` evidence. Staging performs no Pterodactyl calls, writes no server files, starts no server and changes no production resource. The durable content job applies the verified manifest through the single Pterodactyl adapter after authorization, storage admission and operation-specific consent. Selection, removal and replacement require a stopped server; an additive import into a new non-active world folder may run while the server is running.

The source path is internal, absolute, contained by the configured `mountdata` root and free of symlink aliases. The recorded archive digest is checked before processing and again after extraction. A changed upload cannot silently reuse a job plan. Output ancestors are checked for symlinks and each file is created privately with exclusive flags before promotion into the job's staging directory.

The implementation reuses the content provider package's lazy `yauzl` archive reader. It does not introduce another ZIP parser. Archive budgets cover compressed size, expanded size, individual files, entry count and expansion ratio, including ignored entries. Paths, Unix special files, encrypted entries, duplicate/case aliases and unsupported compression fail closed. The world-specific inventory validator additionally rejects multiple world roots, file/directory conflicts, hidden/traversing paths, executable payloads and protected configuration files. A copied `session.lock` is omitted from promotion, since a new server must create its own lock. Dimension paths are retained; the importer does not rewrite old/new dimension layouts.

Files are streamed sequentially through CRC-32 and SHA-256 checks with backpressure and 64 KiB staging buffers. Large region files are not accumulated in memory. Disk margins are checked before the plan and each file. The existing content limits are configurable; the metadata limit below is not an arbitrary whole-world upload cap. Cancellation terminates an in-progress stream, removes only its job-owned temporary file, and retains completed staged files for recovery.

## Bounded `level.dat` validation

`validateMinecraftLevelDat(bytes, expectedDataVersion, options)` accepts Java big-endian NBT, raw or gzip-compressed. It does not guess Bedrock formats. Gzip expansion uses Node's `maxOutputLength`, then a structural validation pass bounds nesting, tag count, array elements and consumed bytes before the upstream object decoder runs. Duplicate compound names, prototype-related property names, negative/oversized lengths, unknown tag types, missing terminators and trailing documents are rejected.

Defaults are 8 MiB input, 16 MiB expanded metadata, depth 32, 100,000 tags and 1,000,000 total array elements. Trusted configuration may increase byte limits to at most 64 MiB and depth to 64; tag and array bounds remain capped. These limits constrain metadata parsing, not streamed region files.

The `Data.DataVersion` integer must match the exact selected release's verified value. If `Data.Version.Id` exists it must agree, and supplied release identity must match `Data.Version.Name` when present. Missing release metadata or incompatible world data fails; the importer neither upgrades worlds automatically nor claims that metadata proves every chunk, datapack or mod can run. Actual runtime readiness remains a separate requirement. Importing older worlds that require conversion needs a separately reviewed migration workflow.

## Recovery, discovery and destructive operations

The stage has an exclusive lock and immutable plan identity. Retries re-read archive content and rehash existing staged files; presence alone is insufficient. A crash-left lock can be cleared only through `recoverMinecraftWorldStageLock` after Core proves exclusive ownership of the durable database job and checks the expected plan digest. PID or elapsed-time guesses are not used.

`discoverMinecraftWorlds` receives capability-limited root-listing and bounded `level.dat` reads from Core. It skips unsafe names/symlinks and distinguishes verified, incompatible and unavailable worlds. The number of candidate directories and metadata bytes are bounded. Discovery does not import a server or infer ownership of a Pterodactyl asset.

`planMinecraftWorldReplacement` requires explicit wipe consent naming exactly the existing target world and retains the requested backup requirement. New imports cannot use stale replacement consent. The durable executor must recheck live preimages and confirm a requested backup is complete and verified before deleting anything. Selection uses the existing `planMinecraftWorldSelection` helper with the freshly validated world SHA-256 and DataVersion. No staging helper claims that a failed replacement rolled back or restored data.

## Dependency and reference audit

The selected dependency is **prismarine-nbt 2.8.0**, the version actually available from the npm registry during implementation. Its published package declares **MIT** and depends on `protodef`, also declared MIT. Upstream indexed `master` documentation mentioned a later version that was not available from the registry; it was not selected. Dependency lock integrity and the complete transitive license audit belong to the repository dependency evidence.

The [upstream parser documentation](https://github.com/PrismarineJS/prismarine-nbt) distinguishes Java big-endian NBT and offers `parseUncompressed`. Inspection of its [parser source](https://github.com/PrismarineJS/prismarine-nbt/blob/master/nbt.js) and [compound decoder](https://github.com/PrismarineJS/prismarine-nbt/blob/master/compiler-compound.js) informed the protective validation boundary: this implementation decompresses with an explicit bound, rejects ambiguous structures first, and calls only `parseUncompressed` with big-endian format. It does not call automatic unbounded decompression or disable array checks. No upstream source was copied into NickHosting.

## Test evidence

`games/minecraft/src/world.test.ts` uses generated fixtures and temporary, test-owned `mountdata` directories. Its NBT DataVersion values are synthetic and establish no real Minecraft release compatibility.

Coverage includes raw/gzip Java NBT, exact-version mismatch, malformed/truncated metadata, decompression bombs, negative/huge arrays, deep recursion, duplicate/prototype tags, wrong endian and missing DataVersion. ZIP tests cover traversal, symlinks, expansion bombs, executable files, multiple worlds and file/directory aliases. A 16 MiB region fixture is generated and extracted as streams; tests verify its full size/hash manifest, dimension paths, retry checks and tamper detection. Additional tests cover source digest/plan conflicts, cancellation, stopped-operation replacement consent, backup intent and exclusive-lock recovery.

Run `scripts/dev.sh pnpm exec vitest run games/minecraft/src/world.test.ts`. The complete milestone report records integrated tests, real-server validation and cleanup separately.

## M5 correction — 2026-10-18

World-format compatibility no longer depends on signed, expiring, per-mapping
installation reports. `minecraftWorldDataVersion(release)` reads the integration's
bundled exact-release catalog for inventory, preparation and execution. It performs
no HTTP request, JAR download or additional database query. No profile migration
or new Owner configuration is needed. Signed reports remain diagnostics and cannot
redefine the catalog value. Unknown releases remain unavailable for world mutations.

`games/minecraft/src/world-data-versions.json` contains 660 exact release/snapshot
values derived from the already pinned [PrismarineJS minecraft-data registry](https://github.com/PrismarineJS/minecraft-data/blob/33a0f3e7323e124a81960a6d6c62df797d69cd85/data/pc/common/protocolVersions.json).
The source URL and original SHA-256 are recorded in the file; upstream declares
[MIT](https://github.com/PrismarineJS/minecraft-data/blob/33a0f3e7323e124a81960a6d6c62df797d69cd85/README.md#license).
To regenerate, retrieve that immutable URL, verify its recorded SHA-256, and project
`minecraftVersion -> dataVersion` for integer values >=100. Values below100 are
upstream's synthetic historical sequence, not native world DataVersion, and are
excluded (including 1.5.2 and 1.8.9). The first included snapshot is 15w32a=100.
Updating the upstream pin and catalog is a reviewed integration metadata update;
there is no mutable upstream lookup on the request path.

Online imports cannot replace an existing path or write the configured active
world, even when that directory is absent. They do not change `level-name`, power,
compute reservations or installed state. Runtime transitions and unknown state
remain blocked. The durable operation still serializes conflicting NickHosting
mutations, and rechecks the destination before promotion; external writes are not
made atomic by this policy. Offline replacement retains explicit consent and its
optional verified backup. No existing world is automatically converted.

### Directory input — M5, 2026-10-18

The Worlds importer also accepts a local world directory through the browser's
[directory picker](https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/webkitdirectory).
Select the directory containing `level.dat`, not its parent collection of worlds.
Nested files keep their relative paths; empty directories are not supplied by the
browser and are not required for the world data. A browser worker packages the
selection as stored ZIP/ZIP64 using the [PKWARE format specification](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT).
It reads CRC input in bounded chunks and retains source File references in Blob
parts, rather than reading the complete world into a JavaScript byte array.
No compression, new package or server-side alternative installer is introduced.
Preparation is cancellable, reports actual bytes read, and precedes the existing
SHA-256/upload/source-reference/import job. Existing Fileman folder path validation
and the archive size boundary apply before processing; backend ZIP/NBT/storage and
replacement validation remain authoritative. Selecting a directory does not
bypass world-version or live-collision checks.
The directory picker retains Fileman's existing 10,000-item bound (files plus
directories); the generated ZIP, including its headers, must fit the existing
8 GiB source limit. CRC preparation and source SHA-256 are two local reads, not
two uploads. Large-offset ZIP64 layout is covered synthetically; no multi-GiB
browser transfer is claimed by that test.

### Version detection and cross-version imports — M5, 2026-10-18

`inspectMinecraftLevelDat` now observes bounded metadata independently of a target
release. It recognizes modern DataVersion, legacy McRegion/Anvil storage markers,
and markerless worlds with the typed seed/time/spawn fields of early Java saves.
Malformed or contradictory metadata remains invalid. Optional observed fields
include storage version, display name, Series, Snapshot and bounded version history.
Missing version fields are never filled from the target server or a filename.

The bundled catalog is indexed once in both directions. An unambiguous native
DataVersion can identify a release; an unfamiliar saved name or a shared number
does not become a guessed exact release. Known display-name aliases use inspected
artifact evidence. DataVersion/name comparisons and Series uncertainty share one
assessment between discovery and strict activation validation. Unknown target
metadata is reported as unknown compatibility. This is metadata compatibility,
not verification of every chunk, mod or datapack.

An import stages structurally recognized worlds even when their version differs
from the installed game or cannot be identified. It preserves the original bytes,
does not change `level-name`, and performs no conversion or game start. The optional
target DataVersion remains in the durable plan identity; source metadata is recorded
separately with `targetRelease` explicitly named. Final promotion compares the
remote metadata digest with the staged digest rather than parsing it again.
The completion event says the world was imported, not certified compatible.

Cross-version imports must target an inactive folder. Replacement of the configured
world still requires compatible metadata as well as the existing stopped-state,
consent and backup conditions. Selection remains restricted to compatible metadata
and a stopped server; this change adds no upgrade/downgrade workflow. Removal of a
structurally recognized inactive world no longer requires matching versions, so an
imported old world is not trapped behind the compatibility gate. Invalid/unreadable
folders remain manageable through Files with its existing authorization rules.

Worlds shows distinct compatible, incompatible, unknown, invalid and unavailable
states. It displays a saved version name or an unambiguous inferred release;
otherwise it says the version is unknown. Import and removal are independent of
the target-version catalog gate; selection is not. Catalog and metadata processing
add no provider calls or network lookups. Existing archive containment, integrity,
resource admission, permission and recovery boundaries remain in place.
