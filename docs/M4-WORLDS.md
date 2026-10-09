# M4 Minecraft world staging and validation

World imports are authorized durable jobs. The public request identifies an uploaded archive; it never supplies a local path or chooses a world DataVersion. Core resolves the immutable archive reference to a trusted file under project `mountdata`, obtains its recorded SHA-256, and passes the selected release's independently verified world DataVersion to the Minecraft package. Neither release spelling nor Owner configuration is accepted as evidence of the world format.

## Implementation boundary

`stageMinecraftWorld(archivePath, options)` stages one world under `mountdata/world-staging/<jobId>/files/<targetWorld>`. Its result contains a hash manifest, source archive digest, stable plan digest and validated `level.dat` evidence. Staging performs no Pterodactyl calls, writes no server files, starts no server and changes no production resource. The durable content job applies the verified manifest through the single Pterodactyl adapter after authorization, stopped-state confirmation, storage admission and operation-specific consent.

The source path is internal, absolute, contained by the configured `mountdata` root and free of symlink aliases. The recorded archive digest is checked before processing and again after extraction. A changed upload cannot silently reuse a job plan. Output ancestors are checked for symlinks and each file is created privately with exclusive flags before promotion into the job's staging directory.

The implementation reuses the content provider package's lazy `yauzl` archive reader. It does not introduce another ZIP parser. Archive budgets cover compressed size, expanded size, individual files, entry count and expansion ratio, including ignored entries. Paths, Unix special files, encrypted entries, duplicate/case aliases and unsupported compression fail closed. The world-specific inventory validator additionally rejects multiple world roots, file/directory conflicts, hidden/traversing paths, executable payloads and protected configuration files. A copied `session.lock` is omitted from promotion, since a new server must create its own lock. Dimension paths are retained; the importer does not rewrite old/new dimension layouts.

Files are streamed sequentially through CRC-32 and SHA-256 checks with backpressure and 64 KiB staging buffers. Large region files are not accumulated in memory. Disk margins are checked before the plan and each file. The existing content limits are configurable; the metadata limit below is not an arbitrary whole-world upload cap. Cancellation terminates an in-progress stream, removes only its job-owned temporary file, and retains completed staged files for recovery.

## Bounded `level.dat` validation

`validateMinecraftLevelDat(bytes, expectedDataVersion, options)` accepts Java big-endian NBT, raw or gzip-compressed. It does not guess Bedrock formats. Gzip expansion uses Node's `maxOutputLength`, then a structural validation pass bounds nesting, tag count, array elements and consumed bytes before the upstream object decoder runs. Duplicate compound names, prototype-related property names, negative/oversized lengths, unknown tag types, missing terminators and trailing documents are rejected.

Defaults are 8 MiB input, 16 MiB expanded metadata, depth 32, 100,000 tags and 1,000,000 total array elements. Trusted configuration may increase byte limits to at most 64 MiB and depth to 64; tag and array bounds remain capped. These limits constrain metadata parsing, not streamed region files.

The `Data.DataVersion` integer must match the exact selected release's verified value. If `Data.Version.Id` exists it must agree, and supplied release identity must match `Data.Version.Name` when present. Missing or incompatible evidence fails; the importer neither upgrades worlds automatically nor claims that metadata proves every chunk, datapack or mod can run. Actual runtime readiness remains a separate requirement. Importing older worlds that require conversion needs a separately reviewed migration workflow.

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
