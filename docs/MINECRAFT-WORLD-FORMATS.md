# Minecraft Java world metadata investigation

Date: 2026-10-18. M5, PR #21. Product source inspected at
`d2545345851e96a89da9d260cd494c82856a5581`.

**Research only.** This document proposes a later importer change; it does not
change the behavior specified in [M4-WORLDS.md](M4-WORLDS.md). No game was started,
world converted, provider resource modified or infrastructure restarted for this
investigation. Official client artifacts were inspected statically with ZIP tools
and `javap`, after checking their published SHA-1. World writers from official
client artifacts establish serialization behavior, not dedicated-server acceptance tests.

The investigation covers version identification, storage-family recognition and
their consequences for import/selection. It is not a catalog of every block,
entity, world-generation or chunk schema change in Minecraft history.

## Findings

Three independent concepts must remain separate:

- **Storage format:** loose chunks, McRegion, Anvil and later directory layouts.
- **Saved data version:** the schema version recorded by the writer, where present.
- **Game compatibility:** whether the selected runtime can load or upgrade that
  world, including experimental branches, mods and data not inspected in metadata.

Neither the current server's selected release nor a filename proves a world's
original release. Metadata usually describes its last save, not its creation.
Older worlds may contain no exact release identifier at all. Reporting that fact
as unknown is necessary; reporting the world as malformed is not justified.

## Chronology of relevant boundaries

NBT paths below are relative to the root compound of `level.dat`. `Data.version`
and `Data.Version` are distinct, case-sensitive fields.

