# M4 Minecraft runtime resolution and management contracts

## Compatibility is separate from availability

`games/minecraft/src/runtime.ts` resolves exact upstream releases and artifacts for Vanilla, Paper, Folia, Fabric and Forge. Resolution is not installation, client compatibility, or permission to publish a combination in the user catalog. Core's evidence-backed registry decides availability. A missing installed egg or Java image is a deployment prerequisite, not proof that a Minecraft release is unsupported. Owner egg mappings remain independent from upstream runtime metadata.

Minecraft release identifiers are opaque values. The resolver never derives a wire protocol number or Java requirement from a release name, never requests `latest`, and never silently changes a build or loader. Numeric Paper/Folia build IDs, Fabric/Forge loader versions, Fabric installer versions, and Java major versions are independent fields. Historical entries containing spaces in Mojang's release manifest do not invalidate other releases; request identifiers outside the safe supported identifier grammar remain unavailable explicitly.

## Sources and integrity

- **Vanilla:** [Mojang version manifest](https://piston-meta.mojang.com/mc/game/version_manifest_v2.json). Match one exact release; verify its metadata against the manifest SHA-1; use its `javaVersion.majorVersion` and server URL/SHA-1/size. Releases missing required metadata are unavailable; no guessed Java fallback.
- **Paper and Folia:** [PaperMC downloads service](https://docs.papermc.io/misc/downloads-service/) v3. Verify the requested build belongs to the exact version, read provider Java minimum, and pin the server SHA-256. Preserve upstream support status and build channel for Owner inspection. A stable build does not mean upstream still supports its release. A descriptive contact-bearing User-Agent is mandatory.
- **Fabric:** [official metadata API](https://github.com/FabricMC/fabric-meta/blob/master/README.md), exact loader/game pair and `server/json` inheritance, plus a separately selected installer from the installer catalog and Maven SHA-256. Starting with 26.1, the provider can return intermediary `0.0.0`; it is not a Minecraft version. Exact `inheritsFrom` verifies the game identity, consistent with [Fabric's unobfuscated mapping documentation](https://docs.fabricmc.net/develop/porting/mappings/). The plan uses the official server installer with pinned Minecraft and loader arguments.
- **Forge:** [official version-coordinate catalog](https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json) and an exact Maven installer SHA-1. The chosen Minecraft/Forge coordinate must exist. The installer uses `--installServer`; its embedded installer version is not represented as an independently selectable Fabric-style version. Processor-generated outputs require separate installation evidence.

Metadata reads allow only the enumerated official HTTPS origins, omit credentials, reject redirects/query strings/userinfo, and impose a response byte limit and total fetch timeout. Evidence contains URL, response SHA-256 and retrieval time. Provider artifact URLs receive the same origin validation; actual artifact download and installation use the content pipeline's separate integrity controls. No JAR is downloaded by metadata resolution. Installer execution is performed by the configured, verified egg—not the API host.

[Minecraft 26.1 release notes](https://feedback.minecraft.net/hc/en-us/articles/44551668333837-Minecraft-Java-Edition-26-1) identify Java 25. [Paper's current Java table](https://docs.papermc.io/paper/getting-started/) also identifies Java 25 for 26.1. The resolver takes each exact release's runtime requirement from metadata rather than extending that table to hypothetical future releases. Current [Fabric installer source](https://github.com/FabricMC/fabric-installer/blob/master/build.gradle) and [Forge installer source](https://github.com/MinecraftForge/Installer/blob/2.0/build.gradle) target a Java 8 base; installing a loader does not lower the game's requirement. Exact installed output and launch tests are still required to establish runtime compatibility. These sources are references only; no upstream implementation was copied.

## Owner mapping and installation proof

`MinecraftRuntimeMapping` requires:

- Exact profile/release, selected image and separately verified image Java major.
- Explicit semantic variable bindings (`release`, `buildId`, `loaderVersion`, `installerVersion`, optional artifact URLs) to actual egg variable names discovered through the adapter.
- Fixed variables, declared egg variables, installation kind, safe relative `artifactPaths`, and the tested `supportedProperties` list.

`validateMinecraftRuntimeMapping` rejects missing required exact-version bindings, undeclared/duplicate destinations, fixed-variable collisions, wrong runtime/installation kind, and an image Java major different from the resolved requirement. A newer Java image is not silently substituted. The adapter must independently validate the image/egg mapping at execution time. No egg/nest IDs or infrastructure paths are defined by the Minecraft package.

Server-JAR mappings require an explicit server artifact path for integrity verification. A downloaded installer and vanilla JAR do **not** prove a working Fabric or Forge installation. Core must attest generated launcher/library/processor outputs, exact loader, runtime launch and readiness through trusted test evidence. The Owner cannot establish these facts with a checkbox. Property support must come from the tested runtime's generated configuration evidence; an arbitrary list alone is not verification.

## User wizard and management plans

The descriptor always supplies Choose a game, Configure, Resources and Create. Core provides only combinations allowed by rollout and compatibility evidence. The public projection contains choice identity, release, runtime and translation key; no protocol numbers, support status or experimental badges. A selected modpack derives the version/loader, suppresses redundant selection, and retains operators, whitelist, resources and EULA confirmation. Existing-server content cannot silently change an immutable runtime, loader or egg mapping.

Management helpers produce plans; authorized durable jobs perform mutations:

- Properties parsing handles Java escapes and continuation, rejects ambiguous duplicate keys, and preserves unrelated settings/comments. Editing accepts only controlled product fields present in the exact verified release schema. Bind addresses/ports, online mode, RCON and credentials are protected. Plans include before/after SHA-256 and require a confirmed stopped server.
- Mojang name and UUID lookups must independently agree. The HTTP provider uses fixed Mojang origins with bounded responses. MCHeads is optional rendering and never an identity authority. Whitelist/operator plans normalize identities, reject malformed or duplicated records, preserve unrelated entries, and include preimage hashes. Operators support levels 1–4 and explicit player-limit bypass.
- World archive planning bounds entries/expanded bytes/expansion ratios, rejects traversal, symlinks, case/Unicode collisions, file/directory conflicts, multiple roots and executable/configuration payloads. Dimension layouts are retained verbatim. Root promotion remains conditional on bounded NBT/DataVersion validation, storage admission and a confirmed stopped server. World selection requires separately verified compatible DataVersion evidence. These plans do not extract archives or claim rollback.

## Resolver and planner evidence

On 2026-10-09, read-only official metadata requests through the implemented resolver established:

| Requested combination | Metadata resolution | Java | Upstream note |
| --- | --- | --- | --- |
| Vanilla 26.1 | Passed | 25 | Mojang metadata hash checked |
| Paper 1.21.4 build 232 | Passed | 21 | Stable build; upstream release unsupported |
| Folia 1.21.4 build 6 | Passed | 21 | Alpha build; upstream release unsupported |
| Fabric 26.1 / loader 0.19.5 / installer 1.1.2 | Passed | 25 | Unobfuscated intermediary identity validated through exact server profile |
| Forge 1.21.4 / loader 54.1.16 | Passed | 21 | Exact coordinate and installer hash |

These are **metadata-only checks**, not real-server compatibility declarations. No provider mutations, production servers, Java installation, or large artifact downloads were involved.

Targeted automated validation: `scripts/dev.sh pnpm exec vitest run games/minecraft/src/runtime.test.ts games/minecraft/src/management.test.ts`. Tests exercise exact release/build/loader resolution, Java separation, corrupt metadata, unknown IDs, unsafe origins, bounded bodies, immutable results, mapping mismatch, property protection, identity mismatch, player plans, world safety and public wizard projection. The milestone validation report records the final integrated counts and real-server evidence separately.
