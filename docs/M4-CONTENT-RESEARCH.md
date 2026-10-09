# M4 content-provider research and licensing

Research date: 2026-10-09. Prism Launcher was studied as a reference, not imported or translated into NickHosting. The pinned revision is [`e4299e14d7c8821ea21953bc36812145611a309e`](https://github.com/PrismLauncher/PrismLauncher/tree/e4299e14d7c8821ea21953bc36812145611a309e), dated 2026-10-06. The coordinator's preliminary research preceded the content implementation; the implementer also inspected these pinned source paths and current provider metadata.

## Prism findings and server adaptation

| Reference | Finding and NickHosting decision |
| --- | --- |
| [ModrinthInstanceCreationTask.cpp](https://github.com/PrismLauncher/PrismLauncher/blob/e4299e14d7c8821ea21953bc36812145611a309e/launcher/modplatform/modrinth/ModrinthInstanceCreationTask.cpp) | Manifest-selected runtime, hashes, tracked files, and layered overrides are established workflows. Prism selects client content and client overrides; NickHosting selects dedicated-server content and common/server overrides. |
| [PackManifest.cpp](https://github.com/PrismLauncher/PrismLauncher/blob/e4299e14d7c8821ea21953bc36812145611a309e/launcher/modplatform/flame/PackManifest.cpp) | CurseForge manifests identify exact project/file pairs and loader IDs. NickHosting retains those identities and requires one unambiguous loader; it does not reinterpret IDs as download URLs. |
| [FileResolvingTask.cpp](https://github.com/PrismLauncher/PrismLauncher/blob/e4299e14d7c8821ea21953bc36812145611a309e/launcher/modplatform/flame/FileResolvingTask.cpp) | Prism resolves unavailable CurseForge URLs and can look up matching hashes on Modrinth. NickHosting fails when distribution is unavailable; it does not silently use another provider or bypass distribution restrictions. |
| [FlameInstanceCreationTask.cpp](https://github.com/PrismLauncher/PrismLauncher/blob/e4299e14d7c8821ea21953bc36812145611a309e/launcher/modplatform/flame/FlameInstanceCreationTask.cpp) | Loader metadata, staged downloads, overrides, and user-assisted blocked downloads are distinct phases. Dedicated-server jobs do not launch a browser, execute loader scripts, or guess a compatible replacement loader. |
| [NetJob.cpp](https://github.com/PrismLauncher/PrismLauncher/blob/e4299e14d7c8821ea21953bc36812145611a309e/launcher/net/NetJob.cpp) | Retries are bounded and permanent failures differ from transient failures. NickHosting retries transport failures, 429 and 5xx within a configured budget; missing files and integrity failures remain explicit failures. |
| [ResourceDownloadTask.cpp](https://github.com/PrismLauncher/PrismLauncher/blob/e4299e14d7c8821ea21953bc36812145611a309e/launcher/ResourceDownloadTask.cpp) | Download checksums precede replacement. NickHosting stages and hashes first; Core must verify old managed-file hashes before replacement or removal. |
| [MetaCacheSink.cpp](https://github.com/PrismLauncher/PrismLauncher/blob/e4299e14d7c8821ea21953bc36812145611a309e/launcher/net/MetaCacheSink.cpp) | Metadata caching uses validators. NickHosting currently fetches metadata afresh and reuses only exact, rehashed job artifacts; it has no unvalidated shared metadata cache. |
| [ArchiveReader.cpp](https://github.com/PrismLauncher/PrismLauncher/blob/e4299e14d7c8821ea21953bc36812145611a309e/launcher/archive/ArchiveReader.cpp) | Archive path and link containment require explicit checks. NickHosting uses a maintained ZIP reader plus its own strict path, type, duplicate, expansion, CRC and hash checks. |

The [official Modrinth format](https://support.modrinth.com/en/articles/8802351-modrinth-modpack-format-mrpack) defines Minecraft/loader dependencies, required file hashes, per-side environment metadata and override layers. Server overrides take precedence over common overrides and indexed downloads; client overrides are never installed. Optional server files are omitted with a machine-readable warning. Required/optional/incompatible/embedded catalog dependency distinctions follow the [version API](https://docs.modrinth.com/api/operations/getversion/).

The [CurseForge API specification](https://docs.curseforge.com/rest-api/) supplies project/file identifiers, relationship types, file hashes, loader compatibility and distribution status. A key must be supplied through Core's protected configuration. Missing URLs, unavailable files and explicit distribution denial stop acquisition. CF's file API does not independently establish dedicated-server execution side: unknown-side JARs require embedded, understood side evidence and otherwise fail closed. A client modpack ZIP is not proof of a working dedicated-server pack.

Current Modrinth v2 observations differ from a simple reading of older examples: project `environment` is an array, while individual version `environment` is a string. Both are validated, and version evidence takes priority. Mixed or unknown project environments do not establish server support. Current environment meanings are documented by [Modrinth](https://modrinth.com/news/article/new-environments/). Fabric's [project metadata documentation](https://docs.fabricmc.net/develop/getting-started/project-structure) defines its embedded environment declaration; Forge display-test metadata is not treated as proof of execution side.

## License decision

Prism's [COPYING.md](https://github.com/PrismLauncher/PrismLauncher/blob/e4299e14d7c8821ea21953bc36812145611a309e/COPYING.md) specifies GPL version 3 for Prism itself, and several studied files explicitly declare `GPL-3.0-only`. Its archive implementation additionally identifies public-domain portions; other bundled components have their own notices. No Prism code, Qt code, archive implementation, or bundled dependency was copied, linked, translated or vendored. Reference links provide attribution without changing NickHosting's repository licensing policy. Reusing Prism code later requires a separate Owner licensing decision.

Dependencies actually added for this package:

| Dependency | Use | License verified in installed package |
| --- | --- | --- |
| `yauzl` 3.4.0 | Streaming ZIP reader | MIT |
| `pend` 1.2.0 | Transitive ZIP-reader dependency | MIT |
| `yazl` 3.3.1 | Test ZIP generation only | MIT |
| `buffer-crc32` 1.0.0 | Transitive test dependency | MIT |
| `@types/yauzl` 3.4.0, `@types/yazl` 3.3.1 | Type declarations only | MIT |

The existing Zod/core dependencies are reused. Node's built-in crypto, HTTPS, streams and zlib provide hashes, TLS, bounded streaming and CRC checks. Dependency copyright/license notices remain in the installed packages and must accompany redistributed dependency bundles. This work does not add an open-source license to the repository.

World metadata uses `prismarine-nbt` 2.8.0 (MIT) with bounded input/decompression
and a structural walk before decoding. The installed dependency license inventory
was checked with `scripts/dev.sh pnpm licenses list --json`: `protodef` 1.19.0,
`lodash.reduce` 4.6.0, `readable-stream` 4.8.0, `abort-controller` 3.0.0 and
`event-target-shim` 5.0.1 declare MIT. ZIP dependencies `yauzl` 3.4.0, `yazl` 3.3.1,
`pend` 1.2.0 and `buffer-crc32` 1.0.0 also declare MIT. Package license notices
remain with the installed packages; no GPL Prism implementation was copied.

The independent live-test client is `minecraft-protocol` 1.68.0 (BSD-3-Clause),
a development dependency only. Its installed metadata requires Node >=22; the
project uses Node 24.21.0. Its supported-version list includes the selected 26.1
and 1.21.4 candidates. That list is not NickHosting compatibility evidence. The
client exercises the real server protocol; it is not included in the production
Gateway and supplies no proxy authentication or protocol translation.

The additional transitive license inventory contains MIT, Apache-2.0, BSD-2-Clause,
BSD-3-Clause and CC0-1.0 packages. Examples include `minecraft-data` 3.117.0 and
`prismarine-auth` 3.1.1 (MIT), `xboxlive-auth` 5.1.0 (Apache-2.0),
`buffer-equal-constant-time` (BSD-3-Clause), `webidl-conversions` (BSD-2-Clause) and
`railroad-diagrams` (CC0-1.0). No Prism/GPL code is introduced through this client.
Installed notices must accompany redistributed dependencies. The client can use
offline authentication only on explicitly configured provenance-verified fixtures;
such tests do not prove Microsoft-authenticated online play.