| Boundary | Metadata written | Storage and detection consequence | Evidence |
| --- | --- | --- | --- |
| Alpha / Beta before Beta 1.3 | Inspected writers have `Data`, without `version`, `DataVersion` or `Version` | Individual chunk files, with base-36 coordinates in hashed subdirectories. Exact release is not recoverable from these absent fields. | Official a1.2.6 and b1.2_02 artifacts; representative samples, not every Alpha. |
| Beta 1.3 → release 1.1 | `Data.version`: TAG_Int **19132** | McRegion `.mcr`. The number identifies a storage family, not a release. | Official b1.3b and 1.1 artifacts; [original Beta 1.3 announcement](https://web.archive.org/web/20150802145044id_/http://notch.tumblr.com/post/3446675806/minecraft-beta-13). |
| 12w07a; stable 1.2.1 | `Data.version`: TAG_Int **19133** | Anvil `.mca`. This marker continues through modern releases, so it cannot distinguish 1.7.10 from 1.8.9 or 26.3. | [Mojang snapshot announcement](https://web.archive.org/web/20120302113913id_/http://www.mojang.com/2012/02/minecraft-snapshot-12w07a/) for the snapshot boundary; official 1.2.1, 1.8.9 and modern artifacts. |
| 15w32a, in the 1.9 development branch | `Data.DataVersion`: TAG_Int **100**; `Data.Version`: compound with `Name` string, `Id` int and `Snapshot` byte/boolean | Explicit saved-data version and display name become available. `Id` is the data version, not the network protocol. | Official 15w31c writer lacks these fields; 15w32a writes all of them; checked again in 15w32b and 1.9. |
| 1.18 experimental snapshot 1; mainline 21w37a | `Data.Version.Series`: string | Version lineage distinguishes normal and experimental data. `Snapshot` alone does not identify a lineage. Missing Series must be preserved as absent in observations, even when a version-specific compatibility rule defaults it to `main`. | [Fabric's experimental snapshot mapping commit](https://github.com/FabricMC/yarn/commit/963908ce8471d1a868945fe45a5f5d59e4cc6a5e), whose build identifies experimental snapshot 1; official 1.17.1/21w37a artifact comparison. |
| 26.1 Snapshot 6, DataVersion 4774 | Version metadata remains, but world data and paths are reorganized | Vanilla dimensions move under `dimensions/minecraft/`; player data under `players/`; shared saved data becomes namespaced. Several former `level.dat` fields move to separate data files. Root `region/` is no longer a universal requirement. | [Mojang Snapshot 6 notes](https://www.minecraft.net/en-us/article/minecraft-26-1-snapshot-6); stable 26.1 metadata writer inspected. |
| 26.3 Snapshot 7, DataVersion 5009 | `Data.version_history` added | A history of saved data versions augments the current version. It does not replace `DataVersion` or establish the age of every chunk. | [Mojang Snapshot 7 notes](https://www.minecraft.net/en-us/article/minecraft-26-3-snapshot-7); official 26.3 writer inspected. |

These are development-branch boundaries, not a chronological cutoff applied to
every release. For example, 1.8.9 still lacks native DataVersion despite being
published after 15w32a. Release metadata must describe the actual branch.

The current official manifest does not provide 12w07a/12w07b artifacts. That exact
snapshot boundary is documentary; the adjacent stable 1.1/1.2.1 artifacts were
checked. Experimental Series introduction is supported by author-maintained
mappings; its first experimental JAR was not inspected here.

Classic and Indev are different save families, not additional variants of the
modern `Data` compound. The inspected Classic c0.30_01c writer uses Java object
serialization. [MCEdit's Indev reader](https://github.com/mcedit/pymclevel/blob/8bf7b3d76479e007a51f3055198a8bcddb626c84/indev.py)
recognizes a `MinecraftLevel` NBT root and finite `Map` data. Recognize and describe
these separately if encountered; do not deserialize Java objects or claim the
current Java server importer can activate them.

## What the modern fields actually establish

`DataVersion` is not the network protocol, pack format or save-format marker.
The integration's pinned [PrismarineJS registry](https://github.com/PrismarineJS/minecraft-data/blob/33a0f3e7323e124a81960a6d6c62df797d69cd85/data/pc/common/protocolVersions.json)
contains synthetic historical numbers below 100. They must not be invented in
legacy NBT or interpreted as metadata that Mojang wrote.

The registry also contains duplicate native values: 15w33a/15w33b share 111,
16w43a/16w44a share 817, and 18w43a/18w43b share 1902. The experimental pairs
24w12a/24w14potato and 1.21.5-rc1/25w14craftmine share 3824 and 4323 respectively.
A lookup can therefore yield multiple candidates; equality is not proof of
interchangeability.

`Version.Name` is a display name. The official 26.1-snapshot-1 artifact has
`version.json.id = "26.1-snapshot-1"` and
`version.json.name = "26.1 Snapshot 1"`; its `PrimaryLevelData` writer stores
`WorldVersion.name()` in `Version.Name`. Our direct comparison with the release
ID can reject the correct version. Use artifact-backed identities and aliases,
not guessed punctuation normalization.

`Version.Series` is independent of numeric order. The inspected 26.1
`DataVersion.isCompatible` compares series, but this is only one check in the
game's loading flow, not its entire compatibility policy. Fabric's
[21w37a version mapping](https://github.com/FabricMC/yarn/blob/61372ae755eeefb742601869081e7b1767dc010d/mappings/net/minecraft/SaveVersion.mapping)
also records a special incompatible-height range, DataVersions 2693–2706
(21w06a–21w14a). A universal “older means safe to upgrade” rule would be wrong.

The inspected 26.3 `PrimaryLevelData` reads `version_history` as integers and
writes **TAG_List of TAG_Int**, not TAG_Int_Array. It retains the existing order
and appends the current DataVersion if the list is empty or its last entry differs.
Missing history is accepted. This is not a reliable complete creation history,
and it does not certify chunk versions. Unknown extra metadata should remain
untouched rather than being rewritten by NickHosting.

## Chunk data and conversion boundaries

World metadata does not prove that every chunk has the same schema. A world can
contain data saved at different times. MCASelector's
[version helper](https://github.com/Querz/mcaselector/blob/701700119c1f3b7af30639c7bd1a8efed57a6e6a/src/main/java/net/querz/mcaselector/version/Helper.java#L325)
handles both nested `Level.DataVersion` and chunk-root `DataVersion`, documenting
the move at 15w33a. That is a chunk change, not a relocation of
`Data.DataVersion` in `level.dat`.

Even region-file extension is not a complete compatibility verdict. Mojang's
[Anvil announcement](https://web.archive.org/web/20120302221152id_/http://www.mojang.com/2012/02/new-minecraft-map-format-anvil/)
describes retaining old `.mcr` files and `level.dat_mcr` after conversion. Mixed
`.mcr`/`.mca` presence can be legitimate. Its preliminary chunk-field description
also differs from the shipped 1.2.1 writer: the artifact uses section `Y` as a
byte and optional `Add` as a byte array. Released artifacts take precedence for
exact field types.

[21w37a removed direct conversion of pre-Anvil worlds](https://www.minecraft.net/en-us/article/minecraft-snapshot-21w37a).
Mojang recommends conversion with an older version, preferably 1.6.4 or earlier
to avoid incorrectly converted biomes. Consequently, recognizing a McRegion
archive does not make it directly loadable in 26.1. Minecraft's
[DataFixerUpper](https://github.com/Mojang/DataFixerUpper/blob/b81c76b6abec08d4aaf22f50dc75e6f46a1beda0/src/main/java/com/mojang/datafixers/DataFixerUpper.java#L75)
performs forward updates, not a general downgrade transformation.

NickHosting should preserve world bytes and delegate actual conversion to an
explicitly chosen compatible game runtime. It should not reproduce Minecraft's
data fixers, silently launch an intermediate server or infer that all modded
content is supported from `level.dat` alone.

## Current NickHosting gaps

The reviewed implementation is in `games/minecraft/src/world.ts` and
`world-version.ts`:

1. `inspectMinecraftLevelDat` requires a positive `DataVersion`, so structurally
   valid older worlds fail before their format can be described.
2. `validateMinecraftLevelDat` requires equality with the selected release's
   bundled value. Discovery uses the same narrow identity model.
3. Optional `Version.Name` is compared directly with a release ID. Display-name
   differences can create false failures even with matching data versions.
4. The result has no storage-family, Series, Snapshot, history or explicit
   unknown-version representation. The catalog maps each release to one integer.
5. Archive staging validates `level.dat` after extraction. Metadata rejection can
   therefore happen late, after otherwise successful upload and staging work.
6. Generic job failure presentation loses the useful version-specific reason;
   submitting the import closes the dialog before the durable import completes.
   Request acceptance must remain distinct from imported-world availability.

The previously inspected Owner-provided 1.7.10 map is a concrete example:
`Data.version = 19133`, with no `DataVersion` or `Version`. Its wrapper directory
is already supported. Metadata proves an Anvil-format world, **not the exact
1.7.10 release**; that release is user-supplied context. The current failure is
our modern-only version requirement, not evidence that the archive is corrupt.
No successful import or 26.1 compatibility is claimed for that map.

## Proposed implementation, not yet approved or applied

Use one shared metadata observation for discovery, preparation and operation
details. Keep source facts separate from a target-runtime assessment.

- **Observe:** structural validity; optional storage marker, DataVersion,
  Version fields and bounded history; known layout evidence. Preserve absence,
  contradictions and unknown values explicitly. Missing modern tags alone are
  insufficient to identify arbitrary NBT as an Alpha world.
- **Identify:** exact identity when supported by artifact-backed metadata,
  candidate releases where ambiguous, otherwise known format with unknown release.
  A user's declared map version remains a declaration, not detected evidence.
- **Import:** allow structurally recognized worlds into a new, inactive folder
  without requiring equality with the installed game's version. Import must not
  change the active world or convert it. Retain path/collision/storage boundaries.
- **Select:** assess the actual target separately: recognized compatible data,
  an upgrade requiring acknowledgement/backup, unsupported downgrade or lineage,
  or unknown compatibility requiring an explicit decision. Define this policy
  before implementation; equal DataVersion alone is not sufficient.
- **Preserve:** retain legacy and modern paths, unknown tags and files accepted
  by the archive contract. Never require root `region/` for every version, or
  silently fall back to an old `level.dat_old` and treat it as the current save.

This can remain inexpensive: read bounded `level.dat` metadata once, share the
result, and use the directory inventory already needed for the archive. For
random-access ZIPs, inspect metadata before extracting all payloads where practical.
There is no need for a release lookup over the network, a JAR download, scanning
all chunks or starting Minecraft on each import. Additional chunk inspection can
be a separate diagnostic, not a new repeated hot-path check.

The proposal changes world import/selection semantics only. It does not enable
undeclared runtimes or alter provider installation, resource admission or Gateway
compatibility. Bedrock level.dat/LevelDB requires its own future implementation.

## Validation plan and remaining uncertainty

Tests should cover format families and transition boundaries, not boot hundreds
of game versions merely to check metadata parsing:

- Legacy loose chunks, McRegion 19132 and Anvil 19133 without DataVersion;
  missing markers with insufficient evidence; invalid/wrong-typed markers.
- 15w31c/15w32a; the separate 1.8.9 branch; duplicate DataVersions; snapshot
  display-name versus release-ID differences; unknown positive data versions.
- Absent/main/experimental Series, Snapshot types, contradictory Version.Id and
  DataVersion; the documented historical upgrade exceptions.
- Old and 26.1 directory layouts; nested archive roots; preservation of opaque
  chunk and dimension data; 26.3 history absent/present/malformed/oversized.
- Metadata that matches while chunk fixtures differ, demonstrating the limited
  guarantee rather than pretending to validate the entire world.
- Archive and directory input; additive import while running; collision and
  active-world rejection; stopped selection; honest asynchronous job errors.
- Separate Classic/Indev recognition, without claiming automatic conversion;
  Unicode/NBT string interoperability should be checked before claiming complete
  historical parser coverage.

These are planned tests, **not executed tests**. This session establishes static
writer behavior and documented boundaries. Dedicated-server loads, historical
conversions, all Alpha variants, modded worlds, and every intervening snapshot
remain untested. Future schema changes must produce an honest unknown assessment,
not an invented exact version or blanket compatibility certification.

## Reproducible artifact evidence

Resolve clients through the [official Mojang manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json),
check each download's metadata SHA-1/size, inspect its metadata writer with
`javap -p -c`, and read `version.json` where present. No Minecraft main class is
executed. Downloaded binaries/disassembly remain ignored local research data;
neither is redistributed in this repository.

| Client | Published client SHA-1 | Inspected metadata writer / result |
| --- | --- | --- |
| a1.2.6 | `a68c817afd6c05c253ba5462287c2c19bbb57935` | `cy.p()`; loose chunks, no version marker |
| b1.2_02 | `093f371e1a05d89664cfb8068d607953687d5d94` | `dn.r()`; loose chunks, no version marker |
| b1.3b | `e19cfb3a2043f185c44237ef05eac80e8ad2d8e7` | `dc`, `jy`; 19132 |
| 1.1 | `f690d4136b0026d452163538495b9b0e8513d718` | `ve`, `abh`; 19132 |
| 1.2.1 | `c7662ac43dd04bfd677694a06972a2aaaf426505` | `wm`, `ahu`; 19133 |
| 1.8.9 | `3870888a6c3d349d3771a3e9d16c9bf5e076b908` | `ato`, `atj`; 19133, no DataVersion |
| 15w31c | `a903feeba306b3e2415ec97757a9a32b4a27859d` | `avo`; no DataVersion/Version |
| 15w32a | `6f85d469a2f6e8d24cc71f1882eba1142ecc29bd` | `awk`; DataVersion 100 and Version compound |
| 15w32b | `1f448b05e56d3b36f0408eecd798b875ec230ef0` | `aws`; modern version metadata |
| 1.9 | `2f67dfe8953299440d1902f9124f0f2c3a2c940f` | `azh`; modern version metadata |
| 21w14a | `4af7eb4770d3e708d287db3bf023d4bbc60465b0` | `dhg`; no Series |
| 21w15a | `749805abb797f201a76e2c6ad2e7ff6f790bb53c` | `dhh`; no Series |
| 1.17.1 | `8d9b65467c7913fcf6f5b2e729d44a1e00fde150` | `dig`; no Series |
| 21w37a | `be41b4e18f4a600365fd7a2b8eeac49232304ced` | `dim`, `dio`; Series present |
| 26.1-snapshot-1 | `bd354bbd46835d7c7753e0b19c718777fb2386ba` | `PrimaryLevelData`; Name differs from release ID |
| 26.1 | `191771837687b766537a8c4607cb6fad79c533a1` | `PrimaryLevelData`, `LevelVersion`, `DataVersion`; Series and 19133 retained |
| 26.3 | `e877b6a07acd633fb3bb475002175cec036e7b87` | `PrimaryLevelData`; version_history integer list |

Classic c0.30_01c
(`54622801f5ef1bcc1549a842c5b04cb5d5583005`) was inspected separately for its
non-NBT serialization family. These observations are static evidence, not a
live compatibility matrix.
